'use strict';

/* The render cap: the default from the display's refresh rate, a choice made
   with F8 kept in the browser and taking precedence, and ?fpsCap for one
   visit. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'online_client.js'), 'utf8');

function element() {
  const listeners = {};
  return {
    dataset: {}, hidden: false, options: [], value: '', textContent: '', style: {},
    addEventListener(type, listener) { listeners[type] = listener; },
    appendChild() {}, close() {}, focus() {}, removeAttribute() {}, select() {},
    setAttribute(name, value) { this[name] = String(value); }, showModal() {},
    querySelectorAll: () => [], querySelector: () => null, listeners,
  };
}

function load({ refreshHz, stored, search = '', interval }) {
  const elements = {};
  const storage = new Map(stored === undefined ? [] : [['halo-frame-cap', String(stored)]]);
  const listeners = {};
  const frames = [];
  const caps = [];
  let cap = 0;
  const context = {
    console,
    document: {
      readyState: 'complete',
      body: { appendChild() {} },
      createElement: () => element(),
      getElementById: id => elements[id] || (elements[id] = element()),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    addEventListener: (type, listener) => { listeners[type] = listener; },
    requestAnimationFrame: callback => { frames.push(callback); },
    localStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, value),
    },
    location: { hash: '', hostname: 'halo.example', href: 'https://halo.example/halo.html' + search,
      origin: 'https://halo.example', pathname: '/halo.html', search },
    Module: {
      _platform_web_frame_cap: () => cap,
      _platform_web_set_frame_cap: value => { cap = value; caps.push(value); },
      _platform_web_online_get_state: () => 0,
      _platform_web_online_get_error: () => 0,
    },
    HaloWebTransport: { configure() {}, disconnectAll() {}, isSupported: () => true },
    history: { replaceState() {} },
    navigator: {},
    URL, URLSearchParams,
    clearTimeout() {}, setTimeout: () => 0, clearInterval() {}, setInterval: () => 0,
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'online_client.js' });
  try {
    context.HaloOnline.runtimeReady();
  } catch (error) {
    /* (the rest of the lobby needs a fuller page; the cap is set up first) */
  }
  /* animation frames at the display's rate (or the given intervals) */
  let time = 0;
  for (let i = 0; i <= 120 && frames.length; i++) {
    frames.shift()(time);
    time += interval ? interval(i) : 1000 / refreshHz;
  }
  return { context, storage, caps, listeners, cap: () => cap };
}

const { defaultFrameCap } = load({ refreshHz: 60 }).context.HaloOnline;
assert.equal(defaultFrameCap(60), 0);
assert.equal(defaultFrameCap(144), 0);
assert.equal(defaultFrameCap(165), 0);
assert.equal(defaultFrameCap(240), 120);
assert.equal(defaultFrameCap(239.76), 120);
assert.equal(defaultFrameCap(360), 120);
assert.equal(defaultFrameCap(200), 100);

/* a 240 Hz display renders at 120 by default; nothing is stored */
let page = load({ refreshHz: 240 });
assert.equal(page.cap(), 120);
assert.equal(page.storage.has('halo-frame-cap'), false);

/* a busy start-up that missed most frames still finds 240 Hz */
page = load({ refreshHz: 240, interval: i => (i % 5 ? 2 : 1) * 1000 / 240 });
assert.equal(page.cap(), 120);

/* F8 cycles from there and keeps the choice */
page.listeners.keydown({ key: 'F8', repeat: false });
assert.equal(page.cap(), 60);
assert.equal(page.storage.get('halo-frame-cap'), '60');
page.listeners.keydown({ key: 'F8', repeat: false });
assert.equal(page.cap(), 0);
assert.equal(page.storage.get('halo-frame-cap'), '0');

/* a kept choice wins over the default, "off" included */
page = load({ refreshHz: 240, stored: 0 });
assert.equal(page.cap(), 0);
page = load({ refreshHz: 60, stored: 120 });
assert.equal(page.cap(), 120);

/* a 60 Hz display is left alone; ?fpsCap sets a cap for the visit only */
page = load({ refreshHz: 60 });
assert.equal(page.cap(), 0);
page = load({ refreshHz: 240, search: '?fpsCap=60' });
assert.equal(page.cap(), 60);
assert.equal(page.storage.has('halo-frame-cap'), false);

console.log('online_client_frame_cap_test: ok');
