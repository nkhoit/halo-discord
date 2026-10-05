/* Browser invite-flow mailbox and game-thread menu integration. */

#include "web_online_ui.h"

#include <emscripten/emscripten.h>
#include <stdatomic.h>
#include <string.h>

/* This browser adapter is compiled as platform code, so it must not include
the game's cseries headers after the host libc headers.  Keep this boundary
to opaque pointers and the game's scalar ABI. */
struct network_game_client;
struct network_game;
struct network_game_server;
struct widget_instance;

void ui_widgets_close_all(void);
struct widget_instance *ui_widget_load_by_name_or_tag(
	const char *name,
	long tag_index,
	struct widget_instance *parent,
	short local_player_index,
	long invoking_widget_tag,
	long focused_child_parent_widget_tag,
	short focused_child_index);
void dispose_global_network_game_server(void);
void dispose_global_network_game_client(void);
struct network_game_server *global_network_game_server_get(void);
struct network_game_client *global_network_game_client_get(void);
unsigned char create_global_network_game_client(void);
void network_game_accept_remote_connections(unsigned char accept_remote_connections);
void player_ui_clear_multiplayer_joins(void);
void player_ui_clear_multiplayer_variant(void);
void player_ui_fast_setup_network_server(void);
long player_ui_get_active_player_profile_index(short local_player_index);
void player_ui_get_active_player_profile(short local_player_index, void *profile);
void player_ui_set_active_player_profile(
	short local_player_index,
	long profile_index,
	void *profile);
unsigned char player_ui_configure_network_server_game(
	long multiplayer_level_index,
	long game_mode_index);
void game_connection_set(short connection);
void main_goto_main_menu(void);
short network_game_client_get_state(struct network_game_client *client, short *state_data);
unsigned char network_game_client_request_start_time_change(struct network_game_client *client, short request_type);
void network_game_server_pause_countdown(struct network_game_server *server, unsigned char pause);
short network_game_client_get_error(struct network_game_client *client);
unsigned char network_game_client_join_first_available_game(void);
unsigned char network_game_client_add_player(struct network_game_client *client, short controller_index);
unsigned char network_game_client_has_local_player(
	struct network_game_client *client,
	short local_player_index);
unsigned char network_game_server_joinable_in_game(struct network_game_server *server);
unsigned char network_game_server_watchable_in_game(struct network_game_server *server);
unsigned char network_game_server_match_starting(struct network_game_server *server);
unsigned char network_game_server_countdown_active(struct network_game_server *server);
unsigned char network_game_client_set_team(char team_index);
unsigned char network_game_client_request_team_switch(char team_index);
unsigned char network_game_client_team_switch_allowed(char team_index);
int network_game_client_game_has_teams(void);
int network_game_client_roster_slot(int index, int *name, int *team, int *local);
int config_boolean(const char *name);
long config_integer(const char *name);
int config_write_boolean(const char *name, int value);
/* network_game_globals.c's: a machine that watches a match without a player */
void network_game_set_spectating(unsigned char spectating);
unsigned char network_game_spectating(void);
short local_player_count(void);
/* port/linux/game/spectator.c's */
void spectator_request_cycle(short direction);
int spectator_target_name_character(int index);
void platform_log(const char *format, ...);
/* game_engine.c's and game.c's: ending a match the way a score or time limit does */
unsigned char game_engine_running(void);
void game_engine_end_game(void);
short game_connection(void);

enum
{
	/* network_game_client_get_state(), kept private by its implementation */
	_network_client_searching = 0,
	_network_client_joining,
	_network_client_pregame,
	_network_client_ingame,
	_network_client_postgame,

	/* Native invite joining also gives up after 90 seconds. */
	WEB_ONLINE_JOIN_TIMEOUT_SECONDS = 90,
	/* Retry slowly enough to avoid duplicate in-game queue entries, but soon
	 * enough to recover when a pregame add crosses the match transition. */
	WEB_ONLINE_PLAYER_RETRY_SECONDS = 1,

	_game_connection_local = 0,
	_game_connection_network_client,
	_game_connection_network_server,

	WEB_ONLINE_REQUEST_COMMAND_MASK = 0xff,
	WEB_ONLINE_REQUEST_MAP_SHIFT = 8,
	WEB_ONLINE_REQUEST_MODE_SHIFT = 16,
};

#define WEB_FALSE ((unsigned char)0)
#define WEB_TRUE 1
#define WEB_NONE (-1)

/* Xbox player profiles use eleven UTF-16 code units plus a terminator.  Keep
 * this small ABI mirror local to the browser adapter: including the game's
 * cseries headers after Emscripten's host headers would corrupt libc types. */
struct web_online_player_profile
{
	unsigned short player_name[WEB_ONLINE_PLAYER_NAME_CHARACTERS + 1];
	short primary_color_index;
	unsigned char remainder[22];
};

