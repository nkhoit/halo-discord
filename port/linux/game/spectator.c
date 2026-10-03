/*
SPECTATOR.C

A spectator's view (#52): a machine in a running match without a player of
its own (network_game_spectating, port/linux/NETCODE.md) watches another
player's.

- The target: a random player with a unit at first; the page cycles
  through the players with a unit (spectator_request_cycle); one who dies
  is watched where they fell, then followed after their respawn; with
  nobody to watch, the view holds (on Blood Gulch, a shot of the map).
- The camera: the target's eyes and aim, interpolated a tick behind, as
  render_interpolation.c draws everything else, with a little low-pass on
  the aim (debug.spectate_smoothing) against the remote unit's corrections.
  A target in a vehicle is seen from behind and above it (its seat views
  need its player's controls); a dead one from where it fell. Zoom is the
  target's input, which no other machine has: the view never zooms.
- The view scope: around the first-person weapon's and the HUD's updates
  and the drawing (game.c, main.c), the target stands in as local player 0
  (players_globals->local_players[0], its local_player_index and the local
  player count), so its first-person weapon, crosshair, HUD and motion
  sensor are drawn as its player sees them. Nothing else ever sees it so:
  the netcode's own players (distributed_player_is_local) and the player's
  input (player_control.c) run outside the scope, and the netcode refuses
  any inside it.

Called from the main loop every frame (main.c).
*/

#include "cseries.h"
#include "cseries/cseries_windows.h"
#include "camera/observer.h"
#include "game/game.h"
#include "game/game_engine.h"
#include "game/players.h"
#include "items/weapons.h"
#include "math/real_math.h"
#include "networking/network_game_globals.h"
#include "objects/objects.h"
#include "scenario/scenario.h"
#include "tag_files/tag_files.h"
#include "units/units.h"
#include "units/unit_definitions.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

/* the platform layer's (port/linux/src/port_config.c) */
double config_real(char const *name);
void platform_log(char const *format, ...);
/* render_interpolation.c's */
real render_interpolation_fraction(void);

#define SPECTATOR_PI 3.14159265f
/* where a dead target is watched from: behind and above where it fell */
#define SPECTATOR_DEATH_DISTANCE 3.0f
#define SPECTATOR_DEATH_HEIGHT 1.5f
/* a target in a vehicle: behind and above the vehicle */
#define SPECTATOR_VEHICLE_DISTANCE 6.0f
#define SPECTATOR_VEHICLE_HEIGHT 2.0f
/* Blood Gulch, with nobody to watch */
#define SPECTATOR_BLOOD_GULCH_X 70.0f
#define SPECTATOR_BLOOD_GULCH_Y (-118.0f)
#define SPECTATOR_BLOOD_GULCH_Z 6.0f
#define SPECTATOR_BLOOD_GULCH_YAW 132.0f
#define SPECTATOR_BLOOD_GULCH_PITCH (-8.0f)

enum spectator_view
{
	_spectator_view_none,
	_spectator_view_first_person,
	_spectator_view_vehicle,
	_spectator_view_dead,
};

/* the target, a tick */
struct spectator_snapshot
{
	real_point3d eye;
	real_vector3d aim;
	real_point3d body;
	real_point3d vehicle;
	real_vector3d vehicle_forward;
};

static struct
{
	boolean checked;
	real smoothing_seconds;
	real log_seconds;
	boolean watching;
	real seconds;
	long target_player;
	long target_unit;
	/* the target's last unit, dead or alive */
	long followed_unit;
	short view;
	/* the target's last two ticks */
	boolean have_snapshot;
	long snapshot_time;
	struct spectator_snapshot previous;
	struct spectator_snapshot latest;
	/* the aim drawn, low-passed */
	boolean have_aim;
	real_vector3d drawn_aim;
	/* the last view drawn, held when there is nothing to watch */
	boolean have_view;
	struct observer_result result;
	/* the page's cycling: +1, -1 or 0 */
	volatile long cycle_request;
	/* the view scope */
	boolean scoped;
	long saved_local_player;
	short saved_player_local_index;
	short saved_local_player_count;
	long logged_tick;
} spectator = { 0 };

static void spectator_read_settings(void)
{
	spectator.checked = TRUE;
	spectator.smoothing_seconds = (real)config_real("debug.spectate_smoothing") / 1000.0f;
	spectator.log_seconds = (real)config_real("debug.spectate_log");
	spectator.target_player = NONE;
	spectator.target_unit = NONE;
}

