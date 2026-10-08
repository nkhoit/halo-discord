/* The indexed draws of port/linux/src/d3d8_gl.c (extracted by gl_base_vertex_test.js) take index i as vertex
   base + i after SetIndices(buffer, base). Stubs stand in for GL: the streams' first vertex and the indices drawn
   are recorded, and each draw's vertices are resolved (stream first vertex + index - its offset). */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define WINAPI
#define CONST const
#define TRUE 1
#define FALSE 0
typedef int BOOL;
typedef unsigned short WORD;
typedef unsigned int UINT;
typedef unsigned int GLuint;
typedef int GLsizei;
typedef int GLint;
typedef unsigned int GLenum;
typedef enum { D3DPT_TRIANGLELIST = 5, D3DPT_QUADLIST = 8 } D3DPRIMITIVETYPE;
typedef struct { void *Data; } D3DIndexBuffer;
#define GL_UNSIGNED_SHORT 0x1403
#define GL_TRIANGLES 4

static WORD *D3D__IndexData;
static struct { unsigned long base_vertex_index; } device;
static struct { BOOL base_vertex; } xgpu_capabilities;
static struct { unsigned long streamed_bytes; } stats;
static unsigned long streams_first;
static long drawn[64];
static int drawn_count;
static WORD uploaded[64];

static BOOL prepare_draw(BOOL x) { (void)x; return TRUE; }
static void trace_draw(const char *a, D3DPRIMITIVETYPE b, UINT c, const void *d) { (void)a; (void)b; (void)c; (void)d; }
static void setup_streams(unsigned long first, unsigned long count) { (void)count; streams_first = first; }
static GLenum primitive_mode(D3DPRIMITIVETYPE type) { (void)type; return GL_TRIANGLES; }
static WORD *quad_indices(const WORD *data, unsigned long count, unsigned long *out) { (void)data; *out = count; return NULL; }
static BOOL mirror_range(unsigned long address, unsigned long size, GLuint *buffer, unsigned long *offset, unsigned long *generation)
{
	(void)size; *buffer = 1; *offset = address; *generation = 0; return TRUE;
}
static void index_extent(const WORD *data, unsigned long count, unsigned long generation, BOOL mirrored,
	unsigned long *minimum, unsigned long *maximum)
{
	unsigned long index;
	(void)generation; (void)mirrored;
	*minimum = 0xffff; *maximum = 0;
	for (index = 0; index < count; index++)
	{
		if (data[index] < *minimum) *minimum = data[index];
		if (data[index] > *maximum) *maximum = data[index];
	}
}
static void state_element_array_buffer(GLuint buffer) { (void)buffer; }
static unsigned long index_upload(const void *data, unsigned long size)
{
	memcpy(uploaded, data, size);
	return (unsigned long)uploaded;
}
static void glDrawElementsBaseVertex(GLenum mode, GLsizei count, GLenum type, const void *indices, GLint base)
{
	int index;
	(void)mode; (void)type;
	for (index = 0; index < count; index++) drawn[index] = (long)streams_first + ((const WORD *)indices)[index] + base;
	drawn_count = count;
}
static void glDrawElements(GLenum mode, GLsizei count, GLenum type, const void *indices)
{
	glDrawElementsBaseVertex(mode, count, type, indices, 0);
}
static void gl_check_errors(const char *x) { (void)x; }

#include "gl_indexed.inc"

static int failures;
#define CHECK(condition) do { if (!(condition)) { printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #condition); failures++; } } while (0)

int main(void)
{
	/* a contrail's triangles: two segments, counting from its first vertex */
	static WORD indices[] = { 0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5 };
	static D3DIndexBuffer buffer = { indices };
	int index;

	xgpu_capabilities.base_vertex = FALSE;
	D3DDevice_SetIndices(&buffer, 100);
	D3DDevice_DrawIndexedVertices(D3DPT_TRIANGLELIST, 12, indices);
	CHECK(streams_first == 100);
	CHECK(drawn_count == 12);
	for (index = 0; index < 12; index++) CHECK(drawn[index] == 100 + indices[index]);

	/* a draw whose vertices do not start at its first index */
	D3DDevice_SetIndices(&buffer, 40);
	D3DDevice_DrawIndexedVertices(D3DPT_TRIANGLELIST, 6, indices + 6);
	CHECK(streams_first == 42);
	for (index = 0; index < 6; index++) CHECK(drawn[index] == 40 + indices[6 + index]);

	/* without a base, as before */
	D3DDevice_SetIndices(&buffer, 0);
	D3DDevice_DrawIndexedVertices(D3DPT_TRIANGLELIST, 6, indices + 6);
	CHECK(streams_first == 2);
	for (index = 0; index < 6; index++) CHECK(drawn[index] == indices[6 + index]);

	if (failures)
		return 1;
	printf("indexed draws take index i as vertex base + i\n");
	return 0;
}