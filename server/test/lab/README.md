# Chrome + relay lab: host End match (#44)

Proves the host **End match** path (not **Close room**) against a real local
relay with two Chrome profiles: results / Next match UI, room stays up, guest
stays connected. Uses DEV_LOGIN-style session cookies and a Module/`HaloOnline`
stub because the repo has no maps or wasm (by design).

This lab is **local-only**. It is excluded from `tsc --noEmit` and from the
default `vitest run` / `npm run check` path so CI does not need Chrome or
`puppeteer-core`.

## Prerequisites

- `google-chrome` (or `chromium`) on `PATH`
- `cd server && npm ci && npm i --no-save puppeteer-core`

## Run

```sh
cd server
npm run test:lab-end-match
# or: npx vitest run test/lab-end-match-chrome.test.ts
```

Artifacts (screenshots + `evidence.json`) land in `/tmp/halo-44-lab/`
(or `$HALO_LAB_OUT`).

## What it covers

1. Real relay: host + guest join one room; host sets `inMatch`.
2. Real `hosted.js` overlay in Chrome: host sees **End match** + **Close room**;
   guest has no End match.
3. Host confirms End match → `endMatch()` once, never `leave()`; UI shows
   **Match over** / **Next match**.
4. Relay summary still has host + 2 players after phase returns to lobby.
5. Host `configure()` next mode; guest socket still open.
