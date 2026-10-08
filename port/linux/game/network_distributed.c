/*
NETWORK_DISTRIBUTED.C

The distributed netcode's own messages (port/linux/NETCODE.md): the game's
"data" message kind (message header type 2, which the Xbox game never sent),
beside its packets, and handled here (network_*_message_handler.c).

The host decides; its clients predict their own players and show the
rest as the host has it:

- The game's objects (units, vehicles, weapons, equipment) are the host's,
  at the same datum index on every machine (network_objects.c): the host
  says which it has, where they are and what units carry.
- Every tick, a client sends the host where its own players' units are (it
  predicts them from its own input); the host takes that as they are,
  within a tolerance, as later Halo engines do.
- Every tick, the host sends every client every player's unit: which unit
  the player has, alive or not, the seat it rides, its shields and health
  (down, recharging, the damage they show), and where it is (dead: who
  killed it, which a client announces when its copy dies). A client binds,
  kills, seats and places its copies to match (it decides no deaths or
  spawns itself), and its own only when far off (a respawn, a teleport).
- Twice a second, and with every kill, the host sends every player's
  statistics (kills, deaths, ...), which clients take as they are.
- Five times a second, the host sends the game type's state (the scores,
  the flags, the balls and the hill), which clients take as it is
  (game_engine_write_network_state).
- Damage is the host's: a client reports its own players' hits, which the
  host checks and deals, and replays the damage the host deals for its
  effects (network_damage.c).

Players are named by their absolute index, which is the same on every
machine (their datum identifiers need not be).
*/

#include <math.h>
#ifdef HALO_WEB
#include <stdlib.h>
#include <emscripten.h>
#endif

#include "cseries.h"
#include "game/game.h"
#include "game/players.h"
#include "networking/network_game_globals.h"
#include "objects/objects.h"
#include "objects/damage.h"
#include "units/units.h"
#include "network_distributed.h"
#ifdef HALO_WEB
#include "items/weapons.h"
#include "scenario/scenario.h"
#include "structures/structure_bsp_definitions.h"
#endif

#ifdef HALO_WEB
/* platform.c's */
void platform_log(char const *format, ...);
#endif

/* network_game_globals.c's and network_server_message_handler.c's */
boolean network_distributed_client_send(void *message, word size);
boolean network_distributed_client_send_reliably(void *message, word size);
boolean network_distributed_server_send_to_all(void *message, word size);
boolean network_distributed_server_send_to_all_reliably(void *message, word size);
boolean network_distributed_server_send_to_machine_reliably(long machine_index, void *message, word size);
#ifdef HALO_WEB
boolean network_distributed_server_send_to_machine(long machine_index, void *message, word size);
#endif
/* spectator.c's: drawing a spectator's target as local player 0 */
boolean spectator_view_scoped(void);
/* players.c's */
void network_player_attach_unit(long player_index, long unit_index);
void network_player_detach_unit(long player_index);
void network_player_show_pickup(long player_index, short kind, long definition_index, short count);
/* game_engine.c's */
void game_engine_client_respawned(long player_index);
long game_engine_write_network_state(byte *buffer, long size);
void game_engine_read_network_state(byte const *buffer, long size);
/* player_queues_new.c's */
void update_queues_distributed_reset(void);

enum
{
	STATISTICS_INTERVAL_TICKS = 15,
	GAME_STATE_INTERVAL_TICKS = 6,
	MAXIMUM_GAME_STATE_SIZE = 0xF00,
	MAXIMUM_UNIT_STATES_PER_MESSAGE = 64,
	MAXIMUM_STATISTICS_PER_MESSAGE = 64,
	MAXIMUM_PICKUPS_PER_TICK = 64,
	/* ticks a client's own player may ride where the host says it does not
	(or the other way round) before it is put where the host has it: its
	own prediction reaches the host and comes back in about a round trip */
	SEAT_DISAGREEMENT_TICKS = 15,
	/* ticks a client may go without the unit the host says a player is
	alive in before it asks for the host's objects again: the unit's
	creation comes reliably, a little behind the word at most (#73); then
	twice as long before each time it asks again for the same player, up to
	the most, until the unit is there */
	MISSING_UNIT_TICKS = 3 * TICKS_PER_SECOND,
	MISSING_UNIT_MAXIMUM_TICKS = 30 * TICKS_PER_SECOND,
};

/* struct distributed_unit_state flags */
enum
{
	/* the player has a unit that is alive */
	_distributed_unit_alive_bit = 0,
	/* ... and not riding (its position is its own) */
	_distributed_unit_placed_bit,
	/* (dead) how it died: killed by a teammate, or by an empty vehicle */
	_distributed_unit_friendly_fire_bit,
	_distributed_unit_killed_by_vehicle_bit,
	/* (alive) its shields: down, charging, overcharging */
	_distributed_unit_shield_depleted_bit,
	_distributed_unit_shield_charging_bit,
	_distributed_unit_shield_over_charging_bit,
};

/* struct distributed_unit_state unit flags */
enum
{
	/* (alive) camouflaged, and doubly so */
	_distributed_unit_camouflaged_bit = 0,
	_distributed_unit_super_camouflaged_bit,
};

/* world units: how far a client's own player's unit may be from the host's
before the host takes it no longer, and before the client is put where the
host has it (no further than that: between the two they would disagree for
good, the host's player somewhere its own is not) */
#define HOST_ACCEPT_TOLERANCE 3.5f
#define REMOTE_CORRECTION_TOLERANCE 0.05f
#define LOCAL_CORRECTION_TOLERANCE 3.0f
/* ticks a client's respawn countdown may differ from the host's before it
takes the host's (which arrives a one-way trip late) */
#define RESPAWN_TIMER_TOLERANCE 6

struct distributed_unit_state
{
	byte player_index;
	byte flags;
	/* (dead) the player who killed it, NO_PLAYER for none */
	byte killing_player_index;
	byte unit_flags;
	/* the player's unit (the host's), NONE for none */
	long unit_index;
	/* the vehicle it rides and its seat, NONE for none */
	long vehicle_index;
	short seat_index;
	/* (dead) ticks until the host respawns the player */
	short respawn_timer;
	real_point3d position;
	real_vector3d velocity;
	real_vector3d forward;
	real_vector3d up;
	real body_vitality;
	real shield_vitality;
	/* what the shields' and the HUD's effects show */
	real current_body_damage;
	real recent_body_damage;
	real current_shield_damage;
	real recent_shield_damage;
	/* the player's powerups: how long each has left, and how camouflaged the
	unit is */
	short powerup_durations[NUMBER_OF_PLAYER_POWERUPS];
	real active_camouflage;
};

struct distributed_pickup
{
	byte player_index;
	byte kind;
	short count;
	long definition_index;
};

struct distributed_player_statistics
{
	short player_index;
	short pad;
	struct game_statistics statistics;
};

struct distributed_unit_state_message
{
	struct distributed_message_header header;
	struct distributed_unit_state states[MAXIMUM_UNIT_STATES_PER_MESSAGE];
};

struct distributed_statistics_message
{
	struct distributed_message_header header;
	struct distributed_player_statistics players[MAXIMUM_STATISTICS_PER_MESSAGE];
};

#ifdef HALO_WEB
/* ---------- compact messages (the browser builds)

Over the internet relay the host's per-tick messages are most of a match's
bandwidth, one copy per guest. The browser builds send three kinds in a
compact form; the native builds keep the plain ones.

A unit state: the player, the flags and which optional fields follow; then
(a living unit) its index, the vehicle and seat it rides, its position as
three 16-bit fractions of the map's world bounds (with a margin; a float
position outside them), its velocity in 16 bits per axis (none when still,
floats past the range), its facing (and its up, when not the world's) as
two 16-bit octahedral coordinates, its shields and body as half floats,
its damage and powerups only when it has any; (a dead one) the respawn
timer and the killer. */

enum
{
	_compact_unit_alive_bit = 0,
	_compact_unit_vehicle_bit,
	_compact_unit_position_bit,
	_compact_unit_position_float_bit,
	_compact_unit_velocity_bit,
	_compact_unit_velocity_float_bit,
	_compact_unit_up_bit,
	_compact_unit_damage_bit,
	_compact_unit_powerups_bit,
};

/* world units past the map's world bounds still quantized */
#define COMPACT_BOUNDS_MARGIN 64.0f
/* world units a tick, each axis, a quantized velocity spans either way */
#define COMPACT_VELOCITY_RANGE 4.0f
#define COMPACT_UNIT_STATE_MAXIMUM_SIZE (4 + 4 + 6 + 12 + 12 + 4 + 4 + 4 + 8 + 3 + 2 * NUMBER_OF_PLAYER_POWERUPS)

word distributed_half_from_real(
	real value)
{
	union { real f; unsigned int u; } bits;
	unsigned int sign, exponent, mantissa;

	bits.f = value;
	sign = (bits.u >> 16) & 0x8000;
	exponent = (bits.u >> 23) & 0xFF;
	mantissa = bits.u & 0x7FFFFF;
	if (exponent == 0xFF)
		return (word)(sign | 0x7C00 | (mantissa ? 0x200 : 0));
	if (exponent > 142)
		return (word)(sign | 0x7C00);
	if (exponent < 113)
	{
		unsigned int shift;

		/* (a subnormal half, or zero) */
		if (exponent < 102)
			return (word)sign;
		mantissa |= 0x800000;
		shift = 126 - exponent;
		return (word)(sign | ((mantissa + (1u << (shift - 1))) >> shift));
	}
	/* (rounded to the nearest; a carry moves the exponent, as it should) */
	return (word)((sign | ((exponent - 112) << 10) | (mantissa >> 13)) + ((mantissa >> 12) & 1));
}

real distributed_real_from_half(
	word half)
{
	union { real f; unsigned int u; } bits;
	unsigned int sign = ((unsigned int)half & 0x8000) << 16;
	unsigned int exponent = (half >> 10) & 0x1F;
	unsigned int mantissa = half & 0x3FF;

	if (exponent == 0)
	{
		real value = (real)mantissa / 16777216.0f;

		return sign ? -value : value;
	}
	if (exponent == 31)
		bits.u = sign | 0x7F800000 | (mantissa << 13);
	else
		bits.u = sign | ((exponent + 112) << 23) | (mantissa << 13);
	return bits.f;
}

static word distributed_quantize(
	real value,
	real minimum,
	real maximum)
{
	real fraction = (value - minimum) / (maximum - minimum);

	if (fraction < 0.0f)
		fraction = 0.0f;
	if (fraction > 1.0f)
		fraction = 1.0f;
	return (word)floor(fraction * 65535.0f + 0.5f);
}

static real distributed_dequantize(
	word value,
	real minimum,
	real maximum)
{
	return minimum + (maximum - minimum) * ((real)value / 65535.0f);
}

static short distributed_signed_fraction(
	real value)
{
	real scaled = value * 32767.0f;

	if (scaled > 32767.0f)
		scaled = 32767.0f;
	if (scaled < -32767.0f)
		scaled = -32767.0f;
	return (short)floor(scaled + 0.5f);
}

