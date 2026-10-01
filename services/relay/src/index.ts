/* Halo WebSocket relay (spike).

   One Durable Object per room forwards binary game frames between a room's
   host and its guests. It serves no assets and reaches no other destination:
   frames go only to sockets in the same room. */

import { ROOM_ID_PATTERN, parseMember } from "./protocol";

export { RelayRoom } from "./room";

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
}

function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  return env.ALLOWED_ORIGINS.split(",").map((value) => value.trim()).includes(origin);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/v1/health") return text(200, "ok");
    const match = /^\/v1\/rooms\/([^/]+)\/ws$/.exec(url.pathname);
    if (!match) return text(404, "not found");
    const roomId = match[1] ?? "";
    if (!ROOM_ID_PATTERN.test(roomId)) return text(400, "invalid room");
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return text(426, "websocket upgrade required");
    }
    if (!originAllowed(request, env)) return text(403, "origin not allowed");
    if (!parseMember(url)) return text(400, "invalid role, id or ch");
    /* Tell the room which data center this client reached (diagnostic). */
    const forwarded = new Request(request);
    forwarded.headers.set("X-Relay-Colo", String(request.cf?.colo ?? "unknown"));
    return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(forwarded);
  },
} satisfies ExportedHandler<Env>;