_Static_assert(sizeof(struct web_online_player_profile) == 0x30,
	"web player profile ABI must remain 0x30 bytes");

/* Command and host options share one atomic word so the game thread can never
observe a new command with map/mode values from a different browser request. */
static atomic_int web_online_requested_request = ATOMIC_VAR_INIT(_web_online_command_none);
/* the host's next match, set in its pregame lobby: 1 | map << 8 | mode << 16,
0 for none (its own mailbox: it never starts or ends a session) */
static atomic_int web_online_requested_configuration = ATOMIC_VAR_INIT(0);
/* the host asks for its match to start (1), as A on Halo's lobby does */
static atomic_int web_online_requested_start = ATOMIC_VAR_INIT(0);
/* the host asks to end the running match (1), as a score or time limit does */
static atomic_int web_online_requested_end = ATOMIC_VAR_INIT(0);
/* the page's choice whether a host lets players join its running match
(network.join_in_progress): -1 none yet, else 0 or 1 */
static atomic_int web_online_requested_join_in_progress = ATOMIC_VAR_INIT(-1);
/* the page's choice to watch a running match without a player (1), or to
add its player after watching (0): -1 none yet */
static atomic_int web_online_requested_spectate = ATOMIC_VAR_INIT(-1);
/* (a client) it watches a match without a player of its own */
static atomic_int web_online_spectating = ATOMIC_VAR_INIT(0);
/* this machine's players onto red (0) or blue (1); -1 none. Pregame only. */
static atomic_int web_online_requested_team = ATOMIC_VAR_INIT(-1);
/* Mid-match switch queue (-1 none). Separate from pregame so a late pregame
click cannot become an in-game request. */
static atomic_int web_online_requested_team_switch = ATOMIC_VAR_INIT(-1);
/* the client's roster, copied each frame so the browser thread never reads
the game's player array. 32 is the web match cap (HALO_WEB_MAXIMUM_PLAYERS). */
enum
{
	WEB_ONLINE_ROSTER_LIMIT = 32,
	WEB_ONLINE_ROSTER_NAME = 12,
};
static atomic_uint web_online_roster_sequence = ATOMIC_VAR_INIT(0);
static atomic_int web_online_roster_count = ATOMIC_VAR_INIT(0);
static atomic_int web_online_roster_teams = ATOMIC_VAR_INIT(0);
static atomic_int web_online_roster_team[WEB_ONLINE_ROSTER_LIMIT];
static atomic_int web_online_roster_local[WEB_ONLINE_ROSTER_LIMIT];
static atomic_int web_online_roster_name[WEB_ONLINE_ROSTER_LIMIT][WEB_ONLINE_ROSTER_NAME];
/* (a spectator) the name of the player watched, a character each; 0 ends it */
#define WEB_ONLINE_SPECTATE_NAME_CHARACTERS 12
static atomic_int web_online_spectate_name[WEB_ONLINE_SPECTATE_NAME_CHARACTERS];
/* (the host) whether a machine could join its match now */
static atomic_int web_online_match_joinable = ATOMIC_VAR_INIT(0);
/* (the host) whether a spectator could join its match now */
static atomic_int web_online_match_watchable = ATOMIC_VAR_INIT(0);
/* (the host) its lobby has started the match, which is loading */
static atomic_int web_online_match_starting = ATOMIC_VAR_INIT(0);
static atomic_int web_online_public_state = ATOMIC_VAR_INIT(_web_online_state_idle);
static atomic_int web_online_public_error = ATOMIC_VAR_INIT(_web_online_error_none);
static atomic_int web_online_transport_state = ATOMIC_VAR_INIT(_web_online_transport_disconnected);
static atomic_uint web_online_customization_sequence = ATOMIC_VAR_INIT(0);
static atomic_int web_online_requested_color = ATOMIC_VAR_INIT(0);
static atomic_int web_online_requested_name[WEB_ONLINE_PLAYER_NAME_CHARACTERS];
static unsigned int web_online_applied_customization_sequence;

static struct
{
	int command;
	int setup;
	int join_attempted;
	int join_completed;
	int player_added;
	int player_request_sent;
	int pregame_screen_loaded;
	int wait_frames;
	int host_map_index;
	int host_mode_index;
	/* (the host) the page started the match, which has not begun loading */
	int start_requested;
	float start_retry_seconds;
	float seconds;
	float player_retry_seconds;
} web_online;

static void publish_state(int state)
{
	atomic_store_explicit(&web_online_public_state, state, memory_order_release);
}

static void publish_error(int error)
{
	atomic_store_explicit(&web_online_public_error, error, memory_order_release);
}

