// Bundles the spike content script into spike/dist/content.js (IIFE).
// Run from any directory: node spike/build.mjs
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const spikeDir = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(spikeDir, "src", "content.ts")],
  outfile: join(spikeDir, "dist", "content.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome110",
  sourcemap: "inline",
  logLevel: "info",
});
