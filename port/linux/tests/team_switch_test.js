// Builds port/linux/tests/team_switch_test.c against the real mid-match team
// switch (network_client_manager.c network_game_team_switch_balance_ok and
// network_game_apply_team_switch), extracted from the source. CC defaults to
// cc; with CC=emcc the test runs under node.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(root, '.halo-team-switch-test-'));

function block(source, marker) {
  const start = source.indexOf(marker);
  assert(start >= 0, `missing production block: ${marker}`);
  let depth = 0;
  let end = source.indexOf('{', start);
  do {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  } while (depth > 0 && end < source.length);
  assert.equal(depth, 0);
  return source.slice(start, end);
}

try {
  const manager = fs.readFileSync(path.join(root, 'source/networking/network_client_manager.c'), 'utf8')
    .replace(/\r\n/g, '\n');
  fs.writeFileSync(path.join(temp, 'team_switch.inc'), [
    block(manager, 'boolean network_game_team_switch_balance_ok(\n'),
    block(manager, 'boolean network_game_apply_team_switch(\n'),
  ].join('\n\n') + '\n');

  const cc = process.env.CC || 'cc';
  const web = /emcc/.test(path.basename(cc));
  const output = path.join(temp, web ? 'team-switch-test.js' : 'team-switch-test');
  const build = spawnSync(cc, ['-O2', '-std=gnu99', '-w', '-iquote', temp,
    path.join(__dirname, 'team_switch_test.c'), '-o', output],
    {encoding: 'utf8', shell: process.platform === 'win32'});
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const run = spawnSync(web ? process.execPath : output, web ? [output] : [], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stdout + run.stderr);
  console.log(run.stdout.trim());
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
