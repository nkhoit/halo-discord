/*
RENDER_INTERPOLATION.C

Frames between the game's 30 Hz ticks, for the native ports (port/linux,
port/android, port/windows; see port/linux/README.md, "Frame rate").

The game simulates in 30 Hz ticks and originally drew one frame per tick.
The ports draw at the display's refresh rate instead, and every frame shows
the world between the last two ticks: after each tick the camera, every
object's node matrices and the first-person weapon's pose are kept, and a
frame blends the previous and the latest by how far the game clock has run
into the next tick. That puts what is drawn one tick (33 ms) behind the
simulation, the usual price of interpolation. (A Catmull-Rom spline would
also need the tick after the pair it spans: two ticks behind.)

Rotations are blended as quaternions (normalised lerp, taking the shorter
way round), positions and scales linearly. Anything that moves further than
a tick of motion plausibly allows (teleports, respawns, camera cuts) snaps
instead of sweeping across the world.

Particles, contrails and other effects already move every frame
(game_frame), so they need nothing here.

An object the distributed netcode moves to where the host has it
(port/linux/game/network_objects.c) is drawn gliding there over a few ticks
rather than jumping: its snapshots move with it, and the difference is drawn
on top of it, fading each tick.
*/

#include "cseries.h"
#include "math/real_math.h"
#include "objects/objects.h"
#include "camera/observer.h"
#include "game/players.h"
#include "render/render_cameras.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#ifdef HALO_WEB
#include <emscripten.h>
#include "units/units.h"

static void web_snap_frame(short local_player_index, struct observer_result const *drawn, boolean cut);
static double web_tick_time;
#endif

/* ---------- constants */

#define MAXIMUM_INTERPOLATED_OBJECTS (MAXIMUM_OBJECTS_PER_MAP * 5)
#define MAXIMUM_INTERPOLATED_NODES 64

/* world units (10 feet each) a node may move in one tick before it snaps:
well beyond any vehicle, short of any teleport */
#define OBJECT_SNAP_DISTANCE 10.0f
/* a correction's difference left drawn after each tick (of 1) */
#define CORRECTION_DECAY 0.6f
/* ... and small enough to be none */
#define CORRECTION_NEGLIGIBLE 0.001f
/* a camera cut: a jump no player makes in 33 ms, or a turn to nearly the
opposite way. (A turn past 60 degrees in a tick used to cut too, but a fast
mouse flick turns that much: the frame drew the latest tick unblended, a tick
ahead, and the aim jumped back as soon as blending resumed.) */
#define CAMERA_CUT_DISTANCE 3.0f
#define CAMERA_CUT_COSINE -0.866f

/* ---------- structures */

struct interpolation_quaternion
{
	real i, j, k, w;
};

struct interpolated_object
{
	long object_index; /* NONE when unused */
	long tick; /* the tick of the latest snapshot */
	short node_count;
	short node_capacity;
	boolean has_previous;
	byte latest; /* which snapshot is the latest */
	long blended_frame;
	/* where it is drawn from where it is: a correction fading */
	real_vector3d correction;
	/* [0] and [1]: the two snapshots, [2]: the blend drawn this frame */
	real_matrix4x3 *nodes;
};

struct interpolated_camera
{
	long tick;
	boolean valid;
	boolean has_previous;
	struct observer_result previous;
	struct observer_result latest;
	struct observer_result blended;
};

struct interpolated_first_person
{
	long tick;
	short node_count;
	boolean has_previous;
	real_matrix4x3 previous[MAXIMUM_INTERPOLATED_NODES];
	real_matrix4x3 latest[MAXIMUM_INTERPOLATED_NODES];
};

/* ---------- globals */

static struct interpolated_object *interpolated_objects;
static struct interpolated_camera interpolated_cameras[MAXIMUM_LOCAL_PLAYERS];
static struct interpolated_first_person interpolated_first_person[MAXIMUM_LOCAL_PLAYERS];
static long interpolation_tick;
static long interpolation_frame;
static boolean interpolation_rendering;
static real interpolation_fraction = 1.0f;

/* ---------- blending */

static real lerp(real a, real b, real t)
{
	return a + (b - a) * t;
}

