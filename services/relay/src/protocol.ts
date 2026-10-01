/* Relay wire format, shared by the Worker and the room.

   Every binary WebSocket message is [channel: u8][peer: 6 bytes][payload].
   A client names the destination peer; the relay overwrites the field with
   the sender's identifier before forwarding, so a peer cannot speak for
   another. */

export const HEADER_BYTES = 7;
/* Reliable frames start with [u32 sequence][u32 acknowledgement] for the
   clients' end-to-end replay; the relay does not read them. */
export const SEQUENCE_BYTES = 8;
export const MINIMUM_HALO_FRAME_BYTES = 12;
export const MAXIMUM_HALO_FRAME_BYTES = 16396;
export const MAXIMUM_FRAME_BYTES = HEADER_BYTES + SEQUENCE_BYTES + MAXIMUM_HALO_FRAME_BYTES;
export const ACK_BYTES = 4;
export const MAXIMUM_PROBE_BYTES = 64;
/* One host and fifteen guests, each with a reliable and an unreliable socket. */
export const MAXIMUM_ROOM_SOCKETS = 32;

export const Channel = {
  Reliable: 0,
  Unreliable: 1,
  PingReliable: 2,
  PongReliable: 3,
  PingUnreliable: 4,
  PongUnreliable: 5,
  /* Echoed by the relay itself: the client-to-relay round trip. */
  RelayEcho: 6,
  /* [u32 acknowledgement] for the peer's reliable frames. */
  Ack: 7,
} as const;

export const CloseCode = {
  UnsupportedData: 1003,
  PolicyViolation: 1008,
  MessageTooBig: 1009,
  /* The same identity reconnected; this socket is stale. */
  Replaced: 4000,
} as const;

export type Role = "host" | "guest";
/* "both" carries every channel; "reliable" and "unreliable" split them. */
export type SocketKind = "both" | "reliable" | "unreliable";

export interface Member {
  role: Role;
  id: string;
  kind: SocketKind;
}

const SOCKET_KINDS: Record<string, SocketKind> = {
  both: "both",
  r: "reliable",
  u: "unreliable",
};

export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const IDENTIFIER_PATTERN = /^[0-9a-f]{12}$/;

export function parseMember(url: URL): Member | null {
  const role = url.searchParams.get("role");
  const id = url.searchParams.get("id");
  const kind = SOCKET_KINDS[url.searchParams.get("ch") ?? "both"];
  if ((role !== "host" && role !== "guest") || !id || !IDENTIFIER_PATTERN.test(id) || !kind) {
    return null;
  }
  return { role, id, kind };
}

export function isReliableChannel(channel: number): boolean {
  return channel === Channel.Reliable || channel === Channel.PingReliable ||
    channel === Channel.PongReliable || channel === Channel.Ack;
}

export function carries(kind: SocketKind, reliable: boolean): boolean {
  return kind === "both" || kind === (reliable ? "reliable" : "unreliable");
}

export function payloadLengthValid(channel: number, length: number): boolean {
  if (channel === Channel.Reliable) {
    return length >= SEQUENCE_BYTES + MINIMUM_HALO_FRAME_BYTES &&
      length <= SEQUENCE_BYTES + MAXIMUM_HALO_FRAME_BYTES;
  }
  if (channel === Channel.Unreliable) {
    return length >= MINIMUM_HALO_FRAME_BYTES && length <= MAXIMUM_HALO_FRAME_BYTES;
  }
  if (channel === Channel.Ack) return length === ACK_BYTES;
  if (channel > Channel.Unreliable && channel <= Channel.RelayEcho) {
    return length >= 1 && length <= MAXIMUM_PROBE_BYTES;
  }
  return false;
}

export function identifierText(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0");
  return text;
}

export function writeIdentifier(bytes: Uint8Array, id: string): void {
  for (let index = 0; index < 6; index++) {
    bytes[1 + index] = parseInt(id.slice(index * 2, index * 2 + 2), 16);
  }
}
