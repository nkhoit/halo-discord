/* Relay protocol 2's multicast (protocol.ts): the host's one frame for many
   guests reaches exactly the guests it names, each as an ordinary frame from
   the host with its own sequence, never the sender or a guest that took a
   slot after the frame's recipient left; a malformed one closes the host's
   socket; and a room never mixes protocols. */
import { describe, expect, it } from "vitest";

import {
  Channel,
  CloseCode,
  joinBatch,
  MAXIMUM_HALO_FRAME_BYTES,
  MAXIMUM_MULTICAST_FRAME_BYTES,
  MAXIMUM_SLOTS,
  SEQUENCE_BYTES,
} from "../src/protocol.ts";
import { type Member, Relay } from "../src/relay.ts";
import { type FakeSocket, joinFake } from "./fake-socket.ts";
import { sender } from "./harness.ts";

const HOST = "020000000001";
const ids = (index: number) => `0200000001${index.toString(16).padStart(2, "0")}`;

type Entry = [slot: number, generation: number, sequence?: number];

function multicast(reliable: boolean, entries: Entry[], payloadBytes = 12, marker = 0x48): Uint8Array {
  const entryBytes = reliable ? 6 : 2;
  const bytes = new Uint8Array(3 + entries.length * entryBytes + payloadBytes);
  const view = new DataView(bytes.buffer);
  bytes[0] = Channel.Multicast;
  bytes[1] = reliable ? Channel.Reliable : Channel.Unreliable;
  bytes[2] = entries.length;
  entries.forEach(([slot, generation, sequence], index) => {
    const offset = 3 + index * entryBytes;
    bytes[offset] = slot;
    bytes[offset + 1] = generation;
    if (reliable) view.setUint32(offset + 2, sequence ?? 0);
  });
  bytes[3 + entries.length * entryBytes] = marker;
  return bytes;
}

function setup(protocol = 2) {
  const logs: Record<string, unknown>[] = [];
  const relay = new Relay(10, (entry) => logs.push(entry));
  const roomId = `room-multicast-${Math.random().toString(36).slice(2)}`;
  const join = (id: string, role: "host" | "guest", options: Partial<Member> = {}) =>
    joinFake(relay, roomId, { user: `user-${id}`, name: `name-${id}`, id, role, kind: "both", spectator: false,
      protocol, ...options });
  const host = join(HOST, "host");
  /* [slot, generation] the host was told for a guest */
  const slotOf = (id: string): [number, number] => {
    for (const message of host.json()) {
      if (message.type === "peer-up" && message.id === id) return [message.slot as number, message.generation as number];
    }
    throw new Error(`no peer-up for ${id}`);
  };
  return { relay, logs, join, host, slotOf };
}

const payloadOf = (bytes: Uint8Array, reliable: boolean) => bytes.subarray(7 + (reliable ? SEQUENCE_BYTES : 0));