/* a unit vector in two 16-bit octahedral coordinates */
static void distributed_octahedral_write(
	byte *out,
	real_vector3d const *vector)
{
	real length = (real)(fabs(vector->i) + fabs(vector->j) + fabs(vector->k));
	real x = length > 0.0f ? vector->i / length : 0.0f;
	real y = length > 0.0f ? vector->j / length : 0.0f;
	short coordinates[2];

	if (length > 0.0f && vector->k < 0.0f)
	{
		real folded_x = (1.0f - (real)fabs(y)) * (x >= 0.0f ? 1.0f : -1.0f);
		real folded_y = (1.0f - (real)fabs(x)) * (y >= 0.0f ? 1.0f : -1.0f);

		x = folded_x;
		y = folded_y;
	}
	coordinates[0] = distributed_signed_fraction(x);
	coordinates[1] = distributed_signed_fraction(y);
	csmemcpy(out, coordinates, sizeof(coordinates));
}

static void distributed_octahedral_read(
	byte const *in,
	real_vector3d *vector)
{
	short coordinates[2];
	real x, y, z, length;

	csmemcpy(coordinates, in, sizeof(coordinates));
	x = coordinates[0] / 32767.0f;
	y = coordinates[1] / 32767.0f;
	z = 1.0f - (real)fabs(x) - (real)fabs(y);
	if (z < 0.0f)
	{
		real unfolded_x = (1.0f - (real)fabs(y)) * (x >= 0.0f ? 1.0f : -1.0f);
		real unfolded_y = (1.0f - (real)fabs(x)) * (y >= 0.0f ? 1.0f : -1.0f);

		x = unfolded_x;
		y = unfolded_y;
	}
	length = (real)sqrt(x * x + y * y + z * z);
	vector->i = x / length;
	vector->j = y / length;
	vector->k = z / length;
}

static boolean distributed_compact_inside(
	real_point3d const *point,
	real_rectangle3d const *bounds)
{
	return point->x >= bounds->x0 && point->x <= bounds->x1 && point->y >= bounds->y0 && point->y <= bounds->y1 &&
		point->z >= bounds->z0 && point->z <= bounds->z1;
}

/* the state in the compact form at out (room bytes free): its size, or 0
if it does not fit */
static short distributed_compact_unit_state_write(
	byte *out,
	short room,
	struct distributed_unit_state const *state,
	real_rectangle3d const *bounds)
{
	byte buffer[COMPACT_UNIT_STATE_MAXIMUM_SIZE];
	short size = 4;
	word fields = 0;
	word half;
	int value;
	short index;

	buffer[0] = state->player_index;
	buffer[1] = state->flags;
	if (state->unit_index == NONE)
	{
		csmemcpy(buffer + size, &state->respawn_timer, 2);
		size += 2;
		buffer[size++] = state->killing_player_index;
	}
	else
	{
		boolean powerups = state->unit_flags != 0 || state->active_camouflage != 0.0f;

		SET_FLAG(fields, _compact_unit_alive_bit, TRUE);
		value = (int)state->unit_index;
		csmemcpy(buffer + size, &value, 4);
		size += 4;
		if (state->vehicle_index != NONE)
		{
			SET_FLAG(fields, _compact_unit_vehicle_bit, TRUE);
			value = (int)state->vehicle_index;
			csmemcpy(buffer + size, &value, 4);
			csmemcpy(buffer + size + 4, &state->seat_index, 2);
			size += 6;
		}
		/* (where a rider is, its vehicle says) */
		if (TEST_FLAG(state->flags, _distributed_unit_placed_bit))
		{
			real const *velocity = &state->velocity.i;

			if (distributed_compact_inside(&state->position, bounds))
			{
				word position[3];

				SET_FLAG(fields, _compact_unit_position_bit, TRUE);
				position[0] = distributed_quantize(state->position.x, bounds->x0, bounds->x1);
				position[1] = distributed_quantize(state->position.y, bounds->y0, bounds->y1);
				position[2] = distributed_quantize(state->position.z, bounds->z0, bounds->z1);
				csmemcpy(buffer + size, position, sizeof(position));
				size += sizeof(position);
			}
			else
			{
				SET_FLAG(fields, _compact_unit_position_float_bit, TRUE);
				csmemcpy(buffer + size, &state->position, 12);
				size += 12;
			}
			if (velocity[0] != 0.0f || velocity[1] != 0.0f || velocity[2] != 0.0f)
			{
				if (fabs(velocity[0]) <= COMPACT_VELOCITY_RANGE && fabs(velocity[1]) <= COMPACT_VELOCITY_RANGE &&
					fabs(velocity[2]) <= COMPACT_VELOCITY_RANGE)
				{
					short quantized[3];

					SET_FLAG(fields, _compact_unit_velocity_bit, TRUE);
					for (index = 0; index < 3; index++)
						quantized[index] = distributed_signed_fraction(velocity[index] / COMPACT_VELOCITY_RANGE);
					csmemcpy(buffer + size, quantized, sizeof(quantized));
					size += sizeof(quantized);
				}
				else
				{
					SET_FLAG(fields, _compact_unit_velocity_float_bit, TRUE);
					csmemcpy(buffer + size, &state->velocity, 12);
					size += 12;
				}
			}
		}
		distributed_octahedral_write(buffer + size, &state->forward);
		size += 4;
		if (fabs(state->up.i) > 0.0001f || fabs(state->up.j) > 0.0001f || state->up.k < 0.9999f)
		{
			SET_FLAG(fields, _compact_unit_up_bit, TRUE);
			distributed_octahedral_write(buffer + size, &state->up);
			size += 4;
		}
		half = distributed_half_from_real(state->body_vitality);
		csmemcpy(buffer + size, &half, 2);
		half = distributed_half_from_real(state->shield_vitality);
		csmemcpy(buffer + size + 2, &half, 2);
		size += 4;
		if (state->current_body_damage != 0.0f || state->recent_body_damage != 0.0f ||
			state->current_shield_damage != 0.0f || state->recent_shield_damage != 0.0f)
		{
			real const damage[4] = { state->current_body_damage, state->recent_body_damage,
				state->current_shield_damage, state->recent_shield_damage };

			SET_FLAG(fields, _compact_unit_damage_bit, TRUE);
			for (index = 0; index < 4; index++)
			{
				half = distributed_half_from_real(damage[index]);
				csmemcpy(buffer + size, &half, 2);
				size += 2;
			}
		}
		for (index = 0; index < NUMBER_OF_PLAYER_POWERUPS; index++)
			powerups |= state->powerup_durations[index] != 0;
		if (powerups)
		{
			SET_FLAG(fields, _compact_unit_powerups_bit, TRUE);
			buffer[size++] = state->unit_flags;
			half = distributed_half_from_real(state->active_camouflage);
			csmemcpy(buffer + size, &half, 2);
			size += 2;
			csmemcpy(buffer + size, state->powerup_durations, 2 * NUMBER_OF_PLAYER_POWERUPS);
			size += 2 * NUMBER_OF_PLAYER_POWERUPS;
		}
	}
	csmemcpy(buffer + 2, &fields, 2);
	if (size > room)
		return 0;
	csmemcpy(out, buffer, size);
	return size;
}

/* a state from its compact form: the bytes read, or 0 if malformed */
static short distributed_compact_unit_state_read(
	byte const *in,
	long available,
	struct distributed_unit_state *state,
	real_rectangle3d const *bounds)
{
	short size = 4;
	word fields;
	word half;
	int value;
	short index;

#define COMPACT_NEED(bytes) if (size + (bytes) > available) return 0
	COMPACT_NEED(0);
	csmemset(state, 0, sizeof(*state));
	state->player_index = in[0];
	state->flags = in[1];
	csmemcpy(&fields, in + 2, 2);
	state->unit_index = NONE;
	state->vehicle_index = NONE;
	state->seat_index = NONE;
	state->killing_player_index = NO_PLAYER;
	if (!TEST_FLAG(fields, _compact_unit_alive_bit))
	{
		COMPACT_NEED(3);
		csmemcpy(&state->respawn_timer, in + size, 2);
		state->killing_player_index = in[size + 2];
		return size + 3;
	}
	COMPACT_NEED(4);
	csmemcpy(&value, in + size, 4);
	state->unit_index = value;
	size += 4;
	if (TEST_FLAG(fields, _compact_unit_vehicle_bit))
	{
		COMPACT_NEED(6);
		csmemcpy(&value, in + size, 4);
		state->vehicle_index = value;
		csmemcpy(&state->seat_index, in + size + 4, 2);
		size += 6;
	}
	if (TEST_FLAG(fields, _compact_unit_position_bit))
	{
		word position[3];

		COMPACT_NEED(6);
		csmemcpy(position, in + size, sizeof(position));
		state->position.x = distributed_dequantize(position[0], bounds->x0, bounds->x1);
		state->position.y = distributed_dequantize(position[1], bounds->y0, bounds->y1);
		state->position.z = distributed_dequantize(position[2], bounds->z0, bounds->z1);
		size += 6;
	}
	else if (TEST_FLAG(fields, _compact_unit_position_float_bit))
	{
		COMPACT_NEED(12);
		csmemcpy(&state->position, in + size, 12);
		size += 12;
	}
	if (TEST_FLAG(fields, _compact_unit_velocity_bit))
	{
		short quantized[3];

		COMPACT_NEED(6);
		csmemcpy(quantized, in + size, sizeof(quantized));
		state->velocity.i = quantized[0] / 32767.0f * COMPACT_VELOCITY_RANGE;
		state->velocity.j = quantized[1] / 32767.0f * COMPACT_VELOCITY_RANGE;
		state->velocity.k = quantized[2] / 32767.0f * COMPACT_VELOCITY_RANGE;
		size += 6;
	}
	else if (TEST_FLAG(fields, _compact_unit_velocity_float_bit))
	{
		COMPACT_NEED(12);
		csmemcpy(&state->velocity, in + size, 12);
		size += 12;
	}
	COMPACT_NEED(4);
	distributed_octahedral_read(in + size, &state->forward);
	size += 4;
	if (TEST_FLAG(fields, _compact_unit_up_bit))
	{
		COMPACT_NEED(4);
		distributed_octahedral_read(in + size, &state->up);
		size += 4;
	}
	else
	{
		state->up.k = 1.0f;
	}
	COMPACT_NEED(4);
	csmemcpy(&half, in + size, 2);
	state->body_vitality = distributed_real_from_half(half);
	csmemcpy(&half, in + size + 2, 2);
	state->shield_vitality = distributed_real_from_half(half);
	size += 4;
	if (TEST_FLAG(fields, _compact_unit_damage_bit))
	{
		real *damage[4];

		damage[0] = &state->current_body_damage;
		damage[1] = &state->recent_body_damage;
		damage[2] = &state->current_shield_damage;
		damage[3] = &state->recent_shield_damage;
		COMPACT_NEED(8);
		for (index = 0; index < 4; index++)
		{
			csmemcpy(&half, in + size, 2);
			*damage[index] = distributed_real_from_half(half);
			size += 2;
		}
	}
	if (TEST_FLAG(fields, _compact_unit_powerups_bit))
	{
		COMPACT_NEED(3 + 2 * NUMBER_OF_PLAYER_POWERUPS);
		state->unit_flags = in[size++];
		csmemcpy(&half, in + size, 2);
		state->active_camouflage = distributed_real_from_half(half);
		size += 2;
		csmemcpy(state->powerup_durations, in + size, 2 * NUMBER_OF_PLAYER_POWERUPS);
		size += 2 * NUMBER_OF_PLAYER_POWERUPS;
	}
#undef COMPACT_NEED
	return size;
}

