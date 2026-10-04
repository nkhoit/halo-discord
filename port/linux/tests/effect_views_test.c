/* Effects on a machine with no player of its own: a spectator (source/effects/effects.c).
   Split screen divides an effect's particles among the local players and puts a
   player's first-person weapon effects on third-person markers; a spectator, with
   none, divided by zero (thousands of particles where the player saw tens) and took
   the third-person markers. It counts as one view now, as a player does; split
   screen is unchanged. The functions come from the real source (effect_views_test.js
   extracts them). */
#include <stdio.h>

typedef int boolean;
#define TRUE 1
#define FALSE 0
#define NONE (-1)
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define FLAG(bit) (1L << (bit))
#define TEST_FLAG(flags, bit) (((flags) & FLAG(bit)) != 0)
#define match_assert(file, line, condition) ((void)0)
#define HALO_LINUX 1

enum
{
	_effect_camera_mode_independent_of_camera_mode = 0,
	_effect_camera_mode_first_person_only,
	_effect_camera_mode_third_person_only,
	_effect_camera_mode_both,
};
enum { _effect_location_first_person_bit = 15 };

struct effect_datum { short local_player_index; };
struct effect_location_datum
{
	short node_designator;
	long next_instance_location_index;
};

static short local_players;
static short local_player_count(void) { return local_players; }

/* an effect on a weapon: its third-person marker (0, 2) and the first-person
weapon's (1, 3), in one chain */
static struct effect_location_datum locations[4] = {
	{ 1, 1 },
	{ 1 | (short)FLAG(_effect_location_first_person_bit), 2 },
	{ 2, 3 },
	{ 2 | (short)FLAG(_effect_location_first_person_bit), NONE },
};
static struct effect_location_datum *effect_location_get(long index) { return &locations[index]; }

#include "effect_views.inc"

static int failures;

static void check(int condition, const char *what)
{
	if (!condition)
	{
		printf("FAIL: %s\n", what);
		failures++;
	}
}

/* the instances a particle block in this camera mode is made at, as a mask */
static int instances(short local_player_index, short camera_mode)
{
	struct effect_datum effect = { local_player_index };
	long index = 0;
	int mask = 0;
	struct effect_location_datum *location;

	while ((location = effect_location_get_next_instance(&effect, &index, camera_mode)) != NULL)
		mask |= 1 << (int)(location - locations);
	return mask;
}

#define FIRST_PERSON ((1 << 1) | (1 << 3))
#define THIRD_PERSON ((1 << 0) | (1 << 2))

int main(void)
{
	local_players = 1;
	check(effect_view_count() == 1, "a player: one view");
	check(instances(0, _effect_camera_mode_both) == FIRST_PERSON, "a player's weapon effects: on the first-person weapon");
	check(instances(NONE, _effect_camera_mode_both) == THIRD_PERSON, "anybody else's: on the third-person weapon");

	local_players = 0;
	check(effect_view_count() == 1, "a spectator: one view (its target's), not none");
	check(instances(0, _effect_camera_mode_both) == FIRST_PERSON,
		"its target's weapon effects, seen from their eyes: on the first-person weapon");
	check(instances(NONE, _effect_camera_mode_both) == THIRD_PERSON, "others': on their third-person weapons");
	check(instances(0, _effect_camera_mode_third_person_only) == THIRD_PERSON &&
		instances(0, _effect_camera_mode_first_person_only) == FIRST_PERSON, "the fixed modes as before");

	local_players = 2;
	check(effect_view_count() == 2, "split screen: two views, as before");
	check(instances(0, _effect_camera_mode_both) == THIRD_PERSON, "and its weapon effects on the third-person weapon");

	{
		/* (effect_update) a particle block's count over the split-screen limit */
		const int limit = 2, count = 40;

		local_players = 0;
		check((count - limit) / effect_view_count() + limit == count, "a spectator makes a player's count");
		local_players = 2;
		check((count - limit) / effect_view_count() + limit == 21, "split screen divides it");
	}

	if (!failures)
		printf("effect views tests passed\n");
	return failures ? 1 : 0;
}
