/*
XINPUT_SDL.C

Xbox controllers and the debug keyboard for the Linux build.

Port 0 is always connected: it is the keyboard and mouse, merged with the
first SDL gamepad when one is present. Further SDL gamepads take ports 1-3.

Keyboard and mouse (port 0):
	W A S D          left stick          arrows           D-pad
	mouse            aim (see halo_linux_mouse_look)
	left button      right trigger       right button, G  left trigger
	space, enter     A                   F, backspace, X1 B
	E, R             X                   tab, wheel       Y
	Q                white               X                black
	left ctrl, C     left stick click    Z, middle button right stick click
	escape           start               F1               back
	F12              release or recapture the mouse

These are the defaults: the setting input.bindings gives a control other
keys or mouse buttons (keyboard_gamepad's table below).

In the menus the mouse is free and drives a pointer instead
(port/linux/include/halo_ui_pointer.h, source/interface/ui_widget.c): its
motion, buttons and wheel do not reach the controller then.

Mouse aim does not go through the right stick: the game's look code asks
halo_linux_mouse_look for the motion since its last call and adds it to the
stick's facing change, so aiming is direct rather than rate based.

The game's debug keyboard exists only for the console. Backquote (which
opens it) always reaches the keystroke queue, everything else only while
the console is open, since the game also polls a few keys directly (escape
returns to the main menu). While the console is open the keyboard does not
drive the controller.
*/

#include "platform.h"
#include "sdl_platform.h"
#include "port_config.h"
#include "halo_aim_device.h"
#include "halo_movement_source.h"

#include <SDL3/SDL.h>
#include <math.h>
#ifdef HALO_WEB
#include <emscripten.h>
#endif
#include <stdlib.h>
#include <string.h>

#define PORT_COUNT 4
#define VK_OEM_3_BACKQUOTE 0xc0

/* ---------- game hooks */

/* main/console.c */
extern unsigned char console_is_active(void);

/* ---------- device tables */

XPP_DEVICE_TYPE XDEVICE_TYPE_GAMEPAD_TABLE;
XPP_DEVICE_TYPE XDEVICE_TYPE_MEMORY_UNIT_TABLE;
XPP_DEVICE_TYPE XDEVICE_TYPE_DEBUG_KEYBOARD_TABLE;

struct controller
{
	BOOL open;
	DWORD packet_number;
	XINPUT_GAMEPAD previous;
};

static struct controller controllers[PORT_COUNT];
static struct controller keyboard_device;
static DWORD reported_gamepads = 0;
static BOOL reported_keyboard = FALSE;

/* ---------- mouse */

static pthread_mutex_t mouse_lock = PTHREAD_MUTEX_INITIALIZER;
static float mouse_pending_x, mouse_pending_y;
static unsigned long mouse_polls_unconsumed = 0;
static float mouse_wheel_accumulated = 0.0f;
/* the wheel's switch (wheel_update): when the wheel last moved, until when
Y is held, and whether a scroll is under way */
static Uint64 wheel_moved_ms = 0;
static Uint64 wheel_press_until_ms = 0;
static BOOL wheel_scrolling = FALSE;

/* Camera-assist ownership is per local-player port. Port 0 combines the
keyboard/mouse with gamepad 0, so its no-input default is mouse look. */
static struct halo_aim_look_state aim_look_states[PORT_COUNT];
static SDL_JoystickID aim_gamepad_ids[PORT_COUNT];
static BOOL aim_gamepad_identity_known[PORT_COUNT];
static BOOL aim_look_states_initialized = FALSE;
/* Winning keyboard axes from this poll, never the last look device. */
static unsigned keyboard_movement_axes[PORT_COUNT];

unsigned halo_linux_keyboard_movement_axes(short gamepad_index)
{
	unsigned axes;

	if (gamepad_index < 0 || gamepad_index >= PORT_COUNT)
		return 0;
	pthread_mutex_lock(&mouse_lock);
	axes = keyboard_movement_axes[gamepad_index];
	pthread_mutex_unlock(&mouse_lock);
	return axes;
}

static void aim_look_states_initialize_locked(void)
{
	int port;

	if (aim_look_states_initialized)
		return;
	for (port = 0; port < PORT_COUNT; port++)
	{
		halo_aim_look_state_reset(
			&aim_look_states[port],
			port == 0 ? _halo_aim_look_device_mouse : _halo_aim_look_device_controller);
	}
	aim_look_states_initialized = TRUE;
}

static void aim_look_reset_port_locked(int port)
{
	halo_aim_look_state_reset(
		&aim_look_states[port],
		port == 0 ? _halo_aim_look_device_mouse : _halo_aim_look_device_controller);
}

static void aim_look_update_gamepad_locked(
	int port,
	SDL_Gamepad *gamepad,
	const XINPUT_GAMEPAD *state)
{
	SDL_JoystickID id = gamepad ? SDL_GetGamepadID(gamepad) : 0;

	aim_look_states_initialize_locked();
	if (!aim_gamepad_identity_known[port] || aim_gamepad_ids[port] != id)
	{
		aim_gamepad_ids[port] = id;
		aim_gamepad_identity_known[port] = TRUE;
		/* Hotplug is not look input: preserve ownership, discard old samples. */
		halo_aim_look_clear_controller_sample(&aim_look_states[port]);
	}
	halo_aim_look_note_controller_sample(
		&aim_look_states[port],
		gamepad ? state->sThumbRX : 0,
		gamepad ? state->sThumbRY : 0, SDL_GetTicks());
}

