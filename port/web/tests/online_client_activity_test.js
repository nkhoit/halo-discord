'use strict';

/* The hosted page's lobby in online_client.js (the Discord Activity and the
   browser page): the room is the Activity instance's or the address's, the
   lobby offers hosting when nobody hosts, joins a host in its lobby at once
   under the Discord name, and waits while the host is in a match; an expired
   Activity session signs in again through the SDK. */

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

/* One page: the Discord Activity (HaloActivity set) or the browser page. */
function load({ activity, hash = '', user = { id: '7', name: 'Arbiter!' } }) {
  const page = {
    elements: {}, roomHost: null, inMatch: false, gameState: 2, clientState: 2, intervals: [], timers: [],
    /* (the Activity's first session request finds it expired; a browser page is signed in) */
    sessionStatus: activity ? [401, 200] : [200], signIns: 0, fetches: [], configured: [], relayOpened: 0, disconnects: 0,
    windowListeners: {}, customizations: [], phases: [], replaced: [], assigned: [],
  };
  const elements = page.elements;
  const styleInputs = ['sage', 'red'].map(value => element({ checked: value === 'sage', value }));
  elements['online-style-options'] = element({ querySelectorAll: () => styleInputs });
  elements['online-map'] = element({ options: [{ value: '0', textContent: 'Battle Creek' }], value: '0' });
  elements['online-mode'] = element({ options: [{ value: '0', textContent: 'Slayer' }], value: '0' });
  const byId = id => elements[id] || (elements[id] = element());
  const origin = activity ? 'https://123.discordsays.com' : 'https://halo.example';
  const location = new URL(activity ? `${origin}/?frame_id=f1&instance_id=i-1` : `${origin}/${hash}`);
  page.location = location;
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
      page.fetches.push(String(url));
      if (/\/v1\/rooms\//.test(url)) {
        return json(200, { host: page.roomHost, players: page.roomHost ? 1 : 0, inMatch: page.inMatch });
      }
      if (/\/auth\/session$/.test(url)) {
        const status = page.sessionStatus.length > 1 ? page.sessionStatus.shift() : page.sessionStatus[0];
        return status === 200 ?
          json(200, { token: 'session-token', user, expiresAt: Date.now() / 1000 + 3600 }) :
          json(status, { error: 'login required' });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    HaloActivity: activity ? {
      roomId: ROOM,
      user,
      signIn: async () => { page.signIns++; },
      openExternalLink() {},
    } : undefined,
    HaloHostedUser: activity ? undefined : user,
    HaloWebTransport: {
      configure(options) { page.configured.push(options); },
      disconnectAll() { page.disconnects++; },
      getLocalIdentifier: () => '020000000001',
      /* Discord's Activity frame has WebSocket but no RTCPeerConnection. */
      isSupported: transport => transport === 'relay',
      openRelay() { page.relayOpened++; },
      removePeer() {},
      /* (sends only changes, as the transport does) */
      setRelayPhase(inMatch) { if (page.phases.at(-1) !== inMatch) page.phases.push(inMatch); },
    },
    history: { replaceState(state, title, url) { page.replaced.push(url); location.hash = url; } },
    localStorage: { getItem: () => null, setItem() {} },
    location,
    Module: {
      _platform_web_online_get_error: () => 0,
      _platform_web_online_get_state: () => page.gameState,
      _platform_web_online_get_client_state: () => page.clientState,
      _platform_web_online_host_configured: () => 1,
      _platform_web_online_request: () => 1,
      _platform_web_online_set_player_customization: (...values) => { page.customizations.push(values); return 1; },
      _platform_web_online_set_transport_state() {},
    },
    navigator: {},
    URL,
    URLSearchParams,
    btoa,
    crypto: globalThis.crypto,
    WebSocket: class {},
    addEventListener(type, listener) { page.windowListeners[type] = listener; },
    clearInterval() {},
    clearTimeout() {},
    setInterval: callback => page.intervals.push(callback),
    setTimeout: (callback, milliseconds) => {
      if (!milliseconds || milliseconds <= 2000) page.timers.push(callback);
      return page.timers.length;
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'online_client.js'), 'utf8'), context,
    { filename: 'online_client.js' });
  page.context = context;
  page.tick = async () => {
    for (const callback of page.timers.splice(0)) await callback();
    await settle();
  };
  page.poll = () => page.intervals.forEach(callback => callback());
  page.status = () => context.HaloOnline.status();
  page.name = () => String.fromCharCode(...page.customizations.at(-1).slice(1).filter(Boolean));
  return page;
}

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const settle = async () => { for (let index = 0; index < 10; index++) await new Promise(resolve => setImmediate(resolve)); };