static void point_lerp(real_point3d const *a, real_point3d const *b, real t, real_point3d *result)
{
	result->x = lerp(a->x, b->x, t);
	result->y = lerp(a->y, b->y, t);
	result->z = lerp(a->z, b->z, t);
}

static real vector_length(real_vector3d const *v)
{
	return (real)sqrt(v->i * v->i + v->j * v->j + v->k * v->k);
}

static void vector_nlerp(real_vector3d const *a, real_vector3d const *b, real t, real_vector3d *result)
{
	real length;

	result->i = lerp(a->i, b->i, t);
	result->j = lerp(a->j, b->j, t);
	result->k = lerp(a->k, b->k, t);
	length = vector_length(result);
	if (length > 1e-6f)
	{
		result->i /= length;
		result->j /= length;
		result->k /= length;
	}
	else
	{
		*result = *b;
	}
}

/* an orthonormal right-handed basis, which a quaternion can represent */
static boolean basis_is_rotation(real_matrix4x3 const *matrix)
{
	real_vector3d cross;
	real determinant;

	if (fabs(vector_length(&matrix->forward) - 1.0f) > 1e-2f ||
		fabs(vector_length(&matrix->left) - 1.0f) > 1e-2f ||
		fabs(vector_length(&matrix->up) - 1.0f) > 1e-2f)
	{
		return FALSE;
	}
	cross.i = matrix->forward.j * matrix->left.k - matrix->forward.k * matrix->left.j;
	cross.j = matrix->forward.k * matrix->left.i - matrix->forward.i * matrix->left.k;
	cross.k = matrix->forward.i * matrix->left.j - matrix->forward.j * matrix->left.i;
	determinant = cross.i * matrix->up.i + cross.j * matrix->up.j + cross.k * matrix->up.k;
	return determinant > 0.5f;
}

/* the basis vectors are the matrix's columns (x forward, y left, z up) */
static void quaternion_from_basis(real_matrix4x3 const *matrix, struct interpolation_quaternion *q)
{
	real m00 = matrix->forward.i, m10 = matrix->forward.j, m20 = matrix->forward.k;
	real m01 = matrix->left.i, m11 = matrix->left.j, m21 = matrix->left.k;
	real m02 = matrix->up.i, m12 = matrix->up.j, m22 = matrix->up.k;
	real trace = m00 + m11 + m22;
	real s;

	if (trace > 0.0f)
	{
		s = 0.5f / (real)sqrt(trace + 1.0f);
		q->w = 0.25f / s;
		q->i = (m21 - m12) * s;
		q->j = (m02 - m20) * s;
		q->k = (m10 - m01) * s;
	}
	else if (m00 > m11 && m00 > m22)
	{
		s = 2.0f * (real)sqrt(1.0f + m00 - m11 - m22);
		q->w = (m21 - m12) / s;
		q->i = 0.25f * s;
		q->j = (m01 + m10) / s;
		q->k = (m02 + m20) / s;
	}
	else if (m11 > m22)
	{
		s = 2.0f * (real)sqrt(1.0f + m11 - m00 - m22);
		q->w = (m02 - m20) / s;
		q->i = (m01 + m10) / s;
		q->j = 0.25f * s;
		q->k = (m12 + m21) / s;
	}
	else
	{
		s = 2.0f * (real)sqrt(1.0f + m22 - m00 - m11);
		q->w = (m10 - m01) / s;
		q->i = (m02 + m20) / s;
		q->j = (m12 + m21) / s;
		q->k = 0.25f * s;
	}
}

static void basis_from_quaternion(struct interpolation_quaternion const *q, real_matrix4x3 *matrix)
{
	real ii = q->i * q->i, jj = q->j * q->j, kk = q->k * q->k;
	real ij = q->i * q->j, ik = q->i * q->k, jk = q->j * q->k;
	real wi = q->w * q->i, wj = q->w * q->j, wk = q->w * q->k;

	matrix->forward.i = 1.0f - 2.0f * (jj + kk);
	matrix->forward.j = 2.0f * (ij + wk);
	matrix->forward.k = 2.0f * (ik - wj);
	matrix->left.i = 2.0f * (ij - wk);
	matrix->left.j = 1.0f - 2.0f * (ii + kk);
	matrix->left.k = 2.0f * (jk + wi);
	matrix->up.i = 2.0f * (ik + wj);
	matrix->up.j = 2.0f * (jk - wi);
	matrix->up.k = 1.0f - 2.0f * (ii + jj);
}

