# Qommit – Plan 3 von 3: Extension, Teil 2 – Update, Diff, Tags, Import

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Extension übernimmt Repo-Stände in eine App (Update mit Sicherungs-Branch), zeigt Unterschiede als Overlay in der Qlik-Seite, legt Tags an und listet sie, und erzeugt aus einem Repo-Stand eine neue App (Import).

**Architecture:** Wie in Plan 2: Abläufe sind reine Funktionen in `src/ext/flows/` über `FlowPorts`; das Content Script führt sie aus, der Service Worker ist der einzige Weg zu GitHub. Neu sind ein Schreib-Adapter für die Engine (`src/qlik/writer.ts`), der die Aktionsliste des vorhandenen `update-planner` ausführt, ein Overlay in Shadow DOM im Content Script und eine Sitzung auf `/app/engineData` für den Import. Zielstände werden nicht als ZIP geladen, sondern als einzelne Blobs, und nur die gepflegten Dateien, die sich vom App-Stand unterscheiden.

**Tech Stack:** unverändert: TypeScript (strict), Node 22, Vitest, esbuild, Preact, enigma.js, `diff` (jsdiff), `fflate`, `happy-dom` und `@testing-library/preact` (nur Tests).

**Spec:** `docs/superpowers/specs/2026-11-10-qlik-github-versioning-design.md` (Revision 11; dieser Plan ergänzt Revision 12 in Task 15). Vorgänger: `docs/superpowers/plans/2026-11-13-extension-connect-and-save.md` (Plan 2), Spike-Ergebnisse `docs/superpowers/spike/results.md`.

## Umfang

In diesem Plan (Spec 6.6–6.9, 6.1 Reiter und Commit-Auswahl, 7 „Fehler mitten im Update“):
- Update auf den Branch-HEAD, einen älteren Commit oder ein Tag, mit Teilauswahl, Vorschau, Sicherungs-Branch und `DoSave`.
- Diff-Overlay für „details“ (Local Changes), „Diff to previous“ und „Diff to app“.
- History-Aktionen, Reiter „Tags“, „Add tag“.
- Reiter „Import“ (im Hub und in einer App).
- Offene Punkte aus Plan 2: seitenweises Laden von Branches und Tags, Namenstausch von Variablen, Sonderzeichen in der Branch-Tabelle.
- „Update first“ in der Nachfrage vor einem Commit auf einen veralteten Stand.

Nicht in diesem Plan (wandert in Spec 10, Task 15): Anzeige einer mehrdeutigen Zuordnung (eine App in zwei Branch-Tabellen). Sie betrifft das Auffinden, nicht das Übernehmen, und ist auf dem Testserver nicht aufgetreten.

## Global Constraints

- Sprache: Code, Bezeichner, Kommentare, Fehlermeldungen und alle UI-Texte auf Englisch. UI-Texte exakt wie in den Aufgaben angegeben.
- Der GitHub-Token bleibt im Service Worker (Schlüssel `secret` in `chrome.storage.local`); er erscheint nie in Logs, Fehlermeldungen oder Nachrichten.
- `src/core/`, `src/github/`, `src/qlik/` und `src/ext/flows/` verwenden keine `chrome.*`-APIs. `src/qlik/` greift nur über übergebene Funktionen nach außen, `src/ext/flows/` nur über seine Ports.
- Schreibzugriffe auf eine Qlik-App: das Link-Objekt wie in Plan 2; Objekte, Skript und statische Dateien **nur** über `applyActions` und `saveApp` aus `src/qlik/writer.ts`, aufgerufen nur von `runUpdate` und `importApp`. Nie in veröffentlichten Apps, nie ohne Schreibrecht (`canWrite`). Bookmarks werden nie geschrieben (Spec 4.4).
- Vor jedem Schreiben in die App ist der Zielstand vollständig geladen und geprüft (`validateTarget`, `variableNameConflicts`). Ein Fehler beim Laden oder Prüfen ändert nichts an der App.
- Hat die App lokale Änderungen und ändert das Update etwas, liegt vorher der Sicherungs-Branch auf GitHub (Erfolgskriterium 5). Schlägt die Sicherung fehl, wird nichts geschrieben.
- Der Service Worker führt nur die Aufrufe aus `GitHubPort` aus, nur für Repos der eingestellten Org, nur für Nachrichten der eigenen Extension. Neue Aufrufe prüfen ihre Argumente wie die bestehenden (`ARG_KINDS`, Pfad- und SHA-Prüfung).
- Manifest unverändert. Keine neuen Abhängigkeiten.
- Commit-Nachricht des Sicherungs-Commits exakt `Backup before update to <sha7>`; Name des Sicherungs-Branches `backup/<branch>-<JJJJMMTT-hhmm>` in Ortszeit von `ports.now()`, bei Kollision `-2`, `-3` … angehängt.
- Commit-Nachrichten im Projekt: Conventional Commits. Jeder Commit-Schritt bedeutet `git add -A && git commit -m "<Nachricht>"`. `npm test` und `npm run typecheck` sind vor jedem Commit grün.

## Review Focus

1. **Die Engine lehnt mitten im Update ein Objekt ab** (etwa „Access denied“ für eine Dimension). Erwartet: Stopp beim ersten Fehler, kein `DoSave`, `syncedSha` unverändert, das Panel nennt erledigte und offene Aktionen und die Engine-Meldung, der Sicherungs-Branch existiert, beim nächsten Laden des Status erscheint der Hinweis auf das abgebrochene Update. → Tests in Task 4, 7 und 10.
2. **Zielstand aus einem gitoqlok-Repo:** `builds/x.qvf`, `loadScript.qvs`, `objects/fields.json`, Dateien skripterzeugter Variablen (mit `qIsScriptCreated: true`) und Sheets mit fremder App-ID in `/appcontent/<id>/`. Erwartet: Nur gepflegte Dateien werden geladen, `builds/` und `README.md` nie; skripterzeugte Variablen werden weder angelegt noch gelöscht; die Sheets zeigen nach dem Update auf die eigene App. → Tests in Task 6.
3. **Der Tab wird während des Updates geschlossen oder neu geladen.** Erwartet: Beim nächsten Öffnen zeigt das Panel „The last update did not finish …“ mit dem Sicherungs-Branch; ein erfolgreiches Update entfernt den Hinweis. → Tests in Task 10 und 12.
4. **Namenskollisionen:** zwei Updates in derselben Minute (Sicherungs-Branch), ein vorhandenes Tag, ein Branch-Name mit `|`, ein App-Titel mit Emoji beim Import. Erwartet: `-2` am Sicherungs-Branch, „Tag already exists.“ ohne Änderung, korrekt maskierte Tabellenzeile, gültige neue App. → Tests in Task 3, 7 und 9.
5. **Variablen tauschen ihre Namen, oder eine Zielvariable trägt den Namen einer Skript-Variablen der App.** Erwartet: Tausch über Zwischennamen ohne Engine-Fehler; der zweite Fall bricht vor dem Schreiben mit „variable-name-taken“ ab. → Tests in Task 3 und 6.

## Dateistruktur

```
src/github/repo.ts                    + parents, Seiten für Branches, Tags über GraphQL, readBlobs
src/ext/shared/github-port.ts         + listTags, createTag, readBlobs
src/ext/background/gateway.ts         + Prüfung und Ausführung der neuen Aufrufe
src/ext/background/sw.ts              + Zugriff des Content Scripts auf storage.session
src/core/update-planner.ts            + Zwischennamen für Variablen, describeAction
src/core/target-validator.ts          + variableNameConflicts
src/core/repo-layout.ts               + Maskierung in Tabellen, readmeTitle
src/qlik/writer.ts                    neu: Aktionen in die App schreiben, DoSave
src/qlik/content-files.ts             + createContentStore (Upload, Löschen)
src/qlik/link.ts                      + canWrite in readAppInfo
src/qlik/session.ts                   + openGlobal, createApp
src/ext/flows/ports.ts                + AppPort.apply/save, AppInfo.canWrite, UpdateJournal, neue FlowError-Codes
src/ext/flows/local-changes.ts        + readLocal
src/ext/flows/target.ts               neu: Zielstand laden
src/ext/flows/update.ts               neu: Vorschau und Update
src/ext/flows/diff.ts                 neu: Unterschiede zweier Stände
src/ext/flows/tags.ts                 neu: Tag anlegen
src/ext/flows/import.ts               neu: neue App aus Repo
src/ext/content/app-port.ts           + apply, save, canWrite
src/ext/content/server-port.ts        neu: neue App auf dem Server des Tabs
src/ext/content/journal.ts            neu: UpdateJournal über chrome.storage.session
src/ext/content/overlay/side-by-side.ts  neu: Zeilen-Diff → Zeilenpaare
src/ext/content/overlay/DiffOverlay.tsx  neu: Overlay (Preact)
src/ext/content/overlay/show.ts       neu: Overlay in Shadow DOM einhängen
src/ext/content/router.ts             + neue Befehle
src/ext/content/content.ts            + Journal, Overlay, Server-Sitzung
src/ext/shared/commands.ts            + neue Befehle, interruptedUpdate
src/ext/panel/CommitPicker.tsx        neu
src/ext/panel/UpdateDialog.tsx        neu
src/ext/panel/AddTagDialog.tsx        neu
src/ext/panel/TagsTab.tsx             neu
src/ext/panel/ImportTab.tsx           neu
src/ext/panel/LocalChangesTab.tsx  HistoryTab.tsx  App.tsx  errors.ts  changes-model.ts   geändert
tests/…                               je Task; tests/ext/fake-ports.ts und tests/qlik/fake-engine.ts erweitert
docs/superpowers/acceptance/plan-3-checklist.md
```

