// Builds port/linux/tests/dsound_decode_test.c against the real Xbox ADPCM decoder and 3D gains of
// port/linux/src/dsound_sdl.c (extracted from the source):
// - an Xbox ADPCM block's header holds its first sample and its nibbles code the 63 after it (the 64th pads):
//   a decoder reproduces an encoder's samples exactly, mono and stereo;
// - 3D distances are in the game's units, as its minimum and maximum distances are: the distance factor
//   (SetDistanceFactor, 3.048 in the game) does not scale them.
// CC defaults to cc.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(root, '.halo-dsound-decode-test-'));

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

function between(source, from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert(start >= 0 && end > start, `missing production text: ${from}`);
  return source.slice(start, end);
}

try {
  const source = fs.readFileSync(path.join(root, 'port/linux/src/dsound_sdl.c'), 'utf8').replace(/\r\n/g, '\n');
  fs.writeFileSync(path.join(temp, 'dsound_decode.inc'), [
    between(source, '/* the listener, in DirectSound', 'static float configured_master_volume'),
    between(source, 'static const int ima_index_table', '/* Xbox ADPCM'),
    block(source, 'static short *decode_adpcm('),
    block(source, 'static float dot3('),
    block(source, 'static void spatialize('),
  ].join('\n\n') + '\n');
  const cc = process.env.CC || 'cc';
  const output = path.join(temp, 'dsound-decode');
  const build = spawnSync(cc, ['-O2', '-std=gnu99', '-w', '-iquote', temp,
    path.join(__dirname, 'dsound_decode_test.c'), '-o', output, '-lm'],
    {encoding: 'utf8', shell: process.platform === 'win32'});
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const run = spawnSync(output, [], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stdout + run.stderr);
  console.log(run.stdout.trim());
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
