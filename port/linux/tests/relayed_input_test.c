/* A client's replay of the host's relayed updates (source/game/player_queues_new.c,
   the distributed netcode): one a tick, in order, once it has a spare. The
   host's taps reach the other players as the host made them: the same
   presses, and the same length while updates come no more than a tick late;
   after a longer stall it catches up without losing a press. The functions
   come from the real source (relayed_input_test.js extracts them). */
#include <stdio.h>
#include <string.h>

typedef int boolean;
typedef float real;
typedef unsigned short word;
#define TRUE 1
#define FALSE 0
#define NONE (-1)
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define csmemset memset
#define MAXIMUM_NUMBER_OF_PLAYERS 16

struct player_action
{
	unsigned long control_flags;
	real primary_trigger;
	short desired_weapon_index;
};

struct server_update
{
	word action_count;
	short pad;
	struct player_action actions[MAXIMUM_NUMBER_OF_PLAYERS];
};

#include "relayed_input.inc"

static int failures;

static void check(int condition, const char *what)
{
	if (!condition)
	{
		printf("FAIL: %s\n", what);
		failures++;
	}
}

#define TICKS 160
#define JUMP 0x1

/* the host's player 0, tick by tick: taps of 3 ticks (one of 2), a held
burst of 8, and a one-tick button (jump) now and then */
static boolean host_trigger[TICKS];
static unsigned long host_flags[TICKS];

static void host_script(void)
{
	int tick;

	memset(host_trigger, 0, sizeof(host_trigger));
	memset(host_flags, 0, sizeof(host_flags));
	for (tick = 10; tick + 3 < 120; tick += 12)
		host_trigger[tick] = host_trigger[tick + 1] = host_trigger[tick + 2] = TRUE;
	host_trigger[59] = FALSE;
	for (tick = 124; tick < 132; tick++)
		host_trigger[tick] = TRUE;
	host_flags[33] = host_flags[77] = host_flags[140] = JUMP;
}

/* what the client's ticks ran for player 0 */
static boolean replay_trigger[TICKS + 40];
static unsigned long replay_flags[TICKS + 40];

/* arrival[t]: the client tick at which the host's update for tick t
arrives (in order); runs the client for TICKS + 40 ticks */
static void replay(const int *arrival, int duplicates)
{
	int tick, next = 0;

	update_client_relayed_reset();
	for (tick = 0; tick < TICKS + 40; tick++)
	{
		while (next < TICKS && arrival[next] <= tick)
		{
			struct server_update update;

			memset(&update, 0, sizeof(update));
			update.action_count = 2;
			update.actions[0].primary_trigger = host_trigger[next] ? 1.0f : 0.0f;
			update.actions[0].control_flags = host_flags[next];
			update_client_relayed_push(&update, next);
			if (duplicates && next > 0)
			{
				/* a stale copy of the one before: dropped */
				update.actions[0].primary_trigger = 1.0f;
				update_client_relayed_push(&update, next - 1);
			}
			next++;
		}
		update_client_relayed_tick();
		/* (update_client_dequeue_distributed's use) */
		replay_trigger[tick] = update_client_relayed_actions[0].valid &&
			update_client_relayed_actions[0].action.primary_trigger > 0.0f;
		replay_flags[tick] = update_client_relayed_actions[0].valid ?
			update_client_relayed_actions[0].action.control_flags | update_client_relayed_actions[0].pending_control_flags : 0;
		update_client_relayed_actions[0].pending_control_flags = 0;
	}
}

static int presses(const boolean *trigger, int count)
{
	int tick, result = 0;

	for (tick = 0; tick < count; tick++)
		if (trigger[tick] && (tick == 0 || !trigger[tick - 1]))
			result++;
	return result;
}

static int flag_ticks(const unsigned long *flags, int count)
{
	int tick, result = 0;

	for (tick = 0; tick < count; tick++)
		if (flags[tick] & JUMP)
			result++;
	return result;
}

