// Regenerates every PNG from the SVG sources in assets/. Run: npm run icons
import { Resvg } from "@resvg/resvg-js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const font = { loadSystemFonts: true, defaultFontFamily: "Segoe UI" };

async function render(svgFile, outFile, width) {
  const svg = await readFile(join(root, "assets", svgFile));
  const png = new Resvg(svg, { fitTo: { mode: "width", value: width }, font }).render().asPng();
  await mkdir(dirname(join(root, outFile)), { recursive: true });
  await writeFile(join(root, outFile), png);
}

for (const size of [16, 32, 48, 128]) await render("icon.svg", `src/ext/icons/icon-${size}.png`, size);
await render("promo-small.svg", "store/promo-small-440x280.png", 440);
