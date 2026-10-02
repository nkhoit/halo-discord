'use strict';

/* The Discord Activity lobby in online_client.js: the room is the Activity
   instance's, the lobby offers hosting when nobody hosts and joining the host
   otherwise, and an expired session signs in again through the SDK. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOM = 'Activity-Room-0123456789';

function element(overrides) {
  const listeners = {};
  return Object.assign({
    dataset: {},
    disabled: false,
    hidden: false,
    open: false,
    value: '',
    textContent: '',
    options: [],
    addEventListener(type, listener) { listeners[type] = listener; },
    dispatchEvent(event) { if (listeners[event.type]) listeners[event.type](event); },
    close() { this.open = false; },
    focus() { this.focused = true; },
    click() { if (listeners.click) listeners.click(); },
    removeAttribute(name) { delete this[name]; },
    select() {},
    setAttribute(name, value) { this[name] = String(value); },
    showModal() { this.open = true; },
    querySelectorAll: () => [],
    appendChild() {},
    removeChild() {},
    listeners,
  }, overrides || {});
}

const elements = {};
const styleInputs = ['sage', 'red'].map(value => element({ checked: value === 'sage', value }));
elements['online-style-options'] = element({ querySelectorAll: () => styleInputs });
elements['online-map'] = element({ options: [{ value: '0', textContent: 'Battle Creek' }], value: '0' });
elements['online-mode'] = element({ options: [{ value: '0', textContent: 'Slayer' }], value: '0' });
const byId = id => elements[id] || (elements[id] = element());

let roomHost = null;
let gameState = 2;
const intervals = [];
let sessionStatus = [401, 200];
let signIns = 0;
const fetches = [];
const configured = [];
let relayOpened = 0;
let disconnects = 0;
const windowListeners = {};
const timers = [];

const settle = async () => { for (let index = 0; index < 10; index++) await new Promise(resolve => setImmediate(resolve)); };

/* Runs every pending timer once; the lobby's poll schedules the next one. */
async function tick() {
  for (const callback of timers.splice(0)) await callback();
  await settle();
}

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const context = {
  console,
  Event: class { constructor(type) { this.type = type; } },
  document: {
    readyState: 'complete',
    getElementById: byId,
    querySelector: selector => ({
      'meta[name="halo-build-id"]': { content: 'test-build' },
      'meta[name="halo-transport"]': { content: 'relay-rooms' },
    })[selector] || null,
  },
  fetch: async url => {
    fetches.push(String(url));
    if (/\/v1\/rooms\//.test(url)) return json(200, { host: roomHost, players: roomHost ? 1 : 0 });
    if (/\/auth\/session$/.test(url)) {
      const status = sessionStatus.length > 1 ? sessionStatus.shift() : sessionStatus[0];
      return status === 200 ?
        json(200, { token: 'session-token', user: { id: '7', name: 'Arbiter' }, expiresAt: Date.now() / 1000 + 3600 }) :
        json(status, { error: 'login required' });
    }
    throw new Error(`unexpected fetch ${url}`);
  },
  HaloActivity: {
    roomId: ROOM,
    user: { id: '7', name: 'Arbiter!' },
    signIn: async () => { signIns++; },
    openExternalLink() {},
  },
  HaloWebTransport: {
    configure(options) { configured.push(options); },
    disconnectAll() { disconnects++; },
    getLocalIdentifier: () => '020000000001',
    /* Discord's Activity frame has WebSocket but no RTCPeerConnection. */
    isSupported: transport => transport === 'relay',
    openRelay() { relayOpened++; },
    removePeer() {},
  },
  history: { replaceState() {} },
  localStorage: { getItem: () => null, setItem() {} },
  location: new URL(`https://123.discordsays.com/?frame_id=f1&instance_id=i-1`),
  Module: {
    _platform_web_online_get_error: () => 0,
    _platform_web_online_get_state: () => gameState,
    _platform_web_online_host_configured: () => 1,
    _platform_web_online_request: () => 1,
    _platform_web_online_set_player_customization: () => 1,
    _platform_web_online_set_transport_state() {},
  },
  navigator: {},
  URL,
  URLSearchParams,
  btoa,
  crypto: globalThis.crypto,
  WebSocket: class {},
  addEventListener(type, listener) { windowListeners[type] = listener; },
  clearInterval() {},
  clearTimeout() {},
  setInterval: callback => intervals.push(callback),
  setTimeout: (callback, milliseconds) => { if (!milliseconds || milliseconds <= 2000) timers.push(callback); return timers.length; },
};
context.window = context;
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'online_client.js'), 'utf8'), context,
  { filename: 'online_client.js' });

(async () => {
  context.HaloOnline.runtimeReady();
  await tick();

  assert.doesNotMatch(elements['online-status'].textContent, /WebRTC|does not support/, 'no WebRTC requirement in the Activity');
  assert(fetches.some(url => url === `https://123.discordsays.com/v1/rooms/${ROOM}`), 'the lobby polls its room');
  assert.equal(elements['online-dialog'].open, true);
  assert.equal(elements['online-dialog'].dataset.view, 'setup', 'nobody hosts yet, so offer hosting');
  assert.match(elements['online-description'].textContent, /Nobody is hosting yet/);
  assert.equal(elements['online-player-name'].value, 'Arbiter', 'the Discord name, cleaned up');

  roomHost = 'Alice';
  await tick();
  assert.equal(elements['online-dialog'].dataset.view, 'join', 'a host appeared, so offer joining');
  assert.match(elements['online-join-summary'].textContent, /^Alice is hosting/);

  assert.equal(elements['online-join-profile'].focused, true, 'the join button is focused, so it is in view and Enter works');

  timers.length = 0;
  elements['online-player-name'].listeners.keydown({ key: 'Enter', preventDefault() {} });
  await settle();
  assert.equal(signIns, 1, 'a 401 signs in again through the Discord SDK');
  assert.equal(relayOpened, 1);
  const guest = configured.at(-1);
  assert.equal(guest.transport, 'relay');
  assert.equal(guest.relay.roomId, ROOM);
  assert.equal(guest.relay.role, 'guest');
  assert.equal(guest.relay.url, 'https://123.discordsays.com');
  assert.equal(guest.relay.auth.getToken(), 'session-token');
  assert(!fetches.some(url => /auth\/login/.test(url)), 'no OAuth redirect inside the Activity');

  guest.onRelayPeer({ peerId: 'relay-020000000002', identifier: '020000000002', name: 'Alice', role: 'host' });
  guest.onStateChange({ peerId: 'relay-020000000002', state: 'connected' });
  gameState = 6;
  intervals.forEach(callback => callback());
  roomHost = null;
  gameState = 0;
  intervals.forEach(callback => callback());
  await settle();
  await tick();
  assert.equal(elements['online-dialog'].dataset.view, 'setup', 'leaving returns to the lobby');
  assert.equal(elements['online-status'].textContent, 'The host left or ended the game.');

  timers.length = 0;
  await context.HaloOnline.host({ mapIndex: 0, modeIndex: 0 });
  const host = configured.at(-1);
  assert.equal(host.relay.role, 'host');
  assert.equal(host.relay.roomId, ROOM, 'the host uses the instance room, not a random one');
  assert.equal(elements['invite-link'].value, 'Everyone in this Activity can join');
  assert.equal(elements['invite-copy'].hidden, true);
  assert.equal(timers.length, 0, 'the lobby stops polling while hosting');

  const before = disconnects;
  windowListeners.pagehide();
  await settle();
  assert(disconnects > before, 'leaving the page (or entering the back/forward cache) closes the room');

  console.log('online_client Activity lobby tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
