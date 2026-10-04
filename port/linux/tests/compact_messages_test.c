/* The browser builds' compact distributed messages (port/linux/game/network_distributed.c
   and network_objects.c): a unit state, an inventory and the game type's state
   come back as the host had them, within the stated resolutions, from a few
   dozen bytes instead of a hundred, and a malformed one is refused. The
   functions come from the real source (compact_messages_test.js extracts them,
   and checks that only the browser builds use them). */
#include <math.h>
#include <stdio.h>
#include <string.h>

typedef int boolean;
typedef float real;
typedef unsigned char byte;
typedef unsigned short word;
typedef struct { real x, y, z; } real_point3d;
typedef struct { real i, j, k; } real_vector3d;
typedef struct { real x0, x1, y0, y1, z0, z1; } real_rectangle3d;
#define TRUE 1
#define FALSE 0
#define NONE (-1)
#define NO_PLAYER 0xFF
#define FLAG(bit) (1u << (bit))
#define TEST_FLAG(flags, bit) (((flags) & FLAG(bit)) != 0)
#define SET_FLAG(flags, bit, value) ((value) ? ((flags) |= FLAG(bit)) : ((flags) &= ~FLAG(bit)))
#define csmemcpy memcpy
#define csmemset memset
#define NUMBER_OF_PLAYER_POWERUPS 2
#define NUMBER_OF_UNIT_GRENADE_TYPES 2
#define MAXIMUM_WEAPONS_PER_UNIT 4

#include "compact_messages.inc"

static int failures;

static void check(int condition, const char *what)
{
	if (!condition)
	{
		printf("FAIL: %s\n", what);
		failures++;
	}
}

static real distance(real_point3d const *a, real_point3d const *b)
{
	return (real)sqrt((a->x - b->x) * (a->x - b->x) + (a->y - b->y) * (a->y - b->y) + (a->z - b->z) * (a->z - b->z));
}

/* (atan2 of the cross and dot products: exact for small angles, where acos
of a float near 1 is not) */
static real degrees_between(real_vector3d const *a, real_vector3d const *b)
{
	double cx = (double)a->j * b->k - (double)a->k * b->j;
	double cy = (double)a->k * b->i - (double)a->i * b->k;
	double cz = (double)a->i * b->j - (double)a->j * b->i;
	double dot = (double)a->i * b->i + (double)a->j * b->j + (double)a->k * b->k;

	return (real)(atan2(sqrt(cx * cx + cy * cy + cz * cz), dot) * 180.0 / 3.14159265358979);
}

static void normalize(real_vector3d *v)
{
	real length = (real)sqrt(v->i * v->i + v->j * v->j + v->k * v->k);

	v->i /= length;
	v->j /= length;
	v->k /= length;
}

