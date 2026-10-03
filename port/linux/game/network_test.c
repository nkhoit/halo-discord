/*
NETWORK_TEST.C

Automated system link sessions for testing the netcode without the menus
(debug.network_test in config.toml, HALO_NETWORK_TEST):

- "host:<map>[:<variant>]" hosts a game on that multiplayer map
  (bloodgulch, ...) with one of the built-in game variants (slayer by
  default; game_engine_get_variant_by_name), as the pregame screen's fast
  setup does, and starts it debug.network_test_start seconds later;
- "join" searches for games and joins the first it finds, as picking it in
  the system link list does.

Once the game runs, every second each machine logs where every player's
unit is, so the machines' views of the game can be compared.

Scripted play for the netcode's parts the bots' wandering does not reach:
debug.network_test_kill (the host kills the last player every so often),
debug.network_test_shoot (every so often each machine's player hits the
next with their weapon's projectile: a client's through its report to the
host) and debug.network_test_vehicle (the host seats the last player as a
vehicle's driver that many seconds in, and takes them out 15 seconds on)
and debug.network_test_pickup (the last player stands on a weapon lying
about that many seconds in, and a joining machine's player holds the action
button a second later, to pick it up).

Called from the main loop every frame (main.c).
*/

#include "cseries.h"
#include "main/main.h"
#include "interface/hud.h"
#include "interface/player_ui.h"
#include "interface/ui_widget.h"
#include "networking/network_game_globals.h"
#include "networking/network_client_manager.h"
#include "networking/network_server_manager.h"
#include "game/game.h"
#include "game/game_engine.h"
#include "game/players.h"
#include "objects/objects.h"
#include "units/units.h"
#include "units/unit_definitions.h"
#include "items/weapons.h"
#include "items/weapon_definitions.h"
#include "items/projectile_definitions.h"
#include "items/items.h"
#include "objects/damage.h"
#include "scenario/scenario.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

/* the platform layer's (port/linux/src/port_config.c) */
const char *config_string(char const *name);
double config_real(char const *name);
void platform_log(char const *format, ...);
/* damage.c's */
void damage_kill_object_for_player(long object_index, long player_index);
/* network_distributed.c's */
void network_distributed_statistics(long *sent, long *received, long *corrections);
void network_distributed_item_statistics(long *creates, long *deletes, long *failures, long *removed);
void network_damage_statistics(long *sent_reports, long *dealt_reports, long *rejected_reports, long *replayed_events);
/* xinput_sdl.c's */
void test_input_hold_action(int hold);

enum
{
	_network_test_off,
	_network_test_host,
	_network_test_join,
};

static struct
{
	boolean checked;
	short mode;
	char map_name[64];
	char variant_name[64];
	real start_delay;
	real menu_seconds;
	boolean set_up;
	real setup_seconds;
	boolean started;
	boolean joined;
	boolean map_set;
	boolean player_added;
	real joined_seconds;
	boolean team_set;
	real kill_interval;
	real end_time;
	boolean ended;
	real ammo_message_interval;
	real shoot_interval;
	real vehicle_time;
	real pickup_time;
	long logged_time;
} network_test;

static void network_test_read_settings(
	void)
{
	char const *setting = config_string("debug.network_test");

	network_test.checked = TRUE;
	if (!strncmp(setting, "host:", 5) && setting[5])
	{
		char *colon;

		network_test.mode = _network_test_host;
		snprintf(network_test.map_name, sizeof(network_test.map_name), "%s", setting + 5);
		snprintf(network_test.variant_name, sizeof(network_test.variant_name), "slayer");
		colon = strchr(network_test.map_name, ':');
		if (colon)
		{
			*colon = 0;
			snprintf(network_test.variant_name, sizeof(network_test.variant_name), "%s", colon + 1);
		}
	}
	else if (!strcmp(setting, "join"))
	{
		network_test.mode = _network_test_join;
	}
	network_test.start_delay = (real)config_real("debug.network_test_start");
	network_test.kill_interval = (real)config_real("debug.network_test_kill");
	network_test.end_time = (real)config_real("debug.network_test_end");
	network_test.ammo_message_interval = (real)config_real("debug.network_test_ammo_message");
	network_test.shoot_interval = (real)config_real("debug.network_test_shoot");
	network_test.vehicle_time = (real)config_real("debug.network_test_vehicle");
	network_test.pickup_time = (real)config_real("debug.network_test_pickup");
	if (network_test.mode != _network_test_off)
		platform_log("network test: %s", setting);
}

