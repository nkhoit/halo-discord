/* The port's 16-bit wide string helpers (port/linux/src/msvc_wide.c), built
   as the game builds them (-O2 -fshort-wchar), with ui_widget.c's
   get_icon_type, which reads Halo's prompts ("%b-button =quit"), and the
   wide printf that formats the HUD's item messages. Included pieces come
   from the real sources (msvc_wide_test.js extracts them). */
#include <stdarg.h>
#include <stdio.h>
#include <stddef.h>
#include <string.h>
#include <wchar.h>

#include "msvc_wide.inc"

#define _wcsnicmp msvc_wcsnicmp
#define NUMBEROF(array) ((short)(sizeof(array) / sizeof((array)[0])))
#define NONE (-1)

#include "icon_names.inc"

static int failures;

static int same(const wchar_t *string1, const wchar_t *string2)
{
	while (*string1 && *string1 == *string2)
	{
		string1++;
		string2++;
	}
	return *string1 == *string2;
}

static void check(int condition, const char *what)
{
	if (!condition)
	{
		printf("FAIL: %s\n", what);
		failures++;
	}
}

int main(void)
{
	/* (no -O2 rewriting of the counting loop into a 32-bit wcslen) */
	check(sizeof(L'x') == 2, "wchar_t is 16-bit");
	check(msvc_wcslen(L"b-button") == 8, "wcslen(\"b-button\") is 8");
	check(msvc_wcslen(L"") == 0, "wcslen(\"\") is 0");
	check(msvc_wcslen(L"Picked up %d rounds for assault rifle") == 37, "wcslen of the ammo pickup string");
	check(msvc_wcsnicmp(L"b-button =quit", L"b-button", 8) == 0, "wcsnicmp prefix");
	check(msvc_wcsnicmp(L"B-BUTTON", L"b-button", 8) == 0, "wcsnicmp ignores case");
	check(msvc_wcsnicmp(L"a-button", L"b-button", 8) != 0, "wcsnicmp tells them apart");
	/* the post-match prompt, ui\multiplayer_game_text #0x48 */
	check(get_icon_type(L"b-button =quit    %a-button =pick game") == 1, "get_icon_type(b-button) is 1");
	check(get_icon_type(L"a-button =pick game") == 0, "get_icon_type(a-button) is 0");
	check(get_icon_type(L"not-an-icon") == NONE, "get_icon_type of no icon is NONE");
	/* the ammo pickup message, hud_messaging.c's usprintf of the map's
	hud_item_messages string (#32) */
	{
		wchar_t formatted[256];

		check(msvc_snwprintf(formatted, 256, L"Picked up %d rounds for assault rifle", 8) == 36,
			"the ammo pickup message is 36 characters");
		check(same(formatted, L"Picked up 8 rounds for assault rifle"), "the ammo pickup message is whole");
		msvc_snwprintf(formatted, 256, L"%s: %d", L"frag grenade", 2);
		check(same(formatted, L"frag grenade: 2"), "a wide %s argument is whole");
		{
			/* (what follows a string's terminator never counts) */
			static const wchar_t followed[] = { 'a', 'b', 'c', 0, 'x', 'y', 'z', 0, 0, 0 };

			msvc_snwprintf(formatted, 256, L"[%s]", followed);
			check(same(formatted, L"[abc]"), "a %s argument ends at its terminator");
			check(msvc_wcslen(followed) == 3, "wcslen ends at the terminator");
		}
	}
	if (!failures)
		printf("msvc_wide tests passed\n");
	return failures ? 1 : 0;
}
