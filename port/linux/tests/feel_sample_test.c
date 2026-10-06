/* The netstats feel series (network_distributed.c, extracted by
   feel_sample_test.js): every value of a window is counted and the largest
   kept, and the percentiles come from a uniform sample of the whole window,
   not its first WEB_FEEL_SAMPLES values. With 63 other players a window has
   about 9,000 corrections. */
#include <stdio.h>
#include <stdlib.h>

#include "feel_series.inc"

static int failures;
#define CHECK(condition) do { if (!(condition)) { printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #condition); failures++; } } while (0)

int main(void)
{
	static struct web_feel_series series;
	double values[3];
	double sum;
	long index;
	int window;

	/* fewer than the sample: exact */
	for (index = 0; index < 100; index++)
		web_feel_sample(&series, (double)(99 - index));
	CHECK(series.count == 100);
	web_feel_take(&series, values);
	CHECK(values[0] == 50.0 && values[1] == 99.0 && values[2] == 99.0);
	CHECK(series.count == 0 && series.maximum == 0.0);

	/* an empty window */
	web_feel_take(&series, values);
	CHECK(values[0] == 0.0 && values[1] == 0.0 && values[2] == 0.0);

	/* a window that grows through it (0 .. 8999 in order): the sample spans
	all of it, where the first 512 would put the median near 256 */
	for (window = 0; window < 20; window++)
	{
		for (index = 0; index < 9000; index++)
			web_feel_sample(&series, (double)index);
		CHECK(series.count == 9000);
		sum = 0.0;
		for (index = 0; index < WEB_FEEL_SAMPLES; index++)
			sum += series.samples[index];
		CHECK(sum / WEB_FEEL_SAMPLES > 4000.0 && sum / WEB_FEEL_SAMPLES < 5000.0);
		web_feel_take(&series, values);
		CHECK(values[0] > 4000.0 && values[0] < 5000.0);
		CHECK(values[1] > 8600.0 && values[1] <= 8999.0);
		CHECK(values[2] == 8999.0);
	}

	/* a spike late in a long window: its maximum, and its count */
	for (index = 0; index < 9000; index++)
		web_feel_sample(&series, index == 8990 ? 5.0 : 0.1);
	web_feel_take(&series, values);
	CHECK(values[0] == 0.1 && values[2] == 5.0);

	/* a late burst of large values (the last tenth) shows in the p99 */
	for (index = 0; index < 9000; index++)
		web_feel_sample(&series, index >= 8100 ? 2.0 : 0.1);
	web_feel_take(&series, values);
	CHECK(values[0] == 0.1 && values[1] == 2.0 && values[2] == 2.0);

	if (failures)
		return 1;
	printf("feel series: whole-window samples, every value counted, the true maximum\n");
	return 0;
}