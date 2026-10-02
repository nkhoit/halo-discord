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
