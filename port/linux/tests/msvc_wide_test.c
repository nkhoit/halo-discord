/* The port's 16-bit wide string helpers (port/linux/src/msvc_wide.c), built
   as the game builds them (-O2 -fshort-wchar), with ui_widget.c's
   get_icon_type, which reads Halo's prompts ("%b-button =quit"). Included
   pieces come from the real sources (msvc_wide_test.js extracts them). */
#include <stdio.h>
#include <stddef.h>
#include <wchar.h>

#include "msvc_wide.inc"

#define _wcsnicmp msvc_wcsnicmp
#define NUMBEROF(array) ((short)(sizeof(array) / sizeof((array)[0])))
#define NONE (-1)

#include "icon_names.inc"

static int failures;

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
	if (!failures)
		printf("msvc_wide tests passed\n");
	return failures ? 1 : 0;
}
