/* Drives port/web/src/web_online_ui.c: the host's End match mailbox calls
   game_engine_end_game only while a match is running, and never disposes
   the server. A guest, the lobby, and a closed room do not. The host's
   Start match counts the lobby down from about five seconds (not Halo's own
   start: thirty, or five off), again while a machine coming in stops it;
   and a page with its own picker takes the next match from Halo's. */

#include "web_online_ui.h"

#include <stdio.h>

int platform_web_online_end_match(void);
int platform_web_online_start_match(void);
void platform_web_online_set_page_picker(int enabled);
int web_online_ui_page_picks_next_match(void);
int platform_web_online_host_configured(int map_index, int mode_index);
int platform_web_online_request(int command);
int platform_web_online_get_state(void);
void web_online_ui_update(int main_menu_loaded, float seconds);

struct network_game_server;
struct network_game_client;

static int failures;
static int server_on = 1;
static int client_on = 1;
static short client_state = 2; /* pregame */
static short connection = 0;
static int engine_running;
static int end_calls;
static int dispose_server_calls;
static int dispose_client_calls;
static int start_calls;
static long start_milliseconds;
static int unpause_calls;
static char server_object;
static char client_object;

static void expect(int condition, const char *message)
{
	if (!condition)
	{
		fprintf(stderr, "FAIL: %s\n", message);
		failures++;
	}
}

static void frame(void)
{
	web_online_ui_update(1, 0.1f);
}

void ui_widgets_close_all(void) {}
struct widget_instance;
struct widget_instance *ui_widget_load_by_name_or_tag(
	const char *name, long tag_index, struct widget_instance *parent,
	short local_player_index, long invoking_widget_tag,
	long focused_child_parent_widget_tag, short focused_child_index)
{
	(void)name; (void)tag_index; (void)parent; (void)local_player_index;
	(void)invoking_widget_tag; (void)focused_child_parent_widget_tag;
	(void)focused_child_index;
	return 0;
}
void dispose_global_network_game_server(void) { dispose_server_calls++; }
void dispose_global_network_game_client(void) { dispose_client_calls++; }
struct network_game_server *global_network_game_server_get(void)
{
	return server_on ? (struct network_game_server *)&server_object : 0;
}
struct network_game_client *global_network_game_client_get(void)
{
	return client_on ? (struct network_game_client *)&client_object : 0;
}
unsigned char create_global_network_game_client(void) { return 1; }
void network_game_accept_remote_connections(unsigned char accept) { (void)accept; }
void player_ui_clear_multiplayer_joins(void) {}
void player_ui_clear_multiplayer_variant(void) {}
void player_ui_fast_setup_network_server(void) { connection = 2; }
long player_ui_get_active_player_profile_index(short local_player_index)
{
	(void)local_player_index;
	return 0;
}
void player_ui_get_active_player_profile(short local_player_index, void *profile)
{
	(void)local_player_index;
	(void)profile;
}
void player_ui_set_active_player_profile(short local_player_index, long profile_index, void *profile)
{
	(void)local_player_index;
	(void)profile_index;
	(void)profile;
}
unsigned char player_ui_configure_network_server_game(long map_index, long mode_index)
{
	(void)map_index;
	(void)mode_index;
	return 1;
}
void game_connection_set(short value) { connection = value; }
void main_goto_main_menu(void) {}
short network_game_client_get_state(struct network_game_client *client, short *state_data)
{
	(void)client;
	(void)state_data;
	return client_state;
}
unsigned char network_game_client_request_start_time_change(struct network_game_client *client, short request_type)
{
	(void)client;
	(void)request_type;
	return 1;
}
void network_game_server_pause_countdown(struct network_game_server *server, unsigned char pause)
{
	(void)server;
	if (!pause)
		unpause_calls++;
}
unsigned char network_game_server_start_countdown_within(struct network_game_server *server, long milliseconds)
{
	(void)server;
	start_calls++;
	start_milliseconds = milliseconds;
	return 1;
}
short network_game_client_get_error(struct network_game_client *client)
{
	(void)client;
	return 0;
}
unsigned char network_game_client_join_first_available_game(void) { return 0; }
unsigned char network_game_client_add_player(struct network_game_client *client, short controller_index)
{
	(void)client;
	(void)controller_index;
	return 1;
}
unsigned char network_game_client_has_local_player(struct network_game_client *client, short local_player_index)
{
	(void)client;
	(void)local_player_index;
	return 1;
}
unsigned char network_game_server_joinable_in_game(struct network_game_server *server)
{
	(void)server;
	return 0;
}
unsigned char network_game_server_watchable_in_game(struct network_game_server *server)
{
	(void)server;
	return 0;
}
unsigned char network_game_server_match_starting(struct network_game_server *server)
{
	(void)server;
	return 0;
}
unsigned char network_game_server_countdown_active(struct network_game_server *server)
{
	(void)server;
	return 0;
}
int config_boolean(const char *name)
{
	(void)name;
	return 0;
}
long config_integer(const char *name)
{
	(void)name;
	return 0;
}
int config_write_boolean(const char *name, int value)
{
	(void)name;
	(void)value;
	return 1;
}
void network_game_set_spectating(unsigned char spectating) { (void)spectating; }
unsigned char network_game_spectating(void) { return 0; }
short local_player_count(void) { return 1; }
void spectator_request_cycle(short direction) { (void)direction; }
int spectator_target_name_character(int index)
{
	(void)index;
	return 0;
}
void platform_log(const char *format, ...) { (void)format; }
unsigned char game_engine_running(void) { return engine_running ? 1 : 0; }
void game_engine_end_game(void) { end_calls++; }
short game_connection(void) { return connection; }
/* The lobby roster publish stops at the first out-of-range slot. */
int network_game_client_roster_slot(int index, int *name, int *team, int *local)
{
	(void)name;
	(void)team;
	(void)local;
	return index < 0 || index >= 16 ? -1 : 0;
}
int network_game_client_game_has_teams(void) { return 0; }
unsigned char network_game_client_set_team(char team_index)
{
	(void)team_index;
	return 0;
}
unsigned char network_game_client_request_team_switch(char team_index)
{
	(void)team_index;
	return 0;
}
unsigned char network_game_client_team_switch_allowed(char team_index)
{
	(void)team_index;
	return 0;
}

