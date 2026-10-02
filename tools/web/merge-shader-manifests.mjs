// Usage: node tools/web/merge-shader-manifests.mjs <recordings dir> <maps dir>
// Each <recordings dir>/*.json holds one client's recording as a JSON string: the value of
// UTF8ToString(Module._platform_web_shader_manifest()) evaluated in a page that played a map.
// Writes the union per map to <maps dir>/<map>.shaders (records deduplicated by their text),
// which the server serves as assets/maps/<map>.shaders. The output is derived from the game
// data: keep it next to the maps, never in git.
import fs from "node:fs";
const [dir, out] = process.argv.slice(2);
const maps = new Map();
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const text = JSON.parse(fs.readFileSync(`${dir}/${file}`, "utf8"));
  if (typeof text !== "string" || !text.startsWith("HALO-SHADERS 1 ")) { console.log(`${file}: no manifest`); continue; }
  const newline = text.indexOf("\n");
  const map = text.slice(15, newline).trim();
  if (!/^[a-z0-9]+$/.test(map)) { console.log(`${file}: bad map ${map}`); continue; }
  const records = maps.get(map) ?? new Set();
  let cursor = newline + 1, count = 0;
  while (text.startsWith("P ", cursor)) {
    const end = text.indexOf("\n", cursor);
    const [, v, f] = text.slice(cursor, end).split(" ").map(Number);
    const record = text.slice(cursor, end + 1 + v + f + 1);
    records.add(record); count++;
    cursor = end + 1 + v + f + 1;
  }
  maps.set(map, records);
  console.log(`${file}: ${map} ${count} programs`);
}
for (const [map, records] of maps) {
  const body = `HALO-SHADERS 1 ${map}\n${[...records].join("")}`;
  fs.writeFileSync(`${out}/${map}.shaders`, body);
  console.log(`${map}.shaders: ${records.size} programs, ${body.length} bytes`);
}