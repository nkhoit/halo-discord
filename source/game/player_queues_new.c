/*
PLAYER_QUEUES_NEW.C

symbols in this file:
000A80A0 0040:
	_update_server_add_player (0000)
000A80E0 0090:
	_update_client_new (0000)
000A8170 0040:
	_update_client_delete (0000)
000A81B0 00c0:
	_update_client_start (0000)
000A8270 0040:
	_update_client_add_player (0000)
000A82B0 0030:
	_update_client_queue (0000)
000A82E0 0020:
	_update_client_queue_push (0000)
000A8300 0010:
	_update_client_get_maximum_actions (0000)
000A8310 0050:
	_update_client_build_client_update (0000)
000A8360 0050:
	_player_new_queue (0000)
000A83B0 0060:
	_update_server_get_update (0000)
000A8410 0030:
	_update_client_get_update (0000)
000A8440 0080:
	_update_server_new (0000)
000A84C0 0060:
	_update_server_delete (0000)
000A8520 00c0:
	_update_server_start (0000)
000A85E0 00d0:
	_update_server_build_server_update (0000)
000A86B0 02d0:
	_update_client_dequeue (0000)
000A8980 0050:
	_update_client_get_maximum_possible_server_time (0000)
000A89D0 0150:
	_update_server_handle_client_update (0000)
000A8B20 00d0:
	_update_client_handle_server_update (0000)
000A8BF0 0110:
	_update_queues_reset_and_fill_with_lies (0000)
000A8D00 00e0:
	_update_server_next_update (0000)
000A8DE0 00c0:
	_update_client_local_ticks (0000)
0025C87C 0012:
	??_C@_0BC@HKAHJFKD@queue_index?$CB?$DNNONE?$AA@ (0000)
0025C890 0028:
	??_C@_0CI@PBIGBCAB@c?3?2halo?2SOURCE?2game?2player_queue@ (0000)
0025C8B8 0015:
	??_C@_0BF@LPJMFPAI@update?5client?5queues?$AA@ (0000)
0025C8D0 0023:
	??_C@_0CD@GPGLDMIM@?$CBupdate_client_globals?4initializ@ (0000)
0025C8F4 0022:
	??_C@_0CC@HHIIJIMP@update_client_globals?4initialize@ (0000)
0025C918 0037:
	??_C@_0DH@JINOOJDL@action_collection?5?$CG?$CG?5update_clie@ (0000)
0025C950 0022:
	??_C@_0CC@PJOBEMLF@update_server_globals?4initialize@ (0000)
0025C974 0015:
	??_C@_0BF@JPNPAAMJ@update?5server?5queues?$AA@ (0000)
0025C98C 0023:
	??_C@_0CD@OBACOIPG@?$CBupdate_server_globals?4initializ@ (0000)
0025C9B0 002c:
	??_C@_0CM@MEBNPPKK@machine_index?$DMMAXIMUM_NETWORK_MA@ (0000)
0025C9DC 003d:
	??_C@_0DN@MONJPEIP@update?5?$CG?$CG?5update_number?5?$CG?$CG?5updat@ (0000)
0025CA20 0062:
	??_C@_0GC@JKNAOGKH@?$CINONE?5?$DN?$DN?5actions?$FLqueue_index?$FN?4de@ (0000)
0025CA88 00b3:
	??_C@_0LD@JLDAFPEL@?$CINONE?5?$DN?$DN?5actions?$FLqueue_index?$FN?4de@ (0000)
0025CB40 00ac:
	??_C@_0KM@CAKKNBBN@?$CINONE?5?$DN?$DN?5actions?$FLqueue_index?$FN?4de@ (0000)
0025CBF0 0046:
	??_C@_0EG@JJEOPHKN@?$CINONE?5?$DN?$DN?5queue?9?$DOdesired_zoom_lev@ (0000)
0025CC38 0089:
	??_C@_0IJ@ENHLLOPB@?$CINONE?5?$DN?$DN?5queue?9?$DOdesired_grenade_@ (0000)
0025CCC8 0082:
	??_C@_0IC@PGBPIKNJ@?$CINONE?5?$DN?$DN?5queue?9?$DOdesired_weapon_i@ (0000)
0025CD4C 0029:
	??_C@_0CJ@GIKNCIIL@queue?9?$DOcurrent_action?4desired_fa@ (0000)
0025CD78 002b:
	??_C@_0CL@PLNKAOG@queue?9?$DOcurrent_action?4desired_fa@ (0000)
0025CDA8 0043:
	??_C@_0ED@GEKLIPAE@if?5you?8re?5playing?5single?5player?1@ (0000)
0025CDEC 003e:
	??_C@_0DO@EODINBPH@if?5you?8re?5in?5a?5multiplayer?5game?0@ (0000)
0025CE2C 0031:
	??_C@_0DB@BKCMOFLJ@failed?5to?5get?5an?5update?5?$CI?$CD?$CFd?$CJ?$DL?5s@ (0000)
0025CE60 0007:
	??_C@_06HDLLMMEJ@update?$AA@ (0000)
0025CE68 002a:
	??_C@_0CK@MPOAFLDM@game_connection?$CI?$CJ?$DN?$DN_game_connect@ (0000)
0043EE60 410c:
	_update_server_globals (0000)
00442F70 10494:
	_update_client_globals (0000)
*/

/* ---------- headers */

#include "cseries/cseries.h"
#include "cseries/cseries_windows.h"
#include "cseries/errors.h"
#include "game/game.h"
#include "game/player_queues_new.h"
#include "game/players.h"
#include "interface/ui_widget.h"
#include "main/main.h"
#include "memory/data.h"
#include "networking/network_game_globals.h"
#include "units/units.h"