/* bytes with their zero runs packed: the size, then tokens, 0x80 | n for
n + 1 zeros and n for n + 1 bytes as they are; the packed size, or 0 if it
does not fit */
static long distributed_pack_zero_runs(
	byte *out,
	long room,
	byte const *in,
	long size)
{
	long written = 2;
	long index = 0;
	word length = (word)size;

	if (room < 2 || size > 0xFFFF)
		return 0;
	csmemcpy(out, &length, 2);
	while (index < size)
	{
		long run = 0;

		while (index + run < size && in[index + run] == 0 && run < 128)
			run++;
		if (run >= 2)
		{
			if (written + 1 > room)
				return 0;
			out[written++] = (byte)(0x80 | (run - 1));
			index += run;
			continue;
		}
		/* bytes as they are, up to the next run of zeros */
		run = 0;
		while (index + run < size && run < 128 &&
			!(in[index + run] == 0 && index + run + 1 < size && in[index + run + 1] == 0))
		{
			run++;
		}
		if (written + 1 + run > room)
			return 0;
		out[written++] = (byte)(run - 1);
		csmemcpy(out + written, in + index, run);
		written += run;
		index += run;
	}
	return written;
}

/* the bytes back: their size, or NONE if malformed or larger than room */
static long distributed_unpack_zero_runs(
	byte *out,
	long room,
	byte const *in,
	long size)
{
	long read = 2;
	long written = 0;
	word length;

	if (size < 2)
		return NONE;
	csmemcpy(&length, in, 2);
	if (length > room)
		return NONE;
	while (read < size && written < length)
	{
		byte token = in[read++];
		long run = (token & 0x7F) + 1;

		if (written + run > length)
			return NONE;
		if (token & 0x80)
		{
			csmemset(out + written, 0, run);
		}
		else
		{
			if (read + run > size)
				return NONE;
			csmemcpy(out + written, in + read, run);
			read += run;
		}
		written += run;
	}
	return written == length && read == size ? written : NONE;
}

#endif

/* ---------- globals */

static long distributed_last_sent_time = NONE;

/* how each player last died, by absolute index: the host's own, which it
sends its clients, and a client's copy of the host's */
static struct distributed_death
{
	boolean valid;
	/* the killer's absolute index, or NONE */
	short killing_player_index;
	boolean friendly_fire;
	boolean killed_by_vehicle;
} distributed_deaths[MAXIMUM_TRACKED_PLAYERS];
/* the host: a kill this tick, whose statistics the clients should have
with it */
static boolean distributed_statistics_due;
/* the host: what players on other machines picked up this tick */
static struct distributed_pickup distributed_pickups[MAXIMUM_PICKUPS_PER_TICK];
static short distributed_pickup_count;
/* a client: the ticks each of its own players has ridden other than as
the host has it */
static short distributed_seat_disagreements[MAXIMUM_TRACKED_PLAYERS];
/* a client: since when each player has been alive on the host in a unit
this machine does not have, NONE for not, and the ticks before it asks for
the host's objects for that player (again) */
static long distributed_missing_unit_times[MAXIMUM_TRACKED_PLAYERS];
static long distributed_missing_unit_waits[MAXIMUM_TRACKED_PLAYERS];
/* (the host) a player's team waiting for its unit's death (a team switch),
NONE for none, and since when */
static long distributed_deferred_teams[MAXIMUM_TRACKED_PLAYERS];
static long distributed_deferred_team_times[MAXIMUM_TRACKED_PLAYERS];
#define DEFERRED_TEAM_MAXIMUM_TICKS TICKS_PER_SECOND
/* (every machine) when each player's team switched while its unit lived,
NONE for none: the switch's death comes within this many ticks (the host's
at once, a client's a one-way trip later) */
static long distributed_team_switch_times[MAXIMUM_TRACKED_PLAYERS];
#define TEAM_SWITCH_DEATH_TICKS (5 * TICKS_PER_SECOND)
#ifdef HALO_WEB
/* (the host) ticks between a machine's own players' states, while they move
as they were moving and nothing else of them changes: their machine moves them
itself, and the host's word corrects it only past LOCAL_CORRECTION_TOLERANCE.
Off (1, every tick) by default: above 1 the host sends each machine its own
unit-state message, encoded for it, which a relay fanning one message out to
every guest could not carry; in a firefight shields and health change nearly
every tick, so it saves little (NETCODE.md) */
#ifndef OWN_UNIT_STATE_INTERVAL_TICKS
#define OWN_UNIT_STATE_INTERVAL_TICKS 1
#endif
#endif
#if defined(HALO_WEB) && OWN_UNIT_STATE_INTERVAL_TICKS > 1
/* (a client) when it last had the host's word on each player's seat: its
disagreements are counted in ticks, its own players' states coming less often */
static long distributed_seat_times[MAXIMUM_TRACKED_PLAYERS];

/* world units: further than this from where the last one said it would be
(a teleporter, a push), it goes at once */
#define OWN_UNIT_STATE_JUMP 0.5f

/* (the host) each player's unit's last state its own machine was sent */
static struct distributed_own_unit_sent
{
	boolean valid;
	long time;
	struct distributed_unit_state state;
} distributed_own_sent[MAXIMUM_TRACKED_PLAYERS];
#endif
#ifdef HALO_WEB
/* the host (the browser builds): the game type's state as last sent, sent
again when it changes, at least once a second, and whenever a machine has
loaded */
enum { GAME_STATE_REFRESH_TICKS = 30 };
static byte distributed_game_state_sent[MAXIMUM_GAME_STATE_SIZE];
static long distributed_game_state_sent_size;
static long distributed_game_state_sent_time;
static boolean distributed_game_state_due;
/* the map's world bounds, with a margin, that unit positions are
quantized to */
static boolean distributed_compact_bounds_logged;
#endif

/* for the automated tests' reports (network_test.c) */
static struct
{
	long sent;
	long received;
	long corrections;
} distributed_statistics;

#ifdef HALO_WEB
/* for the browser's local network statistics (?netstats=1,
port/web/src/web_platform.c): the ticks sent, how often and how far the host
put a client's own units back, and the predictions the host refused */
static struct
{
	long ticks;
	long own_corrections;
	real own_correction_maximum_squared;
	long rejected_predictions;
	/* own corrections that also turned the unit more than
	OWN_AIM_CORRECTION_DEGREES, and the most it turned */
	long own_aim_corrections;
	real own_aim_correction_maximum_degrees;
	/* the host put this machine's own player in (or out of) a seat */
	long own_seat_corrections;
	/* (a client) how many ticks old the host's unit states are when this
	machine takes them, its game time less the host's when it sent them: the
	latest, and the most since the last read */
	long state_age_latest;
	long state_age_maximum;
	boolean state_age_seen;
	/* asked for the host's objects again, a player's unit missing (#73) */
	long object_resyncs;
} distributed_web_statistics;

/* (a client) the age of a message of the host's unit states it takes */
static void distributed_web_note_state_age(
	long sent_game_time)
{
	long age = game_time_get() - sent_game_time;

	distributed_web_statistics.state_age_latest = age;
	if (!distributed_web_statistics.state_age_seen || age > distributed_web_statistics.state_age_maximum)
		distributed_web_statistics.state_age_maximum = age;
	distributed_web_statistics.state_age_seen = TRUE;
}

/* for ?netstats=1 (web_platform.c): the latest age, and the most since the
last call (both 0 before any) */
void network_distributed_web_take_state_age(
	long *latest,
	long *maximum)
{
	*latest = distributed_web_statistics.state_age_seen ? distributed_web_statistics.state_age_latest : 0;
	*maximum = distributed_web_statistics.state_age_seen ? distributed_web_statistics.state_age_maximum : 0;
	distributed_web_statistics.state_age_maximum = distributed_web_statistics.state_age_latest;
}

#define OWN_AIM_CORRECTION_DEGREES 5.0f

/* what shooting and the other players look like here, for the browser's feel
scorecard: from the fire button to this machine's player's weapon firing,
from a hit reported to the host's damage for it coming back, how far the
host's word moved other players' units each tick, and ticks run without a
newer relayed input for the other players (they go on with the last) */
#define WEB_FEEL_SAMPLES 512
#define WEB_FEEL_PENDING_HITS 16
#define WEB_FEEL_PRESS_TIMEOUT 1000.0
#define WEB_FEEL_REMOTE_SNAP 1.0f

/* a window's values of one kind: every one counted and the largest kept,
and a uniform sample of at most WEB_FEEL_SAMPLES of them for the
percentiles (with 63 other players, about 9,000 corrections a window) */
struct web_feel_series
{
	double samples[WEB_FEEL_SAMPLES];
	long count;
	double maximum;
};

static struct
{
	boolean trigger_down;
	double press_time;
	/* the press: the first tick to take it (dequeued with the trigger), and
	whether the weapon was busy (reloading, switching, between shots) */
	double press_dequeued;
	boolean press_busy;
	struct web_feel_series fire;
	struct web_feel_series queue;
	struct web_feel_series weapon;
	long busy_presses;
	long unanswered_presses;
	struct
	{
		long object_index;
		double time;
	} hits[WEB_FEEL_PENDING_HITS];
	struct web_feel_series hit;
	long unconfirmed_hits;
	struct web_feel_series remote;
	long remote_snaps;
	boolean relayed_since_tick;
	short relayed_this_tick;
	long relayed_held_ticks;
	long relayed_held_run;
	long relayed_held_run_maximum;
	long relayed_bunched_ticks;
} web_feel;

/* (the game thread) xorshift32: which samples a full series keeps */
static unsigned long web_feel_random_state = 0x9E3779B9UL;

static unsigned long web_feel_random(
	void)
{
	unsigned long x = web_feel_random_state;

	x ^= (x << 13) & 0xFFFFFFFFUL;
	x ^= x >> 17;
	x ^= (x << 5) & 0xFFFFFFFFUL;
	web_feel_random_state = x;
	return x;
}

/* reservoir sampling (Algorithm R): the n-th value replaces a kept one with
probability WEB_FEEL_SAMPLES / n, so the kept ones are a uniform sample of
the whole window, not its first WEB_FEEL_SAMPLES */
static void web_feel_sample(
	struct web_feel_series *series,
	double value)
{
	if (!series->count || value > series->maximum)
		series->maximum = value;
	if (series->count < WEB_FEEL_SAMPLES)
	{
		series->samples[series->count] = value;
	}
	else
	{
		unsigned long slot = web_feel_random() % (unsigned long)(series->count + 1);

		if (slot < WEB_FEEL_SAMPLES)
			series->samples[slot] = value;
	}
	series->count++;
}

static int web_feel_compare(void const *a, void const *b)
{
	double x = *(double const *)a;
	double y = *(double const *)b;

	return x < y ? -1 : x > y;
}

/* [0] p50, [1] p99 (of the sample), [2] the maximum (of them all), then a
new window */
static void web_feel_take(
	struct web_feel_series *series,
	double *values)
{
	long kept = series->count < WEB_FEEL_SAMPLES ? series->count : WEB_FEEL_SAMPLES;

	values[0] = values[1] = values[2] = 0.0;
	if (kept)
	{
		qsort(series->samples, kept, sizeof(double), web_feel_compare);
		values[0] = series->samples[kept / 2];
		values[1] = series->samples[(kept * 99) / 100];
		values[2] = series->maximum;
	}
	series->count = 0;
	series->maximum = 0.0;
}

