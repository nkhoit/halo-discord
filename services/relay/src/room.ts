import { DurableObject } from "cloudflare:workers";

import {
  Channel,
  CloseCode,
  HEADER_BYTES,
  MAXIMUM_FRAME_BYTES,
  MAXIMUM_ROOM_SOCKETS,
  type Member,
  type SocketKind,
  carries,
  identifierText,
  isReliableChannel,
  parseMember,
  payloadLengthValid,
  writeIdentifier,
} from "./protocol";

function overlaps(a: SocketKind, b: SocketKind): boolean {
  return a === "both" || b === "both" || a === b;
}

function sendQuietly(socket: WebSocket, message: string | ArrayBuffer | Uint8Array): void {
  try {
    socket.send(message);
  } catch {
    /* closing: its close event removes it */
  }
}

function closeQuietly(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    /* already closed */
  }
}

/* One JSON line per socket event, for `wrangler tail` (diagnostic). */
function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

/* One room: a host and its guests. Frames travel host to guest and guest to
   host only, and every member's identity comes from its socket.

   The sockets are plain (not hibernatable) WebSockets. A room is busy for
   the whole match, so hibernation saves nothing, and its per-message event
   dispatch could not keep up with a match's few hundred frames a second in
   local development; a plain socket listener does. */
export class RelayRoom extends DurableObject<Env> {
  private members = new Map<WebSocket, Member>();
  private location: Promise<string> | null = null;

  /* Where this room runs, from Cloudflare's trace endpoint (diagnostic). */
  private roomColo(): Promise<string> {
    this.location ??= fetch("https://cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(1500) })
      .then((response) => response.text())
      .then((body) => /^colo=(\w+)$/m.exec(body)?.[1] ?? "unknown")
      .catch(() => "unknown");
    return this.location;
  }

  private present(id: string): boolean {
    for (const member of this.members.values()) {
      if (member.id === id && carries(member.kind, true)) return true;
    }
    return false;
  }

  /* Whom a member may reach: the host reaches every guest, a guest the host. */
  private counterpart(of: Member, other: Member): boolean {
    return of.id !== other.id && (of.role === "host") !== (other.role === "host");
  }

  private announce(about: Member, type: "peer-up" | "peer-down", except?: WebSocket): void {
    const message = JSON.stringify({ type, id: about.id });
    for (const [socket, member] of this.members) {
      if (socket !== except && this.counterpart(about, member) && carries(member.kind, true)) {
        sendQuietly(socket, message);
      }
    }
  }

  /* A reconnect with the same identity replaces that identity's sockets for
     the same traffic: the old ones may be half-open and never report closing. */
  private admit(joining: Member): { error: string | null; replaced: WebSocket[] } {
    const replaced: WebSocket[] = [];
    let host: Member | undefined;
    for (const [socket, member] of this.members) {
      if (member.role === "host") host = member;
      if (member.id !== joining.id) continue;
      if (member.role !== joining.role) return { error: "identifier in use", replaced: [] };
      if (overlaps(member.kind, joining.kind)) replaced.push(socket);
    }
    if (joining.role === "host" && host && host.id !== joining.id) {
      return { error: "room already has a host", replaced: [] };
    }
    if (this.members.size - replaced.length >= MAXIMUM_ROOM_SOCKETS) {
      return { error: "room full", replaced: [] };
    }
    return { error: null, replaced };
  }

  override async fetch(request: Request): Promise<Response> {
    const joining = parseMember(new URL(request.url));
    if (!joining) return new Response("invalid member", { status: 400 });
    const colo = { edge: request.headers.get("X-Relay-Colo") ?? "unknown", room: await this.roomColo() };
    const { error, replaced } = this.admit(joining);
    if (error) return new Response(error, { status: 409 });
    for (const socket of replaced) {
      this.members.delete(socket);
      closeQuietly(socket, CloseCode.Replaced, "replaced by a new connection");
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const since = Date.now();
    server.binaryType = "arraybuffer";
    server.accept();
    server.addEventListener("message", (event) => this.receive(server, event.data));
    server.addEventListener("close", (event) => {
      log({ event: "close", id: joining.id, kind: joining.kind, code: event.code,
        reason: event.reason, clean: event.wasClean, ageMs: Date.now() - since,
        known: this.members.has(server) });
      this.remove(server);
      closeQuietly(server, event.code, event.reason);
    });
    server.addEventListener("error", (event) => {
      log({ event: "error", id: joining.id, kind: joining.kind, ageMs: Date.now() - since,
        message: String((event as ErrorEvent).message ?? "") });
      this.remove(server);
    });
    this.members.set(server, joining);
    log({ event: "accept", id: joining.id, role: joining.role, kind: joining.kind, ...colo,
      replaced: replaced.length, sockets: this.members.size });

    const peers = new Set<string>();
    for (const member of this.members.values()) {
      if (this.counterpart(joining, member) && carries(member.kind, true)) peers.add(member.id);
    }
    server.send(JSON.stringify({
      type: "ready",
      self: { id: joining.id, role: joining.role, kind: joining.kind },
      peers: [...peers],
      colo,
    }));
    /* Also after a reconnect: the counterparts replay what the old socket lost. */
    if (carries(joining.kind, true)) this.announce(joining, "peer-up", server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private receive(socket: WebSocket, message: unknown): void {
    const sender = this.members.get(socket);
    if (!sender) return;
    if (!(message instanceof ArrayBuffer)) {
      closeQuietly(socket, CloseCode.UnsupportedData, "binary frames only");
      return;
    }
    if (message.byteLength > MAXIMUM_FRAME_BYTES) {
      closeQuietly(socket, CloseCode.MessageTooBig, "frame too large");
      return;
    }
    const bytes = new Uint8Array(message);
    const channel = bytes[0] ?? -1;
    if (bytes.byteLength < HEADER_BYTES ||
        !payloadLengthValid(channel, bytes.byteLength - HEADER_BYTES)) {
      closeQuietly(socket, CloseCode.PolicyViolation, "malformed frame");
      return;
    }
    if (channel === Channel.RelayEcho) {
      sendQuietly(socket, message);
      return;
    }
    const reliable = isReliableChannel(channel);
    if (!carries(sender.kind, reliable)) {
      closeQuietly(socket, CloseCode.PolicyViolation, "channel not carried by this socket");
      return;
    }

    const destination = identifierText(bytes.subarray(1, HEADER_BYTES));
    for (const [target, member] of this.members) {
      if (member.id === destination && this.counterpart(sender, member) &&
          carries(member.kind, reliable)) {
        writeIdentifier(bytes, sender.id);
        sendQuietly(target, bytes);
        return;
      }
    }
    /* No such counterpart (left, not yet joined, or not allowed): drop, as
       a network would. */
  }

  private remove(socket: WebSocket): void {
    const member = this.members.get(socket);
    if (!member) return;
    this.members.delete(socket);
    if (carries(member.kind, true) && !this.present(member.id)) {
      this.announce(member, "peer-down");
    }
  }
}
