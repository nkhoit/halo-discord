'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let library;
global.addToLibrary = value => { library = value; };
vm.runInThisContext(fs.readFileSync(
  path.join(__dirname, '..', 'library_web_transport.js'), 'utf8'));

global.window = global;
global.HEAPU8 = new Uint8Array(65536);
HEAPU8.set([2, 0, 0, 0, 0, 1], 32);

const HOST = '020000000001';
const GUEST = '020000000002';
const GUEST_ADDRESS = 0x01004064;
const calls = { states: [], received: [] };
global.Module = {
  _web_net_remote_local_identifier: () => 32,
  _web_net_remote_ingress_buffer: () => 64,
  _web_net_remote_ingress_capacity: () => 16396,
  _web_net_remote_add_peer: () => GUEST_ADDRESS,
  _web_net_remote_remove_peer: () => 1,
  _web_net_remote_set_peer_state: (address, connected, reliable, unreliable) => {
    calls.states.push([connected, reliable, unreliable]);
    return 1;
  },
  _web_net_remote_receive: (address, length) => {
    calls.received.push([address >>> 0, HEAPU8.slice(64, 64 + length)]);
    return 1;
  },
};

const sockets = [];
class FakeWebSocket {
  constructor(url) {
    this.url = new URL(url);
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.sent = [];
    sockets.push(this);
  }
  send(value) { this.sent.push(new Uint8Array(value)); }
  close(code) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.onclose) this.onclose({ code: code || 1006 });
  }
  open() { this.readyState = 1; this.onopen(); }
  text(value) { this.onmessage({ data: JSON.stringify(value) }); }
  binary(bytes) { this.onmessage({ data: new Uint8Array(bytes).buffer }); }
}
global.WebSocket = FakeWebSocket;
global.RTCPeerConnection = class { constructor() { throw new Error('relay mode must not use WebRTC'); } };

const runtime = library.$HaloWebTransportRuntime;
global.HaloWebTransportRuntime = runtime;
runtime.install();

const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const id = text => Array.from({ length: 6 }, (_, index) => parseInt(text.slice(index * 2, index * 2 + 2), 16));
const lastState = () => calls.states[calls.states.length - 1].join(',');

function haloFrame(marker) {
  const bytes = new Uint8Array(12);
  bytes[0] = 0x48;
  bytes[4] = marker;
  return bytes;
}

async function addGuest(sockets_) {
  HaloWebTransport.configure({
    transport: 'relay',
    relay: { url: 'https://relay.test/', sockets: sockets_, roomId: 'room-1', role: 'host' },
    onSignal() { throw new Error('relay peers must not signal'); },
    onStateChange: event => states.push(event.state),
    onError() {},
  });
  return HaloWebTransport.addPeer({ peerId: 'guest', remoteIdentifier: GUEST, initiator: true });
}

const states = [];

(async () => {
  assert.equal(HaloWebTransport.isSupported(), true);

  // One socket carries both channels.
  await addGuest(1);
  assert.equal(sockets.length, 1);
  const socket = sockets[0];
  assert.equal(socket.url.href,
    'wss://relay.test/v1/rooms/room-1/ws?role=host&id=020000000001&ch=both');
  assert.equal(states[0], 'connecting');

  socket.open();
  assert.equal(lastState(), '0,0,0', 'not connected until the relay reports the peer');
  socket.text({ type: 'ready', self: { id: HOST }, peers: [] });
  socket.text({ type: 'peer-up', id: GUEST });
  assert.equal(lastState(), '1,1,1');
  assert(states.includes('connected'));

  // Outbound frames carry the channel and the destination peer.
  const frame = haloFrame(7);
  HEAPU8.set(frame, 512);
  assert.equal(library.web_transport_send(GUEST_ADDRESS, 1, 512, 12), 1);
  assert.equal(library.web_transport_send(GUEST_ADDRESS, 0, 512, 12), 1);
  assert.deepEqual([...socket.sent[0]], [0, ...id(GUEST), ...frame]);
  assert.deepEqual([...socket.sent[1]], [1, ...id(GUEST), ...frame]);

  // Inbound frames reach the game at the peer's address; strangers are ignored.
  socket.binary([1, ...id(GUEST), ...haloFrame(9)]);
  socket.binary([0, ...id('0200000000ff'), ...haloFrame(10)]);
  await settle();
  assert.equal(calls.received.length, 1);
  assert.equal(calls.received[0][0], GUEST_ADDRESS);
  assert.equal(calls.received[0][1][4], 9);

  // A peer's ping is answered on the same socket.
  socket.sent.length = 0;
  socket.binary([2, ...id(GUEST), 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...socket.sent[0]], [3, ...id(GUEST), 1, 2, 3, 4, 5, 6, 7, 8]);

  // A backed-up socket refuses reliable frames and drops late datagrams.
  socket.sent.length = 0;
  socket.bufferedAmount = runtime.RELIABLE_HIGH_WATER + 1;
  assert.equal(library.web_transport_send(GUEST_ADDRESS, 1, 512, 12), 0);
  assert.equal(library.web_transport_send(GUEST_ADDRESS, 0, 512, 12), 1);
  assert.equal(socket.sent.length, 0);
  assert.equal(HaloWebTransport.listPeers()[0].staleDatagrams, 1);
  await settle();
  assert.equal(lastState(), '1,0,1');
  socket.bufferedAmount = 0;
  await settle();
  assert.equal(lastState(), '1,1,1', 'reliable sends resume once the socket drains');

  // The peer leaving the relay fails it, as a closed DataChannel would.
  socket.text({ type: 'peer-down', id: GUEST });
  assert(states.includes('failed'));
  assert.equal(HaloWebTransport.listPeers().length, 0);
  HaloWebTransport.disconnectAll();
  assert.equal(socket.readyState, 3);

  // Two sockets split reliable and unreliable traffic.
  await addGuest(2);
  const [reliable, unreliable] = sockets.slice(1);
  assert.equal(reliable.url.searchParams.get('ch'), 'r');
  assert.equal(unreliable.url.searchParams.get('ch'), 'u');
  reliable.open();
  unreliable.open();
  reliable.text({ type: 'ready', self: { id: HOST }, peers: [GUEST] });
  assert.equal(lastState(), '1,1,1');
  assert.equal(library.web_transport_send(GUEST_ADDRESS, 1, 512, 12), 1);
  assert.equal(library.web_transport_send(GUEST_ADDRESS, 0, 512, 12), 1);
  assert.equal(reliable.sent.length, 1);
  assert.equal(unreliable.sent.length, 1);
  assert.equal(unreliable.sent[0][0], 1);

  // Losing either socket fails every relay peer.
  unreliable.close(1006);
  assert.equal(HaloWebTransport.listPeers().length, 0);
  assert.equal(reliable.readyState, 3);
  await assert.rejects(HaloWebTransport.handleSignal('guest', {}), /Unknown peer/);

  console.log('library_web_transport relay tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  if (runtime.pumpChannel) runtime.pumpChannel.port1.close();
});