/* this machine watches the match now */
boolean spectator_watching(void)
{
	return spectator.watching;
}

/* the player watched, NONE for none */
long spectator_target_player(void)
{
	return spectator.watching ? spectator.target_player : NONE;
}

/* a character of the watched player's name, 0 past its end or with nobody
watched */
int spectator_target_name_character(int index)
{
	struct player_datum *player;

	if (!spectator.watching || spectator.target_player == NONE || index < 0 ||
		index >= (int)NUMBEROF(player->name) ||
		!(player = (struct player_datum *)datum_try_and_get(player_data, spectator.target_player)))
	{
		return 0;
	}
	return (int)player->name[index];
}

/* (the page, any thread) the next (+1) or previous (-1) player */
void spectator_request_cycle(short direction)
{
	spectator.cycle_request = direction < 0 ? -1 : 1;
}

static boolean spectator_should_watch(void)
{
	return network_game_spectating() && game_connection() == _game_connection_network_client &&
		game_in_progress() && game_engine_running() && !spectator.scoped && local_player_count() == 0 &&
		local_player_get_player_index(0) == NONE;
}

/* the players with a unit, in index order */
static short spectator_candidates(long *players, short maximum)
{
	struct data_iterator iterator;
	struct player_datum *player;
	short count = 0;

	data_iterator_new(&iterator, player_data);
	while ((player = (struct player_datum *)data_iterator_next(&iterator)) != NULL && count < maximum)
	{
		if (player->unit_index != NONE)
			players[count++] = iterator.datum_index;
	}
	return count;
}

static void spectator_switch(long player_index, char const *why)
{
	if (player_index == spectator.target_player)
		return;
	spectator.target_player = player_index;
	spectator.target_unit = NONE;
	spectator.followed_unit = NONE;
	spectator.have_snapshot = FALSE;
	spectator.have_aim = FALSE;
	platform_log("spectate: %s player %ld", why,
		player_index == NONE ? -1L : (long)DATUM_INDEX_TO_ABSOLUTE_INDEX(player_index));
}

/* (every frame, before the ticks) the target */
void spectator_update(real seconds)
{
	long candidates[64];
	short count;
	struct player_datum *player;

	if (!spectator.checked)
		spectator_read_settings();
	if (!spectator_should_watch())
	{
		if (spectator.watching)
			platform_log("spectate: stopped (local players %d)", (int)local_player_count());
		spectator.watching = FALSE;
		spectator.cycle_request = 0;
		return;
	}
	if (!spectator.watching)
	{
		spectator.watching = TRUE;
		spectator.seconds = 0.0f;
		spectator.target_player = NONE;
		spectator.have_view = FALSE;
		platform_log("spectate: watching");
	}
	spectator.seconds += seconds;
	count = spectator_candidates(candidates, NUMBEROF(candidates));

	/* (a player who left) */
	if (spectator.target_player != NONE && !datum_try_and_get(player_data, spectator.target_player))
		spectator_switch(NONE, "the watched player left;");
	if (spectator.target_player == NONE && count > 0)
		spectator_switch(candidates[system_milliseconds() % (unsigned long)count], "watching");
	if (spectator.cycle_request && count > 0)
	{
		short index;
		short next = 0;

		for (index = 0; index < count; index++)
		{
			if (candidates[index] == spectator.target_player)
			{
				next = (short)((index + (spectator.cycle_request > 0 ? 1 : count - 1)) % count);
				break;
			}
		}
		spectator_switch(candidates[next], spectator.cycle_request > 0 ? "next" : "previous");
	}
	spectator.cycle_request = 0;

	player = spectator.target_player != NONE ? player_get(spectator.target_player) : NULL;
	/* (dead: watched where they fell, until a new unit) */
	if (player && player->unit_index != NONE && player->unit_index != spectator.target_unit)
	{
		if (spectator.followed_unit != NONE && spectator.followed_unit != player->unit_index)
			platform_log("spectate: following player %ld's new unit",
				(long)DATUM_INDEX_TO_ABSOLUTE_INDEX(spectator.target_player));
		spectator.target_unit = player->unit_index;
		spectator.followed_unit = player->unit_index;
		spectator.have_snapshot = FALSE;
		spectator.have_aim = FALSE;
	}
	if (player && player->unit_index == NONE && spectator.target_unit != NONE)
	{
		platform_log("spectate: player %ld died: watching where they fell",
			(long)DATUM_INDEX_TO_ABSOLUTE_INDEX(spectator.target_player));
		spectator.target_unit = NONE;
	}
}

