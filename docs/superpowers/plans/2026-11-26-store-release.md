# Store Release Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Qommit repo ready for its first store release v1.0.0: icon A in every size, a release workflow on tag push, a public privacy page, the store texts, a release guide, README and MIT license.

**Architecture:** One SVG source per graphic, turned into committed PNGs by `scripts/icons.mjs`; the build copies the icons into the extension. A GitHub Actions workflow on tags `v*` checks the tag against the manifest version (`scripts/release-check.mjs`), tests, builds and attaches the zip to a GitHub Release. Public texts live in `site/`, `store/`, `README.md`, `LICENSE`, guarded by a test against internal names.

**Tech Stack:** Node (ESM scripts), esbuild build (`scripts/build-ext.mjs`), Vitest, `@resvg/resvg-js` (dev only), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-26-store-release-design.md`

## Global Constraints

- Icon draft A: rounded square `#0F6E56`, white Q ring, tail ending in a commit dot `#9FE1CB`. No Qlik or GitHub logos anywhere.
- Icon sizes: 16, 32, 48, 128 px at `src/ext/icons/icon-<size>.png`; store tile 440 × 280 at `store/promo-small-440x280.png`.
- Manifest gains `icons` (16/32/48/128), `action.default_icon` (16/32), `homepage_url: "https://github.com/lr-bicc/qommit"`. Manifest version stays `0.1.2` (1.0.0 belongs to the release itself).
- Tags are `v` + manifest version; Chrome versions are 1–4 dot-separated integers (0–65535), no suffixes.
- Privacy page URL: `https://lr-bicc.github.io/qommit/`; page in English.
- No internal names in public texts: `lrworld`, `lr-analytics`, `LR\\`, `R.Vasilev@`, `Supply Chain`.
- License: MIT, `Copyright (c) 2026 Rumen Vasilev`.
- Nothing is pushed, tagged, made public or switched to Pages without the user's explicit OK.

## Review Focus

1. A tag like `v1.0.0-rc1` or `v1.0` that Chrome would reject or that differs from the manifest → the workflow stops before building (Task 2 tests).
2. A zip with the files inside a subfolder → the store rejects it; the workflow checks `manifest.json` is at the zip's top level (Task 2 workflow step).
3. A manifest that names an icon the build did not copy → Chrome refuses to load the extension (Task 1 build test checks every manifest icon path exists in `dist`).
4. Internal hostnames or e-mail addresses slipping into the public texts (Task 3 test).
5. A store short description over 132 characters → the dashboard refuses it (Task 3 test).

---

### Task 1: Icon A and the manifest

**Files:**
- Create: `assets/icon.svg`, `assets/promo-small.svg`, `scripts/icons.mjs`, `src/ext/icons/icon-{16,32,48,128}.png`, `store/promo-small-440x280.png`, `tests/ext/icons.test.ts`
- Modify: `package.json` (script `icons`, devDependency `@resvg/resvg-js`), `scripts/build-ext.mjs` (copy `src/ext/icons/` to `<out>/icons/`), `src/ext/manifest.json`, `tests/ext/build.test.ts`

**Interfaces:**
- Produces: `npm run icons` regenerates every PNG from the SVGs; `dist/ext/icons/icon-<size>.png`.

- [ ] **Step 1: Tests.** In `tests/ext/icons.test.ts`, `test("every icon PNG has its size")`: for each of `src/ext/icons/icon-16.png` … `-128.png` and `store/promo-small-440x280.png`, read bytes 16–23 of the PNG header (width, height as big-endian uint32) and expect `[16,16]`, `[32,32]`, `[48,48]`, `[128,128]`, `[440,280]`. In `tests/ext/build.test.ts` extend the expected manifest with `icons: { "16": "icons/icon-16.png", "32": "icons/icon-32.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" }`, `action: { default_title: "Qommit", default_icon: { "16": "icons/icon-16.png", "32": "icons/icon-32.png" } }`, `homepage_url: "https://github.com/lr-bicc/qommit"`, and expect every path in `icons` and `action.default_icon` to exist in the build output.
- [ ] **Step 2:** Run `npx vitest run tests/ext/icons.test.ts tests/ext/build.test.ts` → both FAIL.
- [ ] **Step 3:** Install `@resvg/resvg-js` as devDependency. Write `assets/icon.svg` (viewBox 0 0 128 128, draft A as shown to the user: rect rx 28 `#0F6E56`; circle cx 58 cy 58 r 29, stroke white 14; tail line 79,79 → 97,97, round caps; dot cx 100 cy 100 r 12 `#9FE1CB`) and `assets/promo-small.svg` (440 × 280, white background, the icon at 128 px on the left, "Qommit" and the line "Version control for Qlik Sense apps with GitHub" in a sans-serif system font, dark text `#04342C`). `scripts/icons.mjs` renders `icon.svg` at 16/32/48/128 (`fitTo: { mode: "width", value: size }`) and `promo-small.svg` at its own size, writing the paths above. Add `"icons": "node scripts/icons.mjs"`. Run it and commit the PNGs. The build copies the icons folder; update the manifest.
- [ ] **Step 4:** Run `npx vitest run tests/ext/icons.test.ts tests/ext/build.test.ts` → PASS; `npm run -s build:ext` and look at the 16 px PNG and the promo tile.
- [ ] **Step 5:** Commit `feat(ext): icon A in all sizes, store tile, manifest icons`.

