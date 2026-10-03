/* The keyboard and mouse's bindings (port/linux/src/xinput_sdl.c), from the
real source (input_bindings_test.js extracts it): the defaults are the
mapping the game always had, input.bindings changes them while the game
runs, the web page's staging writes the same setting, and the mouse's
sensitivity and invert follow their settings live. Only SDL and the
settings store are stand-ins. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#define TRUE 1
#define FALSE 0
#define EMSCRIPTEN_KEEPALIVE
typedef int BOOL;
typedef unsigned char BYTE;
typedef unsigned short WORD;
typedef short SHORT;
typedef uint64_t Uint64;

/* SDL's values (SDL_scancode.h, SDL_mouse.h) */
enum
{
	SDL_SCANCODE_A = 4, SDL_SCANCODE_C = 6, SDL_SCANCODE_D = 7, SDL_SCANCODE_E = 8, SDL_SCANCODE_F = 9,
	SDL_SCANCODE_G = 10, SDL_SCANCODE_J = 13, SDL_SCANCODE_K = 14, SDL_SCANCODE_Q = 20, SDL_SCANCODE_R = 21,
	SDL_SCANCODE_S = 22, SDL_SCANCODE_W = 26, SDL_SCANCODE_X = 27, SDL_SCANCODE_Z = 29,
	SDL_SCANCODE_RETURN = 40, SDL_SCANCODE_ESCAPE = 41, SDL_SCANCODE_BACKSPACE = 42, SDL_SCANCODE_TAB = 43,
	SDL_SCANCODE_SPACE = 44, SDL_SCANCODE_F1 = 58, SDL_SCANCODE_RIGHT = 79, SDL_SCANCODE_LEFT = 80,
	SDL_SCANCODE_DOWN = 81, SDL_SCANCODE_UP = 82, SDL_SCANCODE_KP_ENTER = 88, SDL_SCANCODE_LCTRL = 224,
	SDL_SCANCODE_COUNT = 512,
};
enum { SDL_BUTTON_LEFT = 1, SDL_BUTTON_MIDDLE, SDL_BUTTON_RIGHT, SDL_BUTTON_X1, SDL_BUTTON_X2 };
enum { XINPUT_GAMEPAD_DPAD_UP = 1, XINPUT_GAMEPAD_DPAD_DOWN = 2, XINPUT_GAMEPAD_DPAD_LEFT = 4,
	XINPUT_GAMEPAD_DPAD_RIGHT = 8, XINPUT_GAMEPAD_START = 16, XINPUT_GAMEPAD_BACK = 32,
	XINPUT_GAMEPAD_LEFT_THUMB = 64, XINPUT_GAMEPAD_RIGHT_THUMB = 128 };
enum { XINPUT_GAMEPAD_A, XINPUT_GAMEPAD_B, XINPUT_GAMEPAD_X, XINPUT_GAMEPAD_Y,
	XINPUT_GAMEPAD_WHITE, XINPUT_GAMEPAD_BLACK, XINPUT_GAMEPAD_LEFT_TRIGGER, XINPUT_GAMEPAD_RIGHT_TRIGGER };
typedef struct { WORD wButtons; BYTE bAnalogButtons[8]; SHORT sThumbLX, sThumbLY, sThumbRX, sThumbRY; } XINPUT_GAMEPAD;
struct platform_input_state
{
	unsigned char keys[SDL_SCANCODE_COUNT];
	unsigned char mouse_buttons[8];
	float mouse_dx, mouse_dy, mouse_wheel;
	BOOL focused, mouse_released, ui_pointer;
};

static Uint64 ticks = 1000, wheel_press_until_ms;
static Uint64 SDL_GetTicks(void) { return ticks; }
#ifdef HALO_WEB
static double emscripten_get_now(void) { return (double)ticks; }
#endif