/* (player_control.c, every frame) this machine's player's fire button */
void network_web_trigger(
	real primary_trigger)
{
	double now = emscripten_get_now();
	boolean down = primary_trigger > 0.0f;

	if (web_feel.press_time > 0.0 && now - web_feel.press_time > WEB_FEEL_PRESS_TIMEOUT)
	{
		web_feel.unanswered_presses++;
		web_feel.press_time = 0.0;
	}
	if (down && !web_feel.trigger_down && web_feel.press_time <= 0.0)
	{
		long player_index = local_player_get_player_index(0);
		struct player_datum *player = player_index != NONE ? player_try_and_get(player_index) : NULL;
		struct unit_datum *unit = player && player->unit_index != NONE ?
			(struct unit_datum *)object_try_and_get_and_verify_type(player->unit_index, _object_mask_unit) : NULL;
		long weapon_index = unit && unit->unit.current_weapon_index != NONE ?
			unit->unit.weapon_object_indices[unit->unit.current_weapon_index] : NONE;
		struct weapon_datum *weapon = weapon_index != NONE ?
			(struct weapon_datum *)object_try_and_get_and_verify_type(weapon_index, _object_mask_weapon) : NULL;

		web_feel.press_time = now;
		web_feel.press_dequeued = 0.0;
		web_feel.press_busy = !weapon || weapon->weapon.state != _weapon_state_idle;
	}
	web_feel.trigger_down = down;
}

int network_web_trigger_down(void)
{
	return web_feel.trigger_down;
}

long network_web_own_corrections(void)
{
	return distributed_web_statistics.own_corrections;
}

/* (players.c, every tick) the actions a tick takes: when the press reached one */
void network_web_actions_dequeued(
	struct player_action const *actions)
{
	long player_index = local_player_get_player_index(0);

	if (web_feel.press_time <= 0.0 || web_feel.press_dequeued > 0.0 || player_index == NONE)
		return;
	if (actions[DATUM_INDEX_TO_ABSOLUTE_INDEX(player_index)].primary_trigger > 0.0f)
		web_feel.press_dequeued = emscripten_get_now();
}

/* (weapons.c) a weapon fired its primary trigger: this machine's player's
answers a press */
void network_web_weapon_fired(
	long owner_object_index)
{
	long player_index = owner_object_index != NONE ? player_index_from_unit_index(owner_object_index) : NONE;

	double now = emscripten_get_now();

	if (web_feel.press_time <= 0.0 || player_index == NONE || !distributed_player_is_local(player_index))
		return;
	/* (a press the weapon was not ready for waits on the weapon, not on us) */
	if (web_feel.press_busy)
		web_feel.busy_presses++;
	else
	{
		web_feel_sample(&web_feel.fire, now - web_feel.press_time);
		if (web_feel.press_dequeued > 0.0)
		{
			web_feel_sample(&web_feel.queue, web_feel.press_dequeued - web_feel.press_time);
			web_feel_sample(&web_feel.weapon, now - web_feel.press_dequeued);
		}
	}
	web_feel.press_time = 0.0;
}

/* reports the host did not answer within a second: refused, or dealt to
nothing this machine has */
static void web_feel_expire_hits(
	double now)
{
	short index;

	for (index = 0; index < WEB_FEEL_PENDING_HITS; index++)
	{
		if (web_feel.hits[index].time > 0.0 && now - web_feel.hits[index].time > 1000.0)
		{
			web_feel.unconfirmed_hits++;
			web_feel.hits[index].time = 0.0;
		}
	}
}

/* (network_damage.c, a client) a hit on the object reported to the host */
void network_web_hit_reported(
	long object_index)
{
	short index;
	short free_index = NONE;

	web_feel_expire_hits(emscripten_get_now());
	for (index = 0; index < WEB_FEEL_PENDING_HITS; index++)
	{
		if (web_feel.hits[index].time > 0.0 && web_feel.hits[index].object_index == object_index)
			return;
		if (web_feel.hits[index].time <= 0.0 && free_index == NONE)
			free_index = index;
	}
	if (free_index != NONE)
	{
		web_feel.hits[free_index].object_index = object_index;
		web_feel.hits[free_index].time = emscripten_get_now();
	}
}

/* (network_damage.c, a client) the host's damage by this machine's player
to the object arrived */
void network_web_hit_confirmed(
	long object_index)
{
	double now = emscripten_get_now();
	short index;

	web_feel_expire_hits(now);
	for (index = 0; index < WEB_FEEL_PENDING_HITS; index++)
	{
		if (web_feel.hits[index].time > 0.0 && web_feel.hits[index].object_index == object_index)
		{
			web_feel_sample(&web_feel.hit, now - web_feel.hits[index].time);
			web_feel.hits[index].time = 0.0;
		}
	}
}

/* (player_queues_new.c, a client) the host relayed the players' inputs */
void network_web_relayed_update(
	void)
{
	web_feel.relayed_this_tick++;
}

/* (player_queues_new.c, a client) a tick runs the others' latest inputs */
void network_web_client_tick(
	void)
{
	if (!web_feel.relayed_this_tick)
	{
		web_feel.relayed_held_ticks++;
		if (++web_feel.relayed_held_run > web_feel.relayed_held_run_maximum)
			web_feel.relayed_held_run_maximum = web_feel.relayed_held_run;
	}
	else
	{
		web_feel.relayed_held_run = 0;
		if (web_feel.relayed_this_tick > 1)
			web_feel.relayed_bunched_ticks++;
	}
	web_feel.relayed_this_tick = 0;
}

/* since the last call: [0] fire button presses answered by a shot, [1..3]
press to shot p50, p99, max (ms), [4] presses no shot answered within a
second; [5] hits confirmed, [6..8] report to the host's damage p50, p99,
max (ms); [9] other players' corrections, [10..12] their distance p50, p99,
max (world units), [13] those over a world unit; [14] ticks with no newer
relayed input, [15] the longest run of them, [16] ticks after two or more,
[17] hits reported that the host did not answer within a second, [18]
presses made while the weapon was busy (not in [0..3]), [19..21] press to the
first tick taking it p50, p99, max (ms), [22..24] that tick to the shot */
void network_distributed_web_feel(
	double values[25])
{
	values[18] = (double)web_feel.busy_presses;
	web_feel.busy_presses = 0;
	web_feel_take(&web_feel.queue, &values[19]);
	web_feel_take(&web_feel.weapon, &values[22]);
	web_feel_expire_hits(emscripten_get_now());
	values[17] = (double)web_feel.unconfirmed_hits;
	web_feel.unconfirmed_hits = 0;
	values[0] = (double)web_feel.fire.count;
	web_feel_take(&web_feel.fire, &values[1]);
	values[4] = (double)web_feel.unanswered_presses;
	values[5] = (double)web_feel.hit.count;
	web_feel_take(&web_feel.hit, &values[6]);
	values[9] = (double)web_feel.remote.count;
	web_feel_take(&web_feel.remote, &values[10]);
	values[13] = (double)web_feel.remote_snaps;
	values[14] = (double)web_feel.relayed_held_ticks;
	values[15] = (double)web_feel.relayed_held_run_maximum;
	values[16] = (double)web_feel.relayed_bunched_ticks;
	web_feel.unanswered_presses = 0;
	web_feel.remote_snaps = 0;
	web_feel.relayed_held_ticks = 0;
	web_feel.relayed_held_run_maximum = 0;
	web_feel.relayed_bunched_ticks = 0;
}

void network_distributed_web_statistics(
	long *ticks,
	long *own_corrections,
	real *own_correction_maximum_squared,
	long *rejected_predictions,
	long *own_aim_corrections,
	real *own_aim_correction_maximum_degrees,
	long *own_seat_corrections,
	long *object_resyncs)
{
	*object_resyncs = distributed_web_statistics.object_resyncs;
	*ticks = distributed_web_statistics.ticks;
	*own_corrections = distributed_web_statistics.own_corrections;
	*own_correction_maximum_squared = distributed_web_statistics.own_correction_maximum_squared;
	*rejected_predictions = distributed_web_statistics.rejected_predictions;
	*own_aim_corrections = distributed_web_statistics.own_aim_corrections;
	*own_aim_correction_maximum_degrees = distributed_web_statistics.own_aim_correction_maximum_degrees;
	*own_seat_corrections = distributed_web_statistics.own_seat_corrections;
}
#endif

/* ---------- shared (network_distributed.h) */

void network_distributed_statistics(
	long *sent,
	long *received,
	long *corrections)
{
	*sent = distributed_statistics.sent;
	*received = distributed_statistics.received;
	*corrections = distributed_statistics.corrections;
}

void distributed_count_sent(
	void)
{
	distributed_statistics.sent++;
}

void distributed_count_correction(
	void)
{
	distributed_statistics.corrections++;
}

void distributed_send(
	void *message,
	byte type,
	short count,
	word size,
	short destination)
{
	struct distributed_message_header *header = (struct distributed_message_header *)message;

	header->type = type;
	header->count = (byte)count;
	header->game_time = game_time_get();
	header->header = 0;
	build_message_header(&header->header, size, 2, 0);
	distributed_statistics.sent++;
	switch (destination)
	{
	case _distributed_to_clients: network_distributed_server_send_to_all(message, size); break;
	case _distributed_to_clients_reliably: network_distributed_server_send_to_all_reliably(message, size); break;
	case _distributed_to_host: network_distributed_client_send(message, size); break;
	case _distributed_to_host_reliably: network_distributed_client_send_reliably(message, size); break;
	}
}

void distributed_send_to_machine_reliably(
	long machine_index,
	void *message,
	byte type,
	short count,
	word size)
{
	struct distributed_message_header *header = (struct distributed_message_header *)message;

	header->type = type;
	header->count = (byte)count;
	header->game_time = game_time_get();
	header->header = 0;
	build_message_header(&header->header, size, 2, 0);
	distributed_statistics.sent++;
	network_distributed_server_send_to_machine_reliably(machine_index, message, size);
}

#if defined(HALO_WEB) && OWN_UNIT_STATE_INTERVAL_TICKS > 1
/* unreliably to one machine in the game (the host) */
static void distributed_send_to_machine(
	long machine_index,
	void *message,
	byte type,
	short count,
	word size)
{
	struct distributed_message_header *header = (struct distributed_message_header *)message;

	header->type = type;
	header->count = (byte)count;
	header->game_time = game_time_get();
	header->header = 0;
	build_message_header(&header->header, size, 2, 0);
	if (network_distributed_server_send_to_machine(machine_index, message, size))
		distributed_statistics.sent++;
}
#endif

struct player_datum *distributed_player(
	short player_index)
{
	struct player_datum *player;

	if (player_index < 0 || player_index >= player_data->maximum_count)
		return NULL;
	player = (struct player_datum *)((byte *)player_data->data + player_index * player_data->size);
	return player->identifier ? player : NULL;
}

byte distributed_player_to_byte(
	long player_index)
{
	return player_index != NONE ? (byte)DATUM_INDEX_TO_ABSOLUTE_INDEX(player_index) : NO_PLAYER;
}