/* input.mouse_sensitivity and input.invert_mouse, again whenever a setting
has changed (the web page's Settings set them while playing) */
static float mouse_sensitivity_value = 1.0f;
static BOOL mouse_invert_value = FALSE;
static unsigned long mouse_settings_generation;
static BOOL mouse_settings_ready = FALSE;

static void mouse_settings_refresh(void)
{
	unsigned long generation = config_generation();
	float sensitivity;
	BOOL invert;

	if (mouse_settings_ready && generation == mouse_settings_generation)
		return;
	sensitivity = (float)config_real("input.mouse_sensitivity");
	if (sensitivity <= 0.0f)
		sensitivity = 1.0f;
	invert = config_boolean("input.invert_mouse") ? TRUE : FALSE;
	if (mouse_settings_ready && (sensitivity != mouse_sensitivity_value || invert != mouse_invert_value))
		platform_log("input: mouse sensitivity %.2f%s", sensitivity, invert ? ", inverted" : "");
	mouse_sensitivity_value = sensitivity;
	mouse_invert_value = invert;
	mouse_settings_generation = generation;
	mouse_settings_ready = TRUE;
}

int halo_linux_camera_assist_enabled(short gamepad_index)
{
	int enabled;

	if (gamepad_index < 0 || gamepad_index >= PORT_COUNT)
		return TRUE;
	pthread_mutex_lock(&mouse_lock);
	aim_look_states_initialize_locked();
	enabled = halo_aim_look_camera_assist_allowed(&aim_look_states[gamepad_index]);
	pthread_mutex_unlock(&mouse_lock);
	return enabled;
}

/* radians of yaw and pitch for the mouse motion since the last call; the
game adds these to the facing change of the player on gamepad 0 */
int halo_linux_mouse_look(short gamepad_index, float *yaw, float *pitch)
{
	/* radians per pixel of relative motion at sensitivity 1 */
	const float scale = 0.0022f;
	float x, y;

	*yaw = 0.0f;
	*pitch = 0.0f;
	if (gamepad_index != 0)
		return FALSE;
	mouse_settings_refresh();
	pthread_mutex_lock(&mouse_lock);
	aim_look_states_initialize_locked();
	x = mouse_pending_x;
	y = mouse_pending_y;
	mouse_pending_x = 0.0f;
	mouse_pending_y = 0.0f;
	mouse_polls_unconsumed = 0;
	pthread_mutex_unlock(&mouse_lock);
	if (x == 0.0f && y == 0.0f)
		return FALSE;
	*yaw = -x * scale * mouse_sensitivity_value;
	*pitch = (mouse_invert_value ? y : -y) * scale * mouse_sensitivity_value;
	return TRUE;
}

/* collects the motion the game has not asked for yet; motion that nobody
consumes for a few polls (menus, cutscenes) is dropped so it cannot jerk
the view later */
static void mouse_poll(const struct platform_input_state *input)
{
	pthread_mutex_lock(&mouse_lock);
	if (++mouse_polls_unconsumed > 4)
	{
		mouse_pending_x = 0.0f;
		mouse_pending_y = 0.0f;
	}
	if (!input->mouse_released && !input->ui_pointer)
	{
		mouse_pending_x += input->mouse_dx;
		mouse_pending_y += input->mouse_dy;
		mouse_wheel_accumulated += input->mouse_wheel;
		if (input->mouse_wheel != 0.0f)
			wheel_moved_ms = SDL_GetTicks();
	}
	pthread_mutex_unlock(&mouse_lock);
}

/* ---------- keyboard and mouse as a controller */

static BYTE analog(BOOL down)
{
	return down ? 0xff : 0x00;
}

/* The keys and mouse buttons of each of the controller's controls: the
defaults below (port/linux/README.md, "Controls"), except the controls the
setting input.bindings lists (port_config.c). The hosted web page sets it
from its own Settings (platform_web_bind_input). */
enum input_control
{
	_input_move_forward,
	_input_move_back,
	_input_move_left,
	_input_move_right,
	_input_jump,
	_input_melee,
	_input_action,
	_input_switch_weapon,
	_input_flashlight,
	_input_switch_grenade,
	_input_grenade,
	_input_fire,
	_input_crouch,
	_input_zoom,
	_input_pause,
	_input_back,
	_input_dpad_up,
	_input_dpad_down,
	_input_dpad_left,
	_input_dpad_right,
	NUMBER_OF_INPUT_CONTROLS
};

/* an input: a key (its SDL scancode), a mouse button or the wheel */
#define INPUT_MOUSE_BUTTON(button) (0x1000 + (button))
#define INPUT_WHEEL 0x2000
#define MAXIMUM_INPUT_BINDINGS 4

struct input_binding
{
	int count;
	int inputs[MAXIMUM_INPUT_BINDINGS];
};

static const char *const input_control_names[NUMBER_OF_INPUT_CONTROLS] =
{
	"move_forward", "move_back", "move_left", "move_right", "jump", "melee", "action", "switch_weapon",
	"flashlight", "switch_grenade", "grenade", "fire", "crouch", "zoom", "pause", "back",
	"dpad_up", "dpad_down", "dpad_left", "dpad_right",
};

