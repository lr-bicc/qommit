# Qommit – Plan 2 von 3: Extension, Teil 1 – Verbinden und Speichern

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eine ladbare Chrome-Extension, mit der ein Entwickler eine Qlik-Sense-App mit einem GitHub-Repo verbindet (Repo anlegen, verbinden, Branch anlegen), ihre lokalen Änderungen sieht und sie mit „Save changes“ committet.

**Architecture:** Das Content Script führt alle Abläufe aus: Es liest die App über enigma.js und ruft GitHub über den Service Worker auf, der als Einziger den Token kennt. Das Side Panel (Preact) schickt Befehle an das Content Script seines Tabs und zeigt Ergebnisse. Die Abläufe selbst sind reine Funktionen über zwei Schnittstellen (`AppPort` für Qlik, `GitHubPort` für GitHub) und werden mit Attrappen getestet. Plan 3 ergänzt Update, Diff-Ansicht, Tags und Import.

**Tech Stack:** TypeScript (strict), Node 22, Vitest, esbuild, Preact, enigma.js, `happy-dom` und `@testing-library/preact` (nur Tests), `@types/chrome`.

**Spec:** `docs/superpowers/specs/2026-11-10-qlik-github-versioning-design.md` (Revision 9). Spike-Ergebnisse: `docs/superpowers/spike/results.md`.

## Umfang

In diesem Plan: Optionsseite, Service Worker, Side Panel mit den Reitern „Local Changes“ und „History“, Zustände der Verknüpfung (Spec 5), Create repository, Connect to existing repository, Create Branch, Unlink, Local Changes, Save changes, Nur-Lese-Ansicht für veröffentlichte Apps.

Nicht in diesem Plan (Plan 3): Update, Sicherungs-Branch, Diff-Overlay („details“), Aktionen in der History, Tags, Import. Bis dahin zeigt das Panel den Hinweis „Repository has N new commits“ ohne Update-Schaltfläche, und die Nachfrage vor einem Commit auf einen veralteten Stand bietet nur „Commit anyway“ und „Cancel“.

## Global Constraints

- Sprache: Code, Bezeichner, Kommentare, Fehlermeldungen und alle UI-Texte auf Englisch. UI-Texte exakt wie in den Aufgaben angegeben.
- Der GitHub-Token liegt in `chrome.storage.local` unter dem Schlüssel `secret`. Nur der Service Worker und die Optionsseite greifen auf ihn zu. Er erscheint nie in Logs, Fehlermeldungen oder Nachrichten an Content Script und Panel.
- `src/core/`, `src/github/`, `src/qlik/` und `src/ext/flows/` verwenden keine `chrome.*`-APIs. `src/qlik/` greift nur über übergebene Funktionen (`fetch`, enigma) nach außen, `src/ext/flows/` nur über `FlowPorts`.
- Schreibzugriffe auf die Qlik-App in diesem Plan: ausschließlich das Link-Objekt (`qId` und `qType` `qommit-link`) anlegen, ändern, löschen. Kein `DoSave`. In veröffentlichten Apps wird nichts geschrieben.
- Schlägt das Lesen eines einzelnen Objekts fehl, bricht das Lesen der App insgesamt ab. Ein unvollständiger Stand wird nie mit dem Repo verglichen.
- Der Service Worker führt nur die Aufrufe aus `GitHubPort` aus, nur für Repos der eingestellten Org, nur für Nachrichten der eigenen Extension.
- Manifest-Berechtigungen exakt: `permissions: ["storage", "scripting", "sidePanel"]`, `host_permissions: ["https://api.github.com/*", "https://codeload.github.com/*"]`, `optional_host_permissions: ["https://*/*"]`. Kein `content_scripts`-Eintrag; das Panel lädt `content.js` bei Bedarf in seinen Tab.
- Repo-Format wie Spec 4, Commit-Nachricht für Änderungen an der Branch-Tabelle exakt `Update branches table`.
- Binärdaten und `Map`-Werte überstehen `chrome.runtime`-Nachrichten nicht; sie werden über `src/ext/shared/wire.ts` umgewandelt.
- Erlaubte neue Abhängigkeiten: `preact`, `enigma.js` (nach `dependencies`), `@types/chrome`, `happy-dom`, `@testing-library/preact`. Keine weiteren.
- Commit-Nachrichten im Projekt: Conventional Commits. Jeder Commit-Schritt bedeutet `git add -A && git commit -m "<Nachricht>"`. `npm test` und `npm run typecheck` sind vor jedem Commit grün.

## Review Focus

1. **Sitzung bricht während des Lesens ab** (Qlik-Timeout, WebSocket geschlossen). Erwartet: Der Befehl endet mit einer lesbaren Meldung, es entsteht keine Liste lokaler Änderungen aus einem halben Stand, der nächste Befehl öffnet eine neue Sitzung. → Tests in Task 6 und Task 12.
2. **Erster Kontakt mit einem gitoqlok-Repo:** Der Basis-Tree enthält 357 Dateien skripterzeugter Variablen, `loadScript.qvs`, `builds/x.qvf`, `objects/fields.json`, und die Sheets tragen eine fremde App-ID. Erwartet: Variablen-Dateien erscheinen als „deleted“, die nicht gepflegten Dateien getrennt als entfernbar, `README.md` gar nicht; ein Commit nur der gewählten Pfade lässt alles andere unberührt. → Tests in Task 9 und Task 11.
3. **Jemand committet zwischen „Local Changes“ und „Save“.** Erwartet: kein Commit, Liste der fremden Commits; auch wenn GitHub erst das Setzen des Branches ablehnt. → Tests in Task 11.
4. **Namen mit Sonderzeichen:** Branch `feature/x`, App-Titel mit Emoji (der Testserver hat den Stream „📝 Templates“), Dateiname `Stock Availability.png`. Erwartet: gültiger Repo-Name, korrekte Zeile in der Branch-Tabelle, korrekt kodierte URLs. → Tests in Task 6 und Task 10.
5. **Der Tab wechselt die App, während das Panel offen ist** (Navigation vom Hub in eine App oder in eine andere App). Erwartet: Jeder Befehl bezieht sich auf die App der aktuellen URL; eine Sitzung der vorigen App wird nicht weiterverwendet. → Test in Task 12.

## Dateistruktur

```
scripts/build-ext.mjs               baut dist/ext/ (sw.js, content.js, panel.*, options.*, manifest.json)
src/ext/manifest.json
src/ext/shared/options.ts           Optionen und Token in chrome.storage.local
src/ext/shared/wire.ts              Base64, Umwandlung von Dateiinhalten für Nachrichten
src/ext/shared/github-port.ts       GitHubPort, Gateway-Nachrichten, GatewayError, createGitHubPort
src/ext/shared/commands.ts          Befehle Panel → Content Script, Ergebnis- und Ereignistypen
src/ext/background/gateway.ts       handleGateway: geprüfter Zugang zu src/github
src/ext/background/side-panel.ts    welches Panel ein Tab bekommt
src/ext/background/sw.ts            Einstieg Service Worker
src/qlik/engine-types.ts            EngineApi, NxInfo
src/qlik/location.ts                Tab-URL → Server, Präfix, App-ID
src/qlik/session.ts                 CSRF-Token, enigma-Sitzung
src/qlik/content-files.ts           statische Dateien der App auflisten und laden
src/qlik/reader.ts                  App → AppSnapshot
src/qlik/link.ts                    Link-Objekt, gitoqlok-Angaben, App-Infos
src/ext/flows/ports.ts              AppPort, LinkCache, FlowPorts, FlowError, loadLink, saveLink
src/ext/flows/status.ts             Zustand der Verknüpfung (Spec 5)
src/ext/flows/local-changes.ts      lokale Änderungen
src/ext/flows/setup.ts              Create repository, Connect, Create Branch, Unlink
src/ext/flows/commit.ts             Save changes
src/ext/content/app-port.ts         AppPort über einer enigma-Sitzung
src/ext/content/router.ts           Befehle ausführen
src/ext/content/content.ts          Einstieg Content Script
src/ext/panel/…                     Side Panel (Preact)
src/ext/options/…                   Optionsseite (Preact)
tests/ext/fake-chrome.ts  tests/ext/fake-ports.ts  tests/qlik/fake-engine.ts
docs/superpowers/acceptance/plan-2-checklist.md
```

---

### Task 1: Build, Manifest und Testumgebung

**Files:**
- Create: `scripts/build-ext.mjs`, `src/ext/manifest.json`, `src/ext/panel/panel.html`, `src/ext/panel/main.tsx`, `src/ext/options/options.html`, `src/ext/options/main.tsx`, `src/ext/background/sw.ts`, `src/ext/content/content.ts`
- Modify: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Test: `tests/ext/build.test.ts`

**Interfaces:**
- Produces: `node scripts/build-ext.mjs [outDir]` (Standard `dist/ext`) schreibt `manifest.json`, `sw.js` (ESM), `content.js` (IIFE), `panel.html`, `panel.js` (IIFE), `options.html`, `options.js` (IIFE). npm-Skript `build:ext`. Tests dürfen `.test.tsx` heißen; eine Testdatei mit DOM beginnt mit `// @vitest-environment happy-dom`.

- [ ] **Step 1: Abhängigkeiten.** `npm i preact enigma.js` und `npm i -D @types/chrome happy-dom @testing-library/preact`. `enigma.js` steht danach unter `dependencies`.

- [ ] **Step 2: Failing test.**

```ts
// tests/ext/build.test.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("build writes a loadable extension", () => {
  const out = mkdtempSync(join(tmpdir(), "qommit-ext-"));
  execFileSync("node", ["scripts/build-ext.mjs", out], { stdio: "pipe" });
  for (const f of ["manifest.json", "sw.js", "content.js", "panel.html", "panel.js", "options.html", "options.js"]) {
    expect(existsSync(join(out, f)), f).toBe(true);
  }
  expect(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"))).toEqual({
    manifest_version: 3,
    name: "Qommit",
    version: "0.1.0",
    description: "Version control for Qlik Sense apps with GitHub.",
    minimum_chrome_version: "116",
    permissions: ["storage", "scripting", "sidePanel"],
    host_permissions: ["https://api.github.com/*", "https://codeload.github.com/*"],
    optional_host_permissions: ["https://*/*"],
    background: { service_worker: "sw.js", type: "module" },
    action: { default_title: "Qommit" },
    side_panel: { default_path: "panel.html" },
    options_ui: { page: "options.html", open_in_tab: true },
  });
  expect(readFileSync(join(out, "panel.html"), "utf8")).toContain('<script src="panel.js"></script>');
}, 60_000);
```

- [ ] **Step 3:** `npx vitest run tests/ext/build.test.ts` → FAIL (Skript fehlt).

- [ ] **Step 4: Umsetzen.**
  - `scripts/build-ext.mjs`: esbuild, `bundle: true`, `target: "chrome116"`, `jsx: "automatic"`, `jsxImportSource: "preact"`, `sourcemap: "linked"`; vier Einstiege wie oben; kopiert `manifest.json` und die beiden HTML-Dateien. Pfade relativ zur Skriptdatei, nicht zum Arbeitsverzeichnis.
  - HTML-Dateien: `<!doctype html>`, `<meta charset="utf-8">`, `<div id="root"></div>`, Skript wie im Test.
  - `main.tsx` (Panel und Optionen): rendert vorerst `<p>Qommit</p>` in `#root`. `sw.ts` und `content.ts`: vorerst nur ein Kommentar.
  - `tsconfig.json`: `"jsx": "react-jsx"`, `"jsxImportSource": "preact"`, `"resolveJsonModule": true`, `types` um `"chrome"` ergänzen. `vitest.config.ts`: `include: ["tests/**/*.test.{ts,tsx}"]`, `esbuild: { jsx: "automatic", jsxImportSource: "preact" }`.
  - `package.json`: Skript `"build:ext": "node scripts/build-ext.mjs"`.

- [ ] **Step 5:** `npm test && npm run typecheck && node spike/build.mjs` → alles grün, der Spike baut weiter.

- [ ] **Step 6: Commit** `feat(ext): build script, manifest and preact test setup`

---

### Task 2: Ergänzungen der Bibliothek nach dem Spike

**Files:**
- Modify: `src/core/serializer.ts`, `src/core/deserializer.ts`, `src/core/repo-layout.ts`, `src/github/repo.ts`
- Test: `tests/core/serializer.test.ts`, `tests/core/repo-layout.test.ts`, `tests/github/repo.test.ts`, `tests/integration/roundtrip.test.ts` (Aufruf anpassen)

**Interfaces:**
- Produces:
  - `serializeApp(snap, { canonicalAppId })`: ersetzt **jede** GUID in `/appcontent/<GUID>/` durch `canonicalAppId`.
  - `deserializeApp(files, { targetAppId })`: ersetzt jede GUID in `/appcontent/<GUID>/` durch `targetAppId`. Die Option `knownAppIds` entfällt.
  - `canonicalAppId(rows, defaultBranch)`: App-ID der Zeile des Default-Branches, sonst die der ersten Zeile mit App-ID, sonst `null`.
  - `getRepo(c, repo): Promise<RepoRef | null>` (`GET /repos/{repo}` → `{ repo: full_name, defaultBranch: default_branch }`; `not-found` → `null`).
  - `readTextFile(c, repo, ref, path): Promise<string | null>` (`GET /repos/{repo}/contents/{path}?ref={ref}`, Inhalt aus Base64 als UTF-8; `not-found` → `null`).
  - `whoAmI(c): Promise<{ login: string }>` (`GET /user`).

