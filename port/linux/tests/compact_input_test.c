/* The browser builds' compact input (source/networking/network_messages.c): an
   input the source has quantized comes back from its few bytes exactly, bit for
   bit, so every machine runs the same values; quantizing it again changes
   nothing; what it loses is far below a mouse count; a value outside the
   ranges goes as it is; a malformed message is refused. The functions come
   from the real source (compact_input_test.js extracts them, and checks that
   only the browser builds use them). */
#include <math.h>
#include <stdio.h>
#include <string.h>

typedef int boolean;
typedef float real;
typedef unsigned char byte;
typedef unsigned short word;
typedef struct { real yaw, pitch; } real_euler_angles2d;
typedef struct { real i, j; } real_vector2d;
#define TRUE 1
#define FALSE 0
#define NONE (-1)
#define FLAG(bit) (1u << (bit))
#define TEST_FLAG(flags, bit) (((flags) & FLAG(bit)) != 0)
#define SET_FLAG(flags, bit, value) ((value) ? ((flags) |= FLAG(bit)) : ((flags) &= ~FLAG(bit)))
#define csmemcpy memcpy
#define csmemset memset
#define HALO_PORT_MAXIMUM_NETWORK_PLAYERS 16

#include "compact_input.inc"

/* (the action without its padding) */
#define ACTION_BYTES 30
#define PI 3.14159265358979

static int failures;

static void check(int condition, const char *what)
{
	if (!condition)
	{
		printf("FAIL: %s\n", what);
		failures++;
	}
}

static unsigned long random_state = 12345;

static double random_unit(void)
{
	random_state = random_state * 1103515245u + 12345u;
	return (double)((random_state >> 8) & 0xFFFFFF) / (double)0x1000000;
}

static struct player_action random_action(int index)
{
	struct player_action action;

	memset(&action, 0, sizeof(action));
	action.desired_facing.yaw = (real)(random_unit() * 2.0 * PI);
	action.desired_facing.pitch = (real)((random_unit() - 0.5) * PI);
	action.control_flags = (unsigned int)(random_unit() * 0x8000) & (index % 3 ? 0x7FFF : 0);
	if (index % 4 == 0)
	{
		/* a keyboard's */
		action.throttle.i = (real)((int)(random_unit() * 3) - 1);
		action.throttle.j = (real)((int)(random_unit() * 3) - 1);
	}
	else if (index % 4 == 1)
	{
		/* a stick's */
		action.throttle.i = (real)(random_unit() * 2 - 1);
		action.throttle.j = (real)(random_unit() * 2 - 1);
	}
	action.primary_trigger = index % 5 == 0 ? 1.0f : index % 5 == 1 ? (real)random_unit() : 0.0f;
	action.desired_weapon_index = index % 7 == 0 ? (short)(random_unit() * 4) : NONE;
	action.desired_grenade_index = index % 11 == 0 ? (short)(random_unit() * 2) : NONE;
	action.desired_zoom_level = index % 13 == 0 ? (short)(random_unit() * 2) : NONE;
	return action;
}

static int round_trips(struct player_action const *action, short *size)
{
	byte buffer[COMPACT_INPUT_MAXIMUM_SIZE];
	struct player_action decoded;
	short read;

	*size = compact_input_write(buffer, action);
	read = compact_input_read(buffer, *size, &decoded);
	return read == *size && *size <= COMPACT_INPUT_MAXIMUM_SIZE && memcmp(&decoded, action, ACTION_BYTES) == 0;
}

