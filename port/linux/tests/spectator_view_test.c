/* A spectator's view scope (port/linux/game/spectator.c): its target stands
   in as local player 0 only while it is drawn from its eyes, and everything
   is as it was afterwards; the netcode never takes the target for this
   machine's own player, in the scope or out of it
   (network_distributed.c distributed_player_is_local). The functions come
   from the real source (spectator_view_test.js extracts them). */
#include <stdio.h>
#include <string.h>

typedef int boolean;
typedef float real;
typedef struct { real x, y, z; } real_point3d;
typedef struct { real i, j, k; } real_vector3d;
#define TRUE 1
#define FALSE 0
#define NONE (-1)
#define MAXIMUM_LOCAL_PLAYERS 4

struct location { long cluster; };
struct observer_result
{
	real_point3d position;
	struct location location;
	real_vector3d velocity;
	real_vector3d forward;
	real_vector3d up;
	real field_of_view;
};

struct player_datum
{
	short local_player_index;
	long unit_index;
};

static struct
{
	long local_players[MAXIMUM_LOCAL_PLAYERS];
	short local_player_count;
} players_globals_storage;
static struct player_datum players[4];
#define players_globals (&players_globals_storage)
#define player_data players
static void *datum_try_and_get(struct player_datum *data, long index)
{
	return index >= 0 && index < 4 && data[index].unit_index != -2 ? &data[index] : NULL;
}
static struct player_datum *player_get(long index) { return &players[index]; }
static struct player_datum *player_try_and_get(long index) { return datum_try_and_get(players, index); }

#include "spectator_view.inc"

static int failures;

static void check(int condition, const char *what)
{
	if (!condition)
	{
		printf("FAIL: %s\n", what);
		failures++;
	}
}

/* a machine with no player of its own (local player 0 is nobody), watching
player 2 with unit 202 from its eyes */
static void watching(void)
{
	int index;

	memset(&players_globals_storage, 0, sizeof(players_globals_storage));
	for (index = 0; index < MAXIMUM_LOCAL_PLAYERS; index++)
		players_globals->local_players[index] = NONE;
	for (index = 0; index < 4; index++)
	{
		players[index].local_player_index = NONE;
		players[index].unit_index = 200 + index;
	}
	memset(&spectator, 0, sizeof(spectator));
	spectator.watching = TRUE;
	spectator.target_player = 2;
	spectator.target_unit = 202;
	spectator.view = _spectator_view_first_person;
}

int main(void)
{
	boolean begun;

	watching();
	check(!distributed_player_is_local(2), "the target is not this machine's own player");
	begun = spectator_view_begin();
	check(begun, "the scope opens on a target seen from its eyes");
	check(players_globals->local_players[0] == 2 && players[2].local_player_index == 0 &&
		players_globals->local_player_count == 1, "in it the target is local player 0");
	check(spectator_view_scoped() && spectator_first_person_view(), "the view is its eyes");
	check(!distributed_player_is_local(2), "the netcode never takes the target for its own, even in the scope");
	check(!spectator_view_begin(), "the scope does not nest");
	spectator_view_end(begun);
	check(players_globals->local_players[0] == NONE && players[2].local_player_index == NONE &&
		players_globals->local_player_count == 0 && !spectator_view_scoped(), "afterwards everything is as it was");
	spectator_view_end(FALSE);
	check(players_globals->local_players[0] == NONE, "ending a scope that never began changes nothing");

	watching();
	spectator.view = _spectator_view_vehicle;
	check(!spectator_view_begin(), "no scope for a target in a vehicle (seen from outside)");
	watching();
	spectator.target_unit = NONE;
	check(!spectator_view_begin(), "no scope for a dead target");
	watching();
	players[2].unit_index = 999;
	check(!spectator_view_begin(), "no scope once the target's unit is not the one followed");
	watching();
	spectator.watching = FALSE;
	check(!spectator_view_begin(), "no scope without watching");

	watching();
	check(spectator_first_person_slot(202) == 0, "the target's weapon events go to the first-person weapon");
	check(spectator_first_person_slot(201) == NONE && spectator_first_person_slot(NONE) == NONE, "nobody else's");
	spectator.view = _spectator_view_vehicle;
	check(spectator_first_person_slot(202) == NONE, "not while it rides");

	/* a player's own machine, never spectating */
	watching();
	spectator.watching = FALSE;
	players_globals->local_players[0] = 1;
	players[1].local_player_index = 0;
	check(distributed_player_is_local(1), "a machine's own player stays its own");
	check(!spectator_view_begin(), "and has no scope");

	if (!failures)
		printf("spectator view tests passed\n");
	return failures ? 1 : 0;
}
