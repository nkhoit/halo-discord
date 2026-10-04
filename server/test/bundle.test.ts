/* activity.js is built once, and esbuild's service process is stopped after
   the build rather than left resident beside the server. */
import { describe, expect, it, vi } from "vitest";

const calls: string[] = [];

vi.mock("esbuild", async (importOriginal) => {
  const esbuild = await importOriginal<typeof import("esbuild")>();
  return {
    ...esbuild,
    build: async (options: Parameters<typeof esbuild.build>[0]) => {
      calls.push("build");
      const result = await esbuild.build(options);
      calls.push("built");
      return result;
    },
    stop: async () => {
      calls.push("stop");
      await esbuild.stop();
    },
  };
});

const { activityBundle } = await import("../src/bundle.ts");

describe("the Activity bundle", () => {
  it("stops esbuild's service once it is built, and builds once", async () => {
    const text = await activityBundle();
    expect(calls).toEqual(["build", "built", "stop"]);
    expect(text).toContain("Bundled third-party software");
    expect(await activityBundle()).toBe(text);
    expect(calls).toEqual(["build", "built", "stop"]);
  });
});
