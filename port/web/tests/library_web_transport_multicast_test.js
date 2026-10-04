'use strict';

// Relay protocol 2 on the host (library_web_transport.js relayMulticast): what
// the engine writes to every machine goes to the relay once, as the frame
// each guest would have got alone; each guest's reliable frames keep their
// order; nothing is merged without the relay's slots or on a guest; and a
// guest that falls 4 MiB behind is dropped instead of blocking the host.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let library;
global.addToLibrary = value => { library = value; };
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'library_web_transport.js'), 'utf8'));

global.window = global;
global.HEAPU8 = new Uint8Array(65536);
HEAPU8.set([2, 0, 0, 0, 0, 1], 32);

const HOST = '020000000001';
const GUESTS = ['020000000002', '020000000003', '020000000004'];
const addressOf = id => 0x01004000 + parseInt(id.slice(10), 16);
const removed = [];
global.Module = {
  _web_net_remote_local_identifier: () => 32,
  _web_net_remote_ingress_buffer: () => 64,
  _web_net_remote_ingress_capacity: () => 16396,
  _web_net_remote_add_peer: () => 0x01004000 + HEAPU8[64 + 5],
  _web_net_remote_remove_peer: address => { removed.push(address >>> 0); return 1; },
  _web_net_remote_set_peer_state: () => 1,
  _web_net_remote_receive: () => 1,
  _web_net_remote_set_batching: () => {},
};

const sockets = [];
class FakeWebSocket {
  constructor(url) {
    this.url = new URL(url);
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.sent = [];
    this.texts = [];
    sockets.push(this);
  }
  send(value) {
    if (typeof value === 'string') this.texts.push(JSON.parse(value));
    else this.sent.push(new Uint8Array(value));
  }
  close(code) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.onclose) this.onclose({ code: code || 1006 });
  }
  open() { this.readyState = 1; this.onopen(); }
  text(value) { this.onmessage({ data: JSON.stringify(value) }); }
}
global.WebSocket = FakeWebSocket;
delete global.RTCPeerConnection;

const runtime = library.$HaloWebTransportRuntime;
global.HaloWebTransportRuntime = runtime;
runtime.install();

const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const id = text => Array.from({ length: 6 }, (_, index) => parseInt(text.slice(index * 2, index * 2 + 2), 16));
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

/* the relay frames of the messages a socket sent */
function framesOf(socket) {
  return socket.sent.flatMap(message => {
    if (message[0] !== 0x80) return [message];
    const frames = [];
    for (let offset = 1; offset < message.length;) {
      const length = (message[offset] << 8) | message[offset + 1];
      frames.push(message.slice(offset + 2, offset + 2 + length));
      offset += 2 + length;
    }
    return frames;
  });
}

/* a loopback frame (web_loopback_net.c) at HEAPU8[at]: its length */
function loopback(at, type, connection, payload) {
  HEAPU8.fill(0, at, at + 12);
  HEAPU8.set([0x48, 1, type, 0], at);
  new DataView(HEAPU8.buffer).setUint32(at + 4, connection);
  if (type === 1) HEAPU8.set([0x09, 0x1e, 0x08, 0xfe], at + 8);
  HEAPU8.set(payload, at + 12);
  return 12 + payload.length;
}

const send = (guest, reliable, at, length) => library.web_transport_send(addressOf(guest), reliable ? 1 : 0, at, length);

async function host(role, readyExtras) {
  HaloWebTransport.configure({
    transport: 'relay',
    relay: { url: 'https://relay.test/', sockets: 1, roomId: `room-${Math.random()}`, role, rooms: true,
      auth: { getToken: () => 'session-token', build: 'web-1' } },
    onRelayPeer() {},
    onStateChange() {},
    onError() {},
  });
  HaloWebTransport.openRelay();
  const socket = sockets[sockets.length - 1];
  socket.open();
  socket.text({ type: 'ready', self: { id: HOST, slot: 0, generation: 1 }, peers: GUESTS,
    names: {}, ...readyExtras });
  await settle();
  socket.sent.length = 0;
  return socket;
}

const SLOTS = { [GUESTS[0]]: [1, 1], [GUESTS[1]]: [2, 7], [GUESTS[2]]: [3, 1] };

