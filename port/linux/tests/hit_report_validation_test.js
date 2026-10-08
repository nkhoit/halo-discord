// Builds port/linux/tests/hit_report_validation_test.c against the real code it extracts:
// - port/linux/game/network_damage.c: the grenade throws the host takes grenade damage from (a throw of that type
//   within ten seconds, not gone off: upstream de520606), and the numbers a hit report must carry (finite, in the
//   world, no harder than a blow can be: upstream e7d1ed3a, 0d548798);
// - source/networking/network_server_message_handler.c: names from the wire kept to text that draws (upstream
//   083eef0c).
// CC defaults to cc.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(root, '.halo-hit-report-validation-test-'));

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
  return source.slice(start, end) + (source[end] === ';' ? ';' : '');
}

function line(source, marker) {
  const start = source.indexOf(marker);
  assert(start >= 0, `missing production line: ${marker}`);
  return source.slice(start, source.indexOf('\n', start));
}

try {
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
  const damage = read('port/linux/game/network_damage.c');
  const server = read('source/networking/network_server_message_handler.c');
  fs.writeFileSync(path.join(temp, 'validation.inc'), [
    line(damage, '#define REPORT_WORLD_BOUND'),
    line(damage, '#define REPORT_MAXIMUM_SCALE'),
    block(damage, 'struct distributed_damage\n{'),
    block(damage, 'struct distributed_hit_report\n{'),
    block(damage, 'static short distributed_grenade_throw('),
    block(damage, 'static void distributed_grenade_note('),
    block(damage, 'static boolean distributed_real_valid('),
    block(damage, 'static boolean distributed_point_valid('),
    block(damage, 'static boolean distributed_report_numbers_valid('),
    block(server, 'static void network_game_server_clean_name('),
  ].join('\n\n') + '\n');
  const cc = process.env.CC || 'cc';
  const output = path.join(temp, 'hit-report-validation');
  const build = spawnSync(cc, ['-O2', '-std=gnu99', '-w', '-iquote', temp,
    path.join(__dirname, 'hit_report_validation_test.c'), '-o', output, '-lm'],
    {encoding: 'utf8', shell: process.platform === 'win32'});
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const run = spawnSync(output, [], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stdout + run.stderr);
  console.log(run.stdout.trim());
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