GUID heißt hier: `[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`.

- [ ] **Step 1: Failing tests.**

```ts
// tests/core/serializer.test.ts (ergänzen)
test("every app id in appcontent urls is normalised, in both directions", () => {
  const foreign = "22222222-2222-4222-8222-222222222222";
  const sheet = { qProperty: { qInfo: { qId: "s9", qType: "sheet" },
    a: `/appcontent/${foreign}/a.png`, b: `/appcontent/${APP_ID}/b.png`, c: "/appcontent/not-a-guid/c.png" }, qChildren: [] };
  const files = serializeApp({ ...makeSnapshot(), sheets: [sheet] }, { canonicalAppId: CANON_ID });
  const text = files.get("objects/sheets/s9.json") as string;
  expect(text).toContain(`/appcontent/${CANON_ID}/a.png`);
  expect(text).toContain(`/appcontent/${CANON_ID}/b.png`);
  expect(text).toContain("/appcontent/not-a-guid/c.png");

  const legacy = new Map(files).set("objects/sheets/s9.json", text.split(CANON_ID).join(foreign));
  const back = deserializeApp(legacy, { targetAppId: APP_ID });
  expect(JSON.stringify(back.sheets)).not.toContain(foreign);
  expect(JSON.stringify(back.sheets)).toContain(`/appcontent/${APP_ID}/a.png`);
});

// tests/core/repo-layout.test.ts (ergänzen)
test("canonicalAppId falls back to the first row with an app id", () => {
  const rows = [{ branch: "x", appUrl: "u", appId: null }, { branch: "dev", appUrl: "u", appId: "id-dev" }];
  expect(canonicalAppId(rows, "main")).toBe("id-dev");
  expect(canonicalAppId([], "main")).toBeNull();
});
```

`tests/github/repo.test.ts` (ergänzen, mit dem vorhandenen `mockFetch`): `getRepo` liefert `{ repo: "lr-bicc/app", defaultBranch: "main" }` und bei 404 `null`; `readTextFile` dekodiert `{ content: "w6Rw\nZmVs\n", encoding: "base64" }` zu `"äpfel"`, kodiert den Pfad segmentweise (`docs/My File.md` → `docs/My%20File.md`), gibt bei 404 `null` zurück und lässt einen 403 durch; `whoAmI` liefert `{ login: "octocat" }`.

- [ ] **Step 2:** Tests laufen lassen → FAIL.
- [ ] **Step 3: Umsetzen.** Bestehende Aufrufe von `deserializeApp` in den Tests an die neue Signatur anpassen; ihre übrigen Erwartungen bleiben.
- [ ] **Step 4:** `npm test && npm run typecheck && node spike/build.mjs` → grün.
- [ ] **Step 5: Commit** `feat: normalise every app id in appcontent urls, repository lookups`

---

### Task 3: Optionen und Optionsseite

**Files:**
- Create: `src/ext/shared/options.ts`, `src/ext/options/Options.tsx`, `tests/ext/fake-chrome.ts`
- Modify: `src/ext/options/main.tsx`
- Test: `tests/ext/options.test.ts`, `tests/ext/options-page.test.tsx`

**Interfaces:**
- Produces:

```ts
// src/ext/shared/options.ts
export interface Options { org: string; repoPrefix: string; servers: string[] } // servers: origins, e.g. "https://qlik.example.com"
export const DEFAULT_OPTIONS: Options = { org: "lr-bicc", repoPrefix: "", servers: [] };
export function normalizeServer(input: string): string | null;       // https origin or null
export function loadOptions(): Promise<Options>;                      // storage key "options", merged over the defaults
export function saveOptions(patch: Partial<Options>): Promise<Options>;
export function loadToken(): Promise<string>;                         // storage key "secret" → { token }, "" if unset
export function saveToken(token: string): Promise<void>;

// tests/ext/fake-chrome.ts
export interface FakeChrome {
  store: Record<string, unknown>;                    // chrome.storage.local contents
  grantPermissions: boolean;                         // answer of chrome.permissions.request
  permissionRequests: string[][];                    // origins of each request
  sent: unknown[];                                   // chrome.runtime.sendMessage payloads
  respond: (message: any) => unknown;                // answer for runtime.sendMessage / tabs.sendMessage
  tabMessages: { tabId: number; message: unknown }[];
  injected: { tabId: number; files: string[] }[];    // chrome.scripting.executeScript calls
  panelOptions: unknown[];                           // chrome.sidePanel.setOptions calls
  optionsPageOpened: number;
  emitMessage(message: unknown, sender?: unknown): void;   // fires runtime.onMessage listeners
}
export function installFakeChrome(): FakeChrome;     // sets globalThis.chrome; runtime.id is "qommit-test"
```

Die Attrappe deckt ab: `storage.local.get/set/remove`, `storage.onChanged`, `permissions.request/remove`, `runtime.id`, `runtime.sendMessage`, `runtime.onMessage`, `runtime.openOptionsPage`, `tabs.sendMessage`, `tabs.query`, `tabs.onUpdated`, `scripting.executeScript`, `sidePanel.setOptions`, `sidePanel.setPanelBehavior`, `runtime.onInstalled`. Wirft `respond`, lehnt der Aufruf ab; liefert es `undefined`, antwortet niemand. Spätere Aufgaben nutzen die Attrappe unverändert.

- [ ] **Step 1: Failing tests.**

```ts
// tests/ext/options.test.ts
test("normalizeServer keeps only an https origin", () => {
  expect(normalizeServer(" lr-analytics-test.lrworld.com ")).toBe("https://lr-analytics-test.lrworld.com");
  expect(normalizeServer("https://lr-analytics-test.lrworld.com/qs/hub/")).toBe("https://lr-analytics-test.lrworld.com");
  expect(normalizeServer("https://host:4443/x")).toBe("https://host:4443");
  expect(normalizeServer("http://host")).toBeNull();
  expect(normalizeServer("")).toBeNull();
});
test("options and token live under separate storage keys", async () => {
  const c = installFakeChrome();
  expect(await loadOptions()).toEqual(DEFAULT_OPTIONS);
  await saveOptions({ servers: ["https://a"] });
  await saveToken("tok");
  expect(c.store.options).toEqual({ org: "lr-bicc", repoPrefix: "", servers: ["https://a"] });
  expect(c.store.secret).toEqual({ token: "tok" });
  expect(JSON.stringify(c.store.options)).not.toContain("tok");
});
```

`tests/ext/options-page.test.tsx` (happy-dom, `@testing-library/preact`):
  - „Check connection“ sendet `{ target: "gateway", request: { op: "whoAmI", args: [] } }`; bei Antwort `{ ok: true, value: { login: "octocat" } }` steht „Connected as octocat“ auf der Seite, bei `{ ok: false, error: { kind: "unauthorized", message: "x" } }` „Token invalid or expired“.
  - „Add server“ mit Eingabe `qlik.example.com` fragt `["https://qlik.example.com/*"]` an und speichert den Server; mit `grantPermissions = false` erscheint „Permission was not granted“, und `store.options` bleibt ohne Server.
  - Eine ungültige Eingabe (`http://x`) zeigt „Enter an https address“ und fragt keine Berechtigung an.

- [ ] **Step 2:** Tests laufen lassen → FAIL.
- [ ] **Step 3: Umsetzen.** `OptionsPage` (Export aus `Options.tsx`) mit den Bereichen „GitHub“ (Feld „Personal access token“ als Passwortfeld, Schaltfläche „Check connection“, Felder „Organization“ und „Repository prefix (optional)“) und „Qlik Sense servers“ (Eingabe mit Platzhalter `https://qlik.example.com`, „Add server“, je Server „Remove“, das auch die Berechtigung zurückgibt). Jede Änderung wird sofort gespeichert. `main.tsx` rendert `OptionsPage`.
- [ ] **Step 4:** Tests → PASS; `npm run typecheck` grün.
- [ ] **Step 5: Commit** `feat(ext): options storage and options page`

---

### Task 4: GitHub-Zugang über den Service Worker

**Files:**
- Create: `src/ext/shared/wire.ts`, `src/ext/shared/github-port.ts`, `src/ext/background/gateway.ts`, `src/ext/background/side-panel.ts`
- Modify: `src/ext/background/sw.ts`
- Test: `tests/ext/wire.test.ts`, `tests/ext/gateway.test.ts`, `tests/ext/side-panel.test.ts`

**Interfaces:**
- Consumes: `src/github/*` (inkl. `getRepo`, `readTextFile`, `whoAmI` aus Task 2), `loadOptions`, `loadToken`, `tests/github/mock-fetch.ts`.
- Produces:

```ts
// src/ext/shared/wire.ts
export function bytesToBase64(bytes: Uint8Array): string;   // no Buffer; works in a service worker
export function base64ToBytes(text: string): Uint8Array;
export type WireContent = { text: string } | { base64: string };
export function toWire(content: FileContent): WireContent;
export function fromWire(content: WireContent): FileContent;

// src/ext/shared/github-port.ts
export interface GitHubPort {
  whoAmI(): Promise<{ login: string }>;
  listOrgRepos(): Promise<RepoRef[]>;
  findRepoForApp(appId: string): Promise<{ repo: string; branch: string } | null>;
  getRepo(repo: string): Promise<RepoRef | null>;
  createRepo(name: string): Promise<RepoRef>;
  getBranchSha(repo: string, branch: string): Promise<string | null>;
  listBranches(repo: string): Promise<{ name: string; sha: string }[]>;
  getTree(repo: string, commitSha: string): Promise<Map<string, string>>;
  readTextFile(repo: string, ref: string, path: string): Promise<string | null>;
  createBranch(repo: string, name: string, fromSha: string): Promise<void>;
  commitFiles(repo: string, input: { branch: string; parentSha: string; message: string; changes: FileChange[] }): Promise<string>;
  listCommits(repo: string, branch: string, page: number): Promise<CommitInfo[]>;
  compare(repo: string, base: string, head: string): Promise<{ status: "identical" | "ahead" | "behind" | "diverged"; aheadBy: number; behindBy: number; commits: CommitInfo[] }>;
}
export type GatewayErrorKind = GitHubErrorKind | "no-token" | "not-allowed" | "internal";
export interface WireError { kind: GatewayErrorKind; message: string; ssoUrl?: string; resetAt?: number }
export interface GatewayRequest { op: keyof GitHubPort; args: unknown[] }
export type GatewayResponse = { ok: true; value: unknown } | { ok: false; error: WireError };
export class GatewayError extends Error { constructor(public kind: GatewayErrorKind, message: string, public extra?: { ssoUrl?: string; resetAt?: number }); }
export function createGitHubPort(send: (request: GatewayRequest) => Promise<GatewayResponse>): GitHubPort;

// src/ext/background/gateway.ts
export function handleGateway(request: GatewayRequest,
  deps: { loadOptions(): Promise<Options>; loadToken(): Promise<string>; fetch: typeof fetch }): Promise<GatewayResponse>;

// src/ext/background/side-panel.ts
export function panelOptionsFor(tabId: number, url: string | undefined, servers: string[]): { tabId: number; path: string; enabled: true };
export function wireSidePanel(): void;
```

Regeln für `handleGateway`, in dieser Reihenfolge: unbekanntes `op` → `not-allowed`; leerer Token → `no-token`; bei allen Aufrufen mit `repo` als erstem Argument muss es `<org>/<name>` mit der Org aus den Optionen sein (Org ohne Beachtung der Groß-/Kleinschreibung, Name aus `[A-Za-z0-9._-]+`), sonst `not-allowed`; `listOrgRepos`, `findRepoForApp` und `createRepo` verwenden die Org aus den Optionen. In den ersten drei Fällen findet kein `fetch` statt. Ein `GitHubError` wird zu `{ kind, message, ssoUrl?, resetAt? }` (`resetAt` in Millisekunden), jeder andere Fehler zu `kind: "internal"`. Auf der Leitung ist das Ergebnis von `getTree` ein Array von `[path, sha]`, und `changes[].content` ist `WireContent | null`; `createGitHubPort` wandelt beides in beiden Richtungen um.

`panelOptionsFor`: Liegt der Origin von `url` in `servers`, ist `path` `panel.html?tabId=<tabId>`, sonst `panel.html`. `wireSidePanel`: bei Installation `setPanelBehavior({ openPanelOnActionClick: true })`; bei `tabs.onUpdated` und bei Änderung des Speicherschlüssels `options` (dann für alle Tabs aus `tabs.query({})`) `sidePanel.setOptions(panelOptionsFor(…))`.

- [ ] **Step 1: Failing tests.**

```ts
// tests/ext/wire.test.ts
test("binary content survives the wire format", () => {
  const bytes = new Uint8Array([0, 255, 137, 80, 78, 71]);
  const wire = JSON.parse(JSON.stringify(toWire(bytes)));
  expect(fromWire(wire)).toEqual(bytes);
  expect(fromWire(JSON.parse(JSON.stringify(toWire("äö€"))))).toBe("äö€");
  const big = new Uint8Array(300_000).map((_, i) => i % 251);
  expect(base64ToBytes(bytesToBase64(big))).toEqual(big);
});

// tests/ext/side-panel.test.ts
test("tabs on configured servers get their own panel", () => {
  const servers = ["https://qlik.example.com"];
  expect(panelOptionsFor(7, "https://qlik.example.com/qs/sense/app/x", servers)).toEqual({ tabId: 7, path: "panel.html?tabId=7", enabled: true });
  expect(panelOptionsFor(7, "https://other.example.com/", servers)).toEqual({ tabId: 7, path: "panel.html", enabled: true });
  expect(panelOptionsFor(7, undefined, servers)).toEqual({ tabId: 7, path: "panel.html", enabled: true });
});
```

