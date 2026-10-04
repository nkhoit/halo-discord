/* Rooms: a host and its guests. Frames travel host to guest and guest to
   host only, and every member's identity comes from its authenticated
   socket: the Discord user from the session token, and the Halo network
   identifier that user claimed when joining. */

import type { RawData, WebSocket } from "ws";

import {
  BATCH_MARKER,
  Channel,
  CloseCode,
  HEADER_BYTES,
  MAXIMUM_FRAME_BYTES,
  MAXIMUM_ROOM_SOCKETS,
  type Role,
  type SocketKind,
  carries,
  frameValid,
  identifierText,
  isReliableChannel,
  joinBatch,
  sanitizeName,
  splitBatch,
  writeIdentifier,
} from "./protocol.ts";

export interface Member {
  /* Discord user ID from the session token. */
  user: string;
  name: string;
  /* Halo network identifier (12 hex digits), the address on the wire. */
  id: string;
  role: Role;
  kind: SocketKind;
  /* (a guest) it watches the match without a player of its own (#52): it
     joined to watch, until it says it plays */
  spectator: boolean;
  since: number;
}

/* Who may join a room. own: the joining session's Activity instance is this
   room's (its server and voice channel, if any). guilds: the allowlisted
   Discord servers the session's user belongs to. activity: the session is a
   Discord Activity's. */
export interface Access {
  own: { guild: string | null; channel: string | null } | null;
  guilds: readonly string[];
  activity: boolean;
}

const BROWSER_ACCESS: Access = { own: null, guilds: [], activity: false };

/* A match's state as its host reports it. */
export type MatchState = "lobby" | "starting" | "match" | "postgame";
const MATCH_STATES = new Set<string>(["lobby", "starting", "match", "postgame"]);

/* Halo's player limit, and so a room's capacity in players. */
export const MAXIMUM_PLAYERS = MAXIMUM_ROOM_SOCKETS / 2;

/* A room in a server-wide list (GET /v1/guild-rooms). */
export interface GuildRoom {
  roomId: string;
  host: string;
  channel: string | null;
  map: number | null;
  mode: number | null;
  state: MatchState;
  players: number;
  /* machines watching without a player */
  spectators: number;
  capacity: number;
  joinable: boolean;
  /* Why it is not joinable: "full", "version" (another build) or "match"
     (a match that takes nobody now). */
  reason: "full" | "version" | "match" | null;
  /* its running match takes spectators (another build's never) */
  watchable: boolean;
}

/* Who is in a room (GET /v1/rooms/<id>). */
export interface RoomSummary {
  host: string | null;
  players: number;
  spectators: number;
  inMatch: boolean;
  joinable: boolean;
  /* its running match takes spectators, even when it takes no player */
  watchable: boolean;
}

/* Backpressure: bytes the relay has written to a receiver's socket that have
   not gone out yet. Above the first, frames on the unreliable channels to it
   are dropped (a later tick's overtake them); above the second it is closed,
   and its client reconnects and resumes. */
export const RELAY_DROP_BUFFERED_BYTES = 256 * 1024;
export const RELAY_CLOSE_BUFFERED_BYTES = 4 * 1024 * 1024;

export type Log = (entry: Record<string, unknown>) => void;

export const consoleLog: Log = (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));

/* A receiving socket's backpressure. */
interface Flow {
  dropping: boolean;
  droppedFrames: number;
  droppedBytes: number;
  maxBuffered: number;
}

class Room {
  readonly members = new Map<WebSocket, Member>();
  readonly flows = new Map<WebSocket, Flow>();
  /* frames dropped to receivers past RELAY_DROP_BUFFERED_BYTES, and receivers
     closed past RELAY_CLOSE_BUFFERED_BYTES, since the room opened */
  droppedFrames = 0;
  backlogCloses = 0;
  build: string | null = null;
  /* The host's word: its game is past the lobby, so nobody can join until it
     returns, unless its match takes players as it runs (joinable). */
  inMatch = false;
  joinable = false;
  /* (the host's word too) its running match takes spectators */
  watchable = false;
  /* A Discord Activity instance's room, and the server and voice channel it
     belongs to (learned from its members' sessions). */
  activity = false;
  guild: string | null = null;
  channel: string | null = null;
  /* What the host reports for the server-wide list. */
  state: MatchState = "lobby";
  map: number | null = null;
  mode: number | null = null;
  channelName: string | null = null;
  readonly id: string;