/* ---------- constants */

enum
{
#ifdef HALO_LINUX
	/* the native builds' session limits (port/linux/include/halo_port_limits.h) */
	MAXIMUM_NUMBER_OF_PLAYERS = HALO_PORT_MAXIMUM_NETWORK_PLAYERS,
	MAXIMUM_NETWORK_MACHINE_COUNT = HALO_PORT_MAXIMUM_NETWORK_MACHINES,
#else
	MAXIMUM_NUMBER_OF_PLAYERS = 16,
	MAXIMUM_NETWORK_MACHINE_COUNT = 4,
#endif

	MAXIMUM_SERVER_UPDATES = 32,
	MAXIMUM_CLIENT_UPDATES = 128,

	/* the one-shot buttons: they fire on the tick they are first seen and stay latched until released */
	LATCHED_CONTROL_FLAGS =
		FLAG(_unit_control_integrated_light_bit) |
		FLAG(_unit_control_action_bit) |
		FLAG(_unit_control_use_equipment_bit) |
		FLAG(_unit_control_weapon_reload_bit),
};

/* ---------- macros */

/* ---------- structures */

struct player_action_collection
{
	struct player_action actions[MAXIMUM_LOCAL_PLAYERS];
};

struct server_update
{
	word action_count;
	short pad;
	struct player_action actions[MAXIMUM_NUMBER_OF_PLAYERS];
};

struct update
{
	long update_number;
	struct server_update update;
};

struct update_server_queue_datum
{
	short identifier;
	short pad;
	long next_update_number;
	struct player_action current_action;
};

struct update_client_queue_datum
{
	short identifier;
	short pad;
	unsigned long control_flags;
	unsigned long latched_control_flags;
	real_euler_angles2d desired_facing;
	real_vector2d throttle;
	real primary_trigger;
	short desired_weapon_index;
	short desired_grenade_index;
	short desired_zoom_level;
	short pad2;
};

struct update_server_globals
{
	boolean initialized;
	long next_update_number_to_build;
	struct data_array *queues;
	struct update updates[MAXIMUM_SERVER_UPDATES];
};

struct update_client_globals
{
	boolean initialized;
	long next_update_number_to_dequeue;
	long latest_update_number_received;
	struct player_action_collection saved_action_collection;
	long current_local_player;
	struct data_array *queues;
	struct update updates[MAXIMUM_CLIENT_UPDATES];
};

typedef char player_action_collection_size_assert[
	sizeof(struct player_action_collection) == 0x80 ? 1 : -1];
#ifdef HALO_LINUX
/* the update arrays follow the session limit (the networking units' copies
of struct server_update must have the same size) */
typedef char server_update_size_assert[
	sizeof(struct server_update) == 4 + MAXIMUM_NUMBER_OF_PLAYERS * 0x20 ? 1 : -1];
typedef char update_size_assert[
	sizeof(struct update) == 4 + sizeof(struct server_update) ? 1 : -1];
#else
typedef char server_update_size_assert[
	sizeof(struct server_update) == 0x204 ? 1 : -1];
typedef char update_size_assert[
	sizeof(struct update) == 0x208 ? 1 : -1];
#endif
typedef char update_server_queue_datum_size_assert[
	sizeof(struct update_server_queue_datum) == 0x28 ? 1 : -1];
typedef char update_client_queue_datum_size_assert[
	sizeof(struct update_client_queue_datum) == 0x28 ? 1 : -1];
#ifdef HALO_LINUX
typedef char update_server_globals_size_assert[
	sizeof(struct update_server_globals) == 0xC + MAXIMUM_SERVER_UPDATES * sizeof(struct update) ? 1 : -1];
#else
typedef char update_server_globals_size_assert[
	sizeof(struct update_server_globals) == 0x410C ? 1 : -1];
#endif
typedef char update_server_globals_queues_offset_assert[
	offsetof(struct update_server_globals, queues) == 0x8 ? 1 : -1];
#ifdef HALO_LINUX
typedef char update_client_globals_size_assert[
	sizeof(struct update_client_globals) == 0x94 + MAXIMUM_CLIENT_UPDATES * sizeof(struct update) ? 1 : -1];
#else
typedef char update_client_globals_size_assert[
	sizeof(struct update_client_globals) == 0x10494 ? 1 : -1];
#endif
typedef char update_client_globals_saved_actions_offset_assert[
	offsetof(struct update_client_globals, saved_action_collection) == 0xC ? 1 : -1];
typedef char update_client_globals_current_local_player_offset_assert[
	offsetof(struct update_client_globals, current_local_player) == 0x8C ? 1 : -1];
typedef char update_client_globals_queues_offset_assert[
	offsetof(struct update_client_globals, queues) == 0x90 ? 1 : -1];

/* ---------- prototypes */

static struct update *update_server_get_update(
	long update_number);
static struct update *update_client_get_update(
	long update_number);

/* ---------- globals */

#ifdef HALO_LINUX
/* The host takes a client's input as it comes, each packet replacing the
last, and a client sends one a frame (several per tick): a button pressed
in only one packet between two of the host's ticks would be lost. Every
button seen since the host's last tick stays down for the next. */
static unsigned long update_server_pending_control_flags[MAXIMUM_NUMBER_OF_PLAYERS];

/* (the browser's network statistics) how many of a client player's input
packets the host had for each of its ticks: none, one, two, three or more */
static long update_server_inputs_since_tick[MAXIMUM_NUMBER_OF_PLAYERS];
static boolean update_server_remote_player[MAXIMUM_NUMBER_OF_PLAYERS];
static long update_server_input_histogram_counts[4];

