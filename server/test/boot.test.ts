/* The start-up report's checks (server/src/boot.ts): only known fields, each
   bounded; a malformed required field makes it no report. */
import { describe, expect, it } from "vitest";

import { cleanBootReport } from "../src/boot.ts";

const minimal = { kind: "done", context: "page", elapsedMs: 5000, stages: { page: 100, shown: 5000 } };

describe("cleanBootReport", () => {
  it("keeps a minimal report and rounds its times", () => {
    expect(cleanBootReport({ ...minimal, elapsedMs: 4999.7 })).toEqual({ ...minimal, build: null, elapsedMs: 5000 });
  });

  it("refuses a report without its kind, context, time or stages, or with bad stages", () => {
    for (const bad of [null, [], "x", { ...minimal, kind: "maybe" }, { ...minimal, context: "native" },
        { ...minimal, elapsedMs: -1 }, { ...minimal, elapsedMs: 1e9 }, { ...minimal, stages: [] },
        { ...minimal, stages: { "Bad Name": 1 } }, { ...minimal, stages: { page: "soon" } },
        { ...minimal, stages: Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`s${index}`, index])) }]) {
      expect(cleanBootReport(bad), JSON.stringify(bad)?.slice(0, 80)).toBeNull();
    }
  });

  it("keeps the optional fields only when well formed", () => {
    const report = cleanBootReport({
      ...minimal, kind: "failed", build: "NOT-HEX", reason: "not-isolated", view: "pick", stuck: "sdk-ready",
      stuckMs: 12, storage: { mode: "memory", lock: "held" }, js: { ms: 300, cached: true, kb: 120 },
      wasm: { ms: 900, cached: "yes", kb: 2826 }, shaders: { count: 12, ms: 196 }, isolated: false, hidden: true,
      lines: ["one", 2, "  two\u0000\nlines  ", "", "4", "5", "6", "7"], user: "someone", name: "Chief",
    });
    expect(report).toEqual({
      ...minimal, kind: "failed", build: null, reason: "not-isolated", view: "pick", stuck: "sdk-ready", stuckMs: 12,
      storage: { mode: "memory", lock: "held" }, js: { ms: 300, cached: true, kb: 120 },
      shaders: { count: 12, ms: 196 }, isolated: false, hidden: true, lines: ["one", "two lines", "4", "5"],
    });
    expect(cleanBootReport({ ...minimal, storage: { mode: "disk", lock: "held" }, reason: "Has Spaces" }))
      .toEqual({ ...minimal, build: null });
    expect(cleanBootReport({ ...minimal, lines: ["x".repeat(500)] })?.lines?.[0]).toHaveLength(200);
  });
});