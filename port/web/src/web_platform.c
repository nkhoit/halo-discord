/* Browser-only filesystem mounts and small OpenGL ES host helpers. */

#include "platform.h"
#include "posix.h"
#include "gl.h"

#include <emscripten/emscripten.h>
#include <emscripten/heap.h>
#include <emscripten/wasmfs.h>
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Keep the browser platform unit on host libc headers. These two game-side
 * exports use the Xbox ABI's byte boolean and float real types. */
extern unsigned char game_map_loading_in_progress(float *progress);
extern const char *game_map_loading_name(void);

static const char *const map_files[] =
{
	"a10.map", "a30.map", "a50.map", "b30.map", "b40.map", "c10.map",
	"c20.map", "c40.map", "d20.map", "d40.map", "beavercreek.map",
	"bloodgulch.map", "boardingaction.map", "carousel.map", "chillout.map",
	"damnation.map", "hangemhigh.map", "longest.map", "prisoner.map",
	"putput.map", "ratrace.map", "sidewinder.map", "ui.map", "wizard.map"
};

EMSCRIPTEN_KEEPALIVE void platform_web_set_muted(int muted)
{
	platform_audio_set_muted(muted ? TRUE : FALSE);
}

EMSCRIPTEN_KEEPALIVE void platform_web_set_volume(double volume)
{
	platform_audio_set_volume((float)volume);
}

EMSCRIPTEN_KEEPALIVE double platform_web_profile_memory_bytes(void)
{
	return (double)emscripten_get_heap_size();
}

EMSCRIPTEN_KEEPALIVE double platform_web_campaign_load_progress(void)
{
	float progress = 0.0f;

	if (!game_map_loading_in_progress(&progress))
		return -1.0;
	if (progress < 0.0f)
		return 0.0;
	if (progress > 1.0f)
		return 1.0;
	return progress;
}

EMSCRIPTEN_KEEPALIVE double platform_web_map_load_progress(void)
{
	return platform_web_campaign_load_progress();
}

/* (port/linux/game/network_distributed.c, Xbox ABI float real) */
extern void network_distributed_web_statistics(long *ticks, long *own_corrections,
	float *own_correction_maximum_squared, long *rejected_predictions, long *own_aim_corrections,
	float *own_aim_correction_maximum_degrees, long *own_seat_corrections);
/* (source/game/player_queues_new.c, source/game/game_time.c) */
extern void update_server_input_histogram(long histogram[4]);
extern void game_time_tick_statistics(long *multiple_tick_frames, long *maximum_ticks_per_frame,
	long *maximum_tick_milliseconds);
/* (port/linux/src/xbox_textures.c, d3d8_gl.c, sdl_platform.c) */
extern void xgpu_web_texture_statistics(double values[7]);
extern void xgpu_web_shader_statistics(double values[12]);
extern double platform_web_profile_take_callback_maximum(void);
extern const double *platform_web_profile_take_frame_times(void);
extern void xgpu_web_frame_statistics(double values[6]);
/* (port/linux/game/network_distributed.c) */
extern void network_distributed_web_feel(double values[25]);
/* (port/linux/game/render_interpolation.c) */
extern void render_interpolation_web_snaps(double values[21]);

/* Local network statistics for ?netstats=1 (library_web_transport.js):
 * [0] ticks sent, [1] own units put back by the host, [2] the farthest of
 * those in world units, [3] predictions the host refused, [4] own
 * corrections that also turned the unit, [5] the most degrees one turned it,
 * [6] own seat corrections, [7..10] (the host) ticks with 0, 1, 2 and 3+
 * client input packets, [11] frames that ran several ticks to catch up,
 * [12] the most ticks one frame ran since the last read, [13] the most
 * milliseconds one frame spent on its ticks, [14] the longest frame callback
 * (both since the last read), [15..17] shaders compiled and programs linked,
 * their milliseconds and the longest, [18..21] textures uploaded, their
 * bytes, milliseconds and the longest, [22..23] milliseconds spent hashing
 * textures and the longest, [24] idle textures dropped, [25] of [15], shader
 * compiles, [26] shaders reused for text compiled before, [27] new pixel
 * shader keys, [28] the 99th percentile frame gap, [29..32] gaps over 16.7,
 * 33.3, 50 and 100 ms, [33] the longest gap after a frame with a program's
 * first draw, [34] after a transient pool overflow, [35] the most draws in a
 * frame, [36] the most transient uploads, [37] the most transient bytes,
 * [38] frames that overflowed the pool, [39] first draws (total), [40] frames
 * with first draws, [41] the longest time outside the frame callback,
 * [42] programs built ahead, [43] the last warm-up's milliseconds, [44] first
 * draws of programs not built ahead, [45] draws skipped while their program
 * compiled in the background, [46] programs compiled so, [47] the longest
 * wait for one, [48] the longest interval between the worker's animation
 * frames, [49] the longest delay from one's timestamp to the game frame,
 * [50..74] shooting and the other players since the last read
 * (network_distributed_web_feel), [75..95] snaps of the player's own view
 * (render_interpolation_web_snaps), [96] the mean interval between rendered
 * animation frames, [97] the mean change from one to the next.
 * [28..38], [40] and [41] are since the last read; other counts
 * are totals. */
