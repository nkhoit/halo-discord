/* activity.js: the Activity start-up script bundled with the Discord
   Embedded App SDK at run time, so no generated file is committed and no
   CDN is needed (Discord's policy allows only same-origin scripts). The
   licenses of every bundled package travel with the bundle. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build, stop } from "esbuild";

const ENTRY = fileURLToPath(new URL("../client/activity.js", import.meta.url));

function packageRoot(file: string): string | null {
  const marker = `${sep}node_modules${sep}`;
  const index = file.lastIndexOf(marker);
  if (index < 0) return null;
  const rest = file.slice(index + marker.length).split(sep);
  const parts = rest[0]!.startsWith("@") ? rest.slice(0, 2) : rest.slice(0, 1);
  return join(file.slice(0, index + marker.length), ...parts);
}

function licenses(inputs: string[]): string {
  const roots = new Set<string>();
  for (const input of inputs) {
    const root = packageRoot(join(dirname(ENTRY), "..", input));
    if (root) roots.add(root);
  }
  const notices: string[] = [];
  for (const root of [...roots].sort()) {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; version: string; license?: string };
    const file = existsSync(root) ? readdirSync(root).find((name) => /^(licen[cs]e|copying)(\.|$)/i.test(name)) : undefined;
    const text = file ? readFileSync(join(root, file), "utf8").trim() : `License: ${manifest.license ?? "unknown"}`;
    notices.push(`${manifest.name}@${manifest.version}\n\n${text}`);
  }
  return `/*! Bundled third-party software:\n\n${notices.join("\n\n----\n\n").replace(/\*\//g, "* /")}\n*/\n`;
}

let bundle: Promise<string> | null = null;

export function activityBundle(): Promise<string> {
  bundle ??= build({
    entryPoints: [ENTRY],
    absWorkingDir: join(dirname(ENTRY), ".."),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    write: false,
    metafile: true,
    legalComments: "none",
    logLevel: "silent",
  }).then((result) => licenses(Object.keys(result.metafile.inputs)) + result.outputFiles[0]!.text)
    /* (esbuild's service process would otherwise stay resident beside the
       server; a later build starts another) */
    .finally(() => stop().catch(() => {}));
  bundle.catch(() => { bundle = null; });
  return bundle;
}