`tests/ext/gateway.test.ts` mit `mockFetch` und `deps = { loadOptions: async () => ({ org: "lr-bicc", repoPrefix: "", servers: [] }), loadToken: async () => token, fetch }`:
  - `token = ""` → `{ ok: false, error: { kind: "no-token", … } }`, `calls.length === 0`.
  - `{ op: "getBranchSha", args: ["other-org/app", "main"] }` → `not-allowed`, kein Aufruf. `{ op: "deleteRepo", args: [] }` → `not-allowed`.
  - `{ op: "getBranchSha", args: ["LR-BICC/app", "main"] }` ist erlaubt.
  - Über `createGitHubPort((r) => handleGateway(JSON.parse(JSON.stringify(r)), deps).then((x) => JSON.parse(JSON.stringify(x))))`: `getTree` liefert eine `Map`; `commitFiles` mit `{ path: "appcontent/a.png", content: new Uint8Array([1, 2, 3]) }` sendet einen Blob mit `encoding: "base64"`, `content: "AQID"`, und mit `content: null` einen Tree-Eintrag mit `sha: null`.
  - Antwortet GitHub mit 401, wirft der Port einen `GatewayError` mit `kind: "unauthorized"`, dessen `message` den Token nicht enthält (Token im Test: `"ghp_secret123"`).

- [ ] **Step 2:** Tests laufen lassen → FAIL.
- [ ] **Step 3: Umsetzen.** `sw.ts`: `wireSidePanel()` und ein `runtime.onMessage`-Listener, der Nachrichten `{ target: "gateway", request }` nur bei `sender.id === chrome.runtime.id` an `handleGateway` gibt (sonst Antwort `not-allowed`) und `true` zurückgibt, damit die Antwort asynchron folgen kann.
- [ ] **Step 4:** Tests → PASS; `npm run typecheck && npm run build:ext` grün.
- [ ] **Step 5: Commit** `feat(ext): github gateway in the service worker`

---

### Task 5: Qlik-Adresse und Sitzung

**Files:**
- Create: `src/qlik/engine-types.ts`, `src/qlik/location.ts`, `src/qlik/session.ts`
- Test: `tests/qlik/location.test.ts`, `tests/qlik/session.test.ts`

**Interfaces:**
- Produces:

```ts
// src/qlik/engine-types.ts
export interface NxInfo { qId: string; qType: string }
export type EngineApi = { [method: string]: (...args: any[]) => Promise<any> };

// src/qlik/location.ts
export interface QlikLocation { origin: string; prefix: string; appId: string | null } // prefix: "" or "/qs"
export function parseQlikUrl(url: string): QlikLocation | null;      // null: not a hub or app page
export function appUrl(loc: { origin: string; prefix: string }, appId: string): string; // <origin><prefix>/sense/app/<appId>
export function engineUrl(loc: { origin: string; prefix: string }, appId: string, csrfToken: string | null): string;

// src/qlik/session.ts
export interface EnigmaSession { open(): Promise<EngineApi>; close(): Promise<void>; on(event: string, handler: (...args: any[]) => void): void }
export type EnigmaCreate = (config: { schema: unknown; url: string; createSocket: (url: string) => WebSocket }) => EnigmaSession;
export interface EngineSession { doc: EngineApi; appId: string; user: string; isClosed(): boolean; close(): Promise<void> }
export function fetchCsrfToken(loc: { origin: string; prefix: string }, fetchFn: typeof fetch): Promise<string | null>;
export function openSession(loc: QlikLocation & { appId: string }, deps: { fetch: typeof fetch; create: EnigmaCreate }): Promise<EngineSession>;
export class QlikSessionError extends Error {}
```

Festlegungen: Der Pfad einer App-Seite ist `<prefix>/sense/app/<appId>[/…]`, der des Hubs `<prefix>/hub[/…]`. `fetchCsrfToken` ruft `GET <origin><prefix>/qps/csrftoken` mit `credentials: "include"` auf und liefert den Antwort-Header `qlik-csrf-token` oder `null` (auch bei jedem Fehler). `engineUrl`: `wss://<host><prefix>/app/<appId>`, mit Token zusätzlich `?qlik-csrf-token=<kodiert>`. `openSession`: Schema `enigma.js/schemas/12.2027.0.json`; `OpenDoc(appId)`, bei Fehler `GetActiveDoc()`; `user` ist `userId` aus der Benachrichtigung `OnAuthenticationInformation` (vor `open()` registrieren, sonst `""`); nach dem Ereignis `closed` liefert `isClosed()` `true`. Scheitert der Aufbau, wirft sie `QlikSessionError` mit der Meldung der Ursache.

- [ ] **Step 1: Failing tests.**

```ts
// tests/qlik/location.test.ts
test("parses app and hub urls with and without a virtual proxy", () => {
  const id = "0a15fa01-ba63-45e6-aa3d-e060205e8344";
  expect(parseQlikUrl(`https://lr-analytics-test.lrworld.com/qs/sense/app/${id}/sheet/abc/state/analysis`))
    .toEqual({ origin: "https://lr-analytics-test.lrworld.com", prefix: "/qs", appId: id });
  expect(parseQlikUrl(`https://host/sense/app/${id}`)).toEqual({ origin: "https://host", prefix: "", appId: id });
  expect(parseQlikUrl("https://host/qs/hub/stream/x")).toEqual({ origin: "https://host", prefix: "/qs", appId: null });
  expect(parseQlikUrl("https://host/qs/qmc/apps")).toBeNull();
  expect(parseQlikUrl("not a url")).toBeNull();
});
test("builds engine and app urls", () => {
  const loc = { origin: "https://host", prefix: "/qs" };
  expect(engineUrl(loc, "A", "t/1")).toBe("wss://host/qs/app/A?qlik-csrf-token=t%2F1");
  expect(engineUrl(loc, "A", null)).toBe("wss://host/qs/app/A");
  expect(appUrl(loc, "A")).toBe("https://host/qs/sense/app/A");
});
```

`tests/qlik/session.test.ts`: `fetchCsrfToken` liefert bei 204 mit Header den Wert, ohne Header `null`, bei abgelehntem `fetch` `null`, und ruft die URL `https://host/qs/qps/csrftoken` mit `credentials: "include"` auf. `openSession` mit einer `create`-Attrappe: die übergebene `url` enthält das Token; schlägt `openDoc` fehl, wird `getActiveDoc` verwendet; `user` ist `"r.vasilev"`, wenn die Attrappe `OnAuthenticationInformation` mit `{ userId: "r.vasilev", userDirectory: "LR" }` meldet; nach dem ausgelösten `closed` ist `isClosed()` `true`; wirft `open()`, endet `openSession` mit `QlikSessionError`.

- [ ] **Step 2:** Tests laufen lassen → FAIL.
- [ ] **Step 3: Umsetzen.**
- [ ] **Step 4:** Tests → PASS; `npm run typecheck` grün.
- [ ] **Step 5: Commit** `feat(qlik): location parsing and engine session`

---

### Task 6: App lesen

**Files:**
- Create: `src/qlik/content-files.ts`, `src/qlik/reader.ts`, `tests/qlik/fake-engine.ts`
- Test: `tests/qlik/content-files.test.ts`, `tests/qlik/reader.test.ts`

**Interfaces:**
- Consumes: `EngineApi`, `NxInfo`, `AppSnapshot`, `serializeApp`, `makeSnapshot`.
- Produces:

```ts
// src/qlik/content-files.ts
export interface ContentFiles { list(): Promise<string[]>; download(name: string): Promise<Uint8Array> }
export function createContentFiles(doc: EngineApi, loc: { origin: string; prefix: string }, appId: string, fetchFn: typeof fetch): ContentFiles;

// src/qlik/reader.ts
export class QlikReadError extends Error {}
export function readApp(doc: EngineApi, appId: string,
  opts: { published: boolean; files?: ContentFiles; onProgress?: (done: number, total: number) => void }): Promise<AppSnapshot>;

// tests/qlik/fake-engine.ts
export interface FakeObject { props: GenericProps; children?: PropertyTree[]; approved?: boolean }
export interface FakeApp {
  title: string; published: boolean; script: string;
  objects: FakeObject[];          // generic objects of any type: sheet, story, masterobject, appprops, ColorMap, qommit-link, _gitoqlikMetaData
  dimensions: GenericProps[]; measures: GenericProps[];
  bookmarks: { props: GenericProps; approved?: boolean }[];
  variables: { props: GenericProps; list?: { qIsScriptCreated?: boolean; qIsReserved?: boolean } }[];
  libraryFiles: string[];         // qUrl values of the app-specific content library
}
export interface FakeDoc extends EngineApi { }
export function fakeDoc(app: FakeApp): { doc: FakeDoc; calls: string[]; maxInFlight(): number; failOn(method: string, id: string): void };
export function appFromSnapshot(snap: AppSnapshot, extra?: Partial<FakeApp>): FakeApp;
```

Die Engine-Attrappe beantwortet: `getAllInfos`, `getObject(id)` (→ `getProperties`, `getFullPropertyTree`, `setProperties`), `getDimension`, `getMeasure`, `getBookmark`, `getVariableById` (→ `getProperties`), `createSessionObject` für `qVariableListDef`, `qAppObjectListDef` und `qBookmarkListDef` (→ `getLayout`), `destroySessionObject`, `getScript`, `getAppLayout`, `getContentLibraries`, `getLibraryContent`, `createObject`, `destroyObject`. Jede Antwort kommt nach einem `setTimeout(0)`; `calls` enthält Einträge der Form `"<methode> <id>"`. Ein unbekanntes Objekt lehnt mit einem Fehler ab. Variablen mit `list.qIsReserved` stehen nicht in `getAllInfos`, nur in der Variablenliste. Fehlt `approved`, gilt das Objekt in den Listen als freigegeben.

Leseregeln (im Spike bestätigt, sie ergeben bytegleiche Dateien zu gitoqlok):

| Teil | Quelle |
|---|---|
| `appProps`, `masterObjects`, `sheets`, `stories` | `GetAllInfos`, Typen `appprops`, `masterobject`, `sheet`, `story`; je Objekt `GetObject` → `GetFullPropertyTree` |
| `dimensions`, `measures`, `bookmarks` | Typen `dimension`, `measure`, `bookmark`; `GetDimension`/`GetMeasure`/`GetBookmark` → `GetProperties` |
| `variables` | IDs aus `GetAllInfos` (Typ `variable`) und aus der Variablenliste (Session-Objekt mit `qVariableListDef: { qType: "variable", qShowReserved: true, qShowConfig: true, qData: {} }`); `GetVariableById` → `GetProperties`. Kennzeichnet nur die Liste eine Variable als `qIsScriptCreated` oder `qIsReserved`, erhält die gelesene Variable dieses Kennzeichen. |
| Wertefarben | Gibt es zu einer Dimension `D` ein Objekt `ColorMapModel_D` vom Typ `ColorMap`, erhält die Dimension als **letzten** Schlüssel `_ColorMapModel: { qInfo: { qId, qType }, colorMap }` aus dessen `GetProperties`. |
| `script` | `GetScript` |
| `staticFiles` | nur wenn `opts.files` übergeben ist: `list()` und `download()` |
| veröffentlichte App | Sheets, Stories und Bookmarks nur, wenn ihr Eintrag in der jeweiligen Liste (`qAppObjectListDef` mit `qType` `sheet` bzw. `story`, `qBookmarkListDef`) `qMeta.approved === true` hat |

Höchstens 8 Engine-Aufrufe laufen gleichzeitig. Session-Objekte werden nach Gebrauch zerstört. `onProgress(done, total)` zählt gelesene Objekte. Scheitert ein Aufruf, endet `readApp` mit `QlikReadError`, dessen Meldung Typ und ID nennt (z. B. `Could not read sheet s1: …`).

`ContentFiles.list()`: `GetContentLibraries` → Eintrag mit `qAppSpecific`, dann `GetLibraryContent(qName)`; der Dateiname ist der dekodierte Teil von `qUrl` hinter `/appcontent/<id>/`; ohne app-eigene Bibliothek `[]`. `download(name)`: `GET <origin><prefix>/appcontent/<appId>/<kodierter Name>` mit `credentials: "include"`; ein Status außerhalb 200–299 wirft `QlikReadError`.

- [ ] **Step 1: Failing tests.**

