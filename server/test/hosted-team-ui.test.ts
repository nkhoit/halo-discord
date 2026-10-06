// @vitest-environment happy-dom
/// <reference lib="dom" />
/* Team games (client/hosted.js in a DOM): Red and Blue, Discord names, a
   click on your own name or a team header switches in the lobby; mid-match
   Esc overlay switches when balance allows. Spectating/postgame stay locked.
   Free-for-all modes show neither. */
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const SCRIPT = readFileSync(new NodeURL("../client/hosted.js", import.meta.url), "utf8");

type Player = { name: string; team: number; self?: boolean };
type Status = {
  view: string;
  role?: string;
  host?: string;
  settings?: { mapIndex: number; modeIndex: number };
  playerCount?: number;
  spectating?: boolean;
  teams?: { enabled: boolean; pregame: boolean; canSwitch?: boolean; allowed?: { 0: boolean; 1: boolean }; players: Player[] };
};

const lobbyPlayers: Player[] = [
  { name: "Bob", team: 0, self: false },
  { name: "Arbiter!", team: 0, self: true },
  { name: "Alice", team: 1, self: false },
  { name: "Zed", team: -1, self: false },
];

let status: Status = {
  view: "hosting",
  role: "host",
  host: "Arbiter",
  settings: { mapIndex: 0, modeIndex: 1 },
  playerCount: 3,
  teams: { enabled: true, pregame: true, players: lobbyPlayers.map((player) => ({ ...player })) },
};
const teamCalls: number[] = [];
const tick = () => new Promise((resolve) => setTimeout(resolve, 250));

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  expect(node, id).toBeTruthy();
  return node!;
}

const visible = (id: string) => !byId(id).hidden;

function column(id: string): { name: string; self: boolean; tag: string }[] {
  return [...byId(id).querySelectorAll(".hosted-team-player")].map((node) => ({
    name: node.textContent ?? "",
    self: node.getAttribute("data-self") === "true",
    tag: node.tagName,
  }));
}

function header(team: number): HTMLButtonElement {
  const node = document.querySelector(`.hosted-team-header[data-team="${team}"]`);
  expect(node, `team ${team}`).toBeTruthy();
  return node as HTMLButtonElement;
}

beforeAll(() => {
  document.documentElement.classList.add("halo-hosted");
  document.body.innerHTML = '<main id="game-area" data-presented="true"><canvas id="canvas"></canvas></main>';
  localStorage.clear();
  (window as unknown as Record<string, unknown>).HaloOnline = {
    status: () => status,
    setTeam: (team: number) => {
      teamCalls.push(team);
      return true;
    },
  };
  new Function(SCRIPT)();
});

