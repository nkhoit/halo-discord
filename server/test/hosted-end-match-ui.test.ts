// @vitest-environment happy-dom
/// <reference lib="dom" />
/* The host's End match (#44, client/hosted.js in a DOM): only the host, only
   in a match, and only after confirming. It ends the match. Close room is
   the control that still leaves. A guest never sees End match. */
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const SCRIPT = readFileSync(new NodeURL("../client/hosted.js", import.meta.url), "utf8");

let status: Record<string, unknown> = { view: "match", role: "host", host: "Arbiter" };
let ends = 0;
let leaves = 0;
const tick = () => new Promise((resolve) => setTimeout(resolve, 250));

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  expect(node, id).toBeTruthy();
  return node!;
}

const visible = (id: string) => !byId(id).hidden;

function escape() {
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", key: "Escape", bubbles: true, cancelable: true }));
}

beforeAll(() => {
  document.documentElement.classList.add("halo-hosted");
  document.body.innerHTML = '<main id="game-area" data-presented="true"><canvas id="canvas"></canvas></main>';
  localStorage.clear();
  (window as unknown as Record<string, unknown>).HaloOnline = {
    status: () => status,
    endMatch: () => {
      ends++;
      return true;
    },
    leave: () => {
      leaves++;
      return Promise.resolve();
    },
  };
  new Function(SCRIPT)();
});

describe("the host ends the match", () => {
  it("shows End match and Close room while the host is in a match", () => {
    expect(visible("hosted-overlay")).toBe(true);
    expect(visible("hosted-end-match")).toBe(true);
    expect(byId("hosted-end-match").textContent).toBe("End match");
    expect(visible("hosted-menu")).toBe(true);
    expect(visible("hosted-end-confirm")).toBe(false);
    expect(byId("hosted-leave").textContent).toBe("Close room");
    expect(ends).toBe(0);
  });

  it("asks before ending, and Cancel does not end it", () => {
    byId("hosted-end-match").click();
    expect(visible("hosted-end-confirm")).toBe(true);
    expect(byId("hosted-end-confirm-text").textContent).toBe("End the match for everyone?");
    expect(visible("hosted-end-match")).toBe(false);
    expect(ends).toBe(0);
    byId("hosted-end-cancel").click();
    expect(visible("hosted-end-confirm")).toBe(false);
    expect(visible("hosted-end-match")).toBe(true);
    expect(ends).toBe(0);
  });

  it("Escape cancels the confirmation", () => {
    byId("hosted-end-match").click();
    expect(visible("hosted-end-confirm")).toBe(true);
    escape();
    expect(visible("hosted-end-confirm")).toBe(false);
    expect(ends).toBe(0);
  });

  it("confirmation ends the match and leaves the room up", () => {
    byId("hosted-end-match").click();
    byId("hosted-end-confirm-yes").click();
    expect(ends).toBe(1);
    expect(leaves).toBe(0);
    expect(visible("hosted-end-confirm")).toBe(false);
  });

  it("Close room is the control that leaves", () => {
    byId("hosted-leave").click();
    expect(leaves).toBe(1);
    expect(ends).toBe(1);
  });

  it("hides End match once the results are up, and the host can pick the next match", async () => {
    status = { view: "postgame", role: "host", host: "Arbiter" };
    await tick();
    expect(visible("hosted-overlay")).toBe(false);
    expect(visible("hosted-end-match")).toBe(false);
    expect(visible("hosted-next")).toBe(true);
    expect(byId("hosted-next").textContent).toBe("Next match");
    expect(byId("hosted-bar-text").textContent).toBe("Match over");
    status = { view: "hosting", role: "host", host: "Arbiter", settings: { mapIndex: 0, modeIndex: 0 }, playerCount: 2 };
    await tick();
    expect(visible("hosted-panel")).toBe(true);
    expect(byId("hosted-title").textContent).toBe("Next match");
    expect(visible("hosted-end-match")).toBe(false);
    expect(leaves).toBe(1);
  });

  it("gives a guest no End match button", async () => {
    status = { view: "match", role: "guest", host: "Arbiter" };
    await tick();
    expect(visible("hosted-overlay")).toBe(true);
    expect(visible("hosted-end-match")).toBe(false);
    expect(visible("hosted-end-confirm")).toBe(false);
    expect(byId("hosted-leave").textContent).toBe("Leave game");
    expect(ends).toBe(1);
  });
});
