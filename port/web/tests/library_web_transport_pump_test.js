'use strict';

/* A hidden page runs chained timers about once a second.  These tests freeze
   setTimeout entirely, so packets reach the game only if the transport pumps
   without timers. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const realSetTimeout = setTimeout;
const frozenTimers = [];
global.setTimeout = (callback, delay) => {
  frozenTimers.push({ callback, delay });
  return frozenTimers.length;
};
const settle = () => new Promise(resolve => realSetTimeout(resolve, 30));

let library;
global.addToLibrary = value => { library = value; };
vm.runInThisContext(fs.readFileSync(
  path.join(__dirname, '..', 'library_web_transport.js'), 'utf8'));

global.window = global;
global.HEAPU8 = new Uint8Array(65536);
HEAPU8.set([2, 0, 0, 0, 0, 1], 32);

const PEER_ADDRESS = 0x01004064;
let receiveResults = [];
const received = [];
let receiveCalls = 0;
global.Module = {
  _web_net_remote_local_identifier: () => 32,
  _web_net_remote_ingress_buffer: () => 64,
  _web_net_remote_ingress_capacity: () => 16396,
  _web_net_remote_add_peer: () => PEER_ADDRESS,
  _web_net_remote_remove_peer: () => 1,
  _web_net_remote_set_peer_state: () => 1,
  _web_net_remote_receive: (address, length) => {
    receiveCalls++;
    const result = receiveResults.length ? receiveResults.shift() : 1;
    if (result > 0) received.push(HEAPU8.slice(64, 64 + length));
    return result;
  },
};

class FakeDataChannel {
  constructor(label, options) {
    this.label = label;
    this.ordered = options.ordered !== undefined ? options.ordered : true;
    this.maxRetransmits = options.maxRetransmits !== undefined ? options.maxRetransmits : null;
    this.readyState = 'connecting';
    this.bufferedAmount = 0;
  }
  send() {}
  close() { this.readyState = 'closed'; }
  open() { this.readyState = 'open'; if (this.onopen) this.onopen(); }
}

global.RTCPeerConnection = class {
  createDataChannel(label, options) { return new FakeDataChannel(label, options); }
  async setLocalDescription() { this.localDescription = { toJSON() { return {}; } }; }
  close() {}
};

const runtime = library.$HaloWebTransportRuntime;
global.HaloWebTransportRuntime = runtime;
runtime.install();

function frame(marker) {
  const bytes = new Uint8Array(12);
  bytes[0] = 0x48;
  bytes[4] = marker;
  return bytes.buffer;
}

(async () => {
  HaloWebTransport.configure({ onSignal() {}, onStateChange() {} });
  await HaloWebTransport.addPeer({
    peerId: 'friend', remoteIdentifier: '020000000002', initiator: true,
  });
  const record = runtime.peersById.get('friend');
  record.reliable.open();
  record.unreliable.open();
  await settle();

  // A datagram reaches the game with every timer frozen.
  record.unreliable.onmessage({ data: frame(1) });
  await settle();
  assert.equal(received.length, 1, 'datagram must be delivered without timers');
  assert.equal(received[0][4], 1);

  // A briefly busy socket lock is retried without timers.
  receiveResults = [0, 0, 0];
  record.reliable.onmessage({ data: frame(2) });
  await settle();
  assert.equal(received.length, 2, 'busy retries must not wait on a timer');
  assert.equal(frozenTimers.length, 0);

  // A burst drains completely, at most 16 datagrams per pump.
  const pump = runtime.pump;
  let perPumpMaximum = 0;
  runtime.pump = function() {
    const before = received.length;
    pump.call(runtime);
    perPumpMaximum = Math.max(perPumpMaximum, received.length - before);
  };
  received.length = 0;
  for (let index = 0; index < 100; index++) {
    record.unreliable.onmessage({ data: frame(index) });
  }
  await settle();
  assert.equal(received.length, 100, 'a burst must drain without timers');
  assert(perPumpMaximum <= 16, `a pump delivered ${perPumpMaximum} datagrams`);

  // A socket that stays full stops spinning and falls back to a timer.
  receiveResults = new Array(1000).fill(0);
  receiveCalls = 0;
  received.length = 0;
  record.unreliable.onmessage({ data: frame(7) });
  await settle();
  assert.equal(received.length, 0);
  assert(receiveCalls <= runtime.IDLE_PUMP_RETRY_LIMIT + 1,
    `a stalled socket was retried ${receiveCalls} times`);
  assert.equal(frozenTimers.length, 1, 'the stalled retry must fall back to a timer');

  // New traffic resumes immediate pumping even with that timer pending.
  receiveResults = [];
  record.unreliable.onmessage({ data: frame(8) });
  await settle();
  assert.deepEqual(received.map(bytes => bytes[4]), [7, 8]);

  runtime.pump = pump;
  runtime.pumpChannel.port1.close();
  console.log('library_web_transport pump tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
