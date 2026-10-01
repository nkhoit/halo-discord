# WebSocket relay spike: results

Is Halo still fun when every multiplayer packet goes through a WebSocket relay
instead of WebRTC? This note records the test setup, measurements and the
GO/NO-GO.

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
