# Self-hosted Halo server: runbook

`server/` is one Node process that serves everything a hosted game needs on
one origin:

- the page (`halo.html`, `halo.js`, `halo.wasm`), public;
- the maps (`ui.map` and the 13 stock multiplayer maps only, HEAD and single
  byte ranges), which need a session;
- the lobby's images (each multiplayer map's preview and each game type's
  icon, extracted from your own `ui.map`), which need a session;
- Discord login (OAuth2 `identify guilds`; membership of one of the configured
  Discord servers checked at login) issuing a short-lived HMAC-signed session
  bound to the Discord user ID;
- the WebSocket relay with room membership (host/guest roles, peer list,
  build pin, display names from Discord), reconnect/resume and per-frame
  batching.

Nothing depends on how it is exposed: cloudflared, Caddy or a plain public
port in front of `127.0.0.1:8090` all work. The design and its measurements are
in [networking.md](networking.md).

The commands below use these placeholders: `<your-domain>` for the public
hostname (for example `halo.example.com`), `<APP_ID>` for the Discord
application's ID (its `DISCORD_CLIENT_ID`), `<GUILD_ID>` for a Discord
server's ID, `<TUNNEL_ID>` for the Cloudflare tunnel's ID, and `<user>` for
the account on the server host that runs everything from `~/halo-discord`.

## How sessions travel

- After login the server sets an HttpOnly `halo_session` cookie
  (SameSite=Lax; Secure on HTTPS). Map requests carry it automatically,
  including FetchFS range requests from the game's worker threads, so no
  token is ever placed in a URL or in JavaScript-readable storage for maps.
  Requests may also send `Authorization: Bearer <token>`.
- The page reads a fresh token from `GET /auth/session` (which also extends
  the session) and sends it as the relay WebSocket's first message,
  `{"type":"auth","token":...,"id":...,"build":...}`; sockets that do not
  authenticate within 5 s are closed with 4401. The relay takes the player's
  identity and name from the token, never from the client.