/* a matrix a fraction t of the way from a to b */
static void matrix_blend(real_matrix4x3 const *a, real_matrix4x3 const *b, real t, real_matrix4x3 *result)
{
	result->scale = lerp(a->scale, b->scale, t);
	point_lerp(&a->position, &b->position, t, &result->position);
	if (basis_is_rotation(a) && basis_is_rotation(b))
	{
		struct interpolation_quaternion qa, qb, q;
		real length;

		quaternion_from_basis(a, &qa);
		quaternion_from_basis(b, &qb);
		/* q and -q are the same rotation: take the shorter way round */
		if (qa.i * qb.i + qa.j * qb.j + qa.k * qb.k + qa.w * qb.w < 0.0f)
		{
			qb.i = -qb.i;
			qb.j = -qb.j;
			qb.k = -qb.k;
			qb.w = -qb.w;
		}
		q.i = lerp(qa.i, qb.i, t);
		q.j = lerp(qa.j, qb.j, t);
		q.k = lerp(qa.k, qb.k, t);
		q.w = lerp(qa.w, qb.w, t);
		length = (real)sqrt(q.i * q.i + q.j * q.j + q.k * q.k + q.w * q.w);
		if (length > 1e-6f)
		{
			q.i /= length;
			q.j /= length;
			q.k /= length;
			q.w /= length;
			basis_from_quaternion(&q, result);
			return;
		}
	}
	/* a basis a quaternion cannot hold (scaled or mirrored): blend it as is */
	result->forward.i = lerp(a->forward.i, b->forward.i, t);
	result->forward.j = lerp(a->forward.j, b->forward.j, t);
	result->forward.k = lerp(a->forward.k, b->forward.k, t);
	result->left.i = lerp(a->left.i, b->left.i, t);
	result->left.j = lerp(a->left.j, b->left.j, t);
	result->left.k = lerp(a->left.k, b->left.k, t);
	result->up.i = lerp(a->up.i, b->up.i, t);
	result->up.j = lerp(a->up.j, b->up.j, t);
	result->up.k = lerp(a->up.k, b->up.k, t);
}

static real distance_squared(real_point3d const *a, real_point3d const *b)
{
	real x = a->x - b->x, y = a->y - b->y, z = a->z - b->z;

	return x * x + y * y + z * z;
}

/* ---------- ticks */

void render_interpolation_tick(void)
{
	struct object_iterator iterator;
	struct object_datum *object;
	long previous_tick = interpolation_tick++;

#ifdef HALO_WEB
	web_tick_time = emscripten_get_now();
#endif
	if (!halo_interpolation_enabled())
		return;
	if (!interpolated_objects)
	{
		long index;

		interpolated_objects = calloc(MAXIMUM_INTERPOLATED_OBJECTS, sizeof(*interpolated_objects));
		if (!interpolated_objects)
			return;
		for (index = 0; index < MAXIMUM_INTERPOLATED_OBJECTS; index++)
			interpolated_objects[index].object_index = NONE;
	}

	object_iterator_new(&iterator, _object_mask_all, 0);
	while ((object = (struct object_datum *)object_iterator_next(&iterator)) != NULL)
	{
		long absolute_index = DATUM_INDEX_TO_ABSOLUTE_INDEX(iterator.index);
		struct interpolated_object *record;
		short node_count = (short)(object->object.node_matrices.size / (short)sizeof(real_matrix4x3));
		boolean continuing;

		if (absolute_index >= MAXIMUM_INTERPOLATED_OBJECTS)
			continue;
		record = &interpolated_objects[absolute_index];
		if (node_count <= 0 || node_count > MAXIMUM_INTERPOLATED_NODES)
		{
			record->object_index = NONE;
			continue;
		}
		if (record->node_capacity < node_count)
		{
			real_matrix4x3 *nodes = realloc(record->nodes, 3 * node_count * sizeof(real_matrix4x3));

			if (!nodes)
			{
				record->object_index = NONE;
				continue;
			}
			record->nodes = nodes;
			record->node_capacity = node_count;
			record->object_index = NONE; /* the old snapshots moved */
		}
		continuing = record->object_index == iterator.index &&
			record->node_count == node_count &&
			record->tick == previous_tick;
		if (continuing)
		{
			record->latest ^= 1;
			record->correction.i *= CORRECTION_DECAY;
			record->correction.j *= CORRECTION_DECAY;
			record->correction.k *= CORRECTION_DECAY;
			if (fabs(record->correction.i) + fabs(record->correction.j) + fabs(record->correction.k) < CORRECTION_NEGLIGIBLE)
				record->correction = *global_zero_vector3d;
		}
		else
		{
			record->correction = *global_zero_vector3d;
		}
		memcpy(
			record->nodes + record->latest * record->node_capacity,
			object_get_node_matrices(iterator.index),
			node_count * sizeof(real_matrix4x3));
		record->object_index = iterator.index;
		record->node_count = node_count;
		record->tick = interpolation_tick;
		record->has_previous = continuing;
		record->blended_frame = NONE;
	}
}

