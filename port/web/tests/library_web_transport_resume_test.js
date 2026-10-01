'use strict';

/* End-to-end resume through the WebSocket relay: two independent copies of
   the transport (host and guest, each in its own realm with its own Wasm
   stand-in) talk through an in-memory relay that mirrors services/relay.
   Frames wait "in flight" inside the relay, so dropping a socket or
   restarting the relay really loses them; the reliable stream must still
   arrive exactly once and in order. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'library_web_transport.js'), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const HOST = '0a0000000001';
const GUEST = '0a0000000002';
const idBytes = text => Array.from({ length: 6 }, (_, i) => parseInt(text.slice(i * 2, i * 2 + 2), 16));
const idText = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

class FakeRelay {
  constructor() { this.sockets = new Set(); this.inFlight = []; this.refuse = false; }
  members() { return [...this.sockets].filter(s => s.readyState === 1); }
  carries(kind, reliable) { return kind === 'both' || kind === (reliable ? 'r' : 'u'); }
  connect(socket) {
    if (this.refuse) { setTimeout(() => socket.serverClose(1006), 0); return; }
    for (const other of this.members()) {
      if (other.id === socket.id && (other.kind === 'both' || socket.kind === 'both' || other.kind === socket.kind)) {
        this.sockets.delete(other);
        other.serverClose(4000);
      }
    }
    this.sockets.add(socket);
    setTimeout(() => {
      socket.readyState = 1;
      socket.onopen();
      const peers = [...new Set(this.members().filter(m => m.id !== socket.id && m.role !== socket.role &&
        this.carries(m.kind, true)).map(m => m.id))];
      socket.deliverText({ type: 'ready', self: { id: socket.id }, peers });
      if (this.carries(socket.kind, true)) {
        for (const m of this.members()) {
          if (m.id !== socket.id && m.role !== socket.role && this.carries(m.kind, true)) {
            m.deliverText({ type: 'peer-up', id: socket.id });
          }
        }
      }
    }, 5);
  }
  receive(from, bytes) {
    const channel = bytes[0];
    if (channel === 6) { this.inFlight.push({ to: from, bytes }); return; }
    const reliable = channel === 0 || channel === 2 || channel === 3 || channel === 7;
    const target = this.members().find(m => m.id === idText(bytes.subarray(1, 7)) &&
      m.role !== from.role && this.carries(m.kind, reliable));
    if (!target) return;
    const forwarded = bytes.slice();
    forwarded.set(idBytes(from.id), 1);
    this.inFlight.push({ to: target, bytes: forwarded });
  }
  /* Delivers everything in flight to sockets that are still open. */
  flush() {
    const queue = this.inFlight;
    this.inFlight = [];
    for (const { to, bytes } of queue) if (to.readyState === 1 && this.sockets.has(to)) to.deliver(bytes);
  }
  drop(id) {
    this.inFlight = this.inFlight.filter(({ to }) => to.id !== id);
    for (const socket of this.members()) if (socket.id === id) this.leave(socket, 1006);
  }
  restart() {
    this.inFlight = [];
    for (const socket of this.members()) { this.sockets.delete(socket); socket.serverClose(1012); }
  }
  leave(socket, code) {
    this.sockets.delete(socket);
    socket.serverClose(code);
    if (this.carries(socket.kind, true) && !this.members().some(m => m.id === socket.id && this.carries(m.kind, true))) {
      for (const m of this.members()) if (m.role !== socket.role) m.deliverText({ type: 'peer-down', id: socket.id });
    }
  }
}

