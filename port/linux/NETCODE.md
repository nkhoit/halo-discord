# Distributed netcode (the default)

The Xbox game plays system link in lockstep: clients send their input to
the host, the host sends every machine every player's input for each 30 Hz
tick, and every machine simulates the whole game from them, waiting for
each tick's update. A client therefore sees its own movement and shots a
full round trip late, and any machine whose simulation differs in the last
bit goes out of sync.

`network.netcode = "distributed"` replaces that with the model of later
Halo engines (the "distributed" simulation of the MonkeyNuts/Ares source)
with ideas from VALORANT's netcode articles, keeping the 30 Hz tick:

- **Every machine ticks on its own clock.** Nobody waits for anybody: a
  client no longer runs only the ticks the host has sent.
- **Own player predicted.** A client drives its own player (and the
  vehicle it drives) from its local input at once. Remote players are
  driven by the inputs the host relays (the existing per-tick game update),
  the latest one held until a newer arrives.
- **Host authoritative.** The host alone decides damage, deaths, spawns,
  pickups, scores and the game's objects; clients do not decide them but
  apply what the host sends.
- **Corrections.** The host sends each client the authoritative state of
  the players' units and the game's moving objects; a client puts its
  copies there, drawn gliding from where they were. A client's own unit and
  vehicle are only corrected past a tolerance, so prediction does not
  rubber-band.
- **Shooter's hits.** A client reports what its own players hit; the host
  checks the report (the player's, a weapon they carry, the target where
  the host has it, no faster than weapons fire) and deals the damage. What
  the shooter saw hit, hits.

Every machine in a game must use the same netcode.

## Stages

1. (Done) Decoupled ticks: clients tick on their own clock with local input
   for local players and the latest relayed input for remote ones; the host
   no longer waits for clients; taps are accumulated so a quick button
   press is never lost (lockstep too); out-of-sync checks off.
2. (Done) Authority: clients skip damage, deaths, spawns, pickups, item
   spawns, and scoring, and apply the host's state for them
   (`port/linux/game/network_distributed.c`):
   - every tick, every player's unit: which it is, alive or not, the seat
     it rides, shields and health (down, recharging, the damage they show),
     its powerups (camouflage and how long each has left), where it is (a
     client's own player's position is its own, within a tolerance, and the
     host takes it), and when dead who killed it;
   - what a client's players pick up, which the host decides: the client
     shows it (the HUD's message, the sound, a powerup's screen flash);
   - twice a second and with every kill, the players' statistics; five
     times a second, the game type's state (scores, the flags, the balls
     and their carriers, the king's hill) and whether the game is over.

   The messages are a kind of their own (the game's unused "data" message
   type), unreliable per tick, reliable for what must not be lost.
3. (Done) Object identity (`port/linux/game/network_objects.c`): the
   game's units, vehicles, weapons and equipment are the host's, at the same
   datum index (identifier and all) on every machine, so a message names
   one by its index.
   - The host tells its clients (reliably) of each such object it makes
     (what it is, where, how it looks) and each it deletes; clients make
     and delete theirs to match. A client that has loaded asks for all the
     host's objects and is told when it has them; from then on it deletes
     any such object the host has not told it of, and nothing but the
     host's word deletes the host's.
   - The objects placed when the map loads are placed alike everywhere:
     the host's word finds a client's already there. Past loading, a
     client's own objects (projectiles, effects: what only it sees) take
     indices from the upper half of the object array, clear of the host's.
   - Ten times a second, what every unit carries (the host's weapons, slot
     for slot, their ammunition, the weapon in hand, the grenades); a
     client moves the same weapon objects in and out of its units.
   - Players take the units the host spawns them with, seats are the
     host's (a client's own player's once it has ridden otherwise for
     longer than a round trip), and the CTF flags and oddballs are the same
     objects everywhere.
