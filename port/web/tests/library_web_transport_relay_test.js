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
  binary(bytes) { this.onmessage({ data: new Uint8Array(bytes).buffer }); }
}
global.WebSocket = FakeWebSocket;
/* Like Discord's Activity frame: no WebRTC at all, so any use in relay mode throws. */
delete global.RTCPeerConnection;
delete global.RTCDataChannel;

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
    relay: { url: 'https://relay.test/', sockets: sockets_, roomId: 'room-1', role: 'host', batch: false,
      auth: { getToken: () => 'session-token', build: 'web-1' } },
    onSignal() { throw new Error('relay peers must not signal'); },
    onStateChange: event => states.push(event.state),
    onError() {},
  });
  return HaloWebTransport.addPeer({ peerId: 'guest', remoteIdentifier: GUEST, initiator: true });
}

const states = [];

(async () => {
  assert.equal(HaloWebTransport.isSupported(), false, 'WebRTC, the default, is unavailable here');
  assert.equal(HaloWebTransport.isSupported('relay'), true, 'the relay needs only WebSocket');
  assert.equal(HaloWebTransport.isSupported('webrtc'), false);

  // One socket carries both channels.
  await addGuest(1);
  assert.equal(sockets.length, 1);
  const socket = sockets[0];
  assert.equal(socket.url.href, 'wss://relay.test/v1/rooms/room-1/ws?role=host&ch=both');
  assert.equal(states[0], 'connecting');

  socket.open();
  assert.deepEqual(socket.texts, [{ type: 'auth', token: 'session-token', id: HOST, build: 'web-1' }],
    'the session token is the first message');
  assert.equal(lastState(), '0,0,0', 'not connected until the relay reports the peer');
  socket.text({ type: 'ready', self: { id: HOST }, peers: [] });
  socket.text({ type: 'peer-up', id: GUEST });
  assert.equal(lastState(), '1,1,1');
  assert(states.includes('connected'));

  // The host's phase, with what the server-wide list shows; sent on changes only.
  HaloWebTransport.setRelayPhase(false, false, { state: 'lobby', map: 9, mode: 1, channel: 'Squad A' });
  HaloWebTransport.setRelayPhase(false, false, { state: 'lobby', map: 9, mode: 1, channel: 'Squad A' });
  HaloWebTransport.setRelayPhase(true, true, { state: 'match', map: 9, mode: 1, channel: 'Squad A' });
  assert.deepEqual(socket.texts.slice(1), [
    { state: 'lobby', map: 9, mode: 1, channel: 'Squad A', type: 'phase', inMatch: false, joinable: false },
    { state: 'match', map: 9, mode: 1, channel: 'Squad A', type: 'phase', inMatch: true, joinable: true },
  ]);
  HaloWebTransport.setRelayPhase(false, false);
  assert.deepEqual(socket.texts.at(-1), { type: 'phase', inMatch: false, joinable: false }, 'details are optional');
  socket.texts.length = 1;

  // Outbound frames carry the channel and the destination peer; reliable ones
  // also their sequence number and the acknowledgement of the peer's frames.
  const frame = haloFrame(7);
  HEAPU8.set(frame, 512);
  assert.equal(library.web_transport_send(GUEST_ADDRESS, 1, 512, 12), 1);
  assert.equal(library.web_transport_send(GUEST_ADDRESS, 0, 512, 12), 1);
  assert.deepEqual([...socket.sent[0]], [0, ...id(GUEST), 0, 0, 0, 1, 0, 0, 0, 0, ...frame]);
  assert.deepEqual([...socket.sent[1]], [1, ...id(GUEST), ...frame]);

  // Inbound frames reach the game at the peer's address; strangers are ignored.
  socket.binary([1, ...id(GUEST), ...haloFrame(9)]);
  socket.binary([0, ...id('0200000000ff'), 0, 0, 0, 1, 0, 0, 0, 0, ...haloFrame(10)]);
  await settle();
  assert.equal(calls.received.length, 1);
  assert.equal(calls.received[0][0], GUEST_ADDRESS);
  assert.equal(calls.received[0][1][4], 9);

  // Reliable frames arrive once and in order; their acknowledgement goes back.
  socket.sent.length = 0;
  socket.binary([0, ...id(GUEST), 0, 0, 0, 1, 0, 0, 0, 1, ...haloFrame(11)]);
  socket.binary([0, ...id(GUEST), 0, 0, 0, 1, 0, 0, 0, 1, ...haloFrame(11)]);
  socket.binary([0, ...id(GUEST), 0, 0, 0, 3, 0, 0, 0, 1, ...haloFrame(13)]);
  socket.binary([0, ...id(GUEST), 0, 0, 0, 2, 0, 0, 0, 1, ...haloFrame(12)]);
  await settle();
  assert.deepEqual(calls.received.slice(1).map(entry => entry[1][4]), [11, 12]);
  await new Promise(resolve => setTimeout(resolve, runtime.RELAY_ACK_MILLISECONDS + 20));
  assert.deepEqual([...socket.sent.find(bytes => bytes[0] === 7)], [7, ...id(GUEST), 0, 0, 0, 2]);
  assert.equal(runtime.relayPeers.get(GUEST).resend.length, 0, 'the peer acknowledged frame 1');

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

  // A peer leaving the relay stays connected for the game until the grace
  // period runs out (library_web_transport_resume_test.js).
  socket.text({ type: 'peer-down', id: GUEST });
  assert(!states.includes('failed'));
  assert.equal(lastState(), '1,1,1');
  assert.equal(runtime.relayLinked(runtime.relayPeers.get(GUEST)), false);
  HaloWebTransport.disconnectAll();
  assert.equal(socket.readyState, 3);

  // Two sockets split reliable and unreliable traffic.
  await addGuest(2);
  const [reliable, unreliable] = sockets.slice(1);
  assert.equal(reliable.url.searchParams.get('ch'), 'r');
  assert.equal(unreliable.url.searchParams.get('ch'), 'u');
  reliable.open();
  reliable.text({ type: 'ready', self: { id: HOST }, peers: [GUEST] });
  assert.equal(lastState(), '0,0,0', 'linked only once both sockets are open');
  unreliable.open();
  assert.equal(lastState(), '1,1,1');
  assert.equal(library.web_transport_send(GUEST_ADDRESS, 1, 512, 12), 1);
  assert.equal(library.web_transport_send(GUEST_ADDRESS, 0, 512, 12), 1);
  assert.equal(reliable.sent.length, 1);
  assert.equal(unreliable.sent.length, 1);
  assert.equal(unreliable.sent[0][0], 1);

  // Losing either socket reconnects both, and the peer stays connected.
  unreliable.close(1006);
  assert.equal(reliable.readyState, 3);
  assert.equal(HaloWebTransport.listPeers().length, 1);
  await new Promise(resolve => setTimeout(resolve, runtime.RELAY_RECONNECT_MILLISECONDS[0] + 50));
  assert.equal(sockets.length, 5, 'a new pair of sockets');
  assert(!states.includes('failed'));
  HaloWebTransport.disconnectAll();
  await assert.rejects(HaloWebTransport.handleSignal('guest', {}), /Unknown peer/);

  // Room mode: the relay's membership supplies the peers; frames are batched
  // per socket until the game frame ends.
  const discovered = [];
  let batching = null;
  Module._web_net_remote_set_batching = enabled => { batching = enabled; };
  HaloWebTransport.configure({
    relay: { url: 'https://relay.test/', sockets: 1, roomId: 'room-2', role: 'host', rooms: true,
      auth: { getToken: () => 'session-token', build: 'web-1' } },
    onRelayPeer: peer => discovered.push(peer),
  });
  HaloWebTransport.openRelay();
  assert.equal(batching, 1, 'the game is asked to flush once per frame');
  const room = sockets[sockets.length - 1];
  room.open();
  room.text({ type: 'ready', self: { id: HOST }, peers: [GUEST], names: { [GUEST]: 'Guest One' } });
  await settle();
  assert.deepEqual(discovered, [{ peerId: 'relay-' + GUEST, identifier: GUEST, name: 'Guest One', role: 'guest' }]);
  assert.equal(HaloWebTransport.listPeers()[0].state, 'connected');

  room.sent.length = 0;
  assert.equal(library.web_transport_send(GUEST_ADDRESS, 1, 512, 12), 1);
  assert.equal(library.web_transport_send(GUEST_ADDRESS, 0, 512, 12), 1);
  assert.equal(library.web_transport_send(GUEST_ADDRESS, 0, 512, 12), 1);
  assert.equal(room.sent.length, 0, 'held until the frame ends');
  library.web_transport_flush();
  assert.equal(room.sent.length, 1, 'one message for the frame');
  const batch = room.sent[0];
  assert.equal(batch[0], 0x80);
  const lengths = [];
  for (let offset = 1; offset < batch.length;) {
    const length = (batch[offset] << 8) | batch[offset + 1];
    lengths.push([batch[offset + 2], length]);
    offset += 2 + length;
  }
  assert.deepEqual(lengths, [[0, 7 + 8 + 12], [1, 7 + 12], [1, 7 + 12]]);

  const before = calls.received.length;
  const inner = [[1, ...id(GUEST), ...haloFrame(21)], [1, ...id(GUEST), ...haloFrame(22)]];
  room.binary([0x80, ...inner.flatMap(frame => [0, frame.length, ...frame])]);
  await settle();
  assert.deepEqual(calls.received.slice(before).map(entry => entry[1][4]), [21, 22], 'a batch is split on arrival');

  HaloWebTransport.disconnectAll();
  assert.equal(batching, 0);

  console.log('library_web_transport relay tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  HaloWebTransport.disconnectAll();
  if (runtime.pumpChannel) runtime.pumpChannel.port1.close();
});