  constructor(id: string) {
    this.id = id;
  }

  present(id: string): boolean {
    for (const member of this.members.values()) {
      if (member.id === id && carries(member.kind, true)) return true;
    }
    return false;
  }
}

function overlaps(a: SocketKind, b: SocketKind): boolean {
  return a === "both" || b === "both" || a === b;
}

/* Whom a member may reach: the host reaches every guest, a guest the host. */
function counterpart(of: Member, other: Member): boolean {
  return of.id !== other.id && (of.role === "host") !== (other.role === "host");
}

function send(socket: WebSocket, message: string | Uint8Array): void {
  if (socket.readyState === socket.OPEN) socket.send(message);
}

function close(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    /* already closed */
  }
}

export class Relay {
  readonly rooms = new Map<string, Room>();
  private readonly maxRooms: number;
  private readonly log: Log;

  constructor(maxRooms: number, log: Log = consoleLog) {
    this.maxRooms = maxRooms;
    this.log = log;
  }

  /* Admits an authenticated socket, or closes it with the reason it cannot join.
     The caller already listens for the socket's errors (app.ts). */
  join(socket: WebSocket, roomId: string, joining: Omit<Member, "since">, build: string,
      access: Access = BROWSER_ACCESS): void {
    let room = this.rooms.get(roomId);
    /* Besides its own instance's room, a Discord Activity joins only rooms of
       instances in a server the user belongs to; a browser session also
       joins rooms that no Activity owns (link rooms). */
    if (!access.own && (room?.activity || access.activity) &&
        !(room?.activity && room.guild !== null && access.guilds.includes(room.guild))) {
      return this.refuse(socket, roomId, joining, "not in your Discord server");
    }
    if (!room) {
      if (this.rooms.size >= this.maxRooms) return this.refuse(socket, roomId, joining, "too many rooms");
      room = new Room(roomId);
      this.rooms.set(roomId, room);
    }
    const replaced: WebSocket[] = [];
    let error: string | null = null;
    if (room.build && room.build !== build) error = "build mismatch";
    for (const [other, member] of room.members) {
      if (error) break;
      if (member.role === "host" && joining.role === "host" && member.user !== joining.user) {
        error = "room already has a host";
      } else if (member.id === joining.id && (member.user !== joining.user || member.role !== joining.role)) {
        error = "identifier in use";
      } else if (member.id === joining.id && overlaps(member.kind, joining.kind)) {
        /* A reconnect: the old socket can stay half-open after a network failure. */
        replaced.push(other);
      }
    }
    if (!error && room.members.size - replaced.length >= MAXIMUM_ROOM_SOCKETS) error = "room full";
    if (error) {
      if (!room.members.size) this.rooms.delete(roomId);
      return this.refuse(socket, roomId, joining, error);
    }
    for (const other of replaced) {
      room.members.delete(other);
      close(other, CloseCode.Replaced, "replaced by a new connection");
    }
    room.build ??= build;
    if (access.own) {
      room.activity = true;
      room.guild ??= access.own.guild;
      room.channel ??= access.own.channel;
    }
    const member: Member = { ...joining, since: Date.now() };
    room.members.set(socket, member);
    this.log({ event: "accept", room: roomId.slice(0, 8), user: member.user, id: member.id,
      role: member.role, kind: member.kind, replaced: replaced.length, sockets: room.members.size });

    socket.on("message", (data, isBinary) => this.receive(room, socket, data, isBinary));
    socket.on("close", (code, reason) => {
      const flow = room.flows.get(socket);
      this.log({ event: "close", room: roomId.slice(0, 8), user: member.user, id: member.id,
        kind: member.kind, code, reason: reason.toString(), ageMs: Date.now() - member.since,
        current: room.members.get(socket) === member,
        droppedFrames: flow?.droppedFrames ?? 0, droppedBytes: flow?.droppedBytes ?? 0,
        maxBuffered: flow?.maxBuffered ?? 0, roomDroppedFrames: room.droppedFrames,
        roomBacklogCloses: room.backlogCloses });
      this.remove(room, socket);
    });

    const peers: string[] = [];
    const names: Record<string, string> = {};
    for (const other of room.members.values()) {
      if (counterpart(member, other) && carries(other.kind, true) && !peers.includes(other.id)) {
        peers.push(other.id);
        names[other.id] = other.name;
      }
    }
    send(socket, JSON.stringify({
      type: "ready",
      self: { id: member.id, role: member.role, kind: member.kind, name: member.name },
      peers,
      names,
    }));
    /* Also after a reconnect: the counterparts replay what the old socket lost. */
    if (carries(member.kind, true)) this.announce(room, member, "peer-up", socket);
  }

