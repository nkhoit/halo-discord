'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'storage_lock.js'), 'utf8');

/* Loads storage_lock.js into a page whose Web Locks share one held set, so
two loads model two tabs in one browser profile. */
function loadPage(held, options = {}) {
  const dependencies = new Set();
  const context = {
    window: {},
    performance: { now: () => 1234 },
    ENVIRONMENT_IS_PTHREAD: !!options.pthread,
    Module: {},
    navigator: options.noLocks ? {} : {
      locks: options.locks || {
        request(name, opts, callback) {
          assert.equal(opts.ifAvailable, true);
          const free = !held.has(name);
          if (free) held.add(name);
          const result = callback(free ? { name } : null);
          if (free && !(result && typeof result.then === 'function')) held.delete(name);
          return Promise.resolve(result);
        },
      },
    },
    addRunDependency: id => dependencies.add(id),
    removeRunDependency: id => dependencies.delete(id),
  };
  vm.runInNewContext(source, context);
  for (const callback of context.Module.preRun || []) callback();
  return { Module: context.Module, dependencies, boot: () => JSON.parse(JSON.stringify(context.window.HaloBootEvents || [])) };
}

const held = new Set();
const first = loadPage(held);
assert.equal(first.Module.haloStorageExclusive, true);
assert.equal(first.dependencies.size, 0, 'the lock answer must release the run dependency');
assert(held.has('halo-storage'), 'the first copy must keep the lock while it runs');
assert.deepEqual(first.boot(), [['storage', 1234, { mode: 'opfs', lock: 'granted' }]],
  'the start-up report learns the storage and the lock\'s answer');

const second = loadPage(held);
assert.equal(second.Module.haloStorageExclusive, false,
  'a second copy in the same profile must fall back to in-memory storage');
assert.equal(second.dependencies.size, 0);
assert.deepEqual(second.boot()[0][2], { mode: 'memory', lock: 'held' });

const otherProfile = loadPage(new Set());
assert.equal(otherProfile.Module.haloStorageExclusive, true);

const noLocks = loadPage(new Set(), { noLocks: true });
assert.equal(noLocks.Module.haloStorageExclusive, true,
  'browsers without Web Locks keep the previous OPFS behaviour');
assert.deepEqual(noLocks.boot()[0][2], { mode: 'opfs', lock: 'none' });

const worker = loadPage(new Set(), { pthread: true });
assert.equal(worker.Module.preRun, undefined, 'pthread workers must not take the lock');

for (const [label, locks] of [
  ['rejects', { request: () => Promise.reject(new Error('SecurityError')) }],
  ['throws', { request() { throw new Error('SecurityError'); } }],
]) {
  const refused = loadPage(new Set(), { locks });
  setImmediate(() => {
    assert.equal(refused.dependencies.size, 0,
      `a lock request that ${label} must still release startup`);
    assert.equal(refused.Module.haloStorageExclusive, true);
    assert.deepEqual(refused.boot()[0][2], { mode: 'opfs', lock: 'refused' });
  });
}