long distributed_player_from_byte(
	byte player_index)
{
	struct player_datum *player = player_index != NO_PLAYER ? distributed_player(player_index) : NULL;

	return player ? DATUM_INDEX_NEW(player_index, player->identifier) : NONE;
}

boolean distributed_player_is_local(
	long player_index)
{
	struct player_datum *player = player_index != NONE ? player_try_and_get(player_index) : NULL;

	/* (never a spectator's target, which stands in as local player 0 only
	for drawing: spectator.c) */
	return player && player->local_player_index != NONE && !spectator_view_scoped();
}

long distributed_living_unit(
	struct player_datum const *player)
{
	if (!player || player->unit_index == NONE || !object_try_and_get(player->unit_index) ||
		TEST_FLAG(object_get(player->unit_index)->object.damage_flags, _object_dead_bit))
	{
		return NONE;
	}
	return player->unit_index;
}

boolean distributed_machine_has_player(
	long machine_index,
	short player_index)
{
	long *player_list = machine_get_player_list(machine_index);
	short local_player_index;

	for (local_player_index = 0; local_player_index < MAXIMUM_LOCAL_PLAYERS; local_player_index++)
	{
		if (player_list[local_player_index] != NONE &&
			DATUM_INDEX_TO_ABSOLUTE_INDEX(player_list[local_player_index]) == player_index)
		{
			return TRUE;
		}
	}
	return FALSE;
}

/* ---------- units */

static void distributed_state_from_player(
	short player_index,
	struct distributed_unit_state *state)
{
	struct player_datum *player = distributed_player(player_index);
	long unit_index = distributed_living_unit(player);

	csmemset(state, 0, sizeof(*state));
	state->player_index = (byte)player_index;
	state->unit_index = NONE;
	state->vehicle_index = NONE;
	state->seat_index = NONE;
	if (unit_index != NONE)
	{
		struct unit_datum *unit = unit_get(unit_index);
		struct damage_network_state damage;

		state->unit_index = unit_index;
		SET_FLAG(state->flags, _distributed_unit_alive_bit, TRUE);
		SET_FLAG(state->flags, _distributed_unit_placed_bit, unit->object.parent_object_index == NONE);
		if (unit->object.parent_object_index != NONE && unit->unit.parent_seat_index != NONE)
		{
			state->vehicle_index = unit->object.parent_object_index;
			state->seat_index = unit->unit.parent_seat_index;
		}
		state->position = unit->object.position;
		state->velocity = unit->object.translational_velocity;
		state->forward = unit->object.forward;
		state->up = unit->object.up;
		damage_get_network_state(unit_index, &damage);
		SET_FLAG(state->flags, _distributed_unit_shield_depleted_bit, damage.shield_depleted);
		SET_FLAG(state->flags, _distributed_unit_shield_charging_bit, damage.shield_charging);
		SET_FLAG(state->flags, _distributed_unit_shield_over_charging_bit, damage.shield_over_charging);
		state->body_vitality = damage.body_vitality;
		state->shield_vitality = damage.shield_vitality;
		state->current_body_damage = damage.current_body_damage;
		state->recent_body_damage = damage.recent_body_damage;
		state->current_shield_damage = damage.current_shield_damage;
		state->recent_shield_damage = damage.recent_shield_damage;
		csmemcpy(state->powerup_durations, player->powerup_durations, sizeof(state->powerup_durations));
		SET_FLAG(state->unit_flags, _distributed_unit_camouflaged_bit,
			TEST_FLAG(unit->unit.flags, _unit_active_camouflaged_bit));
		SET_FLAG(state->unit_flags, _distributed_unit_super_camouflaged_bit,
			TEST_FLAG(unit->unit.flags, _unit_super_camouflaged_bit));
		state->active_camouflage = unit->unit.active_camouflage;
	}
	state->killing_player_index = NO_PLAYER;
	if (unit_index == NONE)
		state->respawn_timer = (short)MIN(player->respawn_timer, 32767);
	if (unit_index == NONE && player_index < MAXIMUM_TRACKED_PLAYERS && distributed_deaths[player_index].valid)
	{
		struct distributed_death const *death = &distributed_deaths[player_index];

		if (death->killing_player_index != NONE)
			state->killing_player_index = (byte)death->killing_player_index;
		SET_FLAG(state->flags, _distributed_unit_friendly_fire_bit, death->friendly_fire);
		SET_FLAG(state->flags, _distributed_unit_killed_by_vehicle_bit, death->killed_by_vehicle);
	}
}

/* moves the unit to the state if it is further than tolerance from it */
static void distributed_apply_state(
	long unit_index,
	struct distributed_unit_state const *state,
	real tolerance)
{
	struct object_datum *object = object_get(unit_index);
	real_vector3d error;

	error.i = state->position.x - object->object.position.x;
	error.j = state->position.y - object->object.position.y;
	error.k = state->position.z - object->object.position.z;
	if (error.i * error.i + error.j * error.j + error.k * error.k <= tolerance * tolerance)
		return;
	distributed_statistics.corrections++;
	network_objects_correct(unit_index, &state->position, &state->forward, &state->up, &state->velocity, NULL);
}

#ifdef HALO_WEB
static void distributed_compact_bounds(
	real_rectangle3d *bounds)
{
	*bounds = global_structure_bsp_get()->world_bounds;
	bounds->x0 -= COMPACT_BOUNDS_MARGIN;
	bounds->x1 += COMPACT_BOUNDS_MARGIN;
	bounds->y0 -= COMPACT_BOUNDS_MARGIN;
	bounds->y1 += COMPACT_BOUNDS_MARGIN;
	bounds->z0 -= COMPACT_BOUNDS_MARGIN;
	bounds->z1 += COMPACT_BOUNDS_MARGIN;
	if (!distributed_compact_bounds_logged)
	{
		distributed_compact_bounds_logged = TRUE;
		platform_log("network: unit positions to %.4f %.4f %.4f world units",
			(bounds->x1 - bounds->x0) / 65535.0f, (bounds->y1 - bounds->y0) / 65535.0f,
			(bounds->z1 - bounds->z0) / 65535.0f);
	}
}

/* (a client, the browser builds) its own players' units, compactly: as
distributed_send_unit_states picks them */
static void distributed_send_compact_predictions(
	void)
{
	struct
	{
		struct distributed_message_header header;
		byte data[DATAGRAM_MAXIMUM_SIZE];
	} message;
	short room = (short)(DATAGRAM_MAXIMUM_SIZE - sizeof(message.header));
	struct data_iterator iterator;
	struct player_datum *player;
	real_rectangle3d bounds;
	short count = 0;
	short size = 0;

	distributed_compact_bounds(&bounds);
	data_iterator_new(&iterator, player_data);
	while ((player = (struct player_datum *)data_iterator_next(&iterator)) != NULL)
	{
		struct distributed_unit_state state;
		long unit_index = distributed_living_unit(player);
		short written;

		if (player->local_player_index == NONE || unit_index == NONE ||
			object_get(unit_index)->object.parent_object_index != NONE)
		{
			continue;
		}
		distributed_state_from_player((short)DATUM_INDEX_TO_ABSOLUTE_INDEX(iterator.datum_index), &state);
		written = distributed_compact_unit_state_write(message.data + size, (short)(room - size), &state, &bounds);
		if (!written)
			break;
		size += written;
		count++;
	}
	if (count)
	{
		distributed_send(&message, _distributed_message_compact_player_prediction, count,
			(word)(sizeof(message.header) + size), _distributed_to_host);
	}
}

#if OWN_UNIT_STATE_INTERVAL_TICKS > 1
/* (the host) whether a player's own machine can do without its unit's
state this tick: it had one less than OWN_UNIT_STATE_INTERVAL_TICKS ago, and
since then the unit has only moved, about as it was moving */
static boolean distributed_own_state_can_wait(
	short player_index,
	struct distributed_unit_state const *state)
{
	struct distributed_own_unit_sent const *sent;
	struct distributed_unit_state now;
	struct distributed_unit_state then;
	long ticks;
	real dx;
	real dy;
	real dz;

	if (player_index < 0 || player_index >= MAXIMUM_TRACKED_PLAYERS)
		return FALSE;
	sent = &distributed_own_sent[player_index];
	ticks = game_time_get() - sent->time;
	if (!sent->valid || ticks <= 0 || ticks >= OWN_UNIT_STATE_INTERVAL_TICKS ||
		state->unit_index == NONE || !TEST_FLAG(state->flags, _distributed_unit_placed_bit))
	{
		return FALSE;
	}
	/* (a seat, a life, shields, health, powerups: anything else at once) */
	now = *state;
	then = sent->state;
	csmemset(&now.position, 0, sizeof(now.position));
	csmemset(&now.velocity, 0, sizeof(now.velocity));
	csmemset(&now.forward, 0, sizeof(now.forward));
	csmemset(&now.up, 0, sizeof(now.up));
	csmemset(&then.position, 0, sizeof(then.position));
	csmemset(&then.velocity, 0, sizeof(then.velocity));
	csmemset(&then.forward, 0, sizeof(then.forward));
	csmemset(&then.up, 0, sizeof(then.up));
	if (csmemcmp(&now, &then, sizeof(now)) != 0)
		return FALSE;
	dx = state->position.x - (sent->state.position.x + sent->state.velocity.i * ticks);
	dy = state->position.y - (sent->state.position.y + sent->state.velocity.j * ticks);
	dz = state->position.z - (sent->state.position.z + sent->state.velocity.k * ticks);
	return dx * dx + dy * dy + dz * dz <= OWN_UNIT_STATE_JUMP * OWN_UNIT_STATE_JUMP;
}

