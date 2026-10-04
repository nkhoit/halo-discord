import { once } from "node:events";
import { connect } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BATCH_MARKER, Channel, joinBatch, MAXIMUM_HALO_FRAME_BYTES, MAXIMUM_ROOM_SOCKETS, SEQUENCE_BYTES }
  from "../src/protocol.ts";
import { frame, join, open, type Running, sender, settle, start, token, until } from "./harness.ts";

const HOST = "020000000001";
const GUEST_A = "020000000002";
const GUEST_B = "020000000003";

let server: Running;
let roomCounter = 0;
const newRoom = () => `room-${++roomCounter}-${Math.random().toString(36).slice(2)}`;
beforeEach(async () => { server = await start(); });
afterEach(async () => { await server.close(); });

describe("relay protocol 2", () => {
  it("takes the protocol in the auth message and fans a host's multicast out to its guests", async () => {
    const room = newRoom();
    const host = await join(server.base, room, "host", "user-h", HOST, { protocol: 2 });
    const a = await join(server.base, room, "guest", "user-a", GUEST_A, { protocol: 2 });
    const b = await join(server.base, room, "guest", "user-b", GUEST_B, { protocol: 2 });
    await until(() => host.texts.filter((text) => text.type === "peer-up").length === 2);
    const slots = host.texts.filter((text) => text.type === "peer-up")
      .map((text) => [text.slot as number, text.generation as number]);
    const multicast = new Uint8Array(3 + 2 * 2 + 12);
    multicast.set([Channel.Multicast, Channel.Unreliable, 2, ...slots[0]!, ...slots[1]!, 0x48]);
    host.socket.send(joinBatch([multicast, frame(Channel.Unreliable, GUEST_A)]));
    await until(() => a.frames.length === 2 && b.frames.length === 1);
    expect([...a.frames, ...b.frames].every((bytes) => sender(bytes) === HOST)).toBe(true);
    for (const client of [host, a, b]) client.socket.close();
  });

  it("refuses a protocol it does not speak", async () => {
    const client = open(server.base, newRoom(), "host");
    await new Promise((resolve) => client.socket.once("open", resolve));
    client.socket.send(JSON.stringify({ type: "auth", token: token("user-h"), id: HOST, build: "b1", protocol: 3 }));
    expect((await client.closed).code).toBe(4401);
  });
});

describe("authentication", () => {
  it("rejects bad paths, parameters and origins before upgrading", async () => {
    const room = newRoom();
    for (const [path, origin] of [
      [`/v1/rooms/a/ws?role=host`, undefined],
      [`/v1/rooms/${room}/ws?role=admin`, undefined],
      [`/v1/rooms/${room}/ws?role=host&ch=x`, undefined],
      [`/v1/rooms/${room}/other?role=host`, undefined],
      [`/v1/rooms/${room}/ws?role=host`, "https://evil.example"],
    ] as const) {
      const client = open(server.base, room, "host", "both", origin ?? "http://127.0.0.1:9");
      client.socket.close();
      const socket = new (client.socket.constructor as typeof import("ws").WebSocket)(
        server.base.replace(/^http/, "ws") + path, { headers: { Origin: origin ?? "http://127.0.0.1:9" } });
      const status = await new Promise<number>((resolve) => {
        socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
        socket.on("open", () => resolve(101));
        socket.on("error", () => {});
      });
      expect(status, path).not.toBe(101);
    }
  });

  it("closes sockets that do not authenticate in time or correctly", async () => {
    const room = newRoom();
    const silent = open(server.base, room, "host");
    expect((await silent.closed).code).toBe(4401);
    for (const message of [
      "not json",
      JSON.stringify({ type: "auth", token: "forged", id: HOST, build: "b1" }),
      JSON.stringify({ type: "auth", token: token("1", "x", -5), id: HOST, build: "b1" }),
      JSON.stringify({ type: "auth", token: token("1"), id: "XYZ", build: "b1" }),
      JSON.stringify({ type: "auth", token: token("1"), id: HOST, build: "bad build!" }),
    ]) {
      const client = open(server.base, room, "host");
      await new Promise((resolve) => client.socket.once("open", resolve));
      client.socket.send(message);
      expect((await client.closed).code, message).toBe(4401);
    }
    const binary = open(server.base, room, "host");
    await new Promise((resolve) => binary.socket.once("open", resolve));
    binary.socket.send(frame(Channel.Reliable, HOST));
    expect((await binary.closed).code).toBe(4401);
  });
});

