/* The server as it runs (src/main.ts, in its own process): an error event
   nobody listens for ends a Node process, which a test inside this one
   would only report. */

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { connect, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { join, ORIGIN, SECRET, until } from "./harness.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

let child: ChildProcess;
let base: string;
let port: number;
let exit: number | null | undefined;

beforeEach(async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const directory = mkdtempSync(joinPath(tmpdir(), "halo-server-process-"));
  exit = undefined;
  child = spawn(process.execPath, [MAIN], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), PUBLIC_ORIGIN: base, BUILD_DIR: directory,
      EXTRA_ORIGINS: ORIGIN, MAPS_DIR: directory, TOKEN_SECRET: SECRET, DEV_LOGIN: "1", NODE_ENV: "development", DISCORD_CLIENT_ID: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.on("exit", (code) => { exit = code; });
  let output = "";
  child.stdout!.on("data", (data: Buffer) => { output += data; });
  child.stderr!.on("data", (data: Buffer) => { output += data; });
  await until(() => output.includes('"listening"') || exit !== undefined, 10_000);
  expect(exit, output).toBeUndefined();
});

afterEach(async () => {
  if (exit === undefined) {
    child.kill();
    await once(child, "exit");
  }
});

function upgrade(origin: string) {
  const socket = connect(port, "127.0.0.1");
  socket.on("error", () => {});
  socket.write(`GET /v1/rooms/abcdefghijklmnop/ws?role=host&ch=both HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
    "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
    `Sec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`);
  return socket;
}

async function stillServing(): Promise<void> {
  expect(exit).toBeUndefined();
  expect(await (await fetch(`${base}/healthz`)).text()).toBe("ok");
  const host = await join(base, "room-after-0001", "host", "user-h", "020000000001");
  host.socket.close();
}

describe("the server process", () => {
  it("survives an unmasked frame before authentication", async () => {
    const socket = upgrade(base);
    let received = "";
    socket.on("data", (data: Buffer) => { received += data.toString("latin1"); });
    await until(() => received.includes("\r\n\r\n"));
    expect(received).toMatch(/^HTTP\/1\.1 101 /);
    socket.write(Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]));
    await once(socket, "close");
    await stillServing();
  });

  it("survives clients that reset refused upgrades", async () => {
    for (let attempt = 0; attempt < 200; attempt++) upgrade("https://evil.example").resetAndDestroy();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await stillServing();
  });
});
