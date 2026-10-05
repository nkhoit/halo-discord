/* Drives port/web/src/web_online_ui.c: a team choice is queued only in
   pregame, applied on the game thread, and dropped if the match has
   started. The roster snapshot skips empty slots and stays consistent. */

#include "web_online_ui.h"

#include <stdio.h>

int platform_web_online_set_team(int team_index);
int platform_web_online_switch_team(int team_index);
int platform_web_online_team_switch_allowed(int team_index);
int platform_web_online_roster_sequence(void);
int platform_web_online_roster_count(void);
int platform_web_online_roster_teams(void);
int platform_web_online_roster_team(int index);
int platform_web_online_roster_local(int index);
int platform_web_online_roster_name(int index, int unit);
void web_online_ui_update(int main_menu_loaded, float seconds);

struct network_game_server;
struct network_game_client;

static int failures;
static int server_on = 1;
static int client_on = 1;
static short client_state = 2; /* pregame */
static int has_teams = 1;
static int set_team_calls;
static char set_team_value;
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

static void write_name(int *name, const char *label)
{
	int unit;
	int ended = 0;

	for (unit = 0; unit < 12; unit++)
	{
		unsigned char code = 0;

		if (!ended)
		{
			code = (unsigned char)label[unit];
			if (!code)
				ended = 1;
		}
		name[unit] = (int)code;
	}
}

static int name_is(int index, const char *label)
{
	int unit;

	for (unit = 0; label[unit]; unit++)
	{
		if (platform_web_online_roster_name(index, unit) != (unsigned char)label[unit])
			return 0;
	}
	return platform_web_online_roster_name(index, unit) == 0;
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
void dispose_global_network_game_server(void) {}
void dispose_global_network_game_client(void) {}
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
void player_ui_fast_setup_network_server(void) {}
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
void game_connection_set(short value) { (void)value; }
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
	(void)pause;
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
unsigned char game_engine_running(void) { return 0; }
void game_engine_end_game(void) {}
short game_connection(void) { return 0; }

/* Slot 1 is empty. Slots 0 and 2 are Red (local) and Blue. Past 8 is out of range. */
int network_game_client_roster_slot(int index, int *name, int *team, int *local)
{
	if (!name || !team || !local || index < 0 || index >= 8)
		return -1;
	if (index == 0)
	{
		write_name(name, "Red");
		*team = 0;
		*local = 1;
		return 1;
	}
	if (index == 2)
	{
		write_name(name, "Blue");
		*team = 1;
		*local = 0;
		return 1;
	}
	return 0;
}

int network_game_client_game_has_teams(void) { return has_teams; }

unsigned char network_game_client_set_team(char team_index)
{
	set_team_calls++;
	set_team_value = team_index;
	return 1;
}

static int switch_team_calls;
static char switch_team_value;

unsigned char network_game_client_request_team_switch(char team_index)
{
	switch_team_calls++;
	switch_team_value = team_index;
	return 1;
}

unsigned char network_game_client_team_switch_allowed(char team_index)
{
	(void)team_index;
	return 0;
}

int main(void)
{
	int calls;

	frame();
	expect((platform_web_online_roster_sequence() & 1) == 0, "a published roster has an even sequence");
	expect(platform_web_online_roster_count() == 2, "an empty slot is skipped");
	expect(platform_web_online_roster_teams() == 1, "the variant has teams");
	expect(platform_web_online_roster_team(0) == 0, "the first player is red");
	expect(platform_web_online_roster_local(0) == 1, "the first player is local");
	expect(name_is(0, "Red"), "the first player's name");
	expect(platform_web_online_roster_team(1) == 1, "the second player is blue");
	expect(platform_web_online_roster_local(1) == 0, "the second player is someone else");
	expect(name_is(1, "Blue"), "the second player's name");
	expect(platform_web_online_roster_team(-1) == -1, "a team before the roster is out of range");
	expect(platform_web_online_roster_team(32) == -1, "a team past the roster is out of range");
	expect(platform_web_online_roster_local(-1) == 0, "a local flag before the roster is out of range");
	expect(platform_web_online_roster_name(0, 12) == 0, "a name unit past the name is empty");

	has_teams = 0;
	frame();
	expect(platform_web_online_roster_teams() == 0, "a free-for-all publishes no teams");
	expect((platform_web_online_roster_sequence() & 1) == 0, "the sequence stays even");
	has_teams = 1;

	expect(platform_web_online_set_team(-1) == 0, "a missing team is refused");
	expect(platform_web_online_set_team(2) == 0, "a team other than red or blue is refused");
	frame();
	expect(set_team_calls == 0, "a refused team is not applied");

	client_state = 3;
	expect(platform_web_online_set_team(1) == 0, "a match refuses a team change");
	frame();
	expect(set_team_calls == 0, "a match does not apply a team change");

	client_state = 4;
	expect(platform_web_online_set_team(0) == 0, "the results refuse a team change");
	frame();
	expect(set_team_calls == 0, "the results do not apply a team change");

	client_on = 0;
	client_state = 2;
	expect(platform_web_online_set_team(1) == 0, "no client, no team change");
	client_on = 1;
	frame();
	expect(set_team_calls == 0, "a refused request was not left queued");

	expect(platform_web_online_set_team(0) == 1, "red is accepted in pregame");
	expect(platform_web_online_set_team(1) == 1, "the last click wins");
	frame();
	expect(set_team_calls == 1, "one frame applies one choice");
	expect(set_team_value == 1, "the applied choice is blue");
	frame();
	expect(set_team_calls == 1, "the choice is applied once");

	calls = set_team_calls;
	expect(platform_web_online_set_team(0) == 1, "queued while still in pregame");
	client_state = 3;
	frame();
	expect(set_team_calls == calls, "a choice queued in pregame is dropped once the match starts");
	client_state = 2;
	frame();
	expect(set_team_calls == calls, "a dropped choice does not apply when pregame returns");

	/* Mid-match switch (#16): separate export, applied only while ingame. */
	switch_team_calls = 0;
	expect(platform_web_online_switch_team(1) == 0, "pregame refuses a mid-match switch export");
	frame();
	expect(switch_team_calls == 0, "pregame does not call request_team_switch");

	client_state = 3;
	expect(platform_web_online_switch_team(-1) == 0, "a bad mid-match team is refused");
	expect(platform_web_online_switch_team(2) == 0, "only red or blue mid-match");
	expect(platform_web_online_switch_team(1) == 1, "ingame accepts a mid-match switch");
	expect(platform_web_online_switch_team(0) == 1, "the last mid-match click wins");
	frame();
	expect(switch_team_calls == 1, "one frame applies one mid-match choice");
	expect(switch_team_value == 0, "the applied mid-match choice is red");
	frame();
	expect(switch_team_calls == 1, "the mid-match choice is applied once");

	client_state = 4;
	expect(platform_web_online_switch_team(1) == 0, "postgame refuses a mid-match switch");
	frame();
	expect(switch_team_calls == 1, "postgame does not apply a mid-match switch");

	client_state = 3;
	expect(platform_web_online_set_team(1) == 0, "pregame export still refuses during a match");
	frame();
	expect(set_team_calls == calls, "pregame export still does not apply during a match");

	if (failures)
	{
		fprintf(stderr, "%d team checks failed\n", failures);
		return 1;
	}
	printf("web online team tests passed\n");
	return 0;
}