/* ---------- the camera */

static void spectator_point_lerp(real_point3d const *a, real_point3d const *b, real t, real_point3d *result)
{
	result->x = a->x + (b->x - a->x) * t;
	result->y = a->y + (b->y - a->y) * t;
	result->z = a->z + (b->z - a->z) * t;
}

static void spectator_vector_nlerp(real_vector3d const *a, real_vector3d const *b, real t, real_vector3d *result)
{
	result->i = a->i + (b->i - a->i) * t;
	result->j = a->j + (b->j - a->j) * t;
	result->k = a->k + (b->k - a->k) * t;
	if (normalize3d(result) == 0.0f)
		*result = *b;
}

static void spectator_aim_angles(real_vector3d const *aim, real *yaw, real *pitch)
{
	*yaw = (real)atan2(aim->j, aim->i) * 180.0f / SPECTATOR_PI;
	*pitch = (real)asin(PIN(aim->k, -1.0f, 1.0f)) * 180.0f / SPECTATOR_PI;
}

/* the target's state this tick (the view a tick behind it) */
static void spectator_take_snapshot(void)
{
	struct unit_datum *unit;
	struct object_datum *object;
	struct spectator_snapshot snapshot;
	long time = game_time_get();

	if (spectator.target_unit == NONE || !unit_try_and_get(spectator.target_unit))
		return;
	if (spectator.have_snapshot && time == spectator.snapshot_time)
		return;
	unit = unit_get(spectator.target_unit);
	object = object_get(spectator.target_unit);
	unit_get_camera_position(spectator.target_unit, &snapshot.eye);
	snapshot.aim = unit->unit.aiming_vector;
	if (normalize3d(&snapshot.aim) == 0.0f)
		snapshot.aim = object->object.forward;
	snapshot.body = object->object.bounding_sphere_center;
	snapshot.vehicle = object->object.position;
	snapshot.vehicle_forward = object->object.forward;
	if (object->object.parent_object_index != NONE)
	{
		struct object_datum *vehicle = object_get(object->object.parent_object_index);

		snapshot.vehicle = vehicle->object.position;
		snapshot.vehicle_forward = vehicle->object.forward;
	}
	spectator.previous = spectator.have_snapshot ? spectator.latest : snapshot;
	spectator.latest = snapshot;
	spectator.have_snapshot = TRUE;
	spectator.snapshot_time = time;
	spectator.view = object->object.parent_object_index != NONE ? _spectator_view_vehicle : _spectator_view_first_person;
	if (spectator.log_seconds > 0.0f && spectator.seconds <= spectator.log_seconds)
	{
		real yaw, pitch;

		spectator_aim_angles(&snapshot.aim, &yaw, &pitch);
		platform_log("spectate: tick %ld player %ld at %.3f %.3f %.3f aim %.3f %.3f", time,
			(long)DATUM_INDEX_TO_ABSOLUTE_INDEX(spectator.target_player), snapshot.eye.x, snapshot.eye.y, snapshot.eye.z,
			yaw, pitch);
	}
}

static void spectator_set_view(real_point3d const *position, real_vector3d const *forward, real field_of_view)
{
	real_vector3d up = { 0.0f, 0.0f, 1.0f };
	real along;

	spectator.result.position = *position;
	spectator.result.forward = *forward;
	if (normalize3d(&spectator.result.forward) == 0.0f)
		spectator.result.forward.i = 1.0f;
	along = dot_product3d(&up, &spectator.result.forward);
	up.i -= spectator.result.forward.i * along;
	up.j -= spectator.result.forward.j * along;
	up.k -= spectator.result.forward.k * along;
	if (normalize3d(&up) == 0.0f)
	{
		up.i = 1.0f;
		up.j = up.k = 0.0f;
	}
	spectator.result.up = up;
	spectator.result.velocity.i = spectator.result.velocity.j = spectator.result.velocity.k = 0.0f;
	spectator.result.field_of_view = field_of_view;
	scenario_location_from_point(&spectator.result.location, &spectator.result.position);
	spectator.have_view = TRUE;
}