```ts
// tests/qlik/reader.test.ts
const read = (app: FakeApp, published = false) => readApp(fakeDoc(app).doc, APP_ID, { published });

test("reads back what the serializer needs", async () => {
  const expected = { ...makeSnapshot(), staticFiles: new Map() };
  const snap = await read(appFromSnapshot(makeSnapshot()));
  expect(serializeApp(snap, { canonicalAppId: CANON_ID })).toEqual(serializeApp(expected, { canonicalAppId: CANON_ID }));
});
test("flags from the variable list exclude script-created and reserved variables", async () => {
  const app = appFromSnapshot(makeSnapshot());
  app.variables = [
    { props: { qInfo: { qId: "v1", qType: "variable" }, qName: "vKeep" } },
    { props: { qInfo: { qId: "v2", qType: "variable" }, qName: "vScript" }, list: { qIsScriptCreated: true } },
    { props: { qInfo: { qId: "v3", qType: "variable" }, qName: "vReserved" }, list: { qIsReserved: true } },
  ];
  const files = serializeApp(await read(app), { canonicalAppId: CANON_ID });
  expect([...files.keys()].filter((p) => p.startsWith("objects/variables/"))).toEqual(["objects/variables/v1.json"]);
});
test("value colours are embedded as the last key of the dimension", async () => {
  const app = appFromSnapshot(makeSnapshot());
  app.dimensions = [{ qInfo: { qId: "d1", qType: "dimension" }, qDim: { title: "Class" }, qMetaDef: { title: "Class" } }];
  app.objects.push({ props: { qInfo: { qId: "ColorMapModel_d1", qType: "ColorMap" }, qMetaDef: {}, colorMap: { colors: [{ value: "A" }] } } });
  const dim = JSON.parse(serializeApp(await read(app), { canonicalAppId: CANON_ID }).get("objects/dimensions/d1.json") as string);
  expect(Object.keys(dim)).toEqual(["qInfo", "qDim", "qMetaDef", "_ColorMapModel"]);
  expect(dim._ColorMapModel).toEqual({ qInfo: { qId: "ColorMapModel_d1", qType: "ColorMap" }, colorMap: { colors: [{ value: "A" }] } });
});
test("a published app yields only approved sheets", async () => {
  const app = appFromSnapshot(makeSnapshot(), { published: true });
  app.objects.push({ props: { qInfo: { qId: "private", qType: "sheet" } }, children: [], approved: false });
  expect((await read(app, true)).sheets.map((s) => s.qProperty.qInfo.qId)).not.toContain("private");
  expect((await read(app, false)).sheets.map((s) => s.qProperty.qInfo.qId)).toContain("private");
});
test("one failed object fails the whole read", async () => {
  const fake = fakeDoc(appFromSnapshot(makeSnapshot()));
  const id = makeSnapshot().sheets[0]!.qProperty.qInfo.qId;
  fake.failOn("getFullPropertyTree", id);
  await expect(readApp(fake.doc, APP_ID, { published: false })).rejects.toThrow(new RegExp(`sheet ${id}`));
});
test("reads in parallel, at most 8 calls at a time, and cleans up", async () => {
  const app = appFromSnapshot(makeSnapshot());
  for (let i = 0; i < 40; i++) app.measures.push({ qInfo: { qId: `m${i}`, qType: "measure" } });
  const fake = fakeDoc(app);
  await readApp(fake.doc, APP_ID, { published: false });
  expect(fake.maxInFlight()).toBeGreaterThan(1);
  expect(fake.maxInFlight()).toBeLessThanOrEqual(8);
  expect(fake.calls.filter((c) => c.startsWith("createSessionObject")).length)
    .toBe(fake.calls.filter((c) => c.startsWith("destroySessionObject")).length);
  expect(fake.calls.some((c) => c.startsWith("doSave"))).toBe(false);
});
```

`tests/qlik/content-files.test.ts`: `list()` liefert für `libraryFiles: ["/appcontent/<id>/Stock%20Availability.png", "/appcontent/<id>/a.png"]` die Namen `["Stock Availability.png", "a.png"]` und ohne app-eigene Bibliothek `[]`; `download("Stock Availability.png")` ruft `https://host/qs/appcontent/<id>/Stock%20Availability.png` mit `credentials: "include"` auf und liefert die Bytes; Status 404 → `QlikReadError`. Dazu ein Test, dass `readApp` mit `files` die Dateien in `staticFiles` ablegt.

- [ ] **Step 2:** Tests laufen lassen → FAIL.
- [ ] **Step 3: Umsetzen.**
- [ ] **Step 4:** Tests → PASS; `npm run typecheck` grün.
- [ ] **Step 5: Commit** `feat(qlik): read an app into a snapshot`

---

### Task 7: Link-Objekt, gitoqlok-Angaben, App-Infos

**Files:**
- Create: `src/qlik/link.ts`
- Test: `tests/qlik/link.test.ts`

**Interfaces:**
- Consumes: `EngineApi`, Engine-Attrappe aus Task 6.
- Produces:

```ts
export interface LinkData { repo: string; branch: string; appId: string; syncedSha: string }
export const LINK_ID = "qommit-link";            // qId and qType
export const GITOQLOK_META_ID = "_gitoqlikMetaData";
export function readLink(doc: EngineApi): Promise<LinkData | null>;       // null: no object, or not four non-empty strings
export function writeLink(doc: EngineApi, link: LinkData): Promise<void>; // properties: { qInfo: { qId, qType }, link }
export function removeLink(doc: EngineApi): Promise<void>;                // no error when the object does not exist
export function readGitoqlokMeta(doc: EngineApi): Promise<{ repo: string | null; lastCommitId: string | null } | null>;
export function readAppInfo(doc: EngineApi): Promise<{ title: string; published: boolean }>;  // GetAppLayout: qTitle, published
```

`readGitoqlokMeta`: `null`, wenn das Objekt fehlt. `lastCommitId` ist `_data.infoByServerType.github.lastCommitId`, sofern eine nicht leere Zeichenkette. `repo` ist der erste Wert eines Schlüssels `full_name` unterhalb von `_data` (Tiefensuche in Schlüsselreihenfolge), der dem Muster `<owner>/<name>` ohne Leerzeichen entspricht; sonst `null`. (Der Spike hat nur den Pfad von `lastCommitId` belegt; die Lage von `full_name` kennt das Projekt aus gitoqloks Log, nicht aus der App.)

- [ ] **Step 1: Failing tests.**

```ts
const LINK = { repo: "lr-bicc/app", branch: "dev", appId: APP_ID, syncedSha: "abc" };
test("link object round trip without saving the app", async () => {
  const fake = fakeDoc(appFromSnapshot(makeSnapshot()));
  expect(await readLink(fake.doc)).toBeNull();
  await writeLink(fake.doc, LINK);
  expect(await readLink(fake.doc)).toEqual(LINK);
  await writeLink(fake.doc, { ...LINK, syncedSha: "def" });            // second write updates, does not create again
  expect(fake.calls.filter((c) => c.startsWith("createObject")).length).toBe(1);
  expect((await readLink(fake.doc))!.syncedSha).toBe("def");
  await removeLink(fake.doc);
  await removeLink(fake.doc);
  expect(await readLink(fake.doc)).toBeNull();
  expect(fake.calls.some((c) => c.startsWith("doSave"))).toBe(false);
});
test("a malformed link object counts as no link", async () => {
  const app = appFromSnapshot(makeSnapshot());
  app.objects.push({ props: { qInfo: { qId: "qommit-link", qType: "qommit-link" }, link: { repo: "lr-bicc/app" } } });
  expect(await readLink(fakeDoc(app).doc)).toBeNull();
});
test("reads repository and last commit from gitoqlok's metadata", async () => {
  const meta = (data: unknown) => {
    const app = appFromSnapshot(makeSnapshot());
    app.objects.push({ props: { qInfo: { qId: "_gitoqlikMetaData", qType: "_gitoqlikMetaData" }, _data: data } });
    return readGitoqlokMeta(fakeDoc(app).doc);
  };
  expect(await meta({ infoByServerType: { github: { lastCommitId: "c97", repoData: { full_name: "lr-bicc/scp" } } } }))
    .toEqual({ repo: "lr-bicc/scp", lastCommitId: "c97" });
  expect(await meta({ repoData: { full_name: "lr-bicc/scp" }, infoByServerType: { github: {} } }))
    .toEqual({ repo: "lr-bicc/scp", lastCommitId: null });
  expect(await meta({ infoByServerType: { github: { repoData: { full_name: "no slash" } } } }))
    .toEqual({ repo: null, lastCommitId: null });
  expect(await readGitoqlokMeta(fakeDoc(appFromSnapshot(makeSnapshot())).doc)).toBeNull();
});
```

Dazu: `readAppInfo` liefert `{ title, published }` der Attrappe.

- [ ] **Step 2:** Tests laufen lassen → FAIL.
- [ ] **Step 3: Umsetzen.**
- [ ] **Step 4:** Tests → PASS.
- [ ] **Step 5: Commit** `feat(qlik): link object, gitoqlok metadata and app info`

---

### Task 8: Zustand der Verknüpfung

**Files:**
- Create: `src/ext/flows/ports.ts`, `src/ext/flows/status.ts`, `tests/ext/fake-ports.ts`
- Test: `tests/ext/status.test.ts`

**Interfaces:**
- Consumes: `GitHubPort`, `GatewayError`, `LinkData`, `parseBranchTable`, `findBranchForApp`.
- Produces:

```ts
// src/ext/flows/ports.ts
export interface AppInfo { id: string; title: string; published: boolean; url: string; user: string }
export interface AppPort {
  info(): Promise<AppInfo>;
  read(opts: { includeFiles: boolean; onProgress?: (done: number, total: number) => void }): Promise<AppSnapshot>;
  readLink(): Promise<LinkData | null>;
  writeLink(link: LinkData): Promise<void>;
  removeLink(): Promise<void>;
  readGitoqlokMeta(): Promise<{ repo: string | null; lastCommitId: string | null } | null>;
}
export interface LinkCache { get(key: string): Promise<LinkData | null>; set(key: string, link: LinkData): Promise<void>; remove(key: string): Promise<void> }
export interface FlowPorts { app: AppPort; github: GitHubPort; cache: LinkCache; repoPrefix: string; now(): Date }
export type FlowErrorCode = "published" | "not-linked" | "branch-exists" | "branch-not-found" | "invalid-branch-name" | "repo-exists"
  | "repo-not-found" | "nothing-to-commit" | "message-required";
export class FlowError extends Error { constructor(public code: FlowErrorCode, message: string, public detail?: unknown); }
export function cacheKey(info: AppInfo): string;                                   // info.url
export function saveLink(ports: FlowPorts, link: LinkData): Promise<"app" | "local">; // app object first; on failure the cache
export function isAncestor(github: GitHubPort, repo: string, sha: string, head: string): Promise<boolean>;

// src/ext/flows/status.ts
export interface CopySource { repo: string; branch: string | null; syncedSha: string | null }
export type AppStatus =
  | { state: "unlinked" }
  | { state: "linked"; link: LinkData; defaultBranch: string; headSha: string; behindBy: number; stored: "app" | "local" }
  | { state: "branch-missing"; link: LinkData; defaultBranch: string }
  | { state: "repo-missing"; repo: string }
  | { state: "duplicated"; source: CopySource; defaultBranch: string }
  | { state: "published"; repo: string; branch: string | null; syncedSha: string | null };
export function resolveStatus(ports: FlowPorts): Promise<AppStatus>;

// tests/ext/fake-ports.ts
export function fakeGitHub(): GitHubPort & {
  seed(repo: string, files: FileMap, defaultBranch?: string): string;   // creates the repository with one commit, returns its sha
  head(repo: string, branch: string): string;
  filesAt(repo: string, sha: string): FileMap;
  commitCount(repo: string): number;
  messageOf(repo: string, sha: string): string;
  protect(repo: string, branch: string): void;                          // commits to it throw GatewayError("protected-branch")
  raceOnce(repo: string): void;                                         // the next commitFiles throws GatewayError("not-fast-forward")
  deleteBranch(repo: string, branch: string): void;
};
export function fakeApp(init: { info?: Partial<AppInfo>; snapshot?: AppSnapshot; link?: LinkData | null;
  meta?: { repo: string | null; lastCommitId: string | null } | null; writable?: boolean }): AppPort & { snapshot: AppSnapshot; link: LinkData | null };
export function fakeCache(): LinkCache & { entries: Map<string, LinkData> };
export function fakePorts(init?: Parameters<typeof fakeApp>[0]): { ports: FlowPorts; github: ReturnType<typeof fakeGitHub>; app: ReturnType<typeof fakeApp>; cache: ReturnType<typeof fakeCache> };
```

`fakeGitHub` hält Repos im Speicher (Org `lr-bicc`): `commitFiles` wendet die Änderungen auf die Dateien des Eltern-Commits an und verlangt, dass der Branch auf `parentSha` steht (sonst `not-fast-forward`); `getTree` rechnet Blob-SHAs mit `gitBlobSha`; `compare` folgt den Eltern-Commits; `createBranch` wirft bei vorhandenem Namen `name-exists`; `createRepo` legt einen ersten Commit mit einer `README.md` an und wirft bei vorhandenem Namen `name-exists`; ein unbekanntes Repo ergibt bei `getRepo` `null`, bei allen anderen Aufrufen `GatewayError("not-found")`. `fakeApp` mit `writable: false` lehnt `writeLink` ab. Standardwerte: `info = { id: APP_ID, title: "Sales", published: false, url: "https://qlik.example.com/qs/sense/app/" + APP_ID, user: "r.vasilev" }`, `snapshot = makeSnapshot()`.

Auflösung (Spec 5), in dieser Reihenfolge:

1. Link-Objekt vorhanden, App veröffentlicht → `published` mit Repo, Branch und `syncedSha` des Link-Objekts.
2. Link-Objekt mit eigener App-ID → *verknüpft* (siehe unten), `stored: "app"`.
3. Link-Objekt mit fremder App-ID → `duplicated` mit den Angaben des Link-Objekts als `source`; existiert das Repo nicht → `repo-missing`.
4. Kein Link-Objekt, App nicht veröffentlicht, Cache-Eintrag mit eigener App-ID → *verknüpft*, `stored: "local"`.
5. Sonst das Repo suchen: `meta.repo` aus den gitoqlok-Angaben, falls es existiert; die App-ID wird in der Branch-Tabelle der `README.md` seines Default-Branches gesucht. Ohne Treffer dort und ohne `meta.repo`: `findRepoForApp`.
   - App steht in einer Branch-Tabelle: veröffentlicht → `published` (`syncedSha` = `meta.lastCommitId` oder `null`). Sonst Link `{ repo, branch, appId, syncedSha }` mit `syncedSha` = `meta.lastCommitId`, wenn dieser Vorfahr des Branch-HEAD ist, sonst der Branch-HEAD; mit `saveLink` ablegen; → *verknüpft*.
   - `meta.repo` existiert, App steht nicht in seiner Tabelle: veröffentlicht → `published` mit `branch: null`; sonst `duplicated` mit `source = { repo, branch: null, syncedSha: meta.lastCommitId }`.
6. Sonst `unlinked`.

*Verknüpft* heißt: Repo fehlt → `repo-missing`; Branch fehlt → `branch-missing`; sonst `linked` mit `behindBy` = `0`, wenn `syncedSha` der HEAD ist, sonst `compare(syncedSha, head).aheadBy` (kennt GitHub den Commit nicht, `0`).

`isAncestor`: `true`, wenn `sha === head` oder `compare(sha, head).status` `ahead` oder `identical` ist; bei `GatewayError("not-found")` `false`.

- [ ] **Step 1: Failing tests** in `tests/ext/status.test.ts`, je ein Test pro Zeile, mit `fakePorts` und einem Repo `lr-bicc/sales`, dessen `README.md` über `createReadme` eine Branch-Tabelle hat:

| Ausgangslage | Erwartet |
|---|---|
| Link mit eigener ID, `syncedSha` = HEAD | `linked`, `behindBy: 0`, `stored: "app"` |
| wie oben, danach zwei Commits auf dem Branch | `linked`, `behindBy: 2` |
| Link mit anderer `appId` | `duplicated`, `source` = Angaben des Links |
| Link, App veröffentlicht | `published` |
| Link, Branch gelöscht | `branch-missing` |
| Link auf `lr-bicc/gone` | `repo-missing` |
| kein Link, `meta = { repo, lastCommitId: <erster Commit> }`, App-ID in der Tabelle unter `dev`, Branch `dev` einen Commit weiter | `linked` mit `link.branch: "dev"`, `link.syncedSha` = erster Commit, `behindBy: 1`; `app.link` ist gesetzt |
| wie oben, `lastCommitId: "unknown"` | `link.syncedSha` = HEAD von `dev` |
| kein Link, `meta.repo` gesetzt, App-ID nicht in der Tabelle | `duplicated`, `source.branch: null` |
| wie oben, App veröffentlicht | `published`, `branch: null` |
| kein Link, keine gitoqlok-Angaben, App-ID in der Tabelle eines Repos | `linked` (über `findRepoForApp`) |
| nichts | `unlinked` |
| kein Link, Treffer über die Tabelle, `writable: false` | `linked`, `stored: "local"`, `cache.entries` hat den Eintrag unter `info.url` |

- [ ] **Step 2:** Tests laufen lassen → FAIL.
- [ ] **Step 3: Umsetzen.**
- [ ] **Step 4:** Tests → PASS; `npm run typecheck` grün.
- [ ] **Step 5: Commit** `feat(ext): resolve how an app is linked to a repository`

---

### Task 9: Lokale Änderungen

**Files:**
- Create: `src/ext/flows/local-changes.ts`, `tests/ext/helpers.ts` (`legacyRepo`, auch für Task 10 und 11)
- Test: `tests/ext/local-changes.test.ts`

**Interfaces:**
- Consumes: `FlowPorts`, `serializeApp`, `gitBlobSha`, `diffTrees`, `partOf`, `titleOf`, `canonicalAppId`, `parseBranchTable`, Attrappen aus Task 8.
- Produces:

```ts
export interface ChangeItem { path: string; kind: ChangeKind; group: ObjectGroup; part: Part; title: string }
export interface LocalChanges { repo: string; baseSha: string; items: ChangeItem[]; unmaintained: string[] }
export function buildLocalFiles(ports: FlowPorts, repo: string, onProgress?: (done: number, total: number) => void): Promise<FileMap>;
export function hashFiles(files: FileMap): Promise<Map<string, string>>;
export function unmaintainedPaths(tree: Map<string, string>): string[];   // sorted
export function computeLocalChanges(ports: FlowPorts, target: { repo: string; baseSha: string },
  onProgress?: (done: number, total: number) => void): Promise<LocalChanges>;
```

`buildLocalFiles`: App mit Dateien lesen; kanonische App-ID = `canonicalAppId(Zeilen der README des Default-Branches, defaultBranch)`, ohne Ergebnis die ID der App; `serializeApp`. `unmaintainedPaths`: genau `loadScript.qvs`, `objects/fields.json`, `objects/themes.json`, `objects/glossarylinks.json` und alle Pfade unter `builds/`. `computeLocalChanges`: `diffTrees(getTree(repo, baseSha), hashFiles(lokal))`; `title` über `titleOf(path, lokaler Inhalt)`, für gelöschte Einträge der Dateiname.

- [ ] **Step 1: Failing tests.**

```ts
// tests/ext/helpers.ts
export function legacyRepo(github: ReturnType<typeof fakeGitHub>, snap = makeSnapshot()): string {
  const files: FileMap = serializeApp(snap, { canonicalAppId: CANON_ID });
  files.set("README.md", createReadme({ appTitle: "Sales", creatorLogin: "x", createdAt: new Date(0), sheets: [],
    defaultBranch: "main", appUrl: `https://qlik.example.com/qs/sense/app/${CANON_ID}` }));
  files.set("loadScript.qvs", "x"); files.set("builds/a.qvf", new Uint8Array([1])); files.set("objects/fields.json", "[]");
  files.set("objects/variables/v-script.json", '{"qInfo":{"qId":"v-script","qType":"variable"},"qName":"vNow","qIsScriptCreated":true}');
  return github.seed("lr-bicc/sales", files);
}

// tests/ext/local-changes.test.ts
test("first contact with a gitoqlok repository", async () => {
  const { ports, github, app } = fakePorts();
  const base = legacyRepo(github);
  app.snapshot.measures = app.snapshot.measures.slice(1);
  app.snapshot.dimensions.push({ qInfo: { qId: "d-new", qType: "dimension" }, qMetaDef: { title: "Region" } });
  const removed = makeSnapshot().measures[0]!.qInfo.qId;
  const changes = await computeLocalChanges(ports, { repo: "lr-bicc/sales", baseSha: base });
  expect(changes.items).toEqual([
    { path: "objects/dimensions/d-new.json", kind: "added", group: "dimensions", part: "objects", title: "Region" },
    { path: `objects/measures/${removed}.json`, kind: "deleted", group: "measures", part: "objects", title: `${removed}.json` },
    { path: "objects/variables/v-script.json", kind: "deleted", group: "variables", part: "objects", title: "v-script.json" },
  ]);
  expect(changes.unmaintained).toEqual(["builds/a.qvf", "loadScript.qvs", "objects/fields.json"]);
});
test("an unchanged app shows no changes although its own id differs from the canonical one", async () => {
  const { ports, github } = fakePorts();
  const base = legacyRepo(github);          // files carry CANON_ID, the app has APP_ID
  expect((await computeLocalChanges(ports, { repo: "lr-bicc/sales", baseSha: base })).items).toEqual([]);
});
test("without a branch table the app's own id is the canonical one", async () => {
  const { ports, github } = fakePorts();
  github.seed("lr-bicc/empty", new Map([["README.md", "# x"]]));
  const files = await buildLocalFiles(ports, "lr-bicc/empty");
  expect(JSON.stringify([...files.values()].filter((v) => typeof v === "string"))).not.toContain(CANON_ID);
});
```

Dazu: Ein Skript-Tab trägt als Titel den Tab-Namen; schlägt `app.read` fehl, endet `computeLocalChanges` mit demselben Fehler und ohne Ergebnis.

- [ ] **Step 2:** Tests laufen lassen → FAIL.
- [ ] **Step 3: Umsetzen.**
- [ ] **Step 4:** Tests → PASS.
- [ ] **Step 5: Commit** `feat(ext): local changes against the synced commit`

---

### Task 10: Repo anlegen, verbinden, Branch anlegen, trennen

**Files:**
- Create: `src/ext/flows/setup.ts`
- Test: `tests/ext/setup.test.ts`

**Interfaces:**
- Consumes: `FlowPorts`, `FlowError`, `saveLink`, `isAncestor`, `buildLocalFiles`, `repoSlug`, `repoSlugWithId`, `createReadme`, `upsertBranchRow`, `isValidRefName`, `CopySource`.
- Produces:

```ts
export function suggestBranchName(user: string): string;   // lower case, characters outside [a-z0-9._-] become "-", "" becomes "branch"
export function createRepository(ports: FlowPorts, input: { name?: string }): Promise<LinkData>;
export function connectRepository(ports: FlowPorts, input: { repo: string; mode: "new-branch" | "existing-branch"; branch: string }): Promise<LinkData>;
export function createBranchForCopy(ports: FlowPorts, input: { source: CopySource; name: string; fromSource: boolean }): Promise<LinkData>;
export function unlinkApp(ports: FlowPorts): Promise<void>;
```

Gemeinsam: In einer veröffentlichten App werfen alle vier `FlowError("published")`. Ein neuer Branch-Name wird mit `isValidRefName` geprüft (`invalid-branch-name`) und darf nicht existieren (`branch-exists`); beide Prüfungen laufen, bevor irgendetwas geschrieben wird. Das Ergebnis wird mit `saveLink` abgelegt.

- **`createRepository`** (Spec 6.2): Name = `input.name` oder `repoSlug(title, ports.repoPrefix)`. `name-exists` von GitHub → `FlowError("repo-exists")` mit `detail: { name, suggestion: repoSlugWithId(title, appId, prefix) }`. Danach ein Commit `Initial commit` auf dem Default-Branch mit allen Dateien der App und einer `README.md` aus `createReadme` (`creatorLogin` aus `whoAmI`, `createdAt` aus `ports.now()`, Sheets mit `qProperty.qMetaDef.title` und `.description`, fehlende Werte als `""`). Link: Default-Branch, `syncedSha` = neuer Commit.
- **Zeile in der Branch-Tabelle:** `upsertBranchRow(README des Default-Branches oder "", { branch, appUrl: info.url })`, Commit `Update branches table` auf dem Default-Branch.
- **`connectRepository`**: Repo unbekannt → `FlowError("repo-not-found")`. `new-branch`: Zeile committen, Branch auf diesen Commit anlegen, `syncedSha` = dieser Commit. `existing-branch`: Branch muss existieren (`FlowError("branch-not-found")` sonst), Zeile committen, `syncedSha` = HEAD des Branches nach dem Commit.
- **`createBranchForCopy`** (Spec 6.3): Zeile committen. Basis ist bei `fromSource` der HEAD von `source.branch` (fehlt `source.branch` oder der Branch, gilt der Default-Branch), sonst der Default-Branch nach dem Zeilen-Commit. `syncedSha` = `source.syncedSha`, wenn er Vorfahr des neuen Branch-HEAD ist, sonst der neue Branch-HEAD.
- **Geschützter Default-Branch:** Lehnt GitHub den Zeilen-Commit mit `protected-branch` ab, wird erst der Branch von der Basis angelegt und die Zeile auf dem neuen Branch committet. Bei `existing-branch` wird die Zeile dann auf dem gewählten Branch committet.
- **`unlinkApp`**: `removeLink` (Fehler werden übergangen) und Cache-Eintrag entfernen.

- [ ] **Step 1: Failing tests** in `tests/ext/setup.test.ts`:

```ts
test("create repository commits the app and a readme with the branch table", async () => {
  const { ports, github, app } = fakePorts({ info: { title: "📝 Sales Überblick" } });
  const link = await createRepository(ports, {});
  expect(link.repo).toBe("lr-bicc/sales-ueberblick");
  const files = github.filesAt(link.repo, link.syncedSha);
  expect(parseBranchTable(files.get("README.md") as string)).toEqual([{ branch: "main", appUrl: `https://qlik.example.com/qs/sense/app/${APP_ID}`, appId: APP_ID }]);
  expect(files.has("data_load_script/tab_order.txt")).toBe(true);
  expect(github.messageOf(link.repo, link.syncedSha)).toBe("Initial commit");
  expect(app.link).toEqual({ repo: link.repo, branch: "main", appId: APP_ID, syncedSha: github.head(link.repo, "main") });
});
test("an existing repository name is reported with a suggestion", async () => {
  const { ports, github } = fakePorts();
  github.seed("lr-bicc/sales", new Map([["README.md", "x"]]));
  await expect(createRepository(ports, {})).rejects.toMatchObject({ code: "repo-exists", detail: { name: "sales", suggestion: "sales-11111111" } });
  expect((await createRepository(ports, { name: "sales-11111111" })).repo).toBe("lr-bicc/sales-11111111");
});
test("create branch for a copy keeps the source's synced commit when it is in the history", async () => {
  const { ports, github } = fakePorts();
  const first = legacyRepo(github);                                             // tests/ext/helpers.ts, Task 9
  const source = { repo: "lr-bicc/sales", branch: "main", syncedSha: first };
  const link = await createBranchForCopy(ports, { source, name: "feature/x", fromSource: false });
  const head = github.head("lr-bicc/sales", "feature/x");
  expect(github.messageOf("lr-bicc/sales", head)).toBe("Update branches table");
  expect(github.head("lr-bicc/sales", "main")).toBe(head);
  expect(link).toEqual({ repo: "lr-bicc/sales", branch: "feature/x", appId: APP_ID, syncedSha: first });
  const rows = parseBranchTable(github.filesAt("lr-bicc/sales", head).get("README.md") as string);
  expect(rows.find((r) => r.branch === "feature/x")?.appId).toBe(APP_ID);
});
test("nothing is written when the branch name is taken or invalid", async () => {
  const { ports, github } = fakePorts();
  const first = legacyRepo(github);
  const source = { repo: "lr-bicc/sales", branch: "main", syncedSha: first };
  const before = github.commitCount("lr-bicc/sales");
  await expect(createBranchForCopy(ports, { source, name: "main", fromSource: false })).rejects.toMatchObject({ code: "branch-exists" });
  await expect(createBranchForCopy(ports, { source, name: "a..b", fromSource: false })).rejects.toMatchObject({ code: "invalid-branch-name" });
  expect(github.commitCount("lr-bicc/sales")).toBe(before);
});
test("with a protected default branch the table row lands on the new branch", async () => {
  const { ports, github } = fakePorts();
  const first = legacyRepo(github);
  github.protect("lr-bicc/sales", "main");
  const link = await createBranchForCopy(ports, { source: { repo: "lr-bicc/sales", branch: null, syncedSha: first }, name: "dev", fromSource: false });
  expect(github.head("lr-bicc/sales", "main")).toBe(first);
  expect(github.messageOf("lr-bicc/sales", github.head("lr-bicc/sales", "dev"))).toBe("Update branches table");
  expect(link.syncedSha).toBe(first);
});
```

Weitere Tests: `source.syncedSha` nicht in der Historie → `syncedSha` = Branch-HEAD; `fromSource: true` zweigt vom HEAD des Quell-Branches ab, die Zeile steht trotzdem auf `main`; `connectRepository` in beiden Modi (bei `existing-branch` entsteht kein Branch, pro Branch-Name genau eine Zeile); unbekanntes Repo → `repo-not-found`; veröffentlichte App → `published`; `unlinkApp` entfernt Link und Cache-Eintrag; `suggestBranchName("R.Vasilev")` → `"r.vasilev"`, `suggestBranchName("Jörg Müller")` → `"j-rg-m-ller"`, `suggestBranchName("")` → `"branch"`.

- [ ] **Step 2:** Tests laufen lassen → FAIL.
- [ ] **Step 3: Umsetzen.**
- [ ] **Step 4:** Tests → PASS; `npm run typecheck` grün.
- [ ] **Step 5: Commit** `feat(ext): create repository, connect, create branch, unlink`

---

### Task 11: Save changes

**Files:**
- Create: `src/ext/flows/commit.ts`
- Test: `tests/ext/commit.test.ts`

**Interfaces:**
- Consumes: `FlowPorts`, `FlowError`, `GatewayError`, `buildLocalFiles`, `hashFiles`, `unmaintainedPaths`, `saveLink`.
- Produces:

```ts
export type CommitResult = { sha: string } | { behind: CommitInfo[] };
export function commitChanges(ports: FlowPorts, input: { link: LinkData; message: string; paths: string[];
  removeUnmaintained: boolean; allowBehind: boolean }, onProgress?: (done: number, total: number) => void): Promise<CommitResult>;