4. (Done) Corrections: every tick the host sends where its moving objects
   are (vehicles, items, bodies) and a few of those at rest, round them
   all. A client puts its copies there, and the difference is drawn fading
   over a few ticks (`render_interpolation.c`) instead of a jump. A client
   drives its own player's vehicle and sends where it is, which the host
   takes within a tolerance, as it does its own player's unit.
5. (Done) Hits (`port/linux/game/network_damage.c`):
   - A client deals no damage. What its own players' shots, grenades,
     melee and vehicles hit, it reports to the host (reliably).
   - The host deals a report once it has checked it: from that machine's
     player; damage one of their weapons (now or in the last ten seconds),
     their grenades or their vehicle can deal (its projectiles' impacts and
     detonations, followed through the tags); the target within a few
     world units of where the shooter saw it (more for a fast one); the
     impact at the target (an explosion within its reach); and no more
     reports than any weapon fires. Its own copies of a client's
     projectiles deal nothing (the report does).
   - The host sends its clients the damage it dealt to units, and a client
     replays what it does besides the harm (which the units' states
     bring): the player's screen flash and shake, the unit's flinch, pain
     sound, knockback and stun, the scope it knocks the player out of, and
     who the HUD shows hit them. A killing blow it replays whole, so the
     body falls as the shot had it and the kill is announced with the
     host's killer.

## Joining a match in progress

With `network.join_in_progress` on (the hosted pages turn it on for their
hosts; off by default), a machine can join the host's match while it runs,
not only its lobby. Lockstep cannot: its clients simulate the match from its
first tick.

- The host advertises its running match as open and takes the connection
  while the match is on, not over, and has room for a player for every
  machine already loading it.
- The late machine is sent the game's settings (the map, the game type, the
  players) and told to begin, as every machine was at the start. It loads
  the map, takes the match's clock from its first update, asks for the
  host's objects (stage 3), and adds its player through Halo's in-game add;
  every machine then runs the game type's player added for it (its team,
  the smaller one, and its multiplayer data).
- Until it has loaded, the match's messages skip it; the players who joined
  or left meanwhile are sent to it once it has. A machine still loading
  after 90 seconds, or when the match ends, is let go.
- A player is at the same index on every machine, the one the server gave
  it (in a match, the first free of the game's players and of those who
  quit, whom the match keeps): the netcode names players by index, and a
  late machine never had the datums of those who left before it.
- Everything else a late joiner needs is what every client is sent all the
  time: the units, objects, inventories, statistics and the game type's
  state.

### Spectators

A machine can also join without a player of its own, to watch the match
(`network.spectate`, which the hosted pages set for whoever opens a match
already running). It marks its join request (the machine name's last
character, which every other client leaves zero), so the host knows at once:

- a spectator takes a machine slot, not a player's: a full match still takes
  it, up to 8 spectators, and it keeps no player's place while it loads;
- the lobby counts down without a player of its own (Halo's lobby otherwise
  waits for a player on every machine), and it loads into the next match
  still watching;
- it adds its player later through the same in-game add (Join), and from
  then it is a player like any other.

The machines' rules for spectators only apply with joining a match in
progress on; otherwise a machine without a player keeps the lobby waiting,
as before (`tests/network_late_join_gate_test`).

## Testing

`debug.network_test` (`port/linux/game/network_test.c`) hosts or joins a
game without the menus (in a team game the joining player takes the other
team), and `debug.test_input` plays controller 1 with a scripted bot; each
machine logs every player's position, health and shields, weapons,
grenades, score, kills and deaths every second, with the objects made and
removed and the hits reported, dealt, rejected and replayed, so two
machines' views of one game can be compared. `debug.network_test_kill`,
`debug.network_test_shoot`, `debug.network_test_vehicle` and
`debug.network_test_pickup` script kills, hits, a vehicle ride and a weapon
swap the bots' wandering does not reach. `debug.network_latency` and
`debug.network_loss` hold back what a machine receives and drop some of its
datagrams, to test as over the internet.

The host logs to `debug.txt` when a player on another machine presses the
action button where the host has nothing for them to pick up, with where it
has them and the nearest item: a client that sees a pickup the host does
not.