describe("the lobby team picker", () => {
  it("shows Red and Blue for team slayer, with this player first", () => {
    expect(visible("hosted-teams")).toBe(true);
    expect(byId("hosted-teams").parentElement?.id).toBe("hosted-bar");
    expect(byId("hosted-teams").getAttribute("data-interactive")).toBe("true");
    expect(header(0).textContent).toBe("Red");
    expect(header(1).textContent).toBe("Blue");
    expect(header(0).disabled).toBe(false);
    expect(header(1).disabled).toBe(false);
    expect(column("hosted-team-red")).toEqual([
      { name: "Arbiter!", self: true, tag: "BUTTON" },
      { name: "Bob", self: false, tag: "SPAN" },
    ]);
    expect(column("hosted-team-blue")).toEqual([
      { name: "Alice", self: false, tag: "SPAN" },
    ]);
    expect(teamCalls).toEqual([]);
  });

  it("switches when you click your name or a team header", () => {
    const self = byId("hosted-team-red").querySelector("[data-self='true']") as HTMLButtonElement;
    expect(self.getAttribute("aria-label")).toBe("Switch Arbiter! to Blue");
    self.click();
    header(1).click();
    header(0).click();
    (byId("hosted-team-blue").querySelector(".hosted-team-player") as HTMLElement).click();
    expect(teamCalls).toEqual([1, 1, 0]);
  });

  it("moves a player as soon as the roster says they switched", async () => {
    status.teams!.players = [
      { name: "Bob", team: 0, self: false },
      { name: "Arbiter!", team: 0, self: true },
      { name: "Alice", team: 0, self: false },
    ];
    await tick();
    expect(column("hosted-team-red").map((player) => player.name)).toEqual(["Arbiter!", "Alice", "Bob"]);
    expect(column("hosted-team-blue")).toEqual([]);
    expect(teamCalls).toEqual([1, 1, 0]);
  });

  it("shows capture the flag and hides every free-for-all", async () => {
    status.settings = { mapIndex: 0, modeIndex: 2 };
    await tick();
    expect(visible("hosted-teams")).toBe(true);
    status.teams = { enabled: false, pregame: true, players: lobbyPlayers };
    await tick();
    expect(visible("hosted-teams")).toBe(false);
    for (const modeIndex of [0, 3, 4, 5]) {
      status = {
        view: "hosting",
        role: "host",
        settings: { mapIndex: 0, modeIndex },
        teams: { enabled: false, pregame: true, players: lobbyPlayers },
      };
      await tick();
      expect(visible("hosted-teams"), `mode ${modeIndex}`).toBe(false);
    }
  });

  it("shows empty columns for a team mode before the roster arrives, and never invents a team", async () => {
    const before = teamCalls.length;
    status = { view: "hosting", role: "host", settings: { mapIndex: 0, modeIndex: 1 }, playerCount: 1 };
    await tick();
    expect(visible("hosted-teams")).toBe(true);
    expect(column("hosted-team-red")).toEqual([]);
    expect(column("hosted-team-blue")).toEqual([]);
    expect(byId("hosted-teams").getAttribute("data-interactive")).toBe("true");
    status = { view: "hosting", role: "host", settings: { mapIndex: 0, modeIndex: 0 }, playerCount: 1 };
    await tick();
    expect(visible("hosted-teams")).toBe(false);
    expect(teamCalls.length).toBe(before);
  });

  it("lets a guest switch in the lobby even when their saved game type is slayer", async () => {
    status = {
      view: "joined",
      role: "guest",
      host: "Alice",
      settings: { mapIndex: 0, modeIndex: 0 },
      teams: {
        enabled: true,
        pregame: true,
        players: [
          { name: "Alice", team: 0, self: false },
          { name: "Arbiter!", team: 1, self: true },
        ],
      },
    };
    await tick();
    expect(visible("hosted-teams")).toBe(true);
    expect(byId("hosted-teams").parentElement?.id).toBe("hosted-bar");
    expect(column("hosted-team-blue")).toEqual([{ name: "Arbiter!", self: true, tag: "BUTTON" }]);
    (byId("hosted-team-blue").querySelector("[data-self='true']") as HTMLButtonElement).click();
    expect(teamCalls.at(-1)).toBe(0);
  });

  it("shows a spectator the teams and does not let them switch", async () => {
    const before = teamCalls.length;
    status = {
      view: "spectating",
      role: "guest",
      host: "Alice",
      spectating: true,
      teams: {
        enabled: true,
        pregame: false,
        players: [
          { name: "Alice", team: 0, self: false },
          { name: "Arbiter!", team: 1, self: true },
        ],
      },
    };
    await tick();
    expect(visible("hosted-teams")).toBe(true);
    expect(byId("hosted-teams").getAttribute("data-interactive")).toBe("false");
    expect(header(0).disabled).toBe(true);
    expect(column("hosted-team-blue")[0]?.tag).toBe("SPAN");
    header(0).click();
    expect(teamCalls.length).toBe(before);
  });

  it("lets a player switch from the Esc overlay mid-match when balance allows", async () => {
    const before = teamCalls.length;
    status = {
      view: "match",
      role: "host",
      host: "Arbiter",
      settings: { mapIndex: 0, modeIndex: 1 },
      teams: {
        enabled: true,
        pregame: false,
        canSwitch: true,
        allowed: { 0: true, 1: true },
        players: [
          { name: "Arbiter!", team: 0, self: true },
          { name: "Alice", team: 1, self: false },
        ],
      },
    };
    await tick();
    expect(visible("hosted-overlay")).toBe(true);
    expect(visible("hosted-teams")).toBe(true);
    expect(byId("hosted-teams").parentElement?.id).toBe("hosted-overlay-main");
    expect(byId("hosted-teams").getAttribute("data-interactive")).toBe("true");
    expect(header(0).disabled).toBe(false);
    expect(header(1).disabled).toBe(false);
    expect(column("hosted-team-red")).toEqual([{ name: "Arbiter!", self: true, tag: "BUTTON" }]);
    expect(column("hosted-team-blue")).toEqual([{ name: "Alice", self: false, tag: "SPAN" }]);
    (byId("hosted-team-red").querySelector("[data-self='true']") as HTMLButtonElement).click();
    expect(teamCalls.at(-1)).toBe(1);
    header(1).click();
    expect(teamCalls.at(-1)).toBe(1);
    expect(teamCalls.length).toBe(before + 2);
  });

  it("disables switching into a larger team mid-match", async () => {
    const before = teamCalls.length;
    status = {
      view: "match",
      role: "guest",
      host: "Alice",
      settings: { mapIndex: 0, modeIndex: 1 },
      teams: {
        enabled: true,
        pregame: false,
        canSwitch: true,
        allowed: { 0: false, 1: true },
        players: [
          { name: "Alice", team: 0, self: false },
          { name: "Bob", team: 0, self: false },
          { name: "Arbiter!", team: 1, self: true },
        ],
      },
    };
    await tick();
    expect(byId("hosted-teams").getAttribute("data-interactive")).toBe("true");
    expect(header(0).disabled).toBe(true);
    expect(header(1).disabled).toBe(false);
    expect(column("hosted-team-blue")[0]?.tag).toBe("SPAN");
    header(0).click();
    expect(teamCalls.length).toBe(before);
  });

  it("hides the teams while the mouse is in the match, and shows them again in the Esc menu", async () => {
    (window as unknown as { HaloHostedUI: { controller: { pointerLock: (locked: boolean) => void } } })
      .HaloHostedUI.controller.pointerLock(true);
    await tick();
    expect(visible("hosted-overlay")).toBe(false);
    expect(visible("hosted-teams")).toBe(false);
    status = { ...status, view: "spectating" };
    await tick();
    expect(visible("hosted-overlay"), "a spectator's menu, first").toBe(true);
    expect(byId("hosted-teams").parentElement?.id).toBe("hosted-overlay-main");
    (window as unknown as { HaloHostedUI: { controller: { spectateMenu: (open: boolean) => void } } })
      .HaloHostedUI.controller.spectateMenu(false);
    await tick();
    expect(visible("hosted-overlay")).toBe(false);
    expect(visible("hosted-teams"), "nor over a match watched").toBe(false);
    status = { ...status, view: "match" };
    (window as unknown as { HaloHostedUI: { controller: { pointerLock: (locked: boolean) => void } } })
      .HaloHostedUI.controller.pointerLock(false);
    await tick();
    expect(visible("hosted-overlay")).toBe(true);
    expect(visible("hosted-teams")).toBe(true);
    expect(byId("hosted-teams").parentElement?.id).toBe("hosted-overlay-main");
  });

  it("shows the teams on the results, still locked", async () => {
    const before = teamCalls.length;
    status = {
      view: "postgame",
      role: "host",
      host: "Arbiter",
      teams: {
        enabled: true,
        pregame: false,
        players: [
          { name: "Arbiter!", team: 0, self: true },
          { name: "Alice", team: 1, self: false },
        ],
      },
    };
    await tick();
    expect(visible("hosted-teams")).toBe(true);
    expect(byId("hosted-teams").parentElement?.id).toBe("hosted-bar");
    expect(byId("hosted-teams").getAttribute("data-interactive")).toBe("false");
    expect(column("hosted-team-red")[0]?.tag).toBe("SPAN");
    header(1).click();
    expect(teamCalls.length).toBe(before);
  });

  it("follows the red/blue flip when the next lobby opens, and switching works again", async () => {
    status = {
      view: "hosting",
      role: "host",
      host: "Arbiter",
      settings: { mapIndex: 0, modeIndex: 1 },
      playerCount: 2,
      teams: {
        enabled: true,
        pregame: true,
        players: [
          { name: "Arbiter!", team: 1, self: true },
          { name: "Alice", team: 0, self: false },
        ],
      },
    };
    await tick();
    expect(visible("hosted-panel")).toBe(true);
    expect(byId("hosted-title").textContent).toBe("Next match");
    expect(byId("hosted-teams").parentElement?.id).toBe("hosted-panel");
    expect(byId("hosted-teams").getAttribute("data-interactive")).toBe("true");
    expect(column("hosted-team-red")).toEqual([{ name: "Alice", self: false, tag: "SPAN" }]);
    expect(column("hosted-team-blue")).toEqual([{ name: "Arbiter!", self: true, tag: "BUTTON" }]);
    (byId("hosted-team-blue").querySelector("[data-self='true']") as HTMLButtonElement).click();
    header(0).click();
    expect(teamCalls.slice(-2)).toEqual([0, 0]);
  });
});