/* every player's unit, as this machine sees it */
static void network_test_log_players(
	void)
{
	struct data_iterator iterator;
	struct player_datum *player;
	char line[1024];
	int length = 0;

	data_iterator_new(&iterator, player_data);
	while ((player = (struct player_datum *)data_iterator_next(&iterator)) != NULL && length < (int)sizeof(line) - 96)
	{
		if (player->unit_index != NONE)
		{
			struct object_datum *object = object_get(player->unit_index);
			struct unit_datum *unit = unit_get(player->unit_index);
			short slot;

			/* (riding: where its vehicle is) */
			struct object_datum *placed = object->object.parent_object_index != NONE ?
				object_get(object->object.parent_object_index) : object;

			length += snprintf(line + length, sizeof(line) - (size_t)length, " player %ld: (%.3f %.3f %.3f) h%.2f/%.2f%s%s g%d/%d w",
				(long)DATUM_INDEX_TO_ABSOLUTE_INDEX(iterator.datum_index), placed->object.position.x,
				placed->object.position.y, placed->object.position.z, object->object.body_vitality,
				object->object.shield_vitality, placed != object ? " riding" : "",
				TEST_FLAG(unit->unit.flags, _unit_active_camouflaged_bit) ? " camo" : "",
				unit->unit.grenade_counts[0], unit->unit.grenade_counts[1]);
			for (slot = 0; slot < MAXIMUM_WEAPONS_PER_UNIT; slot++)
			{
				long weapon_index = unit->unit.weapon_object_indices[slot];

				if (weapon_index != NONE)
				{
					struct weapon_datum *weapon = weapon_get(weapon_index);

					length += snprintf(line + length, sizeof(line) - (size_t)length, " %lx:%d",
						(unsigned long)weapon->definition_index & 0xFFFF, weapon->weapon.magazines[0].rounds_total +
						weapon->weapon.magazines[0].rounds_loaded);
				}
			}
		}
		else
		{
			length += snprintf(line + length, sizeof(line) - (size_t)length, " player %ld: dead r%ld",
				(long)DATUM_INDEX_TO_ABSOLUTE_INDEX(iterator.datum_index), (long)player->respawn_timer);
		}
		/* the game type's score and the kills and deaths (and the team, in a
		team game) */
		length += snprintf(line + length, sizeof(line) - (size_t)length, " s%ld k%d d%d",
			game_engine && game_engine->get_player_score ?
				game_engine->get_player_score(iterator.datum_index, _get_score_individual) : -1L,
			player->statistics.kills[0], player->statistics.deaths);
		if (game_engine_has_teams())
			length += snprintf(line + length, sizeof(line) - (size_t)length, " t%d", (int)player->team_index);
	}
	{
		long sent, received, corrections;

		struct object_iterator objects;
		long ground_items = 0;

		object_iterator_new(&objects, _object_mask_weapon | _object_mask_equipment, 0);
		while (object_iterator_next(&objects))
		{
			struct item_datum *item = item_get(objects.index);

			if (item->object.parent_object_index == NONE &&
				TEST_FLAG(item->object.flags, _object_connected_to_map_bit) &&
				!TEST_FLAG(item->item.flags, _item_attached_to_unit_bit))
			{
				ground_items++;
			}
		}
		network_distributed_statistics(&sent, &received, &corrections);
		long creates, deletes, failures, removed;

		long sent_reports, dealt_reports, rejected_reports, replayed_events;

		network_distributed_item_statistics(&creates, &deletes, &failures, &removed);
		network_damage_statistics(&sent_reports, &dealt_reports, &rejected_reports, &replayed_events);
		platform_log("network test: tick %ld%s | items %ld (+%ld -%ld !%ld x%ld) | %s | sent %ld received %ld corrected %ld"
			" | hits %ld dealt %ld rejected %ld replayed %ld",
			game_time_get(), line, ground_items, creates, deletes, failures, removed,
			game_engine_can_score() ? "playing" : "game over", sent, received, corrections,
			sent_reports, dealt_reports, rejected_reports, replayed_events);
	}
}

/* each of this machine's players hits the next player with their weapon's
projectile, as its impact would */
static void network_test_shoot(
	void)
{
	struct data_iterator iterator;
	struct player_datum *player;

	data_iterator_new(&iterator, player_data);
	while ((player = (struct player_datum *)data_iterator_next(&iterator)) != NULL)
	{
		struct data_iterator targets;
		struct player_datum *target = NULL;
		struct player_datum *candidate;
		struct unit_datum *unit;
		long weapon_index;
		struct weapon_definition *weapon;
		struct weapon_trigger_definition *trigger;
		long damage_index = NONE;
		struct damage_data damage;
		struct object_datum *target_object;
		real_vector3d direction;

		if (player->local_player_index == NONE || player->unit_index == NONE)
			continue;
		data_iterator_new(&targets, player_data);
		while ((candidate = (struct player_datum *)data_iterator_next(&targets)) != NULL)
		{
			if (candidate != player && candidate->unit_index != NONE)
			{
				target = candidate;
				break;
			}
		}
		unit = unit_get(player->unit_index);
		if (!target || unit->unit.current_weapon_index == NONE ||
			TEST_FLAG(object_get(target->unit_index)->object.damage_flags, _object_dead_bit))
		{
			continue;
		}
		weapon_index = unit->unit.weapon_object_indices[unit->unit.current_weapon_index];
		if (weapon_index == NONE)
			continue;
		weapon = weapon_definition_get(object_get(weapon_index)->definition_index);
		if (weapon->weapon.triggers.count > 0)
		{
			trigger = TAG_BLOCK_GET_ELEMENT(&weapon->weapon.triggers, 0, struct weapon_trigger_definition);
			if (trigger->projectile.index != NONE)
				damage_index = projectile_definition_get(trigger->projectile.index)->projectile.impact_damage.index;
		}
		if (damage_index == NONE)
			damage_index = weapon->weapon.melee_attack_damage.index;
		if (damage_index == NONE)
			continue;
		target_object = object_get(target->unit_index);
		damage_data_new(&damage, damage_index);
		damage.owner_player_index = iterator.datum_index;
		damage.owner_object_index = player->unit_index;
		damage.owner_team_index = unit->object.owner_team_index;
		damage.origin = target_object->object.position;
		damage.epicenter = target_object->object.position;
		direction.i = target_object->object.position.x - unit->object.position.x;
		direction.j = target_object->object.position.y - unit->object.position.y;
		direction.k = target_object->object.position.z - unit->object.position.z;
		normalize3d(&direction);
		damage.direction = direction;
		damage.scale = 1.0f;
		scenario_location_from_point(&damage.location, &damage.epicenter);
		object_cause_damage(&damage, target->unit_index, NONE, NONE, NONE, NULL);
		platform_log("network test: player %ld shoots player %ld",
			(long)DATUM_INDEX_TO_ABSOLUTE_INDEX(iterator.datum_index), (long)(target - (struct player_datum *)player_data->data));
	}
}

