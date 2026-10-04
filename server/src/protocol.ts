/* Relay wire format, shared with port/web/library_web_transport.js.

   Every binary WebSocket message is either one frame,
   [channel: u8][peer: 6 bytes][payload], or a batch of frames,
   [0x80][u16 length][frame][u16 length][frame]..., which a client sends to
   coalesce everything one game frame produced. A client names the
   destination peer; the relay overwrites it with the sender's identifier
   before forwarding, so a peer cannot speak for another.

   Protocol 2 (a client says so in its auth; a room is one protocol or the
   other) adds a frame the host sends once for many guests (Channel.Multicast):
   [8][inner channel: 0 reliable or 1 unreliable][n: u8][n entries][payload],
   an entry [slot: u8][generation: u8], and for a reliable frame the
   recipient's own [u32 sequence] after it. Each recipient gets an ordinary
   frame from the host, [inner channel][host's identifier] and for a reliable
   frame [u32 sequence][u32 acknowledgement: 0], then the payload, so a guest
   reads one sequence from the host whichever way a frame was sent. The relay
   gives every member's identity a slot, and the slot a new generation each
   time it changes hands (in "ready" and "peer-up"), so a frame named for
   someone who left reaches nobody, not whoever took the slot. */

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
export const RELAY_PROTOCOLS: readonly number[] = [1, 2];
/* (protocol 2) one per identity, so never more than sockets */
export const MAXIMUM_SLOTS = MAXIMUM_ROOM_SOCKETS;
export const MULTICAST_HEADER_BYTES = 3;
export const MAXIMUM_MULTICAST_FRAME_BYTES = MULTICAST_HEADER_BYTES + MAXIMUM_SLOTS * 6 + MAXIMUM_HALO_FRAME_BYTES;

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
  /* (protocol 2, the host only) one frame for many guests */
  Multicast: 8,
} as const;

export const CloseCode = {
  UnsupportedData: 1003,
  PolicyViolation: 1008,
  MessageTooBig: 1009,
  /* The same identity reconnected; this socket is stale. */
  Replaced: 4000,
  /* The receiver fell too far behind (RELAY_CLOSE_BUFFERED_BYTES); its client
     reconnects and resumes. */
  Backlogged: 4008,
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
const GUILD_INSTANCE_PATTERN = /^i-\d{1,20}-gc-(\d{1,20})-(\d{1,20})$/;
export const GUILD_ID_PATTERN = /^\d{1,20}$/;

/* The guild and voice channel an Activity instance runs in; null for an
   instance outside a server (a DM or group DM). */
export function instanceLocation(instanceId: string): { guild: string; channel: string } | null {
  const match = GUILD_INSTANCE_PATTERN.exec(instanceId);
  return match ? { guild: match[1]!, channel: match[2]! } : null;
}

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

export interface MulticastRecipient {
  slot: number;
  generation: number;
  /* (reliable) the recipient's own sequence number */
  sequence: number;
}

export interface Multicast {
  reliable: boolean;
  recipients: MulticastRecipient[];
  payload: Uint8Array;
}

/* A multicast frame's parts, or null if it is malformed: an inner channel
   other than reliable or unreliable, no recipients or more than there are
   slots, a slot out of range or named twice, entries past the end, or a
   payload outside the inner channel's bounds. */
export function parseMulticast(frame: Uint8Array): Multicast | null {
  if (frame.byteLength < MULTICAST_HEADER_BYTES || frame[0] !== Channel.Multicast ||
      frame.byteLength > MAXIMUM_MULTICAST_FRAME_BYTES) return null;
  const inner = frame[1]!;
  if (inner !== Channel.Reliable && inner !== Channel.Unreliable) return null;
  const reliable = inner === Channel.Reliable;
  const count = frame[2]!;
  const entryBytes = reliable ? 6 : 2;
  if (count < 1 || count > MAXIMUM_SLOTS) return null;
  const payloadOffset = MULTICAST_HEADER_BYTES + count * entryBytes;
  if (payloadOffset > frame.byteLength) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const recipients: MulticastRecipient[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < count; index++) {
    const offset = MULTICAST_HEADER_BYTES + index * entryBytes;
    const slot = frame[offset]!;
    if (slot >= MAXIMUM_SLOTS || seen.has(slot)) return null;
    seen.add(slot);
    recipients.push({ slot, generation: frame[offset + 1]!, sequence: reliable ? view.getUint32(offset + 2) : 0 });
  }
  const payload = frame.subarray(payloadOffset);
  if (payload.byteLength < MINIMUM_HALO_FRAME_BYTES || payload.byteLength > MAXIMUM_HALO_FRAME_BYTES) return null;
  return { reliable, recipients, payload };
}

/* The frame a recipient of a multicast gets, from the host. */
export function multicastCopy(multicast: Multicast, recipient: MulticastRecipient, host: string): Uint8Array {
  const prefix = HEADER_BYTES + (multicast.reliable ? SEQUENCE_BYTES : 0);
  const copy = new Uint8Array(prefix + multicast.payload.byteLength);
  copy[0] = multicast.reliable ? Channel.Reliable : Channel.Unreliable;
  writeIdentifier(copy, host);
  if (multicast.reliable) new DataView(copy.buffer).setUint32(HEADER_BYTES, recipient.sequence);
  copy.set(multicast.payload, prefix);
  return copy;
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
