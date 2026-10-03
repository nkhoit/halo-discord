# halo-discord

Halo: Combat Evolved multiplayer as a Discord Activity. Players start it from a
voice channel and play together in the Activity's frame. The same page also
works in a desktop browser, with a room link to share.

## How it works

- **Client:** the game, compiled to WebAssembly (WebGL 2, threads, SDL3), in
  [port/web](port/web). The hosted page's own UI (lobby, map and mode picker,
  Esc menu, settings) is [server/client](server/client).
- **Server:** one Node process in [server](server). It serves the page and the
  game data, signs players in with Discord (OAuth2, with an allowlist of
  Discord servers), and relays the game's traffic over WebSockets, one room
  per Activity instance or link. It runs behind cloudflared.
- **Netcode:** the distributed netcode
  ([port/linux/NETCODE.md](port/linux/NETCODE.md)). Each machine moves its own
  player at once and the host decides the rest. Players can join a match in
  progress, and a host can start alone.

## Self-hosting

Refer to [docs/halo-server.md](docs/halo-server.md): the server's settings, the
Discord application, the tunnel, deployment and operations.
[docs/networking.md](docs/networking.md) records the design and the
measurements behind it.

## Game data

The repository has no game data. The maps come from your own copy of the game
(an Xbox disc image), stay private on the server, and are served only to
players signed in with Discord. Never commit game data or build output: CI
rejects them (`.github/scripts/verify-source-only.mjs`).

## Development and tests

Build the web client with `python configure.py` and `ninja web` (Emscripten
SDK and Ninja; refer to "Build the game" below). The server runs with
`cd server && npm ci && npm start` (settings in `server/.env`, refer to the
runbook).

CI runs these; run them before a pull request:

```sh
node .github/scripts/verify-source-only.mjs
cd server && npm ci && npm run check && cd ..
node --test port/linux/tests/halo_aim_device_test.js
node --test port/linux/tests/halo_crouch_movement_test.js
node --test port/linux/tests/input_bindings_test.js
node --test port/linux/tests/msvc_wide_test.js
node --test port/linux/tests/network_late_join_gate_test.js
node --test port/web/tests/*.js
```

The `port/linux/tests` tests compile parts of the game's source with the
system's C compiler (`cc`).

## Build the game

You do not need the Xbox SDK. The port supplies the SDK declarations that
the game uses. Refer to [port/include/xdk](port/include/xdk/README.md).

1. Install Python and [Ninja](https://ninja-build.org/), and the tools for the
   platform (the web build needs an
   [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)
   on `PATH` or in `build/emsdk`).
2. In the root folder of the repository, enter `python configure.py`
   (`--release` for a release build).
3. Enter `ninja` with the target:

| Target | Result |
| --- | --- |
| `ninja web` | `build/web/halo.html`, `halo.js` and `halo.wasm` |
| `ninja linux` | `build/linux/halo` |
| `ninja windows` (on Windows) | `build/windows/halo.exe` and `SDL3.dll` |
| `ninja android_apk` | `port/android/app/build/outputs/apk/debug/app-debug.apk` |

For a local test without the server, `python tools/web_run.py --iso <disc
image>` extracts the maps, builds the web client and serves it.

### Build options

Give these options to `configure.py`:

| Option | Result |
| --- | --- |
| (none) | A debug build. A failed assertion stops the game. |
| `--release` | A release build. The game does not examine assertions, as in the retail game. |
| `--portable` | The Linux and Windows builds operate on all x86-64 processors. |
| `--lto=thin`, `--lto=off` | Less link-time optimization. The link is faster. |
| `--pgo=off` | No profile-guided optimization. |
| `--pgo=train` | Records a new optimization profile (`pgo/`). |

## Native builds

The Linux, Windows and Android ports from upstream still compile, and the
native tests above use their code. This repository publishes no builds of
them. Refer to [port/linux/README.md](port/linux/README.md),
[port/windows/README.md](port/windows/README.md) and
[port/android/README.md](port/android/README.md).

## Credits

The game is the decompilation of the Xbox build 2342 of Halo: Combat Evolved
(`cachebeta.exe`, SHA-256
`4cc87b45f721270392a96f1674ed2b5cd4a7bb4355faeab4531d1cf1884d9520`).

- [punpckhdq/halo](https://github.com/punpckhdq/halo): the decompilation.
- [bnunu/halo-1](https://github.com/bnunu/halo-1): a fork of it, the start of
  the port.
- [cybersecurity/halo-ce-universal](https://github.com/cybersecurity/halo-ce-universal):
  the Linux, Windows and Android ports.
- [ecumene/web-halo](https://github.com/ecumene/web-halo): the web port.
- This repository: the Discord Activity, the server and relay, and the
  multiplayer work on top.

Those projects and their contributors are not responsible for this one. The
license is in [LICENSE.md](LICENSE.md).

## Disclaimer

This project is not affiliated with or endorsed by Microsoft, Xbox Game
Studios, Bungie or Halo Studios (formerly 343 Industries). Halo is a
trademark of Microsoft. The repository contains no game data: to play, you
need your own copy of Halo: Combat Evolved.