/* the host seats the last player as the nearest vehicle's driver, or out */
static void network_test_vehicle(
	boolean enter)
{
	struct data_iterator iterator;
	struct player_datum *player;
	struct player_datum *last = NULL;

	data_iterator_new(&iterator, player_data);
	while ((player = (struct player_datum *)data_iterator_next(&iterator)) != NULL)
		last = player;
	if (!last || last->unit_index == NONE)
		return;
	if (!enter)
	{
		if (object_get(last->unit_index)->object.parent_object_index != NONE)
		{
			unit_exit_seat_end(last->unit_index);
			platform_log("network test: the last player leaves the vehicle");
		}
		return;
	}
	{
		struct object_iterator vehicles;
		long nearest_index = NONE;
		real nearest_distance = 0.0f;
		real_point3d const *position = &object_get(last->unit_index)->object.position;
		short seat_index;

		object_iterator_new(&vehicles, _object_mask_vehicle, 0);
		while (object_iterator_next(&vehicles))
		{
			real_point3d const *vehicle_position = &object_get(vehicles.index)->object.position;
			real distance = distance_squared3d(position, vehicle_position);

			if (nearest_index == NONE || distance < nearest_distance)
			{
				nearest_index = vehicles.index;
				nearest_distance = distance;
			}
		}
		if (nearest_index == NONE)
		{
			platform_log("network test: no vehicle");
			return;
		}
		for (seat_index = 0; seat_index < unit_definition_get(object_get(nearest_index)->definition_index)->unit.seats.count; seat_index++)
		{
			if (unit_seat_is_driver(nearest_index, seat_index) &&
				unit_enter_seat(last->unit_index, nearest_index, seat_index))
			{
				platform_log("network test: the last player drives vehicle %lx", nearest_index);
				return;
			}
		}
		platform_log("network test: the last player cannot drive vehicle %lx", nearest_index);
	}
}

/* the host gives the last player a second weapon, lying about */
static void network_test_second_weapon(
	void)
{
	struct data_iterator iterator;
	struct player_datum *player;
	struct player_datum *last = NULL;
	struct object_iterator weapons;

	data_iterator_new(&iterator, player_data);
	while ((player = (struct player_datum *)data_iterator_next(&iterator)) != NULL)
		last = player;
	if (!last || last->unit_index == NONE)
		return;
	object_iterator_new(&weapons, _object_mask_weapon, 0);
	while (object_iterator_next(&weapons))
	{
		struct object_datum *weapon = object_get(weapons.index);
		struct unit_datum *unit = unit_get(last->unit_index);
		long current_index = unit->unit.weapon_object_indices[0];

		if (weapon->object.parent_object_index == NONE && TEST_FLAG(weapon->object.flags, _object_connected_to_map_bit) &&
			(current_index == NONE || object_get(current_index)->definition_index != weapon->definition_index) &&
			unit_add_weapon_to_inventory(last->unit_index, weapons.index, TRUE))
		{
			platform_log("network test: the last player takes a second weapon (%lx)", weapon->definition_index);
			/* (and camouflage, as a powerup gives) */
			player_handle_powerup(DATUM_INDEX_NEW(last - (struct player_datum *)player_data->data, last->identifier),
				_player_powerup_active_camouflage, 10 * TICKS_PER_SECOND);
			return;
		}
	}
}

/* both machines stand the last player on the first weapon lying about that
it does not carry (the same object on both: a client's own player is where
it has it, within a tolerance) */
static void network_test_pickup(
	void)
{
	struct data_iterator iterator;
	struct player_datum *player;
	struct player_datum *last = NULL;
	struct object_iterator weapons;
	long nearest_index = NONE;
	real nearest_distance = 0.0f;
	struct unit_datum *unit;

	data_iterator_new(&iterator, player_data);
	while ((player = (struct player_datum *)data_iterator_next(&iterator)) != NULL)
		last = player;
	if (!last || last->unit_index == NONE)
		return;
	unit = unit_get(last->unit_index);
	object_iterator_new(&weapons, _object_mask_weapon, 0);
	while (object_iterator_next(&weapons))
	{
		struct object_datum *weapon = object_get(weapons.index);
		short slot;
		boolean carried = FALSE;
		real distance;

		if (weapon->object.parent_object_index != NONE ||
			!TEST_FLAG(weapon->object.flags, _object_connected_to_map_bit))
		{
			continue;
		}
		for (slot = 0; slot < MAXIMUM_WEAPONS_PER_UNIT; slot++)
		{
			long carried_index = unit->unit.weapon_object_indices[slot];

			carried |= carried_index != NONE && object_get(carried_index)->definition_index == weapon->definition_index;
		}
		distance = (real)DATUM_INDEX_TO_ABSOLUTE_INDEX(weapons.index);
		if (!carried && (nearest_index == NONE || distance < nearest_distance))
		{
			nearest_index = weapons.index;
			nearest_distance = distance;
		}
	}
	if (nearest_index != NONE)
	{
		real_point3d position = object_get(nearest_index)->object.position;

		position.z += 0.1f;
		object_set_position(last->unit_index, &position, NULL, NULL);
		platform_log("network test: the last player stands on weapon %lx (%lx)", nearest_index,
			object_get(nearest_index)->definition_index);
	}
}