static const struct input_binding input_default_bindings[NUMBER_OF_INPUT_CONTROLS] =
{
	{ 1, { SDL_SCANCODE_W } },
	{ 1, { SDL_SCANCODE_S } },
	{ 1, { SDL_SCANCODE_A } },
	{ 1, { SDL_SCANCODE_D } },
	{ 3, { SDL_SCANCODE_SPACE, SDL_SCANCODE_RETURN, SDL_SCANCODE_KP_ENTER } },
	{ 3, { SDL_SCANCODE_F, SDL_SCANCODE_BACKSPACE, INPUT_MOUSE_BUTTON(SDL_BUTTON_X1) } },
	{ 2, { SDL_SCANCODE_E, SDL_SCANCODE_R } },
	{ 2, { SDL_SCANCODE_TAB, INPUT_WHEEL } },
	{ 1, { SDL_SCANCODE_Q } },
	{ 1, { SDL_SCANCODE_X } },
	{ 2, { SDL_SCANCODE_G, INPUT_MOUSE_BUTTON(SDL_BUTTON_RIGHT) } },
	{ 1, { INPUT_MOUSE_BUTTON(SDL_BUTTON_LEFT) } },
#ifdef HALO_WEB
	/* Control plus a movement key is a browser shortcut (Ctrl+W closes the
	 * tab, Ctrl+S opens Save, and Ctrl+D bookmarks). Keep web crouch on C so
	 * ordinary tab play cannot accidentally leave the game. */
	{ 1, { SDL_SCANCODE_C } },
#else
	{ 2, { SDL_SCANCODE_LCTRL, SDL_SCANCODE_C } },
#endif
	{ 2, { SDL_SCANCODE_Z, INPUT_MOUSE_BUTTON(SDL_BUTTON_MIDDLE) } },
	{ 1, { SDL_SCANCODE_ESCAPE } },
	{ 1, { SDL_SCANCODE_F1 } },
	{ 1, { SDL_SCANCODE_UP } },
	{ 1, { SDL_SCANCODE_DOWN } },
	{ 1, { SDL_SCANCODE_LEFT } },
	{ 1, { SDL_SCANCODE_RIGHT } },
};

static struct input_binding input_bindings[NUMBER_OF_INPUT_CONTROLS];
static unsigned long input_bindings_generation;
static BOOL input_bindings_ready = FALSE;

/* "key:<SDL scancode name or number>", "mouse:<left|middle|right|x1|x2 or
1-5>" or "wheel"; -1 if it is none */
static int input_parse(const char *text)
{
	static const char *const buttons[] = { "left", "middle", "right", "x1", "x2" };
	char *end;
	long number;
	int index;

	while (*text == ' ')
		text++;
	if (!strcmp(text, "wheel"))
		return INPUT_WHEEL;
	if (!strncmp(text, "mouse:", 6))
	{
		for (index = 0; index < 5; index++)
		{
			if (!SDL_strcasecmp(text + 6, buttons[index]))
				return INPUT_MOUSE_BUTTON(index + 1);
		}
		number = strtol(text + 6, &end, 10);
		return end != text + 6 && !*end && number >= 1 && number <= 5 ? INPUT_MOUSE_BUTTON((int)number) : -1;
	}
	if (!strncmp(text, "key:", 4))
	{
		number = strtol(text + 4, &end, 10);
		if (end != text + 4 && !*end)
			return number > 0 && number < SDL_SCANCODE_COUNT ? (int)number : -1;
		number = SDL_GetScancodeFromName(text + 4);
		return number > 0 ? (int)number : -1;
	}
	return -1;
}

/* the defaults, then each control "spec" lists (control=input,input;...) */
static void input_bindings_parse(const char *spec, struct input_binding *bindings)
{
	char copy[1024];
	char *control_text;
	char *control_state = NULL;

	memcpy(bindings, input_default_bindings, sizeof(input_default_bindings));
	snprintf(copy, sizeof(copy), "%s", spec);
	for (control_text = SDL_strtok_r(copy, ";", &control_state); control_text;
		control_text = SDL_strtok_r(NULL, ";", &control_state))
	{
		char *equals = strchr(control_text, '=');
		char *input_text;
		char *input_state = NULL;
		int control;

		while (*control_text == ' ')
			control_text++;
		if (!equals)
			continue;
		*equals = 0;
		for (control = 0; control < NUMBER_OF_INPUT_CONTROLS; control++)
		{
			if (!strcmp(control_text, input_control_names[control]))
				break;
		}
		if (control == NUMBER_OF_INPUT_CONTROLS)
			continue;
		bindings[control].count = 0;
		for (input_text = SDL_strtok_r(equals + 1, ",", &input_state); input_text;
			input_text = SDL_strtok_r(NULL, ",", &input_state))
		{
			int input = input_parse(input_text);

			if (input >= 0 && bindings[control].count < MAXIMUM_INPUT_BINDINGS)
				bindings[control].inputs[bindings[control].count++] = input;
		}
	}
}

/* (each poll) the bindings, again whenever a setting has changed */
static void input_bindings_refresh(void)
{
	unsigned long generation = config_generation();

	if (input_bindings_ready && generation == input_bindings_generation)
		return;
	{
		char spec[1024];
		static char applied[1024];

		config_copy_string("input.bindings", spec, sizeof(spec));
		input_bindings_parse(spec, input_bindings);
		if (strcmp(spec, applied))
		{
			platform_log("input: bindings \"%s\"", spec);
			snprintf(applied, sizeof(applied), "%s", spec);
		}
	}
	input_bindings_generation = generation;
	input_bindings_ready = TRUE;
}