function makeClient(relay, name, self, role, peer) {
  const delivered = { reliable: [], unreliable: [] };
  const states = [];
  const context = vm.createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval, MessageChannel, URL, URLSearchParams,
    performance,
  });
  context.window = context;
  context.addToLibrary = value => { context.library = value; };
  vm.runInContext(source, context);
  const realm = vm.runInContext('({ Uint8Array, ArrayBuffer })', context);
  class FakeWebSocket {
    constructor(url) {
      const parsed = new URL(url);
      this.role = parsed.searchParams.get('role');
      this.id = parsed.searchParams.get('id');
      this.kind = parsed.searchParams.get('ch') === 'both' ? 'both' : parsed.searchParams.get('ch');
      this.readyState = 0;
      this.bufferedAmount = 0;
      relay.connect(this);
    }
    send(value) {
      if (this.readyState !== 1) throw new Error('not open');
      relay.receive(this, Uint8Array.from(value));
    }
    close() { if (this.readyState < 2) relay.leave(this, 1000); }
    serverClose(code) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (this.onclose) this.onclose({ code });
    }
    deliver(bytes) {
      const copy = new realm.Uint8Array(bytes.length);
      copy.set(bytes);
      this.onmessage({ data: copy.buffer });
    }
    deliverText(value) { if (this.readyState === 1) this.onmessage({ data: JSON.stringify(value) }); }
  }
  context.WebSocket = FakeWebSocket;
  context.HEAPU8 = new Uint8Array(65536);
  context.HEAPU8.set(idBytes(self), 32);
  context.Module = {
    _web_net_remote_local_identifier: () => 32,
    _web_net_remote_ingress_buffer: () => 64,
    _web_net_remote_ingress_capacity: () => 16396,
    _web_net_remote_add_peer: () => 0x01004064,
    _web_net_remote_remove_peer: () => 1,
    _web_net_remote_set_peer_state: (address, connected, reliable, unreliable) => {
      states.push(`${connected}${reliable}${unreliable}`);
      return 1;
    },
    _web_net_remote_receive: (address, length) => {
      const frame = context.HEAPU8.slice(64, 64 + length);
      const marker = new DataView(frame.buffer).getUint32(4);
      (frame[2] === 1 ? delivered.unreliable : delivered.reliable).push(marker);
      return 1;
    },
  };
  const runtime = context.library.$HaloWebTransportRuntime;
  context.HaloWebTransportRuntime = runtime;
  runtime.install();
  const api = context.HaloWebTransport;
  api.configure({
    transport: 'relay',
    relay: { url: 'https://relay.test', sockets: 1, roomId: 'room-1', role },
    onSignal() { throw new Error('relay peers must not signal'); },
    onStateChange: event => states.push(event.state),
    onError() {},
  });
  const markers = { reliable: 0, unreliable: 0 };
  /* What the game would send: reliable stream data or a datagram. */
  const send = reliable => {
    const frame = new Uint8Array(16);
    frame[0] = 0x48;
    frame[1] = 1;
    frame[2] = reliable ? 3 : 1;
    new DataView(frame.buffer).setUint32(4, ++markers[reliable ? 'reliable' : 'unreliable']);
    context.HEAPU8.set(frame, 512);
    return context.library.web_transport_send(0x01004064, reliable ? 1 : 0, 512, 16);
  };
  return {
    name, runtime, api, delivered, states, send,
    add: () => api.addPeer({ peerId: name + '-peer', remoteIdentifier: peer, initiator: role === 'host' }),
    close: () => { api.disconnectAll(); if (runtime.pumpChannel) runtime.pumpChannel.port1.close(); },
  };
}

const exactlyOnceInOrder = (list, count, label) =>
  assert.deepEqual(list, Array.from({ length: count }, (_, i) => i + 1), label);

async function pump(relay, times = 6) {
  for (let i = 0; i < times; i++) { relay.flush(); await sleep(15); }
}

