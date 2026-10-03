/* Joining a match in progress changes nothing unless late joins are on (the
   distributed netcode and network.join_in_progress):
   - the broadcast loops in network_server_message_handler.c send to a
     machine that is joined and not
     network_game_server_client_machine_is_loading_in_game;
   - the lobby counts down to its match (server_ok_to_countdown) with two
     machines, two players and both teams taken, as the Xbox game did; with
     late joins on, a host may start alone;
   - spectators (machines without a player of their own, which a join
     request's machine name marks) count only with late joins: they join a
     full match, up to MAXIMUM_SPECTATOR_MACHINES, and the lobby counts down
     without a player of theirs; without late joins, a machine without a
     player keeps the lobby waiting, as before;
   - the lobby's directions line (multiplayer_game_directions) says
     "Waiting for another Xbox console" to a host alone; with late joins on
     it says "Accepting Players", and nothing over its countdown.
   The rules and what they depend on come from the real source
   (network_late_join_gate_test.js extracts them). */
#include <stdio.h>
#include <string.h>

typedef int boolean;
typedef unsigned short word;
#define TRUE 1
#define FALSE 0
#define TEST_FLAG(flags, bit) (((flags) >> (bit)) & 1)
#define SET_FLAG(flags, bit, value) ((value) ? ((flags) |= (1 << (bit))) : ((flags) &= ~(1 << (bit))))
#define MAXIMUM_NETWORK_MACHINE_COUNT 16
#define MAXIMUM_NETWORK_PLAYER_COUNT 8
#define NUMBER_OF_MULTIPLAYER_TEAMS 2
#define NONE (-1)
#define MAXIMUM_SPECTATOR_MACHINES 8
#include <wchar.h>

#include "late_join_enums.inc"

struct network_player
{
	char machine_index;
	char controller_index;
	char team_index;
};

struct network_game_server_client_machine
{
	short machine_index;
	word flags;
};

struct network_game_server
{
	word state;
	struct network_game_server_client_machine client_machines[MAXIMUM_NETWORK_MACHINE_COUNT];
	long late_join_time[MAXIMUM_NETWORK_MACHINE_COUNT];
	struct
	{
		struct { struct { boolean teams; } universal_variant; } variant;
		char minimum_players;
		short maximum_players;
		short player_count;
		struct network_player players[MAXIMUM_NETWORK_PLAYER_COUNT];
	} game;
};

static boolean distributed;
static boolean join_in_progress;
static boolean splitscreen_local;

static boolean network_game_distributed(void)
{
	return distributed;
}

static int config_boolean(const char *name)
{
	(void)name;
	return join_in_progress;
}

static boolean network_game_is_splitscreen_local(void)
{
	return splitscreen_local;
}

static boolean network_player_is_valid(struct network_player *player)
{
	return player->machine_index >= 0 && player->controller_index >= 0;
}

static int can_score = 1;
static boolean game_engine_can_score(void) { return can_score; }

#include "late_join_gate.inc"
#include "late_join_spectator_mark.inc"

/* game_engine.c's end of a match with one team left */
static int game_engine_present = 1;
static int teams_alive;
static int hosting = 1;
#define game_engine game_engine_present
static boolean multiple_teams_alive(void) { return teams_alive; }
static void *global_network_game_server_get(void) { return hosting ? (void *)&game_engine_present : 0; }
#include "late_join_end.inc"
#undef game_engine

/* ui_widget_game_data_input_functions.c's lobby directions */
#define NUMBEROF(array) ((long)(sizeof(array) / sizeof((array)[0])))
#define match_vassert(file, line, condition, message) ((void)0)
enum { _ui_widget_type_text_box = 1 };
enum { _team_red, _team_blue };
struct widget_instance
{
	short type;
	boolean visible;
	struct { struct { short string_list_index; } text_box; } parameters;
};
struct network_game
{
	short machine_count;
	short player_count;
	struct { boolean has_teams; } variant;
	struct network_player players[MAXIMUM_NETWORK_PLAYER_COUNT];
};
static struct network_game lobby_game;
static short seconds_to_game_start = -1;
static struct network_game *network_game_get_game(void) { return &lobby_game; }
static void *global_network_game_client_get(void) { return &lobby_game; }
static short network_game_client_get_seconds_to_game_start(void *client) { (void)client; return seconds_to_game_start; }
#include "late_join_lobby_text.inc"