/* the first player kills the last (a kill that scores), and picks up a
weapon lying about and two grenades of each kind */
static void network_test_kill(
	void)
{
	struct data_iterator iterator;
	struct player_datum *player;
	struct player_datum *last = NULL;

	struct player_datum *first = NULL;
	long first_index = NONE;

	data_iterator_new(&iterator, player_data);
	while ((player = (struct player_datum *)data_iterator_next(&iterator)) != NULL)
	{
		if (!first)
		{
			first = player;
			first_index = iterator.datum_index;
		}
		last = player;
	}
	if (last && last != first && last->unit_index != NONE && first->unit_index != NONE)
	{
		/* killed by the first player: a kill that scores */
		platform_log("network test: the first player kills the last");
		damage_kill_object_for_player(last->unit_index, first_index);
		/* and picks up a weapon lying about, and two grenades of each kind */
		{
			struct object_iterator objects;
			struct unit_datum *unit = unit_get(first->unit_index);

			object_iterator_new(&objects, _object_mask_weapon, 0);
			while (object_iterator_next(&objects))
			{
				struct weapon_datum *weapon = weapon_get(objects.index);

				if (weapon->object.parent_object_index == NONE &&
					weapon->definition_index != weapon_get(unit->unit.weapon_object_indices[0])->definition_index)
				{
					if (unit_add_weapon_to_inventory(first->unit_index, objects.index, TRUE))
						platform_log("network test: the first player picks up a weapon");
					break;
				}
			}
			unit->unit.grenade_counts[0] = 2;
			unit->unit.grenade_counts[1] = 2;
		}
	}
}

/* the local player is shown "Picked up 8 rounds for <the weapon in hand>" */
static void network_test_ammo_message(
	void)
{
	long player_index = local_player_get_player_index(0);
	struct player_datum *player = player_index != NONE ? player_try_and_get(player_index) : NULL;
	struct unit_datum *unit = player && player->unit_index != NONE ? unit_get(player->unit_index) : NULL;
	long weapon_index = unit && unit->unit.current_weapon_index != NONE ?
		unit->unit.weapon_object_indices[unit->unit.current_weapon_index] : NONE;

	if (weapon_index == NONE)
		return;
	platform_log("network test: an ammunition pickup message");
	hud_picked_up_ammunition(0, object_get(weapon_index)->definition_index, 8);
}

/* ---------- (prototype, #52) a spectator: a machine in a match in progress
without a player of its own, watching another's (debug.spectate). Its
camera replaces the window's (main.c main_game_render); with
debug.spectate_hud the spectated player also stands in as local player 0
around the first-person weapon's and the HUD's updates and the render, but
never as this machine's own player for the netcode (its local_player_index
stays NONE: distributed_player_is_local). */

#include "camera/observer.h"
#include "math/real_math.h"

/* the platform layer's */
int config_boolean(const char *name);
long config_integer(const char *name);
/* network_server_manager.c's */
boolean network_game_join_in_progress_enabled(void);
/* network_distributed.c's: who last killed a player, NONE for none */
short network_distributed_killing_player(short player_absolute_index);
/* render_interpolation.c's */
real render_interpolation_fraction(void);
real_matrix4x3 *render_interpolation_object_node_matrices(long object_index);

#define SPECTATOR_FIELD_OF_VIEW (70.0f * 3.14159265f / 180.0f)
#define SPECTATOR_ORBIT_DISTANCE 3.5f
#define SPECTATOR_ORBIT_PITCH (-20.0f * 3.14159265f / 180.0f)

enum
{
	_spectator_camera_first_person,
	_spectator_camera_smooth,
	_spectator_camera_orbit,
	_spectator_camera_static,
};

static struct
{
	boolean checked;
	boolean enabled;
	short camera;
	boolean hud;
	boolean follow_killer;
	real cycle;
	long first_target;
	real join_after;
	real log_seconds;
	real orbit_speed;
	boolean static_set;
	real_point3d static_position;
	real static_yaw;
	real static_pitch;
	/* while spectating */
	boolean watching;
	real seconds;
	real since_switch;
	boolean join_requested;
	long target_player;
	long target_unit;
	long followed_unit;
	long snapshot_time;
	boolean have_snapshot;
	real_point3d camera_previous;
	real_point3d camera_latest;
	real_vector3d aim_previous;
	real_vector3d aim_latest;
	real_point3d center_previous;
	real_point3d center_latest;
	real orbit_yaw;
	struct observer_result result;
	long frames;
	long logged_tick;
	real logged_seconds;
	long slot_saved;
	boolean slot_swapped;
} spectator = { 0 };

static void spectator_read_settings(void)
{
	char const *camera = config_string("debug.spectate_camera");
	char const *view = config_string("debug.spectate_static");

	spectator.checked = TRUE;
	spectator.enabled = config_boolean("debug.spectate");
	spectator.camera = !strcmp(camera, "smooth") ? _spectator_camera_smooth :
		!strcmp(camera, "orbit") ? _spectator_camera_orbit :
		!strcmp(camera, "static") ? _spectator_camera_static : _spectator_camera_first_person;
	spectator.hud = config_boolean("debug.spectate_hud");
	spectator.follow_killer = !strcmp(config_string("debug.spectate_death"), "killer");
	spectator.cycle = (real)config_real("debug.spectate_cycle");
	spectator.first_target = config_integer("debug.spectate_target");
	spectator.join_after = (real)config_real("debug.spectate_join");
	spectator.log_seconds = (real)config_real("debug.spectate_log");
	spectator.orbit_speed = (real)config_real("debug.spectate_orbit") * 3.14159265f / 180.0f;
	spectator.static_set = sscanf(view, "%f %f %f %f %f", &spectator.static_position.x, &spectator.static_position.y,
		&spectator.static_position.z, &spectator.static_yaw, &spectator.static_pitch) == 5;
	spectator.static_yaw *= 3.14159265f / 180.0f;
	spectator.static_pitch *= 3.14159265f / 180.0f;
	spectator.target_player = NONE;
	spectator.target_unit = NONE;
	spectator.followed_unit = NONE;
	spectator.slot_saved = NONE;
	if (spectator.enabled)
		platform_log("spectate: on (camera %s%s, death %s)", camera, spectator.hud ? ", hud" : "",
			spectator.follow_killer ? "killer" : "stay");
}