/* ---------- frames */

void render_interpolation_frame_begin(void)
{
	interpolation_rendering = halo_interpolation_enabled();
	interpolation_frame++;
	interpolation_fraction = game_time_get_tick_fraction();
}

void render_interpolation_frame_end(void)
{
	interpolation_rendering = FALSE;
}

real render_interpolation_fraction(void)
{
	return interpolation_rendering ? interpolation_fraction : 1.0f;
}

real_matrix4x3 *render_interpolation_object_node_matrices(long object_index)
{
	struct interpolated_object *record;
	long absolute_index;

	if (!interpolation_rendering || !interpolated_objects || object_index == NONE)
		return NULL;
	absolute_index = DATUM_INDEX_TO_ABSOLUTE_INDEX(object_index);
	if (absolute_index >= MAXIMUM_INTERPOLATED_OBJECTS)
		return NULL;
	record = &interpolated_objects[absolute_index];
	if (record->object_index != object_index || record->tick != interpolation_tick || !record->has_previous)
		return NULL;
	if (record->blended_frame != interpolation_frame)
	{
		real_matrix4x3 const *previous = record->nodes + (record->latest ^ 1) * record->node_capacity;
		real_matrix4x3 const *latest = record->nodes + record->latest * record->node_capacity;
		real_matrix4x3 *blended = record->nodes + 2 * record->node_capacity;
		short node_index;

		if (distance_squared(&previous[0].position, &latest[0].position) >
			OBJECT_SNAP_DISTANCE * OBJECT_SNAP_DISTANCE)
		{
			memcpy(blended, latest, record->node_count * sizeof(real_matrix4x3));
		}
		else
		{
			for (node_index = 0; node_index < record->node_count; node_index++)
				matrix_blend(&previous[node_index], &latest[node_index], interpolation_fraction, &blended[node_index]);
		}
		/* (a correction fading through the tick as it does tick to tick) */
		if (record->correction.i != 0.0f || record->correction.j != 0.0f || record->correction.k != 0.0f)
		{
			real fade = lerp(1.0f, CORRECTION_DECAY, interpolation_fraction);

			for (node_index = 0; node_index < record->node_count; node_index++)
			{
				blended[node_index].position.x += record->correction.i * fade;
				blended[node_index].position.y += record->correction.j * fade;
				blended[node_index].position.z += record->correction.k * fade;
			}
		}
		record->blended_frame = interpolation_frame;
	}
	return record->nodes + 2 * record->node_capacity;
}

/* ---------- corrections */