/* A WebSocket client written by hand, to send what a browser never would. */
describe("malformed frames", () => {
  const UNMASKED_HELLO = Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);

  /* A masked text frame; an all-zero mask key leaves the payload as it is. */
  function maskedText(text: string): Buffer {
    const payload = Buffer.from(text);
    const length = payload.length < 126 ? Buffer.from([0x80 | payload.length]) :
      Buffer.from([0x80 | 126, payload.length >> 8, payload.length & 0xff]);
    return Buffer.concat([Buffer.from([0x81]), length, Buffer.alloc(4), payload]);
  }

  async function raw(room: string, role = "guest") {
    const { port } = new URL(server.base);
    const socket = connect(Number(port), "127.0.0.1");
    let received = Buffer.alloc(0);
    socket.on("data", (data: Buffer) => { received = Buffer.concat([received, data]); });
    socket.on("error", () => {});
    const ended = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await once(socket, "connect");
    socket.write(`GET /v1/rooms/${room}/ws?role=${role}&ch=both HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
      "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
      "Sec-WebSocket-Version: 13\r\nOrigin: http://127.0.0.1:9\r\n\r\n");
    await until(() => received.includes("\r\n\r\n"));
    expect(received.toString("latin1")).toMatch(/^HTTP\/1\.1 101 /);
    received = received.subarray(received.indexOf("\r\n\r\n") + 4);
    return { socket, ended, received: () => received };
  }

  async function stillServing(): Promise<void> {
    expect(await (await fetch(`${server.base}/healthz`)).text()).toBe("ok");
    const room = newRoom();
    const host = await join(server.base, room, "host", "user-h", HOST);
    const guest = await join(server.base, room, "guest", "user-a", GUEST_A);
    guest.socket.send(frame(Channel.Reliable, HOST));
    await until(() => host.frames.length === 1);
    host.socket.close();
    guest.socket.close();
  }

  const errors = () => server.logs.filter((entry) => entry.event === "error");

  it("are refused before authentication without taking the server down", async () => {
    const client = await raw(newRoom());
    client.socket.write(UNMASKED_HELLO);
    await client.ended;
    expect(errors()).toEqual([expect.objectContaining({ code: "WS_ERR_EXPECTED_MASK", user: null })]);
    expect(JSON.stringify(server.logs)).not.toContain("hello");
    await stillServing();
  });

  it("are refused while an unauthorized or refused socket closes", async () => {
    const forged = await raw(newRoom());
    forged.socket.write(maskedText(JSON.stringify({ type: "auth", token: "forged", id: GUEST_A, build: "b1" })));
    await until(() => forged.received().length > 0);
    expect(forged.received()[0]).toBe(0x88);
    forged.socket.write(UNMASKED_HELLO);
    await forged.ended;

    const room = newRoom();
    const host = await join(server.base, room, "host", "user-h", HOST, { build: "web-1" });
    const mismatched = await raw(room);
    mismatched.socket.write(maskedText(JSON.stringify({ type: "auth", token: token("user-a"), id: GUEST_A, build: "web-2" })));
    await until(() => mismatched.received().length > 0);
    expect(mismatched.received()[0]).toBe(0x88);
    mismatched.socket.write(UNMASKED_HELLO);
    await mismatched.ended;
    expect(server.logs.some((entry) => entry.event === "refuse" && entry.reason === "build mismatch")).toBe(true);
    expect(errors()).toHaveLength(2);
    expect(host.socket.readyState).toBe(host.socket.OPEN);
    host.socket.close();
    await stillServing();
  });

  it("close a member's socket, once, and leave its room working", async () => {
    const room = newRoom();
    const host = await join(server.base, room, "host", "user-h", HOST);
    const client = await raw(room);
    client.socket.write(maskedText(JSON.stringify({ type: "auth", token: token("user-a"), id: GUEST_A, build: "b1" })));
    await until(() => client.received().includes('"ready"'));
    await until(() => host.texts.some((text) => text.type === "peer-up"));
    client.socket.write(UNMASKED_HELLO);
    await client.ended;
    await until(() => host.texts.some((text) => text.type === "peer-down"));
    expect(errors()).toEqual([expect.objectContaining({ code: "WS_ERR_EXPECTED_MASK", user: "user-a", id: GUEST_A })]);
    const guest = await join(server.base, room, "guest", "user-b", GUEST_B);
    guest.socket.send(frame(Channel.Reliable, HOST));
    await until(() => host.frames.length === 1);
    await stillServing();
  });
});

describe("admission", () => {
  it("binds the host role and identifiers to their Discord users", async () => {
    const room = newRoom();
    await join(server.base, room, "host", "user-h", HOST);
    const otherHost = open(server.base, room, "host");
    await new Promise((resolve) => otherHost.socket.once("open", resolve));
    otherHost.socket.send(JSON.stringify({ type: "auth", token: token("user-x"), id: GUEST_B, build: "b1" }));
    expect(await otherHost.closed).toEqual({ code: 4409, reason: "room already has a host" });

    const stolen = open(server.base, room, "guest");
    await new Promise((resolve) => stolen.socket.once("open", resolve));
    stolen.socket.send(JSON.stringify({ type: "auth", token: token("user-x"), id: HOST, build: "b1" }));
    expect(await stolen.closed).toEqual({ code: 4409, reason: "identifier in use" });
  });

  it("pins the room to the first build", async () => {
    const room = newRoom();
    await join(server.base, room, "host", "user-h", HOST, { build: "web-1" });
    const late = open(server.base, room, "guest");
    await new Promise((resolve) => late.socket.once("open", resolve));
    late.socket.send(JSON.stringify({ type: "auth", token: token("user-g"), id: GUEST_A, build: "web-2" }));
    expect(await late.closed).toEqual({ code: 4409, reason: "build mismatch" });
  });

  it("replaces a reconnecting identity's stale socket and re-announces it", async () => {
    const room = newRoom();
    const host = await join(server.base, room, "host", "user-h", HOST);
    const old = await join(server.base, room, "guest", "user-a", GUEST_A);
    await until(() => host.texts.filter((text) => text.type === "peer-up").length === 1);
    const fresh = await join(server.base, room, "guest", "user-a", GUEST_A);
    expect((await old.closed).code).toBe(4000);
    await until(() => host.texts.filter((text) => text.type === "peer-up").length === 2);
    await settle();
    expect(host.texts.some((text) => text.type === "peer-down")).toBe(false);
    host.socket.send(frame(Channel.Reliable, GUEST_A, undefined, 5));
    await until(() => fresh.frames.length === 1);
    expect(fresh.frames[0]![7]).toBe(5);

    const reliable = await join(server.base, room, "guest", "user-b", GUEST_B, { ch: "r" });
    const unreliable = await join(server.base, room, "guest", "user-b", GUEST_B, { ch: "u" });
    await join(server.base, room, "guest", "user-b", GUEST_B, { ch: "u" });
    expect((await unreliable.closed).code).toBe(4000);
    expect(reliable.socket.readyState).toBe(reliable.socket.OPEN);
  });

  it("caps sockets per room and forgets empty rooms", async () => {
    const room = newRoom();
    const host = await join(server.base, room, "host", "user-h", HOST);
    for (let index = 1; index < MAXIMUM_ROOM_SOCKETS; index++) {
      await join(server.base, room, "guest", `user-${index}`, (0x030000000000 + index).toString(16).padStart(12, "0"));
    }
    const late = open(server.base, room, "guest");
    await new Promise((resolve) => late.socket.once("open", resolve));
    late.socket.send(JSON.stringify({ type: "auth", token: token("late"), id: "040000000000", build: "b1" }));
    expect(await late.closed).toEqual({ code: 4409, reason: "room full" });
    expect(server.app.relay.rooms.has(room)).toBe(true);
    host.socket.close();
    await settle();
    expect(server.app.relay.rooms.get(room)?.members.size).toBe(MAXIMUM_ROOM_SOCKETS - 1);
  });
});

describe("membership", () => {
  it("tells guests about the host and the host about guests, with Discord names", async () => {
    const room = newRoom();
    const host = await join(server.base, room, "host", "user-h", HOST, { name: "Host\u0000 Person" });
    const guest = await join(server.base, room, "guest", "user-a", GUEST_A, { name: "Guest A" });
    expect(guest.texts[0]).toMatchObject({ type: "ready", peers: [HOST], names: { [HOST]: "Host Person" } });
    await until(() => host.texts.some((text) => text.type === "peer-up"));
    expect(host.texts.find((text) => text.type === "peer-up")).toEqual({ type: "peer-up", id: GUEST_A, name: "Guest A" });

    const other = await join(server.base, room, "guest", "user-b", GUEST_B);
    expect(other.texts[0]).toMatchObject({ peers: [HOST] });
    await settle();
    expect(guest.texts.some((text) => text.id === GUEST_B)).toBe(false);

    guest.socket.close(1000, "bye");
    await until(() => host.texts.some((text) => text.type === "peer-down"));
    expect(host.texts.find((text) => text.type === "peer-down")).toEqual({ type: "peer-down", id: GUEST_A });
    const accepts = server.logs.filter((entry) => entry.event === "accept");
    expect(accepts.map((entry) => entry.user)).toEqual(["user-h", "user-a", "user-b"]);
  });
});

describe("spectators (#52)", () => {
  it("count apart from players, say when they play, and still reach the host", async () => {
    const room = newRoom();
    const host = await join(server.base, room, "host", "user-h", HOST, { name: "Chief" });
    await join(server.base, room, "guest", "user-a", GUEST_A);
    const watcher = await join(server.base, room, "guest", "user-b", GUEST_B, { spectator: true });
    expect(server.app.relay.summary(room)).toMatchObject({ players: 2, spectators: 1 });
    host.socket.send(frame(Channel.Reliable, GUEST_B, undefined, 9));
    await until(() => watcher.frames.length === 1);
    watcher.socket.send(frame(Channel.Reliable, HOST, undefined, 4));
    await until(() => host.frames.some((bytes) => bytes[7 + 8] === 4 || bytes[7] === 4));
    watcher.socket.send(JSON.stringify({ type: "spectating", value: false }));
    await until(() => server.app.relay.summary(room).spectators === 0);
    expect(server.app.relay.summary(room)).toMatchObject({ players: 3, spectators: 0 });
    expect(server.logs.find((entry) => entry.event === "spectating")).toMatchObject({ user: "user-b", spectating: false });
    expect(watcher.socket.readyState).toBe(watcher.socket.OPEN);
  });

  it("are told by the host whether its running match takes them, until it ends or the host goes", async () => {
    const room = newRoom();
    const host = await join(server.base, room, "host", "user-h", HOST, { name: "Chief" });
    host.socket.send(JSON.stringify({ type: "phase", inMatch: true, joinable: false, watchable: true }));
    await until(() => server.app.relay.summary(room).watchable);
    expect(server.app.relay.summary(room)).toMatchObject({ inMatch: true, joinable: false, watchable: true });
    host.socket.send(JSON.stringify({ type: "phase", inMatch: false, watchable: true }));
    await until(() => !server.app.relay.summary(room).inMatch);
    expect(server.app.relay.summary(room).watchable, "a lobby is joined, not watched").toBe(false);
    host.socket.send(JSON.stringify({ type: "phase", inMatch: true, watchable: true }));
    await until(() => server.app.relay.summary(room).watchable);
    host.socket.close();
    await until(() => server.app.relay.summary(room).host === null);
    expect(server.app.relay.summary(room).watchable).toBe(false);
  });

  it("refuse the host's spectating and malformed spectating", async () => {
    const room = newRoom();
    const host = await join(server.base, room, "host", "user-h", HOST);
    const guest = await join(server.base, room, "guest", "user-a", GUEST_A, { spectator: true });
    host.socket.send(JSON.stringify({ type: "spectating", value: true }));
    expect((await host.closed).code).toBe(1003);
    guest.socket.send(JSON.stringify({ type: "spectating", value: "yes" }));
    expect((await guest.closed).code).toBe(1003);
    const hostAgain = await join(server.base, room, "host", "user-h", HOST, { spectator: true });
    expect(hostAgain.texts[0]).toMatchObject({ type: "ready" });
    expect(server.app.relay.summary(room).spectators, "a host never watches").toBe(0);
  });

  it("use the room's sockets: a full room takes no spectator either", async () => {
    const room = newRoom();
    const host = await join(server.base, room, "host", "user-h", HOST);
    for (let index = 1; index < MAXIMUM_ROOM_SOCKETS; index++) {
      await join(server.base, room, "guest", `user-${index}`, (0x030000000000 + index).toString(16).padStart(12, "0"),
        { spectator: index % 2 === 0 });
    }
    host.socket.send(JSON.stringify({ type: "phase", inMatch: true, joinable: true, watchable: true }));
    await until(() => server.app.relay.summary(room).inMatch);
    expect(server.app.relay.summary(room)).toMatchObject({ joinable: false, watchable: false,
      players: MAXIMUM_ROOM_SOCKETS / 2 + 1, spectators: MAXIMUM_ROOM_SOCKETS / 2 - 1 });
    const late = open(server.base, room, "guest");
    await new Promise((resolve) => late.socket.once("open", resolve));
    late.socket.send(JSON.stringify({ type: "auth", token: token("late"), id: "040000000000", build: "b1", spectator: true }));
    expect(await late.closed).toEqual({ code: 4409, reason: "room full" });
  });
});

describe("the host's phase", () => {
  it("lets the host say it is in a match, for the room's status", async () => {
    const room = newRoom();
    const host = await join(server.base, room, "host", "user-h", HOST, { name: "Chief" });
    const guest = await join(server.base, room, "guest", "user-a", GUEST_A);
    expect(server.app.relay.summary(room)).toEqual({ host: "Chief", players: 2, spectators: 0, inMatch: false,
      joinable: false, watchable: false });
    host.socket.send(JSON.stringify({ type: "phase", inMatch: true }));
    await until(() => server.app.relay.summary(room).inMatch);
    host.socket.send(frame(Channel.Reliable, GUEST_A, undefined, 7));
    await until(() => guest.frames.length === 1);
    host.socket.send(JSON.stringify({ type: "phase", inMatch: false }));
    await until(() => !server.app.relay.summary(room).inMatch);
    host.socket.send(JSON.stringify({ type: "phase", inMatch: true }));
    await until(() => server.app.relay.summary(room).inMatch);
    host.socket.close();
    await until(() => server.app.relay.summary(room).host === null);
    expect(server.app.relay.summary(room).inMatch).toBe(false);
  });

  it("lets the host say its running match takes players, until the match or the host goes", async () => {
    const room = newRoom();
    const host = await join(server.base, room, "host", "user-h", HOST, { name: "Chief" });
    await join(server.base, room, "guest", "user-a", GUEST_A);
    host.socket.send(JSON.stringify({ type: "phase", inMatch: true, joinable: true }));
    await until(() => server.app.relay.summary(room).joinable);
    expect(server.app.relay.summary(room)).toEqual({ host: "Chief", players: 2, spectators: 0, inMatch: true,
      joinable: true, watchable: false });
    host.socket.send(JSON.stringify({ type: "phase", inMatch: true, joinable: false }));
    await until(() => !server.app.relay.summary(room).joinable);
    expect(server.app.relay.summary(room).inMatch).toBe(true);
    /* (a lobby is not a running match, whatever joinable says) */
    host.socket.send(JSON.stringify({ type: "phase", inMatch: false, joinable: true }));
    await until(() => !server.app.relay.summary(room).inMatch);
    expect(server.app.relay.summary(room).joinable).toBe(false);
    host.socket.send(JSON.stringify({ type: "phase", inMatch: true, joinable: true }));
    await until(() => server.app.relay.summary(room).joinable);
    expect(server.logs.filter((entry) => entry.event === "phase").at(-1)).toMatchObject({ inMatch: true, joinable: true });
    host.socket.close();
    await until(() => server.app.relay.summary(room).host === null);
    expect(server.app.relay.summary(room)).toMatchObject({ inMatch: false, joinable: false });
  });

  it("says a full room's match takes nobody", async () => {
    const room = newRoom();
    const host = await join(server.base, room, "host", "user-h", HOST, { name: "Chief" });
    for (let index = 1; index < MAXIMUM_ROOM_SOCKETS; index++) {
      await join(server.base, room, "guest", `user-${index}`, (0x030000000000 + index).toString(16).padStart(12, "0"));
    }
    host.socket.send(JSON.stringify({ type: "phase", inMatch: true, joinable: true }));
    await until(() => server.app.relay.summary(room).inMatch);
    expect(server.app.relay.summary(room).joinable).toBe(false);
  });

  it("closes a guest's text and the host's malformed text", async () => {
    const room = newRoom();
    const host = await join(server.base, room, "host", "user-h", HOST);
    const guest = await join(server.base, room, "guest", "user-a", GUEST_A);
    guest.socket.send(JSON.stringify({ type: "phase", inMatch: true }));
    expect((await guest.closed).code).toBe(1003);
    expect(server.app.relay.summary(room).inMatch).toBe(false);
    host.socket.send(JSON.stringify({ type: "phase", inMatch: "yes" }));
    expect((await host.closed).code).toBe(1003);
    const another = await join(server.base, newRoom(), "host", "user-h2", HOST);
    another.socket.send(JSON.stringify({ type: "phase", inMatch: true, joinable: "yes" }));
    expect((await another.closed).code).toBe(1003);
  });
});

describe("routing", () => {
  it("forwards host to the named guest and guests to the host only, stamped with the sender", async () => {
    const room = newRoom();
    const host = await join(server.base, room, "host", "user-h", HOST);
    const a = await join(server.base, room, "guest", "user-a", GUEST_A);
    const b = await join(server.base, room, "guest", "user-b", GUEST_B);
    host.socket.send(frame(Channel.Reliable, GUEST_A, undefined, 1));
    await until(() => a.frames.length === 1);
    expect(sender(a.frames[0]!)).toBe(HOST);
    a.socket.send(frame(Channel.Unreliable, HOST, 12, 2));
    await until(() => host.frames.length === 1);
    expect(sender(host.frames[0]!)).toBe(GUEST_A);
    a.socket.send(frame(Channel.Reliable, GUEST_B, undefined, 3));
    a.socket.send(frame(Channel.Reliable, HOST, undefined, 4));
    await until(() => host.frames.length === 2);
    expect(sender(host.frames[1]!)).toBe(GUEST_A);
    expect(b.frames).toHaveLength(0);
  });

  it("routes each channel to the matching socket of a split peer", async () => {
    const room = newRoom();
    const host = await join(server.base, room, "host", "user-h", HOST);
    const reliable = await join(server.base, room, "guest", "user-a", GUEST_A, { ch: "r" });
    const unreliable = await join(server.base, room, "guest", "user-a", GUEST_A, { ch: "u" });
    host.socket.send(frame(Channel.Reliable, GUEST_A));
    host.socket.send(frame(Channel.Unreliable, GUEST_A));
    host.socket.send(frame(Channel.PingReliable, GUEST_A, 8));
    host.socket.send(frame(Channel.PingUnreliable, GUEST_A, 8));
    host.socket.send(frame(Channel.Ack, GUEST_A, 4));
    await until(() => reliable.frames.length === 3 && unreliable.frames.length === 2);
    expect(reliable.frames.map((bytes) => bytes[0])).toEqual([Channel.Reliable, Channel.PingReliable, Channel.Ack]);
    expect(unreliable.frames.map((bytes) => bytes[0])).toEqual([Channel.Unreliable, Channel.PingUnreliable]);
    unreliable.socket.send(frame(Channel.Reliable, HOST));
    expect((await unreliable.closed).code).toBe(1008);
  });

  it("echoes relay probes back to the sender", async () => {
    const host = await join(server.base, newRoom(), "host", "user-h", HOST);
    const probe = frame(Channel.RelayEcho, "000000000000", 8, 9);
    host.socket.send(probe);
    await until(() => host.frames.length === 1);
    expect([...host.frames[0]!]).toEqual([...probe]);
  });
});

describe("batches", () => {
  it("split per destination and arrive as one message per socket", async () => {
    const room = newRoom();
    const host = await join(server.base, room, "host", "user-h", HOST);
    const a = await join(server.base, room, "guest", "user-a", GUEST_A);
    const b = await join(server.base, room, "guest", "user-b", GUEST_B);
    const before = { a: a.messages, b: b.messages };
    host.socket.send(joinBatch([
      frame(Channel.Reliable, GUEST_A, undefined, 1),
      frame(Channel.Unreliable, GUEST_B, 12, 2),
      frame(Channel.Unreliable, GUEST_A, 12, 3),
      frame(Channel.Ack, GUEST_A, 4, 4),
      frame(Channel.RelayEcho, "000000000000", 8, 5),
    ]));
    await until(() => a.frames.length === 3 && b.frames.length === 1 && host.frames.length === 1);
    expect(a.frames.map((bytes) => bytes[7])).toEqual([1, 3, 4]);
    expect(a.frames.every((bytes) => sender(bytes) === HOST)).toBe(true);
    expect(a.messages - before.a).toBe(1);
    expect(b.messages - before.b).toBe(1);
  });

  it("close the socket when malformed", async () => {
    const room = newRoom();
    await join(server.base, room, "host", "user-h", HOST);
    const guest = await join(server.base, room, "guest", "user-a", GUEST_A);
    guest.socket.send(new Uint8Array([BATCH_MARKER, 0, 50, 1, 2, 3]));
    expect((await guest.closed).code).toBe(1008);
    const other = await join(server.base, room, "guest", "user-b", GUEST_B);
    other.socket.send(joinBatch([frame(Channel.Reliable, HOST), frame(9, HOST)]));
    expect((await other.closed).code).toBe(1008);
  });
});

describe("frame limits", () => {
  const cases: [string, string | Uint8Array, number][] = [
    ["text", "hello", 1003],
    ["too short for a header", new Uint8Array([0, 1, 2]), 1008],
    ["a Halo frame under 12 bytes", frame(Channel.Reliable, HOST, SEQUENCE_BYTES + 11), 1008],
    ["a reliable frame without its sequence header", frame(Channel.Reliable, HOST, 12), 1008],
    ["an acknowledgement of the wrong size", frame(Channel.Ack, HOST, 5), 1008],
    ["an unknown channel", frame(9, HOST), 1008],
    ["an oversized probe", frame(Channel.PingReliable, HOST, 65), 1008],
    ["a frame over the size cap", frame(Channel.Reliable, HOST, SEQUENCE_BYTES + MAXIMUM_HALO_FRAME_BYTES + 1), 1009],
    ["a message over the batch cap", new Uint8Array(70 * 1024), 1009],
  ];
  for (const [name, message, code] of cases) {
    it(`closes a socket that sends ${name}`, async () => {
      const room = newRoom();
      await join(server.base, room, "host", "user-h", HOST);
      const guest = await join(server.base, room, "guest", "user-a", GUEST_A);
      guest.socket.send(message);
      expect((await guest.closed).code).toBe(code);
    });
  }

  it("accepts a frame at the size cap", async () => {
    const room = newRoom();
    const host = await join(server.base, room, "host", "user-h", HOST);
    const guest = await join(server.base, room, "guest", "user-a", GUEST_A);
    guest.socket.send(frame(Channel.Reliable, HOST, SEQUENCE_BYTES + MAXIMUM_HALO_FRAME_BYTES));
    await until(() => host.frames.length === 1);
    expect(host.frames[0]!.byteLength).toBe(7 + SEQUENCE_BYTES + MAXIMUM_HALO_FRAME_BYTES);
  });
});

describe("heartbeat", () => {
  it("keeps answering sockets and drops ones that stop answering pings", async () => {
    await server.close();
    server = await start({}, 300, 40);
    const room = newRoom();
    const host = await join(server.base, room, "host", "user-h", HOST);
    const guest = await join(server.base, room, "guest", "user-a", GUEST_A);
    guest.socket.pause();
    await until(() => server.logs.some((entry) => entry.event === "close" && entry.id === GUEST_A), 1000);
    expect(server.logs.find((entry) => entry.event === "close" && entry.id === GUEST_A)).toMatchObject({ code: 1006 });
    await settle();
    expect(host.socket.readyState).toBe(host.socket.OPEN);
    expect(host.texts.some((text) => text.type === "peer-down" && text.id === GUEST_A)).toBe(true);
  });
});