---

### Task 1: GitHub – Eltern, Seiten, Tags, Blobs

**Files:**
- Modify: `src/github/repo.ts`
- Test: `tests/github/repo.test.ts`

**Interfaces:**
- Produces:
  - `interface CommitInfo { sha: string; message: string; author: string; date: string; parents: string[] }`
  - `interface TagInfo { name: string; sha: string /* commit */; date: string | null; message: string }`
  - `interface BlobRef { path: string; sha: string }`, `const MAX_BLOBS_PER_CALL = 100`
  - `listBranches(c, repo)` – alle Seiten
  - `listTags(c, repo): Promise<TagInfo[]>` – GraphQL, alle Seiten, neueste zuerst
  - `createTag(c, repo, { name, sha, message })` – unverändert; vorhandener Name → `GitHubError("name-exists")` (Mapping existiert)
  - `readBlobs(c, repo, items: BlobRef[]): Promise<FileMap>`

- [ ] **Step 1: Write the failing tests**

```ts
test("listCommits returns the parents of each commit", async () => {
  // mock GET /repos/lr-bicc/sales/commits?sha=main&per_page=30&page=1 → [{ sha: "b", parents: [{ sha: "a" }], commit: {...} }]
  expect((await listCommits(c, "lr-bicc/sales", "main", 1))[0].parents).toEqual(["a"]);
});
test("listBranches reads every page", async () => {
  // page 1: 100 branches, page 2: 3 branches; requests ?per_page=100&page=1 and &page=2
  expect((await listBranches(c, "lr-bicc/sales")).length).toBe(103);
});
test("listTags reads annotated and lightweight tags over all pages", async () => {
  // GraphQL page 1: { name: "v1", target: { __typename: "Tag", message: "first", tagger: { date: "2026-01-01T00:00:00Z" }, target: { oid: "c1" } } }, hasNextPage true
  // page 2: { name: "v0", target: { __typename: "Commit", oid: "c0", committedDate: "2025-12-01T00:00:00Z" } }
  expect(await listTags(c, "lr-bicc/sales")).toEqual([
    { name: "v1", sha: "c1", date: "2026-01-01T00:00:00Z", message: "first" },
    { name: "v0", sha: "c0", date: "2025-12-01T00:00:00Z", message: "" },
  ]);
  // the query variables carry owner "lr-bicc", name "sales" and the endCursor of page 1 on the second call
});
test("readBlobs decodes text with its BOM and appcontent as bytes", async () => {
  // GET /repos/lr-bicc/sales/git/blobs/s1 → { encoding: "base64", content: base64("﻿a\n") }
  // GET .../git/blobs/s2 → base64 of bytes [0, 255]
  const files = await readBlobs(c, "lr-bicc/sales", [{ path: "data_load_script/Main.qvs", sha: "s1" }, { path: "appcontent/a.png", sha: "s2" }]);
  expect(files.get("data_load_script/Main.qvs")).toBe("﻿a\n");
  expect(files.get("appcontent/a.png")).toEqual(new Uint8Array([0, 255]));
});
test("readBlobs refuses more than 100 items and stops starting requests after a failure", async () => {
  await expect(readBlobs(c, "lr-bicc/sales", Array.from({ length: 101 }, (_, i) => ({ path: `p${i}`, sha: "s" })))).rejects.toThrow();
  // 20 items, the 1st answers 500: the call rejects and at most 8 requests were sent
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/github/repo.test.ts`
Expected: FAIL (`parents` undefined, `readBlobs` not exported).

- [ ] **Step 3: Implement**