(async () => {
  // The engine writes one message to every machine: one multicast.
  let socket = await host('host', { slots: SLOTS });
  assert.deepEqual(socket.texts[0].protocol, 2, 'the auth says protocol 2');
  const message = [5, 6, 7, 8, 9];
  GUESTS.forEach((guest, index) => {
    const length = loopback(1024, 3, 0x11 * (index + 1), message);
    assert.equal(send(guest, true, 1024, length), 1);
  });
  GUESTS.forEach(guest => assert.equal(send(guest, false, 2048, loopback(2048, 1, 0, [1, 2, 3])), 1));
  assert.equal(send(GUESTS[2], false, 2048, loopback(2048, 1, 0, [4])), 1);
  library.web_transport_flush();
  let frames = framesOf(socket);
  const reliable = frames.filter(frame => frame[0] === 8 && frame[1] === 0);
  assert.equal(reliable.length, 1, 'the reliable message once');
  const multicast = reliable[0];
  const view = new DataView(multicast.buffer, multicast.byteOffset);
  assert.equal(multicast[2], 3);
  const entries = [0, 1, 2].map(index => {
    const offset = 3 + index * 14;
    return [multicast[offset], multicast[offset + 1], view.getUint32(offset + 2), view.getUint32(offset + 6),
      view.getUint32(offset + 10)];
  });
  assert.deepEqual(entries, [[1, 1, 1, 0, 0x11], [2, 7, 1, 0, 0x22], [3, 1, 1, 0, 0x33]],
    'each guest its slot, sequence, acknowledgement and connection word');
  assert.deepEqual(Array.from(multicast.subarray(3 + 3 * 14 + 12)), message);
  const datagram = frames.filter(frame => frame[0] === 8 && frame[1] === 1);
  assert.equal(datagram.length, 1, 'the same datagrams once');
  assert.equal(datagram[0][2], 2, 'for the two guests whose datagrams were the same');
  assert.deepEqual([datagram[0][3], datagram[0][5]].sort(), [1, 2]);
  const unicast = frames.filter(frame => frame[0] === 1);
  assert.equal(unicast.length, 1, 'the third guest got one more datagram: its own bundle');
  assert.equal(hex(unicast[0].subarray(1, 7)), GUESTS[2]);
  assert.equal(runtime.relay.multicastFrames, 2);
  assert.equal(runtime.relay.multicastCopies, 5);

  // A guest's reliable frames keep their order: only neighbours merge.
  socket.sent.length = 0;
  assert.equal(send(GUESTS[0], true, 1024, loopback(1024, 3, 1, [1])), 1);
  assert.equal(send(GUESTS[1], true, 1024, loopback(1024, 3, 2, [9, 9])), 1);
  assert.equal(send(GUESTS[1], true, 1024, loopback(1024, 3, 2, [1])), 1);
  assert.equal(send(GUESTS[2], true, 1024, loopback(1024, 3, 3, [1])), 1);
  library.web_transport_flush();
  frames = framesOf(socket);
  assert.deepEqual(frames.map(frame => frame[0] === 8 ? 'multi:' + frame[2] : hex(frame.subarray(1, 7))),
    [GUESTS[0], GUESTS[1], 'multi:2']);
  const merged = frames[2];
  const mergedView = new DataView(merged.buffer, merged.byteOffset);
  assert.deepEqual([merged[3], mergedView.getUint32(5), merged[3 + 14], mergedView.getUint32(5 + 14)], [2, 3, 3, 2],
    'the second guest\'s merged frame after its own earlier one (sequence 3 after 2)');

  // A guest the relay gave no slot (or a protocol 1 relay) gets its own frames.
  HaloWebTransport.disconnectAll();
  socket = await host('host', { slots: { [GUESTS[0]]: [1, 1] } });
  GUESTS.slice(0, 2).forEach((guest, index) => send(guest, true, 1024, loopback(1024, 3, index + 1, message)));
  library.web_transport_flush();
  assert.deepEqual(framesOf(socket).map(frame => frame[0]), [0, 0], 'no multicast without both slots');
  HaloWebTransport.disconnectAll();
  socket = await host('host', {});
  GUESTS.forEach((guest, index) => send(guest, true, 1024, loopback(1024, 3, index + 1, message)));
  library.web_transport_flush();
  assert.deepEqual(framesOf(socket).map(frame => frame[0]), [0, 0, 0], 'nor from a protocol 1 relay');

  // peer-up brings a slot; peer-down takes it.
  socket.text({ type: 'peer-down', id: GUESTS[0] });
  assert.equal(runtime.relay.slots.has(GUESTS[0]), false);
  socket.text({ type: 'peer-up', id: GUESTS[0], name: 'A', slot: 4, generation: 2 });
  assert.deepEqual(runtime.relay.slots.get(GUESTS[0]), { slot: 4, generation: 2 });
  socket.text({ type: 'peer-up', id: GUESTS[1], name: 'B', slot: 99, generation: 2 });
  assert.equal(runtime.relay.slots.has(GUESTS[1]), false, 'a slot out of range is not used');

  // A guest 4 MiB behind is dropped; the others are not held up.
  HaloWebTransport.disconnectAll();
  socket = await host('host', { slots: SLOTS });
  const behind = runtime.relayPeers.get(GUESTS[1]);
  behind.resendBytes = runtime.RELAY_RESEND_LIMIT - 10;
  removed.length = 0;
  assert.equal(send(GUESTS[0], true, 1024, loopback(1024, 3, 1, message)), 1);
  assert.equal(send(GUESTS[1], true, 1024, loopback(1024, 3, 2, message)), 0);
  assert.equal(send(GUESTS[2], true, 1024, loopback(1024, 3, 3, message)), 1);
  await settle();
  assert.deepEqual(removed, [addressOf(GUESTS[1])], 'the guest behind is dropped');
  assert.equal(runtime.relayPeers.has(GUESTS[1]), false);
  library.web_transport_flush();
  frames = framesOf(socket);
  assert.equal(frames.length, 1);
  assert.equal(frames[0][0], 8);
  assert.deepEqual([frames[0][3], frames[0][3 + 14]], [1, 3], 'the others still get it, once');

  // A guest only ever has the host: nothing to merge.
  HaloWebTransport.disconnectAll();
  socket = await host('guest', { slots: SLOTS });
  assert.equal(runtime.relayMulticast(runtime.relay, [new Uint8Array(30), new Uint8Array(30)]).length, 2);

  HaloWebTransport.disconnectAll();
  console.log('library_web_transport multicast tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  HaloWebTransport.disconnectAll();
  if (runtime.pumpChannel) runtime.pumpChannel.port1.close();
});
