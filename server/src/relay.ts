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
  since: number;
}

export type Log = (entry: Record<string, unknown>) => void;

export const consoleLog: Log = (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));

class Room {
  readonly members = new Map<WebSocket, Member>();
  build: string | null = null;
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

  /* Admits an authenticated socket, or closes it with the reason it cannot join. */
  join(socket: WebSocket, roomId: string, joining: Omit<Member, "since">, build: string): void {
    let room = this.rooms.get(roomId);
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
    const member: Member = { ...joining, since: Date.now() };
    room.members.set(socket, member);
    this.log({ event: "accept", room: roomId.slice(0, 8), user: member.user, id: member.id,
      role: member.role, kind: member.kind, replaced: replaced.length, sockets: room.members.size });

    socket.on("message", (data, isBinary) => this.receive(room, socket, data, isBinary));
    socket.on("close", (code, reason) => {
      this.log({ event: "close", room: roomId.slice(0, 8), user: member.user, id: member.id,
        kind: member.kind, code, reason: reason.toString(), ageMs: Date.now() - member.since,
        current: room.members.get(socket) === member });
      this.remove(room, socket);
    });
    socket.on("error", (error) => {
      this.log({ event: "error", room: roomId.slice(0, 8), user: member.user, id: member.id,
        message: error.message });
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
     joining: the host's display name, if any, and the number of players. */
  summary(roomId: string): { host: string | null; players: number } {
    const room = this.rooms.get(roomId);
    if (!room) return { host: null, players: 0 };
    let host: string | null = null;
    const players = new Set<string>();
    for (const member of room.members.values()) {
      if (!carries(member.kind, true)) continue;
      players.add(member.id);
      if (member.role === "host") host = member.name;
    }
    return { host, players: players.size };
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
    if (!member) return;
    room.members.delete(socket);
    if (carries(member.kind, true) && !room.present(member.id)) this.announce(room, member, "peer-down");
    if (!room.members.size) this.rooms.delete(room.id);
  }

  private receive(room: Room, socket: WebSocket, data: RawData, isBinary: boolean): void {
    const sender = room.members.get(socket);
    if (!sender) return;
    if (!isBinary) return close(socket, CloseCode.UnsupportedData, "binary frames only");
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
    for (const [target, list] of outgoing) send(target, list.length === 1 ? list[0]! : joinBatch(list));
  }
}
