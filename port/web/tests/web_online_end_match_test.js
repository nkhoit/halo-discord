// Builds port/web/src/web_online_ui.c with the host End match mailbox and
// checks it calls game_engine_end_game only for a running hosted match.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-end-match-'));

try {
  const engine = fs.readFileSync(path.join(root, 'source/game/game_engine.c'), 'utf8');
  const slayer = fs.readFileSync(path.join(root, 'source/game/game_engine_slayer.c'), 'utf8');
  assert.match(engine, /void game_engine_end_game\(\s*void\)/, 'the shared end-of-match function');
  assert.match(slayer, /game_engine_end_game\(\);/, 'a score limit ends through game_engine_end_game');
  assert.match(
    fs.readFileSync(path.join(root, 'port/linux/game/network_test.c'), 'utf8'),
    /game_engine_end_game\(\);/,
    'the lab host end uses the same call',
  );

  const stub = path.join(temp, 'emscripten');
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, 'emscripten.h'), '#define EMSCRIPTEN_KEEPALIVE\n');

  const cc = process.env.CC || 'cc';
  const output = path.join(temp, 'end-match-test');
  const build = spawnSync(cc, [
    '-std=c11', '-Wall', '-Wextra', '-Wno-unused-parameter',
    `-I${path.join(root, 'port/web/src')}`,
    `-I${temp}`,
    path.join(root, 'port/web/src/web_online_ui.c'),
    path.join(__dirname, 'web_online_end_match_test.c'),
    '-o', output,
  ], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const run = spawnSync(output, [], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /web online end match tests passed/);
  console.log(run.stdout.trim());
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
