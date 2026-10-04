/* A WebSocket stand-in for driving Relay directly: the test sets its backlog,
   reads what the relay sent it, and feeds it messages. */
import { EventEmitter } from "node:events";

import type { WebSocket } from "ws";

import { BATCH_MARKER, splitBatch } from "../src/protocol.ts";
import type { Member, Relay } from "../src/relay.ts";

export class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];
  readonly texts: string[] = [];
  closedWith: number | null = null;
  terminated = false;

  send(data: string | Uint8Array): void {
    if (typeof data === "string") this.texts.push(data);
    else this.sent.push(data);
  }

  close(code: number): void {
    if (this.readyState !== 1) return;
    this.readyState = 2;
    this.closedWith = code;
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit("close", this.closedWith ?? 1006, Buffer.from(""));
  }

  /* what the relay forwarded, frame by frame */
  frames(): Uint8Array[] {
    return this.sent.flatMap((message) => message[0] === BATCH_MARKER ? splitBatch(message)! : [message]);
  }

  /* its JSON messages from the relay */
  json(): Record<string, unknown>[] {
    return this.texts.map((text) => JSON.parse(text) as Record<string, unknown>);
  }

  message(bytes: Uint8Array): void {
    this.emit("message", Buffer.from(bytes), true);
  }
}

export function joinFake(relay: Relay, roomId: string, member: Omit<Member, "since">, build = "web-1"): FakeSocket {
  const socket = new FakeSocket();
  relay.join(socket as unknown as WebSocket, roomId, member, build);
  return socket;
}
