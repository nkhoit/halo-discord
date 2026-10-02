# WebSocket relay spike: results

Is Halo still fun when every multiplayer packet goes through a WebSocket relay
instead of WebRTC? This note records the test setup, measurements and the
GO/NO-GO.

## Resume here (2026-10-02 night: making play feel good)

The Activity works inside Discord (two PCs, two accounts, sessions 4-6).
The work now is feel: frame pacing, then shooting and other players
(issue #17; frame stalls #1-#3; netcode #7, #8).

Done and committed (PR from `nkhoit-discord-activity` into `main`):

- Shader programs compile in the background (#1): draws wait for a new
  program instead of the frame stalling (60-150 ms a compile before).
  Session 6: mid-match `shaderMsMax` at most 5.2 ms.
- Warm-up manifests per map (#2) plus programs learned per browser.
- Default render cap (#3): a display faster than 165 Hz renders at most 120
  frames a second (the largest whole fraction of its rate). Session 6's F8
  A/B on the 240 Hz host: frames over 33/50/100 ms per minute 3.7/2.8/1.8
  uncapped, 0.8/0/0 at 120, 0/0/0 at 60; the uncapped gaps were the
  browser not delivering animation frames (`rafIntervalMaxMs` 62.5,
  `rafLateMaxMs` 3.9). F8 overrides and is remembered.
- Feel telemetry and `tools/web/feel-scorecard.mjs` (#17): per player,
  freezes per minute in play, press-to-shot, hit-confirm latency, other
  players' correction distance and snaps, held relayed input, own
  corrections, and map loads plus match starts kept apart.

Scorecard baseline, session 6 (06:26-06:33 UTC, before the feel telemetry
and the cap default; 74 ms peer round trip): host (240 Hz, F8 A/B mixed in)
0.6/0.1/0 frames over 33/50/100 ms per minute, longest 63.7 ms; guest
0/0/0, longest 20.5 ms; own corrections 0 for both; match start: loading
gaps up to 1.1 s, then 308 ms in the host's first 15 s.

Next, in order (reorder by the first scorecard with feel data):

1. Hit confirmation. A client's shot, muzzle flash, tracer and impact are
   its own simulation (immediate), but the target's shield flare, damage and
   kill come from the host: a round trip plus up to a tick. Measure
   `hitConfirmP50Ms`; if it tracks the round trip, show the target's shield
   flare locally on the reported hit and let the host's word settle it.
2. Other players' smoothness. Each tick a client snaps every remote player
   to the host's position (above 0.05 units, drawn gliding) while
   simulating them on the last relayed input; late or bunched updates
   (TCP) show as corrections. Measure `remoteErrorP99`, `remoteSnaps` and
   `relayedHeldTicks` at 80-150 ms (lab netem); if they grow with jitter,
   draw remote players from a short buffer of host states (interpolation)
   instead.
3. Fire latency. Own fire is predicted; `fireP50Ms` should be under a tick
   (about 33 ms). Act only on a high p99 or unanswered presses.
4. #7 (a burst of 40 own corrections) and #8 (loss on long legs) with the
   lab's netem profiles (`lab/lab-feel.sh`, R40-R120 and R80L).

Session to ask for: the two players on this build, 5 minutes shooting at
each other (strafing, jumping), F8 left alone (the default cap), then the
scorecard (`docker logs halo-server | node tools/web/feel-scorecard.mjs
--since <start>`). Optional: one player on a worse network (phone
hotspot) for #8.

## Discord Activity (2026-10-02)

Branch `nkhoit-discord-activity` (from the spike branch) makes the hosted
game run as a Discord Activity; [halo-server.md](halo-server.md#discord-activity)
describes how. Deployed on forge (`halo-server` container rebuilt by name,
same `.env`); the browser flow is unchanged for players. Verified locally in
a Discord stand-in (a cross-site page embedding the Activity, Discord's CSP
mirrored, the SDK replaced under `DEV_LOGIN`): cross-origin isolated,
signed in, maps streamed with the partitioned cookie, two players in one
instance played a match at 30 ticks/s, host leaving reported to the guest,
fallback panel when isolation is unavailable, no CSP violations. Publicly:
the launch document gets DIP plus the CSP, `activity.js` carries the SDK,
maps and room status need a session, and relay sockets from
`https://1555066217545605222.discordsays.com` are accepted (others 403).
Not yet tried inside Discord itself; that needs the URL mapping change below.

Activity decisions (coordinating chat, on the user's behalf):

8. Launch detection by `frame_id` in the document's query, so the root
   mapping can point at the site root and one build serves both.
9. DIP only for the Activity document. COOP/COEP next to DIP was harmless in
   a Chrome 154 cross-site iframe test (DIP alone and DIP+COOP/COEP isolated;
   COOP/COEP alone did not), but Discord's Electron 148 was only proven with
   DIP, so the Activity keeps exactly that.
10. Inline scripts and handlers become same-origin files for both contexts
    (Discord's CSP forbids inline scripts; one code path).
11. The SDK is bundled by the server at start-up with esbuild, so no
    generated file is committed and no CDN is needed.
12. A separate partitioned `halo_activity` cookie rather than one cookie for
    both contexts, so renewing either session never changes the other's
    SameSite policy. Discord's access token stays on the server and
    `authenticate` is not called.
13. Room = HMAC(instance id) with the server secret; the lobby polls room
    status (no invites), first host wins.
14. `pagehide` leaves the room: a page parked in the back/forward cache
    otherwise kept its socket and showed others a host that no longer played.
15. Relay pages check WebSocket support only. Discord's frame has no
    RTCPeerConnection; the first in-Discord test failed on a WebRTC support
    check made before the relay was configured.
16. Content-versioned asset URLs and explicit Cache-Control on everything
    (runbook "Caching"). The second in-Discord test still ran the old game:
    the server sent no Cache-Control, and Cloudflare's 4-hour browser TTL
    let the Discord client keep the previous `halo.js`.

Known gaps: the shell's UI images (`assets/ui/**`: map and mode cards,
Spartan previews, controller art) are not in this repository, so every
hosted page shows them broken; the game itself is unaffected. Behind Discord's
proxy all players may share one address for the auth rate limit.

Pending, needing the user: the Activity URL mapping (root `/` to
`halo.runtimeexception.net`), Supported Platforms (Web and Desktop), then
the in-Discord test with a second guild member. Earlier pending items: a
subjective play check and the friends test; optional clumsy cross-check.

Local Activity stand-in (session files `activity-harness/parent.mjs`):
start the server with `PUBLIC_ORIGIN=http://localhost:8090` (and the
development `.env`), run the stand-in on `127.0.0.1:8096`, open
`http://127.0.0.1:8096/?user=Alice&instance=inst-1` and
`...?user=Bob&instance=inst-1` in two Chrome profiles.

### State before the Activity work (2026-10-01 evening)

The runtime no longer uses Cloudflare. `server/` is one Node process that
serves the page, the multiplayer maps, Discord login and the relay with room
membership; [halo-server.md](halo-server.md) is its runbook. `services/relay`
is gone from the tree and CI checks `server/` instead; the old Worker
`halo-relay-spike` has been deleted. Verified end to end locally and in a
container on forge. Revised verdict:
conditional GO, see [Self-hosted server](#self-hosted-server-2026-10-01-evening).

Public hostname: `https://halo.runtimeexception.net`. On forge,
`~/halo-discord/server/.env` exists (mode 600, `PUBLIC_ORIGIN` set,
`TOKEN_SECRET` generated); the named tunnel `halo`
(`58bb6d7a-2b1b-43bb-9abb-7a5eadcac383`, config `~/.cloudflared/halo.yml`)
runs as `halo-cloudflared.service` and forwards to `http://127.0.0.1:8090`;
the Discord OAuth redirect `https://halo.runtimeexception.net/auth/callback`
is registered on the probe app.

Decisions taken by the coordinating chat on the user's behalf, with reasons:

1. Self-host instead of Workers and Durable Objects: no per-request billing,
   rooms in memory, and the same process can run on forge, an Azure VM or
   anywhere behind cloudflared or Caddy.
2. Maps are authorized by an HttpOnly session cookie rather than a fetch
   wrapper adding a header. Same-origin fetches from every game thread carry
   it with no Wasm or worker changes, and the token never appears in a URL or
   in JavaScript-readable storage. The relay WebSocket sends a token from
   `/auth/session` as its first message (browsers cannot set WebSocket
   headers).
3. The server rewrites `halo.html` for hosted use (relay rooms, no signaling
   or Turnstile, game starts after a session exists), so a plain `ninja web`
   output is deployable and nothing needs staging.
4. Rooms: the host's page makes a random 128-bit room id; the invite is
   `#room=<id>`, a fragment, so it is not sent to the server or logged.
5. Batching is per game frame, not per 30 Hz tick: per tick would add up to
   33 ms. Per frame cuts relay messages by 31% (guest) and 65% (host) for
   about 2 ms per hop. Kept on; `?relayBatch=0` turns it off.
6. The server pings every socket every 30 s, because Cloudflare closes
   WebSockets idle for 100 s and a host alone in a lobby sends nothing.
7. The page is served at `/` without redirects, so every URL in it stays
   relative behind any proxy mapping.

Restart the local setup (PowerShell, repository root):

```powershell
ninja web                      # build.ninja names build\emsdk's emcc
cd server; npm ci; npm start   # server\.env as in docs\halo-server.md (DEV_LOGIN=1)
```

Open `http://127.0.0.1:8090/?netstats=1` in one Chrome profile (dev login as
"Developer") and
`http://127.0.0.1:8090/auth/dev-login?name=Guest&return=%2F%3Fnetstats%3D1`
in another; host in the first and open the `#room=` invite in the second.
The WebRTC baseline still runs as before: `python tools\web_serve.py --port
8765` plus `services\signaling` under `wrangler dev`, page
`http://127.0.0.1:8765/build/web/halo.html`.

Local-only pieces that are not in Git: `assets\maps` (from
`tools\xiso_extract.py`), the junction `build\web\assets\maps -> assets\maps`,
an empty `port\web\assets` directory, `server\.env`, and
`services\signaling\.dev.vars` for the WebRTC baseline.

Forge (`ssh forge@forge.story-nessie.ts.net`): `~/halo-discord/{build,maps,server}`,
image `halo-server`, network `halo-net`, netem script
`~/halo-discord/halo-netem.sh` (container netns only). The production
container `halo-server` runs with `~/halo-discord/server/.env` (command in
the runbook).

Superseded Cloudflare history follows; the measurement sections stay as
recorded.
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

Same method (guest-scoped clumsy, 120 s per profile), relay version
`a2336159`:

| Relay | Room | P0 RTT p50 / p99 | P1 gaps > 150 ms per min, guest / host | P1 guest gap p99 / max | Snaps, disconnects |
| --- | --- | --- | --- | --- | --- |
| 1 socket | SJC | 78 / 200-256 ms | 16.5 / 28.3 (before: 26.5 / 58.6) | 161 / 260 ms | 0, 0 |
| 2 sockets | LAX | 98 / 269-300 ms | 15 / 43 (before: 41 / 60.5) | 171 / 285 ms | 0, 0 |

Better than before and without disconnects, but still 2.5-7 times the P1 bar
of 6 per minute: reconnecting does not change head-of-line blocking under
loss, and placement changes only the base round trip. The verdict stands:
NO-GO for a TCP relay at 1% loss; acceptable on a clean connection.

## Self-hosted server (2026-10-01 evening)

### What it is

`server/` replaces the Worker: rooms in memory, the same relay wire
protocol, plus authentication by first message, room membership
(`ready`/`peer-up`/`peer-down` with Discord display names, bounded and
sanitized), a build-ID pin, one host per room, stale-socket replacement, a
64-room cap, per-frame batching (`0x80`, then length-prefixed frames, up to
64 KiB) and 30 s protocol pings. 46 tests (`npm run check`) cover auth,
admission, routing and sender stamping, caps, malformed frames and batches,
replacement, the heartbeat, the static allowlist, path traversal and byte
ranges. The transport's resume test drives the client side through an
in-memory relay with batches and authentication.

### End to end, two Chrome profiles

Locally (server on `127.0.0.1:8090`, dev login) and in the `halo-server`
container on forge (tailnet origin treated as secure by a test-only Chrome
flag; sessions minted with the container's secret): dev login, host creates a
room, guest opens the `#room=` link, the page logs in first if needed, guest
joins the lobby with the host's Discord-style name in the roster, the match
runs at 30 ticks/s on both. Forced drops (`debugDropRelay()`) mid-match: guest
socket back in 254 ms, host socket back in 254 ms; the host replayed 21
reliable frames and the guest discarded 2 duplicates; 30 ticks/s and no
snaps throughout. A host alone in its lobby without `?netstats=1` stayed
connected for more than 100 s on server pings.

### Batching

P0, 120 s, guest moving, loopback:

| | Messages/s guest / host | Frames per message guest / host | Probe RTT p50 guest / host |
| --- | --- | --- | --- |
| Batching off | 160 / 141 | 1.0 / 1.0 | 0.5 / 0.6 ms |
| Batching on | 110 / 50 | 1.46 / 2.83 | 4.7 / 5.9 ms |

Batches flush at the end of each game frame (render rate, about 110 a second
here), with a 4 ms timer as fallback. The probe round trip waits for two
flushes because probes and pongs are produced outside game frames; game
frames leave at the end of the frame that produced them, so their added delay
is part of one frame per hop. Under P1 (below) one unbatched run gave 0.48
gaps per minute at the guest against 1.5-3.84 in three batched runs; all pass,
and a single run cannot separate a small batching cost from run-to-run noise.

### Impairment on forge (netem)

Rig: the `halo-server` container on forge (LAN, about 1 ms from the PC), two
Chrome profiles on the PC, same scripted guest movement, 120 s per profile,
same `?netstats=1` summary. netem runs only inside the container's network
namespace: an egress prio/netem qdisc for packets to the impaired client's
TCP port and an ifb device (also in that namespace) for packets from it, so
each direction gets the delay and loss, and only for that client. Verified:
40 ms each way on the guest's port moved the guest's relay echo from 4.9 to
84.8 ms while the host's stayed at 1.6-5.3 ms. This replaces the clumsy runs
(no UAC); it is the same impairment (P1 = 40 ms and 1% each way on the
guest), applied at the server end instead of the client end.

| Profile (guest leg; host leg) | Batching | Guest leg RTT | Peer RTT p50 / p99 | Gaps > 150 ms per min, guest / host | Gap p99, guest / host | Gaps > 300 ms | Snaps |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P0 (clean) | on | 4 ms | 8 / 14 ms | 0 / 0 | 38 / 18 ms | 0 | 0 |
| P1S (20 ms + 1%) | off | 41 ms | 42 / 135 ms | 0 / 0 | 81 / 75 ms | 0 | 0 |
| P1 (40 ms + 1%), 3 runs | on | 83-84 ms | 86 / 227-326 ms | 1.5-3.84 / 0 | 135-148 / 109-126 ms | 0 | 0 |
| P1 (40 ms + 1%) | off | 92 ms | 93 / 250 ms | 0.48 / 0 | 128 / 107 ms | 0 | 0 |
| P2 (40 ms + 3%) | on | 85 ms | 101 / 394 ms | 9.6 / 0 | 161 / 131 ms | 0 | 0 |
| P0L (60 ms; 20 ms), no loss | off | 121 ms | 162 / 165 ms | 0 / 0 | 38 / 17 ms | 0 | 0 |
| P1L (60 ms + 1%; 20 ms) | off | 129 ms | 173 / 413 ms | 28 / 41.5 | 186 / 155 ms | 1 | 0 |

All runs held 30 ticks/s with no snaps, refused predictions, queue drops or
disconnects.

P1L reproduces the Cloudflare runs' geometry (guest leg about 131 ms with the
impairment, host leg about 40 ms, peer round trip 173 ms) and their result:
28 / 41.5 gaps per minute against 16.5-26.5 / 28-59 on Cloudflare. P0L shows
the long path alone causes no gaps. So the earlier NO-GO came from loss on a
long TCP leg, not from Cloudflare or from clumsy: a lost segment holds up
everything behind it for about one round trip of that leg plus the duplicate
acknowledgements needed to detect the loss, and once that leg's round trip
passes about 100 ms most recoveries exceed the 150 ms gap threshold.

### Revised verdict: conditional GO

Against the bar fixed before testing, the TCP relay passes P1 (at most 6 gaps
over 150 ms per minute, p99 gap at most 250 ms, no disconnects) when the
impaired player's round trip to the place their TCP connection ends is under
about 100 ms, and fails at about 130 ms. P2 (3% loss) exceeds the gap count
even at 85 ms. P0 passes trivially on the LAN; the internet P0 depends on
where the server runs and was not measured with friends.

Consequences:

- Put the server close to the players. A friend 40-80 ms from forge with 1%
  loss lands in the passing band; a friend across an ocean does not.
- For the Activity, each player's TCP connection ends at Discord's nearby
  Cloudflare edge (about 15 ms median from here in the probe), so last-mile
  loss is recovered on a short leg. This favours the relay, but it is an
  inference: it has not been measured through Discord's proxy.
- Loss above 1% remains a problem for any TCP relay; only datagrams fix that.
## Own-player rubber-banding (2026-10-02)

Players reported their own character snapping back "a step" and the view
jumping to another angle, in the Discord Activity and in Chrome alike.

### What the netcode does

A client's own position is its own (port/linux/NETCODE.md): it sends where
its unit is every tick, the host accepts that within 3.5 world units, and the
client is put where the host has it only beyond 3.0 world units, several
metres in Halo CE. A client drives its own player from local input only; the
host's relayed inputs move remote players. So ordinary latency cannot snap a
player back a step. A correction would be a large jump, and when one happens
it also sets the unit's facing from the host.

### Telemetry

With `NETSTATS_UPLOAD=1` (diagnostic mode, on for forge now) every page posts
its 5-second netstats window to `POST /v1/netstats`, logged with the player's
Discord ID. The game section counts own-unit corrections (and those that also
turned the unit), refused predictions, own seat corrections, the host's
client inputs per tick, frames that ran several ticks to catch up and the most
ticks in one frame, frame gaps and hitches, and (to attribute long frames)
the longest tick run and frame callback, shader compiles and links, texture
uploads, content hashing and idle drops. The server also logs every map read.

### First real session (Chrome on two PCs at home, 01:29-01:32 UTC)

- Own corrections, own aim corrections, refused predictions: 0 in every
  window for both players. Netcode corrections are not the cause.
- The reported stutters match client frame stalls: the worst, at 01:30:38,
  was a 591 ms frame gap and 17 ticks run in one frame on the guest, with a
  154 ms gap on the host at the same moment; others were 283 ms (8-9 ticks).
  Network gaps were normal then. A stall followed by catch-up ticks shows as a
  jump, and the mouse motion gathered during the stall turns the view at once.
- One separate transport stall (01:31:19-24, ~210 ms per-tick gaps on both,
  no frame hitch).
- Relay echo p50 40-49 ms although both PCs and forge share a LAN: the path
  hairpins through the Cloudflare edge (SEA) and the tunnel. Peer round trip
  87-92 ms. A known cost of the tunnel; not acted on.

### Ruled out or explained

- Host inputs per tick, mostly 2: by design. A client sends its input when at
  least 16 ms have passed (the original Xbox interval, network_game_globals.c),
  about 60 a second; the host takes the latest each tick and keeps every
  button pressed in between.
- Map reads during play: each multiplayer map fits FetchFS's first 32 MiB
  chunk and is fetched whole at load. The map log is there to confirm it.
- The SwiftShader lab on forge (headless Chromium, 12-18 fps) runs several
  ticks every frame by itself and then shows own corrections (~20-27 a minute)
  and refused predictions even without impairment. That is not the regime of
  real play (0 of both), so it is not used for this.

### Second session: the stalls are shader compiles

With the attribution counters (Chrome on both PCs, 01:47-01:50 UTC):

- The worst stall, a 208 ms frame gap with 6 ticks run in one frame, had a
  203 ms frame callback (the stall was inside the game's frame) and 31 shader
  compiles or links in that window, the longest 155 ms. Smaller gaps lined up
  with dozens of compiles too, and the host kept compiling throughout the
  match (600 and more in two minutes, on one map).
- Texture eviction was real (up to 48 drops in a window, uploads after) but
  cheap (at most 1.8 ms an upload, 0.7 ms a hash). Not the stall.
- Maps were fetched whole at load (14-22 MB, 135-296 ms each) and never during
  the match. Streaming is ruled out.
- Network fine: peer round trip 75-85 ms, no corrections.

Cause: the pixel shader cache key holds the whole block of combiner
registers, constants excluded, including the inputs and outputs of stages the
shader does not use, which keep whatever an earlier shader left there. One
effective shader therefore appeared under many keys; each generated the same
GLSL, compiled it again, and (programs being keyed by GL shader name) linked a
new program.

Fix (`d3d8_gl.c`): GL shaders are cached by their text, so a repeated text
reuses its shader and its program. In a lab match the host met 29 new pixel
shader keys in 150 s and compiled once; the guest met 6 and compiled once.
Netstats now report new pixel shader keys, real compiles and reused texts
separately. The web texture cache also measures idle time in time (60 s)
rather than 1800 frames (7.5 s at 240 fps).

A first sight of a genuinely new shader still compiles on the frame that
draws it (about 100-155 ms). If that remains noticeable, the next steps are
warming known shaders during loading, KHR_parallel_shader_compile, and only
then a soft cap on catch-up ticks.

### Third and fourth sessions: what remained

After the shader fix (session 3) the worst gaps fell from 208-591 ms to
9-16 ms on the guest and 61 ms on the host. Session 4 (Activity, 04:20 UTC,
moving only) left two kinds of stall:

- Match start: one guest frame of 629 ms (callback 622 ms) with 44 shader
  compiles (longest 136 ms) and 31 programs drawn for the first time; the
  host 150 ms with 50 compiles. Transient buffer overflow 0, uploads cheap.
  A genuinely new program is compiled, linked and (ANGLE) turned into
  Direct3D executables on the frame that first draws it.
- Later, host gaps of 25-61 ms with a frame callback of 3-26 ms and no
  compiles, first draws or overflow: time lost outside the game's frame.

### Building programs ahead

Each map's programs are built before its first frame (`d3d8_gl.c`, warm-up
section). When the game loads a map's tags (`scenario_tags_load`), the
renderer reads two lists of vertex+fragment GLSL pairs: the server's manifest
for the map (`assets/maps/<map>.shaders`, session-gated like the maps) and
this browser's own list for the map in OPFS (`/storage/halo-shaders-<map>.txt`,
which gains every program first drawn on the map that neither list named).
It compiles and links them all first, so `KHR_parallel_shader_compile` can
overlap them, then sets each up and draws one point with it into a 1x1
RGBA8 + depth/stencil framebuffer, which makes ANGLE build its executables.
While a map copies in from the network the work starts early, at most 8 ms a
loading frame. The map's tag load is the trigger rather than the loading
screen because a map already in the game's map cache (every visit after the
first) skips the loading screen.

The manifests were recorded in the forge lab (SwiftShader: the GLSL depends
only on the shading language, so it matches every GPU): two bot clients
played each multiplayer map for 60-100 s, and their lists were merged with
`tools/web/merge-shader-manifests.mjs`. 38-65 programs a map (0.4-0.8 MB of
text), 10 for the menu. In a lab match on Blood Gulch with the browser lists
cleared, the warm-up built 41 programs and the match start still met 5 and 9
new ones (effects the recording bots had not caused), then 0-2 a window.
Programs built ahead showed no stall on their first real draw (15 of them in
one window, longest callback 40 ms). Lab timings are not representative
(SwiftShader at 5 fps with two clients), so the real check is a session.

Netstats: `warmedPrograms` (built ahead in the window), `warmupMs` (the
last warm-up's main-thread time), `unwarmedFirstDraws` (first draws of
programs not built ahead: coverage gaps, each a possible stall).

### Stalls outside the frame: instrumentation

For the second kind, netstats now carry `outsideFrameMaxMs` (the longest
time between the end of one frame callback and the start of the next, in the
game's worker) and a `mainThread` section (event-loop lag p99/max from a
4 ms MessageChannel ping, long tasks and their total and longest time, JS
heap size and change), plus relay messages and kilobytes received. A render
cap (`?fpsCap=120` or `60` on the browser page; F8 cycles off/120/60 in
either page) tests whether the uncapped frame rate starves the browser's
compositor or GPU process. Cause still open.

### Activity start-up crash found on the way

The Embedded App SDK copies every console line to Discord (`captureLog`)
without handling the result. Once netstats windows were logged to the console,
Discord rejected one as too long, the rejection went unhandled, and the shell
showed it as a fatal start-up error on the guest. The SDK now starts with
`disableConsoleLogOverride`, failed Discord commands are never fatal, uploaded
windows stay out of the console, failure text wraps, and the Activity reports
errors to `POST /v1/client-errors`. A test runs the built `activity.js`
against an SDK stand-in that mimics the capture and Discord's validation.
