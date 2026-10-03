// Builds port/linux/tests/msvc_wide_test.c against the real msvc_wide.c and
// ui_widget.c code, at -O2 -fshort-wchar as the game is built, and runs it.
// CC defaults to cc; with CC=emcc the test runs under node.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(root, '.halo-wide-test-'));

function between(source, start, end) {
  const from = source.indexOf(start);
  assert(from >= 0, `missing: ${start}`);
  const to = source.indexOf(end, from);
  assert(to >= 0, `missing: ${end}`);
  return source.slice(from, to + end.length);
}

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
  const wide = fs.readFileSync(path.join(root, 'port/linux/src/msvc_wide.c'), 'utf8').replace(/\r\n/g, '\n');
  fs.writeFileSync(path.join(temp, 'msvc_wide.inc'), [
    between(wide, '#if defined(__clang__)\n#define WIDE_NO_BUILTIN', '#endif'),
    block(wide, 'WIDE_NO_BUILTIN size_t msvc_wcslen'),
    block(wide, 'static int is_latin1_upper'),
    block(wide, 'static int is_latin1_lower'),
    block(wide, 'wint_t msvc_towlower'),
    block(wide, 'int msvc_wcsnicmp'),
    '#define wcslen msvc_wcslen',
    'typedef int BOOL;\n#define TRUE 1\n#define FALSE 0',
    block(wide, 'static size_t narrow_to_wide'),
    between(wide, '/* ---------- formatted output */', 'int msvc_vswprintf').replace(/int msvc_vswprintf$/, ''),
  ].join('\n\n') + '\n');
  const widget = fs.readFileSync(path.join(root, 'source/interface/ui_widget.c'), 'utf8').replace(/\r\n/g, '\n');
  const names = between(widget, 'static wchar_t const *icon_names[NUMBER_OF_ICON_TYPES] =', '};')
    .replace('[NUMBER_OF_ICON_TYPES]', '[]');
  const functions = widget.split('static short get_icon_type(\n\twchar_t const *string)\n{');
  assert(functions.length >= 2, 'missing get_icon_type');
  fs.writeFileSync(path.join(temp, 'icon_names.inc'),
    names + '\n\nstatic short get_icon_type(\n\twchar_t const *string)\n' +
    block('{' + functions[functions.length - 1], '{') + '\n');

  const cc = process.env.CC || 'cc';
  const web = /emcc/.test(path.basename(cc));
  const output = path.join(temp, web ? 'wide-test.js' : 'wide-test');
  const build = spawnSync(cc, ['-O2', '-fshort-wchar', '-std=gnu11', '-fms-extensions', '-fno-strict-aliasing', '-fwrapv',
    '-fno-delete-null-pointer-checks', '-ffp-contract=off', '-w', '-iquote', temp,
    path.join(__dirname, 'msvc_wide_test.c'), '-o', output], {encoding: 'utf8', shell: process.platform === 'win32'});
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const run = spawnSync(web ? process.execPath : output, web ? [output] : [], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stdout + run.stderr);
  console.log(run.stdout.trim());
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