```

Ablauf (Spec 6.5): veröffentlichte App → `FlowError("published")`; leere Nachricht (nach `trim`) → `message-required`. HEAD des Branches lesen (fehlt er: `FlowError("branch-not-found")`). Ist HEAD ≠ `link.syncedSha` und `allowBehind` falsch → `{ behind: compare(syncedSha, head).commits }`, nichts wird geschrieben. Sonst die App frisch lesen und gegen den **Tree des HEAD** vergleichen: Für jeden gewählten Pfad entsteht eine Änderung, wenn die lokale Datei fehlt und der Pfad im Tree steht (Löschen) oder ihr Blob-SHA vom Tree abweicht (Schreiben). Mit `removeUnmaintained` kommen Löschungen für `unmaintainedPaths(Tree)` dazu. Keine Änderung → `nothing-to-commit`. `commitFiles` mit `parentSha` = HEAD; antwortet GitHub mit `not-fast-forward`, ist das Ergebnis wieder `{ behind: … }` gegen den neuen HEAD. Nach Erfolg `saveLink` mit `syncedSha` = neuer Commit.

- [ ] **Step 1: Failing tests** in `tests/ext/commit.test.ts` (Hilfsfunktion `linked()`: `fakePorts`, `legacyRepo`, Link auf `main` mit `syncedSha` = erster Commit; die App erhält eine geänderte Variable `objects/variables/<id>.json` und eine neue Dimension `d-new`):

```ts
test("commits only the selected paths", async () => {
  const { ports, github, app, link, changedVar } = await linked();
  const result = await commitChanges(ports, { link, message: "Add region", paths: ["objects/dimensions/d-new.json"], removeUnmaintained: false, allowBehind: false });
  const sha = (result as { sha: string }).sha;
  const files = github.filesAt(link.repo, sha);
  expect(files.has("objects/dimensions/d-new.json")).toBe(true);
  expect(files.get(changedVar)).toEqual(github.filesAt(link.repo, link.syncedSha).get(changedVar));   // not selected, untouched
  expect(files.has("loadScript.qvs")).toBe(true);
  expect(github.messageOf(link.repo, sha)).toBe("Add region");
  expect(app.link!.syncedSha).toBe(sha);
});
test("a moved branch is reported instead of committed", async () => {
  const { ports, github, link } = await linked();
  await github.commitFiles(link.repo, { branch: "main", parentSha: link.syncedSha, message: "theirs", changes: [{ path: "x.txt", content: "1" }] });
  const count = github.commitCount(link.repo);
  const result = await commitChanges(ports, { link, message: "m", paths: ["objects/dimensions/d-new.json"], removeUnmaintained: false, allowBehind: false });
  expect((result as { behind: CommitInfo[] }).behind.map((c) => c.message)).toEqual(["theirs"]);
  expect(github.commitCount(link.repo)).toBe(count);
});
test("commit anyway builds on the head and keeps what was not selected", async () => {
  const { ports, github, link } = await linked();
  await github.commitFiles(link.repo, { branch: "main", parentSha: link.syncedSha, message: "theirs", changes: [{ path: "objects/measures/m-theirs.json", content: "{}" }] });
  const result = await commitChanges(ports, { link, message: "m", paths: ["objects/dimensions/d-new.json"], removeUnmaintained: false, allowBehind: true });
  const files = github.filesAt(link.repo, (result as { sha: string }).sha);
  expect(files.has("objects/measures/m-theirs.json")).toBe(true);
  expect(files.has("objects/dimensions/d-new.json")).toBe(true);
});
test("a commit that loses the race is reported as behind", async () => {
  const { ports, github, app, link } = await linked();
  github.raceOnce(link.repo);
  const result = await commitChanges(ports, { link, message: "m", paths: ["objects/dimensions/d-new.json"], removeUnmaintained: false, allowBehind: false });
  expect("behind" in result).toBe(true);
  expect(app.link!.syncedSha).toBe(link.syncedSha);
});
```

Weitere Tests: gewählter gelöschter Pfad (`objects/variables/v-script.json`) fehlt im neuen Tree; `removeUnmaintained: true` entfernt `loadScript.qvs`, `builds/a.qvf`, `objects/fields.json`; gewählte Pfade ohne Unterschied zum HEAD → `nothing-to-commit`; leere Nachricht → `message-required`; veröffentlichte App → `published`; `protected-branch` von GitHub wird als `GatewayError` durchgereicht und der Link bleibt unverändert.

- [ ] **Step 2:** Tests laufen lassen → FAIL.
- [ ] **Step 3: Umsetzen.**
- [ ] **Step 4:** Tests → PASS.
- [ ] **Step 5: Commit** `feat(ext): save changes`

---

### Task 12: Befehle im Content Script

**Files:**
- Create: `src/ext/shared/commands.ts`, `src/ext/content/app-port.ts`, `src/ext/content/router.ts`
- Modify: `src/ext/content/content.ts`
- Test: `tests/ext/router.test.ts`, `tests/ext/app-port.test.ts`

**Interfaces:**
- Consumes: alles aus Task 4 bis 11.
- Produces:

```ts
// src/ext/shared/commands.ts
export type Command =
  | { cmd: "ping" } | { cmd: "status" } | { cmd: "localChanges" } | { cmd: "listRepos" }
  | { cmd: "listBranches"; repo: string }
  | { cmd: "createRepository"; name?: string }
  | { cmd: "connect"; repo: string; mode: "new-branch" | "existing-branch"; branch: string }
  | { cmd: "createBranch"; name: string; fromSource: boolean }
  | { cmd: "unlink" }
  | { cmd: "commit"; message: string; paths: string[]; removeUnmaintained: boolean; allowBehind: boolean }
  | { cmd: "history"; page: number };
export type StatusView = { page: "hub" } | { page: "app"; app: AppInfo; status: AppStatus; suggestedBranch: string };
export interface CommandError { code: string; message: string; detail?: unknown; ssoUrl?: string; resetAt?: number }
export type CommandResult = { ok: true; value: unknown } | { ok: false; error: CommandError };
export interface ProgressEvent { event: "progress"; text: string }

// src/ext/content/app-port.ts
export function createAppPort(session: EngineSession, loc: QlikLocation & { appId: string }, fetchFn: typeof fetch): AppPort;