/* a machine in a running match with no player of its own (and the setting) */
static boolean spectator_watching(void)
{
	return spectator.enabled && network_game_join_in_progress_enabled() &&
		game_connection() == _game_connection_network_client && game_in_progress() && game_engine_running() &&
		!spectator.slot_swapped && local_player_count() == 0 && local_player_get_player_index(0) == NONE;
}

/* the next player after `after` (NONE: the first) with a unit, or else any */
static long spectator_next_player(long after)
{
	struct data_iterator iterator;
	struct player_datum *player;
	long first_with_unit = NONE;
	long next_with_unit = NONE;
	long any = NONE;
	boolean past = after == NONE;

	data_iterator_new(&iterator, player_data);
	while ((player = (struct player_datum *)data_iterator_next(&iterator)) != NULL)
	{
		if (any == NONE)
			any = iterator.datum_index;
		if (player->unit_index != NONE)
		{
			if (first_with_unit == NONE)
				first_with_unit = iterator.datum_index;
			if (past && next_with_unit == NONE && iterator.datum_index != after)
				next_with_unit = iterator.datum_index;
		}
		if (iterator.datum_index == after)
			past = TRUE;
	}
	return next_with_unit != NONE ? next_with_unit : first_with_unit != NONE ? first_with_unit : any;
}

static void spectator_switch(long player_index, char const *why)
{
	if (player_index == spectator.target_player)
		return;
	spectator.target_player = player_index;
	spectator.since_switch = 0.0f;
	spectator.have_snapshot = FALSE;
	platform_log("spectate: %s player %ld", why,
		player_index == NONE ? -1L : (long)DATUM_INDEX_TO_ABSOLUTE_INDEX(player_index));
}

static void spectator_aim_angles(real_vector3d const *aim, real *yaw, real *pitch)
{
	*yaw = (real)atan2(aim->j, aim->i) * 180.0f / 3.14159265f;
	*pitch = (real)asin(PIN(aim->k, -1.0f, 1.0f)) * 180.0f / 3.14159265f;
}

/* (every frame, before the ticks) the target: cycling, deaths, joining */
static void spectator_update(real seconds)
{
	struct player_datum *player;

	if (!spectator.checked)
		spectator_read_settings();
	if (!spectator_watching())
	{
		if (spectator.watching)
		{
			spectator.watching = FALSE;
			platform_log("spectate: stopped (local players %d)", (int)local_player_count());
		}
		return;
	}
	if (!spectator.watching)
	{
		spectator.watching = TRUE;
		spectator.seconds = 0.0f;
		spectator.target_player = NONE;
		platform_log("spectate: watching");
	}
	spectator.seconds += seconds;
	spectator.since_switch += seconds;

	if (spectator.target_player == NONE || !datum_try_and_get(player_data, spectator.target_player))
	{
		long first = spectator_next_player(NONE);
		struct data_iterator iterator;

		data_iterator_new(&iterator, player_data);
		while (spectator.first_target >= 0 && data_iterator_next(&iterator))
		{
			if (DATUM_INDEX_TO_ABSOLUTE_INDEX(iterator.datum_index) == spectator.first_target)
				first = iterator.datum_index;
		}
		spectator_switch(first, "first");
	}
	else if (spectator.cycle > 0.0f && spectator.since_switch >= spectator.cycle)
		spectator_switch(spectator_next_player(spectator.target_player), "next");
	player = spectator.target_player != NONE ? player_get(spectator.target_player) : NULL;
	spectator.target_unit = player ? player->unit_index : NONE;
	if (player && player->unit_index == NONE && spectator.follow_killer)
	{
		short killer = network_distributed_killing_player((short)DATUM_INDEX_TO_ABSOLUTE_INDEX(spectator.target_player));
		struct data_iterator iterator;
		struct player_datum *other;

		data_iterator_new(&iterator, player_data);
		while (killer != NONE && (other = (struct player_datum *)data_iterator_next(&iterator)) != NULL)
		{
			if (DATUM_INDEX_TO_ABSOLUTE_INDEX(iterator.datum_index) == killer &&
				iterator.datum_index != spectator.target_player && other->unit_index != NONE)
			{
				spectator_switch(iterator.datum_index, "the killer,");
				spectator.target_unit = other->unit_index;
				break;
			}
		}
	}
	if (spectator.target_unit != NONE && spectator.target_unit != spectator.followed_unit)
	{
		platform_log("spectate: following unit %lx%s", (unsigned long)spectator.target_unit,
			spectator.followed_unit != NONE ? " (respawned or switched)" : "");
		spectator.followed_unit = spectator.target_unit;
		spectator.have_snapshot = FALSE;
	}

	if (game_time_get() - network_test.logged_time >= TICKS_PER_SECOND)
	{
		network_test.logged_time = game_time_get();
		network_test_log_players();
	}
	if (spectator.join_after > 0.0f && !spectator.join_requested && spectator.seconds >= spectator.join_after)
	{
		spectator.join_requested = TRUE;
		platform_log("spectate: joining: add player request %s",
			network_game_client_add_player(global_network_game_client_get(), 0) ? "sent" : "refused");
	}
}

