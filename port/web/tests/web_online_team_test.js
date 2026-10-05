// Builds port/web/src/web_online_ui.c with the lobby team mailbox and checks
// a choice is accepted only in pregame, then applied on the game thread.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-team-'));

try {
  const client = fs.readFileSync(path.join(root, 'source/networking/network_client_manager.c'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'port/web/src/web_online_ui.c'), 'utf8');
  assert.match(client, /client->state != _network_game_client_state_pregame/,
    'the engine team change itself is pregame-only');
  assert.match(ui, /EMSCRIPTEN_KEEPALIVE int platform_web_online_set_team\(int team_index\)/);
  assert.match(ui, /network_game_client_get_state\(client, NULL\) != _network_client_pregame/);
  assert.match(ui, /network_game_client_set_team\(\(char\)team\)/);
  assert.match(ui, /EMSCRIPTEN_KEEPALIVE int platform_web_online_switch_team\(int team_index\)/);
  assert.match(ui, /network_game_client_request_team_switch\(\(char\)team\)/);
  assert.match(client, /boolean network_game_client_request_team_switch/,
    'mid-match team switch is a separate client request');
  assert.match(client, /unit_kill_no_statistics/,
    'a mid-match switch kills without suicide/kill credit');

  const stub = path.join(temp, 'emscripten');
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, 'emscripten.h'), '#define EMSCRIPTEN_KEEPALIVE\n');

  const cc = process.env.CC || 'cc';
  const output = path.join(temp, 'team-test');
  const build = spawnSync(cc, [
    '-std=c11', '-Wall', '-Wextra', '-Wno-unused-parameter',
    `-I${path.join(root, 'port/web/src')}`,
    `-I${temp}`,
    path.join(root, 'port/web/src/web_online_ui.c'),
    path.join(__dirname, 'web_online_team_test.c'),
    '-o', output,
  ], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const run = spawnSync(output, [], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /web online team tests passed/);
  console.log(run.stdout.trim());
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
