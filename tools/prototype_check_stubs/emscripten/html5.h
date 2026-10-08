/* tools/check_prototypes.py: emscripten/html5.h's declarations the game sources use */
#include "../emscripten.h"
#include <stdint.h>
typedef uintptr_t EMSCRIPTEN_WEBGL_CONTEXT_HANDLE;
EMSCRIPTEN_WEBGL_CONTEXT_HANDLE emscripten_webgl_get_current_context(void);
_Bool emscripten_webgl_enable_extension(EMSCRIPTEN_WEBGL_CONTEXT_HANDLE context, const char *extension);
