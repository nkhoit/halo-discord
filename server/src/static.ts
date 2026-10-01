/* The game page and its maps. Only an allowlist of files is reachable, and
   maps need a session: the page shell and wasm are public, game data is not. */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

/* ui.map and the stock multiplayer maps; never the campaign. */
export const MAPS = new Set([
  "ui.map",
  "beavercreek.map", "bloodgulch.map", "boardingaction.map", "carousel.map", "chillout.map",
  "damnation.map", "hangemhigh.map", "longest.map", "prisoner.map", "putput.map", "ratrace.map",
  "sidewinder.map", "wizard.map",
]);

const BUILD_FILES: Record<string, string> = {
  "halo.html": "text/html; charset=utf-8",
  "halo.js": "text/javascript; charset=utf-8",
  "halo.wasm": "application/wasm",
};

const UI_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
};

/* "page": a normal top-level page, isolated with COOP/COEP. "activity": the
   Discord Activity iframe, where only Document-Isolation-Policy works. */
export type Context = "page" | "activity";

export function isolationHeaders(context: Context): Record<string, string> {
  const common = {
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  return context === "activity" ?
    { ...common, "Document-Isolation-Policy": "isolate-and-require-corp" } :
    { ...common, "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
}

/* The build file for a request path relative to the site root, or null. */
export function buildFile(path: string): { file: string; type: string } | null {
  if (Object.hasOwn(BUILD_FILES, path)) return { file: path, type: BUILD_FILES[path]! };
  const ui = /^assets\/ui\/((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\.(png|jpg|svg)$/.exec(path);
  if (ui) return { file: path, type: UI_TYPES[ui[2]!]! };
  return null;
}

export function mapFile(path: string): string | null {
  const match = /^assets\/maps\/([a-z0-9]+\.map)$/.exec(path);
  return match && MAPS.has(match[1]!) ? match[1]! : null;
}

function metaPattern(name: string): RegExp {
  return new RegExp(`<meta\\b(?=[^>]*\\bname=(?:["']${name}["']|${name})(?=[\\s>]))[^>]*>`, "g");
}

function scriptPattern(source: string): RegExp {
  return new RegExp(`<script\\b[^>]*\\bsrc=["']?${source}[^>]*>\\s*</script>`, "g");
}

/* Gameplay and rooms go through this server, so the hosted page drops the
   signaling, relay and Turnstile settings and the service-worker isolation
   shim (this server sends the isolation headers). The game's first request
   is a map, so it starts only once a session exists; otherwise the visitor
   logs in and returns to the same address, invite fragment included. */
const LOADER = `<meta name="halo-transport" content="relay-rooms"><script>` +
  `fetch("auth/session",{credentials:"same-origin",cache:"no-store"}).then(function(r){` +
  `if(r.status===401){location.replace("auth/login?return="+encodeURIComponent(location.pathname+location.search+location.hash));return}` +
  `if(!r.ok)throw new Error("session "+r.status);` +
  `var s=document.createElement("script");s.src="halo.js";document.head.appendChild(s)})` +
  `.catch(function(e){console.error("Halo could not start:",e)})</script>`;

export function hostedPage(page: string): string {
  for (const name of ["halo-signaling-url", "halo-relay-url", "halo-turnstile-sitekey", "halo-transport"]) {
    page = page.replace(metaPattern(name), "");
  }
  page = page.replace(scriptPattern("coi-serviceworker\\.js"), "");
  page = page.replace(scriptPattern("https://challenges\\.cloudflare\\.com/"), "");
  const game = scriptPattern("halo\\.js(?=[\"'\\s>])");
  if ((page.match(game) ?? []).length !== 1) throw new Error("halo.html does not load halo.js exactly once");
  return page.replace(game, LOADER);
}

export function parseRange(header: string | undefined, size: number):
    { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  /* Multiple or malformed ranges: serve the whole file, as RFC 9110 allows. */
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!suffix || !size) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

export async function serveFile(request: IncomingMessage, response: ServerResponse, directory: string,
    file: string, type: string, headers: Record<string, string>, ranges: boolean): Promise<void> {
  const path = join(directory, file);
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    response.writeHead(404, { ...headers, "Content-Type": "text/plain" }).end("not found");
    return;
  }
  const base = { ...headers, "Content-Type": type, ...(ranges ? { "Accept-Ranges": "bytes" } : {}) };
  const range = ranges && request.method === "GET" ? parseRange(request.headers.range, size) : null;
  if (range === "unsatisfiable") {
    response.writeHead(416, { ...base, "Content-Range": `bytes */${size}` }).end();
    return;
  }
  if (range) {
    response.writeHead(206, {
      ...base,
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
      "Content-Length": String(range.end - range.start + 1),
    });
  } else {
    response.writeHead(200, { ...base, "Content-Length": String(size) });
  }
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const stream = createReadStream(path, range ? { start: range.start, end: range.end } : {});
  stream.on("error", () => response.destroy());
  stream.pipe(response);
}