/* the settings store */
static char setting_bindings[1024];
static double setting_sensitivity = 1.0;
static int setting_invert;
static unsigned long settings_generation;
static unsigned long config_generation(void) { return settings_generation; }
static void config_copy_string(const char *name, char *buffer, unsigned long size)
{
	(void)name;
	snprintf(buffer, size, "%s", setting_bindings);
}
static double config_real(const char *name) { (void)name; return setting_sensitivity; }
static int config_boolean(const char *name) { (void)name; return setting_invert; }
static int config_set_text(const char *name, const char *text)
{
	if (!strcmp(name, "input.bindings"))
		snprintf(setting_bindings, sizeof(setting_bindings), "%s", text);
	else if (!strcmp(name, "input.mouse_sensitivity"))
		setting_sensitivity = strtod(text, NULL);
	else if (!strcmp(name, "input.invert_mouse"))
		setting_invert = !strcmp(text, "true");
	else
		return 0;
	settings_generation++;
	return 1;
}
static int SDL_GetScancodeFromName(const char *name) { return !strcmp(name, "Left Ctrl") ? SDL_SCANCODE_LCTRL : 0; }
static int logged;
static void platform_log(const char *format, ...) { (void)format; logged++; }
static int SDL_strcasecmp(const char *a, const char *b)
{
	for (; *a && *b; a++, b++)
	{
		int x = *a >= 'A' && *a <= 'Z' ? *a + 32 : *a, y = *b >= 'A' && *b <= 'Z' ? *b + 32 : *b;

		if (x != y)
			return x - y;
	}
	return *a - *b;
}
static char *SDL_strtok_r(char *text, const char *separators, char **state)
{
	char *start = text ? text : *state, *end;

	start += strspn(start, separators);
	if (!*start)
	{
		*state = start;
		return NULL;
	}
	end = start + strcspn(start, separators);
	if (*end)
		*end++ = 0;
	*state = end;
	return start;
}

#ifdef HALO_WEB
static volatile double web_press_until[2];
#endif

#include "bindings.inc"

static int failures;

static void check(int condition, const char *what)
{
	if (!condition)
	{
		printf("FAIL: %s\n", what);
		failures++;
	}
}

static struct platform_input_state input;

static XINPUT_GAMEPAD poll(void)
{
	XINPUT_GAMEPAD pad;

	memset(&pad, 0, sizeof(pad));
	keyboard_gamepad(&input, &pad);
	return pad;
}

/* one key, button or the wheel down; what the controller sees */
static XINPUT_GAMEPAD press(int scancode, int button, int wheel)
{
	XINPUT_GAMEPAD pad;

	memset(&input, 0, sizeof(input));
	if (scancode)
		input.keys[scancode] = 1;
	if (button)
		input.mouse_buttons[button] = 1;
	wheel_press_until_ms = wheel ? ticks + 50 : 0;
	pad = poll();
	memset(&input, 0, sizeof(input));
	wheel_press_until_ms = 0;
	return pad;
}

static int analog_only(XINPUT_GAMEPAD pad, int index)
{
	int other;

	for (other = 0; other < 8; other++)
	{
		if ((other == index) != (pad.bAnalogButtons[other] == 0xff))
			return 0;
	}
	return !pad.wButtons && !pad.sThumbLX && !pad.sThumbLY;
}

static int button_only(XINPUT_GAMEPAD pad, int buttons)
{
	int other;

	for (other = 0; other < 8; other++)
	{
		if (pad.bAnalogButtons[other])
			return 0;
	}
	return pad.wButtons == buttons && !pad.sThumbLX && !pad.sThumbLY;
}

static void bind(const char *spec)
{
	snprintf(setting_bindings, sizeof(setting_bindings), "%s", spec);
	settings_generation++;
}