/* (a player's machine, debug.spectate_log) its own unit's aim, every tick */
static void spectator_log_own(void)
{
	long player_index = local_player_get_player_index(0);
	struct unit_datum *unit;
	real yaw, pitch;
	real_point3d camera;

	if (spectator.log_seconds <= 0.0f || player_index == NONE || game_time_get() == spectator.logged_tick ||
		game_time_get() > (long)(spectator.log_seconds * TICKS_PER_SECOND) + 300 || player_get(player_index)->unit_index == NONE)
		return;
	if (game_time_get() / TICKS_PER_SECOND != spectator.logged_tick / TICKS_PER_SECOND)
		network_test_log_players();
	spectator.logged_tick = game_time_get();
	unit = unit_get(player_get(player_index)->unit_index);
	unit_get_camera_position(player_get(player_index)->unit_index, &camera);
	spectator_aim_angles(&unit->unit.aiming_vector, &yaw, &pitch);
	platform_log("spectate: own tick %ld player %ld at %.3f %.3f %.3f aim %.3f %.3f", game_time_get(),
		(long)DATUM_INDEX_TO_ABSOLUTE_INDEX(player_index), camera.x, camera.y, camera.z, yaw, pitch);
}

static void spectator_snapshot(void)
{
	long time = game_time_get();
	struct unit_datum *unit;
	struct object_datum *object;
	real_point3d camera;
	real_vector3d aim;
	real_point3d center;
	real yaw, pitch;

	if (spectator.target_unit == NONE || !unit_try_and_get(spectator.target_unit))
		return;
	if (spectator.have_snapshot && time == spectator.snapshot_time)
		return;
	unit = unit_get(spectator.target_unit);
	object = object_get(spectator.target_unit);
	unit_get_camera_position(spectator.target_unit, &camera);
	aim = unit->unit.aiming_vector;
	normalize3d(&aim);
	center = object->object.position;
	center.z += 0.3f;
	if (!spectator.have_snapshot)
	{
		spectator.camera_previous = camera;
		spectator.aim_previous = aim;
		spectator.center_previous = center;
	}
	else
	{
		spectator.camera_previous = spectator.camera_latest;
		spectator.aim_previous = spectator.aim_latest;
		spectator.center_previous = spectator.center_latest;
	}
	spectator.camera_latest = camera;
	spectator.aim_latest = aim;
	spectator.center_latest = center;
	spectator.have_snapshot = TRUE;
	spectator.snapshot_time = time;
	if (spectator.log_seconds > 0.0f && spectator.seconds <= spectator.log_seconds)
	{
		spectator_aim_angles(&aim, &yaw, &pitch);
		platform_log("spectate: tick %ld player %ld at %.3f %.3f %.3f aim %.3f %.3f", time,
			(long)DATUM_INDEX_TO_ABSOLUTE_INDEX(spectator.target_player), camera.x, camera.y, camera.z, yaw, pitch);
	}
}

static void spectator_point_lerp(real_point3d const *a, real_point3d const *b, real t, real_point3d *result)
{
	result->x = a->x + (b->x - a->x) * t;
	result->y = a->y + (b->y - a->y) * t;
	result->z = a->z + (b->z - a->z) * t;
}

static void spectator_set_view(real_point3d const *position, real_vector3d const *forward)
{
	real_vector3d up = { 0.0f, 0.0f, 1.0f };
	real along;

	spectator.result.position = *position;
	spectator.result.forward = *forward;
	normalize3d(&spectator.result.forward);
	along = dot_product3d(&up, &spectator.result.forward);
	up.i -= spectator.result.forward.i * along;
	up.j -= spectator.result.forward.j * along;
	up.k -= spectator.result.forward.k * along;
	if (normalize3d(&up) == 0.0f)
		up.i = 1.0f;
	spectator.result.up = up;
	spectator.result.velocity.i = spectator.result.velocity.j = spectator.result.velocity.k = 0.0f;
	spectator.result.field_of_view = SPECTATOR_FIELD_OF_VIEW;
	scenario_location_from_point(&spectator.result.location, &spectator.result.position);
}

/* (main.c, drawing a frame) the camera of a machine spectating, or NULL */
static boolean spectator_watching_or_swapped(void)
{
	return spectator.slot_swapped || spectator_watching();
}

struct observer_result const *network_spectator_camera(
	real frame_seconds)
{
	real alpha = render_interpolation_fraction();
	short camera = spectator.camera;
	real_point3d position;
	real_vector3d forward;

	if (!spectator.checked || !spectator.watching || !spectator_watching_or_swapped())
		return NULL;
	spectator_snapshot();
	/* (dead: around where they fell) */
	if (spectator.target_unit == NONE && camera != _spectator_camera_static)
		camera = _spectator_camera_orbit;
	if (camera == _spectator_camera_static || (!spectator.have_snapshot && spectator.static_set))
	{
		forward.i = (real)(cos(spectator.static_yaw) * cos(spectator.static_pitch));
		forward.j = (real)(sin(spectator.static_yaw) * cos(spectator.static_pitch));
		forward.k = (real)sin(spectator.static_pitch);
		spectator_set_view(&spectator.static_position, &forward);
	}
	else if (!spectator.have_snapshot)
	{
		return NULL;
	}
	else if (camera == _spectator_camera_orbit)
	{
		real_point3d center;

		spectator.orbit_yaw += spectator.orbit_speed * frame_seconds;
		spectator_point_lerp(&spectator.center_previous, &spectator.center_latest, alpha, &center);
		forward.i = (real)(cos(spectator.orbit_yaw) * cos(SPECTATOR_ORBIT_PITCH));
		forward.j = (real)(sin(spectator.orbit_yaw) * cos(SPECTATOR_ORBIT_PITCH));
		forward.k = (real)sin(SPECTATOR_ORBIT_PITCH);
		position.x = center.x - forward.i * SPECTATOR_ORBIT_DISTANCE;
		position.y = center.y - forward.j * SPECTATOR_ORBIT_DISTANCE;
		position.z = center.z - forward.k * SPECTATOR_ORBIT_DISTANCE;
		spectator_set_view(&position, &forward);
	}
	else if (camera == _spectator_camera_smooth)
	{
		spectator_point_lerp(&spectator.camera_previous, &spectator.camera_latest, alpha, &position);
		forward.i = spectator.aim_previous.i + (spectator.aim_latest.i - spectator.aim_previous.i) * alpha;
		forward.j = spectator.aim_previous.j + (spectator.aim_latest.j - spectator.aim_previous.j) * alpha;
		forward.k = spectator.aim_previous.k + (spectator.aim_latest.k - spectator.aim_previous.k) * alpha;
		spectator_set_view(&position, &forward);
	}
	else
	{
		spectator_set_view(&spectator.camera_latest, &spectator.aim_latest);
	}
	spectator.frames++;
	return &spectator.result;
}