/* the directions line for a lobby of machine_count machines (a player each,
alternating teams), with the countdown at seconds (-1: none): its string, or
NONE when hidden */
static int directions(int machine_count, boolean teams, int seconds)
{
	struct widget_instance widget = { _ui_widget_type_text_box, TRUE, { { NONE } } };
	int index;

	memset(&lobby_game, 0, sizeof(lobby_game));
	lobby_game.machine_count = (short)machine_count;
	lobby_game.player_count = (short)machine_count;
	lobby_game.variant.has_teams = teams;
	for (index = 0; index < MAXIMUM_NETWORK_PLAYER_COUNT; index++)
	{
		lobby_game.players[index].machine_index = index < machine_count ? index : NONE;
		lobby_game.players[index].controller_index = index < machine_count ? 0 : NONE;
		lobby_game.players[index].team_index = index < machine_count ? index % 2 : NONE;
	}
	seconds_to_game_start = (short)seconds;
	multiplayer_game_directions(&widget);
	return widget.visible ? widget.parameters.text_box.string_list_index : NONE;
}

static int failures;

/* a lobby: machines 0 to machine_count - 1 with a player each, on teams 0,
1, ... in a team game; minimum_players 2, as the server sets it */
static void lobby(struct network_game_server *server, int machine_count, boolean teams)
{
	int index;

	memset(server, 0, sizeof(*server));
	server->state = _network_game_server_state_pregame;
	server->game.variant.universal_variant.teams = teams;
	server->game.minimum_players = 2;
	for (index = 0; index < MAXIMUM_NETWORK_MACHINE_COUNT; index++)
		server->client_machines[index].machine_index = index < machine_count ? index : NONE;
	for (index = 0; index < MAXIMUM_NETWORK_PLAYER_COUNT; index++)
	{
		server->game.players[index].machine_index = index < machine_count ? index : NONE;
		server->game.players[index].controller_index = index < machine_count ? 0 : NONE;
		server->game.players[index].team_index = index < machine_count ? index % 2 : NONE;
	}
	server->game.player_count = (short)machine_count;
}

static void check(int condition, const char *what)
{
	if (!condition)
	{
		printf("FAIL: %s\n", what);
		failures++;
	}
}

/* the machines a broadcast reaches, as the loops pick them */
static int reached(struct network_game_server *server, struct network_game_server_client_machine *machines, int count)
{
	int index;
	int result = 0;

	for (index = 0; index < count; index++)
	{
		if (TEST_FLAG(machines[index].flags, _network_client_machine_validated_bit) &&
			!network_game_server_client_machine_is_loading_in_game(server, &machines[index]))
		{
			result |= 1 << index;
		}
	}
	return result;
}

