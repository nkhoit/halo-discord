// @vitest-environment happy-dom
/// <reference lib="dom" />
/* The server-wide lobby's list (client/hosted.js in a DOM): polled only
   while nobody hosts here and the picker shows, each match with its host,
   channel, map, game type, players and state, joined with its button, and
   full or other-version matches shown but not joinable. */
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const SCRIPT = readFileSync(new NodeURL("../client/hosted.js", import.meta.url), "utf8");

let status: Record<string, unknown> = { view: "checking" };
let rooms: Record<string, unknown>[] = [];
const requests: number[] = [];
const joined: Record<string, unknown>[] = [];
const tick = () => new Promise((resolve) => setTimeout(resolve, 250));

/* The list's next poll, run by hand. */
const polls: (() => void)[] = [];
const realSetTimeout = window.setTimeout;
const realClearTimeout = window.clearTimeout;
const cleared: number[] = [];
let nextTimer = 1000;
(window as unknown as { setTimeout: unknown }).setTimeout = (callback: () => void, milliseconds?: number) => {
  if (milliseconds === 4000) {
    polls.push(callback);
    return ++nextTimer;
  }
  return realSetTimeout(callback, milliseconds);
};
(window as unknown as { clearTimeout: unknown }).clearTimeout = (id: number) => {
  cleared.push(id);
  realClearTimeout(id);
};


const ALICE = { roomId: "AliceRoom0123456789ab", host: "Alice", channel: "Squad A", map: 9, mode: 1, state: "lobby",
  players: 2, capacity: 16, joinable: true, reason: null };
const BOB = { roomId: "BobRoom0123456789abcd", host: "Bob", channel: null, map: 0, mode: 2, state: "match",
  players: 16, capacity: 16, joinable: false, reason: "full" };
const CAROL = { roomId: "CarolRoom0123456789ab", host: "Carol", channel: "Late", map: 3, mode: 0, state: "lobby",
  players: 1, capacity: 16, joinable: false, reason: "version" };

const entries = () => [...document.querySelectorAll<HTMLElement>("#hosted-guild-list li")].map((item) => ({
  host: item.querySelector(".hosted-guild-host")!.textContent,
  what: item.querySelector(".hosted-guild-what")!.textContent,
  players: item.querySelector(".hosted-guild-players")!.textContent,
  state: item.querySelector(".hosted-guild-state")!.textContent,
  button: item.querySelector("button")!.textContent,
  disabled: item.querySelector("button")!.disabled,
}));
const section = () => document.getElementById("hosted-guild")!;

beforeAll(() => {
  document.documentElement.classList.add("halo-hosted");
  document.body.innerHTML = '<main id="game-area" data-presented="true"><canvas id="canvas"></canvas></main>';
  localStorage.clear();
  (window as unknown as Record<string, unknown>).HaloOnline = {
    status: () => status,
    guildRooms: async () => { requests.push(Date.now()); return rooms; },
    joinGuildRoom: (room: Record<string, unknown>) => { joined.push(room); status = { view: "joining", host: room.host }; return true; },
  };
  new Function(SCRIPT)();
});

describe("the server-wide lobby", () => {
  it("asks nothing before nobody is found hosting here", async () => {
    await tick();
    expect(requests).toEqual([]);
    expect(section().hidden).toBe(true);
  });

  it("stays hidden while the server has no other match", async () => {
    status = { view: "pick", settings: { mapIndex: 0, modeIndex: 0 } };
    await tick();
    expect(requests).toHaveLength(1);
    expect(section().hidden).toBe(true);
    expect(polls, "polls again").toHaveLength(1);
  });

  it("lists the server's matches, and shows full or other-version ones as not joinable", async () => {
    rooms = [ALICE, BOB, CAROL];
    polls.shift()!();
    await tick();
    expect(requests).toHaveLength(2);
    expect(section().hidden).toBe(false);
    expect(section().querySelector("h2")!.textContent).toBe("Matches in this server");
    expect(entries()).toEqual([
      { host: "Alice · Squad A", what: "Blood Gulch · Team Slayer", players: "2/16", state: "In lobby", button: "Join", disabled: false },
      { host: "Bob", what: "Battle Creek · Capture the Flag", players: "16/16", state: "In match", button: "Full", disabled: true },
      { host: "Carol · Late", what: "Rat Race · Slayer", players: "1/16", state: "In lobby", button: "Different version", disabled: true },
    ]);
  });

  it("stops polling when the picker goes, and starts again when it is back", async () => {
    const timer = nextTimer;
    status = { view: "wait-match", host: "Dana" };
    await tick();
    expect(section().hidden).toBe(true);
    expect(cleared).toContain(timer);
    const asked = requests.length;
    status = { view: "pick", settings: { mapIndex: 0, modeIndex: 0 } };
    await tick();
    expect(requests).toHaveLength(asked + 1);
    expect(section().hidden).toBe(false);
  });

  it("joins a match with its button, and stops polling", async () => {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("#hosted-guild-list button")];
    buttons[1]!.click();
    expect(joined, "a full match's button does nothing").toEqual([]);
    buttons[0]!.click();
    expect(joined).toEqual([ALICE]);
    await tick();
    expect(section().hidden).toBe(true);
    const asked = requests.length;
    await tick();
    expect(requests).toHaveLength(asked);
    expect(document.getElementById("hosted-title")!.textContent).toBe("Joining Alice…");
  });
});