// src/ext/content/router.ts
export interface RouterDeps {
  currentUrl(): string;
  openSession(loc: QlikLocation & { appId: string }): Promise<EngineSession>;
  github: GitHubPort; cache: LinkCache; loadOptions(): Promise<Options>;
  fetch: typeof fetch; now(): Date; emit(event: ProgressEvent): void;
}
export function createRouter(deps: RouterDeps): (command: Command) => Promise<CommandResult>;
```

Ergebnisse je Befehl: `ping` → `"pong"`; `status` → `StatusView`; `localChanges` → `LocalChanges`; `listRepos` → `RepoRef[]`; `listBranches` → `{ defaultBranch: string; branches: string[] }`; `createRepository`, `connect`, `createBranch` → `LinkData`; `unlink` → `null`; `commit` → `CommitResult`; `history` → `{ commits: CommitInfo[]; defaultBranch: string }`.

Regeln:
- Jeder Befehl wertet `currentUrl()` neu aus. Keine Qlik-Seite oder Hub: `status` → `{ page: "hub" }`, jeder andere Befehl außer `ping` → Fehler `no-app`.
- Die Sitzung wird beim ersten Bedarf geöffnet und wiederverwendet, solange die App-ID gleich und `isClosed()` falsch ist; sonst wird sie geschlossen und neu geöffnet.
- Befehle laufen nacheinander, nie gleichzeitig.
- `status` merkt sich sein Ergebnis je App. `localChanges` braucht `linked` (Basis `link.syncedSha`) oder `published` mit `syncedSha` und `repo`; `commit` und `history` brauchen `linked`; `createBranch` braucht `duplicated` (Quelle = `source`) oder `branch-missing` (Quelle = `{ repo, branch: null, syncedSha: link.syncedSha }`). Fehlt der gemerkte Zustand, wird er zuerst ermittelt. Passt er nicht → Fehler `not-linked`.
- Nach `createRepository`, `connect`, `createBranch`, `unlink` und einem erfolgreichen `commit` wird der gemerkte Zustand verworfen.
- Fortschritt: `emit({ event: "progress", text })` mit `Loading application data… <done>/<total>` beim Lesen und `Ready` am Ende jedes Befehls.
- Fehlerzuordnung: `GatewayError` → `code` = `kind` (mit `ssoUrl`, `resetAt`); `FlowError` → `code`, `detail`; `QlikReadError` → `qlik-read`; `QlikSessionError` → `qlik-session`; alles andere → `internal`. Nach `qlik-read` und `qlik-session` wird die Sitzung verworfen.
- `createAppPort`: `info()` aus `readAppInfo`, `session.user`, `appUrl`; `read()` über `readApp` mit `published` aus `info()` und, bei `includeFiles`, `createContentFiles`.

`content.ts`: Bei gesetztem `globalThis.__qommitContent` sofort enden, sonst setzen. Router mit `currentUrl: () => location.href`, `openSession` aus Task 5 mit `enigma.create`, `github = createGitHubPort((request) => chrome.runtime.sendMessage({ target: "gateway", request }))`, `cache` über `chrome.storage.local` mit Schlüsseln `link:<key>`, `emit` als `chrome.runtime.sendMessage({ target: "panel", event })`. Ein `runtime.onMessage`-Listener beantwortet Nachrichten `{ target: "content", command }` mit dem Ergebnis des Routers.

- [ ] **Step 1: Failing tests** in `tests/ext/router.test.ts`. Aufbau: `fakeGitHub`, `fakeCache`, eine `openSession`-Attrappe, die pro Aufruf eine `EngineSession` über `fakeDoc(app)` liefert und die Aufrufe zählt, `url` als veränderliche Variable.

```ts
test("hub pages have no app", async () => {
  const { run } = setup({ url: "https://qlik.example.com/qs/hub" });
  expect(await run({ cmd: "status" })).toEqual({ ok: true, value: { page: "hub" } });
  expect(await run({ cmd: "localChanges" })).toMatchObject({ ok: false, error: { code: "no-app" } });
});
test("a command after navigating to another app opens a new session", async () => {
  const { run, sessions, setUrl } = setup({ url: appPage(APP_ID) });
  await run({ cmd: "status" }); await run({ cmd: "status" });
  expect(sessions.opened).toBe(1);
  setUrl(appPage("33333333-3333-4333-8333-333333333333"));
  const view = (await run({ cmd: "status" })) as any;
  expect(sessions.opened).toBe(2);
  expect(sessions.closed).toBe(1);
  expect(view.value.app.id).toBe("33333333-3333-4333-8333-333333333333");
});
test("a failed read reports qlik-read and the next command reconnects", async () => {
  const { run, sessions, failNextRead } = setup({ url: appPage(APP_ID), linked: true });
  failNextRead();
  expect(await run({ cmd: "localChanges" })).toMatchObject({ ok: false, error: { code: "qlik-read" } });
  expect(await run({ cmd: "localChanges" })).toMatchObject({ ok: true });
  expect(sessions.opened).toBe(2);
});
test("unlinked app: create repository, then the status is linked", async () => {
  const { run } = setup({ url: appPage(APP_ID) });
  expect(((await run({ cmd: "status" })) as any).value.status.state).toBe("unlinked");
  expect(await run({ cmd: "commit", message: "m", paths: [], removeUnmaintained: false, allowBehind: false })).toMatchObject({ ok: false, error: { code: "not-linked" } });
  expect(await run({ cmd: "createRepository" })).toMatchObject({ ok: true });
  expect(((await run({ cmd: "status" })) as any).value.status.state).toBe("linked");
});
```

Weitere Tests: `GatewayError("sso-required")` mit `ssoUrl` wird zu `{ code: "sso-required", ssoUrl }`; zwei gleichzeitig gestartete Befehle laufen nacheinander (die Attrappe sieht nie zwei Lesevorgänge zugleich); `emit` erhält am Ende `Ready`; `suggestedBranch` ist `suggestBranchName(user)`; `history` liefert die Commits des verknüpften Branches. `tests/ext/app-port.test.ts`: `info()` setzt `url` und `user`; `read({ includeFiles: false })` lädt keine Dateien.

- [ ] **Step 2:** Tests laufen lassen → FAIL.
- [ ] **Step 3: Umsetzen.**
- [ ] **Step 4:** Tests → PASS; `npm run typecheck && npm run build:ext` grün.
- [ ] **Step 5: Commit** `feat(ext): command router in the content script`

---

### Task 13: Side Panel – Rahmen, Zustände, Dialoge

**Files:**
- Create: `src/ext/panel/bridge.ts`, `src/ext/panel/errors.ts`, `src/ext/panel/App.tsx`, `src/ext/panel/Header.tsx`, `src/ext/panel/SetupViews.tsx`, `src/ext/panel/ConnectDialog.tsx`, `src/ext/panel/CreateBranchDialog.tsx`, `src/ext/panel/panel.css`
- Modify: `src/ext/panel/main.tsx`, `src/ext/panel/panel.html`, `scripts/build-ext.mjs` (CSS kopieren)
- Create (Tests): `tests/ext/fake-bridge.ts`
- Test: `tests/ext/bridge.test.ts`, `tests/ext/panel-errors.test.ts`, `tests/ext/panel-setup.test.tsx`

**Interfaces:**
- Consumes: `Command`, `CommandResult`, `CommandError`, `StatusView`, `AppStatus`, Chrome-Attrappe.
- Produces:

```ts
// src/ext/panel/bridge.ts
export class BridgeError extends Error { constructor(public error: CommandError); }
export interface Bridge {
  send<T>(command: Command): Promise<T>;                 // rejects with BridgeError
  onProgress(listener: (text: string) => void): () => void;
  openOptions(): void;
}
export function createBridge(tabId: number): Bridge;

// src/ext/panel/errors.ts
export function errorText(error: CommandError): { text: string; action?: "options" | "sso" | "retry" };

// src/ext/panel/App.tsx
export function App(props: { bridge: Bridge | null }): JSX.Element;   // null: tab is not a configured Qlik server
```

`createBridge`: `send` schickt `{ target: "content", command }` mit `chrome.tabs.sendMessage(tabId, …)`. Antwortet niemand (Ablehnung oder `undefined`), lädt es einmal `content.js` mit `chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] })` und wiederholt den Versuch; scheitert auch der, `BridgeError` mit `code: "no-content"`. `onProgress` meldet nur Ereignisse, deren Absender-Tab `tabId` ist. `main.tsx` liest `tabId` aus `location.search`; ohne `tabId` rendert es `<App bridge={null} />`.

Texte von `errorText` (Spec 7):

| `code` | Text | Aktion |
|---|---|---|
| `no-token` | No GitHub token configured. | `options` |
| `unauthorized` | Token invalid or expired. | `options` |
| `sso-required` | Authorize the token for the organization (SSO). | `sso` |
| `rate-limited` | GitHub rate limit reached. Try again at `<HH:MM>`. (ohne `resetAt`: „Try again later.“) | – |
| `forbidden` | No permission. | – |
| `not-found` | Repository not found or no access. | – |
| `protected-branch` | The branch is protected. Work on your own branch. | – |
| `network` | Network error. | `retry` |
| `qlik-session`, `qlik-read` | Qlik session lost. Sign in to Qlik again or reload the page. | `retry` |
| `no-content` | Reload the Qlik page and open Qommit again. | – |
| `branch-exists` | Branch already exists. | – |
| `invalid-branch-name` | Invalid branch name. | – |
| `branch-not-found` | Branch not found. | – |
| `repo-not-found` | Repository not found or no access. | – |
| `not-linked` | This app is not linked to a repository. | – |
| `no-app` | Open an app to use Qommit. | – |
| `nothing-to-commit` | Nothing to save. | – |
| `message-required` | Enter a commit message. | – |
| `published` | Published apps are read only. Duplicate the app to make changes. | – |
| sonst | `error.message` | – |

Aufbau von `App`:
- `bridge === null`: Text „Qommit works on Qlik Sense servers that are listed in the options.“ und Schaltfläche „Open options“.
- Beim Start und bei „Refresh“: `status`. `page: "hub"` → „Open an app to use Qommit.“
- **Kopf** (`Header`): App-Titel; bei bekanntem Repo der Link `<repo>` auf `https://github.com/<repo>`, das Branch-Badge und bei `behindBy > 0` „Repository has N new commits“ (bei 1: „Repository has 1 new commit“); Schaltflächen mit `title` „Unlink repository“ (nur bei `linked`, `branch-missing`, `repo-missing`; fragt „Unlink this app from `<repo>`?“ mit „Unlink“ und „Cancel“) und „Refresh“.
- **Fußzeile:** zuletzt gemeldeter Fortschrittstext, anfangs „Ready“.
- **Zustände** (`SetupViews`):
  - `unlinked`: „No linked repository“, Schaltflächen „Create repository“ und „Connect to existing repository“. Meldet „Create repository“ `repo-exists`, erscheint „A repository named `<name>` already exists.“ mit „Connect to existing repository“ und „Create as `<suggestion>`“.
  - `duplicated`: „We found a repository for the master Qlik application, from which current application was duplicated“, Schaltflächen „Create Branch“, „Unlink Repository“, „Connect to existing repository“.
  - `branch-missing`: „Branch `<name>` no longer exists on GitHub.“, Schaltflächen „Create Branch“ und „Connect to existing repository“.
  - `repo-missing`: „Repository not found or no access.“, Schaltflächen „Unlink Repository“ und „Connect to existing repository“.
  - `published`: „Published app – read only. Duplicate the app to make changes.“; bei bekanntem `syncedSha` darunter die Änderungsliste aus Task 14 ohne „Save changes“.
  - `linked`: Reiter „Local Changes“ und „History“ (Inhalt in Task 14; in dieser Aufgabe leere Platzhalter-Komponenten `LocalChangesTab` und `HistoryTab` in eigenen Dateien).
- **`ConnectDialog`:** Titel „Connect to existing repository“; Suchfeld mit Platzhalter „Search repositories“ filtert die Liste aus `listRepos` (Teilzeichenkette ohne Beachtung der Groß-/Kleinschreibung); nach Wahl eines Repos `listBranches`; Auswahl „As a new branch“ (Feld „Branch name“, vorbelegt mit `suggestedBranch`) oder „To existing branch“ (Auswahlliste, vorbelegt mit dem Default-Branch); „Connect“ und „Cancel“.
- **`CreateBranchDialog`:** Feld „Branch Name“, vorbelegt mit `suggestedBranch`; Kontrollkästchen „Branch off from the branch that is used in the app you are duplicating from“ mit dem Branch-Namen dahinter, nur wenn die Quelle einen Branch nennt; „Create Branch“ und „Cancel“.
- Fehler eines Befehls stehen als Meldung über dem Inhalt, mit Schaltfläche „Open options“, Link „Authorize“ (`ssoUrl`, neuer Tab) oder „Retry“ je nach Aktion. Dialoge zeigen ihren Fehler im Dialog und bleiben offen. Während ein Befehl läuft, sind die Schaltflächen gesperrt.
- Nach erfolgreichem `createRepository`, `connect`, `createBranch`, `unlink`: `status` neu laden.

- [ ] **Step 1: Failing tests.**
  - `tests/ext/bridge.test.ts`: erste `tabs.sendMessage` lehnt ab → `injected` enthält `{ tabId: 5, files: ["content.js"] }`, der zweite Versuch liefert das Ergebnis; `{ ok: false, error }` → `BridgeError` mit diesem `error`; ein Fortschritts-Ereignis von Tab 6 erreicht den Zuhörer von Tab 5 nicht.
  - `tests/ext/panel-errors.test.ts`: jede Zeile der Tabelle; `rate-limited` mit `resetAt` für 14:05 Ortszeit ergibt „… Try again at 14:05.“.
  - `tests/ext/panel-setup.test.tsx` (happy-dom). `tests/ext/fake-bridge.ts` exportiert `fakeBridge(answers)`: eine `Bridge`, die jeden Befehl in `commands` aufzeichnet und je `cmd` die Antworten der Reihe nach liefert (die letzte bleibt gültig; ein `BridgeError` in der Liste lehnt ab), sowie `LINK = { repo: "lr-bicc/sales", branch: "main", appId: APP_ID, syncedSha: "abc" }`, `LINKED = { state: "linked", link: LINK, defaultBranch: "main", headSha: "abc", behindBy: 0, stored: "app" }` und `view(status)`, das eine `StatusView` für die App „Sales“ mit `suggestedBranch: "r.vasilev"` baut.

```tsx
test("unlinked app offers both ways and creates a repository", async () => {
  const bridge = fakeBridge({ status: [view({ state: "unlinked" }), view(LINKED)], createRepository: [LINK] });
  render(<App bridge={bridge} />);
  await screen.findByText("No linked repository");
  fireEvent.click(screen.getByText("Create repository"));
  await screen.findByText("lr-bicc/sales");
  expect(bridge.commands.map((c) => c.cmd)).toEqual(["status", "createRepository", "status"]);
});
test("a copy creates a branch with the suggested name", async () => {
  const bridge = fakeBridge({ status: [view({ state: "duplicated", source: { repo: "lr-bicc/sales", branch: "dev", syncedSha: "a" }, defaultBranch: "main" }), view(LINKED)], createBranch: [LINK] });
  render(<App bridge={bridge} />);
  fireEvent.click(await screen.findByText("Create Branch"));
  expect((screen.getByLabelText("Branch Name") as HTMLInputElement).value).toBe("r.vasilev");
  fireEvent.click(screen.getByLabelText(/Branch off from the branch/));
  fireEvent.click(screen.getAllByText("Create Branch").at(-1)!);
  await screen.findByText("lr-bicc/sales");
  expect(bridge.commands[1]).toEqual({ cmd: "createBranch", name: "r.vasilev", fromSource: true });
});
test("an existing branch name keeps the dialog open with the message", async () => {
  const bridge = fakeBridge({ status: [view({ state: "duplicated", source: { repo: "lr-bicc/sales", branch: null, syncedSha: null }, defaultBranch: "main" })],
    createBranch: [new BridgeError({ code: "branch-exists", message: "x" })] });
  render(<App bridge={bridge} />);
  fireEvent.click(await screen.findByText("Create Branch"));
  expect(screen.queryByLabelText(/Branch off from the branch/)).toBeNull();
  fireEvent.click(screen.getAllByText("Create Branch").at(-1)!);
  await screen.findByText("Branch already exists.");
  expect(screen.getByLabelText("Branch Name")).toBeTruthy();
});
```

  Weitere Tests: `bridge={null}` zeigt den Hinweis und „Open options“; `page: "hub"`; `behindBy: 2` zeigt „Repository has 2 new commits“; `no-token` zeigt „No GitHub token configured.“ mit „Open options“; der Connect-Dialog filtert die Repo-Liste und sendet `{ cmd: "connect", repo, mode: "existing-branch", branch: "main" }`; „Unlink“ sendet erst nach der Bestätigung.

