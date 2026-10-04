/* The server-wide lobby (#21): an Activity in one voice channel lists and
   joins the matches hosted from the same Discord server's other channels,
   and never another server's. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activityRoomId } from "../src/auth.ts";
import { MAXIMUM_ROOM_PLAYERS } from "../src/protocol.ts";
import { issueToken } from "../src/tokens.ts";
import { type Client, open, type Running, SECRET, start, until } from "./harness.ts";

const A = "i-11-gc-100-1";
const B = "i-12-gc-100-2";
const C = "i-13-gc-200-3";

let server: Running;
beforeEach(async () => {
  server = await start({ discord: { clientId: "123", clientSecret: "shh", guildIds: ["100", "200"] } });
  for (const [code, id, guilds] of [["alice", "1", ["100"]], ["bob", "2", ["100"]], ["carol", "3", ["200"]],
      ["dave", "4", ["100", "200"]]] as const) {
    server.discord.users.set(code, { id, username: code, globalName: null });
    server.discord.memberGuilds.set(code, [...guilds]);
  }
});
afterEach(async () => { await server.close(); });

async function signIn(code: string, instanceId: string) {
  const response = await fetch(`${server.base}/auth/activity`, {
    method: "POST", body: JSON.stringify({ code, instanceId }), headers: { "Content-Type": "application/json" },
  });
  return { status: response.status, ...(await response.json()) as { token: string; roomId: string } };
}

const list = async (token: string, build = "b1") => {
  const response = await fetch(`${server.base}/v1/guild-rooms?build=${build}`,
    { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, rooms: response.ok ? (await response.json() as { rooms: Record<string, unknown>[] }).rooms : [] };
};

async function connect(roomId: string, role: string, token: string, id: string, options: { ch?: string; build?: string } = {}):
    Promise<Client> {
  const client = open(server.base, roomId, role, options.ch);
  await new Promise<void>((resolve, reject) => {
    client.socket.once("open", () => resolve());
    client.socket.once("error", reject);
  });
  client.socket.send(JSON.stringify({ type: "auth", token, id, build: options.build ?? "b1" }));
  await Promise.race([until(() => client.texts.some((text) => text.type === "ready")), client.closed]);
  return client;
}
const ready = (client: Client) => client.texts.some((text) => text.type === "ready");

const phase = (client: Client, fields: Record<string, unknown>) =>
  client.socket.send(JSON.stringify({ type: "phase", inMatch: false, joinable: false, ...fields }));

describe("the server-wide lobby", () => {
  it("lists a match to another channel of the same server, with what it plays, and lets it join", async () => {
    const alice = await signIn("alice", A);
    const bob = await signIn("bob", B);
    expect(alice.roomId).toBe(activityRoomId(SECRET, A));
    expect(bob.roomId).not.toBe(alice.roomId);
    expect((await list(bob.token)).rooms, "nobody hosts yet").toEqual([]);

    const host = await connect(alice.roomId, "host", alice.token, "020000000001");
    phase(host, { state: "lobby", map: 3, mode: 1, channel: "Alpha\u0000 squad" });
    await until(() => server.app.relay.rooms.get(alice.roomId)?.map === 3);
    expect((await list(bob.token)).rooms).toEqual([{
      roomId: alice.roomId, host: "alice", channel: "Alpha squad", map: 3, mode: 1, state: "lobby",
      players: 1, spectators: 0, capacity: MAXIMUM_ROOM_PLAYERS, joinable: true, reason: null, watchable: false,
    }]);
    expect((await list(alice.token)).rooms, "not your own room").toEqual([]);

    const guest = await connect(alice.roomId, "guest", bob.token, "020000000002");
    expect(ready(guest)).toBe(true);
    await until(() => host.texts.some((text) => text.type === "peer-up"));
    expect((await list(bob.token)).rooms[0]).toMatchObject({ players: 2 });

    phase(host, { inMatch: true, joinable: true, watchable: true, state: "match", map: 3, mode: 1 });
    await until(() => server.app.relay.rooms.get(alice.roomId)?.state === "match");
    expect((await list(bob.token)).rooms[0]).toMatchObject({ state: "match", joinable: true, watchable: true, channel: null });
    const dave = await signIn("dave", B);
    await connect(alice.roomId, "guest", dave.token, "020000000004");
    phase(host, { inMatch: true, joinable: false, watchable: true, state: "match" });
    await until(() => !server.app.relay.rooms.get(alice.roomId)?.joinable);
    expect((await list(bob.token)).rooms[0], "a full match is still watched").toMatchObject({ joinable: false,
      reason: "match", watchable: true });
    phase(host, { inMatch: true, joinable: false, state: "starting" });
    await until(() => server.app.relay.rooms.get(alice.roomId)?.state === "starting");
    expect((await list(bob.token)).rooms[0]).toMatchObject({ state: "starting", joinable: false, reason: "match" });
  });

  it("never shows or admits another server's matches", async () => {
    const alice = await signIn("alice", A);
    const carol = await signIn("carol", C);
    const host = await connect(alice.roomId, "host", alice.token, "020000000001");
    phase(host, { state: "lobby", map: 0, mode: 0 });
    await settleList();
    expect((await list(carol.token)).rooms).toEqual([]);
    const intruder = await connect(alice.roomId, "guest", carol.token, "020000000003");
    expect(await intruder.closed).toEqual({ code: 4409, reason: "not in your Discord server" });
    /* A member of both servers, launched in the other one, sees and joins. */
    const dave = await signIn("dave", C);
    expect((await list(dave.token)).rooms, "lists only the instance's server").toEqual([]);
    expect(ready(await connect(alice.roomId, "guest", dave.token, "020000000004"))).toBe(true);
  });

  it("signs an Activity in only for a member of the instance's server", async () => {
    expect((await signIn("carol", A)).status).toBe(403);
    expect((await signIn("bob", "i-14-gc-999-1")).status, "a server off the allowlist").toBe(403);
    expect(server.discord.membershipChecks.at(-1)).toEqual({ code: "bob", guildIds: ["100", "200"] });
    const dm = await signIn("bob", "i-15-pc-7");
    expect(dm.status, "outside a server: the user's own room only").toBe(200);
    expect((await list(dm.token)).rooms).toEqual([]);
  });

  it("refuses sessions without the server, browser sessions and other rooms", async () => {
    const alice = await signIn("alice", A);
    await connect(alice.roomId, "host", alice.token, "020000000001");
    const withoutGuilds = issueToken(SECRET, "9", "nine", 600, undefined, undefined, { inst: B }).token;
    expect(await (await connect(alice.roomId, "guest", withoutGuilds, "020000000009")).closed)
      .toEqual({ code: 4409, reason: "not in your Discord server" });
    const browser = issueToken(SECRET, "8", "eight", 600, undefined, undefined, { guilds: ["200"] }).token;
    expect(await (await connect(alice.roomId, "guest", browser, "020000000008")).closed)
      .toEqual({ code: 4409, reason: "not in your Discord server" });
    expect((await list(browser)).rooms, "a browser session lists nothing").toEqual([]);
    const bob = await signIn("bob", B);
    expect(await (await connect("link-room-0000000001", "guest", bob.token, "020000000002")).closed,
      "an Activity joins no link room").toEqual({ code: 4409, reason: "not in your Discord server" });
    const browserMember = issueToken(SECRET, "7", "seven", 600, undefined, undefined, { guilds: ["100"] }).token;
    expect(ready(await connect(alice.roomId, "guest", browserMember, "020000000007")),
      "a browser session of a member").toBe(true);
    expect((await fetch(`${server.base}/v1/guild-rooms`)).status).toBe(401);
  });

  it("keeps the build pin and the room's capacity", async () => {
    const alice = await signIn("alice", A);
    const bob = await signIn("bob", B);
    const host = await connect(alice.roomId, "host", alice.token, "020000000001", { ch: "r" });
    await connect(alice.roomId, "host", alice.token, "020000000001", { ch: "u" });
    phase(host, { state: "lobby" });
    await settleList();
    expect((await list(bob.token, "b2")).rooms[0]).toMatchObject({ joinable: false, reason: "version" });
    expect(await (await connect(alice.roomId, "guest", bob.token, "020000000002", { build: "b2" })).closed)
      .toEqual({ code: 4409, reason: "build mismatch" });
    for (let index = 1; index < MAXIMUM_ROOM_PLAYERS; index++) {
      const id = (0x030000000000 + index).toString(16).padStart(12, "0");
      const token = issueToken(SECRET, `user-${index}`, `u${index}`, 600, undefined, undefined, { guilds: ["100"], inst: A }).token;
      await connect(alice.roomId, "guest", token, id, { ch: "r" });
      await connect(alice.roomId, "guest", token, id, { ch: "u" });
    }
    expect((await list(bob.token)).rooms[0]).toMatchObject({ players: MAXIMUM_ROOM_PLAYERS, capacity: MAXIMUM_ROOM_PLAYERS,
      joinable: false, reason: "full" });
    expect(await (await connect(alice.roomId, "guest", bob.token, "020000000002")).closed)
      .toEqual({ code: 4409, reason: "room full" });
  });

  it("learns a room's server again from its members after a restart", async () => {
    const alice = await signIn("alice", A);
    const bob = await signIn("bob", B);
    await server.close();
    server = await start({ discord: { clientId: "123", clientSecret: "shh", guildIds: ["100", "200"] } });
    const host = await connect(alice.roomId, "host", alice.token, "020000000001");
    phase(host, { state: "lobby", map: 1, mode: 2 });
    await settleList();
    expect((await list(bob.token)).rooms.map((room) => room.roomId)).toEqual([alice.roomId]);
    host.socket.close();
    await until(() => !server.app.relay.rooms.has(alice.roomId));
    expect((await list(bob.token)).rooms).toEqual([]);
  });

  it("keeps the server and instance through renewals", async () => {
    const alice = await signIn("alice", A);
    const renewed = await fetch(`${server.base}/auth/session`, { headers: { Cookie: `halo_activity=${alice.token}` } });
    const { token } = await renewed.json() as { token: string };
    const payload = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"));
    expect(payload).toMatchObject({ guilds: ["100"], inst: A });
  });
});

const settleList = () => new Promise((resolve) => setTimeout(resolve, 50));
