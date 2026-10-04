# Networking

This document describes the network path for hosted Halo CE games, why it is a
WebSocket relay, and what was measured before that choice was kept.

The hosted game runs in two places:

- as a Discord Activity;
- as browser rooms on the same hosted page.

Both use the same game transport. The page connects to the self-hosted Node
server in [`server/`](../server/). The server serves the page and maps, owns
login, and relays game traffic between a room host and its guests. The game
uses the [distributed netcode](../port/linux/NETCODE.md), not lockstep.

## Overview

The path is:

```text
hosted page <-> WebSocket <-> Node relay <-> WebSocket <-> hosted page
```

A room has one host and its guests, up to 32 sockets in all (one per player,
or two with separate reliable and unreliable sockets). The relay is not a game server.
It does not simulate Halo. It authenticates sockets, tracks room membership,
stamps the sender identity onto frames, and forwards frames only between the
host and guests.

The design is optimized for the platform constraint first: Discord Activities
can reach the outside world through Discord's proxy with WebSockets. WebRTC
is not available there, and WebTransport is not available through that path.

## Why a WebSocket relay

WebRTC is the better browser transport for game traffic when it is available:
its data channels can avoid TCP head-of-line blocking, and browser-to-browser
paths can be short. The Activity environment decides this project differently.
Inside Discord, the Activity is loaded in a proxied frame. That path allows
WebSockets and ordinary HTTPS. It does not provide the WebRTC path the game
would need, and it does not provide WebTransport datagrams.

So the hosted transport is a WebSocket relay. Browser rooms use the same relay
so the Activity and browser page have one code path.

The risk is TCP. A WebSocket runs over TCP. One lost TCP segment holds back all
later bytes on that connection until retransmission completes. Halo sends
per-tick data often enough that this can show up as movement correction or
remote-player stalls. Measurements below set the bounds:

- clean or low-latency TCP legs are fine;
- one percent loss is acceptable when the impaired player's TCP round trip to
  the relay endpoint is under about 100 ms;
- the same loss on a roughly 130 ms leg causes visible burst gaps;
- three percent loss is too much for this relay;
- splitting reliable and unreliable channels across two sockets did not solve
  the problem because reliable per-tick traffic is still sent every tick.

## The relay

The relay lives in the self-hosted Node server described in
[halo-server.md](halo-server.md). It shares the origin with the hosted page,
maps, login, and Activity endpoints.

### Rooms and routing

A room has a host role and guest roles.

- Host frames route only to guests.
- Guest frames route only to the host.
- Guests never send directly to other guests.
- The destination peer is named by the client, but the relay overwrites the
  source peer with the authenticated socket's peer id before forwarding.
- A socket cannot claim another Discord user or another room member's Halo peer
  id.
- A build id is pinned per room. A different build is refused.
- A second host is refused unless it is the same reconnecting identity replacing
  a stale socket.

Room status is also exposed to the hosted lobby: no host, host waiting in the
lobby, host in a match, or host in a joinable match.

### Authentication

Browsers cannot set custom headers on a WebSocket. The socket therefore opens
first and sends one JSON authentication message:

```json
{"type":"auth","token":"...","id":"...","build":"..."}
```

The token comes from the server session. The relay takes the Discord account
identity and display name from that token. The `id` is only the Halo network
peer id for the room.

Sockets that do not authenticate quickly, authenticate incorrectly, send text
when only binary frames are allowed, send malformed frames, send oversized
frames, or send a channel that the socket kind does not carry are closed.

### Wire format and caps

Every binary WebSocket message is either one frame:

```text
[channel: u8][peer: 6 bytes][payload]
```

or a batch:

```text
[0x80][u16 length][frame][u16 length][frame]...
```

Current caps:

- room id: 8 to 128 URL-safe characters;
- build id: 1 to 96 characters;
- peer id: 12 hex digits;
- max rooms: configurable, default 64;
- max room sockets: 32 (32 players on one socket each, or 16 with separate
  reliable and unreliable sockets);
- max Halo payload: 16,396 bytes;
- max multicast frame (protocol 2): 3 + 32 × 14 + 16,396 bytes;
- max WebSocket message: 64 KiB;
- host control messages: 256 bytes.

The relay enforces the caps before forwarding.

### Backpressure

