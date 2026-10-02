#ifndef HALO_MOVEMENT_SOURCE_H
#define HALO_MOVEMENT_SOURCE_H

/* Physical left-stick axes won by keyboard input in the current XInput poll.
 * These are contribution bits, not a persistent active-device preference. */
#define HALO_KEYBOARD_MOVEMENT_X 1u
#define HALO_KEYBOARD_MOVEMENT_Y 2u

unsigned halo_linux_keyboard_movement_axes(short gamepad_index);

#endif
