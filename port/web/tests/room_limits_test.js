/* The match and room limits are numbers in several languages: the relay's
   (server/src/protocol.ts), the engine's (halo_port_limits.h), and the
   pages' copies of them. They must agree. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const number = (source, pattern, what) => {
  const match = source.match(pattern);
  assert(match, `missing: ${what}`);
  return Number(match[1]);
};

test('the pages, the transport and the engine use the relay room limits', () => {
  const protocol = read('server/src/protocol.ts');
  const players = number(protocol, /export const MAXIMUM_ROOM_PLAYERS = (\d+);/, 'MAXIMUM_ROOM_PLAYERS');
  const spectators = number(protocol, /export const MAXIMUM_ROOM_SPECTATORS = (\d+);/, 'MAXIMUM_ROOM_SPECTATORS');
  assert.match(protocol, /export const MAXIMUM_SLOTS = MAXIMUM_ROOM_MACHINES;/);

  const engine = number(read('port/linux/include/halo_port_limits.h'), /#define HALO_WEB_MAXIMUM_PLAYERS (\d+)/,
    'HALO_WEB_MAXIMUM_PLAYERS');
  assert.equal(engine, players, 'a match holds as many players as a room has machines with players');
  assert.match(read('port/web/src/web_online_ui.c'), /WEB_ONLINE_ROSTER_LIMIT = HALO_WEB_MAXIMUM_PLAYERS,/);

  const transport = read('port/web/library_web_transport.js');
  assert.equal(number(transport, /RELAY_MAXIMUM_SLOTS: (\d+),/, 'RELAY_MAXIMUM_SLOTS'), players + spectators);

  const client = read('port/web/online_client.js');
  assert.equal(number(client, /var RELAY_ROOM_CAPACITY = (\d+);/, 'RELAY_ROOM_CAPACITY'), players);
  assert.equal(number(client, /var ENGINE_ROSTER_LIMIT = (\d+);/, 'ENGINE_ROSTER_LIMIT'), engine);

  assert.equal(number(read('server/client/hosted.js'), /\(room\.capacity \|\| (\d+)\)/, 'the list capacity'), players);
});