static BOOL input_down(const struct platform_input_state *input, int code)
{
	if (code == INPUT_WHEEL)
		return SDL_GetTicks() < wheel_press_until_ms;
	if (code >= INPUT_MOUSE_BUTTON(0))
	{
		int button = code - INPUT_MOUSE_BUTTON(0);

		return !input->mouse_released && button >= 0 && button < (int)sizeof(input->mouse_buttons) &&
			input->mouse_buttons[button];
	}
	return code >= 0 && code < (int)sizeof(input->keys) && input->keys[code];
}

static BOOL input_control_down(const struct platform_input_state *input, enum input_control control)
{
	int index;

	for (index = 0; index < input_bindings[control].count; index++)
	{
		if (input_down(input, input_bindings[control].inputs[index]))
			return TRUE;
	}
	return FALSE;
}

#ifdef HALO_WEB
/* (the hosted page) Start and A pressed for a moment by its own buttons:
the page keeps Escape for itself, and starts the host's match */
static volatile double web_press_until[2];

EMSCRIPTEN_KEEPALIVE void platform_web_press_button(int button)
{
	if (button >= 0 && button < 2)
		web_press_until[button] = emscripten_get_now() + 150.0;
}

/* The page's Settings (its Escape menu), applied as the settings
input.mouse_sensitivity, input.invert_mouse and input.bindings are: the
page keeps them, and sets them each visit. Bindings are staged control by
control (platform_web_bind_input: up to MAXIMUM_INPUT_BINDINGS inputs, in
input codes: an SDL scancode, 0x1000 + an SDL mouse button, 0x2000 the
wheel; none unbinds it) and take effect together. */
static struct input_binding web_staged_bindings[NUMBER_OF_INPUT_CONTROLS];
static BOOL web_staged_controls[NUMBER_OF_INPUT_CONTROLS];

EMSCRIPTEN_KEEPALIVE int platform_web_set_mouse_sensitivity(double sensitivity)
{
	char text[32];

	if (!(sensitivity >= 0.05 && sensitivity <= 20.0))
		return 0;
	snprintf(text, sizeof(text), "%.4f", sensitivity);
	return config_set_text("input.mouse_sensitivity", text);
}

EMSCRIPTEN_KEEPALIVE int platform_web_set_invert_mouse(int invert)
{
	return config_set_text("input.invert_mouse", invert ? "true" : "false");
}

EMSCRIPTEN_KEEPALIVE int platform_web_bind_input(int control, int input0, int input1, int input2, int input3)
{
	int inputs[MAXIMUM_INPUT_BINDINGS] = { input0, input1, input2, input3 };
	int index;

	if (control < 0 || control >= NUMBER_OF_INPUT_CONTROLS)
		return 0;
	web_staged_bindings[control].count = 0;
	for (index = 0; index < MAXIMUM_INPUT_BINDINGS; index++)
	{
		int input = inputs[index];

		if (input <= 0)
			continue;
		if (!(input < SDL_SCANCODE_COUNT || input == INPUT_WHEEL ||
			(input > INPUT_MOUSE_BUTTON(0) && input <= INPUT_MOUSE_BUTTON(5))))
		{
			return 0;
		}
		web_staged_bindings[control].inputs[web_staged_bindings[control].count++] = input;
	}
	web_staged_controls[control] = TRUE;
	return 1;
}

/* the staged controls, the others at their defaults */
EMSCRIPTEN_KEEPALIVE int platform_web_apply_input_bindings(void)
{
	char spec[1024] = "";
	size_t length = 0;
	int control;

	for (control = 0; control < NUMBER_OF_INPUT_CONTROLS; control++)
	{
		int index;

		if (!web_staged_controls[control])
			continue;
		length += (size_t)snprintf(spec + length, sizeof(spec) - length, "%s%s=", length ? ";" : "",
			input_control_names[control]);
		for (index = 0; index < web_staged_bindings[control].count && length < sizeof(spec); index++)
		{
			int input = web_staged_bindings[control].inputs[index];

			if (input == INPUT_WHEEL)
				length += (size_t)snprintf(spec + length, sizeof(spec) - length, "%swheel", index ? "," : "");
			else if (input > INPUT_MOUSE_BUTTON(0))
				length += (size_t)snprintf(spec + length, sizeof(spec) - length, "%smouse:%d", index ? "," : "",
					input - INPUT_MOUSE_BUTTON(0));
			else
				length += (size_t)snprintf(spec + length, sizeof(spec) - length, "%skey:%d", index ? "," : "", input);
		}
		if (length >= sizeof(spec))
			return 0;
	}
	memset(web_staged_controls, 0, sizeof(web_staged_controls));
	return config_set_text("input.bindings", spec);
}
#endif

