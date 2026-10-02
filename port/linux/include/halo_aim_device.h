#ifndef HALO_AIM_DEVICE_H
#define HALO_AIM_DEVICE_H

#include <stdint.h>

/* Match input_xbox.c: every axis strictly beyond 9000 produces look. */
#define HALO_AIM_STICK_DEADZONE 9000
#define HALO_AIM_STICK_EXIT_THRESHOLD 8000
#define HALO_AIM_STICK_MOTION_THRESHOLD 1000

enum halo_aim_look_device
{
	_halo_aim_look_device_mouse,
	_halo_aim_look_device_controller
};

struct halo_aim_look_state
{
	enum halo_aim_look_device active_device;
	short motion_reference_x;
	short motion_reference_y;
	int controller_engaged;
};

static inline void halo_aim_look_clear_controller_sample(struct halo_aim_look_state *state)
{
	state->motion_reference_x = 0;
	state->motion_reference_y = 0;
	state->controller_engaged = 0;
}

static inline void halo_aim_look_state_reset(
	struct halo_aim_look_state *state,
	enum halo_aim_look_device default_device)
{
	state->active_device = default_device;
	halo_aim_look_clear_controller_sample(state);
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
	int moved =
		halo_aim_look_axis_magnitude((int)x - state->motion_reference_x) >=
			HALO_AIM_STICK_MOTION_THRESHOLD ||
		halo_aim_look_axis_magnitude((int)y - state->motion_reference_y) >=
			HALO_AIM_STICK_MOTION_THRESHOLD;

	(void)now_ms;
	/* Hysteresis rejects center chatter; it never expires the last owner. */
	if (magnitude < HALO_AIM_STICK_EXIT_THRESHOLD)
		halo_aim_look_clear_controller_sample(state);
	else if (magnitude > HALO_AIM_STICK_DEADZONE &&
		(!state->controller_engaged || moved))
	{
		state->controller_engaged = 1;
		state->active_device = _halo_aim_look_device_controller;
		state->motion_reference_x = x;
		state->motion_reference_y = y;
	}
}

/* Camera-only blend shared by the game and its behavior tests. */
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
