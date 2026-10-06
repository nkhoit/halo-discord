/*
NETWORK_CLIENT_MANAGER.H

header included in hcex build.
*/

#ifndef __NETWORK_CLIENT_MANAGER_H
#define __NETWORK_CLIENT_MANAGER_H
#pragma once

/* ---------- constants */

/* ---------- macros */

/* ---------- structures */

struct network_advertised_game;
struct network_connection;
struct network_game;
struct network_game_client;
struct network_join_parameters;
struct network_machine;
struct network_player;
struct transport_address;
struct message_server_game_advertise;
struct message_server_machine_accepted;
struct message_server_game_update;

/* ---------- prototypes/NETWORK_CLIENT_MANAGER.C */

void network_game_client_dispose(
	struct network_game_client *client);
void network_game_client_keep_alive(
	struct network_game_client *client);
short network_game_client_get_state(
	struct network_game_client *client,
	short *state_data);
#ifdef HALO_LINUX
boolean network_game_client_join_first_available_game(
	void);
boolean network_game_client_has_local_player(
	struct network_game_client *client,
	short local_player_index);
boolean network_game_client_set_team(
	char team_index);
/* One slot of the client's game roster for the lobby team picker.
   Returns 1 when the slot holds a player, 0 when it is empty, and -1 when
   index is out of range or there is no client. name receives 12 code units
   (0 ends the name). *team is 0 red, 1 blue, or -1. *local is 1 for a player
   on this machine. */
int network_game_client_roster_slot(
	int index,
	int *name,
	int *team,
	int *local);
int network_game_client_game_has_teams(
	void);
/* Mid-match (#16): ask the host to move this machine's players to red (0) or
   blue (1). Pregame still uses network_game_client_set_team. Returns FALSE
   outside an in-progress distributed team game. */
boolean network_game_client_request_team_switch(
	char team_index);
/* 1 when this machine's local player may move onto team_index mid-match. */
boolean network_game_client_team_switch_allowed(
	char team_index);
/* Whether moving from from_team onto to_team is allowed: only onto a team
   with strictly fewer players (3v1 -> 2v2 yes, 2v2 -> 1v3 no). */
boolean network_game_team_switch_balance_ok(
	struct network_game *game,
	char from_team,
	char to_team);
/* Apply an authoritative team change to a network_game copy and the live
   player_datum. kill_unit: the host's game only, once (without statistics, so
   a flag or ball drops); every client copy updates the teams only. FALSE when
   the game has no such player. */
boolean network_game_apply_team_switch(
	struct network_game *game,
	char player_list_index,
	char team_index,
	boolean kill_unit);
#endif
boolean network_game_client_initiate_join_game(
	struct network_game_client *client,
	struct network_advertised_game *game,
	struct network_join_parameters *join_parameters,
	struct transport_address *address);
boolean network_game_client_set_machine(
	struct network_game_client *client,
	struct network_machine *machine);
struct network_machine *network_game_client_get_machine(
	struct network_game_client *client);
short network_game_client_get_machine_index(
	struct network_game_client *client);
boolean network_game_client_advertised_game_is_valid(
	struct network_advertised_game *advertised_game);
struct network_advertised_game *network_game_client_get_available_games(
	struct network_game_client *client);
short network_game_client_get_error(
	struct network_game_client *client);
short network_game_client_get_seconds_to_game_start(
	struct network_game_client *client);
boolean network_game_client_write(
	struct network_connection *connection,
	word *message,
	word message_size,
	struct transport_address *address,
	boolean reliable);
boolean network_game_client_idle(
	struct network_game_client *client);
boolean network_game_client_add_player(
	struct network_game_client *client,
	short local_player_index);
boolean network_game_client_address_matches_server(
	struct network_game_client *client,
	struct transport_address *address);
void network_game_client_new_advertised_game(
	struct network_game_client *client,
	struct message_server_game_advertise *message_packet);
void network_game_client_ponged(
	struct network_game_client *client,
	struct transport_address *source_address,
	long timestamp);
void network_game_client_accepted_into_game(
	struct network_game_client *client,
	struct transport_address *source_address,
	struct message_server_machine_accepted *message_packet);
void network_game_client_rejected_by_game(
	struct network_game_client *client,
	struct transport_address *source_address,
	word rejection_code);
boolean network_game_client_game_settings_updated(
	struct network_game_client *client,
	struct network_game *message_packet);
void network_game_client_countdown_timer_update(
	struct network_game_client *client,
	short seconds_to_game_start);
boolean network_game_client_game_has_started(
	struct network_game_client *client);
void network_game_client_game_shutdown(
	struct network_game_client *client);
boolean network_game_client_handle_game_update(
	struct network_game_client *client,
	struct message_server_game_update *game_update);
void network_game_client_game_out_of_sync(
	struct network_game_client *client);
boolean network_game_client_add_player_to_game(
	struct network_game_client *client,
	struct network_player *player);
boolean network_game_client_remove_player(
	struct network_game_client *client,
	struct network_player *player,
	long reason);
boolean network_game_client_update_local_player_data(
	struct network_game_client *client,
	struct network_player *player);
boolean network_game_client_request_remove_player(
	struct network_game_client *client,
	struct network_player *player);
boolean network_game_client_request_start_time_change(
	struct network_game_client *client,
	short request_type);
boolean network_game_client_leave_game(
	struct network_game_client *client);
void network_game_client_switch_to_postgame(
	struct network_game_client *client);
boolean network_game_client_switch_to_pregame(
	struct network_game_client *client);
void network_game_client_reset(
	struct network_game_client *client,
	boolean teardown_connection);
struct network_game_client *network_game_client_create(
	void);
struct network_connection *network_game_client_get_connection(
	struct network_game_client *client);
void network_game_client_get_remote_server_address(
	struct network_game_client *client,
	struct transport_address *address);
struct network_game *network_game_client_get_game(
	struct network_game_client *client);
boolean network_game_client_server_has_started_game(
	struct network_game_client *client);
long network_game_client_get_next_update_number(
	struct network_game_client *client);
boolean network_client_get_oos(
	struct network_game_client *client);
long unstrip_player_index(
	long player_index);

/* ---------- globals */

extern boolean allow_out_of_sync;
extern boolean network_game_client_dont_use_directly_in_use;
extern struct network_game_client network_game_client_dont_use_directly;

/* ---------- public code */

#endif // __NETWORK_CLIENT_MANAGER_H
