// Builds port/linux/tests/feel_sample_test.c against the real feel series of
// port/linux/game/network_distributed.c (the browser builds' netstats feel:
// fire latency, hit confirms, other players' corrections), extracted from the
// source. CC defaults to cc; with CC=emcc the test runs under node.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(root, '.halo-feel-sample-test-'));

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
  const source = fs.readFileSync(path.join(root, 'port/linux/game/network_distributed.c'), 'utf8')
    .replace(/\r\n/g, '\n');
  const samples = source.match(/#define WEB_FEEL_SAMPLES \d+/);
  assert(samples, 'missing WEB_FEEL_SAMPLES');
  const state = source.match(/static unsigned long web_feel_random_state = [^;]+;/);
  assert(state, 'missing web_feel_random_state');
  fs.writeFileSync(path.join(temp, 'feel_series.inc'), [
    samples[0],
    block(source, 'struct web_feel_series\n{') + ';',
    state[0],
    block(source, 'static unsigned long web_feel_random(\n'),
    block(source, 'static void web_feel_sample(\n'),
    block(source, 'static int web_feel_compare('),
    block(source, 'static void web_feel_take(\n'),
  ].join('\n\n') + '\n');

  const cc = process.env.CC || 'cc';
  const web = /emcc/.test(path.basename(cc));
  const output = path.join(temp, web ? 'feel-sample-test.js' : 'feel-sample-test');
  const build = spawnSync(cc, ['-O2', '-std=gnu99', '-w', '-iquote', temp,
    path.join(__dirname, 'feel_sample_test.c'), '-o', output],
    {encoding: 'utf8', shell: process.platform === 'win32'});
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const run = spawnSync(web ? process.execPath : output, web ? [output] : [], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stdout + run.stderr);
  console.log(run.stdout.trim());
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}