int main(void)
{
	int disposed;
	int ends;

	expect(platform_web_online_host_configured(0, 0) == 1, "host request accepted");
	frame();
	expect(platform_web_online_get_state() == _web_online_state_hosting, "lobby is up");

	expect(!web_online_ui_page_picks_next_match(), "Halo picks the next match unless the page says it does");
	platform_web_online_set_page_picker(1);
	expect(web_online_ui_page_picks_next_match(), "the hosting page picks the next match");
	expect(platform_web_online_start_match() == 1, "start request accepted");
	frame();
	expect(start_calls == 1 && start_milliseconds == 5999, "Start match counts down from about five seconds");
	expect(unpause_calls == 1, "Start match lifts the pause Halo's map select (or the next match's lobby) sets");
	{
		int index;

		for (index = 0; index < 12; index++)
			frame();
	}
	expect(start_calls == 2, "a countdown a machine coming in stopped starts again a second later");
	client_state = 3;
	frame();
	client_state = 2;
	{
		int index;

		for (index = 0; index < 12; index++)
			frame();
	}
	expect(start_calls == 2, "once the match has started, the request is over");

	engine_running = 0;
	client_state = 2;
	expect(platform_web_online_end_match() == 1, "end request accepted");
	frame();
	expect(end_calls == 0, "the lobby ignores end match");
	expect(platform_web_online_get_state() == _web_online_state_hosting, "the lobby stays up");

	disposed = dispose_server_calls;
	client_state = 3;
	engine_running = 1;
	connection = 2;
	expect(platform_web_online_end_match() == 1, "end request accepted in a match");
	frame();
	expect(end_calls == 1, "a running match ends through game_engine_end_game");
	expect(dispose_server_calls == disposed, "ending a match does not dispose the server");
	expect(dispose_client_calls == 0, "ending a match does not dispose the client");
	expect(platform_web_online_get_state() == _web_online_state_hosting, "the room stays in the session");
	frame();
	expect(end_calls == 1, "one request ends the match once");

	connection = 1;
	platform_web_online_end_match();
	frame();
	expect(end_calls == 1, "a machine that is not the network server does not end it");
	connection = 2;

	engine_running = 0;
	platform_web_online_end_match();
	frame();
	expect(end_calls == 1, "end match waits until the game engine is running");

	engine_running = 1;
	client_state = 4;
	platform_web_online_end_match();
	frame();
	expect(end_calls == 1, "postgame is already the results");

	client_state = 3;
	platform_web_online_end_match();
	frame();
	expect(end_calls == 2, "a later running match can be ended again");

	platform_web_online_end_match();
	expect(platform_web_online_request(3) == 1, "cancel accepted");
	frame();
	expect(end_calls == 2, "closing the room drops a pending end");
	expect(platform_web_online_get_state() == _web_online_state_idle, "the room closed");
	expect(!web_online_ui_page_picks_next_match(), "a closed room hosts nothing");

	ends = end_calls;
	expect(platform_web_online_host_configured(0, 0) == 1, "host again");
	frame();
	client_state = 3;
	engine_running = 1;
	frame();
	expect(end_calls == ends, "the next match does not end on its own");
	expect(platform_web_online_get_state() == _web_online_state_hosting, "the new room is hosting");

	expect(platform_web_online_request(3) == 1, "cancel before joining");
	frame();
	expect(platform_web_online_request(2) == 1, "join accepted");
	frame();
	client_state = 3;
	engine_running = 1;
	platform_web_online_end_match();
	frame();
	expect(end_calls == ends, "a guest cannot end the match");

	if (failures)
	{
		fprintf(stderr, "%d end-match checks failed\n", failures);
		return 1;
	}
	printf("web online end match tests passed\n");
	return 0;
}