/* the replay is the host's, shifted by delay ticks */
static int same_as_host(int delay)
{
	int tick;

	for (tick = 0; tick < TICKS; tick++)
		if (replay_trigger[tick + delay] != host_trigger[tick] || (replay_flags[tick + delay] & JUMP) != host_flags[tick])
			return FALSE;
	return TRUE;
}

int main(void)
{
	int arrival[TICKS];
	int tick;
	int host_presses;

	host_script();
	host_presses = presses(host_trigger, TICKS);

	for (tick = 0; tick < TICKS; tick++)
		arrival[tick] = tick;
	replay(arrival, FALSE);
	check(same_as_host(1), "steady updates: the host's taps exactly, a tick behind");

	/* two at once every other tick (the relay's bunching) */
	for (tick = 0; tick < TICKS; tick++)
		arrival[tick] = tick | 1;
	replay(arrival, FALSE);
	check(same_as_host(1), "bunched pairs: still exact (the spare covers the gap)");

	/* each update late by a tick, now and then */
	for (tick = 0; tick < TICKS; tick++)
		arrival[tick] = tick + (tick % 7 == 3 ? 1 : 0);
	for (tick = 1; tick < TICKS; tick++)
		if (arrival[tick] < arrival[tick - 1])
			arrival[tick] = arrival[tick - 1];
	replay(arrival, FALSE);
	check(same_as_host(1), "single late updates: exact");

	/* a stall of five ticks in the middle of a tap, then all at once */
	for (tick = 0; tick < TICKS; tick++)
		arrival[tick] = tick >= 45 && tick < 51 ? 51 : tick;
	replay(arrival, FALSE);
	check(presses(replay_trigger, TICKS + 40) == host_presses, "a stall loses no tap");
	check(flag_ticks(replay_flags, TICKS + 40) == 3, "nor a one-tick button");
	for (tick = 0; tick < 40; tick++)
		check(replay_trigger[tick + 1] == host_trigger[tick], "before the stall: exact");
	{
		int longest = 0, run = 0;

		for (tick = 0; tick < TICKS + 40; tick++)
		{
			run = replay_trigger[tick] ? run + 1 : 0;
			longest = MAX(longest, run);
		}
		check(longest <= 8, "no tap held longer than the host's longest (8 ticks)");
	}

	/* a stall of a second (taps a tick or more apart stay apart while it
	catches up) */
	for (tick = 0; tick < TICKS; tick++)
		arrival[tick] = tick >= 60 && tick < 90 ? 90 : tick;
	replay(arrival, FALSE);
	check(presses(replay_trigger, TICKS + 40) == host_presses, "a long stall loses no tap");
	check(flag_ticks(replay_flags, TICKS + 40) == 3, "nor a button");
	for (tick = 140; tick < TICKS; tick++)
		check(replay_trigger[tick + 1] == host_trigger[tick], "caught up afterwards: exact again");

	/* a stall longer than the queue (32): the oldest merge as they come */
	for (tick = 0; tick < TICKS; tick++)
		arrival[tick] = tick >= 40 && tick < 100 ? 100 : tick;
	replay(arrival, FALSE);
	check(flag_ticks(replay_flags, TICKS + 40) >= 3, "the buttons survive even that");
	check(presses(replay_trigger, TICKS + 40) >= host_presses - 3, "and most taps");

	/* stale copies of earlier updates are dropped */
	for (tick = 0; tick < TICKS; tick++)
		arrival[tick] = tick;
	replay(arrival, TRUE);
	check(same_as_host(1), "repeated or old updates change nothing");

	/* replay waits for its cushion again after running dry */
	update_client_relayed_reset();
	{
		struct server_update update;

		memset(&update, 0, sizeof(update));
		update.action_count = 1;
		update.actions[0].primary_trigger = 1.0f;
		update_client_relayed_push(&update, 0);
		update_client_relayed_tick();
		check(!update_client_relayed_actions[0].valid, "one update in hand: not yet");
		update_client_relayed_push(&update, 1);
		update_client_relayed_tick();
		check(update_client_relayed_actions[0].valid, "two: replay starts");
	}

	if (!failures)
		printf("relayed input tests passed\n");
	return failures ? 1 : 0;
}
