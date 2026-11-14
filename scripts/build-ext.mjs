// Builds the Chrome extension into dist/ext (or the directory given as first argument).
// Run from any directory: node scripts/build-ext.mjs [outDir]
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { copyFile, mkdir } from "node:fs/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "ext");
const outDir = resolve(process.argv[2] ?? join(root, "dist", "ext"));

const common = {
  bundle: true,
  platform: "browser",
  target: "chrome116",
  jsx: "automatic",
  jsxImportSource: "preact",
  sourcemap: "linked",
  logLevel: "warning",
};

await mkdir(outDir, { recursive: true });

await build({ ...common, entryPoints: [{ in: join(src, "background", "sw.ts"), out: "sw" }], outdir: outDir, format: "esm" });
for (const [entry, out] of [
  [join(src, "content", "content.ts"), "content"],
  [join(src, "panel", "main.tsx"), "panel"],
  [join(src, "options", "main.tsx"), "options"],
]) {
  await build({ ...common, entryPoints: [{ in: entry, out }], outdir: outDir, format: "iife" });
}

await copyFile(join(src, "manifest.json"), join(outDir, "manifest.json"));
await copyFile(join(src, "panel", "panel.html"), join(outDir, "panel.html"));
await copyFile(join(src, "panel", "panel.css"), join(outDir, "panel.css"));
await copyFile(join(src, "options", "options.html"), join(outDir, "options.html"));