int main(void)
{
	XINPUT_GAMEPAD pad;
	int index;
	/* the mapping the game always had (port/linux/README.md, "Controls") */
	static const struct { int scancode, button, wheel, analog, buttons; const char *name; } today[] =
	{
		{ SDL_SCANCODE_SPACE, 0, 0, XINPUT_GAMEPAD_A, 0, "space jumps" },
		{ SDL_SCANCODE_RETURN, 0, 0, XINPUT_GAMEPAD_A, 0, "enter is A" },
		{ SDL_SCANCODE_KP_ENTER, 0, 0, XINPUT_GAMEPAD_A, 0, "keypad enter is A" },
		{ SDL_SCANCODE_F, 0, 0, XINPUT_GAMEPAD_B, 0, "F melees" },
		{ SDL_SCANCODE_BACKSPACE, 0, 0, XINPUT_GAMEPAD_B, 0, "backspace is B" },
		{ 0, SDL_BUTTON_X1, 0, XINPUT_GAMEPAD_B, 0, "mouse button 4 is B" },
		{ SDL_SCANCODE_E, 0, 0, XINPUT_GAMEPAD_X, 0, "E is X" },
		{ SDL_SCANCODE_R, 0, 0, XINPUT_GAMEPAD_X, 0, "R is X" },
		{ SDL_SCANCODE_TAB, 0, 0, XINPUT_GAMEPAD_Y, 0, "tab switches weapons" },
		{ 0, 0, 1, XINPUT_GAMEPAD_Y, 0, "the wheel switches weapons" },
		{ SDL_SCANCODE_Q, 0, 0, XINPUT_GAMEPAD_WHITE, 0, "Q is the flashlight" },
		{ SDL_SCANCODE_X, 0, 0, XINPUT_GAMEPAD_BLACK, 0, "X switches grenades" },
		{ SDL_SCANCODE_G, 0, 0, XINPUT_GAMEPAD_LEFT_TRIGGER, 0, "G throws a grenade" },
		{ 0, SDL_BUTTON_RIGHT, 0, XINPUT_GAMEPAD_LEFT_TRIGGER, 0, "the right button throws a grenade" },
		{ 0, SDL_BUTTON_LEFT, 0, XINPUT_GAMEPAD_RIGHT_TRIGGER, 0, "the left button fires" },
		{ SDL_SCANCODE_C, 0, 0, -1, XINPUT_GAMEPAD_LEFT_THUMB, "C crouches" },
		{ SDL_SCANCODE_Z, 0, 0, -1, XINPUT_GAMEPAD_RIGHT_THUMB, "Z zooms" },
		{ 0, SDL_BUTTON_MIDDLE, 0, -1, XINPUT_GAMEPAD_RIGHT_THUMB, "the middle button zooms" },
		{ SDL_SCANCODE_ESCAPE, 0, 0, -1, XINPUT_GAMEPAD_START, "escape is start" },
		{ SDL_SCANCODE_F1, 0, 0, -1, XINPUT_GAMEPAD_BACK, "F1 is back" },
		{ SDL_SCANCODE_UP, 0, 0, -1, XINPUT_GAMEPAD_DPAD_UP, "up is the D-pad" },
		{ SDL_SCANCODE_DOWN, 0, 0, -1, XINPUT_GAMEPAD_DPAD_DOWN, "down is the D-pad" },
		{ SDL_SCANCODE_LEFT, 0, 0, -1, XINPUT_GAMEPAD_DPAD_LEFT, "left is the D-pad" },
		{ SDL_SCANCODE_RIGHT, 0, 0, -1, XINPUT_GAMEPAD_DPAD_RIGHT, "right is the D-pad" },
	};

	/* ---------- the defaults: today's mapping */
	for (index = 0; index < (int)(sizeof(today) / sizeof(today[0])); index++)
	{
		pad = press(today[index].scancode, today[index].button, today[index].wheel);
		check(today[index].analog >= 0 ? analog_only(pad, today[index].analog) : button_only(pad, today[index].buttons),
			today[index].name);
	}
	pad = press(SDL_SCANCODE_W, 0, 0);
	check(pad.sThumbLY == 32767 && !pad.sThumbLX, "W walks forward");
	pad = press(SDL_SCANCODE_S, 0, 0);
	check(pad.sThumbLY == -32767 && !pad.sThumbLX, "S walks back");
	pad = press(SDL_SCANCODE_A, 0, 0);
	check(pad.sThumbLX == -32767 && !pad.sThumbLY, "A strafes left");
	pad = press(SDL_SCANCODE_D, 0, 0);
	check(pad.sThumbLX == 32767 && !pad.sThumbLY, "D strafes right");
	memset(&input, 0, sizeof(input));
	input.keys[SDL_SCANCODE_W] = input.keys[SDL_SCANCODE_D] = 1;
	pad = poll();
	check(pad.sThumbLX == 23169 && pad.sThumbLY == 23169, "W and D walk diagonally on the unit circle");
	pad = press(SDL_SCANCODE_LCTRL, 0, 0);
#ifdef HALO_WEB
	check(button_only(pad, 0), "(web) left ctrl does nothing: Ctrl+W closes the tab");
#else
	check(button_only(pad, XINPUT_GAMEPAD_LEFT_THUMB), "left ctrl crouches");
#endif
	memset(&input, 0, sizeof(input));
	input.mouse_buttons[SDL_BUTTON_LEFT] = 1;
	input.mouse_released = TRUE;
	check(!poll().bAnalogButtons[XINPUT_GAMEPAD_RIGHT_TRIGGER], "a released mouse fires nothing");

	/* ---------- input.bindings, while the game runs */
	bind("jump=key:13;fire=mouse:right,key:14;zoom=;crouch=key:Left Ctrl;nonsense=key:4;melee=key:9,mouse:9,bogus");
	check(analog_only(press(SDL_SCANCODE_J, 0, 0), XINPUT_GAMEPAD_A), "J jumps, as bound");
	check(analog_only(press(SDL_SCANCODE_SPACE, 0, 0), -1), "space no longer jumps: the binding replaces the defaults");
	pad = press(0, SDL_BUTTON_RIGHT, 0);
	check(pad.bAnalogButtons[XINPUT_GAMEPAD_RIGHT_TRIGGER] == 0xff && pad.bAnalogButtons[XINPUT_GAMEPAD_LEFT_TRIGGER] == 0xff,
		"one input on two controls drives both");
	check(analog_only(press(SDL_SCANCODE_K, 0, 0), XINPUT_GAMEPAD_RIGHT_TRIGGER), "K fires, as bound");
	check(analog_only(press(0, SDL_BUTTON_LEFT, 0), -1), "the left button no longer fires");
	check(button_only(press(SDL_SCANCODE_Z, 0, 0), 0), "zoom= unbinds zoom");
	check(button_only(press(SDL_SCANCODE_LCTRL, 0, 0), XINPUT_GAMEPAD_LEFT_THUMB), "a key by its SDL name");
	check(button_only(press(SDL_SCANCODE_C, 0, 0), 0), "C no longer crouches once crouch is bound elsewhere");
	check(analog_only(press(SDL_SCANCODE_F, 0, 0), XINPUT_GAMEPAD_B), "bad inputs are skipped, good ones kept");
	check(analog_only(press(SDL_SCANCODE_E, 0, 0), XINPUT_GAMEPAD_X), "unlisted controls keep their defaults");
	bind("");
	check(analog_only(press(SDL_SCANCODE_SPACE, 0, 0), XINPUT_GAMEPAD_A), "an empty setting is the defaults again");
	bind("wheel=;switch_weapon=key:20");
	check(analog_only(press(0, 0, 1), -1), "the wheel unbound from switching weapons");

#ifdef HALO_WEB
	/* ---------- the web page's staging writes the same setting */
	bind("");
	check(platform_web_bind_input(_input_jump, SDL_SCANCODE_J, INPUT_MOUSE_BUTTON(SDL_BUTTON_X2), 0, 0), "stage jump");
	check(platform_web_bind_input(_input_zoom, 0, 0, 0, 0), "stage zoom, unbound");
	check(!platform_web_bind_input(_input_fire, 999, 0, 0, 0), "an input that is none is refused");
	check(!platform_web_bind_input(NUMBER_OF_INPUT_CONTROLS, SDL_SCANCODE_J, 0, 0, 0), "a control that is none is refused");
	check(platform_web_apply_input_bindings(), "apply");
	check(!strcmp(setting_bindings, "jump=key:13,mouse:5;zoom="), "the staged controls as input.bindings");
	check(analog_only(press(0, SDL_BUTTON_X2, 0), XINPUT_GAMEPAD_A), "applied live: mouse button 5 jumps");
	check(button_only(press(SDL_SCANCODE_Z, 0, 0), 0), "applied live: zoom unbound");
	check(analog_only(press(0, SDL_BUTTON_LEFT, 0), XINPUT_GAMEPAD_RIGHT_TRIGGER), "unstaged controls at their defaults");
	check(platform_web_apply_input_bindings() && !setting_bindings[0], "applying nothing staged is the defaults");

	/* ---------- the Discord Activity's crouch: Left Ctrl and C, staged by the page */
	check(button_only(press(SDL_SCANCODE_LCTRL, 0, 0), 0), "(web) left ctrl does nothing by default");
	check(platform_web_bind_input(_input_crouch, SDL_SCANCODE_LCTRL, SDL_SCANCODE_C, 0, 0), "stage crouch");
	check(platform_web_apply_input_bindings(), "apply crouch");
	check(!strcmp(setting_bindings, "crouch=key:224,key:6"), "the Activity's crouch as input.bindings");
	check(button_only(press(SDL_SCANCODE_LCTRL, 0, 0), XINPUT_GAMEPAD_LEFT_THUMB), "left ctrl crouches when bound");
	check(button_only(press(SDL_SCANCODE_C, 0, 0), XINPUT_GAMEPAD_LEFT_THUMB), "C still crouches");
	check(platform_web_apply_input_bindings() && !setting_bindings[0], "and the web defaults again");
	check(button_only(press(SDL_SCANCODE_LCTRL, 0, 0), 0), "left ctrl unbound again");

	/* ---------- the mouse's settings, live */
	mouse_settings_refresh();
	check(mouse_sensitivity_value == 1.0f && !mouse_invert_value, "sensitivity 1, not inverted");
	check(platform_web_set_mouse_sensitivity(2.5) && platform_web_set_invert_mouse(1), "set from the page");
	mouse_settings_refresh();
	check(mouse_sensitivity_value == 2.5f && mouse_invert_value, "applied at once");
	check(!platform_web_set_mouse_sensitivity(0.0) && !platform_web_set_mouse_sensitivity(100.0), "out of range refused");
	check(platform_web_set_invert_mouse(0), "invert off");
	mouse_settings_refresh();
	check(!mouse_invert_value && mouse_sensitivity_value == 2.5f, "invert off, sensitivity kept");
#endif

	if (!failures)
		printf("input bindings tests passed\n");
	return failures ? 1 : 0;
}
