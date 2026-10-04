/* The relay's backpressure, with sockets whose backlog the test sets: frames
   on the unreliable channels to a receiver past RELAY_DROP_BUFFERED_BYTES are
   dropped (reliable ones still go), a receiver past
   RELAY_CLOSE_BUFFERED_BYTES is closed, and every other member is served as
   before. */
import { describe, expect, it } from "vitest";

import { Channel, CloseCode, joinBatch } from "../src/protocol.ts";
import { RELAY_CLOSE_BUFFERED_BYTES, RELAY_DROP_BUFFERED_BYTES, Relay } from "../src/relay.ts";
import { FakeSocket, joinFake } from "./fake-socket.ts";
import { frame, sender } from "./harness.ts";

const HOST = "020000000001";
const GUEST_A = "020000000002";
const GUEST_B = "020000000003";

function room() {
  const logs: Record<string, unknown>[] = [];
  const relay = new Relay(10, (entry) => logs.push(entry));
  const join = (id: string, role: "host" | "guest", user: string) =>
    joinFake(relay, "room-backpressure", { user, name: user, id, role, kind: "both", spectator: false });
  const host = join(HOST, "host", "user-h");
  const guestA = join(GUEST_A, "guest", "user-a");
  const guestB = join(GUEST_B, "guest", "user-b");
  return { logs, host, guestA, guestB };
}

describe("relay backpressure", () => {
  it("drops frames on the unreliable channels to a receiver past the first mark, and only to it", () => {
    const { logs, host, guestA, guestB } = room();
    guestA.bufferedAmount = RELAY_DROP_BUFFERED_BYTES + 1;
    host.message(joinBatch([frame(Channel.Reliable, GUEST_A), frame(Channel.Unreliable, GUEST_A),
      frame(Channel.PingUnreliable, GUEST_A, 9), frame(Channel.Ack, GUEST_A, 4), frame(Channel.Unreliable, GUEST_B)]));
    expect(guestA.frames().map((bytes) => bytes[0])).toEqual([Channel.Reliable, Channel.Ack]);
    expect(guestA.frames().every((bytes) => sender(bytes) === HOST)).toBe(true);
    expect(guestB.frames().map((bytes) => bytes[0])).toEqual([Channel.Unreliable]);
    expect(guestA.closedWith).toBeNull();
    expect(logs.filter((entry) => entry.event === "backpressure")).toEqual([
      expect.objectContaining({ id: GUEST_A, dropping: true, buffered: RELAY_DROP_BUFFERED_BYTES + 1 })]);

    /* still behind: dropped again, logged once */
    host.message(frame(Channel.Unreliable, GUEST_A));
    expect(guestA.frames()).toHaveLength(2);
    expect(logs.filter((entry) => entry.event === "backpressure")).toHaveLength(1);

    /* caught up: it gets them again, and the log says what it lost */
    guestA.bufferedAmount = 0;
    host.message(frame(Channel.Unreliable, GUEST_A));
    expect(guestA.frames().map((bytes) => bytes[0])).toEqual([Channel.Reliable, Channel.Ack, Channel.Unreliable]);
    expect(logs.filter((entry) => entry.event === "backpressure").at(-1)).toEqual(
      expect.objectContaining({ id: GUEST_A, dropping: false, droppedFrames: 3 }));
  });

  it("drops a message that was only unreliable frames without sending an empty one", () => {
    const { host, guestA } = room();
    guestA.bufferedAmount = RELAY_DROP_BUFFERED_BYTES + 1;
    host.message(joinBatch([frame(Channel.Unreliable, GUEST_A), frame(Channel.PongUnreliable, GUEST_A, 9)]));
    expect(guestA.sent).toHaveLength(0);
  });

  it("closes a receiver past the second mark, counts it, and keeps serving the others", () => {
    const { logs, host, guestA, guestB } = room();
    guestA.bufferedAmount = RELAY_DROP_BUFFERED_BYTES + 1;
    host.message(frame(Channel.Unreliable, GUEST_A));
    guestA.bufferedAmount = RELAY_CLOSE_BUFFERED_BYTES + 1;
    host.message(frame(Channel.Reliable, GUEST_A));
    expect(guestA.closedWith).toBe(CloseCode.Backlogged);
    expect(guestA.terminated).toBe(true);
    expect(guestA.frames()).toHaveLength(0);
    expect(logs).toContainEqual(expect.objectContaining({ event: "backlogged", id: GUEST_A,
      buffered: RELAY_CLOSE_BUFFERED_BYTES + 1, droppedFrames: 1 }));
    expect(logs).toContainEqual(expect.objectContaining({ event: "close", id: GUEST_A, droppedFrames: 1,
      roomDroppedFrames: 1, roomBacklogCloses: 1 }));
    /* the host hears it left, and the other guest is unaffected */
    expect(host.texts.map((text) => JSON.parse(text))).toContainEqual({ type: "peer-down", id: GUEST_A });
    host.message(frame(Channel.Reliable, GUEST_B));
    expect(guestB.frames().map((bytes) => bytes[0])).toEqual([Channel.Reliable]);
    expect(guestB.closedWith).toBeNull();
  });

  it("closes a receiver that a send itself puts past the second mark", () => {
    const { host, guestA } = room();
    guestA.send = function (this: FakeSocket, data: string | Uint8Array) {
      if (typeof data !== "string") this.sent.push(data);
      this.bufferedAmount = RELAY_CLOSE_BUFFERED_BYTES + 100;
    };
    host.message(frame(Channel.Reliable, GUEST_A));
    expect(guestA.sent).toHaveLength(1);
    expect(guestA.closedWith).toBe(CloseCode.Backlogged);
  });

  it("applies to the host as a receiver too", () => {
    const { logs, host, guestA } = room();
    host.bufferedAmount = RELAY_DROP_BUFFERED_BYTES + 1;
    guestA.message(joinBatch([frame(Channel.Unreliable, HOST), frame(Channel.Reliable, HOST)]));
    expect(host.frames().map((bytes) => bytes[0])).toEqual([Channel.Reliable]);
    expect(logs).toContainEqual(expect.objectContaining({ event: "backpressure", id: HOST, dropping: true }));
  });
});