/* the object (and what it carries) moved by the netcode from where it was,
offset from where it is now: drawn from there, gliding */
void render_interpolation_correct_object(long object_index, real_vector3d const *offset)
{
	struct object_datum *object;
	long child_index;
	long absolute_index;

	if (!interpolated_objects || object_index == NONE ||
		offset->i * offset->i + offset->j * offset->j + offset->k * offset->k > OBJECT_SNAP_DISTANCE * OBJECT_SNAP_DISTANCE)
	{
		return;
	}
	absolute_index = DATUM_INDEX_TO_ABSOLUTE_INDEX(object_index);
	if (absolute_index < MAXIMUM_INTERPOLATED_OBJECTS &&
		interpolated_objects[absolute_index].object_index == object_index)
	{
		struct interpolated_object *record = &interpolated_objects[absolute_index];
		short snapshot;
		short node_index;

		/* the snapshots where it would have been, the difference drawn */
		for (snapshot = 0; snapshot < 2; snapshot++)
		{
			real_matrix4x3 *nodes = record->nodes + snapshot * record->node_capacity;

			for (node_index = 0; node_index < record->node_count; node_index++)
			{
				nodes[node_index].position.x -= offset->i;
				nodes[node_index].position.y -= offset->j;
				nodes[node_index].position.z -= offset->k;
			}
		}
		record->correction.i += offset->i;
		record->correction.j += offset->j;
		record->correction.k += offset->k;
		record->blended_frame = NONE;
	}
	object = object_get(object_index);
	for (child_index = object->object.first_child_object_index; child_index != NONE;
		child_index = object_get(child_index)->object.next_object_index)
	{
		render_interpolation_correct_object(child_index, offset);
	}
}

/* ---------- camera */

static struct observer_result const *interpolated_camera(
	short local_player_index,
	struct observer_result const *observer);

struct observer_result const *render_interpolation_camera(
	short local_player_index,
	struct observer_result const *observer)
{
	struct observer_result const *drawn = interpolated_camera(local_player_index, observer);

#ifdef HALO_WEB
	if (interpolation_rendering && drawn && local_player_index == 0)
		web_snap_frame(local_player_index, drawn, drawn == observer);
#endif
	return drawn;
}

static struct observer_result const *interpolated_camera(
	short local_player_index,
	struct observer_result const *observer)
{
	struct interpolated_camera *camera;
	real t = interpolation_fraction;

	if (!interpolation_rendering || !observer ||
		local_player_index < 0 || local_player_index >= MAXIMUM_LOCAL_PLAYERS)
	{
		return observer;
	}
	camera = &interpolated_cameras[local_player_index];
	/* the observer as it stood after each tick (the first frame drawn
	after the tick) */
	if (!camera->valid || camera->tick != interpolation_tick)
	{
		camera->has_previous = camera->valid;
		camera->previous = camera->latest;
		camera->latest = *observer;
		camera->tick = interpolation_tick;
		camera->valid = TRUE;
	}
	if (!camera->has_previous ||
		distance_squared(&camera->previous.position, &camera->latest.position) >
			CAMERA_CUT_DISTANCE * CAMERA_CUT_DISTANCE ||
		camera->previous.forward.i * camera->latest.forward.i +
			camera->previous.forward.j * camera->latest.forward.j +
			camera->previous.forward.k * camera->latest.forward.k < CAMERA_CUT_COSINE)
	{
		return observer;
	}

	camera->blended = camera->latest;
	point_lerp(&camera->previous.position, &camera->latest.position, t, &camera->blended.position);
	vector_nlerp(&camera->previous.forward, &camera->latest.forward, t, &camera->blended.forward);
	vector_nlerp(&camera->previous.up, &camera->latest.up, t, &camera->blended.up);
	{
		/* keep up perpendicular to forward */
		real_vector3d *forward = &camera->blended.forward;
		real_vector3d *up = &camera->blended.up;
		real along = up->i * forward->i + up->j * forward->j + up->k * forward->k;
		real length;

		up->i -= forward->i * along;
		up->j -= forward->j * along;
		up->k -= forward->k * along;
		length = vector_length(up);
		if (length > 1e-6f)
		{
			up->i /= length;
			up->j /= length;
			up->k /= length;
		}
		else
		{
			*up = camera->latest.up;
		}
	}
	camera->blended.field_of_view = lerp(camera->previous.field_of_view, camera->latest.field_of_view, t);
	return &camera->blended;
}

/* ---------- first-person weapon */

/* The first-person weapon and hands are posed in world space from the drawn
camera each frame, from animation state that changes once a tick: blend the
pose relative to the camera. */
void render_interpolation_first_person(
	short local_player_index,
	real_matrix4x3 *node_matrices,
	short node_count,
	struct render_camera const *camera)
{
	struct interpolated_first_person *first_person;
	real_matrix4x3 camera_matrix;
	real_matrix4x3 inverse_camera;
	short node_index;

