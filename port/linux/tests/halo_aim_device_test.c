#include <math.h>
#include <stdio.h>
#include <stdlib.h>

#include "halo_aim_device.h"

#define CHECK(condition, message) \
	do { \
		if (!(condition)) { \
			fprintf(stderr, "FAIL: %s (line %d)\n", message, __LINE__); \
			return 1; \
		} \
	} while (0)

static int near(float actual, float expected)
{
	return fabsf(actual - expected) < 0.00001f;
}

/* Reproducible baseline mode restores the original unconditional camera blend
for a red regression run; the normal mode calls the production helper. */
static float test_camera_assist_blend(
	int enabled,
	float look_delta,
	float target_angular_velocity,
	float input_scale,
	float magnetism_scale)
{
#ifdef HALO_AIM_REPRODUCE_BASELINE
	(void)enabled;
	return target_angular_velocity * magnetism_scale + look_delta * input_scale;
#else
	return halo_aim_camera_assist_blend(
		enabled, look_delta, target_angular_velocity, input_scale, magnetism_scale);
#endif
}

static int test_keyboard_mouse_default_and_no_camera_pull(void)
{
	struct halo_aim_look_state player0;
	float look_delta = 0.25f;
	int wasd_forward = 1;
	int mouse_delta = 0;

	halo_aim_look_state_reset(&player0, _halo_aim_look_device_mouse);
	halo_aim_look_note_controller_sample(&player0, 0, 0, 100);
	halo_aim_look_note_mouse_motion(&player0, mouse_delta != 0);
	CHECK(wasd_forward, "keyboard movement should remain independent of look-source tracking");
	CHECK(!halo_aim_look_camera_assist_allowed(&player0),
		"keyboard-only/no-input port 0 defaults to mouse look");
	CHECK(near(test_camera_assist_blend(
			 halo_aim_look_camera_assist_allowed(&player0), look_delta, 0.8f, 0.5f, 0.6f),
		 look_delta), "WASD with no mouse delta must not receive camera pull");

	halo_aim_look_note_mouse_motion(&player0, 1);
	halo_aim_look_note_mouse_motion(&player0, 0);
	CHECK(!halo_aim_look_camera_assist_allowed(&player0),
		"mouse remains the look device after the current mouse delta is consumed");
	CHECK(near(test_camera_assist_blend(
			 halo_aim_look_camera_assist_allowed(&player0), look_delta, 0.8f, 0.5f, 0.6f),
		 look_delta), "a later no-delta frame must still have no camera pull");
	return 0;
}

static int test_controller_parity_and_mixed_input(void)
{
	struct halo_aim_look_state player0, player1, player2, player3;
	float look_delta = -0.2f;
	float blended;
	int wasd_forward = 1;

	halo_aim_look_state_reset(&player0, _halo_aim_look_device_mouse);
	halo_aim_look_state_reset(&player1, _halo_aim_look_device_controller);
	halo_aim_look_state_reset(&player2, _halo_aim_look_device_controller);
	halo_aim_look_state_reset(&player3, _halo_aim_look_device_controller);
	CHECK(!halo_aim_look_camera_assist_allowed(&player0), "port 0 defaults to mouse on a keyboard-only client");
	CHECK(halo_aim_look_camera_assist_allowed(&player1) &&
		halo_aim_look_camera_assist_allowed(&player2) &&
		halo_aim_look_camera_assist_allowed(&player3),
		"controller camera assist defaults are preserved for ports 1-3");
	CHECK(HALO_AIM_STICK_ENTER_THRESHOLD > HALO_AIM_STICK_DEADZONE &&
		HALO_AIM_STICK_EXIT_THRESHOLD < HALO_AIM_STICK_DEADZONE,
		"controller activation and release use a deadzone hysteresis band");

	halo_aim_look_note_controller_sample(&player0, 16000, -3000, 200);
	halo_aim_look_note_controller_sample(&player1, -22000, 0, 200);
	CHECK(wasd_forward, "keyboard movement can coexist with right-stick look");
	CHECK(halo_aim_look_camera_assist_allowed(&player0),
		"intentional controller look takes ownership on the keyboard/mouse port");
	CHECK(halo_aim_look_camera_assist_allowed(&player1),
		"controller-only local player keeps camera assist by default");
	blended = test_camera_assist_blend(
		halo_aim_look_camera_assist_allowed(&player0), look_delta, 0.5f, 0.8f, 0.4f);
	CHECK(near(blended, 0.04f), "intentional controller look retains the original friction/adhesion blend");

	halo_aim_look_note_mouse_motion(&player0, 1);
	CHECK(!halo_aim_look_camera_assist_allowed(&player0),
		"real mouse motion switches port 0 back to mouse look");
	CHECK(halo_aim_look_camera_assist_allowed(&player1),
		"a mouse event on player 0 cannot change another local player's device");
	halo_aim_look_note_controller_sample(&player0, 16000, -3000, 216);
	CHECK(!halo_aim_look_camera_assist_allowed(&player0),
		"a held, unchanged stick cannot steal ownership back after newer mouse motion");
	halo_aim_look_note_controller_sample(&player0, 16400, -3000, 232);
	halo_aim_look_note_controller_sample(&player0, 16800, -3000, 248);
	CHECK(!halo_aim_look_camera_assist_allowed(&player0),
		"small per-frame stick noise is accumulated but does not switch ownership");
	halo_aim_look_note_controller_sample(&player0, 17000, -3000, 264);
	CHECK(halo_aim_look_camera_assist_allowed(&player0),
		"cumulative intentional stick movement switches ownership back to controller");
	return 0;
}