static void keyboard_gamepad(const struct platform_input_state *input, XINPUT_GAMEPAD *pad)
{
	int x = 0, y = 0;

	input_bindings_refresh();
	if (input_control_down(input, _input_move_right)) x++;
	if (input_control_down(input, _input_move_left)) x--;
	if (input_control_down(input, _input_move_forward)) y++;
	if (input_control_down(input, _input_move_back)) y--;
	if (x || y)
	{
		/* full deflection, diagonals on the unit circle */
		float length = (x && y) ? 0.70710678f : 1.0f;

		pad->sThumbLX = (SHORT)(x * 32767 * length);
		pad->sThumbLY = (SHORT)(y * 32767 * length);
	}

	if (input_control_down(input, _input_dpad_up)) pad->wButtons |= XINPUT_GAMEPAD_DPAD_UP;
	if (input_control_down(input, _input_dpad_down)) pad->wButtons |= XINPUT_GAMEPAD_DPAD_DOWN;
	if (input_control_down(input, _input_dpad_left)) pad->wButtons |= XINPUT_GAMEPAD_DPAD_LEFT;
	if (input_control_down(input, _input_dpad_right)) pad->wButtons |= XINPUT_GAMEPAD_DPAD_RIGHT;
	if (input_control_down(input, _input_pause)) pad->wButtons |= XINPUT_GAMEPAD_START;
	if (input_control_down(input, _input_back)) pad->wButtons |= XINPUT_GAMEPAD_BACK;
#ifdef HALO_WEB
	{
		double now = emscripten_get_now();

		if (now < web_press_until[0]) pad->wButtons |= XINPUT_GAMEPAD_START;
		if (now < web_press_until[1]) pad->bAnalogButtons[XINPUT_GAMEPAD_A] = 0xff;
	}
#endif
	if (input_control_down(input, _input_crouch)) pad->wButtons |= XINPUT_GAMEPAD_LEFT_THUMB;
	if (input_control_down(input, _input_zoom)) pad->wButtons |= XINPUT_GAMEPAD_RIGHT_THUMB;

	pad->bAnalogButtons[XINPUT_GAMEPAD_A] |= analog(input_control_down(input, _input_jump));
	pad->bAnalogButtons[XINPUT_GAMEPAD_B] |= analog(input_control_down(input, _input_melee));
	#if defined(HALO_ANDROID) && !defined(HALO_WEB)
	/* the system back key (gesture or button) backs out of menus */
	pad->bAnalogButtons[XINPUT_GAMEPAD_B] |= analog(input->keys[SDL_SCANCODE_AC_BACK]);
#endif
	pad->bAnalogButtons[XINPUT_GAMEPAD_X] |= analog(input_control_down(input, _input_action));
	pad->bAnalogButtons[XINPUT_GAMEPAD_Y] |= analog(input_control_down(input, _input_switch_weapon));
	pad->bAnalogButtons[XINPUT_GAMEPAD_WHITE] |= analog(input_control_down(input, _input_flashlight));
	pad->bAnalogButtons[XINPUT_GAMEPAD_BLACK] |= analog(input_control_down(input, _input_switch_grenade));
	pad->bAnalogButtons[XINPUT_GAMEPAD_LEFT_TRIGGER] |= analog(input_control_down(input, _input_grenade));
	pad->bAnalogButtons[XINPUT_GAMEPAD_RIGHT_TRIGGER] |= analog(input_control_down(input, _input_fire));
}

/* A scroll of the wheel switches weapons once: it holds Y for WHEEL_PRESS_MS
once the wheel has turned a notch, and the scroll lasts until the wheel has
been still for WHEEL_SCROLL_GAP_MS. One notch often arrives as several events
over a few tens of milliseconds (high-resolution and smooth-scrolling
wheels), and one flick turns several notches; switching for each would bring
the same weapon straight back. Timed in milliseconds, not polls: polls come
once a frame, at the display's refresh rate. */
#define WHEEL_PRESS_MS 50
#define WHEEL_SCROLL_GAP_MS 200

/* debug.test_input "bot:<seed>": a scripted player for the automated
network tests (port/linux/game/network_test.c), different for each seed:
it walks and strafes in circles, turns, fires every few seconds and jumps
now and then */
static int test_input_holding_action;
static Uint64 test_input_holding_action_since;

/* the automated tests (port/linux/game/network_test.c): the scripted player
stands still, holding the action button (X: picking up, swapping weapons)
after a second */
void test_input_hold_action(int hold)
{
	if (hold && !test_input_holding_action)
		test_input_holding_action_since = SDL_GetTicks();
	test_input_holding_action = hold;
}

static int test_input_seed(void)
{
	static int checked;
	static int seed = -1;

	if (!checked)
	{
		const char *setting = config_string("debug.test_input");

		checked = 1;
		if (!strncmp(setting, "bot:", 4))
			seed = atoi(setting + 4);
		else if (!strcmp(setting, "bot"))
			seed = 0;
	}
	return seed;
}

/* debug.test_players: the scripted controllers, the first's included */
static int test_input_ports(void)
{
	long players;

	if (test_input_seed() < 0)
		return 0;
	players = config_integer("debug.test_players");
	return players < 1 ? 1 : players > PORT_COUNT ? PORT_COUNT : (int)players;
}

static int test_input_gamepad(XINPUT_GAMEPAD *pad, int port)
{
	int seed = test_input_seed();
	double t;

	if (seed < 0 || port >= test_input_ports())
		return FALSE;
	/* (another player on another controller) */
	seed += port * 101;
	if (test_input_holding_action && port == 0)
	{
		/* (standing still, the button held from a second on) */
		if (SDL_GetTicks() - test_input_holding_action_since >= 1000)
			pad->bAnalogButtons[XINPUT_GAMEPAD_X] = 255;
		return FALSE;
	}
	t = (double)SDL_GetTicks() / 1000.0 + seed * 1.7;
	pad->sThumbLY = (SHORT)(sin(t * 0.9) * 32000.0);
	pad->sThumbLX = (SHORT)(cos(t * 0.6 + seed) * 20000.0);
	pad->sThumbRX = (SHORT)(sin(t * 0.4) * 14000.0);
	if (fmod(t, 3.0) < 0.3)
		pad->bAnalogButtons[XINPUT_GAMEPAD_RIGHT_TRIGGER] = 255;
	if (fmod(t, 5.0) < 0.1)
		pad->bAnalogButtons[XINPUT_GAMEPAD_A] = 255;
	return TRUE; /* Synthetic movement replaces both physical left axes. */
}

