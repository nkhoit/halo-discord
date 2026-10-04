// Builds port/linux/tests/compact_messages_test.c against the real compact
// message codecs of port/linux/game/network_distributed.c and
// network_objects.c, and checks that only the browser builds use them: every
// line naming a compact form lies in a HALO_WEB branch, and the native
// builds' sends are still there. CC defaults to cc; with CC=emcc the test
// runs under node.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(root, '.halo-compact-messages-test-'));

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
  const distributed = read('port/linux/game/network_distributed.c');
  const objects = read('port/linux/game/network_objects.c');
  const server = read('source/networking/network_server_message_handler.c');

  /* only the browser builds name the compact forms, or send a machine's own
  players' states less often */
  for (const [file, source] of [['network_distributed.c', distributed], ['network_objects.c', objects],
    ['network_server_message_handler.c', server]]) {
    for (const {line, web} of webOnlyLines(source)) {
      if (/compact|inventories_due|game_state_due|zero_runs|own_sent|own_state|seat_times|send_to_machine\(/i.test(line) &&
        !/^\s*(\/\*|\*)/.test(line)) {
        assert(web, `${file}: a compact form outside HALO_WEB: ${line.trim()}`);
      }
    }
  }
  /* and the native builds still send the plain ones */
  for (const [file, source, kinds] of [
    ['network_distributed.c', distributed, ['_distributed_message_unit_states', '_distributed_message_game_state']],
    ['network_objects.c', objects, ['_distributed_message_inventories']]]) {
    for (const kind of kinds) {
      const native = webOnlyLines(source).filter(entry => !entry.web &&
        new RegExp(`distributed_send\\(&message, ${kind}\\b`).test(entry.line));
      assert(native.length > 0 || source.includes(`type = host ? ${kind}`), `${file}: the native ${kind} send`);
    }
  }

  fs.writeFileSync(path.join(temp, 'compact_messages.inc'), [
    lines(distributed, '/* struct distributed_unit_state flags */\nenum\n{', '};'),
    lines(distributed, 'struct distributed_unit_state\n{', '};'),
    lines(objects, 'struct distributed_inventory\n{', '};'),
    lines(distributed, 'enum\n{\n\t_compact_unit_alive_bit = 0,',
      '\treturn written == length && read == size ? written : NONE;\n}'),
    lines(objects, 'enum\n{\n\tINVENTORY_REFRESH_TICKS = 30,', '};'),
    block(objects, 'static short distributed_compact_inventory_write('),
    block(objects, 'static short distributed_compact_inventory_read('),
  ].join('\n\n') + '\n');
  const cc = process.env.CC || 'cc';
  const web = /emcc/.test(path.basename(cc));
  const output = path.join(temp, web ? 'compact-messages-test.js' : 'compact-messages-test');
  const build = spawnSync(cc, ['-O2', '-std=gnu99', '-w', '-iquote', temp,
    path.join(__dirname, 'compact_messages_test.c'), '-o', output, '-lm'],
    {encoding: 'utf8', shell: process.platform === 'win32'});
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const run = spawnSync(web ? process.execPath : output, web ? [output] : [], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stdout + run.stderr);
  console.log(run.stdout.trim());
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
