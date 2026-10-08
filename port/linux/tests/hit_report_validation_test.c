/* Built by hit_report_validation_test.js against the real code it extracts (validation.inc):
   port/linux/game/network_damage.c's grenade throws and hit report numbers, and
   source/networking/network_server_message_handler.c's name cleaning. */
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

typedef int boolean;
typedef float real;
typedef unsigned char byte;
typedef unsigned short word;
typedef struct { real x, y, z; } real_point3d;
typedef struct { real i, j, k; } real_vector3d;
#define TRUE 1
#define FALSE 0
#define NONE (-1)
#define NUMBEROF(array) (sizeof(array) / sizeof((array)[0]))
#define TICKS_PER_SECOND 30
#define RECENT_WEAPON_TICKS (10 * TICKS_PER_SECOND)
#define MAXIMUM_GRENADE_THROWS 32

#include "validation.inc"

static int failures;

static void check(int condition, const char *what)
{
	if (!condition)
	{
		printf("FAIL: %s\n", what);
		failures++;
	}
}

static void test_grenades(void)
{
	long times[MAXIMUM_GRENADE_THROWS];
	short types[MAXIMUM_GRENADE_THROWS];
	short index;
	short first;

	for (index = 0; index < MAXIMUM_GRENADE_THROWS; index++)
		times[index] = NONE;
	check(distributed_grenade_throw(times, types, 0, 100) == NONE, "no throw: no grenade damage");
	distributed_grenade_note(times, types, 0, 100);
	first = distributed_grenade_throw(times, types, 0, 160);
	check(first != NONE, "a frag thrown two seconds ago");
	check(distributed_grenade_throw(times, types, 1, 160) == NONE, "but no plasma grenade");
	check(distributed_grenade_throw(times, types, 0, 100 + RECENT_WEAPON_TICKS + 1) == NONE,
		"a throw longer ago than ten seconds is gone");
	distributed_grenade_note(times, types, 0, 130);
	check(distributed_grenade_throw(times, types, 0, 160) == first, "the oldest throw goes off first");
	times[first] = NONE;
	check(distributed_grenade_throw(times, types, 0, 160) != NONE, "spent, the next one is left");
	times[distributed_grenade_throw(times, types, 0, 160)] = NONE;
	check(distributed_grenade_throw(times, types, 0, 160) == NONE, "both spent: nothing left");
	for (index = 0; index < MAXIMUM_GRENADE_THROWS + 1; index++)
		distributed_grenade_note(times, types, 1, 1000 + index);
	check(distributed_grenade_throw(times, types, 1, 1100) != NONE &&
		times[distributed_grenade_throw(times, types, 1, 1100)] == 1001,
		"past the most kept, the oldest gives way");
}

static struct distributed_hit_report good_report(void)
{
	struct distributed_hit_report report;

	memset(&report, 0, sizeof(report));
	report.damage.origin.x = 10.0f;
	report.damage.epicenter.x = 10.5f;
	report.damage.direction.i = 1.0f;
	report.damage.scale = 1.0f;
	report.damage.multiplier = 1.0f;
	report.damage.material_effect_scale = 1.0f;
	report.target_position.x = 11.0f;
	return report;
}

static void test_numbers(void)
{
	struct distributed_hit_report report = good_report();
	real zero = 0.0f;

	check(distributed_report_numbers_valid(&report), "an ordinary report");
	report.damage.scale = 1.5f;
	check(distributed_report_numbers_valid(&report), "an airborne melee blow's scale");
	report.damage.scale = 1.6f;
	check(!distributed_report_numbers_valid(&report), "no harder than that");
	report.damage.scale = -0.1f;
	check(!distributed_report_numbers_valid(&report), "nor below nothing");
	report = good_report();
	report.damage.scale = zero / zero;
	check(!distributed_report_numbers_valid(&report), "a scale that is not a number");
	report = good_report();
	report.damage.origin.y = zero / zero;
	check(!distributed_report_numbers_valid(&report), "an origin that is not a number");
	report = good_report();
	report.damage.epicenter.z = 1.0f / zero;
	check(!distributed_report_numbers_valid(&report), "an infinite epicenter");
	report = good_report();
	report.target_position.x = 40000.0f;
	check(!distributed_report_numbers_valid(&report), "a target outside the world");
	report = good_report();
	report.damage.direction.j = 3.0f;
	check(!distributed_report_numbers_valid(&report), "a direction longer than a few units");
	report = good_report();
	report.damage.multiplier = 1.0f / zero;
	check(!distributed_report_numbers_valid(&report), "an infinite multiplier");
	report = good_report();
	report.object_normal.i = zero / zero;
	check(distributed_report_numbers_valid(&report), "a normal the report does not have is not read");
	report.has_normal = TRUE;
	check(!distributed_report_numbers_valid(&report), "one it has must be a number");
}

static void clean(const wchar_t *input, long count, const wchar_t *expected, const char *what)
{
	wchar_t name[32];

	memset(name, 0x41, sizeof(name));
	memcpy(name, input, (wcslen(input) + 1) * sizeof(wchar_t) < sizeof(name) ?
		(wcslen(input) + 1) * sizeof(wchar_t) : sizeof(name));
	network_game_server_clean_name(name, count, L"Player");
	check(!memcmp(name, expected, (wcslen(expected) + 1) * sizeof(wchar_t)), what);
}

static void test_names(void)
{
	wchar_t unterminated[12];
	wchar_t expected[12];
	short index;

	clean(L"Bob", 12, L"Bob", "a plain name stays");
	clean(L"  Bob  ", 12, L"Bob", "spaces before and after go");
	clean(L"Bo\nb\t", 12, L"Bob", "line breaks and tabs go");
	clean(L"Ev\x202E" L"il", 12, L"Evil", "a right-to-left override goes");
	clean(L"a\x200B" L"b\xFEFF", 12, L"ab", "zero-width characters go");
	clean(L"x\xD800y", 12, L"xy", "a lone surrogate goes");
	clean(L"c|d", 12, L"cd", "the game's text mark goes");
	clean(L"\n\x202E ", 12, L"Player", "nothing left: the default");
	for (index = 0; index < 12; index++)
		unterminated[index] = L'z';
	network_game_server_clean_name(unterminated, 12, L"Player");
	for (index = 0; index < 11; index++)
		expected[index] = L'z';
	expected[11] = 0;
	check(!memcmp(unterminated, expected, sizeof(expected)), "a name that does not end ends within its field");
}

int main(void)
{
	test_grenades();
	test_numbers();
	test_names();
	if (failures)
		return 1;
	printf("hit report validation tests passed\n");
	return 0;
}