static void wheel_update(void)
{
	Uint64 now = SDL_GetTicks();

	pthread_mutex_lock(&mouse_lock);
	if (!wheel_scrolling)
	{
		if (fabsf(mouse_wheel_accumulated) >= 1.0f)
		{
			wheel_scrolling = TRUE;
			wheel_press_until_ms = now + WHEEL_PRESS_MS;
		}
	}
	else if (now >= wheel_press_until_ms && now - wheel_moved_ms >= WHEEL_SCROLL_GAP_MS)
	{
		wheel_scrolling = FALSE;
		mouse_wheel_accumulated = 0.0f;
	}
	pthread_mutex_unlock(&mouse_lock);
}

/* ---------- SDL gamepads */

/* the SDL gamepads in connection order, at most one per port */
static int sdl_gamepads(SDL_Gamepad *gamepads[PORT_COUNT])
{
	SDL_JoystickID *ids;
	int count = 0, index, found = 0;

	memset(gamepads, 0, sizeof(SDL_Gamepad *) * PORT_COUNT);
	ids = SDL_GetGamepads(&count);
	if (!ids)
		return 0;
	#if defined(HALO_ANDROID) && !defined(HALO_WEB)
	{
		/* Android can list input devices with a few gamepad buttons (the
		emulator's keyboard, some phones' key devices) as generic gamepads:
		recognised controllers take the first ports */
		int pass;

		for (pass = 0; pass < 2; pass++)
		{
			for (index = 0; index < count && found < PORT_COUNT; index++)
			{
				SDL_Gamepad *gamepad = SDL_GetGamepadFromID(ids[index]);
				SDL_GamepadType type;
				BOOL recognised;

				if (!gamepad)
					continue;
				type = SDL_GetGamepadType(gamepad);
				recognised = type != SDL_GAMEPAD_TYPE_UNKNOWN && type != SDL_GAMEPAD_TYPE_STANDARD;
				if (recognised == (pass == 0))
					gamepads[found++] = gamepad;
			}
		}
	}
#else
	for (index = 0; index < count && found < PORT_COUNT; index++)
	{
		SDL_Gamepad *gamepad = SDL_GetGamepadFromID(ids[index]);

		if (gamepad)
			gamepads[found++] = gamepad;
	}
#endif
	SDL_free(ids);
	return found;
}

static SHORT stick(Sint16 value, BOOL flip)
{
	int result = flip ? -(int)value - 1 : value;

	if (result < -32768) result = -32768;
	if (result > 32767) result = 32767;
	return (SHORT)result;
}

static void merge_button(XINPUT_GAMEPAD *pad, int analog_index, BOOL down)
{
	if (down)
		pad->bAnalogButtons[analog_index] = 0xff;
}

static void sdl_gamepad_state(SDL_Gamepad *gamepad, XINPUT_GAMEPAD *pad)
{
	static const struct
	{
		SDL_GamepadButton button;
		WORD mask;
	} digital[] =
	{
		{ SDL_GAMEPAD_BUTTON_DPAD_UP, XINPUT_GAMEPAD_DPAD_UP },
		{ SDL_GAMEPAD_BUTTON_DPAD_DOWN, XINPUT_GAMEPAD_DPAD_DOWN },
		{ SDL_GAMEPAD_BUTTON_DPAD_LEFT, XINPUT_GAMEPAD_DPAD_LEFT },
		{ SDL_GAMEPAD_BUTTON_DPAD_RIGHT, XINPUT_GAMEPAD_DPAD_RIGHT },
		{ SDL_GAMEPAD_BUTTON_START, XINPUT_GAMEPAD_START },
		{ SDL_GAMEPAD_BUTTON_BACK, XINPUT_GAMEPAD_BACK },
		{ SDL_GAMEPAD_BUTTON_LEFT_STICK, XINPUT_GAMEPAD_LEFT_THUMB },
		{ SDL_GAMEPAD_BUTTON_RIGHT_STICK, XINPUT_GAMEPAD_RIGHT_THUMB },
	};
	int index;
	int left_trigger, right_trigger;
	SHORT value;

	for (index = 0; index < (int)(sizeof(digital) / sizeof(digital[0])); index++)
	{
		if (SDL_GetGamepadButton(gamepad, digital[index].button))
			pad->wButtons |= digital[index].mask;
	}
	merge_button(pad, XINPUT_GAMEPAD_A, SDL_GetGamepadButton(gamepad, SDL_GAMEPAD_BUTTON_SOUTH));
	merge_button(pad, XINPUT_GAMEPAD_B, SDL_GetGamepadButton(gamepad, SDL_GAMEPAD_BUTTON_EAST));
	merge_button(pad, XINPUT_GAMEPAD_X, SDL_GetGamepadButton(gamepad, SDL_GAMEPAD_BUTTON_WEST));
	merge_button(pad, XINPUT_GAMEPAD_Y, SDL_GetGamepadButton(gamepad, SDL_GAMEPAD_BUTTON_NORTH));
	/* the Duke's white and black buttons sit where later pads have shoulders */
	merge_button(pad, XINPUT_GAMEPAD_WHITE, SDL_GetGamepadButton(gamepad, SDL_GAMEPAD_BUTTON_LEFT_SHOULDER));
	merge_button(pad, XINPUT_GAMEPAD_BLACK, SDL_GetGamepadButton(gamepad, SDL_GAMEPAD_BUTTON_RIGHT_SHOULDER));

	left_trigger = SDL_GetGamepadAxis(gamepad, SDL_GAMEPAD_AXIS_LEFT_TRIGGER) * 255 / 32767;
	right_trigger = SDL_GetGamepadAxis(gamepad, SDL_GAMEPAD_AXIS_RIGHT_TRIGGER) * 255 / 32767;
	if (left_trigger > pad->bAnalogButtons[XINPUT_GAMEPAD_LEFT_TRIGGER])
		pad->bAnalogButtons[XINPUT_GAMEPAD_LEFT_TRIGGER] = (BYTE)left_trigger;
	if (right_trigger > pad->bAnalogButtons[XINPUT_GAMEPAD_RIGHT_TRIGGER])
		pad->bAnalogButtons[XINPUT_GAMEPAD_RIGHT_TRIGGER] = (BYTE)right_trigger;

	/* a stick only overrides the keyboard when it is pushed further */
	value = stick(SDL_GetGamepadAxis(gamepad, SDL_GAMEPAD_AXIS_LEFTX), FALSE);
	if (abs(value) > abs(pad->sThumbLX)) pad->sThumbLX = value;
	value = stick(SDL_GetGamepadAxis(gamepad, SDL_GAMEPAD_AXIS_LEFTY), TRUE);
	if (abs(value) > abs(pad->sThumbLY)) pad->sThumbLY = value;
	value = stick(SDL_GetGamepadAxis(gamepad, SDL_GAMEPAD_AXIS_RIGHTX), FALSE);
	if (abs(value) > abs(pad->sThumbRX)) pad->sThumbRX = value;
	value = stick(SDL_GetGamepadAxis(gamepad, SDL_GAMEPAD_AXIS_RIGHTY), TRUE);
	if (abs(value) > abs(pad->sThumbRY)) pad->sThumbRY = value;
}