(async () => {
  const relay = new FakeRelay();
  const host = makeClient(relay, 'host', HOST, 'host', GUEST);
  const guest = makeClient(relay, 'guest', GUEST, 'guest', HOST);
  try {
    await host.add();
    await guest.add();
    await sleep(30);
    await pump(relay);
    assert(host.states.includes('connected') && guest.states.includes('connected'));

    /* Steady traffic both ways. */
    for (let i = 0; i < 40; i++) { assert.equal(host.send(true), 1); assert.equal(guest.send(true), 1); }
    await pump(relay);
    exactlyOnceInOrder(guest.delivered.reliable, 40, 'guest receives the host stream');
    exactlyOnceInOrder(host.delivered.reliable, 40, 'host receives the guest stream');

    /* Guest socket drops with frames in flight both ways; both keep sending. */
    for (let i = 0; i < 10; i++) { host.send(true); guest.send(true); }
    const statesBeforeDrop = guest.states.length;
    relay.drop(GUEST);
    for (let i = 0; i < 10; i++) {
      assert.equal(host.send(true), 1);
      assert.equal(guest.send(true), 1, 'reliable sends are buffered during an outage');
      assert.equal(guest.send(false), 1, 'datagrams are dropped, not refused');
    }
    const duringOutage = () => guest.states.slice(statesBeforeDrop);
    assert(!duringOutage().some(s => s === 'failed' || s.startsWith('0')),
      'the game never sees the guest disconnect');
    await sleep(400);
    await pump(relay, 10);
    assert(!duringOutage().some(s => s === 'failed' || s.startsWith('0')),
      'nor while it reconnects');
    exactlyOnceInOrder(guest.delivered.reliable, 60, 'guest stream survives a guest drop');
    exactlyOnceInOrder(host.delivered.reliable, 60, 'host stream survives a guest drop');
    assert.equal(guest.runtime.relay.reconnects, 1);
    assert(guest.runtime.relayPeers.get(HOST).staleDatagrams >= 10);

    /* Host socket drops the same way. */
    for (let i = 0; i < 10; i++) { host.send(true); guest.send(true); }
    relay.drop(HOST);
    for (let i = 0; i < 10; i++) { host.send(true); guest.send(true); }
    await sleep(400);
    await pump(relay, 10);
    exactlyOnceInOrder(guest.delivered.reliable, 80, 'guest stream survives a host drop');
    exactlyOnceInOrder(host.delivered.reliable, 80, 'host stream survives a host drop');

    /* Delivered, but the acknowledgement dies with the sender's socket: the
       replay repeats frames the receiver already has. */
    for (let i = 0; i < 10; i++) host.send(true);
    relay.flush();
    await sleep(5);
    assert.equal(guest.delivered.reliable.length, 90);
    relay.drop(HOST);
    await sleep(400);
    await pump(relay, 10);
    exactlyOnceInOrder(guest.delivered.reliable, 90, 'repeated frames are delivered once');
    assert(guest.runtime.relayPeers.get(HOST).duplicateFrames >= 10, 'the replay repeated delivered frames');
    for (let i = 0; i < 10; i++) host.send(true);
    await pump(relay);

    /* The relay restarts (a redeploy): every socket closes, in-flight frames vanish. */
    for (let i = 0; i < 10; i++) { host.send(true); guest.send(true); }
    relay.restart();
    for (let i = 0; i < 10; i++) { host.send(true); guest.send(true); }
    await sleep(500);
    await pump(relay, 10);
    exactlyOnceInOrder(guest.delivered.reliable, 120, 'guest stream survives a relay restart');
    exactlyOnceInOrder(host.delivered.reliable, 100, 'host stream survives a relay restart');
    assert(!host.states.includes('failed') && !guest.states.includes('failed'));

    /* Fencing: a stale socket's frames and close are ignored after a replacement. */
    const stale = guest.runtime.relay.reliable;
    relay.drop(GUEST);
    await sleep(400);
    await pump(relay, 6);
    const reconnects = guest.runtime.relay.reconnects;
    const frame = new Uint8Array(7 + 8 + 16);
    frame.set(idBytes(HOST), 1);
    new DataView(frame.buffer).setUint32(7, 999);
    stale.readyState = 1;
    stale.deliver(frame);
    stale.serverClose(1006);
    await sleep(400);
    assert.equal(guest.delivered.reliable.length, 120, 'a stale socket delivers nothing');
    assert.equal(guest.runtime.relay.reconnects, reconnects, 'a stale socket does not trigger reconnects');

    /* Acknowledgements trim the replay buffer. */
    await sleep(120);
    await pump(relay, 6);
    assert.equal(host.runtime.relayPeers.get(GUEST).resend.length, 0);
    assert.equal(guest.runtime.relayPeers.get(HOST).resend.length, 0);

    /* A peer gone longer than the grace period fails, as a dead connection would. */
    relay.refuse = true;
    relay.drop(GUEST);
    host.runtime.RELAY_GRACE_MILLISECONDS = 50;
    host.runtime.relayCheckGrace();
    await sleep(80);
    host.runtime.relayCheckGrace();
    assert(host.states.includes('failed'), 'the host gives up on a guest that never returns');
    console.log('library_web_transport resume tests passed');
  } finally {
    host.close();
    guest.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