/* (main.c) every frame drawn: its camera, while debug.spectate_log lasts */
void network_spectator_log_frame(
	struct observer_result const *camera)
{
	real yaw, pitch;

	if (!spectator.checked || spectator.log_seconds <= 0.0f || !camera ||
		(spectator.watching ? spectator.seconds > spectator.log_seconds :
			game_time_get() > (long)(spectator.log_seconds * TICKS_PER_SECOND) + 300))
		return;
	spectator_aim_angles(&camera->forward, &yaw, &pitch);
	platform_log("spectate: frame %ld+%.2f %s at %.3f %.3f %.3f aim %.3f %.3f", game_time_get(),
		render_interpolation_fraction(), spectator.watching ? "spectator" : "own", camera->position.x,
		camera->position.y, camera->position.z, yaw, pitch);
}

/* (debug.spectate_hud) the spectated player as local player 0, around the
first-person weapon's and the HUD's updates and the drawing; TRUE when it
is, for network_spectator_view_end */
boolean network_spectator_view_begin(
	void)
{
	if (!spectator.hud || !spectator_watching() || spectator.target_player == NONE ||
		spectator.target_unit == NONE || spectator.camera == _spectator_camera_orbit ||
		spectator.camera == _spectator_camera_static)
		return FALSE;
	spectator.slot_saved = players_globals->local_players[0];
	players_globals->local_players[0] = spectator.target_player;
	spectator.slot_swapped = TRUE;
	return TRUE;
}

void network_spectator_view_end(
	boolean begun)
{
	if (!begun)
		return;
	players_globals->local_players[0] = spectator.slot_saved;
	spectator.slot_swapped = FALSE;
}

/* (first_person_weapons.c) the spectated unit's first-person weapon slot */
short network_spectator_first_person_slot(
	long unit_index)
{
	return spectator.hud && spectator.watching && unit_index != NONE && unit_index == spectator.target_unit &&
		spectator.camera != _spectator_camera_orbit && spectator.camera != _spectator_camera_static ? 0 : NONE;
}

/* (render_objects.c) the spectated unit, not drawn while seen from inside */
boolean network_spectator_first_person_object(
	long object_index)
{
	return spectator.watching && object_index != NONE && object_index == spectator.target_unit &&
		(spectator.camera == _spectator_camera_first_person || spectator.camera == _spectator_camera_smooth);
}

/* (web_online_ui.c) join without a player */
boolean network_spectator_wanted(
	void)
{
	if (!spectator.checked)
		spectator_read_settings();
	return spectator.enabled;
}

