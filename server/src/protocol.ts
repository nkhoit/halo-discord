/* Relay wire format, shared with port/web/library_web_transport.js.

   Every binary WebSocket message is either one frame,
   [channel: u8][peer: 6 bytes][payload], or a batch of frames,
   [0x80][u16 length][frame][u16 length][frame]..., which a client sends to
   coalesce everything one game frame produced. A client names the
   destination peer; the relay overwrites it with the sender's identifier
   before forwarding, so a peer cannot speak for another. */

export const HEADER_BYTES = 7;
/* Reliable frames start with [u32 sequence][u32 acknowledgement] for the
   clients' end-to-end replay; the relay does not read them. */
export const SEQUENCE_BYTES = 8;
export const MINIMUM_HALO_FRAME_BYTES = 12;
export const MAXIMUM_HALO_FRAME_BYTES = 16396;
export const MAXIMUM_FRAME_BYTES = HEADER_BYTES + SEQUENCE_BYTES + MAXIMUM_HALO_FRAME_BYTES;
export const ACK_BYTES = 4;
export const MAXIMUM_PROBE_BYTES = 64;
export const BATCH_MARKER = 0x80;
export const MAXIMUM_BATCH_BYTES = 64 * 1024;
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
  Unauthorized: 4401,
  Refused: 4409,
} as const;

export type Role = "host" | "guest";
/* "both" carries every channel; "reliable" and "unreliable" split them. */
export type SocketKind = "both" | "reliable" | "unreliable";

const SOCKET_KINDS: Record<string, SocketKind> = { both: "both", r: "reliable", u: "unreliable" };

export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
export const IDENTIFIER_PATTERN = /^[0-9a-f]{12}$/;
export const BUILD_PATTERN = /^[A-Za-z0-9._-]{1,96}$/;
/* A Discord Activity instance id, e.g. i-<snowflake>-gc-<guild>-<channel>. */
export const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function parseSocketQuery(url: URL): { role: Role; kind: SocketKind } | null {
  const role = url.searchParams.get("role");
  const kind = SOCKET_KINDS[url.searchParams.get("ch") ?? "both"];
  if ((role !== "host" && role !== "guest") || !kind) return null;
  return { role, kind };
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

export function frameValid(frame: Uint8Array): boolean {
  return frame.byteLength >= HEADER_BYTES &&
    payloadLengthValid(frame[0] ?? -1, frame.byteLength - HEADER_BYTES);
}

/* The frames of a batch, or null if it is malformed. */
export function splitBatch(message: Uint8Array): Uint8Array[] | null {
  if (message[0] !== BATCH_MARKER || message.byteLength > MAXIMUM_BATCH_BYTES) return null;
  const frames: Uint8Array[] = [];
  let offset = 1;
  while (offset < message.byteLength) {
    if (offset + 2 > message.byteLength) return null;
    const length = (message[offset]! << 8) | message[offset + 1]!;
    offset += 2;
    if (length === 0 || offset + length > message.byteLength) return null;
    frames.push(message.subarray(offset, offset + length));
    offset += length;
  }
  return frames.length ? frames : null;
}

export function joinBatch(frames: Uint8Array[]): Uint8Array {
  let size = 1;
  for (const frame of frames) size += 2 + frame.byteLength;
  const message = new Uint8Array(size);
  message[0] = BATCH_MARKER;
  let offset = 1;
  for (const frame of frames) {
    message[offset] = frame.byteLength >> 8;
    message[offset + 1] = frame.byteLength & 0xff;
    message.set(frame, offset + 2);
    offset += 2 + frame.byteLength;
  }
  return message;
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

/* A display name safe to show anywhere: printable, single-line, bounded. */
export function sanitizeName(value: unknown): string {
  if (typeof value !== "string") return "Player";
  const cleaned = Array.from(value.normalize("NFKC").replace(/[\p{C}\p{Z}]+/gu, " ").trim())
    .slice(0, 32).join("").trim();
  return cleaned || "Player";
}