(async () => {
  /* ---------- the Activity */
  const page = load({ activity: true });
  assert.equal(page.status().view, 'booting');
  page.context.HaloOnline.runtimeReady();
  assert.equal(page.status().view, 'checking');
  await page.tick();

  assert.doesNotMatch(page.elements['online-status'].textContent, /WebRTC|does not support/, 'no WebRTC requirement in the Activity');
  assert(page.fetches.some(url => url === `https://123.discordsays.com/v1/rooms/${ROOM}`), 'the lobby polls its room');
  assert.equal(page.status().view, 'pick', 'nobody hosts yet, so offer hosting');
  assert.equal(page.status().shareUrl, null, 'no invite links in the Activity');
  assert.equal(page.elements['online-dialog'].open, false, 'no shell dialog: the hosted page has its own UI');

  /* A host in its lobby: joined at once, under the Discord name. */
  page.roomHost = 'Alice';
  page.inMatch = true;
  await page.tick();
  assert.equal(page.status().view, 'wait-match', 'a host in a match is waited for');
  assert.equal(page.status().host, 'Alice');
  assert.equal(page.relayOpened, 0);
  page.inMatch = false;
  await page.tick();
  await settle();
  assert.equal(page.signIns, 1, 'a 401 signs in again through the Discord SDK');
  assert.equal(page.relayOpened, 1, 'joined without a confirmation step');
  const guest = page.configured.at(-1);
  assert.equal(guest.transport, 'relay');
  assert.equal(guest.relay.roomId, ROOM);
  assert.equal(guest.relay.role, 'guest');
  assert.equal(guest.relay.url, 'https://123.discordsays.com');
  assert.equal(guest.relay.auth.getToken(), 'session-token');
  assert(!page.fetches.some(url => /auth\/login/.test(url)), 'no OAuth redirect inside the Activity');
  assert.equal(page.status().view, 'joining');
  assert.equal(page.elements['online-dialog'].open, false);

  guest.onRelayPeer({ peerId: 'relay-020000000002', identifier: '020000000002', name: 'Alice', role: 'host' });
  guest.onStateChange({ peerId: 'relay-020000000002', state: 'connected' });
  assert.equal(page.name(), 'Arbiter', 'the Discord name, cleaned up');
  page.gameState = 6;
  page.poll();
  assert.equal(page.status().view, 'joined');
  page.clientState = 3;
  page.poll();
  assert.equal(page.status().view, 'match');
  assert.deepEqual(page.phases, [], 'only the host speaks for the room');

  /* The host left: back to the lobby, with the reason. */
  page.roomHost = null;
  page.gameState = 0;
  page.clientState = 2;
  page.poll();
  await settle();
  await page.tick();
  assert.equal(page.status().view, 'pick', 'leaving returns to the lobby');
  assert.equal(page.status().notice, 'The host left or ended the game.');

  page.timers.length = 0;
  await page.context.HaloOnline.host({ mapIndex: 0, modeIndex: 0 });
  const host = page.configured.at(-1);
  assert.equal(host.relay.role, 'host');
  assert.equal(host.relay.roomId, ROOM, 'the host uses the instance room, not a random one');
  assert.equal(page.timers.length, 0, 'the lobby stops polling while hosting');
  assert.equal(page.status().view, 'host-starting');
  page.gameState = 3;
  page.poll();
  assert.equal(page.status().view, 'hosting');
  assert.equal(page.status().host, 'Arbiter');
  page.clientState = 3;
  page.poll();
  assert.equal(page.status().view, 'match');
  page.clientState = 2;
  page.poll();
  assert.deepEqual(page.phases, [false, true, false], 'the host tells the room when its match starts and ends');

  const before = page.disconnects;
  page.windowListeners.pagehide();
  await settle();
  assert(page.disconnects > before, 'leaving the page (or entering the back/forward cache) closes the room');

  /* ---------- the browser page: the room is in the address */
  const browser = load({ activity: false, user: { id: '9', name: 'Cortana' } });
  browser.context.HaloOnline.runtimeReady();
  await browser.tick();
  const room = new URLSearchParams(browser.location.hash.slice(1)).get('room');
  assert.match(room, /^[A-Za-z0-9_-]{16,64}$/, 'a room made up and put in the address');
  assert(browser.fetches.some(url => url === `https://halo.example/v1/rooms/${room}`));
  assert.equal(browser.status().view, 'pick');
  assert.equal(browser.status().shareUrl, browser.location.href, 'the address is the link to share');
  await browser.context.HaloOnline.host({ mapIndex: 0, modeIndex: 0 });
  assert.equal(browser.configured.at(-1).relay.roomId, room);
  assert.equal(browser.name(), 'Cortana');

  const invited = load({ activity: false, hash: '#room=Shared-Room-0123456789' });
  invited.roomHost = 'Cortana';
  invited.context.HaloOnline.runtimeReady();
  await invited.tick();
  await settle();
  assert.equal(invited.configured.at(-1).relay.roomId, 'Shared-Room-0123456789', 'the address\'s room is joined');
  assert.equal(invited.configured.at(-1).relay.role, 'guest');
  assert.equal(invited.location.hash, '#room=Shared-Room-0123456789', 'the room stays in the address');

  console.log('online_client hosted lobby tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
