// Builds port/linux/tests/spectator_view_test.c against the real view scope
// of port/linux/game/spectator.c (a spectator's target standing in as local
// player 0 while it is drawn) and the netcode's own-player predicate of
// port/linux/game/network_distributed.c. CC defaults to cc; with CC=emcc the
// test runs under node.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(root, '.halo-spectator-test-'));

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

function lines(source, first, last) {
  const from = source.indexOf(first);
  assert(from >= 0, `missing: ${first}`);
  const to = source.indexOf(last, from);
  assert(to >= 0, `missing: ${last}`);
  return source.slice(from, to + last.length);
}

try {
  const spectator = fs.readFileSync(path.join(root, 'port/linux/game/spectator.c'), 'utf8').replace(/\r\n/g, '\n');
  const distributed = fs.readFileSync(path.join(root, 'port/linux/game/network_distributed.c'), 'utf8')
    .replace(/\r\n/g, '\n');
  fs.writeFileSync(path.join(temp, 'spectator_view.inc'), [
    lines(spectator, 'enum spectator_view\n{', '};'),
    lines(spectator, '/* the target, a tick */\nstruct spectator_snapshot', '};'),
    lines(spectator, 'static struct\n{\n\tboolean checked;', '} spectator = { 0 };'),
    block(spectator, 'boolean spectator_view_begin('),
    block(spectator, 'void spectator_view_end('),
    block(spectator, 'boolean spectator_view_scoped('),
    block(spectator, 'boolean spectator_first_person_view('),
    block(spectator, 'short spectator_first_person_slot('),
    block(distributed, 'boolean distributed_player_is_local('),
  ].join('\n\n') + '\n');
  const cc = process.env.CC || 'cc';
  const web = /emcc/.test(path.basename(cc));
  const output = path.join(temp, web ? 'spectator-test.js' : 'spectator-test');
  const build = spawnSync(cc, ['-O2', '-std=gnu99', '-w', '-iquote', temp,
    path.join(__dirname, 'spectator_view_test.c'), '-o', output],
    {encoding: 'utf8', shell: process.platform === 'win32'});
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const run = spawnSync(web ? process.execPath : output, web ? [output] : [], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stdout + run.stderr);
  console.log(run.stdout.trim());
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