int main(void)
{
	/* a map 600 x 400 x 120 world units, with the margin (larger than any
	stock map): 0.009 / 0.006 / 0.002 world units a step */
	real_rectangle3d bounds = { -364.0f, 364.0f, -264.0f, 264.0f, -84.0f, 84.0f };
	real resolution = (bounds.x1 - bounds.x0) / 65535.0f;
	struct distributed_unit_state state, back;
	byte buffer[256];
	short size, read;
	int trial;

	/* a running player, aiming down a little */
	memset(&state, 0, sizeof(state));
	state.player_index = 7;
	SET_FLAG(state.flags, _distributed_unit_alive_bit, TRUE);
	SET_FLAG(state.flags, _distributed_unit_placed_bit, TRUE);
	SET_FLAG(state.flags, _distributed_unit_shield_charging_bit, TRUE);
	state.killing_player_index = NO_PLAYER;
	state.unit_index = 0x1234abcd;
	state.vehicle_index = NONE;
	state.seat_index = NONE;
	state.position.x = 123.456f;
	state.position.y = -201.789f;
	state.position.z = 31.25f;
	state.velocity.i = 0.11f;
	state.velocity.j = -0.07f;
	state.velocity.k = -0.002f;
	state.forward.i = 0.6f;
	state.forward.j = 0.79f;
	state.forward.k = -0.1f;
	normalize(&state.forward);
	state.up.k = 1.0f;
	state.body_vitality = 1.0f;
	state.shield_vitality = 0.734f;
	size = distributed_compact_unit_state_write(buffer, sizeof(buffer), &state, &bounds);
	check(size == 4 + 4 + 6 + 6 + 4 + 4, "a running player in 28 bytes (96 plain)");
	read = distributed_compact_unit_state_read(buffer, size, &back, &bounds);
	check(read == size, "and read back whole");
	check(back.player_index == 7 && back.flags == state.flags && back.unit_index == 0x1234abcd &&
		back.vehicle_index == NONE && back.seat_index == NONE && back.killing_player_index == NO_PLAYER,
		"the player, flags, unit and no vehicle exactly");
	check(fabs(back.position.x - state.position.x) <= resolution / 2 + 1e-4f &&
		fabs(back.position.y - state.position.y) <= resolution / 2 + 1e-4f &&
		fabs(back.position.z - state.position.z) <= resolution / 2 + 1e-4f, "the position within half a step");
	check(distance(&back.position, &state.position) < 0.01f, "under a hundredth of a world unit");
	check(fabs(back.velocity.i - state.velocity.i) < 0.0002f && fabs(back.velocity.j - state.velocity.j) < 0.0002f &&
		fabs(back.velocity.k - state.velocity.k) < 0.0002f, "the velocity within 0.0002 world units a tick");
	check(degrees_between(&back.forward, &state.forward) < 0.01f, "the facing within a hundredth of a degree");
	check(back.up.i == 0.0f && back.up.j == 0.0f && back.up.k == 1.0f, "the world's up, not sent");
	check(fabs(back.body_vitality - 1.0f) < 0.001f && fabs(back.shield_vitality - 0.734f) < 0.001f,
		"the shields and body within a thousandth");
	check(back.current_body_damage == 0.0f && back.powerup_durations[0] == 0 && back.unit_flags == 0,
		"no damage or powerups, not sent");

	/* random facings and ups, every octant */
	{
		real worst = 0.0f;

		for (trial = 0; trial < 20000; trial++)
		{
			real_vector3d v, w;
			byte octahedral[4];
			real error;

			v.i = (real)sin(trial * 1.37) * (trial % 3 ? 1.0f : -1.0f);
			v.j = (real)cos(trial * 2.11) * (trial % 5 ? 1.0f : -1.0f);
			v.k = (real)sin(trial * 0.73 + 1.0) * (trial % 2 ? 1.0f : -1.0f);
			normalize(&v);
			distributed_octahedral_write(octahedral, &v);
			distributed_octahedral_read(octahedral, &w);
			error = degrees_between(&v, &w);
			if (error > worst)
				worst = error;
		}
		printf("octahedral: worst %.4f degrees of 20,000\n", worst);
		check(worst < 0.01f, "a unit vector within a hundredth of a degree");
	}

	/* hurt, camouflaged, in a vehicle's seat, tilted */
	state.vehicle_index = 0x00420011;
	state.seat_index = 2;
	SET_FLAG(state.flags, _distributed_unit_placed_bit, FALSE);
	state.up.i = 0.2f;
	state.up.k = 0.98f;
	normalize(&state.up);
	state.current_body_damage = 0.25f;
	state.recent_body_damage = 0.125f;
	state.current_shield_damage = 1.5f;
	state.recent_shield_damage = 0.0f;
	state.unit_flags = 3;
	state.active_camouflage = 0.6f;
	state.powerup_durations[0] = 900;
	state.powerup_durations[1] = -1;
	size = distributed_compact_unit_state_write(buffer, sizeof(buffer), &state, &bounds);
	read = distributed_compact_unit_state_read(buffer, size, &back, &bounds);
	check(read == size && back.vehicle_index == 0x00420011 && back.seat_index == 2, "the vehicle and seat exactly");
	check(!TEST_FLAG(back.flags, _distributed_unit_placed_bit), "a rider's position is its vehicle's: not sent");
	check(degrees_between(&back.up, &state.up) < 0.01f, "a tilted up, sent");
	check(fabs(back.current_body_damage - 0.25f) < 0.001f && fabs(back.recent_body_damage - 0.125f) < 0.001f &&
		fabs(back.current_shield_damage - 1.5f) < 0.002f && back.recent_shield_damage == 0.0f, "the damage");
	check(back.unit_flags == 3 && fabs(back.active_camouflage - 0.6f) < 0.001f &&
		back.powerup_durations[0] == 900 && back.powerup_durations[1] == -1, "the powerups and camouflage");

	/* out of the map, and flung */
	state.vehicle_index = NONE;
	state.seat_index = NONE;
	SET_FLAG(state.flags, _distributed_unit_placed_bit, TRUE);
	state.position.z = -500.0f;
	state.velocity.k = -9.5f;
	size = distributed_compact_unit_state_write(buffer, sizeof(buffer), &state, &bounds);
	read = distributed_compact_unit_state_read(buffer, size, &back, &bounds);
	check(read == size && back.position.z == -500.0f && back.position.x == state.position.x,
		"outside the bounds: the position as a float, exactly");
	check(back.velocity.k == -9.5f && back.velocity.i == state.velocity.i, "past the range: the velocity as floats");

	/* dead, waiting to respawn */
	memset(&state, 0, sizeof(state));
	state.player_index = 3;
	SET_FLAG(state.flags, _distributed_unit_friendly_fire_bit, TRUE);
	state.unit_index = NONE;
	state.vehicle_index = NONE;
	state.seat_index = NONE;
	state.respawn_timer = 87;
	state.killing_player_index = 5;
	size = distributed_compact_unit_state_write(buffer, sizeof(buffer), &state, &bounds);
	check(size == 7, "a dead player in 7 bytes");
	read = distributed_compact_unit_state_read(buffer, size, &back, &bounds);
	check(read == 7 && back.unit_index == NONE && back.respawn_timer == 87 && back.killing_player_index == 5 &&
		back.flags == state.flags && back.player_index == 3, "dead: the timer, the killer and how");

	/* refused: too little room, and truncated input */
	check(distributed_compact_unit_state_write(buffer, 10, &state, &bounds) == 7, "it fits in 10");
	state.unit_index = 99;
	SET_FLAG(state.flags, _distributed_unit_placed_bit, TRUE);
	state.forward.i = 1.0f;
	state.up.k = 1.0f;
	check(distributed_compact_unit_state_write(buffer, 10, &state, &bounds) == 0, "a living one does not: 0");
	size = distributed_compact_unit_state_write(buffer, sizeof(buffer), &state, &bounds);
	for (trial = 0; trial < size; trial++)
	{
		if (distributed_compact_unit_state_read(buffer, trial, &back, &bounds) != 0)
		{
			check(0, "a truncated state is refused");
			break;
		}
	}

	/* half floats */
	{
		static const real values[] = { 0.0f, 1.0f, -1.0f, 0.5f, 0.734f, 2.9f, 1e-3f, 3e-5f, 65000.0f, -291.0f };
		int index;

		for (index = 0; index < (int)(sizeof(values) / sizeof(values[0])); index++)
		{
			real back_value = distributed_real_from_half(distributed_half_from_real(values[index]));
			real error = (real)fabs(back_value - values[index]);

			if (error > fabs(values[index]) * 0.001f + 1e-7f)
				check(0, "a half float within a thousandth");
		}
		check(isinf(distributed_real_from_half(distributed_half_from_real(1e6f))), "too large: infinity");
	}

	/* the game type's state: a slayer record of 128 players, most of it zero */
	{
		byte state_bytes[1036], packed[1200], unpacked[1036];
		long packed_size, unpacked_size;
		int index;

		memset(state_bytes, 0, sizeof(state_bytes));
		state_bytes[0] = 1;
		for (index = 0; index < 4; index++)
		{
			state_bytes[8 + index * 2] = (byte)(index + 3);
			state_bytes[520 + index * 4] = 0xff;
			state_bytes[521 + index * 4] = 0x7f;
		}
		state_bytes[1035] = 9;
		packed_size = distributed_pack_zero_runs(packed, sizeof(packed), state_bytes, sizeof(state_bytes));
		check(packed_size > 0 && packed_size < 80, "a 1,036-byte record of zeros and scores in under 80 bytes");
		unpacked_size = distributed_unpack_zero_runs(unpacked, sizeof(unpacked), packed, packed_size);
		check(unpacked_size == (long)sizeof(state_bytes) && memcmp(unpacked, state_bytes, sizeof(state_bytes)) == 0,
			"and back exactly");
		for (index = 0; index < (int)sizeof(state_bytes); index++)
			state_bytes[index] = (byte)(index * 37 + (index >> 3));
		packed_size = distributed_pack_zero_runs(packed, sizeof(packed), state_bytes, sizeof(state_bytes));
		unpacked_size = distributed_unpack_zero_runs(unpacked, sizeof(unpacked), packed, packed_size);
		check(packed_size > 0 && unpacked_size == (long)sizeof(state_bytes) &&
			memcmp(unpacked, state_bytes, sizeof(state_bytes)) == 0, "no zeros at all: back exactly");
		check(distributed_unpack_zero_runs(unpacked, sizeof(unpacked), packed, packed_size - 1) == NONE,
			"a truncated one is refused");
		check(distributed_unpack_zero_runs(unpacked, 100, packed, packed_size) == NONE, "as is one too large");
	}

	/* an inventory: two weapons, the battery of one */
	{
		struct distributed_inventory inventory, inventory_back;
		byte compact[64];

		memset(&inventory, 0, sizeof(inventory));
		inventory.unit_index = 0x00100020;
		inventory.grenade_counts[0] = 2;
		inventory.grenade_counts[1] = 1;
		inventory.current_weapon_index = 1;
		inventory.weapon_indices[0] = 0x00300040;
		inventory.weapon_indices[1] = 0x00500060;
		inventory.weapon_indices[2] = NONE;
		inventory.weapon_indices[3] = NONE;
		inventory.rounds_total[0][0] = 112;
		inventory.rounds_loaded[0][0] = 32;
		inventory.age[1] = 0.37f;
		size = distributed_compact_inventory_write(compact, sizeof(compact), &inventory);
		check(size == 8 + 2 * 14, "two weapons in 36 bytes (72 plain)");
		read = distributed_compact_inventory_read(compact, size, &inventory_back);
		check(read == size && inventory_back.unit_index == 0x00100020 && inventory_back.grenade_counts[0] == 2 &&
			inventory_back.grenade_counts[1] == 1 && inventory_back.current_weapon_index == 1, "the unit, grenades, weapon in hand");
		check(inventory_back.weapon_indices[0] == 0x00300040 && inventory_back.weapon_indices[1] == 0x00500060 &&
			inventory_back.weapon_indices[2] == NONE && inventory_back.weapon_indices[3] == NONE, "the slots");
		check(inventory_back.rounds_total[0][0] == 112 && inventory_back.rounds_loaded[0][0] == 32 &&
			fabs(inventory_back.age[1] - 0.37f) < 0.001f, "the rounds exactly, the age within a thousandth");
		check(distributed_compact_inventory_read(compact, size - 1, &inventory_back) == 0, "a truncated one is refused");
	}

	if (!failures)
		printf("compact messages tests passed\n");
	return failures ? 1 : 0;
}