	if (!interpolation_rendering ||
		local_player_index < 0 || local_player_index >= MAXIMUM_LOCAL_PLAYERS ||
		node_count <= 0 || node_count > MAXIMUM_INTERPOLATED_NODES)
	{
		return;
	}
	first_person = &interpolated_first_person[local_player_index];
	matrix4x3_from_point_and_vectors(&camera_matrix, &camera->position, &camera->forward, &camera->up);
	matrix4x3_inverse(&camera_matrix, &inverse_camera);
	if (first_person->tick != interpolation_tick)
	{
		/* the pose drawn last, at the end of the previous tick */
		first_person->has_previous = first_person->node_count == node_count;
		memcpy(first_person->previous, first_person->latest, sizeof(first_person->previous));
		first_person->tick = interpolation_tick;
	}
	for (node_index = 0; node_index < node_count; node_index++)
		matrix4x3_multiply(&inverse_camera, &node_matrices[node_index], &first_person->latest[node_index]);
	first_person->node_count = node_count;
	if (!first_person->has_previous)
		return;
	for (node_index = 0; node_index < node_count; node_index++)
	{
		real_matrix4x3 blended;

		matrix_blend(
			&first_person->previous[node_index],
			&first_person->latest[node_index],
			interpolation_fraction,
			&blended);
		matrix4x3_multiply(&camera_matrix, &blended, &node_matrices[node_index]);
	}
}

/* ---------- time */

/* game time for animated shaders, continuous between ticks: the time of
the frame drawn (a tick behind the simulation, like the objects) */
real render_interpolation_game_time_sec(long ticks)
{
	real time;

	if (!interpolation_rendering)
		return (real)ticks * (1.0f / TICKS_PER_SECOND);
	time = ((real)ticks - 1.0f + interpolation_fraction) * (1.0f / TICKS_PER_SECOND);
	return time > 0.0f ? time : 0.0f;
}

#ifdef HALO_WEB
/* ---------- the browser's snap detector

What the player sees of their own movement: each frame, the camera drawn
against the path the last two ticks lay out. A snap is a frame whose camera
moved back against that path, further or turned further than the time drawn
since the last frame allows, or drawn at an earlier point of the game clock
than the last; camera cuts (render_interpolation_camera's teleports and
turns past CAMERA_CUT_COSINE in a tick) are counted too. The worst snap of
a measurement window keeps its context. */

extern int halo_linux_camera_assist_enabled(short gamepad_index);
extern int network_web_trigger_down(void);
extern long network_web_own_corrections(void);

/* how much more than the path allows, and the least, before it is a snap */
#define SNAP_STEP_FACTOR 1.5f
#define SNAP_STEP_SLACK 0.03f
#define SNAP_TURN_SLACK_DEGREES 3.0f

static struct
{
	boolean valid;
	real_point3d position;
	real_vector3d forward;
	long tick;
	real fraction;
	double time;
	long corrections;
} snap_last;

static struct
{
	double frames, snaps, backward, clock_backward, cuts;
	double maximum_step, maximum_degrees;
	double worst_excess;
	/* the worst: step, allowed, degrees, allowed, ticks run that frame,
	fraction before and now, frame ms, ms since the tick, firing, crouching,
	controller aiming, an own correction that frame, a camera cut */
	double worst[14];
} snap_window;

static real snap_degrees(real_vector3d const *a, real_vector3d const *b)
{
	real dot = a->i * b->i + a->j * b->j + a->k * b->k;

	return (real)(acos(dot < -1.0f ? -1.0f : dot > 1.0f ? 1.0f : dot) * 180.0 / 3.14159265358979);
}