void update_server_input_histogram(
	long histogram[4])
{
	csmemcpy(histogram, update_server_input_histogram_counts, sizeof(update_server_input_histogram_counts));
}

#ifdef HALO_WEB
/* the browser's feel scorecard (port/linux/game/network_distributed.c) */
extern void network_web_relayed_update(void);
extern void network_web_client_tick(void);
#endif

/* the distributed netcode (port/linux/NETCODE.md): the action a client's
tick runs for each of the other players (the host's relayed update it is
replaying), and the buttons of the updates merged into it */
static struct
{
	boolean valid;
	struct player_action action;
	unsigned long pending_control_flags;
} update_client_relayed_actions[MAXIMUM_NUMBER_OF_PLAYERS];

/* (the browser builds) The host relays its players' actions once a tick,
and over the internet relay they reach a client unevenly: none for a tick or
more, then several at once. Running only the newest each tick lost a press
whose release came with it and held a trigger down until the next arrived
(a remote plasma pistol charged and overheated from taps). A browser client
replays them in order, a tick each, once it has one to spare: an update late
by a tick takes the spare. Updates are handled once a frame and a slow frame
runs several ticks, so it only counts as behind when it has kept more than
its spare for a while; then it catches up two a tick where that changes no
press or release (the next update's trigger is up or down as the one just
taken), its buttons pressed too: holds and pauses shorten, taps stay. The
native builds (LAN, where updates come evenly) keep running the newest,
without the spare's tick. */
enum
{
	/* (a second of the host's ticks) */
	RELAYED_UPDATE_QUEUE_SIZE = 32,
	/* updates in hand before replay starts (again, after running dry) */
	RELAYED_UPDATE_CUSHION = 2,
	/* updates left after a tick, in step */
	RELAYED_UPDATE_SPARE = 1,
	/* ticks over which it must have kept more to be behind */
	RELAYED_UPDATE_BEHIND_WINDOW = 8,
};

static struct
{
	long last_update_number;
	short first;
	short count;
	boolean buffering;
	/* updates merged on arrival (the queue full): the next tick's joins them */
	boolean carry;
	/* the fewest updates left after a tick in this window, and its ticks */
	short window_minimum;
	short window_ticks;
	boolean behind;
	struct server_update updates[RELAYED_UPDATE_QUEUE_SIZE];
} update_client_relayed_queue = { NONE, 0, 0, TRUE, FALSE, RELAYED_UPDATE_QUEUE_SIZE, 0, FALSE };

static void update_client_relayed_reset(
	void)
{
	csmemset(update_client_relayed_actions, 0, sizeof(update_client_relayed_actions));
	csmemset(&update_client_relayed_queue, 0, sizeof(update_client_relayed_queue));
	update_client_relayed_queue.last_update_number = NONE;
	update_client_relayed_queue.buffering = TRUE;
	update_client_relayed_queue.window_minimum = RELAYED_UPDATE_QUEUE_SIZE;
}

/* an update's actions become the tick's, or (merge) join the tick's */
static void update_client_relayed_apply(
	struct server_update const *update,
	boolean merge)
{
	short action_index;

	for (action_index = 0;
		action_index < update->action_count && action_index < MAXIMUM_NUMBER_OF_PLAYERS;
		action_index++)
	{
		struct player_action const *action = &update->actions[action_index];
		real primary_trigger = action->primary_trigger;

		if (merge && update_client_relayed_actions[action_index].valid)
			primary_trigger = MAX(primary_trigger, update_client_relayed_actions[action_index].action.primary_trigger);
		update_client_relayed_actions[action_index].valid = TRUE;
		update_client_relayed_actions[action_index].action = *action;
		update_client_relayed_actions[action_index].action.primary_trigger = primary_trigger;
		update_client_relayed_actions[action_index].pending_control_flags |= action->control_flags;
	}
}

/* whether every player's trigger is up or down in the next update as in the
tick's */
static boolean update_client_relayed_next_continues(
	void)
{
	struct server_update const *next =
		&update_client_relayed_queue.updates[update_client_relayed_queue.first];
	short action_index;

	for (action_index = 0;
		action_index < next->action_count && action_index < MAXIMUM_NUMBER_OF_PLAYERS;
		action_index++)
	{
		if ((next->actions[action_index].primary_trigger > 0.0f) !=
			(update_client_relayed_actions[action_index].action.primary_trigger > 0.0f))
		{
			return FALSE;
		}
	}
	return TRUE;
}

static struct server_update const *update_client_relayed_take(
	void)
{
	struct server_update const *update =
		&update_client_relayed_queue.updates[update_client_relayed_queue.first];

	update_client_relayed_queue.first =
		(short)((update_client_relayed_queue.first + 1) % RELAYED_UPDATE_QUEUE_SIZE);
	update_client_relayed_queue.count--;
	return update;
}

/* (an update arrived) in order; an old or repeated one is dropped */
static void update_client_relayed_push(
	struct server_update const *update,
	long update_number)
{
	if (update_client_relayed_queue.last_update_number != NONE &&
		update_number <= update_client_relayed_queue.last_update_number)
	{
		return;
	}
	update_client_relayed_queue.last_update_number = update_number;
	/* (a stall longer than the queue) the oldest joins the tick's */
	if (update_client_relayed_queue.count == RELAYED_UPDATE_QUEUE_SIZE)
	{
		update_client_relayed_apply(update_client_relayed_take(), TRUE);
		update_client_relayed_queue.carry = TRUE;
	}
	update_client_relayed_queue.updates[
		(update_client_relayed_queue.first + update_client_relayed_queue.count) % RELAYED_UPDATE_QUEUE_SIZE] = *update;
	update_client_relayed_queue.count++;
}

