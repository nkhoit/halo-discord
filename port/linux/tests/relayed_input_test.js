// Builds port/linux/tests/relayed_input_test.c against the real replay of
// the host's relayed updates in source/game/player_queues_new.c (a client
// of the distributed netcode). CC defaults to cc; with CC=emcc the test runs
// under node.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(root, '.halo-relayed-input-test-'));

function lines(source, first, last) {
  const from = source.indexOf(first);
  assert(from >= 0, `missing: ${first}`);
  const to = source.indexOf(last, from);
  assert(to >= 0, `missing: ${last}`);
  return source.slice(from, to + last.length);
}

try {
  const queues = fs.readFileSync(path.join(root, 'source/game/player_queues_new.c'), 'utf8').replace(/\r\n/g, '\n');
  fs.writeFileSync(path.join(temp, 'relayed_input.inc'), lines(queues,
    '/* the distributed netcode (port/linux/NETCODE.md): the action a client\'s',
    '\t\tupdate_client_relayed_queue.window_ticks = 0;\n\t}\n}\n') + '\n');
  const cc = process.env.CC || 'cc';
  const web = /emcc/.test(path.basename(cc));
  const output = path.join(temp, web ? 'relayed-input-test.js' : 'relayed-input-test');
  const build = spawnSync(cc, ['-O2', '-std=gnu99', '-w', '-iquote', temp,
    path.join(__dirname, 'relayed_input_test.c'), '-o', output],
    {encoding: 'utf8', shell: process.platform === 'win32'});
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const run = spawnSync(web ? process.execPath : output, web ? [output] : [], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stdout + run.stderr);
  console.log(run.stdout.trim());
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
