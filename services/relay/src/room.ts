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

/* One room: a host and its guests. Frames travel host to guest and guest to
   host only, and every member's identity comes from its socket.

   The sockets are plain (not hibernatable) WebSockets. A room is busy for
   the whole match, so hibernation saves nothing, and its per-message event
   dispatch could not keep up with a match's few hundred frames a second in
   local development; a plain socket listener does. */
export class RelayRoom extends DurableObject<Env> {
  private members = new Map<WebSocket, Member>();

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

  private admissionError(joining: Member): string | null {
    const members = [...this.members.values()];
    if (members.length >= MAXIMUM_ROOM_SOCKETS) return "room full";
    const host = members.find((member) => member.role === "host");
    if (joining.role === "host" && host && host.id !== joining.id) return "room already has a host";
    for (const member of members) {
      if (member.id !== joining.id) continue;
      if (member.role !== joining.role) return "identifier in use";
      if (overlaps(member.kind, joining.kind)) return "duplicate socket";
    }
    return null;
  }

  override async fetch(request: Request): Promise<Response> {
    const joining = parseMember(new URL(request.url));
    if (!joining) return new Response("invalid member", { status: 400 });
    const error = this.admissionError(joining);
    if (error) return new Response(error, { status: 409 });

    const wasPresent = this.present(joining.id);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.binaryType = "arraybuffer";
    server.accept();
    server.addEventListener("message", (event) => this.receive(server, event.data));
    server.addEventListener("close", (event) => {
      this.remove(server);
      closeQuietly(server, event.code, event.reason);
    });
    server.addEventListener("error", () => this.remove(server));
    this.members.set(server, joining);

    const peers = new Set<string>();
    for (const member of this.members.values()) {
      if (this.counterpart(joining, member) && carries(member.kind, true)) peers.add(member.id);
    }
    server.send(JSON.stringify({
      type: "ready",
      self: { id: joining.id, role: joining.role, kind: joining.kind },
      peers: [...peers],
    }));
    if (!wasPresent && carries(joining.kind, true)) this.announce(joining, "peer-up", server);
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
