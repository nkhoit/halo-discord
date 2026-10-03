// @vitest-environment happy-dom
/// <reference lib="dom" />
/* The overlay's controls in the Discord Activity (client/hosted.js in a DOM
   with the Activity's meta): Crouch on Left Ctrl and C by default, Ctrl
   alone taken but never a combination, reset to the Activity's defaults,
   and Ctrl combinations kept from the frame while the game has the mouse. */
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const SCRIPT = readFileSync(new NodeURL("../client/hosted.js", import.meta.url), "utf8");

const binds: number[][] = [];

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  expect(node, id).toBeTruthy();
  return node!;
}

const chips = (control: string) => [...document.querySelectorAll(`.hosted-control[data-control="${control}"] .hosted-chip`)]
  .map((chip) => chip.textContent ?? "");

function key(code: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { code, key: code, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}

beforeAll(() => {
  document.documentElement.classList.add("halo-hosted");
  document.body.innerHTML = '<main id="game-area" data-presented="true"><canvas id="canvas"></canvas></main>';
  localStorage.clear();
  const win = window as unknown as Record<string, unknown>;
  win.HaloOnline = { status: () => ({ view: "match", role: "guest", host: "Alice" }) };
  new Function(SCRIPT)();
  /* (as in the Activity's page: its meta follows hosted.js, and the game,
     whose exports take the settings, runs later) */
  const meta = document.createElement("meta");
  meta.name = "halo-activity";
  meta.content = "123";
  document.head.appendChild(meta);
  win.Module = {
    _platform_web_bind_input: (...args: number[]) => { binds.push(args); return 1; },
    _platform_web_apply_input_bindings: () => 1,
    _platform_web_set_mouse_sensitivity: () => 1,
    _platform_web_set_invert_mouse: () => 1,
  };
});

describe("the Activity's controls", () => {
  it("crouch on Left Ctrl and C, staged into the game", async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(binds).toContainEqual([12, 224, 6, 0, 0]);
    byId("hosted-settings-open").click();
    expect(chips("crouch")).toEqual(["Left Ctrl", "C"]);
  });

  it("take Ctrl alone, and refuse a Ctrl combination", () => {
    (document.querySelector('.hosted-add[data-control="jump"]') as HTMLElement).click();
    key("KeyX", { ctrlKey: true });
    expect(byId("hosted-capture-notice").textContent).toMatch(/Combinations with Ctrl, Alt or Cmd belong to the browser/);
    key("ControlRight", { ctrlKey: true });
    expect(chips("jump")).toEqual(["Space", "Enter", "Num Enter", "Right Ctrl"]);
  });

  it("reset to the Activity's defaults", () => {
    (document.querySelector('.hosted-control[data-control="crouch"] .hosted-chip[data-input="224"]') as HTMLElement).click();
    expect(chips("crouch")).toEqual(["C"]);
    byId("hosted-controls-reset").click();
    expect(chips("crouch")).toEqual(["Left Ctrl", "C"]);
    expect(chips("jump")).toEqual(["Space", "Enter", "Num Enter"]);
    expect(binds.at(-1)).toEqual([12, 224, 6, 0, 0]);
  });

  it("keep Ctrl combinations from the frame while the game has the mouse", () => {
    byId("hosted-settings-back").click();
    expect(key("KeyR", { ctrlKey: true }).defaultPrevented, "no pointer lock: untouched").toBe(false);
    Object.defineProperty(document, "pointerLockElement", { configurable: true, get: () => byId("canvas") });
    expect(key("KeyR", { ctrlKey: true }).defaultPrevented, "Ctrl+R").toBe(true);
    expect(key("ControlLeft", { ctrlKey: true }).defaultPrevented, "Ctrl itself").toBe(true);
    expect(key("KeyR").defaultPrevented, "R alone").toBe(false);
  });
});
