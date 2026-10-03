// Builds port/linux/tests/network_late_join_gate_test.c against the real
// predicate the server's broadcasts use to skip a machine loading a match in
// progress (network_server_manager.c), and checks that the broadcast loops in
// network_server_message_handler.c go through it, and the pregame lobby's
// directions line (ui_widget_game_data_input_functions.c). CC defaults to cc; with
// CC=emcc the test runs under node.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(root, '.halo-late-join-test-'));

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
  const manager = fs.readFileSync(path.join(root, 'source/networking/network_server_manager.c'), 'utf8')
    .replace(/\r\n/g, '\n');
  fs.writeFileSync(path.join(temp, 'late_join_enums.inc'), [
    'enum\n{\n' + lines(manager, '_network_client_machine_connected_bit = 0,', 'NUMBER_OF_NETWORK_CLIENT_MACHINE_FLAGS,') + '\n};',
    'enum\n{\n' + lines(manager, '_network_game_server_state_pregame,', 'NUMBER_OF_NETWORK_GAME_SERVER_STATES') + '\n};',
  ].join('\n\n') + '\n');
  fs.writeFileSync(path.join(temp, 'late_join_gate.inc'), [
    block(manager, 'boolean network_game_join_in_progress_enabled('),
    block(manager, 'static boolean network_game_server_late_joins_enabled('),
    block(manager, 'boolean network_game_server_client_machine_is_loading_in_game('),
    block(manager, 'boolean network_game_server_client_machine_is_spectator('),
    block(manager, 'void network_game_server_set_client_machine_spectator('),
    block(manager, 'long network_game_server_spectator_count('),
    block(manager, 'boolean network_game_server_joinable_in_game('),
    block(manager, 'boolean network_game_server_watchable_in_game('),
    block(manager, 'boolean server_needs_more_teams('),
    block(manager, 'boolean server_has_a_player_on_each_machine('),
    block(manager, 'boolean server_has_enough_machines('),
    block(manager, 'boolean server_ok_to_countdown('),
  ].join('\n\n') + '\n');
  assert.match(manager, /MAXIMUM_SPECTATOR_MACHINES = 8,/, 'the spectator limit the test assumes');
  const globals = fs.readFileSync(path.join(root, 'source/networking/network_game_globals.c'), 'utf8')
    .replace(/\r\n/g, '\n');
  fs.writeFileSync(path.join(temp, 'late_join_spectator_mark.inc'), [
    'enum\n{\n' + lines(globals, 'NETWORK_SPECTATOR_MACHINE_NAME_MARK =', '0x5350,') + '\n};',
    block(globals, 'void network_game_mark_spectator_machine_name('),
    block(globals, 'boolean network_game_machine_name_marks_spectator('),
  ].join('\n\n') + '\n');
  const engine = fs.readFileSync(path.join(root, 'source/game/game_engine.c'), 'utf8').replace(/\r\n/g, '\n');
  fs.writeFileSync(path.join(temp, 'late_join_end.inc'), block(engine, 'boolean game_engine_should_end_game(') + '\n');
  const ui = fs.readFileSync(path.join(root, 'source/interface/ui_widget_game_data_input_functions.c'), 'utf8')
    .replace(/\r\n/g, '\n');
  fs.writeFileSync(path.join(temp, 'late_join_lobby_text.inc'), [
    block(ui, 'enum multiplayer_game_text_string') + ';',
    block(ui, 'void multiplayer_game_directions('),
  ].join('\n\n') + '\n');

  /* the three broadcasts (unreliable and reliable per-tick state, and the
     game's own messages) reach a machine by that predicate alone */
  const handler = fs.readFileSync(path.join(root, 'source/networking/network_server_message_handler.c'), 'utf8')
    .replace(/\r\n/g, '\n');
  for (const name of ['boolean network_distributed_server_send_to_all(',
    'boolean network_distributed_server_send_to_all_reliably(',
    'boolean network_game_server_send_message_to_all_machines(']) {
    assert.match(block(handler, name),
      /if \(network_game_server_client_machine_is_joined_to_game\(server, machine\)\n#ifdef HALO_LINUX\n\t+&& !network_game_server_client_machine_is_loading_in_game\(server, machine\)\n#endif\n\t+\)/,
      `${name} picks machines by the late-join predicate`);
  }

  const cc = process.env.CC || 'cc';
  const web = /emcc/.test(path.basename(cc));
  const output = path.join(temp, web ? 'late-join-test.js' : 'late-join-test');
  const build = spawnSync(cc, ['-O2', '-std=gnu99', '-w', '-DHALO_LINUX', '-iquote', temp,
    path.join(__dirname, 'network_late_join_gate_test.c'), '-o', output],
    {encoding: 'utf8', shell: process.platform === 'win32'});
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const run = spawnSync(web ? process.execPath : output, web ? [output] : [], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stdout + run.stderr);
  console.log(run.stdout.trim());
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