/* ---------- XAPI */

VOID WINAPI XInitDevices(DWORD preallocation_type_count, PXDEVICE_PREALLOC_TYPE preallocation_types)
{
	(void)preallocation_type_count;
	(void)preallocation_types;
	platform_sdl_initialize();
}

static DWORD connected_gamepads(void)
{
	SDL_Gamepad *gamepads[PORT_COUNT];
	int count = sdl_gamepads(gamepads);
	DWORD mask = XDEVICE_PORT0_MASK;
	int port;

	/* the first pad shares port 0 with the keyboard */
	for (port = 1; port < count; port++)
		mask |= 1UL << port;
	for (port = 1; port < test_input_ports(); port++)
		mask |= 1UL << port;
	return mask;
}

static int gamepad_index_for_port(int port)
{
	return port;
}

BOOL WINAPI XGetDeviceChanges(PXPP_DEVICE_TYPE device_type, PDWORD insertions, PDWORD removals)
{
	*insertions = 0;
	*removals = 0;
	if (device_type == XDEVICE_TYPE_GAMEPAD)
	{
		DWORD connected = connected_gamepads();

		*insertions = connected & ~reported_gamepads;
		*removals = reported_gamepads & ~connected;
		reported_gamepads = connected;
	}
	else if (device_type == XDEVICE_TYPE_DEBUG_KEYBOARD)
	{
		if (!reported_keyboard)
		{
			*insertions = 1;
			reported_keyboard = TRUE;
		}
	}
	return *insertions || *removals;
}

HANDLE WINAPI XInputOpen(PXPP_DEVICE_TYPE device_type, DWORD port, DWORD slot,
	PXINPUT_POLLING_PARAMETERS polling_parameters)
{
	(void)slot;
	(void)polling_parameters;
	if (device_type == XDEVICE_TYPE_GAMEPAD && port < PORT_COUNT)
	{
		pthread_mutex_lock(&mouse_lock);
		aim_look_states_initialize_locked();
		aim_look_reset_port_locked((int)port);
		aim_gamepad_identity_known[port] = FALSE;
		keyboard_movement_axes[port] = 0;
		pthread_mutex_unlock(&mouse_lock);
		memset(&controllers[port], 0, sizeof(controllers[port]));
		controllers[port].open = TRUE;
		return (HANDLE)&controllers[port];
	}
	if (device_type == XDEVICE_TYPE_DEBUG_KEYBOARD && port == 0)
	{
		keyboard_device.open = TRUE;
		return (HANDLE)&keyboard_device;
	}
	SetLastError(ERROR_DEVICE_NOT_CONNECTED);
	return NULL;
}

VOID WINAPI XInputClose(HANDLE device)
{
	struct controller *controller = (struct controller *)device;
	int port;

	if (controller)
		controller->open = FALSE;
	for (port = 0; port < PORT_COUNT; port++)
	{
		if (device == (HANDLE)&controllers[port])
		{
			pthread_mutex_lock(&mouse_lock);
			aim_look_states_initialize_locked();
			aim_look_reset_port_locked(port);
			aim_gamepad_identity_known[port] = FALSE;
			keyboard_movement_axes[port] = 0;
			pthread_mutex_unlock(&mouse_lock);
			break;
		}
	}
}