/* (the host, the browser builds) every player's unit, compactly, to each
machine: its own players' as distributed_own_state_can_wait allows */
static void distributed_send_compact_unit_states(
	void)
{
	struct
	{
		struct distributed_message_header header;
		byte data[DATAGRAM_MAXIMUM_SIZE];
	} message;
	short room = (short)(DATAGRAM_MAXIMUM_SIZE - sizeof(message.header));
	byte encoded[MAXIMUM_TRACKED_PLAYERS][COMPACT_UNIT_STATE_MAXIMUM_SIZE];
	short encoded_size[MAXIMUM_TRACKED_PLAYERS];
	/* the machine that does without it this tick, NONE for none */
	long waiting[MAXIMUM_TRACKED_PLAYERS];
	short players = 0;
	struct data_iterator iterator;
	struct player_datum *player;
	real_rectangle3d bounds;
	long machine_index;

	distributed_compact_bounds(&bounds);
	data_iterator_new(&iterator, player_data);
	while ((player = (struct player_datum *)data_iterator_next(&iterator)) != NULL &&
		players < MAXIMUM_TRACKED_PLAYERS)
	{
		short player_index = (short)DATUM_INDEX_TO_ABSOLUTE_INDEX(iterator.datum_index);
		struct distributed_unit_state state;
		long owner = NONE;

		distributed_state_from_player(player_index, &state);
		encoded_size[players] = distributed_compact_unit_state_write(encoded[players],
			COMPACT_UNIT_STATE_MAXIMUM_SIZE, &state, &bounds);
		if (!encoded_size[players])
			continue;
		/* (the host's own players are its own word) */
		if (player->local_player_index == NONE)
		{
			for (machine_index = 0; machine_index < HALO_PORT_MAXIMUM_NETWORK_MACHINES; machine_index++)
			{
				if (distributed_machine_has_player(machine_index, player_index))
					owner = machine_index;
			}
		}
		waiting[players] = NONE;
		if (owner != NONE && distributed_own_state_can_wait(player_index, &state))
		{
			waiting[players] = owner;
		}
		else if (player_index < MAXIMUM_TRACKED_PLAYERS)
		{
			distributed_own_sent[player_index].valid = TRUE;
			distributed_own_sent[player_index].time = game_time_get();
			distributed_own_sent[player_index].state = state;
		}
		players++;
	}
	for (machine_index = 0; machine_index < HALO_PORT_MAXIMUM_NETWORK_MACHINES; machine_index++)
	{
		short count = 0;
		short size = 0;
		short index;

		for (index = 0; index < players; index++)
		{
			if (waiting[index] == machine_index)
				continue;
			if (size + encoded_size[index] > room || count == MAXIMUM_UNIT_STATES_PER_MESSAGE)
			{
				distributed_send_to_machine(machine_index, &message, _distributed_message_compact_unit_states,
					count, (word)(sizeof(message.header) + size));
				count = 0;
				size = 0;
			}
			csmemcpy(message.data + size, encoded[index], encoded_size[index]);
			size += encoded_size[index];
			count++;
		}
		if (count)
		{
			distributed_send_to_machine(machine_index, &message, _distributed_message_compact_unit_states,
				count, (word)(sizeof(message.header) + size));
		}
	}
}
#else
/* (the host, the browser builds) every player's unit, compactly */
static void distributed_send_compact_unit_states(
	void)
{
	struct
	{
		struct distributed_message_header header;
		byte data[DATAGRAM_MAXIMUM_SIZE];
	} message;
	short room = (short)(DATAGRAM_MAXIMUM_SIZE - sizeof(message.header));
	struct data_iterator iterator;
	struct player_datum *player;
	real_rectangle3d bounds;
	short count = 0;
	short size = 0;

	distributed_compact_bounds(&bounds);
	data_iterator_new(&iterator, player_data);
	while ((player = (struct player_datum *)data_iterator_next(&iterator)) != NULL)
	{
		struct distributed_unit_state state;
		short written;

		distributed_state_from_player((short)DATUM_INDEX_TO_ABSOLUTE_INDEX(iterator.datum_index), &state);
		written = distributed_compact_unit_state_write(message.data + size, (short)(room - size), &state, &bounds);
		if (!written || count == MAXIMUM_UNIT_STATES_PER_MESSAGE)
		{
			distributed_send(&message, _distributed_message_compact_unit_states, count,
				(word)(sizeof(message.header) + size), _distributed_to_clients);
			count = 0;
			size = 0;
			written = distributed_compact_unit_state_write(message.data, room, &state, &bounds);
		}
		size += written;
		count++;
	}
	if (count)
	{
		distributed_send(&message, _distributed_message_compact_unit_states, count,
			(word)(sizeof(message.header) + size), _distributed_to_clients);
	}
}
#endif
#endif

static void distributed_send_unit_states(
	boolean host)
{
	struct distributed_unit_state_message message;
	struct data_iterator iterator;
	struct player_datum *player;
	short count = 0;
	byte type = host ? _distributed_message_unit_states : _distributed_message_player_prediction;
	short destination = host ? _distributed_to_clients : _distributed_to_host;

#ifdef HALO_WEB
	if (host)
		distributed_send_compact_unit_states();
	else
		distributed_send_compact_predictions();
	return;
#endif
	data_iterator_new(&iterator, player_data);
	while ((player = (struct player_datum *)data_iterator_next(&iterator)) != NULL)
	{
		short player_index = (short)DATUM_INDEX_TO_ABSOLUTE_INDEX(iterator.datum_index);
		long unit_index;

		/* a client speaks for its own players only, where they are */
		if (!host)
		{
			unit_index = distributed_living_unit(player);
			if (player->local_player_index == NONE || unit_index == NONE ||
				object_get(unit_index)->object.parent_object_index != NONE)
			{
				continue;
			}
		}
		distributed_state_from_player(player_index, &message.states[count++]);
		if (count == DATAGRAM_ENTRIES(struct distributed_unit_state))
		{
			distributed_send(&message, type, count,
				(word)(sizeof(message.header) + count * sizeof(struct distributed_unit_state)), destination);
			count = 0;
		}
	}
	if (count)
	{
		distributed_send(&message, type, count,
			(word)(sizeof(message.header) + count * sizeof(struct distributed_unit_state)), destination);
	}
}

/* (the host) a client's own players: taken as they are, within a
tolerance, from the players of that machine only */
static void distributed_handle_predictions(
	long machine_index,
	struct distributed_unit_state const *states,
	short count)
{
	short index;

	for (index = 0; index < count; index++)
	{
		struct distributed_unit_state const *state = &states[index];
		long unit_index;

		if (!distributed_machine_has_player(machine_index, state->player_index))
			continue;
		unit_index = distributed_living_unit(distributed_player(state->player_index));
		if (unit_index != NONE && object_get(unit_index)->object.parent_object_index == NONE)
		{
			struct object_datum *object = object_get(unit_index);
			real dx = state->position.x - object->object.position.x;
			real dy = state->position.y - object->object.position.y;
			real dz = state->position.z - object->object.position.z;

			if (dx * dx + dy * dy + dz * dz <= HOST_ACCEPT_TOLERANCE * HOST_ACCEPT_TOLERANCE)
				distributed_apply_state(unit_index, state, 0.0f);
#ifdef HALO_WEB
			else
				distributed_web_statistics.rejected_predictions++;
#endif
		}
	}
}

/* (a client) the host's word on every player's unit */
static void distributed_handle_unit_states(
	struct distributed_unit_state const *states,
	short count)
{
	short index;

	for (index = 0; index < count; index++)
	{
		struct distributed_unit_state const *state = &states[index];
		struct player_datum *player = distributed_player(state->player_index);
		long player_index;
		long unit_index;
		boolean alive = TEST_FLAG(state->flags, _distributed_unit_alive_bit);
		boolean local;

		if (!player)
			continue;
		player_index = DATUM_INDEX_NEW(state->player_index, player->identifier);
		local = player->local_player_index != NONE;
		/* how it died, for when this machine's copy dies
		(network_distributed_player_killed) */
		if (state->player_index < MAXIMUM_TRACKED_PLAYERS)
		{
			struct distributed_death *death = &distributed_deaths[state->player_index];

			death->valid = !alive;
			death->killing_player_index = state->killing_player_index != NO_PLAYER ?
				state->killing_player_index : NONE;
			death->friendly_fire = TEST_FLAG(state->flags, _distributed_unit_friendly_fire_bit);
			death->killed_by_vehicle = TEST_FLAG(state->flags, _distributed_unit_killed_by_vehicle_bit);
		}
		unit_index = distributed_living_unit(player);
		if (state->player_index < MAXIMUM_TRACKED_PLAYERS)
		{
			long *missing_time = &distributed_missing_unit_times[state->player_index];
			long *wait = &distributed_missing_unit_waits[state->player_index];

			if (!alive || state->unit_index == NONE || network_objects_client_has(state->unit_index))
			{
				*missing_time = NONE;
				/* (present: the next time it goes missing, the first wait) */
				if (alive && state->unit_index != NONE)
					*wait = MISSING_UNIT_TICKS;
			}
			else if (*missing_time == NONE)
			{
				*missing_time = game_time_get();
				if (*wait < MISSING_UNIT_TICKS)
					*wait = MISSING_UNIT_TICKS;
			}
			else if (game_time_get() - *missing_time >= *wait)
			{
				platform_log("network: player %d is alive on the host in unit %08lx, which this machine "
					"does not have after %ld s; asking for the host's objects again",
					(int)state->player_index, (unsigned long)state->unit_index,
					(game_time_get() - *missing_time) / TICKS_PER_SECOND);
#ifdef HALO_WEB
				distributed_web_statistics.object_resyncs++;
#endif
				network_objects_resynchronize();
				*missing_time = game_time_get();
				*wait = *wait * 2 > MISSING_UNIT_MAXIMUM_TICKS ? MISSING_UNIT_MAXIMUM_TICKS : *wait * 2;
			}
		}
		if (!alive)
		{
			/* died on the host (who counts it; the damage that killed it,
			network_damage.c, usually kills it here first) */
			if (unit_index != NONE)
				unit_kill_no_statistics(unit_index);
			/* the host's respawn timer, which this machine counts down between
			ticks (game_engine_client_respawn_countdown): taken when it is
			further off than the host's word is late */
			if (distributed_living_unit(player) == NONE)
			{
				long difference = player->respawn_timer - state->respawn_timer;

				if (difference > RESPAWN_TIMER_TOLERANCE || difference < -RESPAWN_TIMER_TOLERANCE)
					player->respawn_timer = state->respawn_timer;
			}
			continue;
		}
		/* spawned on the host: the host's unit is the player's here too, once
		this machine has it (network_objects.c) */
		if (state->unit_index == NONE || !network_objects_client_has(state->unit_index) ||
			TEST_FLAG(object_get(state->unit_index)->object.damage_flags, _object_dead_bit))
		{
			continue;
		}
		if (player->unit_index != state->unit_index)
		{
			if (player->unit_index != NONE)
				network_player_detach_unit(player_index);
			network_player_attach_unit(player_index, state->unit_index);
			game_engine_client_respawned(player_index);
			/* (a unit of a life this machine missed the end of, no player's
			now: unit_kill_no_statistics is for players' units only) */
			if (unit_index != NONE && unit_index != state->unit_index)
				unit_kill(unit_index);
		}
		unit_index = state->unit_index;
		/* the seat it rides: a client's own player's, once it has ridden
		otherwise for longer than its prediction takes to reach the host and
		come back */
		{
			struct unit_datum *unit = unit_get(unit_index);
			long vehicle_index = unit->object.parent_object_index != NONE && unit->unit.parent_seat_index != NONE ?
				unit->object.parent_object_index : NONE;
			boolean same = vehicle_index == state->vehicle_index &&
				(vehicle_index == NONE || unit->unit.parent_seat_index == state->seat_index);
			short *disagreement = &distributed_seat_disagreements[state->player_index];

#if defined(HALO_WEB) && OWN_UNIT_STATE_INTERVAL_TICKS > 1
			long elapsed = game_time_get() - distributed_seat_times[state->player_index];

			distributed_seat_times[state->player_index] = game_time_get();
			elapsed = elapsed < 1 ? 1 : elapsed > SEAT_DISAGREEMENT_TICKS ? SEAT_DISAGREEMENT_TICKS : elapsed;
			if (!same)
				*disagreement += (short)(elapsed - 1);
#endif
			if (same)
				*disagreement = 0;
			else if (!local || ++*disagreement > SEAT_DISAGREEMENT_TICKS)
			{
#ifdef HALO_WEB
				if (local)
					distributed_web_statistics.own_seat_corrections++;
#endif
				network_objects_set_seat(unit_index, state->vehicle_index, state->seat_index);
				*disagreement = 0;
			}
		}
		{
			struct damage_network_state damage;

			damage.shield_depleted = TEST_FLAG(state->flags, _distributed_unit_shield_depleted_bit);
			damage.shield_charging = TEST_FLAG(state->flags, _distributed_unit_shield_charging_bit);
			damage.shield_over_charging = TEST_FLAG(state->flags, _distributed_unit_shield_over_charging_bit);
			damage.body_vitality = state->body_vitality;
			damage.shield_vitality = state->shield_vitality;
			damage.current_body_damage = state->current_body_damage;
			damage.recent_body_damage = state->recent_body_damage;
			damage.current_shield_damage = state->current_shield_damage;
			damage.recent_shield_damage = state->recent_shield_damage;
			damage_set_network_state(unit_index, &damage);
		}
		/* the host's powerups (the host decides pickups) */
		{
			struct unit_datum *unit = unit_get(unit_index);

			csmemcpy(player->powerup_durations, state->powerup_durations, sizeof(player->powerup_durations));
			SET_FLAG(unit->unit.flags, _unit_active_camouflaged_bit,
				TEST_FLAG(state->unit_flags, _distributed_unit_camouflaged_bit));
			SET_FLAG(unit->unit.flags, _unit_super_camouflaged_bit,
				TEST_FLAG(state->unit_flags, _distributed_unit_super_camouflaged_bit));
			unit->unit.active_camouflage = state->active_camouflage;
		}
		if (TEST_FLAG(state->flags, _distributed_unit_placed_bit) &&
			object_get(unit_index)->object.parent_object_index == NONE)
		{
#ifdef HALO_WEB
			if (local)
			{
				struct object_datum *object = object_get(unit_index);
				real dx = state->position.x - object->object.position.x;
				real dy = state->position.y - object->object.position.y;
				real dz = state->position.z - object->object.position.z;
				real distance_squared = dx * dx + dy * dy + dz * dz;

				if (distance_squared > LOCAL_CORRECTION_TOLERANCE * LOCAL_CORRECTION_TOLERANCE)
				{
					real_vector3d const *forward = &object->object.forward;
					real dot = forward->i * state->forward.i + forward->j * state->forward.j +
						forward->k * state->forward.k;
					real degrees = (real)(acos(dot < -1.0f ? -1.0f : dot > 1.0f ? 1.0f : dot) * 180.0 / 3.14159265358979);

					distributed_web_statistics.own_corrections++;
					if (distance_squared > distributed_web_statistics.own_correction_maximum_squared)
						distributed_web_statistics.own_correction_maximum_squared = distance_squared;
					if (degrees > OWN_AIM_CORRECTION_DEGREES)
					{
						distributed_web_statistics.own_aim_corrections++;
						if (degrees > distributed_web_statistics.own_aim_correction_maximum_degrees)
							distributed_web_statistics.own_aim_correction_maximum_degrees = degrees;
					}
				}
			}
#endif
#ifdef HALO_WEB
			if (!local)
			{
				struct object_datum *object = object_get(unit_index);
				real dx = state->position.x - object->object.position.x;
				real dy = state->position.y - object->object.position.y;
				real dz = state->position.z - object->object.position.z;
				real distance = (real)sqrt(dx * dx + dy * dy + dz * dz);

				web_feel_sample(&web_feel.remote, distance);
				if (distance > WEB_FEEL_REMOTE_SNAP)
					web_feel.remote_snaps++;
			}
#endif
			distributed_apply_state(unit_index, state, local ? LOCAL_CORRECTION_TOLERANCE : REMOTE_CORRECTION_TOLERANCE);
		}
	}
}

