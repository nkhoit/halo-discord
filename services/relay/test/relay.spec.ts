import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { Channel, MAXIMUM_HALO_FRAME_BYTES, MAXIMUM_ROOM_SOCKETS } from "../src/protocol";

const ORIGIN = "http://127.0.0.1:8765";
const HOST = "020000000001";
const GUEST_A = "020000000002";
const GUEST_B = "020000000003";

let roomCounter = 0;
function newRoom(): string {
  roomCounter++;
  return `room-${roomCounter}-${crypto.randomUUID()}`;
}

interface Client {
  socket: WebSocket;
  texts: Record<string, unknown>[];
  frames: Uint8Array[];
  closed: Promise<CloseEvent>;
}

function upgrade(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(new Request(`http://relay.test${path}`, {
    headers: { Origin: ORIGIN, Upgrade: "websocket", ...headers },
  }));
}

async function connect(room: string, role: string, id: string, ch = "both"): Promise<Client> {
  const response = await upgrade(`/v1/rooms/${room}/ws?role=${role}&id=${id}&ch=${ch}`);
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("Upgrade did not return a WebSocket.");
  const client: Client = {
    socket,
    texts: [],
    frames: [],
    closed: new Promise((resolve) => socket.addEventListener("close", resolve)),
  };
  let chain = Promise.resolve();
  socket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data === "string") client.texts.push(JSON.parse(event.data));
    else {
      /* The test runtime's client sockets deliver binary data as Blobs. */
      const data = event.data as Blob | ArrayBuffer;
      chain = chain.then(async () => {
        client.frames.push(new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data));
      });
    }
  });
  socket.accept();
  await until(() => client.texts.some((text) => text.type === "ready"));
  return client;
}

async function until(condition: () => boolean, milliseconds = 2_000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100));

function frame(channel: number, id: string, payloadBytes = 12, marker = 0x48): Uint8Array {
  const bytes = new Uint8Array(7 + payloadBytes);
  bytes[0] = channel;
  for (let index = 0; index < 6; index++) {
    bytes[1 + index] = parseInt(id.slice(index * 2, index * 2 + 2), 16);
  }
  bytes[7] = marker;
  return bytes;
}