static int test_noise_deadzone_and_release_hysteresis(void)
{
	struct halo_aim_look_state player0;
	uint64_t released_at = 500;

	halo_aim_look_state_reset(&player0, _halo_aim_look_device_mouse);
	halo_aim_look_note_controller_sample(&player0, 9500, 0, released_at);
	halo_aim_look_note_controller_sample(&player0, 9999, 200, released_at + 16);
	CHECK(!halo_aim_look_camera_assist_allowed(&player0),
		"resting-stick noise below the activation threshold cannot enable controller assist");
	CHECK(!player0.controller_engaged, "sub-threshold noise does not latch controller state");

	halo_aim_look_note_controller_sample(&player0, 15000, 0, released_at + 32);
	CHECK(halo_aim_look_camera_assist_allowed(&player0), "a stick past the deadzone activates controller look");
	halo_aim_look_note_controller_sample(&player0, 8500, 0, released_at + 48);
	CHECK(halo_aim_look_camera_assist_allowed(&player0),
		"the exit band prevents near-center noise from immediately flipping ownership");
	halo_aim_look_note_controller_sample(&player0, 7000, 0, released_at + 64);
	CHECK(halo_aim_look_camera_assist_allowed(&player0), "controller source is held briefly on stick release");
	halo_aim_look_note_controller_sample(&player0, 0, 0, released_at + 223);
	CHECK(halo_aim_look_camera_assist_allowed(&player0), "release hysteresis lasts through its configured interval");
	halo_aim_look_note_controller_sample(&player0, 0, 0, released_at + 224);
	CHECK(!halo_aim_look_camera_assist_allowed(&player0), "expired controller state returns to the keyboard/mouse default");
	return 0;
}

static int test_hotplug_reset_clears_stale_state(void)
{
	struct halo_aim_look_state player0;

	halo_aim_look_state_reset(&player0, _halo_aim_look_device_mouse);
	halo_aim_look_note_controller_sample(&player0, 20000, 0, 1000);
	CHECK(halo_aim_look_camera_assist_allowed(&player0), "precondition: controller owns look");

	/* XInput open/close or a changed SDL gamepad identity resets this state. */
	halo_aim_look_state_reset(&player0, _halo_aim_look_device_mouse);
	CHECK(!halo_aim_look_camera_assist_allowed(&player0), "hotplug reset clears the stale controller owner");
	CHECK(!player0.have_motion_reference && !player0.controller_engaged,
		"hotplug reset clears old stick samples and engagement");
	halo_aim_look_note_controller_sample(&player0, 0, 0, 1016);
	CHECK(!halo_aim_look_camera_assist_allowed(&player0), "a neutral reconnected controller does not steal look");
	halo_aim_look_note_controller_sample(&player0, -18000, 0, 1032);
	CHECK(halo_aim_look_camera_assist_allowed(&player0), "intentional post-hotplug stick input is recognized");
	return 0;
}

int main(void)
{
	if (test_keyboard_mouse_default_and_no_camera_pull() ||
		test_controller_parity_and_mixed_input() ||
		test_noise_deadzone_and_release_hysteresis() ||
		test_hotplug_reset_clears_stale_state())
		return EXIT_FAILURE;

	puts("PASS: keyboard/mouse default and no-pull behavior");
	puts("PASS: controller parity, intentional switching, and mixed local players");
	puts("PASS: deadzone noise rejection and release hysteresis");
	puts("PASS: hotplug reset clears stale controller state");
	return EXIT_SUCCESS;
}