/* (a tick) the next update, unless replay waits for its cushion; behind,
the one after it too */
static void update_client_relayed_tick(
	void)
{
	if (update_client_relayed_queue.buffering)
	{
		if (update_client_relayed_queue.count < RELAYED_UPDATE_CUSHION)
			return;
		update_client_relayed_queue.buffering = FALSE;
	}
	if (update_client_relayed_queue.count == 0)
	{
		update_client_relayed_queue.buffering = TRUE;
		update_client_relayed_queue.behind = FALSE;
		return;
	}
	update_client_relayed_apply(update_client_relayed_take(), update_client_relayed_queue.carry);
	update_client_relayed_queue.carry = FALSE;
	if (update_client_relayed_queue.behind && update_client_relayed_queue.count > RELAYED_UPDATE_SPARE &&
		update_client_relayed_next_continues())
	{
		update_client_relayed_apply(update_client_relayed_take(), TRUE);
	}
	update_client_relayed_queue.window_minimum =
		MIN(update_client_relayed_queue.window_minimum, update_client_relayed_queue.count);
	if (++update_client_relayed_queue.window_ticks >= RELAYED_UPDATE_BEHIND_WINDOW)
	{
		update_client_relayed_queue.behind = update_client_relayed_queue.window_minimum > RELAYED_UPDATE_SPARE;
		update_client_relayed_queue.window_minimum = RELAYED_UPDATE_QUEUE_SIZE;
		update_client_relayed_queue.window_ticks = 0;
	}
}

#endif

static struct update_server_globals update_server_globals = { 0 };
static struct update_client_globals update_client_globals = { 0 };

/* ---------- public code */

boolean update_server_new(
	void)
{
	match_assert(
		"c:\\halo\\SOURCE\\game\\player_queues_new.c",
		0xAC,
		!update_server_globals.initialized);
	csmemset(&update_server_globals, 0, sizeof(update_server_globals));
	update_server_globals.queues = data_new(
		"update server queues",
		MAXIMUM_NUMBER_OF_PLAYERS,
		sizeof(struct update_server_queue_datum));
	if (update_server_globals.queues)
	{
		csmemset(update_server_globals.updates, 0, sizeof(update_server_globals.updates));
		if (update_client_new())
		{
			update_server_globals.initialized = TRUE;
		}
	}

	return update_server_globals.initialized;
}

void update_server_delete(
	void)
{
	if (update_server_globals.queues)
	{
		data_dispose(update_server_globals.queues);
		update_server_globals.queues = NULL;
	}
	update_server_globals.initialized = FALSE;
	update_server_globals.next_update_number_to_build = 0;
	if (update_client_globals.queues)
	{
		data_dispose(update_client_globals.queues);
		update_client_globals.queues = NULL;
	}
	update_client_globals.next_update_number_to_dequeue = 0;
	update_client_globals.initialized = FALSE;
	update_client_globals.latest_update_number_received = NONE;

	return;
}

void update_server_start(
	void)
{
	struct data_iterator iterator;
	long queue_index;

	match_assert(
		"c:\\halo\\SOURCE\\game\\player_queues_new.c",
		0xCF,
		update_server_globals.initialized);
	data_make_valid(update_server_globals.queues);
	data_delete_all(update_server_globals.queues);
	data_iterator_new(&iterator, player_data);
	while (data_iterator_next(&iterator))
	{
		queue_index = datum_new_at_index(update_server_globals.queues, iterator.datum_index);
		match_assert(
			"c:\\halo\\SOURCE\\game\\player_queues_new.c",
			0xDD,
			queue_index!=NONE);
	}
	update_client_start();

	return;
}

void update_server_add_player(
	long player_index)
{
	long queue_index;

	queue_index = datum_new_at_index(update_server_globals.queues, player_index);
	match_assert(
		"c:\\halo\\SOURCE\\game\\player_queues_new.c",
		0xEB,
		queue_index!=NONE);

	return;
}

void update_server_next_update(
	void)
{
	long update_number = update_server_globals.next_update_number_to_build;
	struct update *update;
	struct update_server_queue_datum *queue;
	short queue_index;

	match_assert(
		"c:\\halo\\SOURCE\\game\\player_queues_new.c",
		0xFA,
		update_server_globals.initialized);
	update_server_globals.next_update_number_to_build += 1;
	update = update_server_get_update(update_number);
	match_assert(
		"c:\\halo\\SOURCE\\game\\player_queues_new.c",
		0x100,
		update);
	update->update_number = update_number;
	update->update.action_count = 0;
	queue = (struct update_server_queue_datum *)update_server_globals.queues->data;
	for (queue_index = 0; queue_index<update_server_globals.queues->count; ++queue_index, ++queue)
	{
#ifdef HALO_LINUX
		/* port: a slot no player holds (the distributed netcode's players keep
		their slots in the host's player list, which may leave gaps:
		network_game_manager.c) has an idle action, not what its queue's
		memory last held (a weapon index past the unit's, which every machine
		dequeuing it asserted on) */
		if (!queue->identifier)
		{
			struct player_action *action = &update->update.actions[queue_index];

			csmemset(action, 0, sizeof(*action));
			action->desired_weapon_index = NONE;
			action->desired_grenade_index = NONE;
			action->desired_zoom_level = NONE;
			update_server_pending_control_flags[queue_index] = 0;
			update->update.action_count += 1;
			continue;
		}
#endif
		csmemcpy(
			&update->update.actions[queue_index],
			&queue->current_action,
			sizeof(struct player_action));
#ifdef HALO_LINUX
		update->update.actions[queue_index].control_flags |= update_server_pending_control_flags[queue_index];
		update_server_pending_control_flags[queue_index] = 0;
		if (update_server_remote_player[queue_index])
		{
			long received = update_server_inputs_since_tick[queue_index];

			update_server_input_histogram_counts[received < 3 ? received : 3]++;
			update_server_inputs_since_tick[queue_index] = 0;
		}
#endif
		update->update.action_count += 1;
	}
	update_client_handle_server_update(&update->update, update_number);

	return;
}