/* the target's view, as its player's camera without zoom
(player_control_get_field_of_view) */
static real spectator_field_of_view(void)
{
	real field_of_view = 70.0f * SPECTATOR_PI / 180.0f;

	if (spectator.target_unit != NONE && unit_try_and_get(spectator.target_unit))
	{
		struct unit_datum *unit = unit_get(spectator.target_unit);
		struct unit_definition *definition = unit_definition_get(unit->definition_index);
		long weapon_index = unit_inventory_get_weapon(spectator.target_unit, unit->unit.current_weapon_index);

		field_of_view = weapon_index != NONE ?
			weapon_get_field_of_view(weapon_index, definition->unit.camera_field_of_view, NONE) :
			definition->unit.camera_field_of_view;
	}
	return field_of_view;
}

static boolean spectator_map_is(char const *name)
{
	char const *path = global_scenario_index != NONE ? tag_get_name(global_scenario_index) : NULL;

	return path && strstr(path, name) != NULL;
}

/* (main.c, drawing a frame) the spectator's camera, or NULL */
struct observer_result const *spectator_camera(
	real frame_seconds)
{
	real alpha = render_interpolation_fraction();
	real_point3d position;
	real_vector3d forward;

	if (!spectator.watching)
		return NULL;
	spectator_take_snapshot();
	if (spectator.target_unit != NONE && spectator.have_snapshot && spectator.view == _spectator_view_first_person)
	{
		real_vector3d aim;

		spectator_point_lerp(&spectator.previous.eye, &spectator.latest.eye, alpha, &position);
		spectator_vector_nlerp(&spectator.previous.aim, &spectator.latest.aim, alpha, &aim);
		if (spectator.have_aim && spectator.smoothing_seconds > 0.0f)
		{
			real keep = (real)exp(-frame_seconds / spectator.smoothing_seconds);

			spectator_vector_nlerp(&aim, &spectator.drawn_aim, keep, &spectator.drawn_aim);
		}
		else
		{
			spectator.drawn_aim = aim;
		}
		spectator.have_aim = TRUE;
		spectator_set_view(&position, &spectator.drawn_aim, spectator_field_of_view());
	}
	else if (spectator.target_unit != NONE && spectator.have_snapshot)
	{
		real_point3d vehicle;
		real_vector3d behind;

		spectator_point_lerp(&spectator.previous.vehicle, &spectator.latest.vehicle, alpha, &vehicle);
		spectator_vector_nlerp(&spectator.previous.vehicle_forward, &spectator.latest.vehicle_forward, alpha, &behind);
		behind.k = 0.0f;
		if (normalize3d(&behind) == 0.0f)
			behind.i = 1.0f;
		position.x = vehicle.x - behind.i * SPECTATOR_VEHICLE_DISTANCE;
		position.y = vehicle.y - behind.j * SPECTATOR_VEHICLE_DISTANCE;
		position.z = vehicle.z + SPECTATOR_VEHICLE_HEIGHT;
		forward.i = vehicle.x - position.x;
		forward.j = vehicle.y - position.y;
		forward.k = vehicle.z + 0.5f - position.z;
		spectator_set_view(&position, &forward, 70.0f * SPECTATOR_PI / 180.0f);
	}
	else if (spectator.target_player != NONE && spectator.have_snapshot)
	{
		/* (dead: where they fell, from behind and above their last view) */
		real_vector3d behind = spectator.latest.aim;

		behind.k = 0.0f;
		if (normalize3d(&behind) == 0.0f)
			behind.i = 1.0f;
		position.x = spectator.latest.body.x - behind.i * SPECTATOR_DEATH_DISTANCE;
		position.y = spectator.latest.body.y - behind.j * SPECTATOR_DEATH_DISTANCE;
		position.z = spectator.latest.body.z + SPECTATOR_DEATH_HEIGHT;
		forward.i = spectator.latest.body.x - position.x;
		forward.j = spectator.latest.body.y - position.y;
		forward.k = spectator.latest.body.z - position.z;
		spectator_set_view(&position, &forward, 70.0f * SPECTATOR_PI / 180.0f);
		spectator.view = _spectator_view_dead;
	}
	else if (!spectator.have_view && spectator_map_is("bloodgulch"))
	{
		real yaw = SPECTATOR_BLOOD_GULCH_YAW * SPECTATOR_PI / 180.0f;
		real pitch = SPECTATOR_BLOOD_GULCH_PITCH * SPECTATOR_PI / 180.0f;

		position.x = SPECTATOR_BLOOD_GULCH_X;
		position.y = SPECTATOR_BLOOD_GULCH_Y;
		position.z = SPECTATOR_BLOOD_GULCH_Z;
		forward.i = (real)(cos(yaw) * cos(pitch));
		forward.j = (real)(sin(yaw) * cos(pitch));
		forward.k = (real)sin(pitch);
		spectator_set_view(&position, &forward, 70.0f * SPECTATOR_PI / 180.0f);
		spectator.view = _spectator_view_none;
	}
	/* (else the last view, held) */
	return spectator.have_view ? &spectator.result : NULL;
}