int main(void)
{
	struct network_game_server server = { _network_game_server_state_ingame };
	struct network_game_server_client_machine machines[3] = { { 0 }, { 0 }, { 0 } };
	int joined;
	int lockstep;
	int setting;
	int index;

	/* two machines loaded, one joined (validated) and not loaded yet */
	SET_FLAG(machines[0].flags, _network_client_machine_validated_bit, TRUE);
	SET_FLAG(machines[0].flags, _network_client_machine_level_loaded_bit, TRUE);
	SET_FLAG(machines[1].flags, _network_client_machine_validated_bit, TRUE);
	SET_FLAG(machines[1].flags, _network_client_machine_level_loaded_bit, TRUE);
	SET_FLAG(machines[2].flags, _network_client_machine_validated_bit, TRUE);
	joined = 7;

	for (lockstep = 0; lockstep <= 1; lockstep++)
	{
		for (setting = 0; setting <= 1; setting++)
		{
			distributed = !lockstep;
			join_in_progress = setting;
			if (lockstep || !setting)
			{
				check(!network_game_server_client_machine_is_loading_in_game(&server, &machines[2]),
					lockstep ? "lockstep: no machine is loading in game" : "setting off: no machine is loading in game");
				check(reached(&server, machines, 3) == joined,
					"without late joins every joined machine is reached, loaded or not");
			}
		}
	}

	distributed = TRUE;
	join_in_progress = TRUE;
	check(network_game_server_client_machine_is_loading_in_game(&server, &machines[2]),
		"late joins on: the machine loading the running match");
	check(reached(&server, machines, 3) == 3, "late joins on: the loading machine waits");
	check(!network_game_server_client_machine_is_loading_in_game(&server, &machines[0]), "a loaded machine is not loading");
	server.state = _network_game_server_state_pregame;
	check(!network_game_server_client_machine_is_loading_in_game(&server, &machines[2]),
		"in the lobby nobody is loading in game");
	check(reached(&server, machines, 3) == joined, "in the lobby every joined machine is reached");
	server.state = _network_game_server_state_postgame;
	check(reached(&server, machines, 3) == joined, "after the match every joined machine is reached");

	/* ---------- the lobby's countdown: alone only with late joins */
	{
		static const char *const netcodes[] = { "distributed", "lockstep" };
		int netcode;

		for (netcode = 0; netcode <= 1; netcode++)
		{
			for (setting = 0; setting <= 1; setting++)
			{
				boolean alone = netcode == 0 && setting;
				char what[128];

				distributed = netcode == 0;
				join_in_progress = setting;
				splitscreen_local = FALSE;
				lobby(&server, 1, 0);
				snprintf(what, sizeof(what), "%s, setting %s: the host alone %s", netcodes[netcode],
					setting ? "on" : "off", alone ? "may start" : "may not start");
				check(server_ok_to_countdown(&server) == alone, what);
				check(server_has_enough_machines(&server) == alone, "one machine is enough only with late joins");
				lobby(&server, 1, 1);
				snprintf(what, sizeof(what), "%s, setting %s: alone on a team %s", netcodes[netcode],
					setting ? "on" : "off", alone ? "may start" : "may not start");
				check(server_ok_to_countdown(&server) == alone, what);
				lobby(&server, 2, 0);
				check(server_ok_to_countdown(&server), "two machines, a player each, may start");
				lobby(&server, 2, 1);
				server.game.players[1].team_index = 0;
				snprintf(what, sizeof(what), "%s, setting %s: two on one team %s", netcodes[netcode],
					setting ? "on" : "off", alone ? "may start" : "need the other team");
				check(server_ok_to_countdown(&server) == alone, what);
				check(server_needs_more_teams(&server) == !alone, "an empty team matters only without late joins");
				server.game.players[1].team_index = 1;
				check(server_ok_to_countdown(&server), "two teams may start");
				lobby(&server, 2, 0);
				server.game.players[1].machine_index = NONE;
				server.game.player_count = 1;
				check(!server_ok_to_countdown(&server), "a machine without a player never may");
				splitscreen_local = TRUE;
				lobby(&server, 1, 0);
				server.game.players[1].machine_index = 0;
				server.game.players[1].controller_index = 1;
				server.game.player_count = 2;
				check(server_ok_to_countdown(&server), "split screen: one machine, two players, may start");
			}
		}
	}

	/* ---------- spectators: only with late joins */
	{
		wchar_t name[32];
		int netcode_index;

		memset(name, 0, sizeof(name));
		check(!network_game_machine_name_marks_spectator(name, 32), "a zeroed machine name (every other client's) is no spectator's");
		wcscpy(name, L"WEB-7F3A");
		network_game_mark_spectator_machine_name(name, 32);
		check(network_game_machine_name_marks_spectator(name, 32) && !wcscmp(name, L"WEB-7F3A"),
			"the mark leaves the name as it was");

		for (netcode_index = 0; netcode_index <= 1; netcode_index++)
		{
			for (setting = 0; setting <= 1; setting++)
			{
				boolean late_joins = netcode_index == 0 && setting;

				distributed = netcode_index == 0;
				join_in_progress = setting;
				splitscreen_local = FALSE;
				/* a host and a spectator machine without a player */
				lobby(&server, 2, 0);
				server.game.players[1].machine_index = NONE;
				server.game.player_count = 1;
				network_game_server_set_client_machine_spectator(&server.client_machines[1], TRUE);
				check(network_game_server_client_machine_is_spectator(&server.client_machines[1]) == late_joins,
					"a machine is a spectator only with late joins");
				check(server_has_a_player_on_each_machine(&server) == late_joins,
					late_joins ? "late joins: the spectator needs no player" :
						"without late joins a machine without a player keeps the lobby waiting, as before");
				check(server_ok_to_countdown(&server) == late_joins,
					late_joins ? "late joins: the host and a spectator may start" : "without late joins: as before");
				check(network_game_server_spectator_count(&server) == (late_joins ? 1 : 0), "the spectators counted");
				network_game_server_set_client_machine_spectator(&server.client_machines[1], FALSE);
				check(server_has_a_player_on_each_machine(&server) == FALSE, "a machine without a player, not a spectator, waits");

				/* the running match: full of players */
				lobby(&server, 2, 0);
				server.state = _network_game_server_state_ingame;
				server.game.maximum_players = 2;
				memset(server.late_join_time, 0, sizeof(server.late_join_time));
				check(!network_game_server_joinable_in_game(&server), "a full match takes no player");
				check(network_game_server_watchable_in_game(&server) == late_joins,
					late_joins ? "late joins: a full match takes a spectator" : "without late joins nobody joins a match");
				/* a spectator loading the match keeps no player's place */
				server.game.maximum_players = 3;
				server.client_machines[2].machine_index = 2;
				SET_FLAG(server.client_machines[2].flags, _network_client_machine_validated_bit, TRUE);
				network_game_server_set_client_machine_spectator(&server.client_machines[2], TRUE);
				server.late_join_time[2] = 1;
				check(network_game_server_joinable_in_game(&server) == late_joins, "a loading spectator keeps no player's place");
				network_game_server_set_client_machine_spectator(&server.client_machines[2], FALSE);
				check(!network_game_server_joinable_in_game(&server), "a loading player's machine does");
				/* at most MAXIMUM_SPECTATOR_MACHINES */
				for (index = 2; index < 2 + MAXIMUM_SPECTATOR_MACHINES; index++)
				{
					server.client_machines[index].machine_index = (short)index;
					network_game_server_set_client_machine_spectator(&server.client_machines[index], TRUE);
				}
				check(!network_game_server_watchable_in_game(&server), "no more spectators than the limit");
				for (index = 0; index < MAXIMUM_NETWORK_MACHINE_COUNT; index++)
					server.client_machines[index].flags = 0;
				can_score = FALSE;
				check(!network_game_server_watchable_in_game(&server), "a match that is over takes no spectator");
				can_score = TRUE;
			}
		}
	}

	/* ---------- the end of a match with one team left: only with late joins */
	for (lockstep = 0; lockstep <= 1; lockstep++)
	{
		for (setting = 0; setting <= 1; setting++)
		{
			boolean late_joins = !lockstep && setting;

			distributed = !lockstep;
			join_in_progress = setting;
			hosting = TRUE;
			teams_alive = FALSE;
			check(game_engine_should_end_game() == !late_joins,
				late_joins ? "late joins: one team left plays on" : "without late joins one team left ends the match");
			teams_alive = TRUE;
			check(!game_engine_should_end_game(), "two teams alive never end the match");
		}
	}
	distributed = TRUE;
	join_in_progress = TRUE;
	hosting = FALSE;
	teams_alive = FALSE;
	check(game_engine_should_end_game(), "(not the host: its rule as before)");

	/* ---------- the lobby's directions line */
	splitscreen_local = FALSE;
	for (lockstep = 0; lockstep <= 1; lockstep++)
	{
		for (setting = 0; setting <= 1; setting++)
		{
			boolean late_joins = !lockstep && setting;
			int teams;

			distributed = !lockstep;
			join_in_progress = setting;
			hosting = TRUE;
			for (teams = 0; teams <= 1; teams++)
			{
				if (late_joins)
				{
					check(directions(1, teams, -1) == _multiplayer_game_text_string_accepting_players,
						"late joins: a host alone is accepting players");
					check(directions(1, teams, 3) == NONE, "late joins: a host alone counting down shows only the countdown");
					check(directions(1, teams, 0) == NONE, "late joins: nothing over the start");
				}
				else
				{
					check(directions(1, teams, -1) == _multiplayer_game_text_string_waiting_for_machine,
						"without late joins a host alone waits for another Xbox");
					check(directions(1, teams, 3) == _multiplayer_game_text_string_waiting_for_machine,
						"without late joins the line is as before, countdown or not");
				}
				/* two or more machines, and guests: as before */
				check(directions(2, teams, -1) == (teams ? _multiplayer_game_text_string_teams_ready : NONE),
					"two machines: as before");
				check(directions(2, teams, 5) == NONE, "two machines counting down: as before");
			}
			lobby_game.players[1].team_index = _team_red;
			{
				struct widget_instance widget = { _ui_widget_type_text_box, TRUE, { { NONE } } };

				seconds_to_game_start = -1;
				multiplayer_game_directions(&widget);
				check(widget.parameters.text_box.string_list_index == _multiplayer_game_text_string_waiting_for_teams,
					"two on one team: as before");
			}
			hosting = FALSE;
			check(directions(2, 0, 5) == NONE && directions(2, 1, -1) == _multiplayer_game_text_string_teams_ready,
				"a guest's line: as before");
			check(directions(1, 0, -1) == NONE, "a guest never waits for machines");
		}
	}
	hosting = TRUE;

	if (!failures)
		printf("late join gate tests passed\n");
	return failures ? 1 : 0;
}