- `toCommitInfo` liest `parents: c.parents.map(p => p.sha)` (`RawCommit` erhält `parents: { sha: string }[]`).
- `listBranches`: `?per_page=100&page=N` ab 1, bis eine Seite weniger als 100 Einträge hat.
- `listTags`: GraphQL über `repository(owner, name) { refs(refPrefix: "refs/tags/", first: 100, after: $cursor, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) { pageInfo { hasNextPage endCursor } nodes { name target { __typename oid ... on Tag { message tagger { date } target { oid } } ... on Commit { committedDate } } } } }`. Annotiertes Tag: `sha` = `target.target.oid`, `date` = `tagger.date`; sonst `sha` = `target.oid`, `date` = `committedDate ?? null`, `message` = `""`. Abbruch bei `endCursor === null` wie in `orgRepoNodes`.
- `readBlobs`: höchstens `MAX_BLOBS_PER_CALL` Einträge, sonst `Error("Too many blobs in one call")`; `GET /repos/{repo}/git/blobs/{sha}`, höchstens 8 gleichzeitig; nach dem ersten Fehler startet keine weitere Anfrage, der Fehler wird geworfen. Base64 dekodieren (ohne `Buffer`); Pfade unter `appcontent/` als `Uint8Array`, alle anderen als UTF-8 mit `new TextDecoder("utf-8", { ignoreBOM: true })`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/github/repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(github): commit parents, paged branches, tags with dates, blob reads`

---

### Task 2: Gateway und GitHubPort – Tags und Blobs

**Files:**
- Modify: `src/ext/shared/github-port.ts`, `src/ext/background/gateway.ts`, `tests/ext/fake-ports.ts`
- Test: `tests/ext/gateway.test.ts`, `tests/ext/fake-ports.test.ts` (neu, nur für die neuen Fake-Funktionen)

**Interfaces:**
- Consumes: Task 1 (`TagInfo`, `BlobRef`, `readBlobs`, `listTags`, `createTag`, `MAX_BLOBS_PER_CALL`).
- Produces (in `GitHubPort`):
  - `listTags(repo: string): Promise<TagInfo[]>`
  - `createTag(repo: string, input: { name: string; sha: string; message: string }): Promise<void>`
  - `readBlobs(repo: string, items: BlobRef[]): Promise<FileMap>` – höchstens 100 je Aufruf; die Antwort reist als `[path, WireContent][]`.
  - `fakeGitHub()` zusätzlich: `tag(repo, name, sha, message?)` zum Vorbelegen, `blobReads(): number` (Anzahl gelesener Blobs), echte Blob-SHAs aus `gitBlobSha` in `getTree`, `readBlobs` liefert Inhalte zu diesen SHAs, `listTags`, `createTag` (vorhandener Name → `GatewayError("name-exists")`); `listCommits` liefert `parents`.

- [ ] **Step 1: Write the failing tests**

```ts
test("readBlobs travels as wire content and comes back as a FileMap", async () => {
  // gateway with mocked fetch for two blobs (text and appcontent bytes) → port.readBlobs returns Map with string and Uint8Array
});
test.each([
  ["readBlobs", ["lr-bicc/sales", [{ path: "../x", sha: "a".repeat(40) }]]],
  ["readBlobs", ["lr-bicc/sales", [{ path: "objects/a.json", sha: "xyz" }]]],
  ["readBlobs", ["lr-bicc/sales", []]],
  ["readBlobs", ["lr-bicc/sales", Array.from({ length: 101 }, () => ({ path: "a", sha: "a".repeat(40) }))]],
  ["createTag", ["lr-bicc/sales", { name: "bad name", sha: "a".repeat(40), message: "" }]],
  ["createTag", ["lr-bicc/sales", { name: "v1", sha: "nope", message: "" }]],
  ["createTag", ["lr-bicc/sales", { name: "v1", sha: "a".repeat(40) }]],
  ["listTags", ["other-org/sales"]],
])("%s refuses malformed arguments", async (op, args) => {
  expect(await handleGateway({ op, args } as GatewayRequest, deps)).toMatchObject({ ok: false, error: { kind: "not-allowed" } });
});
test("fake readBlobs answers with the files of the commit", async () => {
  const gh = fakeGitHub();
  const sha = gh.seed("lr-bicc/sales", new Map([["objects/variables/v.json", "{}"]]));
  const tree = await gh.getTree("lr-bicc/sales", sha);
  const files = await gh.readBlobs("lr-bicc/sales", [{ path: "objects/variables/v.json", sha: tree.get("objects/variables/v.json")! }]);
  expect(files.get("objects/variables/v.json")).toBe("{}");
  expect(gh.blobReads()).toBe(1);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/ext/gateway.test.ts tests/ext/fake-ports.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `OpSpec.tail` erweitern um `"tag"` und `"blobs"`; `parseTagInput` (Name `isValidRefName`, SHA 40 Hex, `message` String) und `parseBlobItems` (Array, 1 bis `MAX_BLOBS_PER_CALL`, jeder Pfad `isValidCommitPath`, jede SHA 40 Hex) neben `parseCommitInput`.
- `OPS`: `listTags { strings: 1, repo: true }`, `createTag { strings: 1, tail: "tag", repo: true }`, `readBlobs { strings: 1, tail: "blobs", repo: true }`; `readBlobs` gibt `[...files].map(([p, c]) => [p, toWire(c)])` zurück, `createGitHubPort` wandelt mit `fromWire` zurück in eine `Map`.
- `fakeGitHub`: Blob-SHAs aus `gitBlobSha`; `readBlobs` sucht den Inhalt über die SHA in allen Commits des Repos, unbekannte SHA → `GatewayError("not-found")`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ext`
Expected: PASS (bestehende Tests eingeschlossen).

- [ ] **Step 5: Commit**

`feat(ext): gateway calls for tags and blob reads`

---

### Task 3: Bibliothek – Variablentausch, Aktionstitel, Namenskonflikte, Tabellen-Maskierung

**Files:**
- Modify: `src/core/update-planner.ts`, `src/core/target-validator.ts`, `src/core/repo-layout.ts`
- Test: `tests/core/update-planner.test.ts`, `tests/core/target-validator.test.ts`, `tests/core/repo-layout.test.ts`

**Interfaces:**
- Produces:
  - `Action` upsert erhält `temporary?: true`; `summarize` zählt solche Aktionen nicht.
  - `interface ActionItem { kind: "create" | "change" | "delete"; group: AppObjectGroup | "files" | "script"; id: string; title: string }`
  - `describeAction(a: Action): ActionItem` – Titel: `qProperty.qMetaDef.title` bzw. `qMetaDef.title` bzw. `qName` bzw. die ID; Dateien: Dateiname; Skript: `"Load script"`; `delete` hat keinen Payload → Titel ist die ID.
  - `TargetProblemReason` + `"variable-name-taken"`; `variableNameConflicts(app: AppSnapshot, target: AppSnapshot): TargetProblem[]` – `path` = `objects/variables/<qId>.json` der Zielvariable.
  - `readmeTitle(readme: string): string | null`
  - Branch-Tabelle: `|` in Namen als `\|`, in URLs `)` → `%29`, Leerzeichen → `%20`; `parseBranchTable` macht das rückgängig. Sheet-Titel und -Beschreibungen in `createReadme`: `|` → `\|`, Zeilenumbrüche → Leerzeichen.

- [ ] **Step 1: Write the failing tests**

```ts
test("two variables that swap their names go through a temporary name", () => {
  const cur = snap({ variables: [v("a", "vX"), v("b", "vY")] });
  const tgt = snap({ variables: [v("a", "vY"), v("b", "vX")] });
  const actions = planUpdate(cur, tgt, new Set(["objects"]));
  const names = actions.filter(isUpsert).map((a) => `${a.id}:${(a.payload as GenericProps).qName}${a.temporary ? "*" : ""}`);
  expect(names).toEqual(["a:vX__qommit_a*", "a:vY", "b:vX"]);
  expect(summarize(actions)).toEqual({ create: 0, change: 2, delete: 0 });
});
test("describeAction names objects by their title", () => {
  expect(describeAction({ op: "upsert", group: "sheets", id: "s1", exists: false, payload: tree("s1", { qMetaDef: { title: "Overview" } }) }))
    .toEqual({ kind: "create", group: "sheets", id: "s1", title: "Overview" });
  expect(describeAction({ op: "setScript", script: "" })).toEqual({ kind: "change", group: "script", id: "script", title: "Load script" });
  expect(describeAction({ op: "deleteFile", name: "logo.png" })).toEqual({ kind: "delete", group: "files", id: "logo.png", title: "logo.png" });
});
test("a target variable that takes the name of a script variable is a conflict", () => {
  const app = snap({ variables: [v("s", "vToday", { qIsScriptCreated: true })] });
  const target = snap({ variables: [v("x", "vToday")] });
  expect(variableNameConflicts(app, target)).toEqual([{ path: "objects/variables/x.json", reason: "variable-name-taken" }]);
  expect(variableNameConflicts(app, snap({ variables: [v("s", "vToday")] }))).toEqual([]); // same id is no conflict
});
test("branch names with | and URLs with ) survive the table", () => {
  const readme = upsertBranchRow(createReadme({ ...base, defaultBranch: "main" }), { branch: "a|b", appUrl: "https://q/x (1)" });
  expect(readme).toContain("a\\|b|[https://q/x%20%281%29]");
  expect(parseBranchTable(readme).find((r) => r.branch === "a|b")?.appUrl).toBe("https://q/x%20%281%29");
});
test("readmeTitle reads the app title, also from gitoqlok READMEs", () => {
  expect(readmeTitle("# Qlik Application Repository\n# Sales 📈\n")).toBe("Sales 📈");
  expect(readmeTitle("no heading")).toBeNull();
});
```

Die URL wird beim Schreiben maskiert und bleibt beim Lesen maskiert (sie ist danach eine gültige URL); nur `\|` im Branch-Namen wird beim Lesen zurückgewandelt.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/core`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Planer, Gruppe `variables`: Für jede Variable, die in beiden Ständen vorkommt und ihren Namen wechselt, deren bisheriger Name aber Zielname einer **anderen** ID ist, steht vor allen übrigen Aktionen der Gruppe eine Aktion `{ op: "upsert", group: "variables", id, exists: true, payload: { ...aktueller Payload, qName: `${alterName}__qommit_${id}` }, temporary: true }`. Die bestehende Regel für gelöschte Namen bleibt.
- `variableNameConflicts`: Namen der Variablen in `app` mit `qIsScriptCreated` oder `qIsReserved`; jede Zielvariable mit gleichem `qName` und anderer `qInfo.qId` ist ein Problem; sortiert nach `path`.
- `readmeTitle`: erste Zeile `# <Titel>`, deren Titel nicht `Qlik Application Repository` ist; getrimmt; leer → `null`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/core tests/integration/roundtrip.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(core): variable name swaps, action titles, name conflicts, escaped README tables`

---

### Task 4: In die App schreiben

**Files:**
- Create: `src/qlik/writer.ts`
- Modify: `tests/qlik/fake-engine.ts` (Schreibmethoden)
- Test: `tests/qlik/writer.test.ts`

**Interfaces:**
- Consumes: `Action` aus `src/core/update-planner.ts`, `engineCall`/`withTimeout` aus `src/qlik/timeout.ts`.
- Produces:
  - `interface FileStore { put(name: string, bytes: Uint8Array): Promise<void>; remove(name: string): Promise<void> }`
  - `class ApplyError extends Error { done: Action[]; failed: Action; remaining: Action[] }` – `message` ist die Engine-Meldung.
  - `applyActions(doc: EngineApi, actions: Action[], opts: { files: FileStore; onProgress?(done: number, total: number): void }): Promise<void>`
  - `saveApp(doc: EngineApi): Promise<void>` – `DoSave` mit 150 s Zeitgrenze.

Engine-Aufrufe je Aktion (Spike Frage 2 und 5):

| Aktion | anlegen (`exists: false`) | ändern (`exists: true`) | löschen |
|---|---|---|---|
| `appprops`, `masterobjects`, `sheets`, `stories` | `createObject({ qInfo })` → `setFullPropertyTree(tree)` | `getObject(id)` → `setFullPropertyTree(tree)` | `destroyObject(id)` |
| `variables` | `createVariableEx(props)` | `getVariableById(id)` → `setProperties(props)` | `destroyVariableById(id)` |
| `dimensions` | `createDimension(props ohne _ColorMapModel)` | `getDimension(id)` → `setProperties(…)` | `destroyDimension(id)`, danach `destroyObject("ColorMapModel_<id>")` |
| `measures` | `createMeasure(props)` | `getMeasure(id)` → `setProperties(props)` | `destroyMeasure(id)` |
| `putFile` / `deleteFile` | `files.put` | `files.put` | `files.remove` |
| `setScript` | – | `setScript(script)` | – |

Wertefarben (Spec 4.3): Hat der Payload einer Dimension `_ColorMapModel`, wird nach der Dimension `getObject("ColorMapModel_<id>")` geöffnet oder, falls es fehlt, mit `createObject({ qInfo: { qId: "ColorMapModel_<id>", qType: "ColorMap" } })` angelegt und mit `setProperties({ qInfo, colorMap })` beschrieben. Fehlt `_ColorMapModel`, wird `destroyObject("ColorMapModel_<id>")` aufgerufen; eine Antwort „nicht vorhanden“ ist kein Fehler.

- [ ] **Step 1: Write the failing tests**

```ts
test("upserts create and change objects with their ids and keep the order", async () => {
  const { doc, calls } = fakeDoc(appFromSnapshot(makeSnapshot()));
  await applyActions(doc, [
    { op: "upsert", group: "variables", id: "vNew", exists: false, payload: varProps("vNew", "vNew") },
    { op: "upsert", group: "sheets", id: "sh1", exists: true, payload: sheetTree("sh1") },
    { op: "setScript", script: "///$tab Main\nLOAD 1;" },
  ], { files: memoryStore() });
  expect(calls).toEqual(["createVariableEx vNew", "getObject sh1", "setFullPropertyTree sh1", "setScript -"]);
});
test("a dimension with colours writes its ColorMap object; without colours the object is removed", async () => { /* calls contain createObject ColorMapModel_d1, setProperties ColorMapModel_d1; and destroyObject ColorMapModel_d2 */ });
test("the first failure stops the update and names done and remaining actions", async () => {
  const { doc, failOn } = fakeDoc(appFromSnapshot(makeSnapshot()));
  failOn("createDimension", "d9");
  const err = await applyActions(doc, [a1, dimD9, a3], { files: memoryStore() }).catch((e) => e);
  expect(err).toBeInstanceOf(ApplyError);
  expect(err.done).toEqual([a1]); expect(err.failed).toBe(dimD9); expect(err.remaining).toEqual([a3]);
});
test("onProgress counts every action", async () => { /* [0,3], [1,3], [2,3], [3,3] */ });
test("saveApp calls DoSave", async () => { /* calls contains "doSave -" */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/qlik/writer.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `applyActions` and `saveApp` in `src/qlik/writer.ts`; extend `fakeDoc`**

Jeder Engine-Aufruf läuft über `engineCall`; `setFullPropertyTree` mit 60 s (`withTimeout`). Die Aktionen laufen nacheinander (Reihenfolge des Planers ist eine Abhängigkeitsreihenfolge). `fakeDoc` erhält die Schreibmethoden der Tabelle, `setScript`, `doSave`; angelegte und geänderte Objekte landen in `app`, sodass ein anschließendes `readApp` sie liest.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/qlik`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(qlik): write planned actions into an app`

---

### Task 5: Statische Dateien, Schreibrecht, neue App, AppPort

**Files:**
- Modify: `src/qlik/content-files.ts`, `src/qlik/link.ts`, `src/qlik/session.ts`, `src/ext/flows/ports.ts`, `src/ext/content/app-port.ts`, `tests/ext/fake-ports.ts`
- Create: `src/ext/content/server-port.ts`
- Test: `tests/qlik/content-files.test.ts`, `tests/qlik/link.test.ts`, `tests/qlik/session.test.ts`, `tests/ext/app-port.test.ts`

**Interfaces:**
- Consumes: Task 4 (`FileStore`, `applyActions`, `saveApp`).
- Produces:
  - `createContentStore(loc: { origin: string; prefix: string }, appId: string, fetchFn: typeof fetch): FileStore` – `POST <origin><prefix>/qrs/appcontent/<appId>/uploadfile?externalpath=<enc>&overwrite=true&xrfkey=<16 Zeichen>` mit Kopf `X-Qlik-Xrfkey` und `Content-Type: application/octet-stream`; `DELETE …/deletecontent?externalpath=<enc>&xrfkey=…`. Status außerhalb 2xx → `Error("Could not upload <name>: HTTP <status>")` bzw. `remove`. 60 s Zeitgrenze.
  - `readAppInfo(doc)` → `{ title, published, canWrite }`; `canWrite = layout.permissions?.update !== false`.
  - `openGlobal(loc: { origin: string; prefix: string }, deps: { fetch: typeof fetch; create: EnigmaCreate }): Promise<{ global: EngineApi; close(): Promise<void> }>` – URL `wss://<host><prefix>/app/engineData` (mit CSRF-Token wie `openSession`).
  - `createApp(global: EngineApi, name: string): Promise<string>` – `global.createApp(name)`; ohne `qSuccess` → `QlikSessionError("Could not create the app")`.
  - `AppInfo` + `canWrite: boolean`; `AppPort` + `apply(actions: Action[], onProgress?: (done: number, total: number) => void): Promise<void>` (wirft `ApplyError`) und `save(): Promise<void>`.
  - `ServerPort { createApp(name: string): Promise<{ app: AppPort; close(): Promise<void> }> }` (in `src/ext/flows/ports.ts`); `createServerPort(loc: QlikLocation, deps: { openGlobal(loc: QlikLocation): Promise<{ global: EngineApi; close(): Promise<void> }>; openSession(loc: QlikLocation & { appId: string }): Promise<EngineSession>; fetch: typeof fetch }): ServerPort` in `src/ext/content/server-port.ts`.
  - `fakeApp` + `apply` (wendet Aktionen auf `snapshot` an; `failApplyAt(index, message)` lässt die Aktion mit diesem Index mit `ApplyError` scheitern), `save()` zählt `saves`, `read` zählt `reads`, `info.canWrite` Standard `true`.
  - `fakeServer(): ServerPort & { created: { name: string; app: ReturnType<typeof fakeApp> }[]; failAfterCreate(message: string): void }` – jede neue App beginnt mit einem leeren Snapshot (Skript `""`, keine Objekte).

- [ ] **Step 1: Write the failing tests**

```ts
test("upload and delete go to the QRS with an xrfkey", async () => {
  const seen: string[] = [];
  const store = createContentStore({ origin: "https://q", prefix: "/qs" }, "app1", mockFetch(seen, 201));
  await store.put("Stock Availability.png", new Uint8Array([1]));
  expect(seen[0]).toMatch(/^POST https:\/\/q\/qs\/qrs\/appcontent\/app1\/uploadfile\?externalpath=Stock%20Availability\.png&overwrite=true&xrfkey=[A-Za-z0-9]{16}$/);
  // the X-Qlik-Xrfkey header equals the xrfkey query value
});
test("a failed upload names the file", async () => { /* status 403 → rejects with "Could not upload a.png: HTTP 403" */ });
test("canWrite follows the app's update permission", async () => {
  /* layout { permissions: { update: false } } → canWrite false; no permissions → true */
});
test("createApp opens the engineData endpoint and returns the new id", async () => {
  /* fake enigma: url ends with /qs/app/engineData; global.createApp("Sales (main)") → { qSuccess: true, qAppId: "new" } → "new" */
});
test("apply and save of the app port reach the engine", async () => { /* calls contain setScript and doSave */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/qlik tests/ext/app-port.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`createAppPort`: `apply` = `applyActions(doc, actions, { files: createContentStore(loc, loc.appId, fetchFn), onProgress })`, `save` = `saveApp(doc)`, `info` mit `canWrite` aus `readAppInfo`. `createServerPort.createApp(name)`: `openGlobal` → `createApp` → globale Sitzung schließen → `openSession({ ...loc, appId })` → `{ app: createAppPort(session, …), close: () => session.close() }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/qlik tests/ext`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(qlik): upload app content, write permission, create apps`

---

### Task 6: Zielstand laden und Update-Vorschau

**Files:**
- Create: `src/ext/flows/target.ts`, `src/ext/flows/update.ts`
- Modify: `src/ext/flows/local-changes.ts`, `src/ext/flows/ports.ts`
- Test: `tests/ext/target.test.ts`, `tests/ext/update.test.ts`

**Interfaces:**
- Consumes: Task 2 (`readBlobs`, `MAX_BLOBS_PER_CALL`), Task 3 (`describeAction`, `variableNameConflicts`, `ActionItem`), Task 5 (`AppInfo.canWrite`).
- Produces:
  - `readLocal(ports, repo, onProgress?): Promise<{ snapshot: AppSnapshot; files: FileMap; hashes: Map<string, string> }>`; `buildLocalFiles` nutzt sie.
  - `loadTarget(github: GitHubPort, repo: string, sha: string, local?: { files: FileMap; hashes: Map<string, string> }, onProgress?: (done: number, total: number) => void): Promise<FileMap>` – nur Pfade mit `groupOf(path) !== null`; Inhalte mit gleicher Blob-SHA kommen aus `local`, alle anderen über `readBlobs` in Gruppen zu 100.
  - `type UpdatePart = "script" | "objects" | "files"`; `const UPDATE_PARTS: UpdatePart[]`
  - `interface UpdateInput { link: LinkData; target: string; parts: UpdatePart[] }`
  - `interface UpdatePreview { target: string; items: ActionItem[]; summary: PlanSummary; localChanges: number; onBranch: boolean }`
  - `previewUpdate(ports: FlowPorts, input: UpdateInput, onProgress?): Promise<UpdatePreview>`
  - intern geteilt mit Task 7: `prepareUpdate(ports, input, onProgress?)` → `{ info, local, baseTree, actions, preview }`
  - `FlowErrorCode` + `"invalid-target" | "update-failed" | "cannot-write" | "tag-exists" | "invalid-tag-name" | "import-failed"`; `invalid-target` trägt `detail: TargetProblem[]`.

Ablauf `prepareUpdate`:
1. `info.published` → `FlowError("published")`; `!info.canWrite` → `FlowError("cannot-write", "You have no permission to change this app")`.
2. `readLocal` (mit statischen Dateien); `loadTarget(…, target, local)`; `getTree(link.repo, link.syncedSha)` als `baseTree`.
3. Probleme = `validateTarget(targetFiles)` + `variableNameConflicts(local.snapshot, targetSnap)`; nicht leer → `FlowError("invalid-target", …, problems)`.
4. `current = deserializeApp(local.files, { targetAppId: info.id })`, `targetSnap = deserializeApp(targetFiles, { targetAppId: info.id })`; `actions = planUpdate(current, targetSnap, new Set(parts))`.
5. `localChanges = diffTrees(baseTree, local.hashes).length`; `onBranch = await isAncestor(github, repo, target, head)` mit dem aktuellen Branch-HEAD (fehlt der Branch → `FlowError("branch-not-found")`).
6. `items = actions.filter(a => !(a.op === "upsert" && a.temporary)).map(describeAction)`.

- [ ] **Step 1: Write the failing tests**

```ts
test("loadTarget downloads only maintained files that differ from the app", async () => {
  // repo at sha: 4 maintained files (2 equal to local, 2 different), README.md, builds/x.qvf, loadScript.qvs
  const files = await loadTarget(github, "lr-bicc/sales", sha, local);
  expect([...files.keys()].sort()).toEqual(fourMaintainedPaths);
  expect(github.blobReads()).toBe(2);
});
test("preview counts what an update to the head would do", async () => {
  // app has one extra sheet, repo head changed a measure → { create: 0, change: 1, delete: 1 }, localChanges 1, onBranch true
});
test("script-created variables of a gitoqlok target are neither created nor deleted", async () => {
  // target holds objects/variables/vU.json with qIsScriptCreated: true; app has the same variable as script variable → items contain no variable
});
test("sheets of a target with a foreign app id point to the app itself after deserialising", async () => {
  // target sheet text contains /appcontent/<CANON_ID>/a.png; app files equal after normalisation → no sheet action
});
test("a broken target stops before anything is written", async () => {
  // conflict markers in a sheet → rejects with FlowError invalid-target, detail [{ path, reason: "conflict-markers" }]; app.snapshot unchanged
});
test("a target variable on the name of a script variable is reported", async () => { /* reason variable-name-taken */ });
test("published apps and apps without write permission get no preview", async () => { /* codes published, cannot-write */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/ext/target.test.ts tests/ext/update.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `readLocal`, `loadTarget`, `prepareUpdate`, `previewUpdate`**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ext`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(ext): load a target state and preview an update`

---

### Task 7: Update ausführen – Sicherung, Journal, `syncedSha`

**Files:**
- Modify: `src/ext/flows/update.ts`, `src/ext/flows/ports.ts`
- Test: `tests/ext/update.test.ts`

**Interfaces:**
- Consumes: Task 6 (`prepareUpdate`), Task 5 (`AppPort.apply`, `save`), `ApplyError` (Task 4).
- Produces:
  - `interface JournalEntry { appId: string; repo: string; branch: string; target: string; backupBranch: string | null; total: number; startedAt: string }`
  - `interface UpdateJournal { get(appId: string): Promise<JournalEntry | null>; set(entry: JournalEntry): Promise<void>; clear(appId: string): Promise<void> }`
  - `backupBranchName(branch: string, at: Date): string` – `backup/<branch>-<JJJJMMTT-hhmm>` in Ortszeit
  - `interface UpdateResult { syncedSha: string; backupBranch: string | null; applied: number }`
  - `runUpdate(ports: FlowPorts, journal: UpdateJournal, input: UpdateInput, onProgress?: (text: string) => void): Promise<UpdateResult>`
  - `update-failed`: `detail: { done: ActionItem[]; failed: ActionItem; remaining: ActionItem[]; backupBranch: string | null }`, `message` = Engine-Meldung.

Ablauf `runUpdate`:
1. `prepareUpdate`. Keine Aktionen → kein Schreiben, keine Sicherung, kein `DoSave`; weiter mit Schritt 6.
2. `localChanges > 0` → Sicherung: Name nach `backupBranchName`, bei `name-exists` `-2`, `-3` … (höchstens 20 Versuche); `createBranch(repo, name, link.syncedSha)`; `commitFiles(repo, { branch: name, parentSha: link.syncedSha, message: "Backup before update to <sha7>", changes })` mit allen Unterschieden `local.files` gegen `baseTree` (gelöschte Pfade `content: null`). Fehler → werfen, nichts geschrieben.
3. `journal.set({ appId, repo, branch, target, backupBranch, total: actions.length, startedAt: now().toISOString() })`.
4. `app.apply(actions, …)`; `ApplyError` → `FlowError("update-failed", e.message, { done, failed, remaining, backupBranch })` (über `describeAction`); Journal bleibt stehen; `syncedSha` unverändert.
5. `app.save()`; `journal.clear(appId)`.
6. `onBranch` → `saveLink({ ...link, syncedSha: target })`, sonst bleibt `syncedSha`. Rückgabe.

Fortschrittstexte exakt: `Loading repository files… <done>/<total>`, `Saving backup…`, `Updating app… <done>/<total>`, `Saving app…`.

- [ ] **Step 1: Write the failing tests**

```ts
test("an update without local changes makes no backup and moves syncedSha to the target", async () => {
  // result.backupBranch null; app.snapshot equals the target state; app.link.syncedSha === head; app.saves === 1
});
test("local changes are saved to a backup branch before anything is written", async () => {
  const r = await runUpdate(ports, journal, input);
  expect(r.backupBranch).toBe("backup/main-20260102-0304"); // ports.now() = 2026-01-02T03:04:05Z, TZ=UTC in vitest config
  expect(github.messageOf("lr-bicc/sales", github.head("lr-bicc/sales", r.backupBranch!))).toBe("Backup before update to " + head.slice(0, 7));
  expect(github.filesAt("lr-bicc/sales", github.head("lr-bicc/sales", r.backupBranch!))).toEqual(localFilesBefore);
});
test("a second update in the same minute gets backup/main-20260102-0304-2", async () => {});
test("a failing backup leaves the app untouched", async () => { /* createBranch rejects → app.snapshot unchanged, journal empty */ });
test("a failure mid-way keeps syncedSha, keeps the journal and reports done and remaining", async () => {
  app.failApplyAt(1, "Access denied");
  const err = await runUpdate(ports, journal, input).catch((e) => e);
  expect(err).toMatchObject({ code: "update-failed", message: "Access denied" });
  expect(err.detail.done).toHaveLength(1); expect(err.detail.remaining.length).toBeGreaterThan(0);
  expect(app.link!.syncedSha).toBe(before); expect(app.saves).toBe(0);
  expect(await journal.get(APP_ID)).toMatchObject({ target: head, total: expect.any(Number) });
});
test("an update to a commit outside the branch keeps syncedSha", async () => { /* target on another branch → syncedSha unchanged */ });
test("an update to an older commit of the branch sets syncedSha to it", async () => {});
test("only the chosen parts are written", async () => { /* parts ["script"] → only setScript; other differences stay */ });
```

`vitest.config.ts` setzt `test.env.TZ = "UTC"`, damit Namen in Ortszeit stabil sind. `tests/ext/fake-ports.ts` erhält `memoryJournal(): UpdateJournal & { entries: Map<string, JournalEntry> }`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/ext/update.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `backupBranchName` and `runUpdate`**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ext`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(ext): run an update with backup branch and journal`

---

### Task 8: Unterschiede zweier Stände

**Files:**
- Create: `src/ext/flows/diff.ts`
- Test: `tests/ext/diff-flow.test.ts`

**Interfaces:**
- Consumes: Task 6 (`readLocal`), Task 2 (`readBlobs`).
- Produces:
  - `type DiffSide = { kind: "commit"; sha: string } | { kind: "app" }`
  - `interface DiffEntry { path: string; kind: ChangeKind; group: ObjectGroup; title: string }`
  - `interface DiffSource { repo: string; entries: DiffEntry[]; contents(path: string): Promise<{ before: FileContent | null; after: FileContent | null }> }`
  - `openDiff(ports: FlowPorts, repo: string, before: DiffSide, after: DiffSide, onProgress?): Promise<DiffSource>`

Regeln: Die App-Seite liest die App einmal (`readLocal`), Commit-Seiten über `getTree`. `entries` aus `diffTrees` (nur gepflegte Pfade). Titel aus dem Inhalt, der ohne Download vorliegt (App-Seite); für die übrigen Einträge werden die Inhalte der ersten 100 JSON- und `.qvs`-Einträge mit einem `readBlobs`-Aufruf geladen und für Titel und spätere `contents` vorgehalten; danach gilt der Dateiname. `contents` lädt fehlende Blobs einzeln nach und merkt sie sich. Beide Seiten gleich → `entries` leer.

- [ ] **Step 1: Write the failing tests**

```ts
test("commit against commit lists changed objects with their titles", async () => {
  const d = await openDiff(ports, repo, { kind: "commit", sha: c1 }, { kind: "commit", sha: c2 });
  expect(d.entries).toEqual([{ path: "objects/sheets/s1.json", kind: "changed", group: "sheets", title: "Overview" }]);
  expect(await d.contents("objects/sheets/s1.json")).toEqual({ before: textAt(c1), after: textAt(c2) });
});
test("commit against app reads the app once", async () => { /* app.reads === 1; added sheet in app has its title */ });
test("contents are downloaded once", async () => { /* two calls → blobReads unchanged after the first */ });
test("README and builds are never part of a diff", async () => {});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/ext/diff-flow.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `openDiff`**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ext/diff-flow.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(ext): differences between commits and the app`

---

### Task 9: Tags anlegen und Import

**Files:**
- Create: `src/ext/flows/tags.ts`, `src/ext/flows/import.ts`
- Test: `tests/ext/tags.test.ts`, `tests/ext/import.test.ts`

**Interfaces:**
- Consumes: Task 2 (`createTag`, `listTags`), Task 3 (`readmeTitle`), Task 5 (`ServerPort`), Task 6 (`loadTarget`).
- Produces:
  - `addTag(github: GitHubPort, input: { repo: string; sha: string; name: string; message: string }): Promise<void>` – Name getrimmt; ungültig nach `isValidRefName` → `FlowError("invalid-tag-name")`; vorhanden (vorab über `listTags` oder `GatewayError("name-exists")`) → `FlowError("tag-exists")`.
  - `interface ImportResult { appId: string; name: string; url: string }`
  - `importApp(deps: { github: GitHubPort; server: ServerPort }, input: { repo: string; sha: string; label: string }, onProgress?: (text: string) => void): Promise<ImportResult>`

Ablauf `importApp`: `loadTarget(github, repo, sha)` (ohne lokalen Stand) → `validateTarget`, Probleme → `invalid-target` (nichts angelegt); Name `"<readmeTitle(README bei sha) ?? Repo-Name ohne Org> (<label>)"`; `server.createApp(name)`; neuen Stand lesen (`app.read({ includeFiles: true })`, serialisieren und wieder deserialisieren wie in `prepareUpdate`), `planUpdate(current, target, new Set(["script", "objects", "files"]))`, `app.apply`, `app.save`, `close`. Fehler nach dem Anlegen → `FlowError("import-failed", message, { appId, url })`; die halbfertige App bleibt. Fortschritt: `Loading repository files… <d>/<t>`, `Creating app…`, `Writing app… <d>/<t>`, `Saving app…`.

- [ ] **Step 1: Write the failing tests**

```ts
test("addTag refuses an existing name and changes nothing", async () => {
  github.tag("lr-bicc/sales", "v1", sha);
  await expect(addTag(github, { repo, sha, name: "v1", message: "" })).rejects.toMatchObject({ code: "tag-exists" });
});
test("addTag refuses invalid names", async () => { /* "bad name", "a..b" → invalid-tag-name */ });
test("import creates a named app, fills it from the repository and saves it", async () => {
  const r = await importApp({ github, server }, { repo: "lr-bicc/sales", sha, label: "main" });
  expect(r.name).toBe("Sales 📈 (main)");
  expect(server.created[0].app.saves).toBe(1);
  expect(serialize(server.created[0].app.snapshot)).toEqual(maintainedFilesAt(sha)); // roundtrip without bookmarks
});
test("a broken target creates no app", async () => { /* invalid-target, server.created empty */ });
test("a failure after creating reports the incomplete app", async () => { /* import-failed with detail.appId */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/ext/tags.test.ts tests/ext/import.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `addTag` and `importApp`**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ext`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(ext): add tags and import an app from a repository`

---

### Task 10: Befehle, Journal, Sitzungsspeicher

**Files:**
- Create: `src/ext/content/journal.ts`
- Modify: `src/ext/shared/commands.ts`, `src/ext/content/router.ts`, `src/ext/content/content.ts`, `src/ext/background/sw.ts`, `tests/ext/fake-chrome.ts`
- Test: `tests/ext/router.test.ts`, `tests/ext/journal.test.ts`, `tests/ext/sw.test.ts`

**Interfaces:**
- Consumes: Tasks 6–9.
- Produces (in `Command`):
  - `{ cmd: "commits"; repo: string; branch: string; page: number }` → `CommitInfo[]`
  - `{ cmd: "tags"; repo: string }` → `TagInfo[]`
  - `{ cmd: "addTag"; repo: string; sha: string; name: string; message: string }` → `null`
  - `{ cmd: "updatePreview"; appId: string; target: string; parts: UpdatePart[] }` → `UpdatePreview`
  - `{ cmd: "update"; appId: string; target: string; parts: UpdatePart[] }` → `UpdateResult`
  - `{ cmd: "showDiff"; repo: string; before: DiffSide; after: DiffSide; select?: string; title: string }` → `null`
  - `{ cmd: "importApp"; repo: string; sha: string; label: string }` → `ImportResult`
  - `StatusView` (`page: "app"`) + `interruptedUpdate: JournalEntry | null`
  - `RouterDeps` + `journal: UpdateJournal`, `server(loc: QlikLocation): ServerPort`, `showDiff(source: DiffSource, opts: { select?: string; title: string }): void`
  - `createJournal(area: chrome.storage.StorageArea): UpdateJournal` – Schlüssel `update:<appId in Kleinbuchstaben>`
  - `sw.ts`: `chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })` beim Start.

Regeln im Router:
- `listRepos`, `listBranches`, `commits`, `tags`, `addTag`, `importApp` und `showDiff` mit zwei Commit-Seiten laufen auch ohne App (Hub). `showDiff` mit App-Seite und alle übrigen brauchen die App wie bisher.
- `updatePreview` und `update` nutzen eine frische Verknüpfung (`freshStatus`, `linked` nötig), `update` setzt danach `forget`.
- `status` liest zusätzlich `journal.get(appId)` und gibt es als `interruptedUpdate` mit.
- Fortschrittstexte der Abläufe gehen als `ProgressEvent` an das Panel.

- [ ] **Step 1: Write the failing tests**

```ts
test("commits, tags and import work on the hub", async () => {
  const router = createRouter(deps({ url: "https://q/qs/hub/my/work" }));
  expect(await router({ cmd: "tags", repo: "lr-bicc/sales" })).toMatchObject({ ok: true });
  expect(await router({ cmd: "updatePreview", appId: APP_ID, target: sha, parts: ["script"] })).toMatchObject({ ok: false, error: { code: "no-app" } });
});
test("status reports an interrupted update", async () => {
  await journal.set(entry);
  expect((await router({ cmd: "status" })).value).toMatchObject({ interruptedUpdate: entry });
});
test("update refuses a command for another app", async () => { /* app-changed */ });
test("showDiff opens the overlay with the selected path", async () => { /* deps.showDiff called with entries and { select, title } */ });
test("the journal lives in storage.session per app", async () => { /* createJournal(fake.session) set/get/clear */ });
test("the service worker lets content scripts use storage.session", async () => { /* fake records setAccessLevel */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/ext/router.test.ts tests/ext/journal.test.ts tests/ext/sw.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement; `fake-chrome` gets `storage.session` (with `setAccessLevel`, recorded in `sessionAccessLevels`)**

`content.ts`: `journal: createJournal(chrome.storage.session)`, `server: (loc) => createServerPort(loc, …)`, `showDiff: showDiffOverlay` (Task 11; bis dahin eine Funktion, die nichts tut, und Task 11 ersetzt sie).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ext`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(ext): commands for update, diff, tags and import`

---

### Task 11: Diff-Overlay in der Qlik-Seite

**Files:**
- Create: `src/ext/content/overlay/side-by-side.ts`, `src/ext/content/overlay/DiffOverlay.tsx`, `src/ext/content/overlay/show.ts`
- Modify: `src/ext/content/content.ts`, `src/ext/panel/changes-model.ts`
- Test: `tests/ext/side-by-side.test.ts`, `tests/ext/overlay.test.tsx`

**Interfaces:**
- Consumes: Task 8 (`DiffSource`, `DiffEntry`), `lineDiff` aus `src/core/diff.ts`.
- Produces:
  - `interface SideCell { text: string; kind: "same" | "added" | "removed" }`, `interface SideRow { left: SideCell | null; right: SideCell | null }`
  - `sideBySide(lines: LineChange[]): SideRow[]` – gleiche Zeilen stehen links und rechts; ein Block entfernter Zeilen und der direkt folgende Block hinzugefügter Zeilen werden zeilenweise gepaart, der Rest füllt mit `null` auf.
  - `sections` in `changes-model.ts` wird generisch: `sections<T extends { kind: ChangeKind; group: ObjectGroup; title: string; path: string }>(items: T[])`.
  - `showDiffOverlay(source: DiffSource, opts: { select?: string; title: string }): void` – ein `div#qommit-diff` am Ende von `document.body` mit `attachShadow({ mode: "open" })`; ein zweiter Aufruf ersetzt das vorhandene Overlay.

Oberfläche (Texte exakt): Kopf mit `opts.title` und Schaltfläche „Close“ (auch `Escape`). Links die Einträge, gruppiert wie Local Changes („Added objects“, „Deleted objects“, „Changed objects“ mit den Untergruppen), vorgewählt `opts.select` oder der erste Eintrag. Rechts zwei Spalten „Before“ und „After“ aus `sideBySide(lineDiff(before ?? "", after ?? ""))`; Binärinhalt (`Uint8Array`) zeigt „Binary file“ mit den Größen `<n> bytes` beider Seiten. Keine Einträge → „No differences“. Während `contents` lädt: „Loading…“; Fehler → Meldung über `errorText` aus dem Panel.

- [ ] **Step 1: Write the failing tests**

```ts
test("removed and added blocks are paired line by line", () => {
  expect(sideBySide([same("a"), removed("b"), removed("c"), added("B"), same("d")])).toEqual([
    { left: s("a"), right: s("a") }, { left: r("b"), right: ad("B") }, { left: r("c"), right: null }, { left: s("d"), right: s("d") },
  ]);
});
test("the overlay lists entries by group and shows the selected file side by side", async () => {
  showDiffOverlay(source, { select: "data_load_script/Main.qvs", title: "Local changes" });
  const root = document.getElementById("qommit-diff")!.shadowRoot!;
  expect(root.textContent).toContain("Changed objects");
  await waitFor(() => expect(root.querySelectorAll(".removed").length).toBe(1));
});
test("Close and Escape remove the overlay", async () => {});
test("a binary file shows its sizes", async () => { /* "Binary file", "2 bytes", "3 bytes" */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/ext/side-by-side.test.ts tests/ext/overlay.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement; styles inline in the shadow root (fixed, full viewport minus 24 px margin, `z-index: 2147483647`, monospace for code)**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ext && npm run build:ext`
Expected: PASS; `dist/ext/content.js` enthält das Overlay.

- [ ] **Step 5: Commit**

`feat(ext): diff overlay in the Qlik page`

---

### Task 12: Panel – Commit-Auswahl, Update, „details“

**Files:**
- Create: `src/ext/panel/CommitPicker.tsx`, `src/ext/panel/UpdateDialog.tsx`
- Modify: `src/ext/panel/LocalChangesTab.tsx`, `src/ext/panel/App.tsx`, `src/ext/panel/errors.ts`, `tests/ext/fake-bridge.ts`
- Test: `tests/ext/panel-update.test.tsx`, `tests/ext/panel-errors.test.ts`

**Interfaces:**
- Consumes: Task 10 (Befehle, `interruptedUpdate`), Task 6/7 (`UpdatePreview`, `UpdateResult`, `UpdatePart`).
- Produces:
  - `CommitPicker(props: { bridge; repo: string; branch: string; value: string; onChange(sha: string, label: string): void; disabled: boolean })` – oben eine Auswahl „Branch“ (aus `listBranches`, vorbelegt der Branch der App; so lassen sich auch Sicherungs-Branches `backup/…` wählen, Spec 6.6 Schritt 3), darunter die Liste aus `commits` des gewählten Branches (Seite 1, „Load more“) mit Tag-Badges aus `tags`; Suchfeld (Platzhalter „Search commits“) filtert nach Nachricht und SHA; je Eintrag erste Zeile der Nachricht und `toLocaleString()` des Datums; vorausgewählt der HEAD des Branches der App. Label: `<sha7>` auf dem eigenen Branch, sonst `<branch>@<sha7>`.
  - `UpdateDialog(props: DialogProps & { repo: string; target: { sha: string; label: string }; parts: UpdatePart[]; onUpdated(): void })`

Oberfläche Local Changes (nur wenn `!published && canWrite`; Texte exakt):
- Über der Liste: `CommitPicker`, daneben „Update“; bei `behindBy > 0` und gewähltem HEAD „Update (<n>)“. Daneben „▾“ (aria-label „Choose what to update“) öffnet Häkchen „Load script“, „App Objects“, „Attached files“, alle vorausgewählt; ohne Häkchen ist „Update“ gesperrt.
- `UpdateDialog`: Titel „Update Application from the repository?“; Zeile mit dem Commit (Link `https://github.com/<repo>/commit/<sha>`, Text `<sha7>` und `label`); während `updatePreview` „Preparing…“; dann „<create> to create, <change> to change, <delete> to delete“ und die aufklappbare Liste („Show details“) der `items` als `<kind>: <title>`; bei `localChanges > 0` der Hinweis „Your local changes will be saved to a backup branch first.“; Schaltflächen „Update“ und „Cancel“. Keine Aktionen → „The app already matches this state.“ und nur „Close“.
- Nach Erfolg zeigt die Schaltfläche „Success“, darunter bei Sicherung „Backup: <backupBranch>“ (Link `https://github.com/<repo>/tree/<branch>`), Schaltfläche „Close“; danach `onUpdated` → Panel lädt Status und Liste neu.
- `invalid-target`: „The selected state contains files that cannot be applied:“ und je Problem `<path> (<reason>)` als Link `https://github.com/<repo>/blob/<sha>/<path>`.
- `update-failed`: „The update stopped: <message>“, „Done: <n>“, „Not done: <m>“ (aufklappbar), bei Sicherung „Backup: <branch>“.
- Nachfrage vor einem Commit auf veralteten Stand: neue Standard-Schaltfläche „Update first“ öffnet den `UpdateDialog` auf den HEAD; „Commit anyway“ und „Cancel“ bleiben.
- Je Eintrag der Liste ein Link „details“ → `showDiff { repo, before: { kind: "commit", sha: baseSha }, after: { kind: "app" }, select: path, title: "Local changes" }`.
- `interruptedUpdate` im Status: Hinweis unter dem Kopf „The last update did not finish (<total> changes planned). Update again, or restore your work from <backupBranch>.“ (ohne Sicherung endet der Satz nach „Update again.“).
- `errors.ts`: `cannot-write` → „You have no permission to change this app.“, `tag-exists` → „Tag already exists.“, `invalid-tag-name` → „Invalid tag name.“, `import-failed` → „The import stopped. The new app was created but is incomplete.“, `invalid-target` → „The selected state contains files that cannot be applied.“, `update-failed` → „The update stopped.“ mit `detail: message`.

- [ ] **Step 1: Write the failing tests**

```ts
test("Update shows the preview and runs the update with the chosen parts", async () => {
  const bridge = fakeBridge({ status: [view({ ...LINKED, behindBy: 2 })], commits: [[c2, c1]], tags: [[]], localChanges: [noChanges, noChanges],
    updatePreview: [{ target: c2.sha, items: [{ kind: "change", group: "sheets", id: "s1", title: "Overview" }], summary: { create: 0, change: 1, delete: 0 }, localChanges: 0, onBranch: true }],
    update: [{ syncedSha: c2.sha, backupBranch: null, applied: 1 }] });
  render(<App bridge={bridge} />);
  fireEvent.click(await screen.findByText("Update (2)"));
  expect(await screen.findByText("0 to create, 1 to change, 0 to delete")).toBeTruthy();
  fireEvent.click(screen.getByText("Update"));
  expect(await screen.findByText("Success")).toBeTruthy();
  expect(bridge.commands.find((c) => c.cmd === "update")).toEqual({ cmd: "update", appId: APP_ID, target: c2.sha, parts: ["script", "objects", "files"] });
});
test("unticking App Objects sends only script and files", async () => {});
test("a failed update lists done and remaining work and the backup", async () => {});
test("the behind question offers Update first", async () => {});
test("details opens the diff overlay for that object", async () => {});
test("an interrupted update is reported under the header", async () => {});
test("published apps and apps without write permission show no Update", async () => {});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/ext/panel-update.test.tsx tests/ext/panel-errors.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ext`
Expected: PASS (die Tests aus Plan 2 eingeschlossen).

- [ ] **Step 5: Commit**

`feat(panel): commit picker, update dialog and details`

---

### Task 13: Panel – History-Aktionen, Tags, „Add tag“

**Files:**
- Create: `src/ext/panel/TagsTab.tsx`, `src/ext/panel/AddTagDialog.tsx`
- Modify: `src/ext/panel/HistoryTab.tsx`, `src/ext/panel/App.tsx`
- Test: `tests/ext/panel-history.test.tsx`

**Interfaces:**
- Consumes: Task 10 (`tags`, `addTag`, `showDiff`), Task 12 (`UpdateDialog`).
- Produces: `AddTagDialog(props: DialogProps & { repo: string; sha: string; onDone(): void })`, `TagsTab(props: { bridge; repo: string; canUpdate: boolean; onUpdate(target: { sha: string; label: string }): void })`.

Oberfläche (Texte exakt):
- Reiter in der Reihenfolge „Local Changes“, „History“, „Tags“, „Import“.
- History: je Commit Tag-Badges und die Schaltflächen „Diff to previous“ (gesperrt ohne Eltern; `showDiff` mit `parents[0]` → `sha`, Titel „<sha7> against its parent“), „Diff to app“ (`sha` → App, Titel „App against <sha7>“), „Add tag“, „Update app to this commit“ (nur bei `canUpdate`; öffnet `UpdateDialog` mit Label `<sha7>`).
- Tags: je Tag Name, Datum (`toLocaleString`, ohne Datum „–“), `<sha7>` als Link, Beschreibung (erste Zeile) und „Diff to app“ sowie bei `canUpdate` „Update app to this tag“ (Label = Tag-Name). Leer: „No tags“.
- `AddTagDialog`: Titel „Add tag to <sha7>“, Felder „Tag name“ und „Description (optional)“, Schaltflächen „Add tag“ und „Cancel“; Fehler im Dialog; nach Erfolg schließt er, History und Tags laden neu.
- In veröffentlichten Apps bleiben „Diff …“ und „Add tag“, „Update …“ fehlt.

- [ ] **Step 1: Write the failing tests**

```ts
test("history entries offer diff, tag and update actions", async () => {});
test("Diff to previous is disabled for the first commit", async () => {});
test("Add tag sends name and description and reloads the tags", async () => {
  // addTag { repo, sha, name: "v1.0", message: "Release" }; afterwards a second "tags" command
});
test("an existing tag name is reported in the dialog", async () => { /* "Tag already exists." */ });
test("the Tags tab lists tags and updates the app to a tag", async () => { /* UpdateDialog with label "v1.0" */ });
test("a published app has no update actions", async () => {});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/ext/panel-history.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ext`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(panel): history actions, tags tab and add tag`

---

### Task 14: Panel – Import

**Files:**
- Create: `src/ext/panel/ImportTab.tsx`
- Modify: `src/ext/panel/App.tsx`, `src/ext/panel/ConnectDialog.tsx` (Repo-Liste als eigene Komponente `RepoList` herauslösen)
- Test: `tests/ext/panel-import.test.tsx`

**Interfaces:**
- Consumes: Task 10 (`listRepos`, `listBranches`, `commits`, `tags`, `importApp`).
- Produces: `ImportTab(props: { bridge: Bridge })`; `RepoList(props: { bridge; value: string | null; onChange(repo: string): void })` aus dem Connect-Dialog (Filterfeld, „Show all repositories“).

Oberfläche (Texte exakt): Im Hub zeigt das Panel unter „Open an app to use Qommit.“ den Reiter-Inhalt „Import“ direkt; in einer App ist es der Reiter „Import“. Schritte: „Repository“ (`RepoList`), „Branch“ (Auswahl, vorbelegt Default-Branch), „State“ mit den Optionen „Latest commit“, „Commit“ (Liste aus `commits`), „Tag“ (Liste aus `tags`); Schaltfläche „Import“. Label: Branch-Name, Tag-Name oder `<sha7>`. Danach „Created <name>“ und Link „Open app“ (`url`, neues Fenster). Hinweis darunter: „The new app is not linked. Open it to connect it or create a branch.“ Fehler über `errorText`; `import-failed` nennt zusätzlich den Link „Open the incomplete app“.

- [ ] **Step 1: Write the failing tests**

```ts
test("import from the latest commit of a branch", async () => {
  // importApp { repo: "lr-bicc/sales", sha: head, label: "main" } → "Created Sales (main)" and link "Open app"
});
test("import from a tag uses the tag name as label", async () => {});
test("the hub shows the import", async () => { /* status { page: "hub" } → "Repository" visible */ });
test("an incomplete import links the app", async () => {});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/ext/panel-import.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ext`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(panel): import an app from a repository`

---

### Task 15: Zusammenspiel, Spec und Abnahme

**Files:**
- Modify: `tests/integration/extension-flow.test.ts`, `docs/superpowers/specs/2026-11-10-qlik-github-versioning-design.md`
- Create: `docs/superpowers/acceptance/plan-3-checklist.md`

**Interfaces:**
- Consumes: alles Vorige.

- [ ] **Step 1: Write the integration tests (gateway with mocked fetch, router, fake engine)**

```ts
test("copy behind main: update to the head, then no local changes and no new commits", async () => {});
test("local changes survive an update on a backup branch and come back by updating to it", async () => {
  // update to head → backup branch; update to backup head (outside the branch) → app equals the earlier state, syncedSha unchanged
});
test("import of a repository state and serialising the new app gives the same files (bookmarks excepted)", async () => {});
```

- [ ] **Step 2: Run them**

Run: `npx vitest run tests/integration`
Expected: PASS (die Abläufe stehen; scheitert ein Test, liegt der Fehler in einem Task davor und wird dort behoben).

- [ ] **Step 3: Spec Revision 12**

Kopfzeilen auf Revision 12 und neuer Abschnitt „14. Änderungen in Revision 12 (aus der Umsetzung von Plan 3)“ mit je einer Zeile:
- 6.6: Zielstand als einzelne Blobs, nur gepflegte Dateien, nur die vom App-Stand abweichenden (statt ZIP; `builds/` wird so nie geladen).
- 6.6: Vorschau und Update lesen die App je einmal; das Update plant mit dem frischen Stand neu.
- 6.6: Zielvariable auf dem Namen einer Skript-Variablen → Update startet nicht (`variable-name-taken`); Namenstausch über Zwischennamen.
- 6.6, 7: Schreibrecht aus `permissions.update` des App-Layouts; Journal in `chrome.storage.session`, Hinweis „The last update did not finish …“.
- 6.6: Keine Sicherung, wenn das Update nichts ändert.
- 6.8: Tag-Datum: Datum des Taggers, bei leichtgewichtigen Tags Commit-Datum.
- 6.9: App-Name aus dem Titel der README, sonst Repo-Name.
- 10: „Mehrdeutige Zuordnung einer App (eine App in zwei Branch-Tabellen) anzeigen“ als offener Punkt.

Abschnitt 6.6 Schritt 1 und Abschnitt 9 („Für Plan 3“) entsprechend anpassen.

- [ ] **Step 4: Abnahme-Checkliste `docs/superpowers/acceptance/plan-3-checklist.md`**

Aufbau wie `plan-2-checklist.md` (Vorbereitung: Extension neu laden; Testserver `qlik.example.com`). Punkte, je mit „Erwartet:“:
1. Kopie einer versionierten App, die hinter `main` steht: „Update (N)“ → Vorschau → Update → „Success“; danach „No local changes“, kein Hinweis auf neue Commits.
2. Dieselbe Kopie mit einer lokalen Änderung (ein Sheet umbenennen) auf einen älteren Commit aktualisieren: Sicherungs-Branch `backup/<branch>-…` auf GitHub mit dem Commit „Backup before update to …“; Panel meldet „Repository has N new commits“.
3. In der Commit-Auswahl den Sicherungs-Branch wählen und auf seinen Commit aktualisieren. Erwartet: Das umbenannte Sheet ist zurück; es erscheint als lokale Änderung, weil der Sicherungs-Branch nicht auf dem Branch der App liegt (`syncedSha` bleibt).
4. Nur „Load script“ übernehmen: Objekte bleiben, das Skript entspricht dem Ziel; danach Daten neu laden und prüfen, dass die App ihre Daten nach dem `DoSave` behält (Spike-Frage 7, Skriptteil).
5. Tag „acceptance-1“ mit Beschreibung auf einen Commit setzen; im Reiter „Tags“ sichtbar, auf GitHub als annotiertes Tag; derselbe Name noch einmal → „Tag already exists.“
6. „Update app to this tag“: `syncedSha` bleibt (Prüfung über die Engine), der Stand erscheint als lokale Änderung, falls das Tag nicht auf dem Branch liegt.
7. „details“, „Diff to previous“, „Diff to app“: Overlay mit Liste und Gegenüberstellung; Skript zeilenweise; „Close“ und Escape schließen.
8. Import von „Sales Overview“ (`main`) im Hub: neue App „Sales Overview (main)“ ohne Daten; mit „Connect to existing repository“ → „To existing branch“ `main` verbinden → „No local changes“ außer Bookmarks (Erfolgskriterium 4). Danach Unlink und App löschen.
9. Story mit Snapshots (falls eine App mit Story vorliegt): Import und Vergleich (Spike-Frage 6).
10. Abgebrochenes Update: während eines Updates den Tab neu laden → Hinweis „The last update did not finish …“; erneutes Update entfernt ihn.
11. Veröffentlichte App: kein „Update“, keine „Update …“-Aktionen; „Diff to app“ und „Add tag“ vorhanden.
12. Ende zu Ende (Erfolgskriterium 2): Kopie → Create Branch → ändern → Save changes → PR auf GitHub mergen → in der QMC „Publish and replace“ → veröffentlichte App zeigt „Published from commit“ mit dem Merge-Commit und „No local changes“.
13. Rückmeldung: Dauer von Vorschau und Update bei „Sales Overview“, Fehlermeldungen im Wortlaut.

- [ ] **Step 5: Full check and build**

Run: `npm test && npm run typecheck && npm run build:ext`
Expected: alle Tests grün, Typecheck ohne Fehler, `dist/ext` gebaut.

- [ ] **Step 6: Commit**

`docs: spec revision 12 and plan 3 acceptance checklist`

- [ ] **Step 7 (Mensch):** Rumen führt die Checkliste gegen den Testserver aus und meldet das Ergebnis.