/* (main.c) every frame drawn, while debug.spectate_log lasts: its camera,
the spectator's or a player's own, for measuring the view's smoothness */
void spectator_log_frame(
	struct observer_result const *camera)
{
	real yaw, pitch;

	if (!spectator.checked)
		spectator_read_settings();
	if (spectator.log_seconds <= 0.0f || !camera ||
		(spectator.watching ? spectator.seconds > spectator.log_seconds :
			game_time_get() > (long)(spectator.log_seconds * TICKS_PER_SECOND) + 300))
		return;
	if (!spectator.watching && local_player_get_player_index(0) != NONE && game_time_get() != spectator.logged_tick &&
		player_get(local_player_get_player_index(0))->unit_index != NONE)
	{
		long unit_index = player_get(local_player_get_player_index(0))->unit_index;
		real_point3d eye;
		real_vector3d aim = unit_get(unit_index)->unit.aiming_vector;

		spectator.logged_tick = game_time_get();
		unit_get_camera_position(unit_index, &eye);
		normalize3d(&aim);
		spectator_aim_angles(&aim, &yaw, &pitch);
		platform_log("spectate: own tick %ld player %ld at %.3f %.3f %.3f aim %.3f %.3f", game_time_get(),
			(long)DATUM_INDEX_TO_ABSOLUTE_INDEX(local_player_get_player_index(0)), eye.x, eye.y, eye.z, yaw, pitch);
	}
	spectator_aim_angles(&camera->forward, &yaw, &pitch);
	platform_log("spectate: frame %ld+%.2f %s at %.3f %.3f %.3f aim %.3f %.3f", game_time_get(),
		render_interpolation_fraction(), spectator.watching ? "spectator" : "own", camera->position.x,
		camera->position.y, camera->position.z, yaw, pitch);
}

/* ---------- the view scope */

/* (game.c, main.c) the target as local player 0 for the first-person
weapon's and the HUD's updates and the drawing, while it is seen from its
eyes; TRUE when it is, for spectator_view_end */
boolean spectator_view_begin(void)
{
	struct player_datum *player;

	if (!spectator.watching || spectator.scoped || spectator.target_player == NONE ||
		spectator.target_unit == NONE || spectator.view != _spectator_view_first_person ||
		!datum_try_and_get(player_data, spectator.target_player))
	{
		return FALSE;
	}
	player = player_get(spectator.target_player);
	if (player->unit_index != spectator.target_unit)
		return FALSE;
	spectator.saved_local_player = players_globals->local_players[0];
	spectator.saved_player_local_index = player->local_player_index;
	spectator.saved_local_player_count = players_globals->local_player_count;
	players_globals->local_players[0] = spectator.target_player;
	player->local_player_index = 0;
	players_globals->local_player_count = 1;
	spectator.scoped = TRUE;
	return TRUE;
}

void spectator_view_end(boolean begun)
{
	struct player_datum *player;

	if (!begun)
		return;
	player = (struct player_datum *)datum_try_and_get(player_data, spectator.target_player);
	if (player)
		player->local_player_index = spectator.saved_player_local_index;
	players_globals->local_players[0] = spectator.saved_local_player;
	players_globals->local_player_count = spectator.saved_local_player_count;
	spectator.scoped = FALSE;
}

/* inside the view scope (the netcode's own players are never there) */
boolean spectator_view_scoped(void)
{
	return spectator.scoped;
}

/* (director.c) the view's perspective, while scoped: its eyes */
boolean spectator_first_person_view(void)
{
	return spectator.scoped;
}

/* (first_person_weapons.c) the first-person weapon slot of the target's
unit, for its weapon's events outside the scope, or NONE */
short spectator_first_person_slot(long unit_index)
{
	return spectator.watching && unit_index != NONE && unit_index == spectator.target_unit &&
		spectator.view == _spectator_view_first_person ? 0 : NONE;
}