### Task 2: Release workflow

**Files:**
- Create: `scripts/release-check.mjs`, `scripts/release-check.d.mts` (type declaration, so the TypeScript test can import it under `tsc --noEmit`), `.github/workflows/release.yml`, `tests/release-check.test.ts`

**Interfaces:**
- Produces: `export function checkTag(tag: string, manifestVersion: string): string | null` (null: OK; otherwise the reason). CLI: `node scripts/release-check.mjs <tag>` reads `src/ext/manifest.json`, prints the reason and exits 1 when `checkTag` returns one.

- [ ] **Step 1: Tests** in `tests/release-check.test.ts`:
  - `checkTag("v1.0.0", "1.0.0")` → `null`; `checkTag("v1.2.3.4", "1.2.3.4")` → `null`
  - `checkTag("v1.0.1", "1.0.0")` → contains `"1.0.0"` and `"v1.0.1"`
  - `checkTag("1.0.0", "1.0.0")`, `checkTag("v1.0.0-rc1", "1.0.0-rc1")`, `checkTag("v1.65536", "1.65536")`, `checkTag("v01.0", "01.0")` → each not null
- [ ] **Step 2:** Run `npx vitest run tests/release-check.test.ts` → FAIL.
- [ ] **Step 3:** Implement `checkTag`: tag must be `v` + version, and the version 1–4 parts of integers 0–65535 without leading zeros. Write `release.yml`: `on: push: tags: ["v*"]`, `permissions: contents: write`, job on `ubuntu-latest`: checkout, `actions/setup-node` (Node 22, npm cache), `npm ci`, `node scripts/release-check.mjs "$GITHUB_REF_NAME"`, `npm run typecheck`, `npm test`, `npm run build:ext`, `cd dist/ext && zip -r "../../qommit-${GITHUB_REF_NAME#v}.zip" . -x "*.map"`, a check that `unzip -Z1` lists `manifest.json` as a top-level entry, `gh release create "$GITHUB_REF_NAME" "qommit-${GITHUB_REF_NAME#v}.zip" --title "$GITHUB_REF_NAME" --generate-notes` with `GH_TOKEN: ${{ github.token }}`.
- [ ] **Step 4:** Run the test → PASS; `node scripts/release-check.mjs v0.1.2` → exit 0; `node scripts/release-check.mjs v1.0.0` → exit 1 with the reason.
- [ ] **Step 5:** Commit `ci: release workflow on version tags`.

### Task 3: Public texts

**Files:**
- Create: `site/index.html`, `store/listing.md`, `docs/release.md`, `README.md`, `LICENSE`, `tests/public-files.test.ts`

**Interfaces:**
- Consumes: the privacy URL, the workflow from Task 2, `npm run icons` from Task 1.
- Produces: `store/listing.md` has a line `**Short description:** <text>`.

- [ ] **Step 1: Tests** in `tests/public-files.test.ts`:
  - `test("public texts name nothing internal")`: for `site/index.html`, `store/listing.md`, `README.md`, `LICENSE`, `docs/release.md`, none contains (case-insensitive) `lrworld`, `lr-analytics`, `LR\\`, `R.Vasilev@`, `Supply Chain`.
  - `test("the store short description fits")`: the text after `**Short description:** ` in `store/listing.md` is 1–132 characters.
  - `test("the privacy page says where data goes")`: `site/index.html` contains `chrome.storage.local`, `api.github.com`, `https://github.com/lr-bicc/qommit/issues`.
  - `test("MIT license with its holder")`: `LICENSE` starts with `MIT License` and contains `Copyright (c) 2026 Rumen Vasilev`.
  - `test("README links the privacy policy")`: contains `https://lr-bicc.github.io/qommit/`.
- [ ] **Step 2:** Run `npx vitest run tests/public-files.test.ts` → FAIL.
- [ ] **Step 3:** Write the files per spec sections 2, 4, 5, 6. `site/index.html` is self-contained (inline CSS, no external requests). `store/listing.md` covers every field in spec section 4, with one reason per permission. `docs/release.md` holds the steps of spec section 5, including the one-time steps (make public, Pages on `gh-pages`, check the URL) and how the `gh-pages` branch gets `site/index.html` (`git worktree` or orphan branch with only `index.html`).
- [ ] **Step 4:** Run the test → PASS; then `npm test` and `npm run typecheck` → all pass.
- [ ] **Step 5:** Commit `docs: privacy page, store listing, release guide, README, MIT license`. Create the orphan branch `gh-pages` locally with only `index.html` (copy of `site/index.html`); it is pushed only with the user's OK.
