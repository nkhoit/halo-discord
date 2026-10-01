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

## Test setup: hidden pages break the baseline

Two instances on one machine showed rubber-banding with stock WebRTC. The
cause is Chrome's timer throttling of hidden pages, not the netcode and not
CPU/GPU contention.

`library_web_transport.js` moves received packets into WebAssembly from
main-thread `setTimeout` callbacks (`schedulePump`). The game itself runs on
a worker's `requestAnimationFrame` and keeps its 30 Hz tick when hidden, but
in a hidden page (minimized, or otherwise reported hidden) Chrome runs chained
timers once per second. That page then delivers at most one reliable frame
and 16 datagrams per second, and its 256-datagram receive queue overflows.

Measured on one machine (Ryzen 7 9800X3D, RTX 5090, Chrome 154, 240 Hz),
Battle Creek Slayer, guest driven by a scripted 40 s mix of runs, rapid
strafes, reversals and jumps; both pages sampled every 500 ms:

| Run | Flags | Host window | Host fps / ticks | Guest own-unit snaps (> 3.0 units) | Host rejected predictions | Max frame gap |
| --- | --- | --- | --- | --- | --- | --- |
| E1/E2 | on | visible, other monitor | 240 / 30.0 | 0 | 0 | 26 ms |
| E3 (host moving) | on | visible | 240 / 30.0 | 0 | 0 | 250 ms, once |
| E4 | on | minimized | 240 / 30.0 | 0 | 0 | 18 ms |
| E5 | off | minimized | 239 / 30.0 | 2, 3.07 units each | 0 | 63 ms |
| E6 | off | covered by the guest window | 236 / 30.0 | 0 | 0 | 9 ms |
| E7 | off | visible, other monitor | 235 / 30.0 | 0 | 0 | 9 ms |

In E5 the hidden host's chained `setTimeout(1)` fired every ~1000 ms (1-5 ms
when visible) and the host dropped 4,830 of the guest's datagrams. It applied
the guest's predicted position up to a second late, so the position it sent
back was more than `LOCAL_CORRECTION_TOLERANCE` (3.0 units) behind and the
guest snapped back: rubber-banding. Each instance used about 2.5 ms of CPU
per frame, so two instances on this machine do not contend.

With localhost and zero added latency, nothing in the netcode itself snaps:
no own-unit corrections and no rejected predictions in either direction.

Required setup for every measurement here:

- Launch each Chrome with `--disable-background-timer-throttling
  --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`
  (test only), and
- keep both windows visible and not minimized (one per monitor, or one per
  machine).

Product consequence, independent of transport: a player whose page is hidden
(a host who minimizes the window or switches away) stalls packet delivery for
their machine. In a Discord Activity that is a host alt-tabbing. Scheduling
the pump with something hidden pages do not throttle (a `MessageChannel`, or
delivery directly from the socket's message handler) would remove it.