/* ---------- deaths */

/* a player died (game_engine_player_killed, before it announces who killed
whom): the host notes who killed them for its clients; on a client, whose
copy of the death knows nothing of the killer, the host's killer, as this
machine has them */
void network_distributed_player_killed(
	long *killing_player_index,
	long *killing_object_index,
	long dead_player_index,
	boolean *friendly_fire)
{
	short dead_absolute_index = (short)DATUM_INDEX_TO_ABSOLUTE_INDEX(dead_player_index);
	struct distributed_death *death;

	if (!network_game_distributed() || dead_absolute_index < 0 || dead_absolute_index >= MAXIMUM_TRACKED_PLAYERS)
		return;
	death = &distributed_deaths[dead_absolute_index];
	if (game_connection() == _game_connection_network_server)
	{
		struct object_datum *killing_object = *killing_object_index != NONE ?
			object_try_and_get(*killing_object_index) : NULL;

		death->valid = TRUE;
		death->killing_player_index = *killing_player_index != NONE ?
			(short)DATUM_INDEX_TO_ABSOLUTE_INDEX(*killing_player_index) : NONE;
		death->friendly_fire = *friendly_fire;
		death->killed_by_vehicle = *killing_player_index == NONE && killing_object &&
			killing_object->object.type == _object_type_vehicle;
		distributed_statistics_due = TRUE;
	}
	else if (game_connection() == _game_connection_network_client && death->valid)
	{
		struct player_datum *killing_player = death->killing_player_index != NONE ?
			distributed_player(death->killing_player_index) : NULL;

		*friendly_fire = death->friendly_fire;
		*killing_player_index = NONE;
		if (killing_player)
		{
			*killing_player_index = DATUM_INDEX_NEW(death->killing_player_index, killing_player->identifier);
			*killing_object_index = killing_player->unit_index;
		}
		/* (an empty vehicle's: the one that did it, the same object here) */
		else if (!death->killed_by_vehicle || *killing_object_index == NONE ||
			!object_try_and_get(*killing_object_index) ||
			object_get(*killing_object_index)->object.type != _object_type_vehicle)
		{
			*killing_object_index = NONE;
		}
	}
}

/* (a client) the host's word on how a player died, with the damage that
killed them (network_damage.c), before this machine's copy dies */
void distributed_set_death(
	short dead_player_index,
	byte killing_player_index,
	boolean friendly_fire,
	boolean killed_by_vehicle)
{
	struct distributed_death *death;

	if (dead_player_index < 0 || dead_player_index >= MAXIMUM_TRACKED_PLAYERS)
		return;
	death = &distributed_deaths[dead_player_index];
	death->valid = TRUE;
	death->killing_player_index = killing_player_index != NO_PLAYER ? killing_player_index : NONE;
	death->friendly_fire = friendly_fire;
	death->killed_by_vehicle = killed_by_vehicle;
}

/* (the host) how a player died, for the damage that killed them */
boolean distributed_get_death(
	short dead_player_index,
	byte *killing_player_index,
	boolean *friendly_fire,
	boolean *killed_by_vehicle)
{
	struct distributed_death const *death;

	if (dead_player_index < 0 || dead_player_index >= MAXIMUM_TRACKED_PLAYERS)
		return FALSE;
	death = &distributed_deaths[dead_player_index];
	*killing_player_index = death->killing_player_index != NONE ? (byte)death->killing_player_index : NO_PLAYER;
	*friendly_fire = death->friendly_fire;
	*killed_by_vehicle = death->killed_by_vehicle;
	return death->valid;
}

/* ---------- pickups */

/* (the host) a player on another machine picked something up (players.c),
for that machine to show */
void network_distributed_player_picked_up(
	long player_index,
	short kind,
	long definition_index,
	short count)
{
	struct distributed_pickup *pickup;

	if (!network_game_distributed() || game_connection() != _game_connection_network_server ||
		distributed_pickup_count >= MAXIMUM_PICKUPS_PER_TICK)
	{
		return;
	}
	pickup = &distributed_pickups[distributed_pickup_count++];
	pickup->player_index = distributed_player_to_byte(player_index);
	pickup->kind = (byte)kind;
	pickup->count = count;
	pickup->definition_index = definition_index;
}

static void distributed_send_pickups(
	void)
{
	struct
	{
		struct distributed_message_header header;
		struct distributed_pickup pickups[MAXIMUM_PICKUPS_PER_TICK];
	} message;

	if (!distributed_pickup_count)
		return;
	csmemcpy(message.pickups, distributed_pickups, distributed_pickup_count * sizeof(struct distributed_pickup));
	distributed_send(&message, _distributed_message_pickups, distributed_pickup_count,
		(word)(sizeof(message.header) + distributed_pickup_count * sizeof(struct distributed_pickup)),
		_distributed_to_clients_reliably);
	distributed_pickup_count = 0;
}

/* ---------- statistics */

static void distributed_send_statistics(
	void)
{
	struct distributed_statistics_message message;
	struct data_iterator iterator;
	struct player_datum *player;
	short count = 0;

	data_iterator_new(&iterator, player_data);
	while ((player = (struct player_datum *)data_iterator_next(&iterator)) != NULL)
	{
		message.players[count].player_index = (short)DATUM_INDEX_TO_ABSOLUTE_INDEX(iterator.datum_index);
		message.players[count].pad = 0;
		message.players[count].statistics = player->statistics;
		count++;
		if (count == DATAGRAM_ENTRIES(struct distributed_player_statistics))
		{
			distributed_send(&message, _distributed_message_player_statistics, count,
				(word)(sizeof(message.header) + count * sizeof(struct distributed_player_statistics)),
				_distributed_to_clients);
			count = 0;
		}
	}
	if (count)
	{
		distributed_send(&message, _distributed_message_player_statistics, count,
			(word)(sizeof(message.header) + count * sizeof(struct distributed_player_statistics)),
			_distributed_to_clients);
	}
}

/* ---------- the game type's state */

static void distributed_send_game_state(
	void)
{
	struct
	{
		struct distributed_message_header header;
		byte data[MAXIMUM_GAME_STATE_SIZE];
	} message;
	long size = game_engine_write_network_state(message.data, sizeof(message.data));

#ifdef HALO_WEB
	/* (the browser builds) when it changes, at least once a second, and for
	a machine that has loaded; its zero runs packed (the scores of 128
	players, most of them none) */
	if (size > 0 && (distributed_game_state_due || size != distributed_game_state_sent_size ||
		csmemcmp(message.data, distributed_game_state_sent, size) != 0 ||
		distributed_game_state_sent_time == NONE ||
		game_time_get() - distributed_game_state_sent_time >= GAME_STATE_REFRESH_TICKS))
	{
		struct
		{
			struct distributed_message_header header;
			byte data[MAXIMUM_GAME_STATE_SIZE + MAXIMUM_GAME_STATE_SIZE / 64 + 4];
		} packed;
		long packed_size = distributed_pack_zero_runs(packed.data, sizeof(packed.data), message.data, size);

		if (packed_size > 0)
		{
			distributed_send(&packed, _distributed_message_compact_game_state, 0,
				(word)(sizeof(packed.header) + packed_size), _distributed_to_clients_reliably);
			csmemcpy(distributed_game_state_sent, message.data, size);
			distributed_game_state_sent_size = size;
			distributed_game_state_sent_time = game_time_get();
			distributed_game_state_due = FALSE;
		}
	}
	return;
#endif
	/* (larger than a datagram) */
	if (size > 0)
	{
		distributed_send(&message, _distributed_message_game_state, 0, (word)(sizeof(message.header) + size),
			_distributed_to_clients_reliably);
	}
}

/* ---------- the game */

