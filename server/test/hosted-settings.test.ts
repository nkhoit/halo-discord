/* The hosted page's Settings (client/hosted.js): the mouse's sensitivity and
   invert, and the controls' keys and mouse buttons, kept in the browser and
   set in the game as the settings xinput_sdl.c reads. */
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

const SCRIPT = readFileSync(new URL("../client/hosted.js", import.meta.url), "utf8");
const XINPUT = readFileSync(new URL("../../port/linux/src/xinput_sdl.c", import.meta.url), "utf8").replace(/\r\n/g, "\n");

interface Control { id: string; label: string; defaults: number[]; index: number }
interface InputSettings {
  settings: { sensitivity: number; invert: boolean; bindings: Record<string, number[]> };
  inputsOf(id: string): number[];
  controlsOf(input: number): string[];
  conflicts(): Record<string, string[]>;
  bind(id: string, input: number): { ok?: boolean; also?: string[]; refused?: string };
  unbind(id: string, input: number): void;
  resetControls(): void;
  setSensitivity(value: number): void;
  setInvert(invert: boolean): void;
  resetMouse(): void;
  apply(): boolean;
}
interface HostedUi {
  createInputSettings(environment: { storage: Storage; module(name: string): ((...args: number[]) => number) | null }): InputSettings;
  inputFromEvent(event: Record<string, unknown>): { input?: number; refused?: string };
  inputLabel(input: number): string;
  sensitivityFromSlider(position: number): number;
  sliderFromSensitivity(value: number): number;
  CONTROLS: Control[];
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

/* the game's exports, recording what they are given */
function game() {
  const calls: { bind: number[][]; apply: number; sensitivity: number[]; invert: number[] } =
    { bind: [], apply: 0, sensitivity: [], invert: [] };
  const exports: Record<string, (...args: number[]) => number> = {
    platform_web_bind_input: (...args) => { calls.bind.push(args); return 1; },
    platform_web_apply_input_bindings: () => { calls.apply++; return 1; },
    platform_web_set_mouse_sensitivity: (value) => { calls.sensitivity.push(value); return 1; },
    platform_web_set_invert_mouse: (value) => { calls.invert.push(value); return 1; },
  };
  return { calls, module: (name: string) => exports[name] ?? null };
}

const MOUSE = 0x1000;
const WHEEL = 0x2000;
/* SDL's scancodes (SDL_scancode.h) and mouse buttons (SDL_mouse.h) */
const SDL: Record<string, number> = {
  SDL_SCANCODE_W: 26, SDL_SCANCODE_S: 22, SDL_SCANCODE_A: 4, SDL_SCANCODE_D: 7, SDL_SCANCODE_SPACE: 44,
  SDL_SCANCODE_RETURN: 40, SDL_SCANCODE_KP_ENTER: 88, SDL_SCANCODE_F: 9, SDL_SCANCODE_BACKSPACE: 42,
  SDL_SCANCODE_E: 8, SDL_SCANCODE_R: 21, SDL_SCANCODE_TAB: 43, SDL_SCANCODE_Q: 20, SDL_SCANCODE_X: 27,
  SDL_SCANCODE_G: 10, SDL_SCANCODE_C: 6, SDL_SCANCODE_LCTRL: 224, SDL_SCANCODE_Z: 29, SDL_SCANCODE_ESCAPE: 41,
  SDL_SCANCODE_F1: 58, SDL_SCANCODE_UP: 82, SDL_SCANCODE_DOWN: 81, SDL_SCANCODE_LEFT: 80, SDL_SCANCODE_RIGHT: 79,
  SDL_BUTTON_LEFT: 1, SDL_BUTTON_MIDDLE: 2, SDL_BUTTON_RIGHT: 3, SDL_BUTTON_X1: 4,
};

/* xinput_sdl.c's controls and their defaults, as the web build compiles them */
function engineDefaults(): { names: string[]; defaults: number[][] } {
  const namesText = XINPUT.slice(XINPUT.indexOf("input_control_names[NUMBER_OF_INPUT_CONTROLS] ="));
  const names = [...namesText.slice(0, namesText.indexOf("};")).matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!);
  let table = XINPUT.slice(XINPUT.indexOf("input_default_bindings[NUMBER_OF_INPUT_CONTROLS] ="));
  table = table.slice(table.indexOf("{") + 1, table.indexOf("\n};"));
  table = table.replace(/#ifdef HALO_WEB\n([\s\S]*?)#else\n[\s\S]*?#endif\n/g, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
  const defaults = [...table.matchAll(/\{ (\d+), \{ ([^}]*) \} \}/g)].map((match) => {
    const inputs = match[2]!.split(",").map((token) => token.trim()).map((token) => {
      const mouse = /^INPUT_MOUSE_BUTTON\((\w+)\)$/.exec(token);
      if (mouse) return MOUSE + SDL[mouse[1]!]!;
      if (token === "INPUT_WHEEL") return WHEEL;
      expect(SDL[token], token).toBeDefined();
      return SDL[token]!;
    });
    expect(inputs.length).toBe(Number(match[1]));
    return inputs;
  });
  return { names, defaults };
}

describe("the controls' defaults", () => {
  it("are the game's (xinput_sdl.c, web build), in its order", () => {
    const { CONTROLS } = load();
    const engine = engineDefaults();
    expect(engine.names.length).toBe(20);
    expect(CONTROLS.map((control) => control.id)).toEqual(engine.names);
    expect(CONTROLS.map((control) => control.defaults)).toEqual(engine.defaults);
    expect(CONTROLS.map((control) => control.index)).toEqual(engine.names.map((_, index) => index));
  });
});

describe("taking an input", () => {
  it("names keys by their SDL scancode, mouse buttons and the wheel", () => {
    const { inputFromEvent, inputLabel } = load();
    expect(inputFromEvent({ type: "keydown", code: "KeyJ" })).toEqual({ input: 13 });
    expect(inputFromEvent({ type: "keydown", code: "Space" })).toEqual({ input: 44 });
    expect(inputFromEvent({ type: "keydown", code: "ShiftLeft" })).toEqual({ input: 225 });
    expect(inputFromEvent({ type: "keydown", code: "Numpad5" })).toEqual({ input: 93 });
    expect(inputFromEvent({ type: "keydown", code: "F2" })).toEqual({ input: 59 });
    expect(inputFromEvent({ type: "mousedown", button: 0 })).toEqual({ input: MOUSE + 1 });
    expect(inputFromEvent({ type: "mousedown", button: 2 }), "right").toEqual({ input: MOUSE + 3 });
    expect(inputFromEvent({ type: "mousedown", button: 3 }), "back").toEqual({ input: MOUSE + 4 });
    expect(inputFromEvent({ type: "wheel", deltaY: 120 })).toEqual({ input: WHEEL });
    expect(inputLabel(13)).toBe("J");
    expect(inputLabel(MOUSE + 3)).toBe("Right click");
    expect(inputLabel(WHEEL)).toBe("Wheel");
    expect(inputLabel(88)).toBe("Num Enter");
  });

  it("refuses the keys the page, the browser and Discord keep", () => {
    const { inputFromEvent } = load();
    for (const code of ["Escape", "F5", "F8", "F11", "F12", "Backquote", "ControlLeft", "ControlRight", "MetaLeft",
        "AltLeft", "AltRight"]) {
      expect(inputFromEvent({ type: "keydown", code }).refused, code).toBeTruthy();
    }
    expect(inputFromEvent({ type: "keydown", code: "KeyW", ctrlKey: true }).refused, "Ctrl+W").toMatch(/browser/);
    expect(inputFromEvent({ type: "keydown", code: "KeyS", metaKey: true }).refused, "Cmd+S").toBeTruthy();
    expect(inputFromEvent({ type: "keydown", code: "BrowserBack" }).refused).toBeTruthy();
    expect(inputFromEvent({ type: "mousedown", button: 7 }).refused).toBeTruthy();
  });
});

describe("the settings", () => {
  it("bind, warn of conflicts, unbind and reset, applied to the game at once", () => {
    const { calls, module } = game();
    const store = storage();
    const settings = load().createInputSettings({ storage: store, module });
    expect(settings.inputsOf("jump")).toEqual([44, 40, 88]);
    expect(settings.conflicts(), "the defaults share nothing").toEqual({});

    expect(settings.bind("jump", 13)).toEqual({ ok: true, also: [] });
    expect(settings.inputsOf("jump")).toEqual([44, 40, 88, 13]);
    expect(calls.bind.at(-1), "control 4 staged with its four inputs").toEqual([4, 44, 40, 88, 13]);
    expect(calls.apply).toBe(1);
    expect(settings.bind("jump", 14).refused, "four is the most").toMatch(/4/);

    expect(settings.bind("fire", MOUSE + 3)).toEqual({ ok: true, also: ["grenade"] });
    expect(settings.conflicts()).toEqual({ [String(MOUSE + 3)]: ["grenade", "fire"] });
    expect(settings.controlsOf(MOUSE + 3)).toEqual(["grenade", "fire"]);

    settings.unbind("zoom", 29);
    settings.unbind("zoom", MOUSE + 2);
    expect(settings.inputsOf("zoom"), "a control can go unbound").toEqual([]);
    expect(calls.bind.at(-1), "unbound: staged with none").toEqual([13, 0, 0, 0, 0]);

    settings.unbind("jump", 13);
    expect(settings.settings.bindings.jump, "back at its defaults: no override kept").toBeUndefined();

    settings.resetControls();
    expect(settings.settings.bindings).toEqual({});
    const staged = calls.bind.length;
    expect(calls.apply).toBeGreaterThan(0);
    settings.apply();
    expect(calls.bind.length, "nothing staged: every control at its default").toBe(staged);
  });

  it("keep the mouse's sensitivity and invert, on a logarithmic slider", () => {
    const { calls, module } = game();
    const ui = load();
    const settings = ui.createInputSettings({ storage: storage(), module });
    expect(settings.settings).toMatchObject({ sensitivity: 1, invert: false });
    settings.setSensitivity(2.5);
    settings.setInvert(true);
    expect(calls.sensitivity.at(-1)).toBe(2.5);
    expect(calls.invert.at(-1)).toBe(1);
    settings.setSensitivity(50);
    expect(settings.settings.sensitivity, "at most 5x").toBe(5);
    settings.setSensitivity(0.01);
    expect(settings.settings.sensitivity, "at least 0.1x").toBe(0.1);
    settings.resetMouse();
    expect(settings.settings).toMatchObject({ sensitivity: 1, invert: false });
    expect(ui.sensitivityFromSlider(0)).toBeCloseTo(0.1);
    expect(ui.sensitivityFromSlider(1000)).toBeCloseTo(5);
    expect(ui.sensitivityFromSlider(ui.sliderFromSensitivity(1))).toBeCloseTo(1, 2);
    expect(ui.sliderFromSensitivity(1), "1x a little past the middle").toBeGreaterThan(500);
  });

  it("last between visits, and survive damaged storage", () => {
    const store = storage();
    const first = load().createInputSettings({ storage: store, module: () => null });
    first.bind("crouch", 225);
    first.unbind("crouch", 6);
    first.setSensitivity(0.75);
    first.setInvert(true);
    expect(first.apply(), "the game is not running yet").toBe(false);

    const { calls, module } = game();
    const again = load().createInputSettings({ storage: store, module });
    expect(again.inputsOf("crouch")).toEqual([225]);
    expect(again.settings).toMatchObject({ sensitivity: 0.75, invert: true });
    expect(again.apply()).toBe(true);
    expect(calls.sensitivity).toEqual([0.75]);
    expect(calls.invert).toEqual([1]);
    expect(calls.bind).toEqual([[12, 225, 0, 0, 0]]);
    expect(calls.apply).toBe(1);

    const damaged = load().createInputSettings({ storage: storage({ "halo-hosted-input": "{nope" }), module });
    expect(damaged.settings).toEqual({ sensitivity: 1, invert: false, bindings: {} });
    const odd = load().createInputSettings({
      storage: storage({ "halo-hosted-input": JSON.stringify({
        sensitivity: "fast", invert: "yes", bindings: { jump: [13, 99999, "x", 14, 15, 16, 17], nonsense: [4] } }) }),
      module,
    });
    expect(odd.settings.sensitivity).toBe(1);
    expect(odd.settings.invert).toBe(false);
    expect(odd.inputsOf("jump"), "unknown inputs dropped, at most four kept").toEqual([13, 14, 15, 16]);
    expect(odd.settings.bindings.nonsense).toBeUndefined();
  });
});
