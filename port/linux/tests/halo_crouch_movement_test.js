const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync, execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(root, '.halo-crouch-test-'));
function block(source, marker) {
 const start = source.indexOf(marker);
 assert(start >= 0, `missing production block: ${marker}`);
 let depth = 0, end = source.indexOf('{', start);
 do { if (source[end] === '{') depth++; if (source[end] === '}') depth--; end++; } while (depth > 0 && end < source.length);
 assert.equal(depth, 0);
 return source.slice(start, end);
}
function section(source, start, end) {
 const i = source.indexOf(start), j = source.indexOf(end, i);
 assert(i >= 0 && j > i, `missing production section: ${start}`);
 return source.slice(i, j);
}
function compile(name, linux = true, web = false) {
 const binary = path.join(temp, name);
 const args = ['-std=c99', '-Wall', '-Wextra', '-Werror', ...(linux ? ['-DHALO_LINUX'] : []), ...(web ? ['-DHALO_WEB'] : []),
  '-iquote', path.join(root, 'port/linux/include'), '-iquote', temp,
  path.join(__dirname, 'halo_crouch_movement_test.c'), '-pthread', '-lm', '-o', binary];
 const r = spawnSync(process.env.CC || 'cc', args, {encoding: 'utf8'});
 assert.equal(r.status, 0, r.stdout + r.stderr);
 return binary;
}
function run(binary, args = []) {
 const r = spawnSync(binary, args, {encoding: 'utf8'});
 assert.equal(r.status, 0, r.stdout + r.stderr);
 console.log(r.stdout.trim());
}
try {
 const read = p => fs.readFileSync(path.join(root, p), 'utf8');
 const xinput = read('port/linux/src/xinput_sdl.c');
 const functions = ['unsigned halo_linux_keyboard_movement_axes', 'static void aim_look_states_initialize_locked',
  'static void aim_look_reset_port_locked', 'static void aim_look_update_gamepad_locked',
  'int halo_linux_camera_assist_enabled', 'static void mouse_poll', 'static BYTE analog',
  'static void keyboard_gamepad', 'void test_input_hold_action', 'static int test_input_seed',
  'static int test_input_ports', 'static int test_input_gamepad',
  'static SHORT stick', 'static void merge_button', 'static void sdl_gamepad_state',
  'HANDLE WINAPI XInputOpen', 'VOID WINAPI XInputClose', 'static int controller_port', 'DWORD WINAPI XInputGetState'];
 fs.writeFileSync(path.join(temp, 'xinput_movement.inc'),
  section(xinput, '/* The keys and mouse buttons of each of the controller\'s controls', 'static BOOL input_control_down(') +
  block(xinput, 'static BOOL input_control_down(') + '\n' +
  functions.map(m => block(xinput, m)).join('\n'));
 const abstraction = read('source/input/input_abstraction.c');
 fs.writeFileSync(path.join(temp, 'movement_policy.inc'), block(abstraction, 'boolean input_abstraction_keyboard_crouch_enabled'));
 fs.writeFileSync(path.join(temp, 'movement_mapping.inc'), section(abstraction, '\t\t\t{\n\t\t\t\treal scale;', 'input_abstraction_globals.controller_available[controller_index] = TRUE;'));
 fs.writeFileSync(path.join(temp, 'stick_constants.inc'), section(abstraction, '#define STICK_DIAGONAL_ANGLE', '/* ---------- macros */'));
 fs.writeFileSync(path.join(temp, 'dead_zone.inc'), block(read('source/input/input_xbox.c'), 'short fix_dead_zone'));
 fs.writeFileSync(path.join(temp, 'biped_speed.inc'), section(read('source/units/bipeds.c'), '\t\t\t\tcrouch = biped->biped.crouch;', 'physics.airborne_acceleration_maximum ='));
 const player = read('source/game/player_control.c');
 assert.match(player, /boolean controls_enable_crouch = FALSE;/);
 assert.match(read('source/input/input_abstraction.h'), /boolean input_abstraction_keyboard_crouch_enabled\(/);
 assert.match(xinput, /#include "halo_movement_source.h"/);
 assert.match(abstraction, /#include "halo_movement_source.h"/);
 assert.match(read('.github/workflows/ci.yml'), /node --test port\/linux\/tests\/halo_crouch_movement_test\.js/);
 // Optional local red proof: fetch the exact requested base block from Git.
 // The rest of the same production-input harness stays unchanged.
 if (process.env.HALO_CROUCH_BASELINE) {
  const base = execFileSync('git', ['show', `${process.env.HALO_CROUCH_BASELINE}:source/game/player_control.c`], {cwd: root, encoding: 'utf8'});
  fs.writeFileSync(path.join(temp, 'player_crouch.inc'), block(base, 'if (biped &&'));
  const red = spawnSync(compile('baseline'), [], {encoding: 'utf8'});
  assert.equal(red.status, 1, red.stdout + red.stderr);
  assert.match(red.stderr, /FAIL: keyboard crouch direction/);
  console.log(`BASELINE RED (${process.env.HALO_CROUCH_BASELINE} actual crouch block): ${red.stderr.trim()}`);
 }
 fs.writeFileSync(path.join(temp, 'player_crouch.inc'), block(player, 'if (biped &&'));
 const binary = compile('movement');
 run(binary);
 run(binary, ['--bot']);
 run(compile('web-input', true, true));
 run(compile('xbox', false), ['--xbox']);
} finally { fs.rmSync(temp, {recursive: true, force: true}); }