EMSCRIPTEN_KEEPALIVE const double *platform_web_netstats(void)
{
	static double first_draws_total;
	static double values[98];
	long ticks;
	long own_corrections;
	float own_correction_maximum_squared;
	long rejected_predictions;
	long own_aim_corrections;
	float own_aim_correction_maximum_degrees;
	long own_seat_corrections;
	long histogram[4];
	long multiple_tick_frames;
	long maximum_ticks_per_frame;
	long maximum_tick_milliseconds;
	double textures[7];
	double shaders[12];
	int index;

	network_distributed_web_statistics(&ticks, &own_corrections, &own_correction_maximum_squared,
		&rejected_predictions, &own_aim_corrections, &own_aim_correction_maximum_degrees,
		&own_seat_corrections);
	update_server_input_histogram(histogram);
	game_time_tick_statistics(&multiple_tick_frames, &maximum_ticks_per_frame, &maximum_tick_milliseconds);
	xgpu_web_texture_statistics(textures);
	xgpu_web_shader_statistics(shaders);
	values[0] = (double)ticks;
	values[1] = (double)own_corrections;
	values[2] = sqrt((double)own_correction_maximum_squared);
	values[3] = (double)rejected_predictions;
	values[4] = (double)own_aim_corrections;
	values[5] = (double)own_aim_correction_maximum_degrees;
	values[6] = (double)own_seat_corrections;
	for (index = 0; index < 4; index++)
		values[7 + index] = (double)histogram[index];
	values[11] = (double)multiple_tick_frames;
	values[12] = (double)maximum_ticks_per_frame;
	values[13] = (double)maximum_tick_milliseconds;
	values[14] = platform_web_profile_take_callback_maximum();
	for (index = 0; index < 3; index++)
		values[15 + index] = shaders[index];
	values[18] = textures[0];
	values[19] = textures[1];
	values[20] = textures[2];
	values[21] = textures[3];
	values[22] = textures[4];
	values[23] = textures[5];
	values[24] = textures[6];
	values[25] = shaders[3];
	values[26] = shaders[4];
	values[27] = shaders[5];
	{
		const double *times = platform_web_profile_take_frame_times();
		double frame[6];

		for (index = 0; index < 7; index++)
			values[28 + index] = times[index];
		xgpu_web_frame_statistics(frame);
		values[35] = frame[0];
		values[36] = frame[1];
		values[37] = frame[2];
		values[38] = frame[3];
		first_draws_total += frame[4];
		values[39] = first_draws_total;
		values[40] = frame[5];
		values[41] = times[7];
		values[42] = shaders[6];
		values[43] = shaders[7];
		values[44] = shaders[8];
		values[45] = shaders[9];
		values[46] = shaders[10];
		values[47] = shaders[11];
		values[48] = times[8];
		values[49] = times[9];
		network_distributed_web_feel(&values[50]);
		render_interpolation_web_snaps(&values[75]);
		values[96] = times[10];
		values[97] = times[11];
	}
	return values;
}

EMSCRIPTEN_KEEPALIVE long platform_web_campaign_load_index(void)
{
	const char *name = game_map_loading_name();
	char file_name[40];
	unsigned long index;

	snprintf(file_name, sizeof(file_name), "%s.map", name);
	for (index = 0; index < 10; index++)
	{
		if (!strcmp(file_name, map_files[index]))
			return (long)index;
	}
	return -1;
}

EMSCRIPTEN_KEEPALIVE long platform_web_map_load_index(void)
{
	const char *name = game_map_loading_name();
	char file_name[40];
	unsigned long index;

	snprintf(file_name, sizeof(file_name), "%s.map", name);
	for (index = 0; index < sizeof(map_files) / sizeof(map_files[0]); index++)
	{
		if (!strcmp(file_name, map_files[index]))
			return (long)index;
	}
	return -1;
}