function sender(bytes: Uint8Array): string {
  return [...bytes.subarray(1, 7)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("relay admission", () => {
  it("answers health checks", async () => {
    const response = await exports.default.fetch("http://relay.test/v1/health");
    expect(response.status).toBe(200);
  });

  it("rejects bad paths, upgrades, origins and parameters", async () => {
    const room = newRoom();
    const ok = `?role=host&id=${HOST}`;
    expect((await upgrade(`/v1/rooms/a/ws${ok}`)).status).toBe(400);
    expect((await upgrade(`/v1/rooms/${room}/other${ok}`)).status).toBe(404);
    expect((await exports.default.fetch(`http://relay.test/v1/rooms/${room}/ws${ok}`)).status)
      .toBe(426);
    expect((await upgrade(`/v1/rooms/${room}/ws${ok}`, { Origin: "https://evil.example" })).status)
      .toBe(403);
    const noOrigin = await exports.default.fetch(new Request(
      `http://relay.test/v1/rooms/${room}/ws${ok}`, { headers: { Upgrade: "websocket" } }));
    expect(noOrigin.status).toBe(403);
    expect((await upgrade(`/v1/rooms/${room}/ws?role=admin&id=${HOST}`)).status).toBe(400);
    expect((await upgrade(`/v1/rooms/${room}/ws?role=host&id=XYZ`)).status).toBe(400);
    expect((await upgrade(`/v1/rooms/${room}/ws?role=host&id=${HOST}&ch=x`)).status).toBe(400);
  });

  it("allows one host, unique identifiers and no duplicate sockets", async () => {
    const room = newRoom();
    await connect(room, "host", HOST);
    const path = (role: string, id: string, ch = "both") =>
      `/v1/rooms/${room}/ws?role=${role}&id=${id}&ch=${ch}`;
    expect((await upgrade(path("host", GUEST_A))).status).toBe(409);
    expect((await upgrade(path("guest", HOST))).status).toBe(409);
    expect((await upgrade(path("host", HOST, "r"))).status).toBe(409);
    await connect(room, "guest", GUEST_A, "r");
    await connect(room, "guest", GUEST_A, "u");
    expect((await upgrade(path("guest", GUEST_A, "u"))).status).toBe(409);
  });

  it("caps sockets per room", async () => {
    const room = newRoom();
    await connect(room, "host", HOST);
    for (let index = 1; index < MAXIMUM_ROOM_SOCKETS; index++) {
      await connect(room, "guest", (0x030000000000 + index).toString(16).padStart(12, "0"));
    }
    const response = await upgrade(`/v1/rooms/${room}/ws?role=guest&id=040000000000`);
    expect(response.status).toBe(409);
    expect(await response.text()).toBe("room full");
  });
  it("reports the data centers from the Worker, not from the client", async () => {
    const room = newRoom();
    const response = await upgrade(`/v1/rooms/${room}/ws?role=host&id=${HOST}`, { "X-Relay-Colo": "FAKE" });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    const ready = new Promise<Record<string, unknown>>((resolve) =>
      socket.addEventListener("message", (event: MessageEvent) => resolve(JSON.parse(event.data as string))));
    socket.accept();
    const colo = (await ready).colo as { edge: string; room: string };
    expect(colo.edge).not.toBe("FAKE");
    expect(typeof colo.room).toBe("string");
  });
});

describe("relay membership", () => {
  it("tells guests about the host and the host about guests", async () => {
    const room = newRoom();
    const host = await connect(room, "host", HOST);
    const guest = await connect(room, "guest", GUEST_A);
    expect(guest.texts[0]).toMatchObject({ type: "ready", peers: [HOST] });
    await until(() => host.texts.some((text) => text.type === "peer-up"));
    expect(host.texts.find((text) => text.type === "peer-up")).toEqual({ type: "peer-up", id: GUEST_A });

    const other = await connect(room, "guest", GUEST_B);
    expect(other.texts[0]).toMatchObject({ peers: [HOST] });
    await settle();
    expect(guest.texts.some((text) => text.id === GUEST_B)).toBe(false);

    guest.socket.close(1000, "bye");
    await until(() => host.texts.some((text) => text.type === "peer-down"));
    expect(host.texts.find((text) => text.type === "peer-down")).toEqual({ type: "peer-down", id: GUEST_A });
  });
});

describe("relay routing", () => {
  it("forwards host to the named guest and guests to the host only", async () => {
    const room = newRoom();
    const host = await connect(room, "host", HOST);
    const a = await connect(room, "guest", GUEST_A);
    const b = await connect(room, "guest", GUEST_B);

    host.socket.send(frame(Channel.Reliable, GUEST_A, 12, 1));
    await until(() => a.frames.length === 1);
    expect(sender(a.frames[0]!)).toBe(HOST);
    expect(a.frames[0]![7]).toBe(1);

    a.socket.send(frame(Channel.Unreliable, HOST, 12, 2));
    await until(() => host.frames.length === 1);
    expect(sender(host.frames[0]!)).toBe(GUEST_A);

    a.socket.send(frame(Channel.Reliable, GUEST_B, 12, 3));
    await settle();
    expect(b.frames).toHaveLength(0);
  });

  it("stamps the sender's identity, so a guest cannot speak for another", async () => {
    const room = newRoom();
    const host = await connect(room, "host", HOST);
    const a = await connect(room, "guest", GUEST_A);
    await connect(room, "guest", GUEST_B);

    const forged = frame(Channel.Reliable, HOST);
    a.socket.send(forged);
    await until(() => host.frames.length === 1);
    expect(sender(host.frames[0]!)).toBe(GUEST_A);
  });

  it("drops frames for peers that are not in the room", async () => {
    const room = newRoom();
    const host = await connect(room, "host", HOST);
    host.socket.send(frame(Channel.Reliable, GUEST_A));
    await settle();
    expect(host.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("routes each channel to the matching socket of a split peer", async () => {
    const room = newRoom();
    const host = await connect(room, "host", HOST);
    const reliable = await connect(room, "guest", GUEST_A, "r");
    const unreliable = await connect(room, "guest", GUEST_A, "u");

    host.socket.send(frame(Channel.Reliable, GUEST_A, 12, 1));
    host.socket.send(frame(Channel.Unreliable, GUEST_A, 12, 2));
    host.socket.send(frame(Channel.PingReliable, GUEST_A, 8, 3));
    host.socket.send(frame(Channel.PingUnreliable, GUEST_A, 8, 4));
    await until(() => reliable.frames.length === 2 && unreliable.frames.length === 2);
    expect(reliable.frames.map((bytes) => bytes[0])).toEqual([Channel.Reliable, Channel.PingReliable]);
    expect(unreliable.frames.map((bytes) => bytes[0])).toEqual([Channel.Unreliable, Channel.PingUnreliable]);

    unreliable.socket.send(frame(Channel.Reliable, HOST));
    expect((await unreliable.closed).code).toBe(1008);
  });

  it("echoes relay probes back to the sender", async () => {
    const room = newRoom();
    const host = await connect(room, "host", HOST);
    const probe = frame(Channel.RelayEcho, "000000000000", 8, 9);
    host.socket.send(probe);
    await until(() => host.frames.length === 1);
    expect([...host.frames[0]!]).toEqual([...probe]);
  });
});

describe("relay frame limits", () => {
  const cases: [string, string | Uint8Array, number][] = [
    ["text", "hello", 1003],
    ["too short for a header", new Uint8Array([0, 1, 2]), 1008],
    ["a Halo frame under 12 bytes", frame(Channel.Reliable, HOST, 11), 1008],
    ["an unknown channel", frame(9, HOST), 1008],
    ["an oversized probe", frame(Channel.PingReliable, HOST, 65), 1008],
    ["a frame over the size cap", frame(Channel.Reliable, HOST, MAXIMUM_HALO_FRAME_BYTES + 1), 1009],
  ];
  for (const [name, message, code] of cases) {
    it(`closes a socket that sends ${name}`, async () => {
      const room = newRoom();
      await connect(room, "host", HOST);
      const guest = await connect(room, "guest", GUEST_A);
      guest.socket.send(message);
      expect((await guest.closed).code).toBe(code);
    });
  }

  it("accepts a frame at the size cap", async () => {
    const room = newRoom();
    const host = await connect(room, "host", HOST);
    const guest = await connect(room, "guest", GUEST_A);
    guest.socket.send(frame(Channel.Reliable, HOST, MAXIMUM_HALO_FRAME_BYTES));
    await until(() => host.frames.length === 1);
    expect(host.frames[0]!.byteLength).toBe(7 + MAXIMUM_HALO_FRAME_BYTES);
  });
});