static int controller_port(HANDLE device)
{
	int port;

	for (port = 0; port < PORT_COUNT; port++)
	{
		if (device == (HANDLE)&controllers[port] && controllers[port].open)
			return port;
	}
	return -1;
}

DWORD WINAPI XInputGetState(HANDLE device, PXINPUT_STATE state)
{
	int port = controller_port(device);
	SDL_Gamepad *gamepads[PORT_COUNT];
	int gamepad_index;
	int count;
	SDL_Gamepad *look_gamepad = NULL;
	unsigned movement_axes = 0;

	memset(state, 0, sizeof(*state));
	if (port < 0)
		return ERROR_DEVICE_NOT_CONNECTED;
	platform_pump_events();
	count = sdl_gamepads(gamepads);
	if (port == 0)
	{
		struct platform_input_state input;
		XINPUT_GAMEPAD keyboard = {0};

		platform_input_read(&input, TRUE);
		mouse_poll(&input);
		wheel_update();
		if (!console_is_active())
			keyboard_gamepad(&input, &state->Gamepad);
		keyboard = state->Gamepad;
		if (count > 0)
		{
			look_gamepad = gamepads[0];
			sdl_gamepad_state(look_gamepad, &state->Gamepad);
		}
		pthread_mutex_lock(&mouse_lock);
		aim_look_update_gamepad_locked(port, look_gamepad, &state->Gamepad);
		/* Same-poll ties favor captured mouse; later polls keep their ordering. */
		halo_aim_look_note_mouse_motion(&aim_look_states[0],
			!input.mouse_released && !input.ui_pointer &&
			(input.mouse_dx != 0.0f || input.mouse_dy != 0.0f));
		pthread_mutex_unlock(&mouse_lock);
		/* Do not let synthetic network-test input change the physical device. */
		if (!test_input_gamepad(&state->Gamepad, 0) && !input.ui_pointer)
		{
			/* The existing per-axis merge favors keyboard on equal magnitude.
			 * Opposing keys, console input, and overridden axes contribute zero. */
			if (keyboard.sThumbLX && keyboard.sThumbLX == state->Gamepad.sThumbLX)
				movement_axes |= HALO_KEYBOARD_MOVEMENT_X;
			if (keyboard.sThumbLY && keyboard.sThumbLY == state->Gamepad.sThumbLY)
				movement_axes |= HALO_KEYBOARD_MOVEMENT_Y;
		}
	}
	else
	{
		gamepad_index = gamepad_index_for_port(port);
		if (gamepad_index >= 0 && gamepad_index < count)
		{
			look_gamepad = gamepads[gamepad_index];
			sdl_gamepad_state(look_gamepad, &state->Gamepad);
		}
		pthread_mutex_lock(&mouse_lock);
		aim_look_update_gamepad_locked(port, look_gamepad, &state->Gamepad);
		pthread_mutex_unlock(&mouse_lock);
		test_input_gamepad(&state->Gamepad, port);
	}

	pthread_mutex_lock(&mouse_lock);
	keyboard_movement_axes[port] = movement_axes;
	pthread_mutex_unlock(&mouse_lock);
	if (memcmp(&state->Gamepad, &controllers[port].previous, sizeof(state->Gamepad)))
	{
		controllers[port].packet_number++;
		controllers[port].previous = state->Gamepad;
	}
	state->dwPacketNumber = controllers[port].packet_number;
	return ERROR_SUCCESS;
}

DWORD WINAPI XInputSetState(HANDLE device, PXINPUT_FEEDBACK feedback)
{
	int port = controller_port(device);
	SDL_Gamepad *gamepads[PORT_COUNT];
	int gamepad_index;
	int count;

	if (!feedback)
		return ERROR_INVALID_PARAMETER;
	feedback->Header.dwStatus = ERROR_SUCCESS;
	if (port < 0)
		return ERROR_DEVICE_NOT_CONNECTED;
	count = sdl_gamepads(gamepads);
	gamepad_index = gamepad_index_for_port(port);
	if (gamepad_index >= 0 && gamepad_index < count)
	{
		/* the game refreshes the motors every frame; rumble a little longer
		than that so they do not stutter */
		SDL_RumbleGamepad(gamepads[gamepad_index], feedback->Rumble.wLeftMotorSpeed,
			feedback->Rumble.wRightMotorSpeed, 100);
	}
	return ERROR_SUCCESS;
}

DWORD WINAPI XInputDebugInitKeyboardQueue(PXINPUT_DEBUG_KEYQUEUE_PARAMETERS parameters)
{
	(void)parameters;
	return ERROR_SUCCESS;
}

DWORD WINAPI XInputDebugGetKeystroke(PXINPUT_DEBUG_KEYSTROKE keystroke)
{
	struct platform_keystroke next;

	memset(keystroke, 0, sizeof(*keystroke));
	while (platform_next_keystroke(&next))
	{
		BOOL key_up = (next.flags & XINPUT_DEBUG_KEYSTROKE_FLAG_KEYUP) != 0;

		/* key ups always pass, so no key is left latched down */
		if (key_up || next.virtual_key == VK_OEM_3_BACKQUOTE || console_is_active())
		{
			keystroke->VirtualKey = next.virtual_key;
			keystroke->Ascii = next.ascii;
			keystroke->Flags = next.flags;
			return ERROR_SUCCESS;
		}
	}
	return ERROR_HANDLE_EOF;
}
