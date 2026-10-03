/* The hosted page's UI (client/hosted.js, client/hosted.css): when the
   overlay shows, the sound kept in the browser, and none of upstream's shell
   chrome on the page. */
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

const SCRIPT = readFileSync(new URL("../client/hosted.js", import.meta.url), "utf8");
const STYLE = readFileSync(new URL("../client/hosted.css", import.meta.url), "utf8");

interface Controller {
  state: { presented: boolean; view: string; locked: boolean; everLocked: boolean; blocked: boolean };
  lock: { requests: number; successes: number; failures: number };
  lockRequested(): void;
  lockFailed(): void;
  showMenu(): void;
  audio: { muted: boolean; volume: number };
  overlay(): string;
  update(presented: boolean, view: string): void;
  pointerLock(locked: boolean): void;
  setMuted(muted: boolean): void;
  setVolume(volume: number): void;
  applyAudio(): void;
}

interface HostedUi {
  createController(environment: { storage: Storage; applyAudio(muted: boolean, volume: number): void }): Controller;
  surfaceFor(view: string, playedMatch?: boolean): string;
  isLockCooldown(error: unknown): boolean;
}

function load(): HostedUi {
  const context: Record<string, unknown> = {};
  context.window = context;
  vm.runInNewContext(SCRIPT, context);
  return context.HaloHostedUI as HostedUi;
}

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  } as unknown as Storage & { values: Map<string, string> };
}

describe("the overlay", () => {
  it("shows in a match when the game has no mouse", () => {
    const controller = load().createController({ storage: storage(), applyAudio() {} });
    controller.update(false, "booting");
    expect(controller.overlay()).toBe("none");
    controller.update(true, "pick");
    expect(controller.overlay(), "the lobby's panel is the UI").toBe("none");
    controller.update(true, "hosting");
    expect(controller.overlay(), "in Halo's lobby the bar is the UI").toBe("none");
    controller.update(true, "match");
    expect(controller.overlay(), "never played yet").toBe("play");
    controller.pointerLock(true);
    expect(controller.overlay()).toBe("none");
    controller.pointerLock(false);
    expect(controller.overlay(), "Escape (or anything else) released the mouse").toBe("paused");
    controller.pointerLock(true);
    expect(controller.overlay(), "resumed").toBe("none");
    controller.pointerLock(false);
    controller.update(true, "joined");
    expect(controller.overlay(), "back in the lobby after the match").toBe("none");
    controller.update(true, "wait-match");
    expect(controller.overlay()).toBe("none");
  });

  it("never keeps the player behind it when the browser refuses the mouse", () => {
    const controller = load().createController({ storage: storage(), applyAudio() {} });
    controller.update(true, "match");
    expect(controller.overlay()).toBe("play");
    controller.lockRequested();
    controller.lockFailed();
    expect(controller.overlay(), "playing on without mouse look").toBe("none");
    expect(controller.state.blocked).toBe(true);
    controller.showMenu();
    expect(controller.overlay(), "Escape or the notice's Menu brings it back").toBe("paused");
    controller.lockRequested();
    controller.pointerLock(true);
    expect(controller.state.blocked).toBe(false);
    expect(controller.lock).toEqual({ requests: 2, successes: 1, failures: 1 });
    controller.pointerLock(false);
    expect(controller.overlay()).toBe("paused");
  });

  it("tells Chrome's re-lock cooldown after Escape from a refusal", () => {
    const { isLockCooldown } = load();
    const error = (name: string, message: string) => Object.assign(new Error(message), { name });
    expect(isLockCooldown(error("SecurityError",
      "Pointer lock cannot be acquired immediately after the user has exited the lock."))).toBe(true);
    expect(isLockCooldown(error("NotAllowedError", "denied"))).toBe(false);
    expect(isLockCooldown(error("WrongDocumentError", "The root document of this element is not valid for pointer lock.")))
      .toBe(false);
    expect(isLockCooldown(error("SecurityError", "The user has exited the lock before this request was completed.")))
      .toBe(false);
    expect(isLockCooldown(null)).toBe(false);
  });

  it("puts the lobby's views on a panel or a bar", () => {
    const { surfaceFor } = load();
    for (const view of ["checking", "pick", "joining", "wait-match", "wait-retry", "host-starting"]) {
      expect(surfaceFor(view), view).toBe("panel");
    }
    expect(surfaceFor("hosting")).toBe("bar");
    expect(surfaceFor("hosting", true), "after a match the host picks the next one").toBe("panel");
    expect(surfaceFor("joined")).toBe("bar");
    expect(surfaceFor("joined", true), "guests never get the picker").toBe("bar");
    expect(surfaceFor("postgame")).toBe("bar");
    expect(surfaceFor("postgame", true)).toBe("bar");
    expect(surfaceFor("match")).toBe("none");
    expect(surfaceFor("booting")).toBe("none");
  });
});

describe("the sound", () => {
  it("is on at full volume at first, and keeps the player's choice", () => {
    const store = storage();
    const applied: [boolean, number][] = [];
    const first = load().createController({ storage: store, applyAudio: (muted, volume) => void applied.push([muted, volume]) });
    expect(first.audio).toEqual({ muted: false, volume: 1 });
    first.setMuted(true);
    first.setVolume(0.4);
    expect(applied.at(-1), "raising the volume unmutes").toEqual([false, 0.4]);
    first.setMuted(true);
    const again = load().createController({ storage: store, applyAudio() {} });
    expect(again.audio).toEqual({ muted: true, volume: 0.4 });
    again.setVolume(7);
    expect(again.audio.volume).toBe(1);
  });

  it("ignores a damaged stored choice", () => {
    const controller = load().createController({
      storage: storage({ "halo-hosted-audio": "{not json" }), applyAudio() {},
    });
    expect(controller.audio).toEqual({ muted: false, volume: 1 });
  });
});

describe("the page", () => {
  it("hides all of upstream's shell chrome", () => {
    for (const selector of ["header", "#game-frame > footer", "#duke-legend", "#player-sidebar", "#online-dialog",
        "#about-dialog", "#campaign-loading"]) {
      expect(STYLE, selector).toContain(`html.halo-hosted ${selector}`);
    }
    expect(STYLE).toMatch(/#campaign-loading \{ display: none !important; \}/);
    expect(STYLE).toMatch(/object-fit: contain/);
  });
});