static int pack_request(int command, int map_index, int mode_index)
{
	return (command & WEB_ONLINE_REQUEST_COMMAND_MASK) |
		(map_index << WEB_ONLINE_REQUEST_MAP_SHIFT) |
		(mode_index << WEB_ONLINE_REQUEST_MODE_SHIFT);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_request(int command)
{
	if (command < _web_online_command_host || command > _web_online_command_cancel)
		return 0;
	/* Legacy callers that only request hosting get the safe defaults: Battle
	Creek and Slayer. Join/cancel ignore the packed host fields. */
	atomic_store_explicit(
		&web_online_requested_request,
		pack_request(command, 0, 0),
		memory_order_release);
	return 1;
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_host_configured(
	int map_index,
	int mode_index)
{
	if (map_index < 0 || map_index >= _web_online_multiplayer_level_count ||
		mode_index < 0 || mode_index >= _web_online_game_mode_count)
	{
		return 0;
	}
	atomic_store_explicit(
		&web_online_requested_request,
		pack_request(_web_online_command_host, map_index, mode_index),
		memory_order_release);
	return 1;
}

/* The host's pregame lobby takes another map and game type (after a match,
for the next one): the same change Halo's own lobby menus make, so nobody
disconnects. Ignored unless this machine hosts and is in its lobby. */
EMSCRIPTEN_KEEPALIVE int platform_web_online_configure(
	int map_index,
	int mode_index)
{
	if (map_index < 0 || map_index >= _web_online_multiplayer_level_count ||
		mode_index < 0 || mode_index >= _web_online_game_mode_count)
	{
		return 0;
	}
	atomic_store_explicit(
		&web_online_requested_configuration,
		pack_request(1, map_index, mode_index),
		memory_order_release);
	return 1;
}

/* The host's lobby starts its match: the request Halo's lobby makes when the
host presses A ("start faster", network_game_client_request_start_time_change),
whichever of the lobby's menus has the focus. Ignored unless this machine
hosts and is in its lobby. */
EMSCRIPTEN_KEEPALIVE int platform_web_online_start_match(void)
{
	atomic_store_explicit(&web_online_requested_start, 1, memory_order_release);
	return 1;
}

/* The host ends the running match the way a score or time limit does
(game_engine_end_game): its results, then the lobby, and nobody leaves.
The browser only sets a flag. web_online_ui_update() applies it on the
game thread, and only while this machine hosts a match that is running. */
EMSCRIPTEN_KEEPALIVE int platform_web_online_end_match(void)
{
	atomic_store_explicit(&web_online_requested_end, 1, memory_order_release);
	return 1;
}

/* Whether this machine, hosting, lets players join its match while it runs
(the setting network.join_in_progress, saved with the others). */
EMSCRIPTEN_KEEPALIVE int platform_web_online_set_join_in_progress(int enabled)
{
	atomic_store_explicit(&web_online_requested_join_in_progress, enabled ? 1 : 0, memory_order_release);
	return 1;
}

/* Whether this machine joins a running match as a spectator, without a
player (1, before joining), or adds its player after watching (0): the
in-game add a late joiner's player takes. The distributed netcode only. */
EMSCRIPTEN_KEEPALIVE int platform_web_online_set_spectate(int spectate)
{
	atomic_store_explicit(&web_online_requested_spectate, spectate ? 1 : 0, memory_order_release);
	return 1;
}

/* (a client) it is in a match, or its lobby, watching without a player */
EMSCRIPTEN_KEEPALIVE int platform_web_online_spectating(void)
{
	return atomic_load_explicit(&web_online_spectating, memory_order_acquire);
}

/* (a spectator) watch the next (+1) or previous (-1) player with a unit */
EMSCRIPTEN_KEEPALIVE int platform_web_spectate_cycle(int direction)
{
	spectator_request_cycle(direction < 0 ? -1 : 1);
	return 1;
}

/* (a spectator) the watched player's name, a character at a time: 0 past its
end, or when it watches nobody */
EMSCRIPTEN_KEEPALIVE int platform_web_spectate_target_name(int index)
{
	if (index < 0 || index >= WEB_ONLINE_SPECTATE_NAME_CHARACTERS)
		return 0;
	return atomic_load_explicit(&web_online_spectate_name[index], memory_order_acquire);
}

/* (the host) whether a machine joining now would enter the running match:
the match is on, not over, and has room */
EMSCRIPTEN_KEEPALIVE int platform_web_online_match_joinable(void)
{
	return atomic_load_explicit(&web_online_match_joinable, memory_order_acquire);
}

/* (the host) whether a spectator joining now would enter the running match:
the match is on, not over, and has room for another spectator, whether or
not it has room for another player */
EMSCRIPTEN_KEEPALIVE int platform_web_online_match_watchable(void)
{
	return atomic_load_explicit(&web_online_match_watchable, memory_order_acquire);
}

/* (the host) its match has started and is loading: nobody can join yet */
EMSCRIPTEN_KEEPALIVE int platform_web_online_match_starting(void)
{
	return atomic_load_explicit(&web_online_match_starting, memory_order_acquire);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_set_player_customization(
	int color_index,
	int name0,
	int name1,
	int name2,
	int name3,
	int name4,
	int name5,
	int name6,
	int name7,
	int name8,
	int name9,
	int name10)
{
	int i;
	int name_length = 0;
	int name[WEB_ONLINE_PLAYER_NAME_CHARACTERS] =
	{
		name0, name1, name2, name3, name4, name5,
		name6, name7, name8, name9, name10,
	};

	if (color_index < 0 || color_index >= WEB_ONLINE_PLAYER_COLOR_COUNT)
		return 0;

	/* Browser names intentionally use Halo's portable ASCII subset.  Reject a
	 * malformed caller instead of letting control codes reach menu rendering. */
	for (i = 0; i < WEB_ONLINE_PLAYER_NAME_CHARACTERS; i++)
	{
		if (!name[i])
			break;
		if (name[i] < 0x20 || name[i] > 0x7e)
			return 0;
		name_length++;
	}
	if (!name_length)
		return 0;

	/* Odd versions are writes in progress; even versions are complete. */
	atomic_fetch_add_explicit(
		&web_online_customization_sequence,
		1,
		memory_order_acq_rel);
	atomic_store_explicit(
		&web_online_requested_color,
		color_index,
		memory_order_relaxed);
	for (i = 0; i < WEB_ONLINE_PLAYER_NAME_CHARACTERS; i++)
	{
		atomic_store_explicit(
			&web_online_requested_name[i],
			i < name_length ? name[i] : 0,
			memory_order_relaxed);
	}
	/* Publishing the even version last commits the mailbox transaction. */
	atomic_fetch_add_explicit(
		&web_online_customization_sequence,
		1,
		memory_order_release);
	return 1;
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_get_state(void)
{
	return atomic_load_explicit(&web_online_public_state, memory_order_acquire);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_get_error(void)
{
	return atomic_load_explicit(&web_online_public_error, memory_order_acquire);
}

EMSCRIPTEN_KEEPALIVE void platform_web_online_set_transport_state(int state)
{
	if (state < _web_online_transport_disconnected || state > _web_online_transport_failed)
		return;
	atomic_store_explicit(&web_online_transport_state, state, memory_order_release);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_get_transport_state(void)
{
	return atomic_load_explicit(&web_online_transport_state, memory_order_acquire);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_get_client_state(void)
{
	struct network_game_client *client = global_network_game_client_get();

	return client ? network_game_client_get_state(client, NULL) : WEB_NONE;
}

/* The page's team choice. network_game_client_set_team itself refuses
anything but pregame; this returns 0 in that case instead of queueing a
choice the match would ignore. */
EMSCRIPTEN_KEEPALIVE int platform_web_online_set_team(int team_index)
{
	struct network_game_client *client = global_network_game_client_get();

	if (team_index != 0 && team_index != 1)
		return 0;
	if (!client || network_game_client_get_state(client, NULL) != _network_client_pregame)
		return 0;
	atomic_store_explicit(&web_online_requested_team, team_index, memory_order_release);
	return 1;
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_switch_team(int team_index)
{
	struct network_game_client *client = global_network_game_client_get();

	if (team_index != 0 && team_index != 1)
		return 0;
	if (!client || network_game_client_get_state(client, NULL) != _network_client_ingame)
		return 0;
	if (!network_game_client_game_has_teams())
		return 0;
	atomic_store_explicit(&web_online_requested_team_switch, team_index, memory_order_release);
	return 1;
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_team_switch_allowed(int team_index)
{
	if (team_index != 0 && team_index != 1)
		return 0;
	return network_game_client_team_switch_allowed((char)team_index) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_roster_sequence(void)
{
	return (int)atomic_load_explicit(&web_online_roster_sequence, memory_order_acquire);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_roster_count(void)
{
	return atomic_load_explicit(&web_online_roster_count, memory_order_acquire);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_roster_teams(void)
{
	return atomic_load_explicit(&web_online_roster_teams, memory_order_acquire);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_roster_team(int index)
{
	if (index < 0 || index >= WEB_ONLINE_ROSTER_LIMIT)
		return -1;
	return atomic_load_explicit(&web_online_roster_team[index], memory_order_acquire);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_roster_local(int index)
{
	if (index < 0 || index >= WEB_ONLINE_ROSTER_LIMIT)
		return 0;
	return atomic_load_explicit(&web_online_roster_local[index], memory_order_acquire);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_roster_name(int index, int unit)
{
	if (index < 0 || index >= WEB_ONLINE_ROSTER_LIMIT ||
		unit < 0 || unit >= WEB_ONLINE_ROSTER_NAME)
		return 0;
	return atomic_load_explicit(&web_online_roster_name[index][unit], memory_order_acquire);
}

static void publish_lobby_roster(void)
{
	int slot;
	int count = 0;
	int name[WEB_ONLINE_ROSTER_NAME];
	int team;
	int local;
	int unit;

	atomic_fetch_add_explicit(&web_online_roster_sequence, 1, memory_order_acq_rel);
	for (slot = 0; count < WEB_ONLINE_ROSTER_LIMIT; slot++)
	{
		int present = network_game_client_roster_slot(slot, name, &team, &local);

		if (present < 0)
			break;
		if (!present)
			continue;
		atomic_store_explicit(&web_online_roster_team[count], team, memory_order_relaxed);
		atomic_store_explicit(&web_online_roster_local[count], local ? 1 : 0, memory_order_relaxed);
		for (unit = 0; unit < WEB_ONLINE_ROSTER_NAME; unit++)
		{
			atomic_store_explicit(
				&web_online_roster_name[count][unit],
				name[unit],
				memory_order_relaxed);
		}
		count++;
	}
	atomic_store_explicit(&web_online_roster_count, count, memory_order_relaxed);
	atomic_store_explicit(
		&web_online_roster_teams,
		network_game_client_game_has_teams() ? 1 : 0,
		memory_order_relaxed);
	atomic_fetch_add_explicit(&web_online_roster_sequence, 1, memory_order_release);
}

static void apply_team_request(void)
{
	int team = atomic_exchange_explicit(&web_online_requested_team, -1, memory_order_acq_rel);
	struct network_game_client *client;

	if (team == 0 || team == 1)
	{
		client = global_network_game_client_get();
		if (client && network_game_client_get_state(client, NULL) == _network_client_pregame)
			network_game_client_set_team((char)team);
	}

	team = atomic_exchange_explicit(&web_online_requested_team_switch, -1, memory_order_acq_rel);
	if (team != 0 && team != 1)
		return;
	client = global_network_game_client_get();
	if (!client || network_game_client_get_state(client, NULL) != _network_client_ingame)
		return;
	network_game_client_request_team_switch((char)team);
}

static void apply_requested_player_customization(void)
{
	int i;
	unsigned int sequence;
	unsigned int committed_sequence;
	struct web_online_player_profile profile;

	sequence = atomic_load_explicit(
		&web_online_customization_sequence,
		memory_order_acquire);
	if ((sequence & 1) || sequence == web_online_applied_customization_sequence)
		return;

	player_ui_get_active_player_profile(0, &profile);
	for (i = 0; i < WEB_ONLINE_PLAYER_NAME_CHARACTERS; i++)
	{
		profile.player_name[i] = (unsigned short)atomic_load_explicit(
			&web_online_requested_name[i],
			memory_order_relaxed);
	}
	profile.player_name[WEB_ONLINE_PLAYER_NAME_CHARACTERS] = 0;
	profile.primary_color_index = (short)atomic_load_explicit(
		&web_online_requested_color,
		memory_order_relaxed);
	committed_sequence = atomic_load_explicit(
		&web_online_customization_sequence,
		memory_order_acquire);
	if (sequence != committed_sequence)
		return;
	player_ui_set_active_player_profile(
		0,
		player_ui_get_active_player_profile_index(0),
		&profile);
	web_online_applied_customization_sequence = sequence;
}

static void clear_multiplayer_joins_and_restore_customization(void)
{
	/* Halo's stock clear also replaces every active player profile with an
	 * unnamed, colour-less default.  Browser hosting/joining deliberately
	 * bypasses the profile picker, so restore the identity the browser posted
	 * before network_game_client_add_player() serializes that profile.  Without
	 * this, the server sees an empty name/NONE colour and assigns random values
	 * such as "Howard" instead. */
	player_ui_clear_multiplayer_joins();
	web_online_applied_customization_sequence = 0;
	apply_requested_player_customization();
}

static void reset_owned_game(void)
{
	/* This mirrors the stock network-game cancel handlers.  Closing the old
	widgets first prevents them from observing the disposed client/server on
	the remainder of this frame. */
	ui_widgets_close_all();
	dispose_global_network_game_server();
	dispose_global_network_game_client();
	network_game_accept_remote_connections(WEB_FALSE);
	player_ui_clear_multiplayer_joins();
	player_ui_clear_multiplayer_variant();
	game_connection_set(_game_connection_local);
	main_goto_main_menu();
}

static void clear_session(void)
{
	memset(&web_online, 0, sizeof(web_online));
	/* a closed room must not end the next match it hosts, or move its teams */
	atomic_store_explicit(&web_online_requested_end, 0, memory_order_release);
	atomic_store_explicit(&web_online_requested_team, -1, memory_order_release);
	atomic_store_explicit(&web_online_requested_team_switch, -1, memory_order_release);
}

static void fail_session(int error)
{
	platform_log("web online: session failed (%d)", error);
	if (web_online.setup)
		reset_owned_game();
	clear_session();
	publish_error(error);
	publish_state(_web_online_state_error);
}

static void begin_request(int command, int map_index, int mode_index)
{
	platform_log("web online: request %s", command == _web_online_command_host ? "host" : "join");
	if (web_online.command || web_online.setup)
	{
		reset_owned_game();
		clear_session();
		/* main_menu_load() runs near the beginning of the next frame. */
		web_online.wait_frames = 1;
	}
	web_online.command = command;
	web_online.host_map_index = map_index;
	web_online.host_mode_index = mode_index;
	publish_error(_web_online_error_none);
	publish_state(_web_online_state_waiting_for_main_menu);
}

static void cancel_request(void)
{
	if (web_online.command || web_online.setup)
		reset_owned_game();
	clear_session();
	publish_error(_web_online_error_none);
	publish_state(_web_online_state_idle);
}

static void setup_host(void)
{
	platform_log("web online: opening host lobby");
	clear_multiplayer_joins_and_restore_customization();
	player_ui_clear_multiplayer_variant();
	publish_state(_web_online_state_host_starting);
	player_ui_fast_setup_network_server();
	web_online.setup = WEB_TRUE;
	if (!global_network_game_server_get() || !global_network_game_client_get())
	{
		fail_session(_web_online_error_host_setup_failed);
		return;
	}
	if (!player_ui_configure_network_server_game(
		web_online.host_map_index,
		web_online.host_mode_index))
	{
		fail_session(_web_online_error_host_setup_failed);
		return;
	}
	platform_log("web online: host lobby ready");
	publish_state(_web_online_state_hosting);
}

static void setup_join(void)
{
	platform_log("web online: opening join client");
	dispose_global_network_game_client();
	dispose_global_network_game_server();
	network_game_accept_remote_connections(WEB_FALSE);
	clear_multiplayer_joins_and_restore_customization();
	player_ui_clear_multiplayer_variant();
	web_online.setup = WEB_TRUE;
	if (!create_global_network_game_client())
	{
		fail_session(_web_online_error_client_setup_failed);
		return;
	}
	game_connection_set(_game_connection_network_client);
	publish_state(_web_online_state_join_searching);
}

static void add_primary_player_when_ready(
	struct network_game_client *client,
	float seconds)
{
	if (!client || web_online.player_added)
		return;
	if (network_game_client_has_local_player(client, 0))
	{
		web_online.player_added = WEB_TRUE;
		platform_log("web online: primary player confirmed");
		return;
	}

	web_online.player_retry_seconds += seconds;
	if (!web_online.player_request_sent ||
		web_online.player_retry_seconds >= WEB_ONLINE_PLAYER_RETRY_SECONDS)
	{
		if (network_game_client_add_player(client, 0))
		{
			platform_log("web online: %s primary player",
				web_online.player_request_sent ? "retrying" : "requesting");
			web_online.player_request_sent = WEB_TRUE;
		}
		web_online.player_retry_seconds = 0.0f;
	}
}

/* debug.test_players (with debug.test_input, port/linux/src/xinput_sdl.c):
the lab's split screen players, one for each scripted controller after the
first, once the first's player is in */
static void add_test_players_when_ready(
	struct network_game_client *client,
	float seconds)
{
	static float retry_seconds = WEB_ONLINE_PLAYER_RETRY_SECONDS;
	long players = config_integer("debug.test_players");
	short controller;

	if (players <= 1 || !client || !network_game_client_has_local_player(client, 0))
		return;
	retry_seconds += seconds;
	if (retry_seconds < WEB_ONLINE_PLAYER_RETRY_SECONDS)
		return;
	retry_seconds = 0.0f;
	for (controller = 1; controller < players && controller < 4; controller++)
	{
		if (!network_game_client_has_local_player(client, controller) &&
			network_game_client_add_player(client, controller))
		{
			platform_log("web online: requesting test player %d", (int)controller);
		}
	}
}

static void update_host(float seconds)
{
	struct network_game_client *client = global_network_game_client_get();

	if (!global_network_game_server_get() || !client)
	{
		/* Backing out through Halo's own UI ends the browser room cleanly. */
		clear_session();
		publish_error(_web_online_error_none);
		publish_state(_web_online_state_idle);
		return;
	}
	web_online.seconds += seconds;
	if (web_online.seconds >= 0.5f)
	{
		add_primary_player_when_ready(client, seconds);
		add_test_players_when_ready(client, seconds);
	}
	publish_state(_web_online_state_hosting);
}

static int load_join_pregame_screen(void)
{
	ui_widgets_close_all();
	return ui_widget_load_by_name_or_tag(
		"ui\\shell\\main_menu\\multiplayer_type_select\\connected\\pregame\\connected_pregame_screen",
		WEB_NONE, NULL, WEB_NONE, WEB_NONE, WEB_NONE, WEB_NONE) != NULL;
}

static void update_join(float seconds)
{
	struct network_game_client *client = global_network_game_client_get();
	short client_state;

	web_online.seconds += seconds;
	if (web_online.seconds >= WEB_ONLINE_JOIN_TIMEOUT_SECONDS && !web_online.join_completed)
	{
		fail_session(_web_online_error_join_timed_out);
		return;
	}
	if (!client)
	{
		/* Halo's Back action disposes the client before the browser receives a
		 * cancel command. Treat that local UI action as a clean room exit. */
		clear_session();
		publish_error(_web_online_error_none);
		publish_state(_web_online_state_idle);
		return;
	}
	if (network_game_client_get_error(client) != 0)
	{
		fail_session(_web_online_error_join_failed);
		return;
	}

	client_state = network_game_client_get_state(client, NULL);
	if (!web_online.join_attempted && client_state == _network_client_searching)
	{
		if (network_game_client_join_first_available_game())
		{
			web_online.join_attempted = WEB_TRUE;
			if (!load_join_pregame_screen())
			{
				fail_session(_web_online_error_pregame_screen_failed);
				return;
			}
			web_online.pregame_screen_loaded = WEB_TRUE;
			publish_state(_web_online_state_join_connecting);
		}
		else
		{
			publish_state(_web_online_state_join_searching);
		}
		return;
	}

	if (client_state == _network_client_joining)
	{
		publish_state(_web_online_state_join_connecting);
		return;
	}
	if (client_state == _network_client_pregame ||
		client_state == _network_client_ingame ||
		client_state == _network_client_postgame)
	{
		/* (a spectator joins without a player: Join adds it later) */
		if (!web_online.player_added && network_game_spectating())
		{
			web_online.player_added = WEB_TRUE;
			platform_log("web online: joining as a spectator, without a player");
		}
		add_primary_player_when_ready(client, seconds);
		if (!web_online.player_added)
		{
			publish_state(_web_online_state_join_connecting);
			return;
		}
		add_test_players_when_ready(client, seconds);
		web_online.join_completed = WEB_TRUE;
		if (!web_online.pregame_screen_loaded && client_state == _network_client_pregame)
		{
			if (!load_join_pregame_screen())
			{
				fail_session(_web_online_error_pregame_screen_failed);
				return;
			}
			web_online.pregame_screen_loaded = WEB_TRUE;
		}
		publish_state(_web_online_state_joined);
		return;
	}

	/* A rejected or disconnected join returns the client to searching. */
	if (web_online.join_attempted && client_state == _network_client_searching)
		fail_session(_web_online_error_join_failed);
}

void web_online_ui_update(int main_menu_loaded, float seconds)
{
	int join_in_progress = atomic_exchange_explicit(
		&web_online_requested_join_in_progress, -1, memory_order_acq_rel);
	int request;

	/* The lobby's red/blue choice, and the roster every machine is showing.
	   Both run whether or not a browser session is opening: a team click only
	   lands in pregame, and an idle client publishes an empty roster. */
	apply_team_request();
	publish_lobby_roster();

	if (join_in_progress >= 0 && config_boolean("network.join_in_progress") != join_in_progress)
	{
		config_write_boolean("network.join_in_progress", join_in_progress);
		platform_log("web online: joining a match in progress %s", join_in_progress ? "on" : "off");
	}
	{
		int spectate = atomic_exchange_explicit(&web_online_requested_spectate, -1, memory_order_acq_rel);

		if (spectate >= 0 && (spectate != 0) != (network_game_spectating() != 0))
		{
			network_game_set_spectating(spectate ? 1 : 0);
			platform_log("web online: %s", spectate ? "spectating" : "joining with a player after watching");
			/* (a spectator in a match or its lobby: its player is added
			as a late joiner's is) */
			if (!spectate && web_online.command == _web_online_command_join && web_online.player_added &&
				local_player_count() == 0)
			{
				web_online.player_added = WEB_FALSE;
				web_online.player_request_sent = WEB_FALSE;
				web_online.player_retry_seconds = 0.0f;
			}
		}
		atomic_store_explicit(&web_online_spectating,
			web_online.command == _web_online_command_join && network_game_spectating() && local_player_count() == 0,
			memory_order_release);
	}
	{
		/* (the watched player's name, for the page's label) */
		int index;
		int ended = 0;

		for (index = 0; index < WEB_ONLINE_SPECTATE_NAME_CHARACTERS; index++)
		{
			int character = ended ? 0 : spectator_target_name_character(index);

			ended = ended || !character;
			atomic_store_explicit(&web_online_spectate_name[index], character, memory_order_release);
		}
	}
	atomic_store_explicit(&web_online_match_joinable,
		global_network_game_server_get() &&
			network_game_server_joinable_in_game(global_network_game_server_get()) ? 1 : 0,
		memory_order_release);
	atomic_store_explicit(&web_online_match_watchable,
		global_network_game_server_get() &&
			network_game_server_watchable_in_game(global_network_game_server_get()) ? 1 : 0,
		memory_order_release);
	atomic_store_explicit(&web_online_match_starting,
		global_network_game_server_get() &&
			(network_game_server_match_starting(global_network_game_server_get()) ||
				web_online.start_requested) ? 1 : 0,
		memory_order_release);
	request = atomic_exchange_explicit(
		&web_online_requested_request,
		_web_online_command_none,
		memory_order_acq_rel);
	int command = request & WEB_ONLINE_REQUEST_COMMAND_MASK;
	int map_index = (request >> WEB_ONLINE_REQUEST_MAP_SHIFT) & 0xff;
	int mode_index = (request >> WEB_ONLINE_REQUEST_MODE_SHIFT) & 0xff;

	/* Browser calls only publish atomics.  Apply the selected identity here,
	 * before host/join can build its network_player from the active profile. */
	apply_requested_player_customization();

	if (command == _web_online_command_cancel)
	{
		cancel_request();
		return;
	}
	if (command == _web_online_command_host || command == _web_online_command_join)
		begin_request(command, map_index, mode_index);

	/* (the host) end the match, once: the same call a score or time limit
	makes (and debug.network_test_end). A request outside a running match,
	or from a machine that is not hosting, is dropped. */
	if (atomic_exchange_explicit(&web_online_requested_end, 0, memory_order_acq_rel))
	{
		struct network_game_client *end_client = global_network_game_client_get();

		if (web_online.command == _web_online_command_host && web_online.setup &&
			global_network_game_server_get() && end_client &&
			network_game_client_get_state(end_client, NULL) == _network_client_ingame &&
			game_connection() == _game_connection_network_server &&
			game_engine_running())
		{
			platform_log("web online: the host ends the match");
			game_engine_end_game();
		}
	}

	if (!web_online.command)
		return;
	if (web_online.wait_frames > 0)
	{
		web_online.wait_frames--;
		return;
	}
	if (!web_online.setup)
	{
		if (!main_menu_loaded)
		{
			publish_state(_web_online_state_waiting_for_main_menu);
			return;
		}
		if (web_online.command == _web_online_command_host)
			setup_host();
		else
			setup_join();
		return;
	}

	if (web_online.command == _web_online_command_host)
	{
		int configuration = atomic_exchange_explicit(
			&web_online_requested_configuration, 0, memory_order_acq_rel);
		struct network_game_client *client = global_network_game_client_get();

		if (configuration && global_network_game_server_get() && client &&
			network_game_client_get_state(client, NULL) == _network_client_pregame)
		{
			int map_index = (configuration >> WEB_ONLINE_REQUEST_MAP_SHIFT) & 0xff;
			int mode_index = (configuration >> WEB_ONLINE_REQUEST_MODE_SHIFT) & 0xff;

			if (player_ui_configure_network_server_game(map_index, mode_index))
			{
				web_online.host_map_index = map_index;
				web_online.host_mode_index = mode_index;
				platform_log("web online: next match %d/%d", map_index, mode_index);
			}
		}
		if (atomic_exchange_explicit(&web_online_requested_start, 0, memory_order_acq_rel) &&
			global_network_game_server_get() && client &&
			network_game_client_get_state(client, NULL) == _network_client_pregame)
		{
			/* (after a match Halo's own map select pauses the countdown until
			the host leaves it; the page's picker stands in for it) */
			platform_log("web online: starting the match");
			network_game_server_pause_countdown(global_network_game_server_get(), WEB_FALSE);
			network_game_client_request_start_time_change(client, WEB_TRUE);
			web_online.start_requested = WEB_TRUE;
			web_online.start_retry_seconds = 0.0f;
		}
		if (!client || network_game_client_get_state(client, NULL) != _network_client_pregame ||
			!global_network_game_server_get() ||
			network_game_server_match_starting(global_network_game_server_get()))
		{
			web_online.start_requested = WEB_FALSE;
		}
		else if (web_online.start_requested &&
			!network_game_server_countdown_active(global_network_game_server_get()))
		{
			/* a machine that came into the lobby meanwhile stopped the
			countdown (Halo stops it while a machine has no player yet):
			once a second, start it again, as the host would press A */
			web_online.start_retry_seconds += seconds;
			if (web_online.start_retry_seconds >= 1.0f)
			{
				web_online.start_retry_seconds = 0.0f;
				network_game_server_pause_countdown(global_network_game_server_get(), WEB_FALSE);
				network_game_client_request_start_time_change(client, WEB_TRUE);
			}
		}
		update_host(seconds);
	}
	else
		update_join(seconds);
}