  /* Who is in a room, for a lobby that has to choose between hosting and
     joining: the host's display name, if any, the players and the
     spectators. Spectators' sockets count against the room's, as their
     machines do against the host's. */
  summary(roomId: string): RoomSummary {
    const room = this.rooms.get(roomId);
    if (!room) return { host: null, players: 0, spectators: 0, inMatch: false, joinable: false, watchable: false };
    let host: string | null = null;
    const players = new Set<string>();
    const spectators = new Set<string>();
    for (const member of room.members.values()) {
      if (!carries(member.kind, true)) continue;
      (member.spectator ? spectators : players).add(member.id);
      if (member.role === "host") host = member.name;
    }
    /* (a full room takes nobody, whatever the host's match would) */
    const roomFull = room.members.size >= MAXIMUM_ROOM_SOCKETS;
    return { host, players: players.size, spectators: spectators.size, inMatch: host !== null && room.inMatch,
      joinable: host !== null && room.inMatch && room.joinable && !roomFull,
      watchable: host !== null && room.inMatch && room.watchable && !roomFull };
  }

  /* The rooms of Activity instances in a Discord server that have a host, but
     not the caller's own (exceptRoomId); joinable for a client of build. */
  guildRooms(guild: string, exceptRoomId: string | null, build: string | null): GuildRoom[] {
    const rooms: GuildRoom[] = [];
    for (const room of this.rooms.values()) {
      if (!room.activity || room.guild !== guild || room.id === exceptRoomId) continue;
      const summary = this.summary(room.id);
      if (!summary.host) continue;
      const full = summary.players >= MAXIMUM_PLAYERS || room.members.size >= MAXIMUM_ROOM_SOCKETS;
      const reason = full ? "full" : build !== null && room.build !== null && room.build !== build ? "version" :
        summary.inMatch && !summary.joinable ? "match" : null;
      rooms.push({
        roomId: room.id, host: summary.host, channel: room.channelName, map: room.map, mode: room.mode,
        state: room.state, players: summary.players, spectators: summary.spectators, capacity: MAXIMUM_PLAYERS,
        joinable: reason === null, reason, watchable: summary.watchable && reason !== "version",
      });
    }
    return rooms.sort((a, b) => a.host.localeCompare(b.host));
  }

  private refuse(socket: WebSocket, roomId: string, joining: Omit<Member, "since">, reason: string): void {
    this.log({ event: "refuse", room: roomId.slice(0, 8), user: joining.user, id: joining.id, reason });
    close(socket, CloseCode.Refused, reason);
  }

  private announce(room: Room, about: Member, type: "peer-up" | "peer-down", except?: WebSocket): void {
    const message = JSON.stringify(type === "peer-up" ?
      { type, id: about.id, name: about.name } : { type, id: about.id });
    for (const [socket, member] of room.members) {
      if (socket !== except && counterpart(about, member) && carries(member.kind, true)) send(socket, message);
    }
  }

