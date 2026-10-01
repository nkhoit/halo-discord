'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let library;
global.addToLibrary = value => { library = value; };
vm.runInThisContext(fs.readFileSync(
  path.join(__dirname, '..', 'library_web_transport.js'), 'utf8'));

const intervals = [];
const logged = [];
console.info = line => logged.push(line);
const logWindow = async () => {
  intervals[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  return HaloWebTransport.netStats().at(-1);
};
global.setInterval = (callback, delay) => { intervals.push({ callback, delay }); return 1; };
global.window = global;
global.location = { search: '?netstats=1' };
global.document = { visibilityState: 'visible' };
global.HEAPU8 = new Uint8Array(65536);
global.HEAPF64 = new Float64Array(HEAPU8.buffer);
HEAPU8.set([2, 0, 0, 0, 0, 1], 32);

const STATS_POINTER = 1024;
let hitches = 0;
let gapMaximum = 0;
global.Module = {
  _web_net_remote_local_identifier: () => 32,
  _web_net_remote_ingress_buffer: () => 64,
  _web_net_remote_ingress_capacity: () => 16396,
  _web_net_remote_add_peer: () => 0x01004064,
  _web_net_remote_remove_peer: () => 1,
  _web_net_remote_set_peer_state: () => 1,
  _web_net_remote_receive: () => 1,
  _platform_web_netstats: () => STATS_POINTER,
  _platform_web_profile_take_gap_maximum: () => { const gap = gapMaximum; gapMaximum = 0; return gap; },
  _platform_web_profile_hitches: () => hitches,
};
const game = values => HEAPF64.set(values, STATS_POINTER / 8);

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
  async getStats() {
    return new Map([['pair', {
      type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.012,
    }]]);
  }
  close() {}
};

let now = 0;
performance.now = () => now;

const runtime = library.$HaloWebTransportRuntime;
global.HaloWebTransportRuntime = runtime;
runtime.install();

function frame(length) {
  const bytes = new Uint8Array(length);
  bytes[0] = 0x48;
  return bytes.buffer;
}

(async () => {
  assert.equal(runtime.netstatsEnabled, true);
  assert.equal(intervals.length, 1, '?netstats=1 starts the periodic console summary');

  game([100, 0, 0, 0]);
  await runtime.netstatsTakeWindow();
  HaloWebTransport.configure({ onSignal() {}, onStateChange() {} });
  await HaloWebTransport.addPeer({
    peerId: 'friend', remoteIdentifier: '020000000002', initiator: true,
  });
  const record = runtime.peersById.get('friend');
  record.reliable.open();
  record.unreliable.open();

  for (const at of [0, 33, 66, 266, 299]) {
    now = at;
    record.unreliable.onmessage({ data: frame(40) });
  }
  record.reliable.onmessage({ data: frame(100) });
  record.droppedDatagrams += 3;
  game([160, 2, 3.07, 1]);
  hitches = 1;
  gapMaximum = 62.5;
  now = 2000;
  const first = await logWindow();

  assert.equal(first.game.ticksPerSecond, 30);
  assert.equal(first.game.ownCorrections, 2);
  assert.equal(first.game.ownCorrectionMaxUnits, 3.07);
  assert.equal(first.game.rejectedPredictions, 1);
  assert.equal(first.game.frameGapMaxMs, 62.5);
  assert.equal(first.game.frameHitches, 1);
  const peer = first.peers[0];
  assert.equal(peer.rttMs, 12);
  assert.equal(peer.droppedDatagrams, 3);
  assert.equal(peer.unreliable.framesPerSecond, 2.5);
  assert.equal(peer.unreliable.bytesPerSecond, 100);
  assert.equal(peer.unreliable.gapMaxMs, 200);
  assert.equal(peer.unreliable.gapsOver150Ms, 1);
  assert.equal(peer.unreliable.gapsOver300Ms, 0);
  assert.equal(peer.unreliable.gapP50Ms, 33);
  assert.equal(peer.reliable.framesPerSecond, 0.5);

  const second = await logWindow();
  assert.equal(HaloWebTransport.netStats().length, 2, 'netStats returns the logged windows');
  assert.equal(second.peers[0].droppedDatagrams, 0, 'each call reports a fresh window');
  assert.equal(second.peers[0].unreliable.gapsOver150Ms, 0);
  assert.equal(second.game.ownCorrections, 0);

  console.log('library_web_transport netstats tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  if (runtime.pumpChannel) runtime.pumpChannel.port1.close();
});