- The hosted page starts the game only after `/auth/session` succeeds (the
  game's first request is a map). Without a session it goes to
  `/auth/login?return=<path#room=...>` and comes back to the same invite.
- Discord server membership (any server in `DISCORD_GUILD_IDS`, or the legacy
  `DISCORD_GUILD_ID` fallback) is checked at sign-in. Each `/auth/session`
  call extends the session, but only until `SESSION_LIFETIME_SECONDS` (24 h)
  after that sign-in; then the page signs in again, which checks membership
  again. For a player who has already authorized the app this is silent: the
  browser page goes through Discord's OAuth redirect with `prompt=none` and
  comes back to the same address, and the Activity calls the SDK's
  `authorize` again. Someone removed from every allowed Discord server can
  start new connections for at most `SESSION_LIFETIME_SECONDS` plus
  `TOKEN_TTL_SECONDS` (1 h), or until `TOKEN_SECRET` is rotated; a relay
  socket already open stays open until it closes.
- The Discord Activity signs in through the Embedded App SDK instead (see
  [Discord Activity](#discord-activity)) and keeps its session in a separate
  `halo_activity` cookie: HttpOnly, SameSite=None, Secure and Partitioned,
  as a cross-site iframe needs. `/auth/session` renews whichever cookie it
  was given, so the browser and Activity sessions never overwrite each other.

## Inputs

- A web build: `ninja web` produces `build/web/halo.html`, `halo.js` and
  `halo.wasm` (see the main README for the toolchain). The server rewrites
  `halo.html` on the fly for relay rooms; no staging step.
- Maps extracted from your own disc with `tools/xiso_extract.py`. Only
  `ui.map` and the multiplayer maps are served; campaign maps in the same
  directory are never reachable.
- Optional shader manifests next to the maps, `<map>.shaders`: the GL
  programs each map draws, which the game builds while the map loads rather
  than in its first frames. They are derived from the game data (recorded in
  play), so they live with the maps and never in git. To record them, play
  each map with the page open and run
  `copy(UTF8ToString(Module._platform_web_shader_manifest()))` in the
  console; save each result as a JSON string in a directory (one file per
  map and player) and run
  `node tools/web/merge-shader-manifests.mjs <that directory> <MAPS_DIR>`.
  Rerecord after changes to the shader translators; a stale manifest only
  wastes load time. Without them the game still learns each map's programs
  per browser (kept in its storage) and builds them ahead from the second
  visit.
- The lobby's images, `<MAPS_DIR>/ui/maps/<slug>.png` and
  `<MAPS_DIR>/ui/modes/<slug>.png` (or under `UI_DIR`), extracted from
  your own `ui.map`: the 140x114 previews and icons Halo's menus show
  (`ui\shell\bitmaps\mp_map_grafix` and `game_type_grafix`). Game
  data: generated where the maps are, never committed. Optional; the lobby
  shows names alone without them.

  ```sh
  node tools/web/extract-ui-images.mjs ~/halo-discord/maps/ui.map ~/halo-discord/maps/ui
  # on a host without Node, in any Node 22 image:
  sudo docker run --rm --user $(id -u):$(id -g) -v ~/halo-discord/maps:/maps \
    -v "$PWD/tools/web":/tools --entrypoint node node:22 /tools/extract-ui-images.mjs /maps/ui.map /maps/ui
  ```
- `server/.env`, copied from [`server/example.env`](../server/example.env).
  Never commit it.
- The site icon in `server/icons/` (favicon.ico, icon-64.png,
  apple-touch-icon.png) ships with the server and is public.
  `python tools/icon/ring_icon.py` regenerates it from the 64x64 pixel art.

## The hosted page

One page for the Discord Activity and the browser
(`server/client/hosted.js` and `hosted.css` over upstream's shell, whose
chrome they hide; local development keeps upstream's shell as it is):

- The game fills the frame (letterboxed). Before it runs, a loading screen.
- The room is the Activity instance's, or in a browser the address's
  `#room=` (made up on first visit, so the address is the invite link).
  The lobby polls the room: nobody hosting shows the map and game type
  picker; a host in its lobby, or in a match that takes players, is joined
  at once, under the Discord name ("Joining <host>'s match..." while the map
  loads); while the host's match is starting or full the page shows
  "<host> is in a match" (the host tells the relay when its match starts,
  whether it takes players, and when it ends). The host can start alone.
- In Halo's lobby a bar shows the room (the host's "Start match" presses A
  for it). In a match, whenever the game does not have the mouse an overlay
  offers Play/Resume, sound on/off and volume (kept in the browser), Game
  menu (Halo's Start, its pause menu) and Leave/End game.
- Escape belongs to the page: browsers release the mouse on it, which shows
  the overlay, so Halo's pause moved to the overlay's Game menu. F11 toggles
  full screen for the frame (also inside the Activity), F8 the frame cap.

## Run locally (no Discord)

Node 22.18 or newer. From the repository root:

```powershell
cd server
npm ci
@"
HOST=127.0.0.1
PORT=8090
PUBLIC_ORIGIN=http://127.0.0.1:8090
BUILD_DIR=$((Resolve-Path ..\build\web).Path)
MAPS_DIR=$((Resolve-Path ..\assets\maps).Path)
TOKEN_SECRET=$([Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(36)))
NODE_ENV=development
DEV_LOGIN=1
"@ | Set-Content .env
npm start
```

`DEV_LOGIN=1` is refused unless `NODE_ENV=development` and `HOST` is a
loopback address. Open `http://127.0.0.1:8090/` in one Chrome profile (it
logs in as "Developer"), and
`http://127.0.0.1:8090/auth/dev-login?name=Guest&return=/` in a second
profile. Host in the first, open the `#room=` invite in the second.
`?netstats=1` adds the measurement log; `?relayBatch=0` turns batching off.

`npm run check` type-checks and runs the tests.

## Run in a container

The image holds only the server; the build and maps are mounted read-only.

```sh
cd server
docker build -t halo-server .
docker network create halo-net
docker run -d --name halo-server --network halo-net --restart unless-stopped \
  --env-file .env -e HOST=0.0.0.0 -e PORT=8090 \
  -e BUILD_DIR=/data/build -e MAPS_DIR=/data/maps \
  -v "$PWD/../build/web:/data/build:ro" -v /path/to/maps:/data/maps:ro \
  -p 127.0.0.1:8090:8090 halo-server
```

or `docker compose -f compose.example.yaml up -d --build` (expects
`server/.env` and `server/maps`). The container answers `GET /healthz`.
`DEV_LOGIN` does not work in a container (its `HOST` is not loopback), so a
containerised server needs the Discord settings.

A layout that works: everything under `~/halo-discord` (`build/`, `maps/`,
`server/` with its `.env`), the container `halo-server` on the network
`halo-net`. Other services on the host are never touched.

## Update

A new web build needs no restart: the page's asset versions are content
hashes, so copying `halo.html`, `halo.js` and `halo.wasm` into
`~/halo-discord/build/` is enough. A new server version (anything under
`server/`, including `server/client/`) needs the image rebuilt and the
container recreated with the same `.env`, mounts and settings:

```sh
cd ~/halo-discord/server                  # a copy of the repository's server/
docker build -t halo-server .
docker rm -f halo-server
docker run -d --name halo-server --network halo-net --restart unless-stopped \
  --env-file ~/halo-discord/server/.env -e HOST=0.0.0.0 -e PORT=8090 \
  -e BUILD_DIR=/data/build -e MAPS_DIR=/data/maps \
  -v ~/halo-discord/build:/data/build:ro -v ~/halo-discord/maps:/data/maps:ro \
  -p 127.0.0.1:8090:8090 halo-server
docker image prune -f                     # or remove the old image by its ID
```

Recreating the container closes every room; do it when nobody is playing
(with `-e NETSTATS_UPLOAD=1`, the pages report a `netstats` line every five
seconds to `docker logs halo-server`, which shows who is). Afterwards
check `GET /healthz`, that the page answers 200, that the maps and
`/v1/rooms/<id>` answer 401 without a session, and that the startup log line
reads `"discord":true,"devLogin":false`.

## Discord application

Create an application at <https://discord.com/developers/applications>.

1. OAuth2 > Redirects: add `https://<your-domain>/auth/callback`
   (`PUBLIC_ORIGIN` + `/auth/callback`, exactly).
2. OAuth2 > Client information: copy the Client ID; Reset Secret and copy
   it. Put them in `.env` as `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`.
3. The Discord servers whose members may play: Discord > User Settings >
   Advanced > Developer Mode on, then right-click each server icon > Copy
   Server ID. Set `DISCORD_GUILD_IDS` to those decimal IDs
   (`<GUILD_ID>,<GUILD_ID>`), comma-separated;
   whitespace is trimmed and duplicates are ignored. If that variable is
   unset, the legacy `DISCORD_GUILD_ID` accepts one server. A set-but-empty or
   malformed `DISCORD_GUILD_IDS` is an error and does not fall back.
4. Installation: install the app to the Discord server (guild install), not
   to users. A user-installed app fails in servers with more than 25 members
   with "User-installed Apps require verification to use activities in
   servers with more than 25 members".
5. For the Activity: Activities > URL Mappings, root prefix `/` to target
   `<your-domain>` (the site root; Activity launches are told apart by their
   `frame_id` query). The server allows the relay origin
   `https://<APP_ID>.discordsays.com` by itself.

Production `.env` additions: `NODE_ENV=production`, `DEV_LOGIN=0`,
`PUBLIC_ORIGIN=https://<your-domain>`, a fresh `TOKEN_SECRET`
(`openssl rand -base64 48`), and `TRUST_PROXY` to match the front end. Keep
the file at `~/halo-discord/server/.env` with mode 600.

## Discord Activity

The same server and page run as an Activity. Discord loads the mapped root
with `frame_id`, `instance_id` and friends in the query; that document gets:

- `Document-Isolation-Policy: isolate-and-require-corp` and no COOP/COEP:
  Discord's page is not isolated, so only DIP makes the frame
  cross-origin isolated (threaded WebAssembly needs it). Every response is
  CORP same-origin, which DIP requires of subresources and workers. In Chrome
  154, adding COOP/COEP next to DIP in a cross-site iframe was harmless, but
  the Activity keeps the set proven inside Discord's Electron client.
- A Content-Security-Policy mirroring the one Discord's proxy enforces
  (same-origin scripts, `'unsafe-eval'`, same-origin connections and
  workers, no inline scripts), so a page that runs locally under it also runs
  in Discord. The server serves the build's inline script and inline event
  handlers as same-origin files (`halo-shell-0.js`, `halo-handlers.js`) for
  both the Activity and the browser page.
- `activity.js` instead of the browser login: the Embedded App SDK, bundled
  by the server at start-up with its license (Discord's policy allows no
  CDN). It completes the SDK handshake before anything heavy loads, checks
  `crossOriginIsolated` (otherwise it explains and offers "Open Halo in the
  browser" through `openExternalLink`), calls `authorize` (`identify`,
  `guilds`, `prompt: none`), posts the code with the instance id to
  `POST /auth/activity`, and only then loads the game. The server exchanges
  the code without a redirect URI, as Discord's Activity examples do, checks
  membership of `DISCORD_GUILD_IDS` (or the legacy `DISCORD_GUILD_ID` fallback),
  and keeps Discord's access token to itself; `authenticate` is not called
  because nothing needs it. An instance in a Discord server
  (`i-<id>-gc-<server>-<channel>`) also needs the user to be a member of that
  server, and the server to be on the allowlist; otherwise the sign-in gets
  403. The session token carries the allowlisted servers the user belongs to
  and the instance id, so the relay authorizes without asking Discord again,
  and the session lifetime keeps both fresh.
- One room per Activity instance: `POST /auth/activity` returns the room id,
  an HMAC of the instance id under `TOKEN_SECRET`, so a room id cannot be
  chosen to land in someone's instance. The in-game lobby polls
  `GET /v1/rooms/<id>` and offers to host when nobody does, or to join the
  host; the first player to host wins (a second one is refused and returns to
  the lobby). There are no invite links. When the host leaves, guests are
  told "The host left or ended the game." and return to the lobby.
- One lobby per Discord server: while nobody hosts in a voice channel, its
  lobby lists the matches hosted from the server's other voice channels
  ("Matches in this server", from `GET /v1/guild-rooms?build=<build>`, polled
  every few seconds): host, voice channel, map, game type, players, and
  whether it is in its lobby, starting, in a match or over. Join moves the
  player to that room, into its lobby or into the running match; leaving it
  returns them to their own channel's lobby. Voice stays per channel. The
  host's page reports the map, game type, state and channel name in its
  relay phase message. A room learns its server and channel from its own
  instance's members' sessions (so again after a restart). The relay admits
  an Activity session to its own instance's room, or to a room of an
  instance in one of the servers in its token; a browser session to link
  rooms, or to such a room of its servers. Rooms in other Discord servers are
  never listed or joinable. Full rooms and rooms of another build are listed
  but not joinable; the build pin and the room's capacity still apply. Room
  ids stay unguessable HMACs; the list shows them only to members of the same
  server. Activity participation itself is not verified with Discord (any
  member of the server who learns an instance id gets its room).
- Spectators: whoever opens a room (or picks it from the server's list)
  while its match runs watches it first, with Join (add their player, as a
  late joiner's) or Spectate. A spectator sees the watched player's own
  view and HUD under "Spectating <name>"; the mouse stays free, a left or
  right click watches the next or previous player, and Escape brings the
  menu back. Between matches the lobby's bar offers Join too. On the relay
  a spectator is a guest whose auth message says `"spectator": true`, and
  `{"type":"spectating","value":false}` once it joins. The room counts
  players and spectators separately (`GET /v1/rooms/<id>`, the server's
  list), and a spectator still takes one of the room's connections. The
  host's phase message says whether its match takes spectators now
  (`watchable`: running, and fewer than 8 spectators), so a match full of
  players can still be watched.

Expectations and limits:

- Works in the Discord desktop app and Discord in Chrome or Edge. Discord in
  Firefox or Safari shows the fallback panel. Set Activities > Settings >
  Supported Platforms to Web and Desktop only; the mobile clients are
  untested and the game expects keyboard and mouse or a gamepad.
- The first launch for a player shows Discord's consent prompt for
  `identify` and `guilds`; later launches pass silently.
- Behind Discord's proxy every player may reach the server from the same
  address, so the auth rate limit (30 a minute per address) is shared;
  raise `AUTH_RATE_LIMIT_PER_MINUTE` if launches start failing with 429.
- `?netstats=1` cannot be added inside Discord; measure in the browser.

Testing locally without Discord: with `DEV_LOGIN=1` the Activity page
accepts a `dev_user` query parameter that replaces the SDK (and, like Discord's
frame, removes WebRTC from the page: relay pages must never need it), and
`POST /auth/activity` accepts `dev:<name>` codes. Run the server with
`PUBLIC_ORIGIN=http://localhost:8090` (browsers accept Secure, partitioned
cookies from `http://localhost`) and embed
`http://localhost:8090/?frame_id=x&instance_id=<id>&dev_user=<name>` in an
iframe on another site (for example a page on `http://127.0.0.1`). Two
browser profiles with the same `instance_id` play one match. The development
login makes the player a member of the instance's server; instance ids of the
form `i-1-gc-100-1` and `i-2-gc-100-2` stand for two voice channels of one
server (`&channel_name=` names the channel).

## Expose it: Cloudflare Tunnel (named, locally managed)

No inbound ports; `cloudflared` dials out to Cloudflare. Install it from
Cloudflare's apt repository and follow Cloudflare's
[locally-managed tunnel guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/):

```sh
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install cloudflared

cloudflared tunnel login                  # prints a URL; pick the zone of <your-domain>
cloudflared tunnel create halo            # note the tunnel ID and credentials path
cloudflared tunnel route dns halo <your-domain>

cat > ~/.cloudflared/halo.yml <<EOF
tunnel: <TUNNEL_ID>
credentials-file: /home/<user>/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: <your-domain>
    service: http://127.0.0.1:8090
  - service: http_status:404
EOF
```

Run the tunnel under its own unit, `/etc/systemd/system/halo-cloudflared.service`,
rather than the default `cloudflared.service`, so it cannot collide with
other tunnels on the host:

```ini
[Unit]
Description=cloudflared tunnel for <your-domain>
After=network-online.target
Wants=network-online.target

[Service]
User=<user>
ExecStart=/usr/bin/cloudflared --no-autoupdate --config /home/<user>/.cloudflared/halo.yml tunnel run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now halo-cloudflared
cloudflared tunnel info halo              # connections should be listed
```

Set `TRUST_PROXY=cloudflare` (the auth rate limit keys on
`CF-Connecting-IP`; safe only because the port is published on loopback).
WebSockets pass through tunnels; Cloudflare closes WebSockets idle for 100 s,
which the server's 30 s protocol pings prevent.

## Alternative: Caddy on a public IP

Point an A/AAAA record at the machine, open 80 and 443, and run Caddy with:

```
<your-domain> {
	reverse_proxy 127.0.0.1:8090
}
```

Caddy obtains the certificate and proxies WebSockets. Use
`TRUST_PROXY=forwarded`.

## Azure VM

Any small Ubuntu VM works (the relay uses little CPU; the maps are 283 MB);
pick a region close to the players, since loss recovery time grows with each
player's round trip to the server. Install Docker, copy `build/web` and the
maps, run the container as above, then either the tunnel (no inbound NSG
rules) or Caddy (allow 80/443 inbound).

## Caching

Any cache may sit in front of the server (Cloudflare's edge on the tunnel,
Discord's proxy for the Activity, a browser), so every response says what
may be kept:

- Pages, `/auth/*`, `/v1/rooms/*`, `/healthz` and errors: `no-store`.
- Every asset the page loads carries `?v=<content hash>`: `halo.js` and
  `halo.wasm` share one version (the loader sets `Module.locateFile` for
  the wasm; pthread workers reuse `halo.js`'s URL), and the shell scripts,
  loaders and icons carry their own. The current version is
  `public, max-age=31536000, immutable`; a missing or stale `?v=` gets
  `no-cache`. A new build or server version changes the URLs, so nothing
  needs purging after a deploy.
- Maps and their shader manifests: `private, max-age=3600` with
  `Vary: Cookie, Authorization`. Shared
  caches never store them; the player's own browser may keep them for an
  hour, which spares the server's upload when a match restarts.

Cloudflare's zone setting Caching > Configuration > Browser Cache TTL
(default 4 hours) replaces a shorter origin `Cache-Control` for files with
cacheable extensions, so unversioned URLs such as `/halo.js` reach browsers
with `max-age=14400`. Pages never use those URLs; setting it to "Respect
Existing Headers" makes the origin authoritative everywhere.

## Operating

- Logs are JSON lines on stdout: `accept`, `close` (code, age), `refuse`,
  `unauthorized`, each with the room prefix and the Discord user ID.
- Limits: `MAX_ROOMS` (64), 32 sockets per room, 16 KiB frames, 64 KiB
  batches; malformed frames close the socket (1003/1008/1009).
- Rotating `TOKEN_SECRET` signs everyone out.

## Teardown

```sh
docker rm -f halo-server && docker network rm halo-net && docker rmi halo-server
rm -rf ~/halo-discord                      # build, maps, server copy and .env
sudo systemctl disable --now halo-cloudflared && sudo rm /etc/systemd/system/halo-cloudflared.service && sudo systemctl daemon-reload
cloudflared tunnel delete halo
rm ~/.cloudflared/halo.yml ~/.cloudflared/<TUNNEL_ID>.json
```

Then delete the CNAME for `<your-domain>` in its DNS zone. If the account has
other tunnels, `~/.cloudflared` may hold their files: delete only the `halo`
tunnel and the two files above, never the whole directory or `cert.pem`.

In the Discord Developer Portal remove the redirect URI (and the URL mapping
if one was added), and reset the client secret.
