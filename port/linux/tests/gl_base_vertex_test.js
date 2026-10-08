// Builds port/linux/tests/gl_base_vertex_test.c against the real D3DDevice_SetIndices and
// D3DDevice_DrawIndexedVertices of port/linux/src/d3d8_gl.c (extracted from the source), twice: as the native
// builds and as the browser build (HALO_ANDROID + HALO_WEB, whose WebGL 2 has no base-vertex draws). An indexed
// draw after SetIndices(buffer, base) takes index i as vertex base + i, as the Xbox's vertex fetch does: Halo's
// dynamic triangles count from their vertex buffer's first vertex in the group's buffer (contrails).
// CC defaults to cc.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(root, '.halo-gl-base-vertex-test-'));

function block(source, marker) {
  const start = source.indexOf(marker);
  assert(start >= 0, `missing production block: ${marker}`);
  let depth = 0;
  let end = source.indexOf('{', start);
  do {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  } while (depth > 0 && end < source.length);
  assert.equal(depth, 0);
  return source.slice(start, end);
}

try {
  const source = fs.readFileSync(path.join(root, 'port/linux/src/d3d8_gl.c'), 'utf8').replace(/\r\n/g, '\n');
  fs.writeFileSync(path.join(temp, 'gl_indexed.inc'), [
    block(source, 'void WINAPI D3DDevice_SetIndices('),
    block(source, 'void WINAPI D3DDevice_DrawIndexedVertices('),
  ].join('\n\n') + '\n');
  const cc = process.env.CC || 'cc';
  for (const [label, defines] of [['native', []], ['browser', ['-DHALO_ANDROID', '-DHALO_WEB']]]) {
    const output = path.join(temp, `gl-base-vertex-${label}`);
    const build = spawnSync(cc, ['-O2', '-std=gnu99', '-w', ...defines, '-iquote', temp,
      path.join(__dirname, 'gl_base_vertex_test.c'), '-o', output],
      {encoding: 'utf8', shell: process.platform === 'win32'});
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const run = spawnSync(output, [], {encoding: 'utf8'});
    assert.equal(run.status, 0, `${label}: ${run.stdout}${run.stderr}`);
    console.log(`${label}: ${run.stdout.trim()}`);
  }
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}