void update_server_build_server_update(
	long machine_index,
	struct server_update *update,
	long *update_number)
{
	long start_time = system_milliseconds();
	struct update_server_queue_datum *queue = NULL;

	match_assert(
		"c:\\halo\\SOURCE\\game\\player_queues_new.c",
		0x11A,
		update && update_number && update_server_globals.initialized);
	if (machine_index!=NONE)
	{
		match_assert(
			"c:\\halo\\SOURCE\\game\\player_queues_new.c",
			0x11E,
			machine_index<MAXIMUM_NETWORK_MACHINE_COUNT);
		queue = datum_get(update_server_globals.queues, machine_index);
		if (queue->next_update_number<update_server_globals.next_update_number_to_build)
		{
			*update_number = queue->next_update_number;
		}
		else
		{
			*update_number = NONE;
			return;
		}
	}
	if (*update_number!=NONE)
	{
		struct update *server_update = update_server_get_update(*update_number);

		if (server_update)
		{
			csmemcpy(update, &server_update->update, sizeof(*update));
		}
		if (queue)
		{
			queue->next_update_number += 1;
		}
	}

	return;
}

boolean update_client_new(
	void)
{
	match_assert(
		"c:\\halo\\SOURCE\\game\\player_queues_new.c",
		0x146,
		!update_client_globals.initialized);
	csmemset(&update_client_globals, 0, sizeof(update_client_globals));
	update_client_globals.queues = data_new(
		"update client queues",
		MAXIMUM_NUMBER_OF_PLAYERS,
		sizeof(struct update_client_queue_datum));
	if (update_client_globals.queues)
	{
		csmemset(update_client_globals.updates, NONE, sizeof(update_client_globals.updates));
		update_client_globals.latest_update_number_received = NONE;
		update_client_globals.next_update_number_to_dequeue = 0;
		update_client_globals.initialized = TRUE;
	}

	return update_client_globals.initialized;
}

void update_client_delete(
	void)
{
	if (update_client_globals.queues)
	{
		data_dispose(update_client_globals.queues);
		update_client_globals.queues = NULL;
	}
	update_client_globals.latest_update_number_received = NONE;
	update_client_globals.next_update_number_to_dequeue = 0;
	update_client_globals.initialized = FALSE;

	return;
}

void update_client_start(
	void)
{
	struct data_iterator iterator;
	long queue_index;

	match_assert(
		"c:\\halo\\SOURCE\\game\\player_queues_new.c",
		0x168,
		update_client_globals.initialized);
	data_make_valid(update_client_globals.queues);
	data_delete_all(update_client_globals.queues);
	data_iterator_new(&iterator, player_data);
	while (data_iterator_next(&iterator))
	{
		queue_index = datum_new_at_index(update_client_globals.queues, iterator.datum_index);
		match_assert(
			"c:\\halo\\SOURCE\\game\\player_queues_new.c",
			0x176,
			queue_index!=NONE);
	}

	return;
}

void update_client_add_player(
	long player_index)
{
	long queue_index;

	queue_index = datum_new_at_index(update_client_globals.queues, player_index);
	match_assert(
		"c:\\halo\\SOURCE\\game\\player_queues_new.c",
		0x182,
		queue_index!=NONE);

	return;
}

#ifdef HALO_LINUX
/* The native builds draw several frames per 30 Hz tick
(port/linux/game/render_interpolation.c) and build an action every frame, and
only the last one before a tick reaches it: a button pressed and released
between two ticks, or a press seen only on its first frame (zoom, grenade
and weapon switches), would be lost. Every control held on any frame since
the last tick stays held until a tick has run, and the trigger stays as far
down as it went (weapons with an analog rate of fire read that, not the
flag). */
static unsigned long update_client_pending_control_flags[MAXIMUM_LOCAL_PLAYERS];
static real update_client_pending_primary_triggers[MAXIMUM_LOCAL_PLAYERS];
static long update_client_pending_game_time = NONE;

#endif
#ifdef HALO_WEB
/* network_messages.c's: an input as every machine will have it */
void web_quantize_player_action(struct player_action *action);
#endif

void update_client_queue(
	struct player_action const *action)
{
#ifdef HALO_WEB
	/* (the browser builds) quantized where it is made, before this machine
	uses or sends it: the host and every client run it as this one does */
	struct player_action quantized = *action;

	web_quantize_player_action(&quantized);
	action = &quantized;
#endif
	update_client_globals.saved_action_collection.actions[
		update_client_globals.current_local_player] = *action;
#ifdef HALO_LINUX
	if (update_client_globals.current_local_player < MAXIMUM_LOCAL_PLAYERS)
	{
		struct player_action *saved = &update_client_globals.saved_action_collection.actions[
			update_client_globals.current_local_player];
		unsigned long *pending = &update_client_pending_control_flags[
			update_client_globals.current_local_player];
		real *pending_primary_trigger = &update_client_pending_primary_triggers[
			update_client_globals.current_local_player];

		*pending |= action->control_flags;
		*pending_primary_trigger = MAX(*pending_primary_trigger, action->primary_trigger);
		saved->control_flags = *pending;
		saved->primary_trigger = *pending_primary_trigger;
	}
#endif
	++update_client_globals.current_local_player;

