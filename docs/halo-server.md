# Self-hosted Halo server: runbook

`server/` is one Node process that serves everything a hosted game needs on
one origin:

- the page (`halo.html`, `halo.js`, `halo.wasm`), public;
- the maps (`ui.map` and the 13 stock multiplayer maps only, HEAD and single
  byte ranges), which need a session;
- Discord login (OAuth2 `identify guilds`, membership of one Discord server
  checked at login) issuing a short-lived HMAC-signed session bound to the
  Discord user ID;
- the WebSocket relay with room membership (host/guest roles, peer list,
  build pin, display names from Discord), reconnect/resume and per-frame
  batching.

Nothing depends on how it is exposed: cloudflared, Caddy or a plain public
port in front of `127.0.0.1:8090` all work. Design notes and measurements are
in [websocket-relay-spike.md](websocket-relay-spike.md).

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
- Discord server membership is checked at login only, and each
  `/auth/session` call extends the session. Someone removed from the Discord
  server keeps access until they stay away longer than `TOKEN_TTL_SECONDS`
  (1 h), or until `TOKEN_SECRET` is rotated.
- Discord Activity (not wired in the client yet): `POST /auth/activity` with
  the Embedded App SDK's authorization code returns the Discord access token
  plus a session, and sets a partitioned SameSite=None cookie; the Activity is
  served under `/activity/` with `Document-Isolation-Policy` instead of
  COOP/COEP.

## Inputs

- A web build: `ninja web` produces `build/web/halo.html`, `halo.js` and
  `halo.wasm` (see the main README for the toolchain). The server rewrites
  `halo.html` on the fly for relay rooms; no staging step.
- Maps extracted from your own disc with `tools/xiso_extract.py`. Only
  `ui.map` and the multiplayer maps are served; campaign maps in the same
  directory are never reachable.
- `server/.env`, copied from [`server/example.env`](../server/example.env).
  Never commit it.

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

On forge everything lives under `~/halo-discord` (`build/`, `maps/`,
`server/`), the container is `halo-server` on network `halo-net`, and only
those named resources are touched.

## Discord application

Reuse the probe application (1555066217545605222) or create a new one at
<https://discord.com/developers/applications>.

1. OAuth2 > Redirects: add `https://halo.runtimeexception.net/auth/callback`
   (`PUBLIC_ORIGIN` + `/auth/callback`, exactly).
2. OAuth2 > Client information: copy the Client ID; Reset Secret and copy
   it. Put them in `.env` as `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`.
3. The Discord server whose members may play: Discord > User Settings >
   Advanced > Developer Mode on, then right-click the server icon > Copy
   Server ID, into `DISCORD_GUILD_ID`.
4. Later, for the Activity: Activities > URL Mappings, prefix `/` to target
   `halo.runtimeexception.net/activity`, and add
   `EXTRA_ORIGINS=https://<application id>.discordsays.com` to `.env`.
   (The probe app's root mapping still points at the probe Worker; changing
   it retires the probe Activity.)

Production `.env` additions: `NODE_ENV=production`, `DEV_LOGIN=0`,
`PUBLIC_ORIGIN=https://halo.runtimeexception.net`, a fresh `TOKEN_SECRET`
(`openssl rand -base64 48`), and `TRUST_PROXY` to match the front end. On
forge this file is `~/halo-discord/server/.env` (mode 600).

## Expose it: Cloudflare Tunnel (named, locally managed)

No inbound ports; `cloudflared` dials out to Cloudflare. This is how forge is
set up (cloudflared 2026.9.3 from Cloudflare's apt repo), following
Cloudflare's
[locally-managed tunnel guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/):

```sh
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install cloudflared

cloudflared tunnel login                  # prints a URL; pick the runtimeexception.net zone
cloudflared tunnel create halo            # note the UUID and credentials path
cloudflared tunnel route dns halo halo.runtimeexception.net

cat > ~/.cloudflared/halo.yml <<EOF
tunnel: <UUID>
credentials-file: /home/forge/.cloudflared/<UUID>.json
ingress:
  - hostname: halo.runtimeexception.net
    service: http://127.0.0.1:8090
  - service: http_status:404
EOF
```

On forge the tunnel `halo` has id `58bb6d7a-2b1b-43bb-9abb-7a5eadcac383`.
It runs under its own unit, `/etc/systemd/system/halo-cloudflared.service`,
rather than the default `cloudflared.service`, so it cannot collide with
other tunnels:

```ini
[Unit]
Description=cloudflared tunnel for halo.runtimeexception.net
After=network-online.target
Wants=network-online.target

[Service]
User=forge
ExecStart=/usr/bin/cloudflared --no-autoupdate --config /home/forge/.cloudflared/halo.yml tunnel run
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
halo.runtimeexception.net {
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
rm ~/.cloudflared/halo.yml ~/.cloudflared/58bb6d7a-2b1b-43bb-9abb-7a5eadcac383.json
```

Then delete the `halo` CNAME in the runtimeexception.net DNS zone. The
account has other tunnels (`unraid`, `runtimeexception.net`,
`momobot-spectator`) and `~/.cloudflared` may hold their files: delete only
the `halo` tunnel and the two files above, never the whole directory or
`cert.pem`.

In the Discord Developer Portal remove the redirect URI (and the URL mapping
if one was added), and reset the client secret.
