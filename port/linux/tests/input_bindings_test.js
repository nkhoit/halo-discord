// Builds port/linux/tests/input_bindings_test.c against the real keyboard and
// mouse bindings in port/linux/src/xinput_sdl.c (defaults, input.bindings,
// the web page's staging, the mouse's live settings), native and as the web
// build compiles them.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(root, '.halo-bindings-test-'));

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

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert(from >= 0 && to > from, `missing production section: ${start}`);
  return source.slice(from, to);
}

function run(name, web) {
  const cc = process.env.CC || 'cc';
  const emcc = /emcc/.test(path.basename(cc));
  const output = path.join(temp, name + (emcc ? '.js' : ''));
  const build = spawnSync(cc, ['-std=c99', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function',
    ...(web ? ['-DHALO_WEB'] : []), '-iquote', temp, path.join(__dirname, 'input_bindings_test.c'), '-o', output],
    {encoding: 'utf8', shell: process.platform === 'win32'});
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const result = spawnSync(emcc ? process.execPath : output, emcc ? [output] : [], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  console.log(`${web ? 'web' : 'native'}: ${result.stdout.trim()}`);
}

try {
  const xinput = fs.readFileSync(path.join(root, 'port/linux/src/xinput_sdl.c'), 'utf8').replace(/\r\n/g, '\n');
  fs.writeFileSync(path.join(temp, 'bindings.inc'), [
    section(xinput, '/* input.mouse_sensitivity and input.invert_mouse', 'int halo_linux_camera_assist_enabled'),
    block(xinput, 'static BYTE analog('),
    section(xinput, '/* The keys and mouse buttons of each of the controller\'s controls', 'static BOOL input_control_down('),
    block(xinput, 'static BOOL input_control_down('),
    '#ifdef HALO_WEB',
    section(xinput, 'static struct input_binding web_staged_bindings', 'static void keyboard_gamepad('),
    block(xinput, 'static void keyboard_gamepad('),
  ].join('\n\n') + '\n');
  run('native', false);
  run('web', true);
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
