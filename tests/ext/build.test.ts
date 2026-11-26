import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("build writes a loadable extension", () => {
  const out = mkdtempSync(join(tmpdir(), "qommit-ext-"));
  execFileSync("node", ["scripts/build-ext.mjs", out], { stdio: "pipe" });
  for (const f of ["manifest.json", "sw.js", "content.js", "panel.html", "panel.js", "options.html", "options.js", "diff.html", "diff.js"]) {
    expect(existsSync(join(out, f)), f).toBe(true);
  }
  expect(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"))).toEqual({
    manifest_version: 3,
    name: "Qommit",
    version: "0.1.2",
    description: "Version control for Qlik Sense apps with GitHub.",
    minimum_chrome_version: "116",
    permissions: ["storage", "scripting", "sidePanel"],
    host_permissions: ["https://api.github.com/*", "https://codeload.github.com/*"],
    optional_host_permissions: ["https://*/*"],
    background: { service_worker: "sw.js", type: "module" },
    homepage_url: "https://github.com/lr-bicc/qommit",
    icons: { "16": "icons/icon-16.png", "32": "icons/icon-32.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" },
    action: { default_title: "Qommit", default_icon: { "16": "icons/icon-16.png", "32": "icons/icon-32.png" } },
    side_panel: { default_path: "panel.html" },
    options_ui: { page: "options.html", open_in_tab: true },
  });
  const built = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  for (const p of [...Object.values<string>(built.icons), ...Object.values<string>(built.action.default_icon)]) {
    expect(existsSync(join(out, p)), p).toBe(true);
  }
  expect(readFileSync(join(out, "panel.html"), "utf8")).toContain('<script src="panel.js"></script>');
  expect(readFileSync(join(out, "diff.html"), "utf8")).toContain('<script src="diff.js"></script>');
}, 60_000);