describe("relay protocol 2 multicast", () => {
  it("gives each identity a slot and tells counterparts, in protocol 2 rooms only", () => {
    const { join, host, slotOf } = setup();
    const ready = host.json()[0]!;
    expect(ready).toMatchObject({ type: "ready", self: { id: HOST, slot: 0, generation: 1 }, peers: [], slots: {} });
    const guest = join(ids(1), "guest");
    expect(slotOf(ids(1))).toEqual([1, 1]);
    expect(guest.json()[0]).toMatchObject({ type: "ready", self: { slot: 1, generation: 1 }, slots: { [HOST]: [0, 1] } });

    const v1 = setup(1);
    v1.join(ids(1), "guest");
    expect(v1.host.json()[0]).toEqual({ type: "ready", self: { id: HOST, role: "host", kind: "both", name: `name-${HOST}` },
      peers: [], names: {} });
    expect(v1.host.json()[1]).toEqual({ type: "peer-up", id: ids(1), name: `name-${ids(1)}` });
  });

  it("delivers an unreliable multicast to the guests it names, spectators too, and never the sender", () => {
    const { join, host, slotOf } = setup();
    const a = join(ids(1), "guest");
    const b = join(ids(2), "guest");
    const watcher = join(ids(3), "guest", { spectator: true });
    const other = join(ids(4), "guest");
    host.message(multicast(false, [slotOf(ids(1)), slotOf(ids(2)), slotOf(ids(3)), [0, 1]], 40, 0x5a));
    for (const guest of [a, b, watcher]) {
      const frames = guest.frames();
      expect(frames).toHaveLength(1);
      expect(frames[0]![0]).toBe(Channel.Unreliable);
      expect(sender(frames[0]!)).toBe(HOST);
      expect(payloadOf(frames[0]!, false)).toHaveLength(40);
      expect(payloadOf(frames[0]!, false)[0]).toBe(0x5a);
    }
    expect(other.frames()).toHaveLength(0);
    expect(host.frames()).toHaveLength(0);
  });

  it("gives each recipient of a reliable multicast its own sequence, and no acknowledgement", () => {
    const { join, host, slotOf } = setup();
    const a = join(ids(1), "guest");
    const b = join(ids(2), "guest");
    host.message(multicast(true, [[...slotOf(ids(1)), 5], [...slotOf(ids(2)), 0x01020304]], 20));
    const [fromA, fromB] = [a.frames()[0]!, b.frames()[0]!];
    for (const [frame, sequence] of [[fromA, 5], [fromB, 0x01020304]] as const) {
      const view = new DataView(frame.buffer, frame.byteOffset);
      expect(frame[0]).toBe(Channel.Reliable);
      expect(sender(frame)).toBe(HOST);
      expect(view.getUint32(7)).toBe(sequence);
      expect(view.getUint32(11)).toBe(0);
      expect(frame.byteLength).toBe(7 + SEQUENCE_BYTES + 20);
    }
  });

  it("keeps unicast and multicast frames to a guest in the order the host sent them", () => {
    const { join, host, slotOf } = setup();
    const a = join(ids(1), "guest");
    const unicast = new Uint8Array(7 + SEQUENCE_BYTES + 12);
    unicast[0] = Channel.Reliable;
    unicast.set([2, 0, 0, 0, 1, 1], 1);
    new DataView(unicast.buffer).setUint32(7, 1);
    const second = multicast(true, [[...slotOf(ids(1)), 2]]);
    const third = unicast.slice();
    new DataView(third.buffer).setUint32(7, 3);
    host.message(joinBatch([unicast, second, third]));
    expect(a.frames().map((frame) => new DataView(frame.buffer, frame.byteOffset).getUint32(7))).toEqual([1, 2, 3]);
  });

  it("reaches nobody through a slot whose holder left, even once someone else holds it", () => {
    const { relay, join, host, slotOf } = setup();
    const a = join(ids(1), "guest");
    const old = slotOf(ids(1));
    a.terminate();
    expect(host.json().at(-1)).toEqual({ type: "peer-down", id: ids(1) });
    host.message(multicast(false, [old]));

    /* the same identity back: another slot, so the old entry still misses it */
    const back = join(ids(1), "guest");
    const backSlot = host.json().filter((message) => message.type === "peer-up" && message.id === ids(1)).at(-1)!;
    expect(backSlot.slot).not.toBe(old[0]);
    host.message(multicast(false, [old]));
    expect(back.frames()).toHaveLength(0);
    back.terminate();

    /* guests come and go until one is handed the old slot: a new generation */
    let holder: FakeSocket | null = null;
    let holderId = "";
    for (let index = 10; index < 10 + 3 * MAXIMUM_SLOTS && !holder; index++) {
      const guest = join(ids(index), "guest");
      if (slotOf(ids(index))[0] === old[0]) {
        holder = guest;
        holderId = ids(index);
      } else {
        guest.terminate();
      }
    }
    expect(holder).not.toBeNull();
    const now = slotOf(holderId);
    expect(now[1]).not.toBe(old[1]);
    host.message(multicast(false, [old]));
    expect(holder!.frames()).toHaveLength(0);
    host.message(multicast(false, [now]));
    expect(holder!.frames()).toHaveLength(1);
    expect(relay.rooms.size).toBe(1);
  });

  it("keeps a reconnecting identity's slot while it is still in the room", () => {
    const { join, host, slotOf } = setup();
    join(ids(1), "guest");
    const before = slotOf(ids(1));
    const replacement = join(ids(1), "guest");
    expect(replacement.json()[0]).toMatchObject({ self: { slot: before[0], generation: before[1] } });
    host.message(multicast(false, [before]));
    expect(replacement.frames()).toHaveLength(1);
  });

  it("sends a guest's reliable and unreliable copies to the sockets that carry them", () => {
    const { join, host, slotOf } = setup();
    const reliable = join(ids(1), "guest", { kind: "reliable" });
    const unreliable = join(ids(1), "guest", { kind: "unreliable" });
    host.message(multicast(true, [[...slotOf(ids(1)), 1]]));
    host.message(multicast(false, [slotOf(ids(1))]));
    expect(reliable.frames().map((frame) => frame[0])).toEqual([Channel.Reliable]);
    expect(unreliable.frames().map((frame) => frame[0])).toEqual([Channel.Unreliable]);
  });

  it("closes the host's socket for a malformed or oversize multicast", () => {
    const cases: [string, (slot: Entry) => Uint8Array, number][] = [
      ["no recipients", () => multicast(false, []), CloseCode.PolicyViolation],
      ["a slot named twice", (slot) => multicast(false, [slot, slot]), CloseCode.PolicyViolation],
      ["a slot out of range", () => multicast(false, [[MAXIMUM_SLOTS, 1]]), CloseCode.PolicyViolation],
      ["more recipients than slots", () => multicast(false,
        Array.from({ length: MAXIMUM_SLOTS + 1 }, (_, index) => [index % 256, 1] as Entry)), CloseCode.PolicyViolation],
      ["entries past the end", () => {
        const bytes = multicast(true, [[1, 1, 1]], 0);
        bytes[2] = 3;
        return bytes;
      }, CloseCode.PolicyViolation],
      ["an inner channel that is not reliable or unreliable", (slot) => {
        const bytes = multicast(false, [slot]);
        bytes[1] = Channel.Ack;
        return bytes;
      }, CloseCode.PolicyViolation],
      ["a payload too short", (slot) => multicast(false, [slot], 11), CloseCode.PolicyViolation],
      ["a payload too long", (slot) => multicast(false, [slot], MAXIMUM_HALO_FRAME_BYTES + 1), CloseCode.PolicyViolation],
      ["a frame past the multicast limit", () => new Uint8Array(MAXIMUM_MULTICAST_FRAME_BYTES + 1).fill(Channel.Multicast, 0, 1),
        CloseCode.MessageTooBig],
    ];
    for (const [what, build, code] of cases) {
      const { join, host, slotOf } = setup();
      const guest = join(ids(1), "guest");
      host.message(build(slotOf(ids(1))));
      expect(host.closedWith, what).toBe(code);
      expect(guest.frames(), what).toHaveLength(0);
    }
  });

  it("takes multicasts from a protocol 2 room's host only", () => {
    const { join, host, slotOf } = setup();
    const guest = join(ids(1), "guest");
    const other = join(ids(2), "guest");
    guest.message(multicast(false, [slotOf(ids(2)), [0, 1]]));
    expect(guest.closedWith).toBe(CloseCode.PolicyViolation);
    expect(other.frames()).toHaveLength(0);
    expect(host.frames()).toHaveLength(0);

    const v1 = setup(1);
    v1.join(ids(1), "guest");
    v1.host.message(multicast(false, [[1, 1]]));
    expect(v1.host.closedWith).toBe(CloseCode.PolicyViolation);
  });

  it("never mixes protocols in a room", () => {
    const { logs, join } = setup(2);
    const old = join(ids(1), "guest", { protocol: 1 });
    expect(old.closedWith).toBe(CloseCode.Refused);
    expect(logs).toContainEqual(expect.objectContaining({ event: "refuse", reason: "protocol mismatch" }));

    const v1 = setup(1);
    expect(v1.join(ids(1), "guest", { protocol: 2 }).closedWith).toBe(CloseCode.Refused);
  });
});
