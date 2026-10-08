/* A page's start-up report (POST /v1/client-boot; hosted.js's boot recorder):
   when each stage of a launch was reached, in milliseconds from the
   navigation, and how it ended. Only these fields are kept, each checked and
   bounded; anything else in the request is dropped. */

const STAGE = /^[a-z][a-z0-9-]{0,23}$/;
const KINDS = new Set(["done", "stalled", "unload", "failed"]);
const LOCKS = new Set(["granted", "held", "refused", "none"]);
const MAXIMUM_MILLISECONDS = 3_600_000;
const MAXIMUM_STAGES = 24;
const MAXIMUM_LINES = 6;
const MAXIMUM_LINE_LENGTH = 200;

export const MAXIMUM_BOOT_REPORT_BYTES = 4096;

export interface BootAsset {
  /* when it had arrived */
  ms: number;
  /* from the browser's cache (nothing transferred) */
  cached: boolean;
  kb: number;
}

export interface BootReport {
  kind: string;
  context: string;
  build: string | null;
  elapsedMs: number;
  stages: Record<string, number>;
  stuck?: string;
  stuckMs?: number;
  reason?: string;
  /* (done) what showed: the page's view */
  view?: string;
  storage?: { mode: string; lock: string };
  js?: BootAsset;
  wasm?: BootAsset;
  shaders?: { count: number; ms: number };
  isolated?: boolean;
  hidden?: boolean;
  lines?: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function milliseconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAXIMUM_MILLISECONDS ?
    Math.round(value) : null;
}

function asset(value: unknown): BootAsset | undefined {
  const fields = record(value);
  const ms = fields && milliseconds(fields.ms);
  const kb = fields && milliseconds(fields.kb);
  if (!fields || ms === null || kb === null || typeof fields.cached !== "boolean") return undefined;
  return { ms, cached: fields.cached, kb };
}

/* control characters out, whitespace collapsed, a length bound */
function line(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAXIMUM_LINE_LENGTH);
  return text || null;
}

/* null when the report is not one (a missing or malformed required field) */
export function cleanBootReport(value: unknown): BootReport | null {
  const body = record(value);
  if (!body) return null;
  const kind = typeof body.kind === "string" && KINDS.has(body.kind) ? body.kind : null;
  const context = body.context === "activity" || body.context === "page" ? body.context : null;
  const elapsedMs = milliseconds(body.elapsedMs);
  const stagesIn = record(body.stages);
  if (!kind || !context || elapsedMs === null || !stagesIn) return null;
  const entries = Object.entries(stagesIn);
  if (entries.length > MAXIMUM_STAGES) return null;
  const stages: Record<string, number> = {};
  for (const [name, at] of entries) {
    const ms = milliseconds(at);
    if (!STAGE.test(name) || ms === null) return null;
    stages[name] = ms;
  }
  const report: BootReport = {
    kind,
    context,
    build: typeof body.build === "string" && /^[0-9a-f]{1,32}$/.test(body.build) ? body.build : null,
    elapsedMs,
    stages,
  };
  if (typeof body.stuck === "string" && STAGE.test(body.stuck)) report.stuck = body.stuck;
  const stuckMs = milliseconds(body.stuckMs);
  if (stuckMs !== null) report.stuckMs = stuckMs;
  if (typeof body.reason === "string" && /^[a-z0-9_-]{1,40}$/.test(body.reason)) report.reason = body.reason;
  if (typeof body.view === "string" && /^[a-z-]{1,16}$/.test(body.view)) report.view = body.view;
  const storage = record(body.storage);
  if (storage && (storage.mode === "opfs" || storage.mode === "memory") &&
      typeof storage.lock === "string" && LOCKS.has(storage.lock)) {
    report.storage = { mode: storage.mode, lock: storage.lock };
  }
  const js = asset(body.js);
  if (js) report.js = js;
  const wasm = asset(body.wasm);
  if (wasm) report.wasm = wasm;
  const shaders = record(body.shaders);
  const shaderCount = shaders && milliseconds(shaders.count);
  const shaderMs = shaders && milliseconds(shaders.ms);
  if (shaderCount !== null && shaderCount !== undefined && shaderMs !== null && shaderMs !== undefined) {
    report.shaders = { count: shaderCount, ms: shaderMs };
  }
  if (typeof body.isolated === "boolean") report.isolated = body.isolated;
  if (typeof body.hidden === "boolean") report.hidden = body.hidden;
  if (Array.isArray(body.lines)) {
    const lines = body.lines.slice(0, MAXIMUM_LINES).map(line).filter((text): text is string => text !== null);
    if (lines.length) report.lines = lines;
  }
  return report;
}