	return;
}

void update_client_queue_push(
	void)
{
#ifdef HALO_LINUX
	/* while the clock is stopped no tick will take them */
	if (update_client_pending_game_time != game_time_get() ||
		game_time_get_paused())
	{
		update_client_pending_game_time = game_time_get();
		csmemset(
			update_client_pending_control_flags,
			0,
			sizeof(update_client_pending_control_flags));
		csmemset(
			update_client_pending_primary_triggers,
			0,
			sizeof(update_client_pending_primary_triggers));
	}
#endif
	update_client_globals.current_local_player = 0;
	csmemset(
		&update_client_globals.saved_action_collection,
		0,
		sizeof(update_client_globals.saved_action_collection));

	return;
}

#ifdef HALO_LINUX
/* the local player (of this machine) controlling the player at player_index,
or NONE */
static short update_client_local_player_index(
	short player_index)
{
	short local_player_index;

	for (local_player_index = 0; local_player_index < MAXIMUM_LOCAL_PLAYERS; local_player_index++)
	{
		long local_player = local_player_get_player_index(local_player_index);

		if (local_player != NONE && DATUM_INDEX_TO_ABSOLUTE_INDEX(local_player) == player_index)
			return local_player_index;
	}
	return NONE;
}

/* the distributed netcode's tick (port/linux/NETCODE.md): this machine's
players from its own input at once, the others from what the host last
relayed */
static boolean update_client_dequeue_distributed(
	struct player_action *actions)
{
	struct update_client_queue_datum *queue = (struct update_client_queue_datum *)update_client_globals.queues->data;
	short queue_index;

#ifdef HALO_WEB
	update_client_relayed_tick();
#endif
	for (queue_index = 0; queue_index < update_client_globals.queues->count; ++queue_index, ++queue)
	{
		struct player_action action;
		short local_player_index = update_client_local_player_index(queue_index);

		csmemset(&action, 0, sizeof(action));
		action.desired_weapon_index = NONE;
		action.desired_grenade_index = NONE;
		action.desired_zoom_level = NONE;
		if (local_player_index != NONE)
		{
			action = update_client_globals.saved_action_collection.actions[local_player_index];
		}
		else if (queue_index < MAXIMUM_NUMBER_OF_PLAYERS && update_client_relayed_actions[queue_index].valid)
		{
			action = update_client_relayed_actions[queue_index].action;
			action.control_flags |= update_client_relayed_actions[queue_index].pending_control_flags;
			update_client_relayed_actions[queue_index].pending_control_flags = 0;
		}
		actions[queue_index].control_flags = action.control_flags & ~queue->latched_control_flags;
		queue->latched_control_flags = action.control_flags & LATCHED_CONTROL_FLAGS;
		actions[queue_index].desired_facing = action.desired_facing;
		actions[queue_index].throttle = action.throttle;
		actions[queue_index].primary_trigger = action.primary_trigger;
		actions[queue_index].desired_weapon_index = action.desired_weapon_index;
		actions[queue_index].desired_grenade_index = action.desired_grenade_index;
		actions[queue_index].desired_zoom_level = action.desired_zoom_level;
	}
	update_client_globals.next_update_number_to_dequeue += 1;
#ifdef HALO_WEB
	network_web_client_tick();
#endif
	return TRUE;
}

#endif
boolean update_client_dequeue(
	struct player_action *actions)
{
	struct update *update;
	struct update_client_queue_datum *queue;
	short queue_index;

	match_assert(
		"c:\\halo\\SOURCE\\game\\player_queues_new.c",
		0x1AF,
		update_client_globals.initialized);
#ifdef HALO_LINUX
	if (game_connection() == _game_connection_network_client && network_game_distributed())
		return update_client_dequeue_distributed(actions);
#endif
	update = update_client_get_update(update_client_globals.next_update_number_to_dequeue);
	if (!update ||
		update_client_globals.next_update_number_to_dequeue>update_client_globals.latest_update_number_received ||
		update->update.action_count<=0 ||
		update->update.action_count>MAXIMUM_NUMBER_OF_PLAYERS)
	{
		return FALSE;
	}

	queue = (struct update_client_queue_datum *)update_client_globals.queues->data;
	for (queue_index = 0; queue_index<update_client_globals.queues->count; ++queue_index, ++queue)
	{
		if (queue_index<update->update.action_count)
		{
			struct player_action *action = &update->update.actions[queue_index];

			queue->control_flags = action->control_flags;
			queue->desired_facing = action->desired_facing;
			queue->throttle = action->throttle;
			queue->primary_trigger = action->primary_trigger;
			queue->desired_weapon_index = action->desired_weapon_index;
			queue->desired_grenade_index = action->desired_grenade_index;
			queue->desired_zoom_level = action->desired_zoom_level;
			match_assert(
				"c:\\halo\\SOURCE\\game\\player_queues_new.c",
				0x1C9,
				(NONE == queue->desired_weapon_index) || (queue->desired_weapon_index>=0 && queue->desired_weapon_index<MAXIMUM_WEAPONS_PER_UNIT));
			match_assert(
				"c:\\halo\\SOURCE\\game\\player_queues_new.c",
				0x1CA,
				(NONE == queue->desired_grenade_index) || (queue->desired_grenade_index>=0 && queue->desired_grenade_index<NUMBER_OF_UNIT_GRENADE_TYPES));
			match_assert(
				"c:\\halo\\SOURCE\\game\\player_queues_new.c",
				0x1CB,
				(NONE == queue->desired_zoom_level) || (queue->desired_zoom_level>=0));
		}
	}