void platform_web_initialize(void)
{
	backend_t root = wasmfs_get_backend_by_path("/");
	backend_t maps;
	backend_t storage;
	char *maps_url;
	unsigned long index;

	/* FetchFS performs HTTP range requests, so opening a map does not first
	download every map (or even all of the selected map). */
	/* The mountpoint is created inside this directory immediately below, so
	the parent must remain writable during startup. */
	if (wasmfs_create_directory("/assets", 0755, root) != 0 && errno != EEXIST)
		platform_log("web: cannot create /assets");
	/* FetchFS's whole-file fallback stores the file length as its per-file
	 * chunk size, while later range-residency checks continue using the
	 * configured chunk size. Sequential reads past that configured boundary
	 * enter inconsistent chunk bookkeeping. Every UI/multiplayer map is under
	 * 32 MiB, so it remains entirely in chunk zero even when a CDN does not
	 * advertise ranges. Campaign maps are over 64 MiB and stay on the ranged
	 * path when served by the local range-capable development server. */
	/* FetchFS resolves relative URLs against location.origin, which discards a
	 * hosting prefix such as /halo/. Resolve the map directory from the loaded
	 * script instead; scriptDirectory is correct in both the window and the
	 * pthread worker that initializes this backend. */
	maps_url = (char *)EM_ASM_PTR({
		return stringToNewUTF8(new URL("assets/maps", scriptDirectory).href);
	});
	platform_log("web: map source: %s", maps_url);
	maps = wasmfs_create_fetch_backend(maps_url, 32 * 1024 * 1024);
	free(maps_url);
	if (wasmfs_create_directory("/assets/maps", 0555, maps) != 0 && errno != EEXIST)
		platform_log("web: cannot mount the maps backend");
	for (index = 0; index < sizeof(map_files) / sizeof(map_files[0]); index++)
	{
		char path[128];
		int descriptor;

		snprintf(path, sizeof(path), "/assets/maps/%s", map_files[index]);
		descriptor = wasmfs_create_file(path, 0444, maps);
		if (descriptor >= 0)
			close(descriptor);
	}

	/* Origin-private storage persists configuration, cache files, profiles
	and saves without asking the browser to hold them in linear memory. */
	/* OPFS sync access handles are exclusive per file across tabs, so only
	the copy holding the storage lock (storage_lock.js) may use it; another copy
	in the same browser profile would fail to open the cache files and halt. */
	if (MAIN_THREAD_EM_ASM_INT({ return Module.haloStorageExclusive ? 1 : 0; }))
	{
		storage = wasmfs_create_opfs_backend();
	}
	else
	{
		platform_log("web: another copy of the game holds persistent storage; settings and saves in this copy are not kept");
		storage = wasmfs_create_memory_backend();
	}
	if (wasmfs_create_directory("/storage", 0777, storage) != 0 && errno != EEXIST)
		platform_log("web: cannot mount persistent storage");
	setenv("HALO_DATA_ROOT", "/assets", 1);
	setenv("HALO_SAVE_ROOT", "/storage", 1);
	setenv("HALO_NET_ONLINE", "false", 1);
	setenv("HALO_NET_JOIN_FROM_CLIPBOARD", "false", 1);
	setenv("HALO_FULLSCREEN", "false", 1);
	setenv("HALO_WINDOW_SCALE", "1", 1);
}

int host_gl_has_extension(const char *name)
{
	GLint count = 0;
	GLint index;

	glGetIntegerv(GL_NUM_EXTENSIONS, &count);
	for (index = 0; index < count; index++)
	{
		const char *extension = (const char *)glGetStringi(GL_EXTENSIONS, (GLuint)index);

		if (extension && !strcmp(extension, name))
			return TRUE;
	}
	return FALSE;
}

unsigned int host_gl_read_buffer_word(unsigned int buffer, unsigned int offset)
{
	(void)buffer;
	(void)offset;
	return 0;
}

void host_gl_buffer_write(unsigned int target, unsigned int offset, unsigned int size, const void *data)
{
	glBufferSubData((GLenum)target, (GLintptr)offset, (GLsizeiptr)size, data);
}

void host_gl_fence_frame(unsigned int slot)
{
	(void)slot;
	/* bufferSubData copies its input before returning, and presentation has
	already committed the WebGL command stream for this frame. */
}

void host_gl_wait_frame(unsigned int slot)
{
	(void)slot;
	/* WebGL copies bufferSubData input before returning.  glFinish on an
	OffscreenCanvas worker can wait on the browser compositor indefinitely,
	so the three-frame streaming ring needs no explicit CPU-side wait. */
}