- [ ] **Step 2:** Tests laufen lassen → FAIL.
- [ ] **Step 3: Umsetzen.** `panel.css`: schlichte, lesbare Darstellung für eine Breite ab 320 px, Systemschrift, keine externen Ressourcen; `panel.html` bindet sie ein.
- [ ] **Step 4:** Tests → PASS; `npm run typecheck && npm run build:ext` grün.
- [ ] **Step 5: Commit** `feat(ext): side panel shell, link states and dialogs`

---

### Task 14: Side Panel – Local Changes, Save changes, History

**Files:**
- Create: `src/ext/panel/changes-model.ts`
- Modify: `src/ext/panel/LocalChangesTab.tsx`, `src/ext/panel/HistoryTab.tsx`, `src/ext/panel/App.tsx`
- Test: `tests/ext/changes-model.test.ts`, `tests/ext/panel-changes.test.tsx`

**Interfaces:**
- Consumes: `LocalChanges`, `ChangeItem`, `CommitResult`, `Bridge`, `fakeBridge` aus Task 13.
- Produces:

```ts
// src/ext/panel/changes-model.ts
export type SectionKey = "added" | "deleted" | "changed";
export interface ChangeGroup { label: string; items: ChangeItem[] }
export interface ChangeSection { key: SectionKey; label: string; groups: ChangeGroup[] }
export function sections(items: ChangeItem[]): ChangeSection[];              // empty sections and groups are left out
export const PARTS: { part: Part; label: string }[];                          // Load script, App Objects, Bookmarks, Attached files
export function initialSelection(items: ChangeItem[]): Set<string>;           // every path
export function togglePart(selection: Set<string>, items: ChangeItem[], part: Part, on: boolean): Set<string>;
export function pullRequestUrl(repo: string, defaultBranch: string, branch: string): string;
```

Beschriftungen: Abschnitte „Added objects“, „Deleted objects“, „Changed objects“, in dieser Reihenfolge. Gruppen in dieser Reihenfolge: „Sheets“ (`sheets`), „Master Items“ (`dimensions`, `measures`, `masterobjects`), „Variables“ (`variables`), „Script“ (`script`), „Attached files“ (`attachedFiles`), „Stories“ (`stories`), „Bookmarks“ (`bookmarks`), „App properties“ (`appprops`). Innerhalb einer Gruppe nach Titel sortiert. `pullRequestUrl`: `https://github.com/<repo>/compare/<default>...<branch>`, Branch-Namen segmentweise kodiert.

`LocalChangesTab`:
- Lädt beim Anzeigen und nach „Refresh“ `localChanges`. Ohne Einträge: „No local changes“. Jede Gruppe zeigt ihre Anzahl in Klammern; Gruppen mit mehr als 20 Einträgen sind anfangs eingeklappt.
- Schaltfläche „Save changes“ (gesperrt ohne Einträge und ohne nicht gepflegte Dateien) schaltet in den Commit-Modus: Überschrift „Choose what to save“ mit vier Kontrollkästchen aus `PARTS` (nur Teile mit Änderungen, anfangs angehakt), ein Kontrollkästchen je Gruppe und je Eintrag, Textfeld mit Platzhalter „Commit message“, Schaltflächen „Save“ (gesperrt bei leerer Nachricht oder leerer Auswahl) und „Back“. Gibt es nicht gepflegte Dateien, steht darunter das angehakte Kontrollkästchen „Remove files no longer maintained (N)“.
- „Save“ sendet `commit` mit `allowBehind: false`. Ergebnis `{ sha }`: Die Schaltfläche zeigt „Success“, danach lädt das Panel `status` und `localChanges` neu und verlässt den Commit-Modus. Ergebnis `{ behind }`: Dialog „The branch has N new commits that this save would overwrite:“ mit den Nachrichten der Commits, dem Hinweis „Updating the app is not part of this version yet.“ und den Schaltflächen „Commit anyway“ (sendet denselben Befehl mit `allowBehind: true`) und „Cancel“.
- Für `published` (Task 13) zeigt dieselbe Komponente nur die Liste.

`HistoryTab`: lädt `history` Seite 1; je Commit Nachricht (erste Zeile), Autor, Datum und Uhrzeit in Ortszeit, die ersten sieben Zeichen des SHA als Link auf `https://github.com/<repo>/commit/<sha>`; „Load more“ lädt die nächste Seite, solange die letzte Seite 30 Einträge hatte. Ist der Branch nicht der Default-Branch, steht oben der Link „Open pull request on GitHub“ (`pullRequestUrl`, neuer Tab).

- [ ] **Step 1: Failing tests.**

```ts
// tests/ext/changes-model.test.ts
const item = (path: string, kind: ChangeKind, group: ObjectGroup, title: string): ChangeItem => ({ path, kind, group, part: partOf(group), title });
test("groups changes like gitoqlok", () => {
  const items = [
    item("objects/measures/m1.json", "changed", "measures", "Sales"),
    item("objects/dimensions/d1.json", "changed", "dimensions", "Region"),
    item("objects/sheets/s1.json", "changed", "sheets", "Overview"),
    item("data_load_script/Main.qvs", "added", "script", "Main"),
  ];
  expect(sections(items).map((s) => [s.label, s.groups.map((g) => [g.label, g.items.map((i) => i.title)])])).toEqual([
    ["Added objects", [["Script", ["Main"]]]],
    ["Changed objects", [["Sheets", ["Overview"]], ["Master Items", ["Region", "Sales"]]]],
  ]);
});
test("parts select and deselect their paths", () => {
  const items = [item("data_load_script/Main.qvs", "changed", "script", "Main"), item("objects/sheets/s1.json", "changed", "sheets", "S")];
  const none = togglePart(initialSelection(items), items, "objects", false);
  expect([...none]).toEqual(["data_load_script/Main.qvs"]);
  expect(togglePart(none, items, "objects", true).size).toBe(2);
});
test("pull request url encodes branch segments", () => {
  expect(pullRequestUrl("lr-bicc/sales", "main", "feature/währung")).toBe("https://github.com/lr-bicc/sales/compare/main...feature/w%C3%A4hrung");
});
```

`tests/ext/panel-changes.test.tsx` (happy-dom, `fakeBridge`):
  - Eine verknüpfte App mit zwei Änderungen und `unmaintained: ["loadScript.qvs"]`: „Save changes“ → Eintrag eines Sheets abwählen → Nachricht eingeben → „Save“ sendet `{ cmd: "commit", message: "Fix", paths: [<nur der andere Pfad>], removeUnmaintained: true, allowBehind: false }`; nach `{ sha }` erscheint „Success“, und `status` und `localChanges` werden erneut gesendet.
  - „Save“ ist ohne Nachricht gesperrt. Ohne nicht gepflegte Dateien gibt es das Kontrollkästchen nicht, und der Befehl trägt `removeUnmaintained: false`.
  - Antwort `{ behind: [{ message: "theirs", … }] }` zeigt „The branch has 1 new commit that this save would overwrite:“ und „theirs“; „Commit anyway“ sendet denselben Befehl mit `allowBehind: true`.
  - Ohne Änderungen steht „No local changes“.
  - Eine Gruppe mit 25 Einträgen ist eingeklappt und zeigt „Variables (25)“.
  - `HistoryTab`: zeigt zwei Commits; bei Branch `dev` und Default-Branch `main` gibt es den Link „Open pull request on GitHub“, bei Branch `main` nicht; „Load more“ erscheint nur nach einer vollen Seite.

- [ ] **Step 2:** Tests laufen lassen → FAIL.
- [ ] **Step 3: Umsetzen.**
- [ ] **Step 4:** Tests → PASS; `npm run typecheck && npm run build:ext` grün.
- [ ] **Step 5: Commit** `feat(ext): local changes, save changes and history in the side panel`

---

### Task 15: Zusammenspiel und Abnahme

**Files:**
- Create: `tests/integration/extension-flow.test.ts`, `docs/superpowers/acceptance/plan-2-checklist.md`

**Interfaces:**
- Consumes: Router (Task 12), `handleGateway` und `createGitHubPort` (Task 4), Engine-Attrappe (Task 6), `mockFetch`.

- [ ] **Step 1: Integrationstest.** Der Router läuft gegen die Engine-Attrappe; sein `GitHubPort` geht über `createGitHubPort` → JSON-Kopie der Nachricht → `handleGateway` → `src/github` → ein kleines GitHub im Speicher hinter `fetch` (in der Testdatei: Repos, Refs, Commits, Trees, Blobs, `contents`, `compare`, GraphQL-Liste der Repos; nur die Endpunkte, die die Bibliothek aufruft). Ablauf in einem Test:
  1. `status` → `unlinked`.
  2. `createRepository` → Repo `lr-bicc/<slug>` existiert; sein HEAD enthält `README.md` und die Dateien der App, darunter eine Binärdatei unter `appcontent/`, deren Bytes mit denen der App übereinstimmen.
  3. `status` → `linked`, `behindBy: 0`; `localChanges` → keine Einträge.
  4. Die App ändert sich (Titel eines Sheets, eine neue Variable). `localChanges` → genau diese zwei Einträge.
  5. `commit` nur mit dem Pfad des Sheets → `{ sha }`; `localChanges` danach → nur noch die Variable.
  6. In keiner Anfrage an das GitHub im Speicher fehlt der Header `Authorization`, und in keinem Ergebnis des Routers kommt der Token vor.

- [ ] **Step 2:** Test laufen lassen. Schlägt er fehl, liegt der Fehler in einer früheren Aufgabe: dort beheben, mit eigenem Test, und hier berichten.

- [ ] **Step 3: Abnahme-Checkliste** `docs/superpowers/acceptance/plan-2-checklist.md` (Deutsch), mit diesen Abschnitten und je Schritt dem erwarteten Ergebnis:
  1. **Einrichten:** `dist/ext` in `chrome://extensions` laden; Optionen: Token eintragen, „Check connection“, Server `https://lr-analytics-test.lrworld.com` hinzufügen.
  2. **Bestehendes gitoqlok-Repo:** die veröffentlichte „Supply Chain Performance“ duplizieren, Kopie öffnen, Panel öffnen. Erwartet: Hinweis auf die Kopie einer versionierten App. „Create Branch“ mit eigenem Namen. Erwartet auf GitHub: neuer Branch, Commit „Update branches table“.
  3. **Local Changes der frischen Kopie.** Erwartet (Spike): 11 geänderte Sheets, 2 geänderte Dimensionen, 357 gelöschte Variablen, sonst nichts; „Remove files no longer maintained“ nennt 5 Dateien. Abweichungen bitte mit Bildschirmfoto melden.
  4. **Save changes** mit allen Einträgen. Erwartet: Commit auf dem Branch; danach „No local changes“. Seite neu laden, Daten der App neu laden: weiterhin „No local changes“ (Erfolgskriterium 3).
  5. **Änderung:** ein Measure und einen Skript-Tab ändern → genau diese zwei Einträge → nur das Measure speichern → der Skript-Tab bleibt als Änderung stehen.
  6. **Neues Repo:** eine kleine App ohne Repo → „Create repository“ → Repo ist privat, hat `README.md` mit Branch-Tabelle; danach „No local changes“.
  7. **Sonderfälle:** veröffentlichte App (nur lesen); Token entfernen (Hinweis mit „Open options“); in Qlik abmelden und „Refresh“ (Hinweis zur Sitzung).
  8. **Rückmeldung:** was gemeldet werden soll (Dauer des Ladens der lokalen Änderungen, unerwartete Einträge, Fehlermeldungen im Wortlaut).

- [ ] **Step 4:** `npm test && npm run typecheck && npm run build:ext` → grün.
- [ ] **Step 5: Commit** `test: extension flow end to end, acceptance checklist`
- [ ] **Step 6 (Mensch):** Rumen führt die Checkliste gegen den Testserver aus und meldet das Ergebnis.

---

## Danach: Plan 3

Update mit Sicherungs-Branch, Diff-Overlay, Aktionen in der History, Tags, Import. Plan 3 wird nach der Abnahme von Plan 2 geschrieben. Bereits bekannte Eingaben:

- Zielstand über Tree und einzelne Blobs laden statt über das ZIP, solange `builds/` im Repo liegt (33 MB im Referenz-Repo).
- Wertefarben beim Zurückschreiben als eigenes Objekt `ColorMapModel_<qId>` anlegen, ändern oder löschen.
- `DoSave` nach einer Skriptänderung auf Datenerhalt prüfen (Spike-Frage 7 ist dafür offen); Stories mit Snapshots (Frage 6).
- Hochladen und Löschen statischer Dateien (`uploadfile`, `deletecontent`, im Spike bestätigt).
- Die offenen Punkte aus `docs/superpowers/plans/2026-11-12-plan-2-inputs.md`, die dieser Plan nicht erledigt: Seitenweises Laden der Branch- und Tag-Listen, mehrdeutige Zuordnung einer App, Namenstausch von Variablen im Update-Planer, Sonderzeichen in der Branch-Tabelle.
