/* Joining a match in progress never changes which machines a server's
   broadcasts reach unless late joins are on (the distributed netcode and
   network.join_in_progress): the broadcast loops in
   network_server_message_handler.c send to a machine that is joined and not
   network_game_server_client_machine_is_loading_in_game. The predicate and
   what it depends on come from the real source
   (network_late_join_gate_test.js extracts them). */
#include <stdio.h>

typedef int boolean;
typedef unsigned short word;
#define TRUE 1
#define FALSE 0
#define TEST_FLAG(flags, bit) (((flags) >> (bit)) & 1)
#define SET_FLAG(flags, bit, value) ((value) ? ((flags) |= (1 << (bit))) : ((flags) &= ~(1 << (bit))))

#include "late_join_enums.inc"

struct network_game_server
{
	word state;
};

struct network_game_server_client_machine
{
	word flags;
};

static boolean distributed;
static boolean join_in_progress;

static boolean network_game_distributed(void)
{
	return distributed;
}

static int config_boolean(const char *name)
{
	(void)name;
	return join_in_progress;
}

#include "late_join_gate.inc"

static int failures;

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

	if (!failures)
		printf("late join gate tests passed\n");
	return failures ? 1 : 0;
}
