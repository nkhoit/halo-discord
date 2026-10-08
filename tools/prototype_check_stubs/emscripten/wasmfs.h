/* tools/check_prototypes.py: emscripten/wasmfs.h's declarations the game sources use */
#include <stdint.h>
#include <sys/types.h>
typedef struct Backend *backend_t;
backend_t wasmfs_get_backend_by_path(const char *path);
int wasmfs_create_file(const char *pathname, mode_t mode, backend_t backend);
int wasmfs_create_directory(const char *path, mode_t mode, backend_t backend);
backend_t wasmfs_create_memory_backend(void);
backend_t wasmfs_create_fetch_backend(const char *base_url, uint32_t chunk_size);
backend_t wasmfs_create_opfs_backend(void);
