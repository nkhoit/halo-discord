/* A mid-match team switch (network_client_manager.c, extracted by
   team_switch_test.js):
   - the balance rule: onto a team with strictly fewer players only;
   - the host kills the switcher's living unit once, and its player keeps the
     old team until the death (network_distributed_defer_team);
   - a client, and the host's own client copies, never kill;
   - only a real change marks the death to come as the switch's: a late
     loader's reconciliation and the host's loopback copy of its own switch
     change nothing, so they neither mark nor kill. */
#include <stdio.h>
#include <stdlib.h>

typedef int boolean;
#define TRUE 1
#define FALSE 0
#define NONE (-1)
#define TEST_FLAG(flags, bit) (((flags) >> (bit)) & 1)
#define MAXIMUM_NUMBER_OF_PLAYERS 16
enum { _team_red, _team_blue };
enum { _object_dead_bit = 3 };

struct network_player
{
	boolean valid;
	char player_list_index;
	char team_index;
};

struct network_game
{
	struct network_player players[MAXIMUM_NUMBER_OF_PLAYERS];
};

struct player_datum
{
	long unit_index;
	signed char team_index;
	struct { char team_index; } network_player_data;
};

struct object_header { struct { unsigned long damage_flags; } object; };

static int player_data_storage;
static void *player_data = &player_data_storage;
static struct player_datum players[MAXIMUM_NUMBER_OF_PLAYERS];
static struct object_header units[MAXIMUM_NUMBER_OF_PLAYERS];
static boolean host;
static int kills, notes, defers;
static char deferred = NONE;

static boolean network_player_is_valid(struct network_player *player) { return player->valid; }
static long unstrip_player_index(char player_list_index) { return player_list_index; }
static struct player_datum *player_get(long player_index) { return &players[player_index]; }
static void *object_try_and_get(long unit_index) { return unit_index == NONE ? NULL : &units[unit_index]; }
static struct object_header *object_get(long unit_index) { return &units[unit_index]; }
static void unit_kill_no_statistics(long unit_index) { (void)unit_index; kills++; }
/* port/linux/game/network_distributed.c: the host defers, a client takes it at once */
boolean network_distributed_defer_team(long player_index, char team_index)
{
	(void)player_index;
	defers++;
	if (!host)
		return FALSE;
	deferred = team_index;
	return TRUE;
}
void network_distributed_note_team_switch(long player_index) { (void)player_index; notes++; }

#include "team_switch.inc"

static int failures;
#define CHECK(condition) do { if (!(condition)) { printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #condition); failures++; } } while (0)

static void roster(struct network_game *game, int red, int blue)
{
	int index;

	for (index = 0; index < MAXIMUM_NUMBER_OF_PLAYERS; index++)
	{
		game->players[index].valid = index < red + blue;
		game->players[index].player_list_index = (char)index;
		game->players[index].team_index = index < red ? _team_red : _team_blue;
	}
}

/* player 0 on red, alive in unit 0 */
static void reset(boolean is_host)
{
	host = is_host;
	kills = notes = defers = 0;
	deferred = NONE;
	players[0].unit_index = 0;
	players[0].team_index = _team_red;
	players[0].network_player_data.team_index = _team_red;
	units[0].object.damage_flags = 0;
}

int main(void)
{
	struct network_game game;
	struct network_game copy;

	/* the balance rule */
	roster(&game, 3, 1);
	CHECK(network_game_team_switch_balance_ok(&game, _team_red, _team_blue));
	CHECK(!network_game_team_switch_balance_ok(&game, _team_blue, _team_red));
	roster(&game, 2, 2);
	CHECK(!network_game_team_switch_balance_ok(&game, _team_red, _team_blue));
	CHECK(!network_game_team_switch_balance_ok(&game, _team_blue, _team_red));
	roster(&game, 1, 3);
	CHECK(network_game_team_switch_balance_ok(&game, _team_blue, _team_red));
	CHECK(!network_game_team_switch_balance_ok(&game, _team_red, _team_red));
	CHECK(!network_game_team_switch_balance_ok(&game, _team_red, 2));
	CHECK(!network_game_team_switch_balance_ok(NULL, _team_red, _team_blue));

	/* the host: its server game kills once and defers the team, its client
	copy only marks, and its loopback copy (its roster has the team already)
	does neither */
	reset(TRUE);
	roster(&game, 3, 1);
	roster(&copy, 3, 1);
	CHECK(network_game_apply_team_switch(&game, 0, _team_blue, TRUE));
	CHECK(kills == 1 && notes == 1);
	CHECK(game.players[0].team_index == _team_blue);
	CHECK(players[0].network_player_data.team_index == _team_blue);
	CHECK(players[0].team_index == _team_red && deferred == _team_blue);
	CHECK(network_game_apply_team_switch(&copy, 0, _team_blue, FALSE));
	CHECK(kills == 1 && notes == 2 && players[0].team_index == _team_red);
	CHECK(network_game_apply_team_switch(&copy, 0, _team_blue, FALSE));
	CHECK(kills == 1 && notes == 2 && players[0].team_index == _team_red);
	/* a request for the team the player has: no kill */
	CHECK(network_game_apply_team_switch(&game, 0, _team_blue, TRUE));
	CHECK(kills == 1 && notes == 2);

	/* a client: the team at once, the death marked, never a kill */
	reset(FALSE);
	roster(&copy, 3, 1);
	CHECK(network_game_apply_team_switch(&copy, 0, _team_blue, FALSE));
	CHECK(kills == 0 && notes == 1);
	CHECK(players[0].team_index == _team_blue && copy.players[0].team_index == _team_blue);
	/* a late loader's reconciliation of the same team: nothing marked */
	CHECK(network_game_apply_team_switch(&copy, 0, _team_blue, FALSE));
	CHECK(kills == 0 && notes == 1 && players[0].team_index == _team_blue);
	/* the reconciliation still mends a stale player, unmarked */
	players[0].team_index = _team_red;
	CHECK(network_game_apply_team_switch(&copy, 0, _team_blue, FALSE));
	CHECK(notes == 1 && players[0].team_index == _team_blue);
	/* a dead unit's switch: no death to mark */
	reset(FALSE);
	roster(&copy, 3, 1);
	units[0].object.damage_flags = 1u << _object_dead_bit;
	CHECK(network_game_apply_team_switch(&copy, 0, _team_blue, FALSE));
	CHECK(kills == 0 && notes == 0 && players[0].team_index == _team_blue);
	reset(FALSE);
	roster(&copy, 3, 1);
	players[0].unit_index = NONE;
	CHECK(network_game_apply_team_switch(&copy, 0, _team_blue, FALSE));
	CHECK(notes == 0 && players[0].team_index == _team_blue);

	/* not a player, not a team */
	reset(FALSE);
	roster(&copy, 3, 1);
	CHECK(!network_game_apply_team_switch(&copy, 9, _team_blue, FALSE));
	CHECK(!network_game_apply_team_switch(&copy, 0, 2, FALSE));
	CHECK(!network_game_apply_team_switch(NULL, 0, _team_blue, FALSE));
	CHECK(notes == 0 && copy.players[0].team_index == _team_red);

	if (failures)
		return 1;
	printf("team switch: balance rule, one kill on the host, a mark only on a change\n");
	return 0;
}