static void web_snap_frame(short local_player_index, struct observer_result const *drawn, boolean cut)
{
	struct interpolated_camera *camera = &interpolated_cameras[local_player_index];
	double now = emscripten_get_now();
	long corrections = network_web_own_corrections();

	if (snap_last.valid && camera->valid && camera->has_previous)
	{
		long ticks = interpolation_tick - snap_last.tick;
		real advance = (real)ticks + interpolation_fraction - snap_last.fraction;
		real_vector3d path, step;
		real speed, distance, allowed, degrees, allowed_degrees, along;
		boolean backward, snap;

		path.i = camera->latest.position.x - camera->previous.position.x;
		path.j = camera->latest.position.y - camera->previous.position.y;
		path.k = camera->latest.position.z - camera->previous.position.z;
		step.i = drawn->position.x - snap_last.position.x;
		step.j = drawn->position.y - snap_last.position.y;
		step.k = drawn->position.z - snap_last.position.z;
		speed = vector_length(&path);
		distance = vector_length(&step);
		along = path.i * step.i + path.j * step.j + path.k * step.k;
		allowed = speed * (advance > 0.0f ? advance : 0.0f) * SNAP_STEP_FACTOR + SNAP_STEP_SLACK;
		degrees = snap_degrees(&snap_last.forward, &drawn->forward);
		allowed_degrees = snap_degrees(&camera->previous.forward, &camera->latest.forward) *
			(advance > 0.0f ? advance : 0.0f) * SNAP_STEP_FACTOR + SNAP_TURN_SLACK_DEGREES;
		backward = speed > 0.005f && distance > 0.01f && along < 0.0f;
		snap = backward || distance > allowed || degrees > allowed_degrees || advance < -0.001f || cut;
		snap_window.frames++;
		if (distance > snap_window.maximum_step)
			snap_window.maximum_step = distance;
		if (degrees > snap_window.maximum_degrees)
			snap_window.maximum_degrees = degrees;
		if (snap)
		{
			/* (the worst: past what was allowed, a world unit counted as 30 degrees) */
			double excess = (distance - allowed > 0.0f ? distance - allowed : 0.0f) * 30.0 +
				(degrees - allowed_degrees > 0.0f ? degrees - allowed_degrees : 0.0f) + (backward ? distance * 30.0 : 0.0);
			struct player_datum *player = local_player_get_player_index(0) != NONE ?
				player_try_and_get(local_player_get_player_index(0)) : NULL;
			struct unit_datum *unit = player && player->unit_index != NONE ?
				(struct unit_datum *)object_try_and_get_and_verify_type(player->unit_index, _object_mask_unit) : NULL;

			snap_window.snaps++;
			snap_window.backward += backward;
			snap_window.clock_backward += advance < -0.001f;
			snap_window.cuts += cut;
			if (excess >= snap_window.worst_excess)
			{
				double *worst = snap_window.worst;

				snap_window.worst_excess = excess;
				worst[0] = distance;
				worst[1] = allowed;
				worst[2] = degrees;
				worst[3] = allowed_degrees;
				worst[4] = (double)ticks;
				worst[5] = snap_last.fraction;
				worst[6] = interpolation_fraction;
				worst[7] = now - snap_last.time;
				worst[8] = now - web_tick_time;
				worst[9] = network_web_trigger_down();
				worst[10] = unit && TEST_FLAG(unit->unit.control_flags, _unit_control_crouch_modifier_bit);
				worst[11] = halo_linux_camera_assist_enabled(0) ? 1.0 : 0.0;
				worst[12] = corrections != snap_last.corrections;
				worst[13] = cut;
			}
		}
	}
	snap_last.valid = TRUE;
	snap_last.position = drawn->position;
	snap_last.forward = drawn->forward;
	snap_last.tick = interpolation_tick;
	snap_last.fraction = interpolation_fraction;
	snap_last.time = now;
	snap_last.corrections = corrections;
}

/* since the last call: [0] frames measured, [1] snaps, [2] of them moving
back, [3] drawn earlier on the game clock, [4] camera cuts, [5] the longest
step (world units), [6] the largest turn (degrees), [7..20] the worst snap
(see snap_window.worst) */
void render_interpolation_web_snaps(double values[21])
{
	values[0] = snap_window.frames;
	values[1] = snap_window.snaps;
	values[2] = snap_window.backward;
	values[3] = snap_window.clock_backward;
	values[4] = snap_window.cuts;
	values[5] = snap_window.maximum_step;
	values[6] = snap_window.maximum_degrees;
	memcpy(&values[7], snap_window.worst, sizeof(snap_window.worst));
	memset(&snap_window, 0, sizeof(snap_window));
}
#endif
