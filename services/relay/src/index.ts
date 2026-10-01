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

const MIDDLE_EAST = new Set(["AE", "BH", "IL", "IQ", "IR", "JO", "KW", "LB", "OM", "QA", "SA", "SY", "YE"]);

/* The Durable Object region nearest the client's location (not the edge it
   happened to reach). Cloudflare honors a hint only when it creates the room,
   which the host's first connection does. */
export function locationHint(cf: IncomingRequestCfProperties | undefined): DurableObjectLocationHint | undefined {
  if (!cf) return undefined;
  const longitude = Number(cf.longitude);
  if (cf.country && MIDDLE_EAST.has(cf.country)) return "me";
  switch (cf.continent) {
    case "NA": return Number.isFinite(longitude) && longitude > -100 ? "enam" : "wnam";
    case "SA": return "sam";
    case "EU": return Number.isFinite(longitude) && longitude > 15 ? "eeur" : "weur";
    case "AS": return "apac";
    case "OC": return "oc";
    case "AF": return "afr";
    default: return undefined;
  }
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
    const member = parseMember(url);
    if (!member) return text(400, "invalid role, id or ch");
    /* Tell the room which data center this client reached (diagnostic). */
    const forwarded = new Request(request);
    forwarded.headers.set("X-Relay-Colo", String(request.cf?.colo ?? "unknown"));
    const id = env.ROOMS.idFromName(roomId);
    const hint = member.role === "host" ? locationHint(request.cf) : undefined;
    return env.ROOMS.get(id, hint ? { locationHint: hint } : undefined).fetch(forwarded);
  },
} satisfies ExportedHandler<Env>;