void network_test_update(
	boolean main_menu_loaded,
	real seconds)
{
	spectator_update(seconds);
	spectator_log_own();
	if (!network_test.checked)
		network_test_read_settings();
	/* (scripted hits and kills also in games the menus made, for measuring;
	the players logged every second) */
	if (network_test.mode == _network_test_off)
	{
		if ((network_test.shoot_interval > 0.0f || network_test.kill_interval > 0.0f || network_test.end_time > 0.0f ||
			network_test.ammo_message_interval > 0.0f) &&
			game_in_progress() &&
			!main_menu_loaded && game_connection() != _game_connection_local &&
			game_time_get() - network_test.logged_time >= TICKS_PER_SECOND)
		{
			network_test.logged_time = game_time_get();
			network_test_log_players();
			if (network_test.shoot_interval > 0.0f &&
				game_time_get() % (long)(network_test.shoot_interval * TICKS_PER_SECOND) < TICKS_PER_SECOND)
			{
				network_test_shoot();
			}
			if (network_test.kill_interval > 0.0f && game_connection() == _game_connection_network_server &&
				game_time_get() % (long)(network_test.kill_interval * TICKS_PER_SECOND) < TICKS_PER_SECOND)
			{
				network_test_kill();
			}
			if (network_test.ammo_message_interval > 0.0f && game_engine_running() &&
				game_time_get() % (long)(network_test.ammo_message_interval * TICKS_PER_SECOND) < TICKS_PER_SECOND)
			{
				network_test_ammo_message();
			}
			/* (once a game: the clock starts over with the next; a match only,
			not Halo's lobby, whose clock runs too. These checks run a second
			apart by the frames' clock, so a window of exactly a second can be
			stepped over.) */
			if (game_time_get() < (long)(network_test.end_time * TICKS_PER_SECOND))
				network_test.ended = FALSE;
			else if (network_test.end_time > 0.0f && !network_test.ended &&
				game_connection() == _game_connection_network_server && game_engine_running())
			{
				network_test.ended = TRUE;
				platform_log("network test: the host ends the game");
				game_engine_end_game();
			}
		}
		return;
	}

	/* the game running: report */
	if (game_in_progress() && !main_menu_loaded && game_time_get() - network_test.logged_time >= TICKS_PER_SECOND)
	{
		network_test.logged_time = game_time_get();
		network_test_log_players();
		if (network_test.shoot_interval > 0.0f &&
			game_time_get() % (long)(network_test.shoot_interval * TICKS_PER_SECOND) < TICKS_PER_SECOND)
		{
			network_test_shoot();
		}
		if (network_test.pickup_time > 0.0f)
		{
			long pickup_time = (long)(network_test.pickup_time * TICKS_PER_SECOND);

			/* (two weapons first: picking up a third swaps) */
			if (network_test.mode == _network_test_host && game_time_get() >= pickup_time - 3 * TICKS_PER_SECOND &&
				game_time_get() - (pickup_time - 3 * TICKS_PER_SECOND) < TICKS_PER_SECOND)
			{
				network_test_second_weapon();
			}

			if (game_time_get() >= pickup_time && game_time_get() - pickup_time < TICKS_PER_SECOND)
			{
				network_test_pickup();
			}
			/* (standing there for four seconds, the button held from a second
			on) */
			if (network_test.mode == _network_test_join)
			{
				boolean hold = game_time_get() >= pickup_time &&
					game_time_get() < pickup_time + 4 * TICKS_PER_SECOND;

				test_input_hold_action(hold);
			}
		}
		if (network_test.mode == _network_test_host && network_test.vehicle_time > 0.0f)
		{
			long enter_time = (long)(network_test.vehicle_time * TICKS_PER_SECOND);

			if (game_time_get() >= enter_time && game_time_get() - enter_time < TICKS_PER_SECOND)
				network_test_vehicle(TRUE);
			if (game_time_get() >= enter_time + 15 * TICKS_PER_SECOND &&
				game_time_get() - enter_time - 15 * TICKS_PER_SECOND < TICKS_PER_SECOND)
			{
				network_test_vehicle(FALSE);
			}
		}
		/* debug.network_test_kill: the host kills the last player every so
		often, to test deaths and respawns reaching the clients */
		if (network_test.mode == _network_test_host && network_test.kill_interval > 0.0f &&
			game_time_get() % (long)(network_test.kill_interval * TICKS_PER_SECOND) < TICKS_PER_SECOND)
		{
			network_test_kill();
		}
	}

	if (!main_menu_loaded)
		return;
	network_test.menu_seconds += seconds;
	/* (the main menu settling first) */
	if (network_test.menu_seconds < 2.0f)
		return;

	switch (network_test.mode)
	{
	case _network_test_host:
		if (!network_test.set_up)
		{
			network_test.set_up = TRUE;
			main_set_multiplayer_map_name(network_test.map_name);
			player_ui_fast_setup_network_server();
			platform_log("network test: hosting %s", network_test.map_name);
		}
		else if (!network_test.started)
		{
			network_test.setup_seconds += seconds;
			/* the map (fast setup clears it), and a player for controller 1, as
			pressing A in the lobby adds one */
			if (!network_test.map_set && network_test.setup_seconds >= 1.0f && global_network_game_server_get())
			{
				char path[128];

				struct game_variant variant;

				snprintf(path, sizeof(path), "levels\\test\\%s\\%s", network_test.map_name, network_test.map_name);
				network_game_server_change_map_name(global_network_game_server_get(), path);
				/* the variant, as picking the game settings does */
				variant = *game_engine_get_variant_by_name(&variant, network_test.variant_name);
				player_ui_set_game_variant(&variant);
				network_game_server_change_game_variant(global_network_game_server_get(), &variant);
				network_test.map_set = TRUE;
			}
			if (!network_test.player_added && network_test.setup_seconds >= 2.0f && global_network_game_client_get())
				network_test.player_added = network_game_client_add_player(global_network_game_client_get(), 0);
			if (network_test.setup_seconds >= network_test.start_delay)
			{
				network_test.started = TRUE;
				network_game_client_request_immediate_start();
				platform_log("network test: starting the game");
			}
		}
		break;
	case _network_test_join:
		if (!network_test.set_up)
		{
			network_test.set_up = TRUE;
			dispose_global_network_game_client();
			dispose_global_network_game_server();
			if (create_global_network_game_client())
			{
				game_connection_set(_game_connection_network_client);
				platform_log("network test: searching for games");
			}
		}
		else if (!network_test.joined && network_game_client_join_first_available_game())
		{
			network_test.joined = TRUE;
			ui_widgets_close_all();
			ui_widget_load_by_name_or_tag(
				"ui\\shell\\main_menu\\multiplayer_type_select\\connected\\pregame\\connected_pregame_screen",
				NONE, NULL, NONE, NONE, NONE, NONE);
			platform_log("network test: joining");
		}
		else if (network_test.joined && !network_test.player_added)
		{
			network_test.joined_seconds += seconds;
			if (network_test.joined_seconds >= 3.0f && global_network_game_client_get())
				network_test.player_added = network_game_client_add_player(global_network_game_client_get(), 0);
		}
		/* (the other team from the host's player: a team game needs both) */
		else if (network_test.player_added && !network_test.team_set)
		{
			network_test.joined_seconds += seconds;
			if (network_test.joined_seconds >= 5.0f)
				network_test.team_set = network_game_client_set_team(1);
		}
		break;
	}
}
