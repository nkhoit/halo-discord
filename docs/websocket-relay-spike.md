# WebSocket relay spike: results

Is Halo still fun when every multiplayer packet goes through a WebSocket relay
instead of WebRTC? This note records the test setup, measurements and the
GO/NO-GO.

## Resume here (updated 2026-10-01)

Done and committed: local Windows build, hidden-page pump fix, `?netstats=1`,
`services/relay` with tests, the `?transport=relay` client, local results, and
the P0-P3 runs with a GO/NO-GO (see "Measurements through the deployed
relay").

Deployed: `services/relay` as Worker `halo-relay-spike` on the
cloudflare@khoit.dev account, `https://halo-relay-spike.halo-ce-nkhoit.workers.dev`.
Current version `a2336159-740f-4168-ad02-c49a832e29af` (resume, room
placement, close logging); earlier versions `b9dc076d`, `177ec9c5`,
`f0abcbfd`. ALLOWED_ORIGINS is loopback-only.

Teardown when the spike ends (deletes the Worker and its Durable Objects):

```powershell
cd services\relay; npx wrangler delete halo-relay-spike
```

Pending: the P1 re-run after the fixes (needs one accepted UAC prompt for the
clumsy controller), a subjective play check by a person, and the decision on
how friends would run the client for a real test.

Restart the local setup (PowerShell, repository root):

```powershell
# build.ninja (ignored) already names build\emsdk's emcc; if it is missing:
#   python configure.py --release --pgo=off --lto=off --web-cc=build\emsdk\upstream\emscripten\emcc.exe
ninja web
python tools\web_local_config.py --relay http://127.0.0.1:8788   # or the deployed relay URL
# each in its own terminal:
python tools\web_serve.py --port 8765
cd services\signaling; npx wrangler dev --port 8787 --ip 127.0.0.1 --local   # uses the ignored .dev.vars
cd services\relay; npx wrangler dev --port 8788 --ip 127.0.0.1 --local
```

Local-only pieces that are not in Git and must exist: `assets\maps` (from
`tools\xiso_extract.py`), the junction `build\web\assets\maps -> assets\maps`,
an empty `port\web\assets` directory, and `services\signaling\.dev.vars`
(`ENVIRONMENT=development`, `TURNSTILE_TEST_BYPASS=true`, random
`ROOM_ID_SECRET`, `ABUSE_ID_SECRET`, `ADMIN_TOKEN`, `TURNSTILE_SECRET`).

Then open two Chrome profiles at
`http://127.0.0.1:8765/build/web/halo.html?netstats=1` (add
`&transport=relay`, optionally `&relaySockets=2`), host in one, join with the
invite in the other, and read `HaloWebTransport.netStats()` in each.

## Build

- Native Windows with emsdk 6.0.10 (6.0.9 behaves the same).
  `python configure.py --release --pgo=off --lto=off --web-cc=<emsdk>\upstream\emscripten\emcc.exe`,
  `ninja web`, then `python tools/web_local_config.py` after every link.
- Maps: `python tools/xiso_extract.py <xiso> --output assets/maps`, and a
  junction `build/web/assets/maps -> assets/maps` (the game resolves maps
  relative to the page; `tools/web_serve.py` serves the repository root).
- Local signaling: `services/signaling`, `wrangler dev --port 8787` with an
  ignored `.dev.vars` holding `ENVIRONMENT=development`,
  `TURNSTILE_TEST_BYPASS=true` and random secrets.

## Hidden pages stalled packet delivery (fixed)

Two instances on one machine showed rubber-banding with stock WebRTC. The
cause was Chrome's timer throttling of hidden pages, not the netcode and not
CPU/GPU contention.

The game runs on a worker's `requestAnimationFrame` and keeps its 30 Hz tick
when its page is hidden. `library_web_transport.js`, however, moved received
packets into WebAssembly from main-thread `setTimeout` callbacks, and Chrome
runs a hidden page's chained timers about once per second. A hidden page then
delivered at most one reliable frame and 16 datagrams per second, and its
256-datagram receive queue overflowed. The pump is now posted through a
`MessageChannel`, which hidden pages do not throttle; only retries that make
no progress (a full socket in WebAssembly) fall back to a timer.

Measured on one machine (Ryzen 7 9800X3D, RTX 5090, Chrome 154, 240 Hz),
Battle Creek Slayer, guest driven by a scripted mix of runs, rapid strafes,
reversals and jumps; both pages sampled every 500 ms. "Flags" are Chrome's
`--disable-background-timer-throttling --disable-renderer-backgrounding
--disable-backgrounding-occluded-windows`.

| Run | Pump | Flags | Host window | Length | Host fps / ticks | Host datagram drops | Guest own-unit snaps (> 3.0 units) | Host rejected predictions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E1/E2 | timer | on | visible, other monitor | 40 s | 240 / 30.0 | not read | 0 | 0 |
| E3 (host moving) | timer | on | visible | 40 s | 240 / 30.0 | not read | 0 | 0 |
| E4 | timer | on | minimized | 40 s | 240 / 30.0 | not read | 0 | 0 |
| E5 | timer | off | minimized | 40 s | 239 / 30.0 | 4,830* | 2, 3.07 units each | 0 |
| E6 | timer | off | covered by the guest window | 40 s | 236 / 30.0 | not read | 0 | 0 |
| E7 | timer | off | visible, other monitor | 40 s | 235 / 30.0 | not read | 0 | 0 |
| E8 | MessageChannel | off | minimized | 40 s | 240 / 30.0 | 0 | 0 | 0 |
| E9 | MessageChannel | off | minimized | 90 s | 239 / 30.0 | 0 | 0 | 0 |

*Read once after E5-E7 and a further 30 s with the host minimized; the host was hidden only during E5 and that probe. In E5 and E8 the hidden host's chained `setTimeout(1)` fired every ~1000 ms
(1-5 ms when visible). With the timer pump the host applied the guest's
predicted position up to a second late, so the position it sent back was more
than `LOCAL_CORRECTION_TOLERANCE` (3.0 units) behind and the guest snapped
back. With the MessageChannel pump the same throttling no longer reaches
packet delivery.

Frame pacing was clean in every run (about 2.5 ms of CPU per frame per
instance; worst frame gaps 9-80 ms, with a single 250 ms host stall in E3), so
two instances on this machine do not contend. With localhost and zero added
latency the netcode itself never snapped: no own-unit corrections and no
rejected predictions in either direction.

Measurement setup: keep both windows visible where practical. The Chrome
flags above are optional belt-and-braces for measurement runs; the baseline
no longer depends on them.

## Measuring: `?netstats=1`

Open the page with `?netstats=1` to log a measurement window to the console
every 5 s; `HaloWebTransport.netStats()` returns the last hour of windows.
Nothing is sent anywhere and nothing changes on the wire. Each window has:

- `game`: ticks per second, own-unit corrections from the host (the
  rubber-band count, > 3.0 world units) and the largest since start, the
  predictions the host refused (> 3.5 units), the longest frame gap and frames
  more than 50 ms apart.
- per peer: round-trip time (WebRTC's selected candidate pair), datagrams
  dropped from the receive queue, queue depths, and for each channel frames and
  bytes per second and receive gaps (median, p99, maximum, counts over 150 and
  300 ms).

Host to guest, the game sends both channels every tick (about 34 reliable and
40 unreliable frames per second), so head-of-line blocking on a reliable
stream also delays per-tick data.

## WebSocket relay: local results

Use: `python tools/web_local_config.py --relay <relay URL>` after `ninja web`,
then open the page with `?transport=relay` (and `&relaySockets=2` to split
reliable and unreliable traffic across two sockets). Rooms and invites still
come from the signaling service; only gameplay frames change path.

Relay capacity, measured with a synthetic host/guest pair sending 100-byte
frames each way plus 10 relay echoes a second, against `wrangler dev` on this
machine:

| Room sockets | 120 frames/s each way | 300 frames/s each way | 800 frames/s each way |
| --- | --- | --- | --- |
| hibernatable (`ctx.acceptWebSocket`) | echo grows to ~140 ms | not run | collapses, frames lost |
| plain (`server.accept()`) | 0.7 ms | 0.5 ms, none lost | 0.6 ms, none lost |

A two-player match is about 300 frames a second through the room in total
(guest to host about 90 datagrams/s, host to guest about 34 reliable and 40
unreliable frames/s, plus probes). Through the hibernatable room it backed up
until relay echoes took 11-13 s and the join failed, so the room uses plain
WebSockets; a busy room never hibernates anyway. Whether hosted Durable
Objects share the hibernation dispatch cost was not measured.

Two clients on one machine, local relay, zero added latency, guest moving
(windows fully in a match only):

| Transport | Ticks/s | Peer RTT p50 | Probe RTT p99 | Per-tick gap p99 (max) | Gaps > 150 ms | Own-unit snaps | Drops |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WebRTC | 30 | ~0 ms | n/a | 34 ms | 0 | 0 | 0 |
| relay, 1 socket | 30 | 0.9 ms | 2.9 ms | 17-36 ms (38 ms) | 0 | 0 | 0 |
| relay, 2 sockets | 30 | 0.8 ms | 2.1 ms | 17-34 ms (34 ms) | 0 | 0 | 0 |

Locally, with no loss, the relay is indistinguishable from WebRTC. The
question this spike answers is what loss and distance do to it; that needs
the deployed relay.

## Measurements through the deployed relay (2026-10-01)

### Rig and confounders

One PC (Ryzen 7 9800X3D, Chrome 154), two Chrome profiles on separate
monitors, Battle Creek Slayer, guest driven by a scripted loop of runs, rapid
strafes, reversals and jumps; host idle. Each profile ran for about 120 s;
only 5-second `?netstats=1` windows fully inside the match and fully under the
profile count. Impairment was clumsy 0.3 (WinDivert), started with arguments
by a small elevated controller.

- Impairment is scoped to the guest only, never doubled. Relay: clumsy filters
  the guest's own TCP connection(s) to Cloudflare by local port, both
  directions; the host's relay leg is untouched (its relay echo stays at its
  baseline while the guest's rises). WebRTC: clumsy filters the guest's UDP
  port. Both browsers are on one machine, so WebRTC travels over loopback with
  host candidates; WinDivert sees loopback packets only as outbound, which
  covers both directions. Verified before the runs: P2 raised WebRTC's RTT from
  1 ms to 84 ms, and P1 raised the guest's relay echo from 40 ms to 131 ms. So
  the A/B is "one guest on a bad link" on both transports.
- Profiles: P1 = 40 ms lag and 1% drop in each direction; P2 = 40 ms and 3%;
  P3 = clumsy's throttle (1 s frames, its maximum) for 2 s every 30 s.
- Unequal baselines: WebRTC between two local browsers has ~0 ms RTT, while
  the relay goes to the real Cloudflare network. From this connection (Comcast,
  Pacific Northwest) each new connection lands on PDX, SJC, DFW or BOS
  (about one in three is not PDX), and the room's Durable Object ran in SJC or
  DFW. Each client-to-room leg was 30-70 ms (133 ms for a host that landed on
  a distant edge), so the clean relay round trip host to guest is 80-160 ms
  before any impairment. A two-machine WebRTC game
  would also cross the internet; the local WebRTC rows are a best case.

### Results

Guest = the impaired client (host-to-guest per-tick stream); host = the
host's view of the guest-to-host stream. RTT is the peer round trip (WebRTC:
selected candidate pair; relay: peer-echoed probe on the reliable socket).
Gaps are between consecutive per-tick unreliable frames.

| Transport (edges) | Profile | RTT p50 / p99 (ms) | Guest gap p99 / max (ms) | Gaps > 150 ms per min, guest / host | Gaps > 300 ms (g+h) | Own-unit snaps | Host refused predictions |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WebRTC (loopback) | P0 | 0 | 38 / 38 | 0 / 0 | 0 | 0 | 0 |
| WebRTC | P1 | 94 | 67 / 95 | 0 / 0 | 0 | 0 | 0 |
| WebRTC | P2 | 95 | 71 / 117 | 0 / 0 | 0 | 0 | 0 |
| WebRTC | P3 | - | 38 / 1838 | 3.8 / 3.8 | 16 | 0 | 0 |
| Relay, 1 socket (host PDX, guest SJC, room SJC) | P0 | 81 / 171 | 53 / 131 | 0 / 0 | 0 | 0 | 0 |
| Relay, 1 socket | P1 | 173 / 427 | 176 / 311 | 26.5 / 58.6 | 1 | 0 | 0 |
| Relay, 1 socket | P2 | 266 / 701 | 198 / 425 | 73 / 134.5 | 13 | 0 | 0 |
| Relay, 1 socket | P3 | 81 / 1981 | 53 / 1066 | 4 / 4 | 16 | 1 | 0 |
| Relay, 1 socket (host on a far edge, room location not recorded) | P0 | 162 / 271 | 63 / 168 | 0.5 / 0 | 0 | 0 | 0 |
| Relay, 1 socket (same) | P1 | 254 / 500 | 160 / 208 | 18 / 29.3 | 0 | 0 | 0 |
| Relay, 1 socket (same) | P2 | 323 / 733 | 183 / 313 | 45 / 144.5 | 14 | 0 | 0 |
| Relay, 1 socket (same) | P3 | 168 / 1919 | 70 / 1060 | 4.5 / 4 | 16 | 0 | 0 |
| Relay, 2 sockets (all DFW) | P0 | 133 / 232 | 64 / 141 | 0 / 0 | 0 | 10 | 14 |
| Relay, 2 sockets | P1 | 221 / 529 | 205 / 367 | 41 / 60.5 | 2 | 6 | 22 |
| Relay, 2 sockets | P2 | 238 / 653 | 220 / 410 | 99 / 150 | 8 | 0 | 0 |
| Relay, 2 sockets | P3 | 132 / 2233 | 57 / 1096 | 4 / 4 | 16 | 2 | 3 |

Every run held 30 ticks/s, no receive-queue drops, no late-datagram drops at
the sender, and at most 4 KB buffered in a relay socket. Raw rows:
`results.jsonl` in the session files.

Relay disconnects: in about 95 minutes of relay sessions the guest's relay
socket(s) closed abnormally (1006, no close frame) four times, each time with
no impairment active and within about 2 minutes of a match starting. In the
drop recorded with socket logging, both of the guest's relay sockets closed
together while the host's stayed up; for a dropped socket captured by
`wrangler tail`, the Durable Object reported a normal outcome with no
exception. The transport has no reconnect, so each one ended the guest's game.
The WebRTC sessions (about 10 minutes) never dropped. One of the
four followed a redeploy (a Durable Object restart drops its sockets); the
cause of the other three is not established.

### Verdict: NO-GO for "a TCP relay feels acceptable" as built

Against the bar fixed before testing:

- P0 relay round trip (median <= 60 ms, p99 <= 120 ms): **fail** in every run
  (median 81-162 ms, p99 171-271 ms). The cause is the path, not TCP: each
  client-to-room leg is 30-70 ms because the room's Durable Object ran in SJC
  or DFW and connections land on varying edges. The gap criterion passed
  (at most 1 gap over 150 ms, none over 300 ms).
- P1 (at most 6 gaps over 150 ms per minute, p99 gap <= 250 ms, no
  disconnects): **fail**. 1% loss on one guest's link gave 18-41 gaps over
  150 ms per minute at the guest and 29-61 at the host, against 0 for WebRTC
  under the identical impairment. p99 gaps stayed within 250 ms (160-205 ms),
  and disconnects happened outside the impaired runs. Two sockets did not help:
  the game sends per-tick data on its reliable stream too (about 34
  frames/s), so splitting does not take per-tick traffic out of head-of-line
  blocking. (The 2-socket run was also worse, but on a longer path.)
- Recovery (P3): **pass**. After 2 s bursts the relay recovered like WebRTC
  (same number of long gaps, maxima about 1.1 s versus 1.8 s), and socket
  buffers never exceeded 4 KB.
- Subjective feel was not assessed; the runs used scripted movement.

The netcode kept the game consistent: 30 ticks/s throughout. Own-unit snaps
and refused predictions appeared only on the relay: mostly in the all-DFW run
(about 130 ms clean round trip, P0 and P1) and once during a P3 burst; never
on WebRTC. What fails is smoothness under loss: on TCP
every lost segment stalls everything behind it for a retransmission. That is
the risk this spike set out to measure, and at 1% loss it is several times over
the bar.

What would have to change before a relay can pass:

1. A shorter path: a room placed next to the players (Durable Object location
   hints, or a relay outside Durable Objects), and edges that stay put. The P0
   failure is mostly this.
2. A reconnect-and-resume layer, so a dropped WebSocket does not end a game.
3. Datagram transport (WebTransport) where the platform allows it; over TCP,
   per-tick traffic cannot avoid head-of-line blocking.

## Fixes after the first verdict (2026-10-01 afternoon)

Relay version `a2336159-740f-4168-ad02-c49a832e29af`.

### Room placement

The host's first connection now creates the room with a Durable Object
location hint for the host's own location (`request.cf` continent and
longitude), so a host whose connection happens to land in DFW or BOS no longer
creates its room there. P0, relay with one socket, three fresh rooms, both
clients reaching PDX:

| Room | Peer RTT p50 | p99 | One client-to-room leg (echo p50) |
| --- | --- | --- | --- |
| before: DFW room, or host on a far edge | 133-162 ms | 232-271 ms | 30-133 ms |
| before: SJC | 81 ms | 171 ms | 40 ms |
| after: SJC | 80-82 ms | 134-178 ms | 40-42 ms |
| after: SJC | 81 ms | 177 ms | 41 ms |
| after: SEA | 62 ms | 274-285 ms | 31-33 ms |

The hint removes the far rooms, but within `wnam` Cloudflare chose SEA, SJC,
LAX or DEN, never PDX. With about 20 ms from here to PDX and two legs per
round trip, the best case is about 60 ms: the original P0 median bar (60 ms)
is reachable only when the room lands in SEA, and the p99 bar (120 ms) was
not met in any run. Choosing among several candidate rooms by measured round
trip would make SEA-like placement the norm; it was not built.

### The 1006 drops

The relay now logs every accept, close and error (code, cleanliness, socket
age) and every client records its close codes in `?netstats=1`.

- Redeploys: confirmed. The room is terminated ("This script has been
  upgraded. Please send a new request to connect to the new version.") and
  every socket in it closes with 1006 at once. During the roll-out, about 15
  seconds, a reconnect can land on an old instance and be dropped again (seen
  1-8 s after reconnecting).
- The other three drops (all before this logging existed) closed only the
  guest's sockets while the host's sockets in the same room stayed up, so
  they were not room restarts; they were per-connection, on the client or edge
  side. They did not recur: a 35-minute soak (4 host/guest rooms, 100
  frames/s each way, about 4.7 socket-hours) and four game sessions produced
  no unexplained closes; every logged close was a forced test drop (4999),
  the redeploy (1006), or a page reload (1001). Root cause not established;
  the instrumentation will identify the next one, and reconnecting now makes
  it a sub-second stall instead of the end of a game.

### Reconnect and resume

When a relay socket closes, the client reconnects both sockets to the same
room with the same identity (250 ms, then 0.5, 1, 2 and 4 s), and the relay
replaces any stale socket of that identity and re-announces it. Reliable
frames carry a sequence number and a cumulative acknowledgement; each side
keeps unacknowledged frames (up to 4 MB, then backpressure), replays them in
order after its own reconnect or the peer's re-announcement, and delivers
each sequence number exactly once. The game keeps the peer throughout; only a
peer without a path for 20 s fails. Datagrams without a path are dropped.

Tests (`port/web/tests/library_web_transport_resume_test.js`): two independent
copies of the transport talk through an in-memory relay that holds frames in
flight, so drops really lose data. The reliable streams arrive exactly once
and in order across a guest drop, a host drop, a sender drop that loses an
in-flight acknowledgement (replayed duplicates must be discarded), and a
relay restart; a stale socket's late frames and close are ignored; a peer
gone past the grace period fails. Disabling the replay or the duplicate check
makes the test fail. The relay tests cover the replacement and re-announcement.

Live, in a match through the deployed relay:

| Event | Outage | Longest per-tick gap | Game |
| --- | --- | --- | --- |
| Guest socket dropped | 413 ms | 673 ms | continued, 30 ticks/s, no snaps |
| Host socket dropped | 346 ms | 453 ms | continued |
| Relay redeployed (both sides dropped) | 431-433 ms | 500-527 ms | continued |

### P1 after the fixes

Not run yet: the impaired runs need clumsy, which needs one accepted UAC
prompt for its controller; the prompt was cancelled twice while no one was at
the machine. Reconnect does not change the head-of-line behaviour under loss
that failed P1, and placement changes only the base round trip, so P1 is not
expected to pass; it should still be re-measured for the record.
