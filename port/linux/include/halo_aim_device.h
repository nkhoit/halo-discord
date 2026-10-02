#ifndef HALO_AIM_DEVICE_H
#define HALO_AIM_DEVICE_H

#include <stdint.h>

/* input_xbox.c applies the same 9000-unit deadzone to each stick axis. */
#define HALO_AIM_STICK_DEADZONE 9000
#define HALO_AIM_STICK_ENTER_THRESHOLD 10000
#define HALO_AIM_STICK_EXIT_THRESHOLD 8000
#define HALO_AIM_STICK_MOTION_THRESHOLD 1000
#define HALO_AIM_STICK_RELEASE_HYSTERESIS_MS 160

enum halo_aim_look_device
{
	_halo_aim_look_device_mouse,
	_halo_aim_look_device_controller
};

struct halo_aim_look_state
{
	enum halo_aim_look_device default_device;
	enum halo_aim_look_device active_device;
	short motion_reference_x;
	short motion_reference_y;
	uint64_t release_at_ms;
	int have_motion_reference;
	int controller_engaged;
};

static inline void halo_aim_look_state_reset(
	struct halo_aim_look_state *state,
	enum halo_aim_look_device default_device)
{
	state->default_device = default_device;
	state->active_device = default_device;
	state->motion_reference_x = 0;
	state->motion_reference_y = 0;
	state->release_at_ms = 0;
	state->have_motion_reference = 0;
	state->controller_engaged = 0;
}

static inline int halo_aim_look_camera_assist_allowed(
	const struct halo_aim_look_state *state)
{
	return state->active_device == _halo_aim_look_device_controller;
}

static inline void halo_aim_look_note_mouse_motion(
	struct halo_aim_look_state *state,
	int real_motion)
{
	if (real_motion)
		state->active_device = _halo_aim_look_device_mouse;
}

static inline unsigned halo_aim_look_axis_magnitude(int value)
{
	return (unsigned)(value < 0 ? -value : value);
}

static inline void halo_aim_look_note_controller_sample(
	struct halo_aim_look_state *state,
	short x,
	short y,
	uint64_t now_ms)
{
	unsigned magnitude_x = halo_aim_look_axis_magnitude(x);
	unsigned magnitude_y = halo_aim_look_axis_magnitude(y);
	unsigned magnitude = magnitude_x > magnitude_y ? magnitude_x : magnitude_y;
	int moved = state->have_motion_reference &&
		(halo_aim_look_axis_magnitude((int)x - state->motion_reference_x) >=
			HALO_AIM_STICK_MOTION_THRESHOLD ||
		halo_aim_look_axis_magnitude((int)y - state->motion_reference_y) >=
			HALO_AIM_STICK_MOTION_THRESHOLD);

	if (!state->have_motion_reference)
	{
		state->motion_reference_x = x;
		state->motion_reference_y = y;
		state->have_motion_reference = 1;
	}

	if (state->controller_engaged)
	{
		if (magnitude < HALO_AIM_STICK_EXIT_THRESHOLD)
		{
			state->controller_engaged = 0;
			state->release_at_ms = now_ms + HALO_AIM_STICK_RELEASE_HYSTERESIS_MS;
		}
		else if (moved)
		{
			state->active_device = _halo_aim_look_device_controller;
			state->motion_reference_x = x;
			state->motion_reference_y = y;
			state->release_at_ms = 0;
		}
	}
	else if (magnitude > HALO_AIM_STICK_ENTER_THRESHOLD)
	{
		state->controller_engaged = 1;
		state->active_device = _halo_aim_look_device_controller;
		state->motion_reference_x = x;
		state->motion_reference_y = y;
		state->release_at_ms = 0;
	}

	if (!state->controller_engaged &&
		state->active_device == _halo_aim_look_device_controller &&
		state->release_at_ms != 0 && now_ms >= state->release_at_ms)
	{
		state->active_device = state->default_device;
		state->release_at_ms = 0;
	}
}

/* Keep this exact camera-only blend shared by the game and its behavior test. */
static inline float halo_aim_camera_assist_blend(
	int enabled,
	float look_delta,
	float target_angular_velocity,
	float input_scale,
	float magnetism_scale)
{
	if (!enabled)
		return look_delta;
	return target_angular_velocity * magnetism_scale + look_delta * input_scale;
}

#endif