int main(void)
{
	byte buffer[1200];
	unsigned int bits;
	int index;
	short size;
	double yaw_error = 0;
	double pitch_error = 0;
	double throttle_error = 0;
	double trigger_error = 0;
	int idle_size = 0;
	int moving_size = 0;
	int largest = 0;

	/* every code is its own value's */
	for (bits = 0; bits < 65536; bits++)
	{
		real yaw = compact_input_yaw((word)bits);
		real pitch = compact_input_pitch((word)bits);

		if (compact_input_yaw_bits(yaw) != bits || yaw < 0.0f || yaw >= (real)(2.0 * PI))
		{
			check(0, "every yaw code maps back to itself, within 0 to 2 pi");
			break;
		}
		if (!compact_input_aim_fits(pitch) || compact_input_pitch_bits(pitch) != bits)
		{
			check(0, "every pitch code maps back to itself");
			break;
		}
	}
	for (index = -127; index <= 127; index++)
	{
		check(compact_input_throttle_bits(compact_input_throttle((char)index)) == (char)index, "every throttle code maps back");
	}
	for (index = 0; index <= 255; index++)
	{
		check(compact_input_trigger_bits(compact_input_trigger((byte)index)) == index, "every trigger code maps back");
	}
	check(compact_input_throttle(compact_input_throttle_bits(1.0f)) == 1.0f &&
		compact_input_throttle(compact_input_throttle_bits(-1.0f)) == -1.0f &&
		compact_input_throttle(compact_input_throttle_bits(0.0f)) == 0.0f, "a keyboard's movement is exact");
	check(compact_input_trigger(compact_input_trigger_bits(1.0f)) == 1.0f, "a full trigger is exact");

	/* a quantized input comes back bit for bit; quantizing again changes nothing */
	for (index = 0; index < 20000; index++)
	{
		struct player_action original = random_action(index);
		struct player_action quantized = original;
		struct player_action again;
		double difference;

		web_quantize_player_action(&quantized);
		again = quantized;
		web_quantize_player_action(&again);
		if (memcmp(&again, &quantized, ACTION_BYTES) != 0)
		{
			check(0, "quantizing is idempotent");
			break;
		}
		if (!round_trips(&quantized, &size))
		{
			check(0, "a quantized input round-trips exactly");
			break;
		}
		if (size > largest)
			largest = size;
		if (original.control_flags == 0 && original.throttle.i == 0 && original.throttle.j == 0 &&
			original.primary_trigger == 0 && original.desired_weapon_index == NONE &&
			original.desired_grenade_index == NONE && original.desired_zoom_level == NONE)
		{
			idle_size = size;
		}
		if (original.control_flags && (original.throttle.i || original.throttle.j) &&
			original.primary_trigger == 1.0f && original.desired_weapon_index == NONE &&
			original.desired_grenade_index == NONE && original.desired_zoom_level == NONE)
		{
			moving_size = size;
		}
		difference = fabs((double)quantized.desired_facing.yaw - original.desired_facing.yaw);
		if (difference > PI)
			difference = 2 * PI - difference;
		if (difference > yaw_error)
			yaw_error = difference;
		difference = fabs((double)quantized.desired_facing.pitch - original.desired_facing.pitch);
		if (difference > pitch_error)
			pitch_error = difference;
		difference = fmax(fabs((double)quantized.throttle.i - original.throttle.i),
			fabs((double)quantized.throttle.j - original.throttle.j));
		if (difference > throttle_error)
			throttle_error = difference;
		difference = fabs((double)quantized.primary_trigger - original.primary_trigger);
		if (difference > trigger_error)
			trigger_error = difference;
		check(quantized.control_flags == original.control_flags &&
			quantized.desired_weapon_index == original.desired_weapon_index &&
			quantized.desired_grenade_index == original.desired_grenade_index &&
			quantized.desired_zoom_level == original.desired_zoom_level, "buttons and choices are untouched");
	}
	/* half a step at most; a mouse count is 0.0022 radians at sensitivity 1,
	0.00022 at the page's lowest */
	check(yaw_error <= PI / 65536 * 1.01, "yaw within half a step");
	check(pitch_error <= PI / 2 / 65535 * 1.01, "pitch within half a step");
	check(2 * PI / 65536 < 0.00022 / 2, "a yaw step under half the smallest mouse count");
	check(throttle_error <= 0.5 / 127 + 1e-6, "movement within half a step");
	check(trigger_error <= 0.5 / 255 + 1e-6, "trigger within half a step");
	check(idle_size == 5, "an idle input: 5 bytes (30 in the game's form)");
	check(moving_size == 10, "moving and firing: 10 bytes");
	check(largest <= COMPACT_INPUT_MAXIMUM_SIZE, "never past the maximum");

	/* what the ranges do not take goes as it is */
	{
		struct player_action action = random_action(1);

		web_quantize_player_action(&action);
		action.desired_facing.pitch = 2.5f;
		web_quantize_player_action(&action);
		check(action.desired_facing.pitch == 2.5f, "an out-of-range pitch is not quantized");
		check(round_trips(&action, &size) && size >= 9, "and goes as floats");
		action.control_flags = 0x12345678;
		check(round_trips(&action, &size), "buttons past 16 bits");
		action.desired_weapon_index = 9;
		action.desired_grenade_index = 3;
		action.desired_zoom_level = -2;
		check(round_trips(&action, &size), "choices past their fields");
	}

	/* the host's update: its header, then every player's input */
	{
		byte message[COMPACT_SERVER_UPDATE_HEADER + COMPACT_SERVER_UPDATE_PLAYERS * sizeof(struct player_action)];
		byte decoded[sizeof(message)];
		short count = COMPACT_SERVER_UPDATE_PLAYERS;
		short written;
		int truncated_refused = 1;

		memset(message, 0, sizeof(message));
		for (index = 0; index < COMPACT_SERVER_UPDATE_HEADER - 2; index++)
			message[index] = (byte)(index * 37 + 1);
		memcpy(message + COMPACT_SERVER_UPDATE_HEADER - 2, &count, 2);
		for (index = 0; index < count; index++)
		{
			struct player_action action = random_action(index);

			web_quantize_player_action(&action);
			memcpy(message + COMPACT_SERVER_UPDATE_HEADER + index * sizeof(action), &action, sizeof(action));
		}
		written = compact_game_update_write(TRUE, message, buffer, sizeof(buffer));
		check(written > 0 && written < (short)sizeof(message) / 2, "16 players' update in under half the game's size");
		check(compact_game_update_read(TRUE, decoded, sizeof(decoded), buffer, written), "it reads");
		for (index = 0; index < count; index++)
		{
			check(memcmp(decoded + COMPACT_SERVER_UPDATE_HEADER + index * sizeof(struct player_action),
				message + COMPACT_SERVER_UPDATE_HEADER + index * sizeof(struct player_action), ACTION_BYTES) == 0,
				"every player's input as the host had it");
		}
		check(memcmp(decoded, message, COMPACT_SERVER_UPDATE_HEADER) == 0, "the header as it was");
		for (size = 0; size < written; size++)
		{
			if (compact_game_update_read(TRUE, decoded, sizeof(decoded), buffer, size))
				truncated_refused = 0;
		}
		check(truncated_refused, "a truncated update is refused");
		buffer[written] = 0;
		check(!compact_game_update_read(TRUE, decoded, sizeof(decoded), buffer, written + 1), "trailing bytes are refused");
		count = COMPACT_SERVER_UPDATE_PLAYERS + 1;
		memcpy(buffer + 1 + COMPACT_SERVER_UPDATE_HEADER - 2, &count, 2);
		check(!compact_game_update_read(TRUE, decoded, sizeof(decoded), buffer, written), "too many players are refused");
		check(!compact_game_update_write(TRUE, message, buffer, 40), "an update that does not fit is not written");
		memcpy(message + COMPACT_SERVER_UPDATE_HEADER - 2, &count, 2);
		check(!compact_game_update_write(TRUE, message, buffer, sizeof(buffer)), "nor one of too many players");
		check(!compact_game_update_read(FALSE, decoded, 8, buffer, written), "nor into too small a message");
	}

	if (failures)
		return 1;
	printf("compact input: exact round trips and idempotent quantizing over 20000 inputs; "
		"idle %d B, moving and firing %d B, largest %d B (30 in the game's form); "
		"yaw error %.2e rad, pitch %.2e rad (a mouse count at the lowest sensitivity: 2.2e-04)\n",
		idle_size, moving_size, largest, yaw_error, pitch_error);
	return 0;
}