	queue = (struct update_client_queue_datum *)update_client_globals.queues->data;
	for (queue_index = 0; queue_index<update_client_globals.queues->count; ++queue_index, ++queue)
	{
		actions[queue_index].control_flags = queue->control_flags & ~queue->latched_control_flags;
		queue->latched_control_flags = queue->control_flags & LATCHED_CONTROL_FLAGS;
		actions[queue_index].desired_facing = queue->desired_facing;
		actions[queue_index].throttle = queue->throttle;
		actions[queue_index].primary_trigger = queue->primary_trigger;
		actions[queue_index].desired_weapon_index = queue->desired_weapon_index;
		actions[queue_index].desired_grenade_index = queue->desired_grenade_index;
		actions[queue_index].desired_zoom_level = queue->desired_zoom_level;
		match_assert(
			"c:\\halo\\SOURCE\\game\\player_queues_new.c",
			0x1E6,
			(NONE == actions[queue_index].desired_weapon_index) || (actions[queue_index].desired_weapon_index>=0 && actions[queue_index].desired_weapon_index<MAXIMUM_WEAPONS_PER_UNIT));
		match_assert(
			"c:\\halo\\SOURCE\\game\\player_queues_new.c",
			0x1E7,
			(NONE == actions[queue_index].desired_grenade_index) || (actions[queue_index].desired_grenade_index>=0 && actions[queue_index].desired_grenade_index<NUMBER_OF_UNIT_GRENADE_TYPES));
		match_assert(
			"c:\\halo\\SOURCE\\game\\player_queues_new.c",
			0x1E8,
			(NONE == actions[queue_index].desired_zoom_level) || (actions[queue_index].desired_zoom_level>=0));
	}
	update_client_globals.next_update_number_to_dequeue += 1;

	return TRUE;
}

long update_client_get_maximum_actions(
	void)
{
	return update_client_globals.latest_update_number_received -
		update_client_globals.next_update_number_to_dequeue + 1;
}

long update_client_get_maximum_possible_server_time(
	void)
{
	long update_number = update_client_globals.next_update_number_to_dequeue;

	while (update_number<=update_client_globals.latest_update_number_received)
	{
		struct update *update = update_client_get_update(update_number);

		if (!update ||
			update->update.action_count<=0 ||
			update->update.action_count>MAXIMUM_NUMBER_OF_PLAYERS)
		{
			break;
		}
		update_number += 1;
	}

	return update_number;
}

void update_client_local_ticks(
	short ticks)
{
	struct player_action_collection action_collection;
	struct server_update update;
	long update_number;
	long machine_index = 0;

	match_assert(
		"c:\\halo\\SOURCE\\game\\player_queues_new.c",
		0x20B,
		game_connection()==_game_connection_local);
	update_client_build_client_update(&action_collection);
	update_server_handle_client_update(machine_index, action_collection.actions);
	while (ticks-->0)
	{
		update_server_next_update();
		update_server_build_server_update(machine_index, &update, &update_number);
	}

	return;
}

void update_server_handle_client_update(
	long machine_index,
	struct player_action *actions)
{
	long *player_list = machine_get_player_list(machine_index);
	long action_index = 0;
	long player_index;

	match_assert(
		"c:\\halo\\SOURCE\\game\\player_queues_new.c",
		0x22A,
		update_server_globals.initialized);
	for (player_index = 0; player_index<MAXIMUM_LOCAL_PLAYERS; ++player_index)
	{
		if (player_list[player_index]!=NONE)
		{
			struct update_server_queue_datum *queue = datum_get(
				update_server_globals.queues,
				player_list[player_index]);

			queue->current_action = actions[action_index++];
#ifdef HALO_LINUX
			update_server_pending_control_flags[DATUM_INDEX_TO_ABSOLUTE_INDEX(player_list[player_index])] |=
				queue->current_action.control_flags;
			update_server_inputs_since_tick[DATUM_INDEX_TO_ABSOLUTE_INDEX(player_list[player_index])]++;
			update_server_remote_player[DATUM_INDEX_TO_ABSOLUTE_INDEX(player_list[player_index])] = TRUE;
#endif
			match_assert_valid_real(
				"c:\\halo\\SOURCE\\game\\player_queues_new.c",
				0x238,
				queue->current_action.desired_facing.pitch);
			match_assert_valid_real(
				"c:\\halo\\SOURCE\\game\\player_queues_new.c",
				0x239,
				queue->current_action.desired_facing.yaw);
		}
	}

	return;
}

void update_client_build_client_update(
	struct player_action_collection *action_collection)
{
	match_assert(
		"c:\\halo\\SOURCE\\game\\player_queues_new.c",
		0x244,
		action_collection && update_client_globals.initialized);
	csmemcpy(
		action_collection,
		&update_client_globals.saved_action_collection,
		sizeof(*action_collection));

	return;
}

