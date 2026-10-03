// @vitest-environment happy-dom
/// <reference lib="dom" />
/* The overlay's Settings on the page (client/hosted.js in a DOM): opened from
   the paused overlay, a key or mouse button taken for a control, refusals,
   conflicts, the mouse's settings and Escape. */
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

/* (happy-dom has its own URL) */
const SCRIPT = readFileSync(new NodeURL("../client/hosted.js", import.meta.url), "utf8");

const calls = { bind: [] as number[][], apply: 0, sensitivity: [] as number[], invert: [] as number[] };

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  expect(node, id).toBeTruthy();
  return node!;
}

function chips(control: string): string[] {
  return [...document.querySelectorAll(`.hosted-control[data-control="${control}"] .hosted-chip`)]
    .map((chip) => chip.textContent ?? "");
}

function add(control: string) {
  (document.querySelector(`.hosted-add[data-control="${control}"]`) as HTMLElement).click();
}

function key(code: string, init: KeyboardEventInit = {}) {
  window.dispatchEvent(new KeyboardEvent("keydown", { code, key: code, bubbles: true, cancelable: true, ...init }));
}

beforeAll(() => {
  document.documentElement.classList.add("halo-hosted");
  document.body.innerHTML = '<main id="game-area" data-presented="true"><canvas id="canvas"></canvas></main>';
  localStorage.clear();
  const win = window as unknown as Record<string, unknown>;
  win.HaloOnline = { status: () => ({ view: "match", role: "guest", host: "Alice" }) };
  win.Module = {
    _platform_web_bind_input: (...args: number[]) => { calls.bind.push(args); return 1; },
    _platform_web_apply_input_bindings: () => { calls.apply++; return 1; },
    _platform_web_set_mouse_sensitivity: (value: number) => { calls.sensitivity.push(value); return 1; },
    _platform_web_set_invert_mouse: (value: number) => { calls.invert.push(value); return 1; },
  };
  new Function(SCRIPT)();
});

describe("the overlay's Settings", () => {
  it("opens from the paused overlay with every control and its keys", () => {
    expect(byId("hosted-overlay").hidden, "a match, the mouse never taken: the overlay").toBe(false);
    expect(byId("hosted-settings").hidden).toBe(true);
    byId("hosted-settings-open").click();
    expect(byId("hosted-settings").hidden).toBe(false);
    expect(byId("hosted-overlay-main").hidden).toBe(true);
    expect(document.querySelectorAll(".hosted-control").length).toBe(20);
    expect(chips("jump")).toEqual(["Space", "Enter", "Num Enter"]);
    expect(chips("fire")).toEqual(["Left click"]);
    expect(chips("switch_weapon")).toEqual(["Tab", "Wheel"]);
    expect(byId("hosted-sensitivity-value").textContent).toBe("1.00×");
    expect(calls.sensitivity, "the settings went into the game when it ran").toEqual([1]);
  });

  it("takes a key for a control, and refuses the browser's", () => {
    add("jump");
    expect(byId("hosted-capture-notice").textContent).toMatch(/Press a key .* for Jump/);
    key("ControlLeft");
    expect(byId("hosted-capture-notice").textContent, "refused, still listening").toMatch(/Ctrl.*Pick another for Jump/);
    key("KeyW", { ctrlKey: true });
    expect(byId("hosted-capture-notice").textContent).toMatch(/belong to the browser/);
    key("KeyJ");
    expect(chips("jump")).toEqual(["Space", "Enter", "Num Enter", "J"]);
    expect(calls.bind.at(-1)).toEqual([4, 44, 40, 88, 13]);
    expect(JSON.parse(localStorage.getItem("halo-hosted-input")!).bindings.jump).toEqual([44, 40, 88, 13]);
    expect(byId("hosted-capture-notice").textContent).toBe("J added to Jump.");
  });

  it("takes a mouse button, and warns when it already does something", () => {
    add("fire");
    window.dispatchEvent(new MouseEvent("mousedown", { button: 2, bubbles: true, cancelable: true }));
    expect(chips("fire")).toEqual(["Left click", "Right click"]);
    expect(byId("hosted-capture-notice").textContent).toMatch(/Right click now also does Throw grenade/);
    const conflict = document.querySelector('.hosted-control[data-control="grenade"] .hosted-chip.conflict');
    expect(conflict?.textContent).toBe("Right click");
  });

  it("removes a key, cancels on Escape, and resets", () => {
    (document.querySelector('.hosted-control[data-control="zoom"] .hosted-chip[data-input="29"]') as HTMLElement).click();
    expect(chips("zoom")).toEqual(["Middle click"]);
    add("melee");
    key("Escape");
    expect(byId("hosted-capture-notice").textContent, "cancelled").toMatch(/Click \+ to add/);
    expect(byId("hosted-settings").hidden, "the first Escape only cancels").toBe(false);
    byId("hosted-controls-reset").click();
    expect(chips("jump")).toEqual(["Space", "Enter", "Num Enter"]);
    expect(chips("zoom")).toEqual(["Z", "Middle click"]);
    expect(JSON.parse(localStorage.getItem("halo-hosted-input")!).bindings).toEqual({});
  });

  it("sets the mouse's sensitivity and invert live", () => {
    const slider = byId("hosted-sensitivity") as HTMLInputElement;
    slider.value = "1000";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    expect(byId("hosted-sensitivity-value").textContent).toBe("5.00×");
    expect(calls.sensitivity.at(-1)).toBe(5);
    byId("hosted-invert").click();
    expect(byId("hosted-invert").textContent).toBe("Invert look: on");
    expect(calls.invert.at(-1)).toBe(1);
    byId("hosted-mouse-reset").click();
    expect(byId("hosted-sensitivity-value").textContent).toBe("1.00×");
    expect(calls.invert.at(-1)).toBe(0);
  });

  it("goes back to the overlay on Escape or Back", () => {
    key("Escape");
    expect(byId("hosted-settings").hidden).toBe(true);
    expect(byId("hosted-overlay-main").hidden).toBe(false);
    byId("hosted-settings-open").click();
    byId("hosted-settings-back").click();
    expect(byId("hosted-settings").hidden).toBe(true);
  });
});
