/* Built by dsound_decode_test.js against the real decoder and 3D gains of port/linux/src/dsound_sdl.c
(dsound_decode.inc, extracted from the source). */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef unsigned long DWORD;
#define DS3DMODE_HEADRELATIVE 1

struct sdl_stream
{
	DWORD mode;
	float position[3];
	float minimum_distance, maximum_distance;
	float i3dl2_gain;
};

#define XBOX_ADPCM_BLOCK_BYTES 36
#define XBOX_ADPCM_BLOCK_SAMPLES 64

#include "dsound_decode.inc"

#define BLOCKS 40

static int failures;

static void check(int condition, const char *what)
{
	if (!condition)
	{
		printf("FAIL: %s\n", what);
		failures++;
	}
}

/* An Xbox ADPCM encoder: per block and channel, the header holds the first sample and the step index, and
nibble n codes sample n + 1 (the 64th nibble pads). expected[] receives what a decoder must reproduce: the
header's sample, then each nibble's reconstruction. */
static void encode(const short *input, unsigned long channels, unsigned char *output, short *expected)
{
	int predictor[2] = { 0, 0 }, index[2] = { 0, 0 };
	unsigned long block, channel, sample;

	for (block = 0; block < BLOCKS; block++)
	{
		unsigned char *data = output + block * XBOX_ADPCM_BLOCK_BYTES * channels;
		const short *in = input + block * XBOX_ADPCM_BLOCK_SAMPLES * channels;
		short *out = expected + block * XBOX_ADPCM_BLOCK_SAMPLES * channels;

		memset(data, 0, XBOX_ADPCM_BLOCK_BYTES * channels);
		for (channel = 0; channel < channels; channel++)
		{
			predictor[channel] = in[channel];
			data[channel * 4] = (unsigned char)(in[channel] & 0xff);
			data[channel * 4 + 1] = (unsigned char)((in[channel] >> 8) & 0xff);
			data[channel * 4 + 2] = (unsigned char)index[channel];
			out[channel] = in[channel];
			for (sample = 1; sample < XBOX_ADPCM_BLOCK_SAMPLES; sample++)
			{
				unsigned long nibble_index = sample - 1;
				unsigned long group = nibble_index / 8, within = nibble_index % 8;
				unsigned char *byte = data + 4 * channels + (group * channels + channel) * 4 + within / 2;
				int step = ima_step_table[index[channel]];
				int difference = in[sample * channels + channel] - predictor[channel];
				int nibble = 0;

				if (difference < 0) { nibble = 8; difference = -difference; }
				if (difference >= step) { nibble |= 4; difference -= step; }
				step >>= 1;
				if (difference >= step) { nibble |= 2; difference -= step; }
				step >>= 1;
				if (difference >= step) nibble |= 1;
				out[sample * channels + channel] = (short)ima_expand(nibble, &predictor[channel], &index[channel]);
				*byte |= (unsigned char)(within & 1 ? nibble << 4 : nibble);
			}
		}
	}
}

static void test_adpcm(unsigned long channels)
{
	unsigned long frames = BLOCKS * XBOX_ADPCM_BLOCK_SAMPLES, decoded_frames = 0, i, mismatches = 0, worst = 0;
	short *input = malloc(frames * channels * sizeof(short));
	short *expected = malloc(frames * channels * sizeof(short));
	unsigned char *encoded = malloc(BLOCKS * XBOX_ADPCM_BLOCK_BYTES * channels);
	short *decoded;
	char what[128];

	for (i = 0; i < frames * channels; i++)
	{
		unsigned long frame = i / channels;
		double hz = i % channels ? 660.0 : 440.0;

		input[i] = (short)(8000.0 * sin(2.0 * 3.14159265358979 * hz * (double)frame / 22050.0));
	}
	encode(input, channels, encoded, expected);
	decoded = decode_adpcm(encoded, BLOCKS * XBOX_ADPCM_BLOCK_BYTES * channels, channels, &decoded_frames);
	snprintf(what, sizeof(what), "%lu channel(s): %lu frames decoded", channels, decoded_frames);
	check(decoded && decoded_frames == frames, what);
	for (i = 0; decoded && i < frames * channels; i++)
	{
		unsigned long error = (unsigned long)abs(decoded[i] - expected[i]);

		mismatches += error != 0;
		if (error > worst) worst = error;
	}
	snprintf(what, sizeof(what), "%lu channel(s): %lu of %lu samples differ from the encoder's (worst %lu)",
		channels, mismatches, frames * channels, worst);
	check(mismatches == 0, what);
	printf("adpcm %lu channel(s): %lu frames, %lu mismatches\n", channels, decoded_frames, mismatches);
	free(input); free(expected); free(encoded); free(decoded);
}

static void test_distance(void)
{
	struct sdl_stream stream;
	float left, right, gain;

	memset(&stream, 0, sizeof(stream));
	stream.minimum_distance = 1.0f;
	stream.maximum_distance = 100.0f;
	stream.i3dl2_gain = 1.0f;
	/* the game's SetDistanceFactor: a world unit is 10 feet */
	listener.distance_factor = 3.048f;
	listener.rolloff_factor = 1.0f;

	/* straight ahead: centred, each ear at cos(45 degrees) times the attenuation */
	stream.position[2] = 10.0f;
	spatialize(&stream, &left, &right);
	gain = left / 0.70710678f;
	printf("distance 10, minimum 1: gain %.4f (inverse distance law: 0.1000)\n", gain);
	check(fabsf(gain - 0.1f) < 1.0e-4f, "a source 10 units off with a minimum distance of 1 is attenuated 1/10");
	check(fabsf(left - right) < 1.0e-6f, "a source straight ahead is centred");

	/* beyond the maximum distance the gain holds */
	stream.position[2] = 400.0f;
	spatialize(&stream, &left, &right);
	gain = left / 0.70710678f;
	check(fabsf(gain - 0.01f) < 1.0e-5f, "beyond the maximum distance the gain holds at its value there");

	/* inside the minimum distance: full gain */
	stream.position[2] = 0.5f;
	spatialize(&stream, &left, &right);
	check(fabsf(left / 0.70710678f - 1.0f) < 1.0e-5f, "inside the minimum distance the gain is 1");
}

int main(void)
{
	test_adpcm(1);
	test_adpcm(2);
	test_distance();
	if (failures)
		return 1;
	printf("ok\n");
	return 0;
}