void update_client_handle_server_update(
	struct server_update *update,
	long update_number)
{
	struct update *client_update = update_client_get_update(update_number);

#ifdef HALO_LINUX
	if (game_connection() == _game_connection_network_client && network_game_distributed())
	{
#ifdef HALO_WEB
		network_web_relayed_update();
		update_client_relayed_push(update, update_number);
#else
		short action_index;

		/* (the native builds) the newest, until the next */
		for (action_index = 0;
			action_index < update->action_count && action_index < MAXIMUM_NUMBER_OF_PLAYERS;
			action_index++)
		{
			update_client_relayed_actions[action_index].valid = TRUE;
			update_client_relayed_actions[action_index].action = update->actions[action_index];
			update_client_relayed_actions[action_index].pending_control_flags |= update->actions[action_index].control_flags;
		}
#endif
		/* port: the distributed client plays on its own clock
		(update_client_dequeue_distributed) and takes only the relayed
		actions from the host's update. Its stock queue follows this
		machine's ticks, not the host's update numbers, which arrive
		behind them, so queueing the update failed (logging "failed to get
		an update") on every tick (upstream 84ed39e2's network half). */
		return;
	}
#endif
	if (client_update)
	{
		client_update->update_number = update_number;
		csmemcpy(&client_update->update, update, sizeof(client_update->update));
		if (update_number>update_client_globals.latest_update_number_received)
		{
			if (update_client_globals.latest_update_number_received+1<update_number)
			{
				client_update->update.action_count = NONE;
			}
			update_client_globals.latest_update_number_received = update_number;
		}
	}
	else if (!global_network_game_client_get() || !global_network_game_server_get())
	{
		if (!main_menu_is_active())
		{
			error(_error_silent, "failed to get an update (#%d); sp scenario= '%s'", update_number, main_get_map_name());
			error(_error_silent, "if you're in a multiplayer game, you might be out of sync now");
			error(_error_silent, "if you're playing single player/coop, you can probably ignore this");
		}
	}

	switch (game_connection())
	{
	case _game_connection_local:
	case _game_connection_network_client:
	case _game_connection_network_server:
		/* film recording of the update was compiled out of this build; only its menu check remains */
		main_menu_is_active();
		break;
	}

	return;
}

#ifdef HALO_LINUX
/* port: the distributed netcode's record of each player's latest input,
forgotten for a new game (network_distributed_new_game) as after loading
one: a game numbers its updates from the start again, so the last game's
latest, kept, would be later than any of this game's, and a client would
drop every relayed update as old (the other players driven by the last
game's last input) until this game's numbers passed it */
void update_queues_distributed_reset(
	void)
{
	csmemset(update_server_pending_control_flags, 0, sizeof(update_server_pending_control_flags));
	update_client_relayed_reset();
}

#endif
void update_queues_reset_and_fill_with_lies(
	void)
{
#ifdef HALO_LINUX
	update_queues_distributed_reset();
#endif
	if (update_server_globals.initialized)
	{
		update_server_globals.next_update_number_to_build = 0;
		csmemset(update_server_globals.updates, 0, sizeof(update_server_globals.updates));
	}
	if (update_client_globals.initialized)
	{
		long game_time;
		long update_number;
		long update_index;

		csmemset(update_client_globals.updates, NONE, sizeof(update_client_globals.updates));
		csmemset(
			&update_client_globals.saved_action_collection,
			0,
			sizeof(update_client_globals.saved_action_collection));
		update_client_globals.latest_update_number_received = NONE;
		update_client_globals.next_update_number_to_dequeue = 0;
		game_time = game_time_get();
		update_number = MAX(0, game_time-MAXIMUM_CLIENT_UPDATES);
		for (update_index = 0; update_number<game_time; ++update_index, ++update_number)
		{
			update_client_globals.updates[update_index].update_number = update_number;
			update_client_globals.updates[update_index].update.action_count = 1;
			csmemset(
				update_client_globals.updates[update_index].update.actions,
				0,
				sizeof(update_client_globals.updates[update_index].update.actions));
		}
		update_client_globals.next_update_number_to_dequeue = game_time;
		update_client_globals.latest_update_number_received = game_time-1;
		update_server_globals.next_update_number_to_build = game_time;
	}
	if (update_server_globals.initialized)
	{
		struct update_server_queue_datum *queue;

		update_server_start();
		queue = datum_get(update_server_globals.queues, 0);
		queue->next_update_number = update_server_globals.next_update_number_to_build;
	}
	else if (update_client_globals.initialized)
	{
		update_client_start();
	}

	return;
}

long player_new_queue(
	long player_index)
{
	long queue_index;

	queue_index = datum_new_at_index(update_server_globals.queues, player_index);
	match_assert(
		"c:\\halo\\SOURCE\\game\\player_queues_new.c",
		0x292,
		queue_index!=NONE);

	return queue_index;
}

/* ---------- private code */

static struct update *update_server_get_update(
	long update_number)
{
	struct update *update;

	match_assert(
		"c:\\halo\\SOURCE\\game\\player_queues_new.c",
		0x29E,
		update_server_globals.initialized);
	if (update_number<update_server_globals.next_update_number_to_build &&
		update_number>=update_server_globals.next_update_number_to_build-MAXIMUM_SERVER_UPDATES)
	{
		update = &update_server_globals.updates[update_number&(MAXIMUM_SERVER_UPDATES-1)];
	}
	else
	{
		update = NULL;
	}

	return update;
}

static struct update *update_client_get_update(
	long update_number)
{
	if (update_number>=update_client_globals.next_update_number_to_dequeue &&
		update_number<update_client_globals.next_update_number_to_dequeue+MAXIMUM_CLIENT_UPDATES)
	{
		return &update_client_globals.updates[update_number&(MAXIMUM_CLIENT_UPDATES-1)];
	}

	return NULL;
}
