// Builds port/linux/tests/compact_input_test.c against the real compact input
// codec of source/networking/network_messages.c, and checks that only the
// browser builds use it: every line naming it (and the quantizing at the
// source, player_queues_new.c) lies in a HALO_WEB branch, and the native
// builds still encode the game update as they did. CC defaults to cc; with
// CC=emcc the test runs under node.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(root, '.halo-compact-input-test-'));

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
}

function lines(source, first, last) {
  const from = source.indexOf(first);
  assert(from >= 0, `missing: ${first}`);
  const to = source.indexOf(last, from);
  assert(to >= 0, `missing: ${last}`);
  return source.slice(from, to + last.length);
}

/* the lines of a file only the browser builds compile: inside the
#ifdef HALO_WEB branch, or the #else of #ifndef HALO_WEB */
function webOnlyLines(source) {
  const stack = [];
  const webNow = () => stack.some(entry =>
    (entry.kind === 'web' && !entry.inElse) || (entry.kind === 'not-web' && entry.inElse));
  return source.split('\n').map(line => {
    const directive = line.trim();
    if (/^#\s*if/.test(directive)) {
      stack.push({kind: /^#\s*ifdef\s+HALO_WEB\b/.test(directive) ? 'web' :
        /^#\s*ifndef\s+HALO_WEB\b/.test(directive) ? 'not-web' : 'other', inElse: false});
    } else if (/^#\s*else/.test(directive) && stack.length) {
      stack[stack.length - 1].inElse = true;
    } else if (/^#\s*endif/.test(directive)) {
      stack.pop();
    }
    return {line, web: webNow()};
  });
}

try {
  const messages = read('source/networking/network_messages.c');
  const queues = read('source/game/player_queues_new.c');
  const players = read('source/game/players.h');

  for (const [file, source] of [['network_messages.c', messages], ['player_queues_new.c', queues]]) {
    for (const {line, web} of webOnlyLines(source)) {
      if (/compact_|web_quantize_player_action/.test(line) && !/^\s*(\/\*|\*)/.test(line)) {
        assert(web, `${file}: the compact input outside HALO_WEB: ${line.trim()}`);
      }
    }
  }
  /* the native builds' game update is still the game's own encoding */
  const encode = webOnlyLines(messages).filter(entry => !entry.web &&
    /return data_packet_group_encode_packet\(/.test(entry.line));
  assert(encode.length > 0, 'network_messages.c: the native encoding');
  assert(webOnlyLines(queues).some(entry => entry.web && /web_quantize_player_action\(&/.test(entry.line)),
    'player_queues_new.c: the source quantizes its input');

  fs.writeFileSync(path.join(temp, 'compact_input.inc'), [
    /* (unsigned long is 32 bits where the game runs; a 64-bit host's long is not) */
    lines(players, 'struct player_action\n{', '};').replace('unsigned long control_flags', 'unsigned int control_flags'),
    lines(messages, 'enum\n{\n\t_compact_input_buttons_bit = 0,', '\treturn read == size;\n}'),
  ].join('\n\n') + '\n');
  const cc = process.env.CC || 'cc';
  const web = /emcc/.test(path.basename(cc));
  const output = path.join(temp, web ? 'compact-input-test.js' : 'compact-input-test');
  const build = spawnSync(cc, ['-O2', '-std=gnu99', '-w', '-iquote', temp,
    path.join(__dirname, 'compact_input_test.c'), '-o', output, '-lm'],
    {encoding: 'utf8', shell: process.platform === 'win32'});
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const run = spawnSync(web ? process.execPath : output, web ? [output] : [], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stdout + run.stderr);
  console.log(run.stdout.trim());
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