/* a new map loading (game.c), before any of the new game's messages can
apply: nothing sent or had yet */
void network_distributed_new_game(
	void)
{
	distributed_last_sent_time = NONE;
	csmemset(distributed_deaths, 0, sizeof(distributed_deaths));
	csmemset(distributed_seat_disagreements, 0, sizeof(distributed_seat_disagreements));
	csmemset(distributed_missing_unit_times, 0xFF, sizeof(distributed_missing_unit_times));
	csmemset(distributed_missing_unit_waits, 0, sizeof(distributed_missing_unit_waits));
	csmemset(distributed_deferred_teams, 0xFF, sizeof(distributed_deferred_teams));
	csmemset(distributed_team_switch_times, 0xFF, sizeof(distributed_team_switch_times));
#if defined(HALO_WEB) && OWN_UNIT_STATE_INTERVAL_TICKS > 1
	csmemset(distributed_seat_times, 0, sizeof(distributed_seat_times));
	csmemset(distributed_own_sent, 0, sizeof(distributed_own_sent));
#endif
	distributed_statistics_due = FALSE;
	distributed_pickup_count = 0;
	/* (each player's latest input: player_queues_new.c) */
	update_queues_distributed_reset();
#ifdef HALO_WEB
	distributed_game_state_sent_size = 0;
	distributed_game_state_sent_time = NONE;
	distributed_game_state_due = TRUE;
	distributed_compact_bounds_logged = FALSE;
#endif
	network_objects_new_game();
	network_damage_new_game();
}

boolean network_distributed_defer_team(
	long player_index,
	char team_index)
{
	long absolute_index = DATUM_INDEX_TO_ABSOLUTE_INDEX(player_index);
	struct player_datum *player;

	if (game_connection() != _game_connection_network_server ||
		absolute_index < 0 || absolute_index >= MAXIMUM_TRACKED_PLAYERS)
	{
		return FALSE;
	}
	player = distributed_player((short)absolute_index);
	if (distributed_deferred_teams[absolute_index] == NONE && player && player->team_index == team_index)
		return TRUE;
	/* (the first call's time: the host's client copies defer it again) */
	if (distributed_deferred_teams[absolute_index] == NONE ||
		game_time_get() - distributed_deferred_team_times[absolute_index] >= DEFERRED_TEAM_MAXIMUM_TICKS)
	{
		distributed_deferred_team_times[absolute_index] = game_time_get();
	}
	distributed_deferred_teams[absolute_index] = team_index;
	return TRUE;
}

void network_distributed_note_team_switch(
	long player_index)
{
	long absolute_index = DATUM_INDEX_TO_ABSOLUTE_INDEX(player_index);

	if (absolute_index >= 0 && absolute_index < MAXIMUM_TRACKED_PLAYERS)
		distributed_team_switch_times[absolute_index] = game_time_get();
}

/* (once) whether this death is a team switch's */
boolean network_distributed_team_switch_death(
	long dead_player_index)
{
	long absolute_index = DATUM_INDEX_TO_ABSOLUTE_INDEX(dead_player_index);
	long time;

	if (!network_game_distributed() || absolute_index < 0 || absolute_index >= MAXIMUM_TRACKED_PLAYERS)
		return FALSE;
	time = distributed_team_switch_times[absolute_index];
	distributed_team_switch_times[absolute_index] = NONE;
	return time != NONE && game_time_get() - time <= TEAM_SWITCH_DEATH_TICKS;
}

/* (the host, after each tick) the deferred teams of players whose units have
died (and dropped what they carried), or after a second whatever happened */
static void distributed_apply_deferred_teams(
	void)
{
	long absolute_index;

	for (absolute_index = 0; absolute_index < MAXIMUM_TRACKED_PLAYERS; absolute_index++)
	{
		struct player_datum *player;

		if (distributed_deferred_teams[absolute_index] == NONE)
			continue;
		player = distributed_player((short)absolute_index);
		if (player && distributed_living_unit(player) != NONE &&
			game_time_get() - distributed_deferred_team_times[absolute_index] < DEFERRED_TEAM_MAXIMUM_TICKS)
		{
			continue;
		}
		if (player)
			player->team_index = (signed char)distributed_deferred_teams[absolute_index];
		distributed_deferred_teams[absolute_index] = NONE;
	}
}

/* after each tick (game_time.c) */
void network_distributed_tick(
	void)
{
	short connection = game_connection();

	if (!network_game_distributed() || game_time_get() == distributed_last_sent_time)
		return;
#ifdef HALO_WEB
	distributed_web_statistics.ticks++;
#endif
	distributed_last_sent_time = game_time_get();
	if (connection == _game_connection_network_server)
	{
		/* the objects first (created before anything names them), the damage
		dealt this tick before the units it hurt and killed, and a kill's
		statistics before the kill, so that a client announcing it counts it
		(a double kill, a killing spree) */
		distributed_apply_deferred_teams();
		network_objects_host_tick();
		network_damage_host_tick();
		if (distributed_statistics_due || game_time_get() % STATISTICS_INTERVAL_TICKS == 0)
			distributed_send_statistics();
		distributed_statistics_due = FALSE;
		distributed_send_unit_states(TRUE);
		distributed_send_pickups();
		if (game_time_get() % GAME_STATE_INTERVAL_TICKS == 0)
			distributed_send_game_state();
	}
	else if (connection == _game_connection_network_client)
	{
		distributed_send_unit_states(FALSE);
		network_objects_client_tick();
		network_damage_client_tick();
	}
}

/* a message of the distributed kind; machine_index is the sender's on the
host, NONE on a client */
void network_distributed_handle_message(
	long machine_index,
	word const *message,
	word size)
{
	struct distributed_message_header header;
	void const *entries = (byte const *)message + sizeof(header);
	short index;
	word entry_size;

	/* (none between games: loading, or in the menus) */
	if (size < sizeof(header) || !network_game_distributed() || !game_in_progress())
		return;
	csmemcpy(&header, message, sizeof(header));
	switch (header.type)
	{
	case _distributed_message_player_prediction:
	case _distributed_message_unit_states: entry_size = sizeof(struct distributed_unit_state); break;
	case _distributed_message_player_statistics: entry_size = sizeof(struct distributed_player_statistics); break;
	case _distributed_message_pickups: entry_size = sizeof(struct distributed_pickup); break;
	case _distributed_message_game_state:
	case _distributed_message_objects_synchronized:
	case _distributed_message_client_ready: entry_size = 0; break;
	case _distributed_message_damage_events:
	case _distributed_message_hit_reports: entry_size = network_damage_entry_size(header.type); break;
#ifdef HALO_WEB
	/* (their entries vary in size: read as they come) */
	case _distributed_message_compact_unit_states:
	case _distributed_message_compact_inventories:
	case _distributed_message_compact_game_state:
	case _distributed_message_compact_player_prediction: entry_size = 0; break;
#endif
	default: entry_size = network_objects_entry_size(header.type); break;
	}
	if (header.type == 0 || header.type >= NUMBER_OF_DISTRIBUTED_MESSAGES ||
		size < sizeof(header) + header.count * entry_size)
	{
		return;
	}
	distributed_statistics.received++;

	/* (each kind from the host, or from a client) */
	switch (header.type)
	{
	case _distributed_message_player_prediction:
	case _distributed_message_client_ready:
	case _distributed_message_hit_reports:
	case _distributed_message_vehicle_prediction:
#ifdef HALO_WEB
	case _distributed_message_compact_player_prediction:
#endif
		if (machine_index == NONE || game_connection() != _game_connection_network_server)
			return;
		break;
	default:
		if (game_connection() != _game_connection_network_client)
			return;
		break;
	}

	switch (header.type)
	{
	case _distributed_message_player_prediction:
		distributed_handle_predictions(machine_index, (struct distributed_unit_state const *)entries, header.count);
		break;
	case _distributed_message_unit_states:
		distributed_handle_unit_states((struct distributed_unit_state const *)entries, header.count);
		break;
	case _distributed_message_player_statistics:
	{
		/* the host's count of kills, deaths, ... */
		struct distributed_player_statistics const *players = (struct distributed_player_statistics const *)entries;

		for (index = 0; index < header.count; index++)
		{
			struct player_datum *player = distributed_player(players[index].player_index);

			if (player)
				player->statistics = players[index].statistics;
		}
		break;
	}
	case _distributed_message_inventories:
		network_objects_handle_inventories(entries, header.count);
		break;
	case _distributed_message_object_changes:
		network_objects_handle_changes(entries, header.count);
		break;
	case _distributed_message_object_states:
		network_objects_handle_states(entries, header.count);
		break;
	case _distributed_message_game_state:
		game_engine_read_network_state((byte const *)entries, size - sizeof(header));
		break;
#ifdef HALO_WEB
	case _distributed_message_compact_unit_states:
	{
		struct distributed_unit_state states[MAXIMUM_UNIT_STATES_PER_MESSAGE];
		byte const *data = (byte const *)entries;
		long available = size - (long)sizeof(header);
		real_rectangle3d bounds;
		short count = 0;

		distributed_compact_bounds(&bounds);
		while (count < header.count && count < MAXIMUM_UNIT_STATES_PER_MESSAGE)
		{
			short read = distributed_compact_unit_state_read(data, available, &states[count], &bounds);

			if (!read)
				break;
			data += read;
			available -= read;
			count++;
		}
		distributed_web_note_state_age(header.game_time);
		distributed_handle_unit_states(states, count);
		break;
	}
	case _distributed_message_compact_inventories:
		network_objects_handle_compact_inventories(entries, size - (long)sizeof(header), header.count);
		break;
	case _distributed_message_compact_player_prediction:
	{
		struct distributed_unit_state states[MAXIMUM_LOCAL_PLAYERS];
		byte const *data = (byte const *)entries;
		long available = size - (long)sizeof(header);
		real_rectangle3d bounds;
		short count = 0;

		distributed_compact_bounds(&bounds);
		while (count < header.count && count < MAXIMUM_LOCAL_PLAYERS)
		{
			short read = distributed_compact_unit_state_read(data, available, &states[count], &bounds);

			if (!read)
				break;
			data += read;
			available -= read;
			count++;
		}
		distributed_handle_predictions(machine_index, states, count);
		break;
	}
	case _distributed_message_compact_game_state:
	{
		byte state[MAXIMUM_GAME_STATE_SIZE];
		long state_size = distributed_unpack_zero_runs(state, sizeof(state), (byte const *)entries,
			size - (long)sizeof(header));

		if (state_size > 0)
			game_engine_read_network_state(state, state_size);
		break;
	}
#endif
	case _distributed_message_objects_synchronized:
		network_objects_handle_synchronized();
		break;
	case _distributed_message_client_ready:
		network_objects_client_ready(machine_index);
#ifdef HALO_WEB
		/* (a machine that has loaded: the whole game type's state and every
		inventory at their next sends, not only what changes) */
		distributed_game_state_due = TRUE;
		network_objects_inventories_due();
#endif
		break;
	case _distributed_message_damage_events:
		network_damage_handle_events(entries, header.count);
		break;
	case _distributed_message_hit_reports:
		network_damage_handle_reports(machine_index, entries, header.count);
		break;
	case _distributed_message_vehicle_prediction:
		network_objects_handle_vehicle_prediction(machine_index, entries, header.count);
		break;
	case _distributed_message_pickups:
	{
		/* what the host says this machine's players picked up */
		struct distributed_pickup const *pickups = (struct distributed_pickup const *)entries;

		for (index = 0; index < header.count; index++)
		{
			long player_index = distributed_player_from_byte(pickups[index].player_index);

			if (distributed_player_is_local(player_index))
			{
				network_player_show_pickup(player_index, pickups[index].kind, pickups[index].definition_index,
					pickups[index].count);
			}
		}
		break;
	}
	}
}
