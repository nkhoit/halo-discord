# Halo WebSocket relay (spike)

A Cloudflare Worker with one Durable Object per room that forwards Halo's
game frames between a host and its guests over WebSockets. It exists to
measure whether a TCP relay plays acceptably (see
`docs/websocket-relay-spike.md`). It serves no assets, keeps nothing in
storage, and is not deployed by CI.

## Connecting

```
GET /v1/rooms/:roomId/ws?role=host|guest&id=<12 hex>&ch=both|r|u
Upgrade: websocket
Origin: <one of ALLOWED_ORIGINS>
```

- `roomId` is the signaling service's room ID (8-128 of `A-Za-z0-9_-`).
- `id` is the browser's Halo network identifier, unique within the room.
- `ch=both` carries every channel on one socket; `r` and `u` split reliable
  and unreliable traffic across two sockets of the same peer.

A room accepts one host identifier and at most 32 sockets; anything else is
refused with 409. A connection with an identity and channel class that is
already connected replaces the old socket (closed with 4000), because after a
network failure the old one can stay half-open; the counterparts get `peer-up`
again so they replay what the old socket lost.

The host's first connection creates the room with a Durable Object location
hint for the host's own location (`wnam`, `enam`, `weur`, ...), from
`request.cf`, rather than wherever its edge happens to be.

## Frames

Binary messages only: `[channel: u8][peer: 6 bytes][payload]`.

| Channel | Meaning | Payload |
| --- | --- | --- |
| 0 | reliable Halo frame: `[u32 sequence][u32 acknowledgement][frame]` | 20-16404 bytes |
| 1 | unreliable Halo frame | 12-16396 bytes |
| 2 / 3 | ping / pong on the reliable socket | 1-64 bytes |
| 4 / 5 | ping / pong on the unreliable socket | 1-64 bytes |
| 6 | echoed by the relay itself | 1-64 bytes |
| 7 | acknowledgement: `[u32 sequence]` | 4 bytes |

Sequence numbers and acknowledgements are end to end between the two
clients, which replay unacknowledged frames after any reconnect and drop
duplicates (`port/web/library_web_transport.js`); the relay does not read
them. Channels 0, 2, 3 and 7 travel on the reliable socket.

A client names the destination peer; the relay replaces it with the sender's
identifier before forwarding. Guests reach only the host and the host reaches
only its guests; frames for anyone else are dropped. Text frames close the
socket with 1003, malformed frames with 1008, and frames over 16411 bytes
with 1009.

The relay sends small JSON text messages on each peer's reliable socket:
`ready` (with the counterparts already present and the data centers of the
client's edge and of the room), `peer-up` and `peer-down`. Every accept, close
and error is logged as one JSON line for `wrangler tail`.

## Development

```sh
npm ci
npm run check   # types, TypeScript, tests, dry-run bundle
npm run dev     # local relay on http://127.0.0.1:8787
```
