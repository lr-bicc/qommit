// Checks that a release tag matches the extension version in src/ext/manifest.json.
// Run: node scripts/release-check.mjs v1.0.0   (exits 1 with the reason on mismatch)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const PART = /^(0|[1-9]\d{0,4})$/;

/** Returns null when the tag is a valid release tag for manifestVersion, otherwise the reason. */
export function checkTag(tag, manifestVersion) {
  const parts = manifestVersion.split(".");
  const valid = parts.length >= 1 && parts.length <= 4 && parts.every((p) => PART.test(p) && Number(p) <= 65535);
  if (!valid) {
    return `manifest version "${manifestVersion}" is not a valid Chrome extension version (1-4 integers 0-65535 without leading zeros, separated by dots)`;
  }
  if (tag !== `v${manifestVersion}`) {
    return `tag "${tag}" does not match manifest version "${manifestVersion}" (expected "v${manifestVersion}")`;
  }
  return null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(join(root, "src", "ext", "manifest.json"), "utf8"));
  const reason = checkTag(process.argv[2] ?? "", manifest.version);
  if (reason) {
    console.error(reason);
    process.exit(1);
  }
  console.log(`tag ${process.argv[2]} matches manifest version ${manifest.version}`);
}