  private remove(room: Room, socket: WebSocket): void {
    const member = room.members.get(socket);
    room.flows.delete(socket);
    if (!member) return;
    room.members.delete(socket);
    if (carries(member.kind, true) && !room.present(member.id)) this.announce(room, member, "peer-down");
    if (member.role === "host" && ![...room.members.values()].some((other) => other.role === "host")) {
      room.inMatch = false;
      room.joinable = false;
      room.watchable = false;
      room.state = "lobby";
    }
    if (!room.members.size) this.rooms.delete(room.id);
  }

  /* The one text message after "auth": the host's
     {"type":"phase","inMatch":boolean,"joinable"?:boolean,"watchable"?:boolean},
     and for the server-wide list, optionally "state" (MatchState), "map" and
     "mode" (the hosted page's indices) and "channel" (its voice channel's
     name). */
  private control(room: Room, sender: Member, data: RawData): boolean {
    const message = data instanceof Buffer ? data : Buffer.concat(data as Buffer[]);
    if (message.byteLength > 512) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.toString("utf8"));
    } catch {
      return false;
    }
    const value = parsed as { type?: unknown; inMatch?: unknown; joinable?: unknown; watchable?: unknown;
      state?: unknown; map?: unknown; mode?: unknown; channel?: unknown } | null;
    if (!value || value.type !== "phase" || typeof value.inMatch !== "boolean") return false;
    if (value.joinable !== undefined && typeof value.joinable !== "boolean") return false;
    if (value.watchable !== undefined && typeof value.watchable !== "boolean") return false;
    const index = (field: unknown) => typeof field === "number" && Number.isInteger(field) && field >= 0 && field < 64;
    if ((value.state !== undefined && (typeof value.state !== "string" || !MATCH_STATES.has(value.state))) ||
        (value.map !== undefined && !index(value.map)) || (value.mode !== undefined && !index(value.mode)) ||
        (value.channel !== undefined && value.channel !== null && typeof value.channel !== "string")) return false;
    room.state = (value.state as MatchState | undefined) ?? (value.inMatch ? "match" : "lobby");
    room.map = (value.map as number | undefined) ?? null;
    room.mode = (value.mode as number | undefined) ?? null;
    room.channelName = typeof value.channel === "string" && value.channel.trim() ?
      sanitizeName(value.channel) : null;
    const joinable = value.inMatch && value.joinable === true;
    if (room.inMatch !== value.inMatch || room.joinable !== joinable) {
      this.log({ event: "phase", room: room.id.slice(0, 8), user: sender.user, inMatch: value.inMatch, joinable });
    }
    room.inMatch = value.inMatch;
    room.joinable = joinable;
    room.watchable = value.inMatch && value.watchable === true;
    return true;
  }

  /* A guest's text message: {"type":"spectating","value":boolean}, when a
     spectator joins with a player (or watches again). */
  private memberControl(room: Room, sender: Member, data: RawData): boolean {
    const message = data instanceof Buffer ? data : Buffer.concat(data as Buffer[]);
    if (message.byteLength > 128) return false;
    let value: { type?: unknown; value?: unknown } | null;
    try {
      value = JSON.parse(message.toString("utf8"));
    } catch {
      return false;
    }
    if (!value || value.type !== "spectating" || typeof value.value !== "boolean") return false;
    if (sender.spectator !== value.value) {
      this.log({ event: "spectating", room: room.id.slice(0, 8), user: sender.user, id: sender.id,
        spectating: value.value });
    }
    for (const member of room.members.values()) {
      if (member.id === sender.id && member.user === sender.user) member.spectator = value.value;
    }
    return true;
  }

  private receive(room: Room, socket: WebSocket, data: RawData, isBinary: boolean): void {
    const sender = room.members.get(socket);
    if (!sender) return;
    if (!isBinary) {
      if (sender.role === "host" ? this.control(room, sender, data) : this.memberControl(room, sender, data)) return;
      return close(socket, CloseCode.UnsupportedData, "binary frames only");
    }
    const message = data instanceof Buffer ? data : Buffer.concat(data as Buffer[]);
    const bytes = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
    const batched = bytes[0] === BATCH_MARKER;
    let frames: Uint8Array[];
    if (batched) {
      const split = splitBatch(bytes);
      if (!split) return close(socket, CloseCode.PolicyViolation, "malformed batch");
      frames = split;
    } else {
      if (bytes.byteLength > MAXIMUM_FRAME_BYTES) return close(socket, CloseCode.MessageTooBig, "frame too large");
      frames = [bytes];
    }

    const outgoing = new Map<WebSocket, Uint8Array[]>();
    const queue = (target: WebSocket, frame: Uint8Array) => {
      const list = outgoing.get(target);
      if (list) list.push(frame); else outgoing.set(target, [frame]);
    };
    for (const frame of frames) {
      if (!frameValid(frame)) return close(socket, CloseCode.PolicyViolation, "malformed frame");
      const channel = frame[0]!;
      if (channel === Channel.RelayEcho) {
        queue(socket, frame.slice());
        continue;
      }
      const reliable = isReliableChannel(channel);
      if (!carries(sender.kind, reliable)) {
        return close(socket, CloseCode.PolicyViolation, "channel not carried by this socket");
      }
      const destination = identifierText(frame.subarray(1, HEADER_BYTES));
      for (const [target, member] of room.members) {
        if (member.id === destination && counterpart(sender, member) && carries(member.kind, reliable)) {
          const forwarded = frame.slice();
          writeIdentifier(forwarded, sender.id);
          queue(target, forwarded);
          break;
        }
      }
      /* No such counterpart (left, not yet joined, or not allowed): dropped, as
         a network would. */
    }
    for (const [target, list] of outgoing) this.deliver(room, target, list);
  }

  /* Sends a receiver its frames, as its backlog allows (RELAY_DROP_BUFFERED_BYTES,
     RELAY_CLOSE_BUFFERED_BYTES). */
  private deliver(room: Room, target: WebSocket, frames: Uint8Array[]): void {
    if (target.readyState !== target.OPEN) return;
    let flow = room.flows.get(target);
    if (!flow) {
      flow = { dropping: false, droppedFrames: 0, droppedBytes: 0, maxBuffered: 0 };
      room.flows.set(target, flow);
    }
    const buffered = target.bufferedAmount;
    if (buffered > RELAY_CLOSE_BUFFERED_BYTES) return this.backlogged(room, target, buffered);
    if (buffered > RELAY_DROP_BUFFERED_BYTES) {
      const kept = frames.filter((frame) => isReliableChannel(frame[0]!));
      if (kept.length < frames.length) {
        let bytes = 0;
        for (const frame of frames) if (!isReliableChannel(frame[0]!)) bytes += frame.byteLength;
        flow.droppedFrames += frames.length - kept.length;
        flow.droppedBytes += bytes;
        room.droppedFrames += frames.length - kept.length;
        if (!flow.dropping) {
          flow.dropping = true;
          const member = room.members.get(target);
          this.log({ event: "backpressure", room: room.id.slice(0, 8), user: member?.user, id: member?.id,
            kind: member?.kind, buffered, dropping: true });
        }
      }
      frames = kept;
    } else if (flow.dropping) {
      flow.dropping = false;
      const member = room.members.get(target);
      this.log({ event: "backpressure", room: room.id.slice(0, 8), user: member?.user, id: member?.id,
        kind: member?.kind, buffered, dropping: false, droppedFrames: flow.droppedFrames,
        droppedBytes: flow.droppedBytes });
    }
    if (!frames.length) return;
    target.send(frames.length === 1 ? frames[0]! : joinBatch(frames));
    const after = target.bufferedAmount;
    if (after > flow.maxBuffered) flow.maxBuffered = after;
    if (after > RELAY_CLOSE_BUFFERED_BYTES) this.backlogged(room, target, after);
  }

  private backlogged(room: Room, target: WebSocket, buffered: number): void {
    const member = room.members.get(target);
    const flow = room.flows.get(target);
    room.backlogCloses++;
    this.log({ event: "backlogged", room: room.id.slice(0, 8), user: member?.user, id: member?.id,
      kind: member?.kind, buffered, droppedFrames: flow?.droppedFrames ?? 0 });
    close(target, CloseCode.Backlogged, "receiver too far behind");
    /* (its close frame would wait behind the backlog it cannot drain) */
    target.terminate();
  }
}
