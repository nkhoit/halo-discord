/* tools/check_prototypes.py: the few emscripten declarations the browser build's game sources use, for a native
   syntax-only compile (the real build takes emscripten's own headers) */
#ifndef PROTOTYPE_CHECK_EMSCRIPTEN_H
#define PROTOTYPE_CHECK_EMSCRIPTEN_H
#include <stddef.h>
#define EMSCRIPTEN_KEEPALIVE __attribute__((used))
typedef void (*em_arg_callback_func)(void *);
double emscripten_get_now(void);
void emscripten_cancel_main_loop(void);
void emscripten_force_exit(int status);
void emscripten_set_main_loop_arg(em_arg_callback_func func, void *arg, int fps, int simulate_infinite_loop);
size_t emscripten_get_heap_size(void);
#define EM_ASM_PTR(...) ((void *)0)
#define EM_ASM_DOUBLE(...) 0.0
#define MAIN_THREAD_EM_ASM_INT(...) 0
#endif