The relay watches each receiving socket's backlog (`bufferedAmount`):

- past 256 KiB, frames on the unreliable channels to it are dropped (a later
  tick's state overtakes them); reliable frames and acknowledgements still go;
- past 4 MiB, it is closed (code 4008, then terminated: its close frame would
  wait behind the backlog), and its client reconnects and resumes.

Other members are unaffected. The relay logs `backpressure` when a socket
starts and stops dropping and `backlogged` when it closes one; every `close`
log carries the socket's dropped frames and bytes, its largest backlog and
the room's counts.

### Protocol 2: fan-out

Without fan-out the host uploads its whole per-tick stream once per guest.
With relay protocol 2 it sends what is the same for several guests once, and
the relay copies it:

```text
[8][inner channel][n][n entries][payload]
entry: [slot: u8][generation: u8], and for a reliable frame
       [u32 sequence][u32 acknowledgement][u32 word]
```

- The client says `protocol: 2` in its auth; a room pins its protocol as it
  pins its build, so the two never mix.
- Every member identity has a relay slot and a generation, bumped whenever the
  slot changes hands, sent in `ready` and `peer-up`. A frame naming a slot
  whose holder changed reaches nobody, as if sent to someone who left.
- Each recipient gets exactly the frame the host would have sent it alone: its
  own sequence and acknowledgement, and its loopback connection identifier
  (`word`) in payload bytes 4 to 7. Guests and the engine are unchanged.
- The host's transport merges, at the end of a game frame, a run of reliable
  frames side by side for different guests that are the same but for those
  fields (the engine writing one message to every machine), and datagrams that
  are the same for several guests. Only neighbouring reliable frames merge, so
  a guest's reliable frames keep their order: unicast and broadcast frames to
  one guest share its sequence, in the order the engine wrote them.
- Recipients are whoever the engine wrote to, so machines still loading and
  per-machine messages (object sync, joins) are as before. A guest without a
  slot gets its own frames.

Lab, four machines, bots: host upload 278 kbit/s without fan-out, 137 with it,
against about 100 for one guest's download. The rest is per guest: TCP
acknowledgements of its uploads, its multicast entries, and probes.

### Batching

The client batches everything produced by one game frame. Batching is not per
30 Hz game tick because that would add up to 33 ms. Per-frame batching cuts
message count while keeping added delay to the frame that produced the data.

Loopback measurement, 120 s, guest moving:

| Mode | Messages/s guest / host | Frames per message guest / host | Relay echo RTT p50 guest / host |
| --- | --- | --- | --- |
| Batching off | 160 / 141 | 1.0 / 1.0 | 0.5 / 0.6 ms |
| Batching on | 110 / 50 | 1.46 / 2.83 | 4.7 / 5.9 ms |

Echo probes wait for two flushes because they are produced outside game
frames. Game frames leave at the end of the frame that produced them. Under
P1 impairment, one unbatched run had 0.48 gaps over 150 ms per minute at the
guest. Three batched runs had 1.5 to 3.84. All passed the bar; the difference
was small enough that batching stayed on.

### Reliable and unreliable channels

The game still has reliable and unreliable channels. Reliable frames carry a
sequence number and cumulative acknowledgement for end-to-end replay. The relay
does not interpret those fields. It only routes the frame.

The client can use one socket for both channels or two sockets, one reliable
and one unreliable. Two sockets reduce sharing between channels, but they do
not remove TCP head-of-line blocking from the game because host-to-guest
per-tick data exists on both channels.

In the remote relay measurements, two sockets did not improve the loss case:

| Relay | Room | P0 RTT p50 / p99 | P1 gaps >150 ms per min, guest / host | P1 guest gap p99 / max | Snaps, disconnects |
| --- | --- | --- | --- | --- | --- |
| 1 socket | nearby region | 78 / 200-256 ms | 16.5 / 28.3 | 161 / 260 ms | 0, 0 |
| 2 sockets | nearby region | 98 / 269-300 ms | 15 / 43 | 171 / 285 ms | 0, 0 |

The one-socket path is the normal path. The split path remains useful for
experiments.

### Resume and reconnect

When a relay socket closes, the client reconnects to the same room with the
same identity. Delays are 250 ms, then 0.5 s, 1 s, 2 s and 4 s. A reconnecting
socket replaces any stale socket for that identity, and the relay announces the
peer again so the other side replays reliable frames.

Reliable delivery is exactly-once and in order across reconnects:

- reliable frames have sequence numbers;
- acknowledgements are cumulative;
- each side keeps unacknowledged reliable frames up to 4 MiB; a peer past it is
  dropped and rejoins, rather than blocking the host's writes to everyone;
- duplicates after replay are discarded;
- unreliable frames without a path are dropped;
- a peer without a path for 20 s fails.

Resume tests drive two independent copies of the transport through an
in-memory relay that can drop sockets and hold frames in flight. The tests
cover guest drop, host drop, a lost acknowledgement, a stale socket, and a
relay restart.

Live in a match through the relay:

| Event | Outage | Longest per-tick gap | Result |
| --- | --- | --- | --- |
| Guest socket dropped | 413 ms | 673 ms | continued, 30 ticks/s, no snaps |
| Host socket dropped | 346 ms | 453 ms | continued |
| Relay restarted | 431-433 ms | 500-527 ms | continued |

Reconnect fixes connection loss. It does not fix TCP head-of-line blocking
while the connection remains up.

### Keepalive

The server sends protocol-level WebSocket pings. This keeps idle sockets alive
through proxies that close quiet WebSockets. Cloudflare's idle limit is 100 s,
and a host alone in a lobby may send no game traffic. The server also drops a
socket that stops answering pings.

## Netcode

Halo's original system-link model is lockstep. That is a poor fit for browser
and Activity rooms because every client would see its own input a full round
trip late.

Hosted play uses [`network.netcode = "distributed"`](../port/linux/NETCODE.md).
Each machine ticks on its own clock. A client predicts its own player from
local input. The host is authoritative for damage, deaths, objects, pickups,
scores, and game state. The host sends corrections, and clients draw them as
gliding updates instead of hard jumps where possible.

This is why a WebSocket relay can work at all. The relay may add latency and
jitter, but the client does not wait for the host before moving or firing.

## Joining a match in progress

Hosted pages enable [`network.join_in_progress`](../port/linux/NETCODE.md#joining-a-match-in-progress)
for hosts. A guest can join a running match instead of waiting for the next
lobby.

The relay only exposes whether the host's current match is joinable. The game
netcode does the real work: the late machine loads the map, takes the match
clock from the host, receives the host's objects, and then receives the same
unit, object, inventory, score, and game-type updates every client receives.

## Hosting

The current hosting model is one self-hosted Node process. It serves:

- the web build;
- authenticated maps and lobby images;
- browser login;
- Discord Activity login;
- room status;
- the WebSocket relay.

See [halo-server.md](halo-server.md) for the runbook. The process can sit
behind any HTTPS front end that forwards to the Node process. Activity relay
origins use the Discord origin shape `https://<APP_ID>.discordsays.com`.
Browser rooms use the site's own origin, for example `<your-domain>`.

The design intentionally does not depend on a particular host, tunnel, or CDN.
Rooms are in memory, so restarting the process drops rooms unless clients
reconnect after the process is back.

## Measurements and lab method

### Netstats

`?netstats=1` logs a measurement window every 5 s. It also exposes the last
hour through `HaloWebTransport.netStats()`. The measurement does not change
the wire format.

Each window includes:

- game ticks per second;
- own-unit corrections from the host;
- largest own-unit correction;
- host-refused predictions;
- frame gaps and frames over threshold;
- per-peer round trip;
- receive drops and queue depths;
- reliable and unreliable frames and bytes per second;
- receive gaps: median, p99, maximum, and counts over 150 ms and 300 ms.

Later diagnostic windows also included:

- own aim corrections;
- seat corrections;
- host inputs per tick;
- catch-up ticks per frame;
- shader compiles and links;
- texture uploads and evictions;
- map reads;
- main-thread event-loop lag and long tasks;
- relay bytes and message counts.

### Hidden pages stalled packet delivery

Two instances on one desktop showed rubber-banding even with stock WebRTC. The
cause was Chrome's timer throttling of hidden pages.

The game ticked in a worker. Packet delivery into WebAssembly used main-thread
`setTimeout` callbacks. Chrome runs hidden chained timers about once per
second. A hidden page then delivered at most one reliable frame and 16
datagrams per second, and its 256-datagram receive queue overflowed.

The packet pump moved to `MessageChannel`. Hidden pages do not throttle that
path. Timers remain only as a fallback when WebAssembly cannot accept more
packets.

Measured on one high-end desktop, Chrome, 240 Hz, Battle Creek Slayer. The
guest used scripted runs, strafes, reversals, and jumps. Both pages sampled
every 500 ms. Optional Chrome flags disabled background throttling for some
runs.

| Run | Pump | Flags | Host window | Length | Host fps / ticks | Host datagram drops | Guest own-unit snaps (>3.0 units) | Host rejected predictions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E1/E2 | timer | on | visible, other monitor | 40 s | 240 / 30.0 | not read | 0 | 0 |
| E3 | timer | on | visible, host moving | 40 s | 240 / 30.0 | not read | 0 | 0 |
| E4 | timer | on | minimized | 40 s | 240 / 30.0 | not read | 0 | 0 |
| E5 | timer | off | minimized | 40 s | 239 / 30.0 | 4,830 | 2, 3.07 units each | 0 |
| E6 | timer | off | covered by guest window | 40 s | 236 / 30.0 | not read | 0 | 0 |
| E7 | timer | off | visible, other monitor | 40 s | 235 / 30.0 | not read | 0 | 0 |
| E8 | MessageChannel | off | minimized | 40 s | 240 / 30.0 | 0 | 0 | 0 |
| E9 | MessageChannel | off | minimized | 90 s | 239 / 30.0 | 0 | 0 | 0 |

In E5 and E8 the hidden host's chained `setTimeout(1)` fired every about
1000 ms, compared with 1-5 ms when visible. With the timer pump, the host
applied the guest's predicted position up to a second late and sent back a
position more than the 3.0 unit correction tolerance behind. With the
MessageChannel pump, the same timer throttling no longer reached packet
delivery.

Frame pacing was otherwise clean: about 2.5 ms of CPU per frame per instance,
worst frame gaps 9-80 ms, and one 250 ms host stall. With localhost and zero
added latency, the netcode had no own-unit corrections and no rejected
predictions in either direction.

### Local relay baseline

A synthetic host/guest pair sent 100-byte frames each way plus ten relay
echoes per second against a local Worker development server. Plain WebSockets
were required; the hibernatable Worker WebSocket path backed up badly.

| Room sockets | 120 frames/s each way | 300 frames/s each way | 800 frames/s each way |
| --- | --- | --- | --- |
| hibernatable Worker socket | echo grows to about 140 ms | not run | collapses, frames lost |
| plain Worker socket | 0.7 ms | 0.5 ms, none lost | 0.6 ms, none lost |

A two-player match is about 300 frames per second through the room in total:
about 90 guest-to-host datagrams/s, about 34 reliable host-to-guest frames/s,
about 40 unreliable host-to-guest frames/s, plus echo traffic.

Two clients on one machine, local relay, zero added latency, guest moving:

| Transport | Ticks/s | Peer RTT p50 | Relay echo RTT p99 | Per-tick gap p99 (max) | Gaps >150 ms | Own-unit snaps | Drops |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WebRTC | 30 | about 0 ms | n/a | 34 ms | 0 | 0 | 0 |
| relay, 1 socket | 30 | 0.9 ms | 2.9 ms | 17-36 ms (38 ms) | 0 | 0 | 0 |
| relay, 2 sockets | 30 | 0.8 ms | 2.1 ms | 17-34 ms (34 ms) | 0 | 0 | 0 |

Locally, with no loss, the relay was indistinguishable from WebRTC.

### Remote Worker relay measurements

This was the first remote relay design. It used Cloudflare Workers and Durable
Objects. It is no longer the current hosting model, but the measurements are
kept because they isolate the TCP-over-distance risk.

Rig:

- one desktop;
- two Chrome profiles on separate monitors;
- Battle Creek Slayer;
- scripted guest movement;
- host idle;
- 120 s per profile;
- only 5 s `?netstats=1` windows fully inside the match counted;
- clumsy/WinDivert impaired only the guest leg.

Profiles:

- P0: clean;
- P1: 40 ms lag and 1% drop in each direction;
- P2: 40 ms lag and 3% drop in each direction;
- P3: two-second throttle bursts every 30 s.

The WebRTC rows are a best case because both browsers were on one machine and
WebRTC used loopback host candidates. The relay rows crossed the real network
and the Durable Object room.

| Transport | Profile | RTT p50 / p99 (ms) | Guest gap p99 / max (ms) | Gaps >150 ms per min, guest / host | Gaps >300 ms total | Own-unit snaps | Host refused predictions |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WebRTC loopback | P0 | 0 | 38 / 38 | 0 / 0 | 0 | 0 | 0 |
| WebRTC loopback | P1 | 94 | 67 / 95 | 0 / 0 | 0 | 0 | 0 |
| WebRTC loopback | P2 | 95 | 71 / 117 | 0 / 0 | 0 | 0 | 0 |
| WebRTC loopback | P3 | n/a | 38 / 1838 | 3.8 / 3.8 | 16 | 0 | 0 |
| Relay, 1 socket, near room | P0 | 81 / 171 | 53 / 131 | 0 / 0 | 0 | 0 | 0 |
| Relay, 1 socket, near room | P1 | 173 / 427 | 176 / 311 | 26.5 / 58.6 | 1 | 0 | 0 |
| Relay, 1 socket, near room | P2 | 266 / 701 | 198 / 425 | 73 / 134.5 | 13 | 0 | 0 |
| Relay, 1 socket, near room | P3 | 81 / 1981 | 53 / 1066 | 4 / 4 | 16 | 1 | 0 |
| Relay, 1 socket, far edge | P0 | 162 / 271 | 63 / 168 | 0.5 / 0 | 0 | 0 | 0 |
| Relay, 1 socket, far edge | P1 | 254 / 500 | 160 / 208 | 18 / 29.3 | 0 | 0 | 0 |
| Relay, 1 socket, far edge | P2 | 323 / 733 | 183 / 313 | 45 / 144.5 | 14 | 0 | 0 |
| Relay, 1 socket, far edge | P3 | 168 / 1919 | 70 / 1060 | 4.5 / 4 | 16 | 0 | 0 |
| Relay, 2 sockets | P0 | 133 / 232 | 64 / 141 | 0 / 0 | 0 | 10 | 14 |
| Relay, 2 sockets | P1 | 221 / 529 | 205 / 367 | 41 / 60.5 | 2 | 6 | 22 |
| Relay, 2 sockets | P2 | 238 / 653 | 220 / 410 | 99 / 150 | 8 | 0 | 0 |
| Relay, 2 sockets | P3 | 132 / 2233 | 57 / 1096 | 4 / 4 | 16 | 2 | 3 |

Every run held 30 ticks/s. There were no receive-queue drops, no late-datagram
drops at the sender, and at most 4 KiB buffered in a relay socket.

The relay recovered from P3 throttle bursts like WebRTC. The failure was P1 and
P2 loss on long TCP legs: loss caused many gaps over 150 ms, while WebRTC under
the same impairment had none. Two sockets did not help enough because reliable
per-tick traffic also blocked.

The remote Worker relay also had several abnormal client-side closes over about
95 minutes of relay sessions. Reconnect/resume was added after that. Some
closes were caused by room restarts during rollouts. Others did not reproduce
after socket close/error logging and reconnect were added.

### Room placement in the Worker design

Durable Object placement was then hinted from the host's connection. Fresh
rooms with both clients reaching a nearby edge measured:

| Room placement | Peer RTT p50 | p99 | One client-to-room leg, echo p50 |
| --- | --- | --- | --- |
| before, far room or far host edge | 133-162 ms | 232-271 ms | 30-133 ms |
| before, nearby room | 81 ms | 171 ms | 40 ms |
| after, nearby room | 80-82 ms | 134-178 ms | 40-42 ms |
| after, nearby room | 81 ms | 177 ms | 41 ms |
| after, best observed room | 62 ms | 274-285 ms | 31-33 ms |

The hint removed the worst rooms, but placement was still not deterministic.
The P0 median target was reachable only in the best observed placement, and
p99 still missed.

### Self-hosted relay impairment runs

The self-hosted Node relay replaced the Worker design. The key question was
whether the earlier failure came from TCP itself, from Cloudflare placement, or
from the client-side impairment tool.

Rig:

- a LAN server running the Node process in a container;
- two Chrome profiles on a desktop;
- scripted guest movement;
- 120 s per profile;
- `?netstats=1` summaries;
- Linux `netem` inside the container network namespace;
- egress and ingress qdiscs targeted only the impaired client's TCP port.

Verification: adding 40 ms each way on the guest's port moved the guest relay
echo from 4.9 ms to 84.8 ms while the host's echo stayed between 1.6 and
5.3 ms. The impairment was scoped to one client.

| Profile (guest leg; host leg) | Batching | Guest leg RTT | Peer RTT p50 / p99 | Gaps >150 ms per min, guest / host | Gap p99, guest / host | Gaps >300 ms | Snaps |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P0 clean | on | 4 ms | 8 / 14 ms | 0 / 0 | 38 / 18 ms | 0 | 0 |
| P1S, 20 ms + 1% | off | 41 ms | 42 / 135 ms | 0 / 0 | 81 / 75 ms | 0 | 0 |
| P1, 40 ms + 1%, three runs | on | 83-84 ms | 86 / 227-326 ms | 1.5-3.84 / 0 | 135-148 / 109-126 ms | 0 | 0 |
| P1, 40 ms + 1% | off | 92 ms | 93 / 250 ms | 0.48 / 0 | 128 / 107 ms | 0 | 0 |
| P2, 40 ms + 3% | on | 85 ms | 101 / 394 ms | 9.6 / 0 | 161 / 131 ms | 0 | 0 |
| P0L, 60 ms; 20 ms, no loss | off | 121 ms | 162 / 165 ms | 0 / 0 | 38 / 17 ms | 0 | 0 |
| P1L, 60 ms + 1%; 20 ms | off | 129 ms | 173 / 413 ms | 28 / 41.5 | 186 / 155 ms | 1 | 0 |

All runs held 30 ticks/s with no refused predictions, queue drops, or
disconnects. P0L shows a long path alone did not create gaps. P1L reproduced
the earlier Worker geometry and failure. The cause was loss on a long TCP leg:
once that leg's round trip passed about 100 ms, common recovery time exceeded
the 150 ms gap threshold.

### Real-play stutter investigation

Players reported their own character snapping back and their view jumping. The
netcode was not the cause.

A client's own position is its own within tolerance. The host corrects a
client's own unit only past 3.0 world units, and the host accepts the client's
position within 3.5 world units. A small latency hiccup cannot make an ordinary
one-step correction. A true correction would be a large jump and would also set
the unit's facing from the host.

In a two-PC home session:

- own corrections: 0 in every window for both players;
- own aim corrections: 0;
- refused predictions: 0;
- worst reported stutter: 591 ms frame gap and 17 ticks run in one frame on
  the guest;
- the host had a 154 ms frame gap at the same moment;
- another stall was 283 ms with 8-9 ticks in one frame;
- one separate transport stall had about 210 ms per-tick gaps on both clients.

The visible jump came from frame stalls and catch-up ticks. Mouse motion queued
during the stall applied at once when the page resumed.

A later session with attribution counters showed shader compilation as the
main source:

- worst stall: 208 ms frame gap;
- frame callback: 203 ms;
- shader compiles or links in that window: 31;
- longest compile/link: 155 ms;
- the host kept compiling throughout the match, reaching more than 600 in two
  minutes on one map;
- texture eviction happened, up to 48 drops in a window, but uploads were at
  most 1.8 ms and content hashing at most 0.7 ms;
- maps were fetched whole at load, 14-22 MB in 135-296 ms, and not during the
  match.

The shader cache key was too specific. Inputs and outputs from unused combiner
stages changed the key even when the generated GLSL text was the same. Caching
GL shaders by text fixed most repeated compilation.

After that fix:

- lab match: host saw 29 new pixel shader keys in 150 s and compiled once;
- guest saw 6 and compiled once;
- next real session: worst guest gaps fell from 208-591 ms to 9-16 ms;
- host worst gap was 61 ms.

Remaining match-start stalls were first-use shaders:

- guest: 629 ms frame, 622 ms frame callback, 44 shader compiles, 31 programs
  first drawn;
- host: 150 ms, 50 compiles;
- later host gaps: 25-61 ms with no compiles, first draws, or buffer overflow.

The follow-up was shader warm-up. Each map can have a shader manifest next to
its map file. The game compiles, links, and draws one point with each program
while the map loads so ANGLE builds the backing GPU program before the first
real frame.

Lab manifest recording used two headless Chrome containers with SwiftShader.
Two bot clients played each multiplayer map for 60-100 s. The merged manifests
had 38-65 programs per map and 10 for the menu, about 0.4-0.8 MB of text per
map. In a lab match on Blood Gulch with browser-learned lists cleared, warm-up
built 41 programs. The match still found 5 and 9 new programs, then 0-2 per
window. Programs built ahead showed no stall on first real draw; one window
first-drew 15 warmed programs with the longest callback at 40 ms.

### Frame pacing and feel telemetry

A fast display can drive unnecessary rendering work. The browser page now caps
rendering by default on displays faster than 165 Hz. The cap chooses the
largest whole fraction of the display rate at or below 120 fps. F8 cycles cap
off, 120, and 60.

On a 240 Hz host, frames over 33 / 50 / 100 ms per minute were:

| Cap | Frames >33 ms | Frames >50 ms | Frames >100 ms |
| --- | --- | --- | --- |
| off | 3.7 | 2.8 | 1.8 |
| 120 fps | 0.8 | 0 | 0 |
| 60 fps | 0 | 0 | 0 |

The uncapped gaps were from the browser not delivering animation frames:
`rafIntervalMaxMs` was 62.5, while `rafLateMaxMs` was 3.9.

The feel scorecard records, per player:

- freezes per minute in play;
- press-to-shot latency;
- hit-confirm latency;
- remote-player correction distance and snaps;
- held relayed input;
- own corrections;
- map loads and match starts separately.

Baseline before the cap default and before full feel telemetry, with 74 ms
peer round trip:

- host: 0.6 / 0.1 / 0 frames over 33 / 50 / 100 ms per minute, longest
  63.7 ms;
- guest: 0 / 0 / 0, longest 20.5 ms;
- own corrections: 0 for both;
- match start: loading gaps up to 1.1 s, then 308 ms in the host's first
  15 s.

A lab hit-confirm check used a headless Chromium container with SwiftShader,
scripted hits, and no movement. Frame numbers are not representative there.
Hit confirmation p50 was 100 ms at a 10 ms peer round trip and 217 ms at a
176 ms peer round trip, roughly a round trip plus one tick. Many scripted hit
reports were correctly refused by host validation.

## Earlier design: Cloudflare Workers

The first remote relay used Cloudflare Workers and Durable Objects. It was
removed in favor of the self-hosted Node server.

What was learned:

- Hibernatable Worker WebSockets were too slow for a busy room in local
  testing. Plain Worker WebSockets handled the synthetic rates.
- Durable Object placement could make clean relay RTT 80-160 ms before any
  impairment. Location hints improved this but did not make it deterministic.
- Loss on a long TCP leg caused the head-of-line blocking that mattered.
- Reconnect/resume is mandatory. A dropped WebSocket must be a sub-second
  stall, not the end of a game.
- The same process that serves the page, maps, auth, and relay is simpler.
  Rooms are in memory, tests are local, and there is no per-request relay
  billing model to reason about.

The Worker measurements remain useful as worst-case path data. They are not
instructions for the current deployment.

## Decisions

- Use a WebSocket relay because Discord Activities can use WebSockets through
  Discord's proxy, while WebRTC and WebTransport are not available there.
- Use one self-hosted Node process for the page, maps, auth, room status, and
  relay. See [halo-server.md](halo-server.md).
- Keep rooms in memory. A room is short-lived and tied to active sockets.
- Route only host to guest and guest to host. The host remains the authority.
- Stamp sender identity from the authenticated socket. Never trust the client
  to name itself on the wire.
- Keep per-frame batching. It cuts message count substantially and passed the
  impairment tests.
- Use one socket normally. Two sockets did not remove the measured TCP loss
  problem.
- Keep reconnect/resume. It turns drops and restarts into short stalls.
- Keep protocol pings. Idle sockets must survive proxy idle limits.
- Use distributed netcode. Lockstep would make the relay unplayable at normal
  internet latency.
- Enable join in progress for hosted rooms so Activity guests can enter a
  running match when the game says it is safe.
- Put the server close to players. Clean latency alone is fine, but loss on a
  long TCP leg is not.
- Treat shader compilation and frame pacing as networking-adjacent. They can
  look like rubber-banding even when the network and netcode are clean.
