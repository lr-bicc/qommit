# Qommit – Plan 1 von 2: Spike und Kernbibliothek

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Annahmen über den Qlik-Server mit einem Wegwerf-Spike klären und die browserunabhängige Kernbibliothek (Repo-Format, Diff, Update-Planung, GitHub-Client) vollständig getestet liefern.

**Architecture:** Zwei Verzeichnisse ohne Abhängigkeit auf Chrome-APIs: `src/core/` (reine Funktionen über `AppSnapshot` und `FileMap`) und `src/github/` (GitHub-Client über ein injiziertes `fetch`). Der Spike liegt getrennt in `spike/` und wird nicht in das Produkt übernommen. Die Extension selbst (Side Panel, Service Worker, Content Script, Engine-Adapter, Abläufe) folgt in Plan 2, der nach den Spike-Ergebnissen geschrieben wird.

**Tech Stack:** TypeScript (strict), Node 22, Vitest, `diff` (jsdiff), `fflate`, esbuild (nur Spike), enigma.js (nur Spike).

**Spec:** `docs/superpowers/specs/2026-11-10-qlik-github-versioning-design.md` (Revision 8)

## Global Constraints

- Sprache: Code, Bezeichner, Kommentare, Fehlermeldungen und alle UI-Texte auf Englisch.
- `src/core/` und `src/github/` verwenden keine `chrome.*`-APIs und kein DOM; sie laufen unter Node 22 und im Browser.
- Der GitHub-Token wird dem Client übergeben, nie geloggt und erscheint in keiner Fehlermeldung.
- JSON-Dateien im Repo: `JSON.stringify(value, null, 2)`, Schlüsselreihenfolge unverändert, Zeilenenden `\n`, kein abschließender Zeilenumbruch.
- Repo-Pfade exakt wie in Spec 4.2: `data_load_script/<Tab>.qvs`, `data_load_script/tab_order.txt`, `objects/appprops.json`, `objects/{variables,dimensions,measures,masterobjects,sheets,stories,bookmarks}/<qId>.json`, `appcontent/<Dateiname>`.
- `loadScript.qvs`, `objects/fields.json`, `objects/themes.json`, `objects/glossarylinks.json`, `builds/` und `README.md` werden von Serializer und Diff nicht geschrieben und nicht als Änderung gemeldet.
- Trenner in `tab_order.txt`: `%tab_file_order_divider%`.
- Variablen mit `qIsScriptCreated: true` werden nie serialisiert und nie von einem Update gelöscht oder geändert.
- Bookmarks werden serialisiert, aber nie in eine App zurückgeschrieben.
- Objekt-IDs (`qInfo.qId`) bleiben unverändert.
- Commit-Nachrichten im Projekt: Conventional Commits (`feat:`, `test:`, `chore:`, `docs:`). Jeder Commit-Schritt bedeutet `git add -A && git commit -m "<Nachricht>"`.

## Review Focus

1. **Bestehendes gitoqlok-Repo als Vergleichsbasis:** Der Basis-Tree enthält `README.md`, `loadScript.qvs`, `objects/fields.json`, `builds/x.qvf`. Erwartet: Sie erscheinen nicht als „deleted“. → Test in Task 6.
2. **Skripterzeugte Variablen in der App, nicht im Zielstand:** Erwartet: Das Update lässt sie unangetastet. → Test in Task 8.
3. **Tab-Namen, die nach dem Ersetzen ungültiger Zeichen gleich lauten, oder doppelte Tab-Namen:** Erwartet: getrennte Dateien, verlustfreies Zusammensetzen. → Test in Task 4.
4. **App-Namen ohne lateinische Zeichen (z. B. kyrillisch):** Erwartet: ein gültiger, nicht leerer Repo-Name. → Test in Task 9.
5. **Branch-Tabelle, wie gitoqlok sie hinterlässt:** doppelte Zeilen, URLs mit und ohne Virtual-Proxy-Präfix, Host ohne Domain, fehlende Tabelle. Erwartet: korrektes Lesen, beim Schreiben genau eine Zeile pro Branch. → Test in Task 9.

## Dateistruktur

```
package.json  tsconfig.json  vitest.config.ts  .gitignore
src/core/types.ts             AppSnapshot, FileMap, PropertyTree, GenericProps
src/core/script-tabs.ts       Ladeskript ↔ Tab-Dateien
src/core/serializer.ts        AppSnapshot → FileMap
src/core/deserializer.ts      FileMap → AppSnapshot
src/core/target-validator.ts  Prüfung eines Zielstands vor dem Update
src/core/git-hash.ts          Git-Blob-SHA
src/core/diff.ts              Tree-Vergleich, Gruppen, Titel, Zeilen-Diff
src/core/update-planner.ts    Aktionsliste für Update und Import
src/core/repo-layout.ts       Repo-Name, README, Branch-Tabelle
src/github/errors.ts          GitHubError und Zuordnung
src/github/client.ts          fetch-Wrapper (REST, GraphQL)
src/github/repo.ts            Branches, Trees, Commits, Tags, Vergleich
src/github/snapshot.ts        ZIP-Abruf, Repo anlegen, Repo zu App finden
tests/fixtures/snapshot.ts    synthetische Test-App
tests/core/*.test.ts  tests/github/*.test.ts
spike/                        Wegwerf-Extension (nicht Teil des Produkts)
docs/superpowers/spike/RUNBOOK.md  results.md
```

---

### Task 1: Projektgerüst, Typen und Fixture

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/core/types.ts`, `tests/fixtures/snapshot.ts`, `tests/core/types.test.ts`

**Interfaces:**
- Produces (`src/core/types.ts`):

```ts
export type FileContent = string | Uint8Array;          // Text als string, appcontent als Bytes
export type FileMap = Map<string, FileContent>;         // Repo-Pfad → Inhalt
export interface GenericProps { qInfo: { qId: string; qType: string }; [key: string]: unknown }
export interface PropertyTree { qProperty: GenericProps; qChildren: PropertyTree[] }
export interface AppSnapshot {
  appId: string;
  script: string;
  appProps: PropertyTree[];
  variables: GenericProps[];
  dimensions: GenericProps[];
  measures: GenericProps[];
  masterObjects: PropertyTree[];
  sheets: PropertyTree[];
  stories: PropertyTree[];
  bookmarks: GenericProps[];
  staticFiles: Map<string, Uint8Array>;                 // Dateiname → Bytes
}
```

- Produces (`tests/fixtures/snapshot.ts`): `APP_ID`, `CANON_ID`, `makeSnapshot(): AppSnapshot`

- [ ] **Step 1: Gerüst anlegen.** `package.json` mit `"type": "module"`, `"private": true`, Scripts `"test": "vitest run"`, `"typecheck": "tsc --noEmit"`. Installieren: `npm install diff fflate` und `npm install -D typescript vitest esbuild enigma.js @types/node`. `tsconfig.json`: `strict`, `target`/`lib` ES2022 + DOM, `module`/`moduleResolution` `ESNext`/`Bundler`, `include: ["src","tests"]`. `vitest.config.ts`: Umgebung `node`, Tests unter `tests/**/*.test.ts`. `.gitignore`: `node_modules`, `dist`, `spike/dist`.

- [ ] **Step 2: `src/core/types.ts` wie oben anlegen.**

- [ ] **Step 3: Fixture `tests/fixtures/snapshot.ts` anlegen.**

```ts
import type { AppSnapshot } from "../../src/core/types";
export const APP_ID = "11111111-1111-4111-8111-111111111111";
export const CANON_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export function makeSnapshot(): AppSnapshot {
  return {
    appId: APP_ID,
    script: "///$tab Main\r\nSET a=1;\r\n///$tab Load / Data\r\nLOAD * INLINE [x];\r\n",
    appProps: [{ qProperty: { qInfo: { qId: "appprops-1", qType: "appprops" }, theme: "t" }, qChildren: [] }],
    variables: [
      { qInfo: { qId: "var-1", qType: "variable" }, qName: "vUser", qDefinition: "1" },
      { qInfo: { qId: "var-2", qType: "variable" }, qName: "vToday", qDefinition: "01.01.2026", qIsScriptCreated: true },
    ],
    dimensions: [{ qInfo: { qId: "dim-1", qType: "dimension" }, qDim: { qFieldDefs: ["Country"] }, qMetaDef: { title: "Country" } }],
    measures: [{ qInfo: { qId: "mes-1", qType: "measure" }, qMeasure: { qDef: "Sum(Sales)" }, qMetaDef: { title: "Sales" } }],
    masterObjects: [{ qProperty: { qInfo: { qId: "mo-1", qType: "masterobject" }, qMetaDef: { title: "KPI" } }, qChildren: [] }],
    sheets: [{
      qProperty: { qInfo: { qId: "sh-1", qType: "sheet" }, qMetaDef: { title: "Overview" },
        thumbnail: { qStaticContentUrlDef: { qUrl: `/appcontent/${APP_ID}/logo.png` } } },
      qChildren: [{ qProperty: { qInfo: { qId: "obj-1", qType: "barchart" } }, qChildren: [] }],
    }],
    stories: [],
    bookmarks: [{ qInfo: { qId: "bm-1", qType: "bookmark" }, qMetaDef: { title: "Germany" } }],
    staticFiles: new Map([["logo.png", new Uint8Array([137, 80, 78, 71])]]),
  };
}
```

- [ ] **Step 4: Rauchtest `tests/core/types.test.ts`.**

```ts
import { makeSnapshot, APP_ID } from "../fixtures/snapshot";
test("fixture is a fresh object each call", () => {
  const a = makeSnapshot(); a.variables.pop();
  expect(makeSnapshot().variables).toHaveLength(2);
  expect(makeSnapshot().appId).toBe(APP_ID);
});
```

- [ ] **Step 5: Prüfen.** Run: `npm test && npm run typecheck` · Expected: 1 Test PASS, keine Typfehler.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "chore: project scaffold, core types and test fixture"`

---

### Task 2: Spike gegen den Testserver

Wegwerf-Code. Ergebnis ist `docs/superpowers/spike/results.md`, nicht der Code. Der Spike braucht den Qlik-Testserver und wird von Rumen im eigenen Chrome ausgeführt; die Tasks 3–12 hängen nicht davon ab und laufen parallel weiter.

**Files:**
- Create: `spike/manifest.json`, `spike/src/content.ts`, `spike/src/probes.ts`, `spike/build.mjs`
- Create: `docs/superpowers/spike/RUNBOOK.md`, später `docs/superpowers/spike/results.md`

**Interfaces:**
- Produces: JSON-Bericht `{ server, appId, startedAt, probes: [{ id, question, ok, detail, evidence }] }`, heruntergeladen als `spike-report-<timestamp>.json`.

- [ ] **Step 1: Extension-Hülle.** `spike/manifest.json` (Manifest V3, Name „Qommit Spike“, `content_scripts` für `https://qlik.example.com/*`, `js: ["dist/content.js"]`, `run_at: document_idle`, keine weiteren Berechtigungen). `spike/build.mjs` bündelt `spike/src/content.ts` mit esbuild nach `spike/dist/content.js` (IIFE). Das Content Script blendet auf App-Seiten (`/sense/app/<id>`) unten links einen Button „Run spike probes“ ein, der `runProbes()` ausführt und den Bericht als Datei herunterlädt.

- [ ] **Step 2: Probes in `spike/src/probes.ts`.** Jede Probe fängt Fehler ab und schreibt `ok`, `detail` und `evidence`. Alle angelegten Objekte tragen IDs mit Präfix `spike-` und werden am Ende wieder gelöscht. URL-Bestandteile (Host, Virtual-Proxy-Präfix, App-ID) werden aus `location` abgeleitet.

| ID | Frage (Spec Abschnitt 9) | Vorgehen | `evidence` |
|---|---|---|---|
| P11 | CSRF-Token | `GET /<präfix>/qps/csrftoken`; Status und Antwort-Header `qlik-csrf-token` lesen | Status, ob Header vorhanden |
| P1 | WebSocket aus dem Content Script | enigma.js-Session auf `wss://<host>/<präfix>/app/<id>` öffnen, mit Token aus P11 als Query-Parameter `qlik-csrf-token`, falls vorhanden; `OpenDoc`, `GetAppProperties` | `qSessionState`, App-Titel |
| P4 | Stabiles Lesen | Für alle Sheets zweimal `GetFullPropertyTree`, für alle Measures zweimal `GetProperties`; `JSON.stringify(x, null, 2)` beider Durchläufe vergleichen | Anzahl Objekte, Anzahl Abweichungen, erster abweichender Pfad |
| P2 | Anlegen mit vorgegebener `qId` | `CreateDimension`, `CreateMeasure`, `CreateObject` (Typ `masterobject`), `CreateObject` (Typ `sheet`) jeweils mit `qInfo.qId = "spike-…"`; danach per `GetObject`/`GetDimension`/`GetMeasure` zurücklesen; anschließend `Destroy…` | je Typ: zurückgelesene ID |
| P3 | Link-Objekt | Prüfen, ob ein Objekt mit `qId: "spike-qommit-link"` existiert; wenn nicht, `CreateObject` mit `qInfo: { qId: "spike-qommit-link", qType: "qommit-link" }` und Feld `link: { probe: true }`. **Nicht** löschen und kein `DoSave` davor (P7 läuft als letzte Probe). | `existedBefore` (true/false), ob in `GetAllInfos` enthalten |
| P5 | Statische Dateien | App-Inhaltsbibliothek per `GetContentLibraries`/`GetLibraryContent` auflisten; erste Datei per `GET /<präfix>/appcontent/<id>/<name>` laden; Upload `POST /<präfix>/qrs/appcontent/<id>/uploadfile?externalpath=spike-probe.txt&overwrite=true&xrfkey=<16 Zeichen>` mit Header `X-Qlik-Xrfkey`; Löschen `DELETE /<präfix>/qrs/appcontent/<id>/deletecontent?externalpath=spike-probe.txt&xrfkey=…` | Anzahl Dateien, Status je Aufruf |
| P6 | Stories | Anzahl Objekte vom Typ `story`; falls vorhanden: `GetFullPropertyTree` der ersten Story, Größe in Bytes, ob `qEmbeddedSnapshotDef` vorkommt | Anzahl, Größe, Fundstellen |
| P7 | `DoSave` und Daten (läuft zuletzt) | Summe `qNoOfRows` aller Tabellen aus `GetTablesAndKeys`; `DoSave`; Summe erneut | Zeilen vorher/nachher |
| P10 | `gitoqlikMetadata` | `GetAllInfos`: Liste der `qType`-Werte mit Anzahl; alle Variablen, App-Properties und alle Objekte unbekannter Typen nach den Zeichenfolgen `gitoqlik`, `lastCommitId`, `branchNamesTable` durchsuchen | Fundort (Objekttyp, ID, Eigenschaftspfad) oder „not found“ |
| P8 | Skript veröffentlichter Apps | nur wenn `published === true`: `GetScript` | Länge oder Fehlermeldung |

- [ ] **Step 3: Runbook `docs/superpowers/spike/RUNBOOK.md` schreiben.** Inhalt, in dieser Reihenfolge:
  1. `node spike/build.mjs`, dann `chrome://extensions` → Entwicklermodus → „Entpackte Erweiterung laden“ → Ordner `spike/`.
  2. Eine veröffentlichte, mit gitoqlok versionierte App im Hub duplizieren (z. B. „Sales Overview“), Kopie öffnen, „Run spike probes“ klicken, Bericht speichern (**Bericht A**).
  3. Seite der ersten Kopie neu laden und Probes erneut ausführen (**Bericht A2**): `existedBefore` zeigt, ob das Link-Objekt ohne eigenes Speichern erhalten blieb. Dann die Kopie im Hub duplizieren, zweite Kopie öffnen, Probes ausführen (**Bericht B**): `existedBefore` zeigt, ob das Link-Objekt mitkopiert wurde.
  4. Eine Wegwerf-App in einen Test-Stream veröffentlichen, dann die erste Kopie in der QMC per „Publish and replace“ darüberlegen, die veröffentlichte App öffnen, Probes ausführen (**Bericht C**). `existedBefore` beantwortet Frage 9 (Link-Objekt nach „Publish and replace“); P8 beantwortet Frage 8.
  5. Im Hub prüfen, ob das Objekt `spike-qommit-link` irgendwo in der Oberfläche sichtbar ist (Sheets, Master Items, Bookmarks).
  6. Kopien und Wegwerf-App löschen, Extension entfernen, die Berichte A, A2, B und C übergeben.

- [ ] **Step 4: Build prüfen.** Run: `node spike/build.mjs && test -s spike/dist/content.js && echo OK` · Expected: `OK`

- [ ] **Step 5: Commit.** `git add -A && git commit -m "chore: throwaway spike extension and runbook"`

- [ ] **Step 6 (Mensch, Gate für Plan 2): Spike ausführen.** Rumen folgt dem Runbook und liefert die Berichte A, A2, B und C.

- [ ] **Step 7: `docs/superpowers/spike/results.md` schreiben.** Je Frage 1–11 aus Spec Abschnitt 9: Antwort (ja/nein/teilweise), Beleg aus den Berichten, Folge für die Spec. Negative Antworten werden vor Plan 2 in die Spec eingearbeitet. Commit: `docs: spike results`.

---

### Task 3: Git-Blob-Hash

**Files:**
- Create: `src/core/git-hash.ts` · Test: `tests/core/git-hash.test.ts`

**Interfaces:**
- Produces: `gitBlobSha(content: FileContent): Promise<string>` (40 Hex-Zeichen, identisch mit `git hash-object`)

- [ ] **Step 1: Failing test.**

```ts
import { gitBlobSha } from "../../src/core/git-hash";
test("matches git hash-object", async () => {
  expect(await gitBlobSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  expect(await gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  expect(await gitBlobSha(new TextEncoder().encode("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
});
test("uses UTF-8 byte length for non-ASCII text", async () => {
  expect(await gitBlobSha("Umsätze")).toBe(await gitBlobSha(new TextEncoder().encode("Umsätze")));
  expect(await gitBlobSha("Umsätze")).not.toBe(await gitBlobSha("Umsatze"));
});
```

- [ ] **Step 2:** Run: `npx vitest run tests/core/git-hash.test.ts` · Expected: FAIL (Modul fehlt)
- [ ] **Step 3: Implementieren.** SHA-1 über `"blob " + byteLength + "\0"` + Bytes mit `crypto.subtle.digest`.
- [ ] **Step 4:** Run: wie Step 2 · Expected: PASS
- [ ] **Step 5: Commit.** `feat: git blob hash`

---

### Task 4: Skript-Tabs

**Files:**
- Create: `src/core/script-tabs.ts` · Test: `tests/core/script-tabs.test.ts`

**Interfaces:**
- Produces:

```ts
export const TAB_ORDER_PATH = "data_load_script/tab_order.txt";
export const TAB_DIVIDER = "%tab_file_order_divider%";
export interface ScriptTab { name: string; content: string }   // content beginnt mit der Zeile "///$tab <name>"
export function splitScript(script: string): ScriptTab[];
export function joinScript(tabs: ScriptTab[], eol: "\r\n" | "\n"): string;
export function scriptToFiles(script: string): Map<string, string>;   // Tab-Dateien + tab_order.txt
export function filesToScript(files: Map<string, FileContent>): string; // wirft Error bei fehlender Tab-Datei
```

Regeln (aus dem Referenz-Repo abgeleitet):
- Getrennt wird an jedem Zeilenanfang `///$tab `. Der Zeilenumbruch **vor** einem Tab-Marker gehört zu keinem Tab; `joinScript` setzt ihn wieder ein. `eol` ist `\r\n`, wenn das Skript `\r\n` enthält, sonst `\n`.
- Text vor dem ersten Marker wird ein Tab mit `name: "Main"` und unverändertem Inhalt.
- Dateiname: Tab-Name, darin jedes der Zeichen `\ / : * ? " < > |` durch ein Leerzeichen ersetzt, plus `.qvs`. Ergibt das einen schon vergebenen Namen (Groß-/Kleinschreibung ignoriert), wird ` (2)`, ` (3)` … angehängt.
- `tab_order.txt` enthält die Dateinamen ohne `.qvs` in Reihenfolge, verbunden mit `TAB_DIVIDER`. Leeres Skript → `tab_order.txt` mit leerem Inhalt, keine Tab-Dateien.
- `filesToScript` liest `tab_order.txt`, lädt die Dateien in dieser Reihenfolge und verbindet sie mit dem `eol`, das in der ersten Tab-Datei vorkommt (Default `\r\n`). Fehlt `tab_order.txt`, ist das Ergebnis `""`.

- [ ] **Step 1: Failing tests.**

```ts
import { splitScript, scriptToFiles, filesToScript, TAB_ORDER_PATH } from "../../src/core/script-tabs";
import { makeSnapshot } from "../fixtures/snapshot";
const script = makeSnapshot().script;

test("splits at tab markers and drops the line break before a marker", () => {
  expect(splitScript(script)).toEqual([
    { name: "Main", content: "///$tab Main\r\nSET a=1;" },
    { name: "Load / Data", content: "///$tab Load / Data\r\nLOAD * INLINE [x];\r\n" },
  ]);
});
test("writes one file per tab and the order file", () => {
  const files = scriptToFiles(script);
  expect([...files.keys()].sort()).toEqual([
    "data_load_script/Load   Data.qvs", "data_load_script/Main.qvs", TAB_ORDER_PATH]);
  expect(files.get(TAB_ORDER_PATH)).toBe("Main%tab_file_order_divider%Load   Data");
});
test("round-trips CRLF and LF scripts exactly", () => {
  expect(filesToScript(scriptToFiles(script))).toBe(script);
  const lf = script.replaceAll("\r\n", "\n");
  expect(filesToScript(scriptToFiles(lf))).toBe(lf);
});
test("keeps tabs apart whose names collide after sanitizing", () => {
  const s = "///$tab A/B\r\n1;\r\n///$tab A B\r\n2;\r\n///$tab a b\r\n3;";
  const files = scriptToFiles(s);
  expect(files.get(TAB_ORDER_PATH)).toBe(["A B", "A B (2)", "a b (3)"].join("%tab_file_order_divider%"));
  expect(filesToScript(files)).toBe(s);
});
test("empty script and missing files", () => {
  expect([...scriptToFiles("").entries()]).toEqual([[TAB_ORDER_PATH, ""]]);
  expect(filesToScript(new Map())).toBe("");
  expect(() => filesToScript(new Map([[TAB_ORDER_PATH, "Main"]]))).toThrow(/Main\.qvs/);
});
```

- [ ] **Step 2:** Run: `npx vitest run tests/core/script-tabs.test.ts` · Expected: FAIL
- [ ] **Step 3: Implementieren** nach den Regeln oben.
- [ ] **Step 4:** Run: wie Step 2 · Expected: PASS
- [ ] **Step 5: Commit.** `feat: split load script into tab files and back`

---

### Task 5: Serializer und Deserializer

**Files:**
- Create: `src/core/serializer.ts`, `src/core/deserializer.ts` · Test: `tests/core/serializer.test.ts`

**Interfaces:**
- Consumes: `scriptToFiles`, `filesToScript` (Task 4), Typen (Task 1)
- Produces:

```ts
export function toJson(value: unknown): string;                       // JSON.stringify(value, null, 2)
export function serializeApp(snap: AppSnapshot, opts: { canonicalAppId: string }): FileMap;
export function deserializeApp(files: FileMap, opts: { targetAppId: string; knownAppIds: string[] }): AppSnapshot;
```

Regeln:
- Pfade nach Global Constraints. `appprops.json` ist das Array `snap.appProps`. Variablen, Dimensionen, Measures, Bookmarks: je Objekt eine Datei mit den Eigenschaften. Master-Objekte, Sheets, Stories: je Objekt eine Datei mit dem `PropertyTree`.
- Ausgelassen werden Variablen mit `qIsScriptCreated === true` oder `qIsReserved === true`.
- Im Text jeder Objektdatei wird `/appcontent/<snap.appId>/` durch `/appcontent/<canonicalAppId>/` ersetzt.
- `deserializeApp` kehrt das um: `/appcontent/<id>/` wird für jede `id` aus `knownAppIds` durch `/appcontent/<targetAppId>/` ersetzt; `appId` des Ergebnisses ist `targetAppId`. Dateien außerhalb der gepflegten Pfade werden ignoriert. Listen sind nach Pfad sortiert.

- [ ] **Step 1: Failing tests.**

```ts
import { serializeApp } from "../../src/core/serializer";
import { deserializeApp } from "../../src/core/deserializer";
import { makeSnapshot, APP_ID, CANON_ID } from "../fixtures/snapshot";

test("writes exactly the maintained files", () => {
  const files = serializeApp(makeSnapshot(), { canonicalAppId: CANON_ID });
  expect([...files.keys()].sort()).toEqual([
    "appcontent/logo.png",
    "data_load_script/Load   Data.qvs", "data_load_script/Main.qvs", "data_load_script/tab_order.txt",
    "objects/appprops.json", "objects/bookmarks/bm-1.json", "objects/dimensions/dim-1.json",
    "objects/masterobjects/mo-1.json", "objects/measures/mes-1.json", "objects/sheets/sh-1.json",
    "objects/variables/var-1.json",
  ]);
});
test("formats JSON like gitoqlok", () => {
  const files = serializeApp(makeSnapshot(), { canonicalAppId: CANON_ID });
  expect(files.get("objects/variables/var-1.json")).toBe(
    '{\n  "qInfo": {\n    "qId": "var-1",\n    "qType": "variable"\n  },\n  "qName": "vUser",\n  "qDefinition": "1"\n}');
});
test("normalizes the app id in content URLs both ways", () => {
  const files = serializeApp(makeSnapshot(), { canonicalAppId: CANON_ID });
  const sheet = files.get("objects/sheets/sh-1.json") as string;
  expect(sheet).toContain(`/appcontent/${CANON_ID}/logo.png`);
  expect(sheet).not.toContain(APP_ID);
  const other = "22222222-2222-4222-8222-222222222222";
  const back = deserializeApp(files, { targetAppId: other, knownAppIds: [CANON_ID] });
  expect(JSON.stringify(back.sheets)).toContain(`/appcontent/${other}/logo.png`);
});
test("round trip keeps everything except script-created variables", () => {
  const snap = makeSnapshot();
  const back = deserializeApp(serializeApp(snap, { canonicalAppId: CANON_ID }), { targetAppId: APP_ID, knownAppIds: [CANON_ID] });
  expect(back).toEqual({ ...snap, variables: [snap.variables[0]] });
});
test("serializing twice yields identical bytes", () => {
  const a = serializeApp(makeSnapshot(), { canonicalAppId: CANON_ID });
  const b = serializeApp(makeSnapshot(), { canonicalAppId: CANON_ID });
  expect([...a.entries()]).toEqual([...b.entries()]);
});
```

- [ ] **Step 2:** Run: `npx vitest run tests/core/serializer.test.ts` · Expected: FAIL
- [ ] **Step 3: Implementieren.**
- [ ] **Step 4:** Run: wie Step 2 · Expected: PASS
- [ ] **Step 5: Commit.** `feat: serialize app snapshots to the repository layout and back`

---

### Task 6: Diff

**Files:**
- Create: `src/core/diff.ts` · Test: `tests/core/diff.test.ts`

**Interfaces:**
- Produces:

```ts
export type ChangeKind = "added" | "deleted" | "changed";
export type ObjectGroup = "script" | "appprops" | "variables" | "dimensions" | "measures"
  | "masterobjects" | "sheets" | "stories" | "bookmarks" | "attachedFiles";
export type Part = "script" | "objects" | "bookmarks" | "files";
export interface TreeChange { path: string; kind: ChangeKind; group: ObjectGroup }
export function groupOf(path: string): ObjectGroup | null;     // null = nicht gepflegt
export function partOf(group: ObjectGroup): Part;               // objects = appprops…stories
export function diffTrees(base: Map<string, string>, local: Map<string, string>): TreeChange[]; // Pfad → Blob-SHA, sortiert nach Pfad
export function titleOf(path: string, content: FileContent | undefined): string;
export interface LineChange { kind: "same" | "added" | "removed"; text: string }
export function lineDiff(before: string, after: string): LineChange[];
```

Regeln:
- `groupOf`: `data_load_script/*` → `script`; `objects/appprops.json` → `appprops`; `objects/<ordner>/*.json` → gleichnamige Gruppe; `appcontent/*` → `attachedFiles`; alles andere → `null`.
- `diffTrees` betrachtet nur Pfade mit `groupOf(path) !== null`.
- `titleOf`: bei JSON-Dateien der erste vorhandene Wert aus `qMetaDef.title`, `qProperty.qMetaDef.title`, `qName`; bei Tab-Dateien der Name aus der ersten Zeile `///$tab <name>`; sonst der Dateiname. Nicht lesbares JSON → Dateiname.
- `lineDiff` nutzt `diffLines` aus `diff`; jede Zeile ein Eintrag.

- [ ] **Step 1: Failing tests.**

```ts
import { diffTrees, groupOf, partOf, titleOf, lineDiff } from "../../src/core/diff";

test("classifies paths", () => {
  expect(groupOf("data_load_script/Main.qvs")).toBe("script");
  expect(groupOf("data_load_script/tab_order.txt")).toBe("script");
  expect(groupOf("objects/sheets/sh-1.json")).toBe("sheets");
  expect(groupOf("appcontent/logo.png")).toBe("attachedFiles");
  expect(partOf("variables")).toBe("objects");
  expect(partOf("attachedFiles")).toBe("files");
});
test("reports added, changed and deleted objects", () => {
  const base = new Map([["objects/sheets/a.json", "1"], ["objects/sheets/b.json", "2"], ["objects/measures/m.json", "3"]]);
  const local = new Map([["objects/sheets/a.json", "1"], ["objects/sheets/b.json", "9"], ["objects/variables/v.json", "4"]]);
  expect(diffTrees(base, local)).toEqual([
    { path: "objects/measures/m.json", kind: "deleted", group: "measures" },
    { path: "objects/sheets/b.json", kind: "changed", group: "sheets" },
    { path: "objects/variables/v.json", kind: "added", group: "variables" },
  ]);
});
test("ignores files the extension does not maintain", () => {
  const base = new Map([["README.md", "1"], ["loadScript.qvs", "2"], ["objects/fields.json", "3"],
    ["objects/themes.json", "4"], ["objects/glossarylinks.json", "5"], ["builds/x.qvf", "6"]]);
  expect(diffTrees(base, new Map())).toEqual([]);
});
test("titles", () => {
  expect(titleOf("objects/sheets/sh-1.json", '{"qProperty":{"qMetaDef":{"title":"Overview"}}}')).toBe("Overview");
  expect(titleOf("objects/variables/v.json", '{"qName":"vUser"}')).toBe("vUser");
  expect(titleOf("data_load_script/Load   Data.qvs", "///$tab Load / Data\r\nx")).toBe("Load / Data");
  expect(titleOf("objects/sheets/x.json", "<<<<<<< HEAD")).toBe("x.json");
  expect(titleOf("appcontent/logo.png", undefined)).toBe("logo.png");
});
test("line diff", () => {
  expect(lineDiff("a\nb\n", "a\nc\n")).toEqual([
    { kind: "same", text: "a" }, { kind: "removed", text: "b" }, { kind: "added", text: "c" }]);
});
```

- [ ] **Step 2:** Run: `npx vitest run tests/core/diff.test.ts` · Expected: FAIL
- [ ] **Step 3: Implementieren.**
- [ ] **Step 4:** Run: wie Step 2 · Expected: PASS
- [ ] **Step 5: Commit.** `feat: tree diff, grouping, titles and line diff`

---

### Task 7: Prüfung des Zielstands

**Files:**
- Create: `src/core/target-validator.ts` · Test: `tests/core/target-validator.test.ts`

**Interfaces:**
- Consumes: `TAB_ORDER_PATH`, `TAB_DIVIDER` (Task 4), `groupOf` (Task 6)
- Produces:

```ts
export type TargetProblemReason = "invalid-json" | "conflict-markers" | "missing-tab-file" | "unlisted-tab-file";
export interface TargetProblem { path: string; reason: TargetProblemReason }
export function validateTarget(files: FileMap): TargetProblem[];   // sortiert nach Pfad; leer = in Ordnung
```

Regeln: Geprüft werden nur gepflegte Textdateien. Konfliktmarke = eine Zeile, die mit `<<<<<<< `, `=======` (ganze Zeile) oder `>>>>>>> ` beginnt; sie hat Vorrang vor `invalid-json`. `missing-tab-file`: in `tab_order.txt` genannt, Datei fehlt (Pfad der fehlenden Datei). `unlisted-tab-file`: `.qvs`-Datei unter `data_load_script/`, die `tab_order.txt` nicht nennt.

- [ ] **Step 1: Failing tests.**

```ts
import { validateTarget } from "../../src/core/target-validator";
import { serializeApp } from "../../src/core/serializer";
import { makeSnapshot, CANON_ID } from "../fixtures/snapshot";
const good = () => serializeApp(makeSnapshot(), { canonicalAppId: CANON_ID });

test("a serialized snapshot is valid", () => expect(validateTarget(good())).toEqual([]));
test("finds broken json and conflict markers", () => {
  const f = good();
  f.set("objects/measures/mes-1.json", "{ not json");
  f.set("objects/sheets/sh-1.json", '<<<<<<< HEAD\n{"a":1}\n=======\n{"a":2}\n>>>>>>> feature\n');
  f.set("data_load_script/Main.qvs", "///$tab Main\r\n<<<<<<< HEAD\r\nSET a=1;");
  expect(validateTarget(f)).toEqual([
    { path: "data_load_script/Main.qvs", reason: "conflict-markers" },
    { path: "objects/measures/mes-1.json", reason: "invalid-json" },
    { path: "objects/sheets/sh-1.json", reason: "conflict-markers" },
  ]);
});
test("finds tab files that do not match the order file", () => {
  const f = good();
  f.delete("data_load_script/Main.qvs");
  f.set("data_load_script/Extra.qvs", "///$tab Extra\r\n");
  expect(validateTarget(f)).toEqual([
    { path: "data_load_script/Extra.qvs", reason: "unlisted-tab-file" },
    { path: "data_load_script/Main.qvs", reason: "missing-tab-file" },
  ]);
});
test("ignores unmaintained and binary files", () => {
  const f = good();
  f.set("README.md", "<<<<<<< HEAD"); f.set("objects/fields.json", "{ broken");
  expect(validateTarget(f)).toEqual([]);
});
```

- [ ] **Step 2:** Run: `npx vitest run tests/core/target-validator.test.ts` · Expected: FAIL
- [ ] **Step 3: Implementieren.**
- [ ] **Step 4:** Run: wie Step 2 · Expected: PASS
- [ ] **Step 5: Commit.** `feat: validate a target snapshot before applying it`

---

### Task 8: Update-Planer

**Files:**
- Create: `src/core/update-planner.ts` · Test: `tests/core/update-planner.test.ts`

**Interfaces:**
- Consumes: `Part` (Task 6), Typen (Task 1), `toJson` (Task 5)
- Produces:

```ts
export type AppObjectGroup = "appprops" | "variables" | "dimensions" | "measures" | "masterobjects" | "sheets" | "stories";
export type Action =
  | { op: "upsert"; group: AppObjectGroup; id: string; exists: boolean; payload: GenericProps | PropertyTree }
  | { op: "delete"; group: AppObjectGroup; id: string }
  | { op: "putFile"; name: string; exists: boolean; bytes: Uint8Array }
  | { op: "deleteFile"; name: string }
  | { op: "setScript"; script: string };
export interface PlanSummary { create: number; change: number; delete: number }
export function planUpdate(current: AppSnapshot, target: AppSnapshot, parts: ReadonlySet<Part>): Action[];
export function summarize(actions: Action[]): PlanSummary;   // setScript und putFile(exists) zählen als change
```

Regeln:
- Verglichen wird je Objekt `toJson(payload)`; gleiche Objekte erzeugen keine Aktion. Dateien werden byteweise verglichen.
- Reihenfolge: zuerst alle `upsert` in der Gruppenfolge appprops → variables → dimensions → measures → masterobjects → sheets → stories, dann `putFile`, dann `setScript`; danach `delete` in umgekehrter Gruppenfolge (stories … variables), zuletzt `deleteFile`. Innerhalb einer Gruppe nach ID sortiert. `appprops` wird nie gelöscht.
- Teile: `objects` steuert alle `AppObjectGroup`, `files` die Dateien, `script` das Skript. `bookmarks` erzeugt nie Aktionen.
- Variablen der aktuellen App mit `qIsScriptCreated === true` oder `qIsReserved === true` nehmen am Vergleich nicht teil.
- Ausnahme von der Reihenfolge: Wird eine Variable gelöscht, deren `qName` eine neu anzulegende Variable trägt, steht dieses `delete` unmittelbar vor deren `upsert`.

- [ ] **Step 1: Failing tests.**

```ts
import { planUpdate, summarize } from "../../src/core/update-planner";
import { makeSnapshot } from "../fixtures/snapshot";
const ALL = new Set(["script", "objects", "bookmarks", "files"] as const);

test("identical snapshots need no actions", () => {
  expect(planUpdate(makeSnapshot(), makeSnapshot(), ALL)).toEqual([]);
});
test("orders upserts by dependency, then deletes in reverse", () => {
  const cur = makeSnapshot(); const tgt = makeSnapshot();
  tgt.measures[0] = { ...tgt.measures[0], qMeasure: { qDef: "Sum(Qty)" } };
  tgt.dimensions.push({ qInfo: { qId: "dim-2", qType: "dimension" }, qDim: {} });
  tgt.sheets = []; tgt.masterObjects = [];
  tgt.script = cur.script + "// x";
  tgt.staticFiles.set("new.png", new Uint8Array([1]));
  tgt.staticFiles.delete("logo.png");
  const ops = planUpdate(cur, tgt, ALL).map(a =>
    a.op === "upsert" || a.op === "delete" ? `${a.op}:${a.group}:${a.id}` : a.op === "setScript" ? a.op : `${a.op}:${a.name}`);
  expect(ops).toEqual([
    "upsert:dimensions:dim-2", "upsert:measures:mes-1", "putFile:new.png", "setScript",
    "delete:sheets:sh-1", "delete:masterobjects:mo-1", "deleteFile:logo.png"]);
  expect(summarize(planUpdate(cur, tgt, ALL))).toEqual({ create: 2, change: 2, delete: 3 });
});
test("never touches script-created variables", () => {
  const cur = makeSnapshot(); const tgt = makeSnapshot();
  tgt.variables = tgt.variables.filter(v => !v.qIsScriptCreated);
  expect(planUpdate(cur, tgt, ALL)).toEqual([]);
});
test("never writes bookmarks", () => {
  const tgt = makeSnapshot(); tgt.bookmarks = [];
  expect(planUpdate(makeSnapshot(), tgt, ALL)).toEqual([]);
});
test("respects the selected parts", () => {
  const tgt = makeSnapshot(); tgt.script = "///$tab Main\r\n"; tgt.sheets = [];
  expect(planUpdate(makeSnapshot(), tgt, new Set(["script"] as const)).map(a => a.op)).toEqual(["setScript"]);
  expect(planUpdate(makeSnapshot(), tgt, new Set(["objects"] as const)).map(a => a.op)).toEqual(["delete"]);
});
test("frees a variable name before reusing it under a new id", () => {
  const tgt = makeSnapshot();
  tgt.variables[0] = { ...tgt.variables[0], qInfo: { qId: "var-9", qType: "variable" } };
  expect(planUpdate(makeSnapshot(), tgt, ALL).map(a => `${a.op}:${"id" in a ? a.id : ""}`))
    .toEqual(["delete:var-1", "upsert:var-9"]);
});
```

- [ ] **Step 2:** Run: `npx vitest run tests/core/update-planner.test.ts` · Expected: FAIL
- [ ] **Step 3: Implementieren.**
- [ ] **Step 4:** Run: wie Step 2 · Expected: PASS
- [ ] **Step 5: Commit.** `feat: plan the actions that bring an app to a target snapshot`

---

### Task 9: Repo-Layout (Name, README, Branch-Tabelle)

**Files:**
- Create: `src/core/repo-layout.ts` · Test: `tests/core/repo-layout.test.ts`

**Interfaces:**
- Produces:

```ts
export function repoSlug(appName: string, prefix?: string): string;
export function repoSlugWithId(appName: string, appId: string, prefix?: string): string;  // slug + "-" + erste 8 Zeichen der ID
export interface BranchRow { branch: string; appUrl: string; appId: string | null }
export function parseBranchTable(readme: string): BranchRow[];
export function upsertBranchRow(readme: string, row: { branch: string; appUrl: string }): string;
export function canonicalAppId(rows: BranchRow[], defaultBranch: string): string | null;
export function findBranchForApp(rows: BranchRow[], appId: string): string | null;
export function createReadme(input: { appTitle: string; creatorLogin: string; createdAt: Date;
  sheets: { title: string; description: string }[]; defaultBranch: string; appUrl: string }): string;
```

Regeln:
- Slug: Kleinbuchstaben; `ä→ae`, `ö→oe`, `ü→ue`, `ß→ss`; übrige diakritische Zeichen per NFKD entfernt; alles außer `a-z0-9` → `-`; mehrfache `-` zusammengefasst; `-` an Anfang und Ende entfernt; höchstens 80 Zeichen (inklusive Präfix); leeres Ergebnis → `app`.
- Branch-Tabelle: beginnt mit der Zeile `Branch Name|Qlik application`, gefolgt von `---|---`, dann Zeilen `<branch>|[<url>](<url>)` bis zur ersten Zeile ohne `|`. `appId` ist die GUID hinter `/app/` in der URL, sonst `null`.
- `parseBranchTable` liefert je Branch-Name einen Eintrag: an der Position des ersten Vorkommens, mit dem Inhalt des letzten.
- `upsertBranchRow` ersetzt alle Zeilen dieses Branches durch eine; fehlt die Tabelle, wird sie mit zwei Leerzeilen Abstand am Ende angefügt. Alles andere bleibt zeichengenau erhalten.
- `createReadme`: Zeilen `# Qlik Application Repository`, `# <appTitle>`, `Created by <creatorLogin> at <ISO-Datum>`, dann die Tabelle `Sheet Title | Description` mit Trennzeile `------------ | -------------` und je Sheet einer Zeile `<title>|<description>`, danach die Branch-Tabelle mit einer Zeile für `defaultBranch`.

- [ ] **Step 1: Failing tests.**

```ts
import { repoSlug, repoSlugWithId, parseBranchTable, upsertBranchRow, canonicalAppId, findBranchForApp, createReadme }
  from "../../src/core/repo-layout";

test("slugs", () => {
  expect(repoSlug("Sales Overview")).toBe("sales-overview");
  expect(repoSlug("Umsätze & Bestände (DE)")).toBe("umsaetze-bestaende-de");
  expect(repoSlug("Café  Größe", "qlik-")).toBe("qlik-cafe-groesse");
  expect(repoSlug("Продажби")).toBe("app");
  expect(repoSlug("x".repeat(200)).length).toBe(80);
  expect(repoSlugWithId("Продажби", "def7f0fe-1253-41bf-a3f2-b72b72fe7804")).toBe("app-def7f0fe");
});

const A = "a600a3f7-cc53-4822-a600-13522fc2e6a8", B = "cb1d418c-c2cd-4134-8b8d-bcef3a9a224d", C = "fa823547-0a1f-4b57-acd0-d3be1fa40cea";
const readme = [
  "# Qlik Application Repository ", "# Demo", "", "Sheet Title | Description", "------------ | -------------", "About|", "", "",
  "Branch Name|Qlik application", "---|---",
  `main|[https://qs.example.com/sense/app/${A}](https://qs.example.com/sense/app/${A})`,
  `test-branch|[https://qs.example.com/qs/sense/app/${B}](https://qs.example.com/qs/sense/app/${B})`,
  `test-branch|[https://qs.example.com/qs/sense/app/${B}](https://qs.example.com/qs/sense/app/${B})`,
  `old|[https://qs-test/sense/app/${C}](https://qs-test/sense/app/${C})`,
].join("\n");

test("reads the table gitoqlok leaves behind", () => {
  const rows = parseBranchTable(readme);
  expect(rows.map(r => [r.branch, r.appId])).toEqual([["main", A], ["test-branch", B], ["old", C]]);
  expect(canonicalAppId(rows, "main")).toBe(A);
  expect(findBranchForApp(rows, C)).toBe("old");
  expect(findBranchForApp(rows, "nope")).toBeNull();
  expect(parseBranchTable("# no table")).toEqual([]);
});
test("writes exactly one row per branch and keeps the rest", () => {
  const url = "https://qs.example.com/qs/sense/app/11111111-1111-4111-8111-111111111111";
  const out = upsertBranchRow(readme, { branch: "test-branch", appUrl: url });
  expect(out.split("\n").filter(l => l.startsWith("test-branch|"))).toEqual([`test-branch|[${url}](${url})`]);
  expect(out.startsWith(readme.split("Branch Name")[0])).toBe(true);
  expect(parseBranchTable(upsertBranchRow(out, { branch: "new", appUrl: url })).map(r => r.branch))
    .toEqual(["main", "test-branch", "old", "new"]);
  expect(parseBranchTable(upsertBranchRow("# no table", { branch: "main", appUrl: url }))).toHaveLength(1);
});
test("creates a readme the parser understands", () => {
  const url = `https://qs.example.com/qs/sense/app/${A}`;
  const md = createReadme({ appTitle: "Demo", creatorLogin: "rumen-vasilev", createdAt: new Date("2026-11-11T10:00:00Z"),
    sheets: [{ title: "About", description: "" }], defaultBranch: "main", appUrl: url });
  expect(md).toContain("# Demo");
  expect(md).toContain("2026-11-11T10:00:00.000Z");
  expect(md).toContain("About|");
  expect(parseBranchTable(md)).toEqual([{ branch: "main", appUrl: url, appId: A }]);
});
```

- [ ] **Step 2:** Run: `npx vitest run tests/core/repo-layout.test.ts` · Expected: FAIL
- [ ] **Step 3: Implementieren.**
- [ ] **Step 4:** Run: wie Step 2 · Expected: PASS
- [ ] **Step 5: Commit.** `feat: repository naming, readme and branch table`

---

### Task 10: GitHub-Client und Fehlerzuordnung

**Files:**
- Create: `src/github/errors.ts`, `src/github/client.ts` · Test: `tests/github/client.test.ts`, `tests/github/mock-fetch.ts`

**Interfaces:**
- Produces:

```ts
// errors.ts
export type GitHubErrorKind = "unauthorized" | "sso-required" | "rate-limited" | "forbidden" | "not-found"
  | "name-exists" | "not-fast-forward" | "protected-branch" | "network" | "unknown";
export class GitHubError extends Error {
  constructor(public kind: GitHubErrorKind, public status: number, message: string,
    public extra: { ssoUrl?: string; resetAt?: Date } = {}) { super(message); }
}
export function toGitHubError(status: number, headers: Headers, body: unknown): GitHubError;
// client.ts
export interface GitHubClient {
  rest<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>;
  raw(path: string): Promise<Uint8Array>;                       // folgt Weiterleitungen (zipball)
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
}
export function createGitHubClient(opts: { token: string; fetch?: typeof fetch; baseUrl?: string }): GitHubClient;
// tests/github/mock-fetch.ts
export interface Recorded { method: string; url: string; body: unknown }
export function mockFetch(routes: Record<string, (req: Recorded) => { status?: number; body?: unknown; headers?: Record<string, string> }>):
  { fetch: typeof fetch; calls: Recorded[] };                   // Schlüssel "METHOD /pfad"; unbekannte Route → 404
```

Regeln:
- Header: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`. `baseUrl` Default `https://api.github.com`.
- Zuordnung (`message` aus dem Antwortfeld `message`, in Kleinbuchstaben geprüft):
  - `401` → `unauthorized`
  - `403` mit Header `x-github-sso` → `sso-required`, `ssoUrl` aus `url=<…>` des Headers
  - `403` oder `429` mit `x-ratelimit-remaining: 0` oder Header `retry-after` → `rate-limited`, `resetAt` aus `x-ratelimit-reset` (Unix-Sekunden) bzw. jetzt + `retry-after` Sekunden
  - Nachricht enthält `protected branch` → `protected-branch` (jeder Status)
  - `422`, Nachricht enthält `not a fast forward` → `not-fast-forward`
  - `422`, Nachricht oder `errors[].message` enthält `already exists` → `name-exists`
  - `403` sonst → `forbidden`; `404` → `not-found`; alles andere ≥ 400 → `unknown`
  - `fetch` wirft → `GitHubError("network", 0, …)`
- Die Fehlermeldung enthält nie den Token.

- [ ] **Step 1: Failing tests.**

```ts
import { createGitHubClient } from "../../src/github/client";
import { GitHubError } from "../../src/github/errors";
import { mockFetch } from "./mock-fetch";
const kindOf = async (p: Promise<unknown>) => p.then(() => "ok", e => (e as GitHubError).kind);

test("sends auth headers and parses json", async () => {
  const m = mockFetch({ "GET /user": () => ({ body: { login: "me" } }) });
  const c = createGitHubClient({ token: "T0KEN", fetch: m.fetch });
  expect(await c.rest("GET", "/user")).toEqual({ login: "me" });
  expect(m.calls[0].url).toBe("https://api.github.com/user");
});
test("maps errors", async () => {
  const m = mockFetch({
    "GET /a": () => ({ status: 401, body: { message: "Bad credentials" } }),
    "GET /b": () => ({ status: 403, body: { message: "SAML" }, headers: { "x-github-sso": "required; url=https://github.com/orgs/x/sso?y=1" } }),
    "GET /c": () => ({ status: 403, body: { message: "rate limit" }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" } }),
    "GET /d": () => ({ status: 403, body: { message: "Must have admin rights" } }),
    "PATCH /e": () => ({ status: 422, body: { message: "Update is not a fast forward" } }),
    "POST /f": () => ({ status: 422, body: { message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] } }),
    "PATCH /g": () => ({ status: 409, body: { message: "Cannot update this protected branch" } }),
    "GET /h": () => ({ status: 500, body: { message: "boom" } }),
  });
  const c = createGitHubClient({ token: "T0KEN", fetch: m.fetch });
  expect(await kindOf(c.rest("GET", "/a"))).toBe("unauthorized");
  const sso = await c.rest("GET", "/b").catch(e => e as GitHubError);
  expect([sso.kind, sso.extra.ssoUrl]).toEqual(["sso-required", "https://github.com/orgs/x/sso?y=1"]);
  const rl = await c.rest("GET", "/c").catch(e => e as GitHubError);
  expect([rl.kind, rl.extra.resetAt?.getTime()]).toEqual(["rate-limited", 1800000000000]);
  expect(await kindOf(c.rest("GET", "/d"))).toBe("forbidden");
  expect(await kindOf(c.rest("PATCH", "/e", {}))).toBe("not-fast-forward");
  expect(await kindOf(c.rest("POST", "/f", {}))).toBe("name-exists");
  expect(await kindOf(c.rest("PATCH", "/g", {}))).toBe("protected-branch");
  expect(await kindOf(c.rest("GET", "/h"))).toBe("unknown");
  expect(await kindOf(c.rest("GET", "/missing"))).toBe("not-found");
});
test("network failures and token hygiene", async () => {
  const c = createGitHubClient({ token: "T0KEN", fetch: (async () => { throw new TypeError("fetch failed T0KEN"); }) as typeof fetch });
  const e = await c.rest("GET", "/user").catch(x => x as GitHubError);
  expect(e.kind).toBe("network");
  expect(e.message).not.toContain("T0KEN");
});
```

- [ ] **Step 2:** Run: `npx vitest run tests/github/client.test.ts` · Expected: FAIL
- [ ] **Step 3: Implementieren** (`mock-fetch.ts`, `errors.ts`, `client.ts`).
- [ ] **Step 4:** Run: wie Step 2 · Expected: PASS
- [ ] **Step 5: Commit.** `feat: github client with error mapping`

---

### Task 11: Branches, Trees, Commits, Tags, Vergleich

**Files:**
- Create: `src/github/repo.ts` · Test: `tests/github/repo.test.ts`

**Interfaces:**
- Consumes: `GitHubClient`, `GitHubError` (Task 10), `FileContent` (Task 1)
- Produces (`repo` ist immer `"<owner>/<name>"`):

```ts
export interface CommitInfo { sha: string; message: string; author: string; date: string }
export interface TagInfo { name: string; sha: string }
export function getBranchSha(c: GitHubClient, repo: string, branch: string): Promise<string | null>;   // null bei not-found
export function listBranches(c: GitHubClient, repo: string): Promise<{ name: string; sha: string }[]>;
export function getTree(c: GitHubClient, repo: string, commitSha: string): Promise<Map<string, string>>; // Pfad → Blob-SHA, nur Blobs
export function createBranch(c: GitHubClient, repo: string, name: string, fromSha: string): Promise<void>;
export interface FileChange { path: string; content: FileContent | null }   // null = löschen
export function commitFiles(c: GitHubClient, repo: string, input:
  { branch: string; parentSha: string; message: string; changes: FileChange[] }): Promise<string>;      // neuer Commit-SHA
export function listCommits(c: GitHubClient, repo: string, branch: string, page: number): Promise<CommitInfo[]>; // 30 pro Seite
export function compare(c: GitHubClient, repo: string, base: string, head: string):
  Promise<{ status: "identical" | "ahead" | "behind" | "diverged"; aheadBy: number; behindBy: number; commits: CommitInfo[] }>;
export function createTag(c: GitHubClient, repo: string, input: { name: string; sha: string; message: string }): Promise<void>;
export function listTags(c: GitHubClient, repo: string): Promise<TagInfo[]>;
export function isValidRefName(name: string): boolean;
```

Regeln:
- `getTree`: `GET /repos/{repo}/git/trees/{sha}?recursive=1`; bei `truncated: true` → `Error("Repository tree is too large")`.
- `commitFiles`, in dieser Reihenfolge:
  1. `GET /repos/{repo}/git/commits/{parentSha}` → `tree.sha`
  2. je Änderung mit Inhalt `POST /repos/{repo}/git/blobs` (`{ content, encoding }`; Text `utf-8`, Bytes `base64`), höchstens 5 gleichzeitig
  3. `POST /repos/{repo}/git/trees` mit `base_tree` und Einträgen `{ path, mode: "100644", type: "blob", sha }`; Löschungen mit `sha: null`
  4. `POST /repos/{repo}/git/commits` mit `{ message, tree, parents: [parentSha] }`
  5. `PATCH /repos/{repo}/git/refs/heads/{branch}` mit `{ sha, force: false }`
  Leere `changes` → `Error("Nothing to commit")`, kein Aufruf.
- `createBranch`: `POST /repos/{repo}/git/refs` mit `{ ref: "refs/heads/<name>", sha }`; existiert der Branch, wirft der Client `name-exists`.
- `createTag`: `POST /repos/{repo}/git/tags` (annotiert, `type: "commit"`), dann `POST /repos/{repo}/git/refs` mit `refs/tags/<name>`.
- `compare`: `GET /repos/{repo}/compare/{base}...{head}`; Felder `status`, `ahead_by`, `behind_by`, `commits`.
- `isValidRefName` nach den Git-Regeln: nicht leer; kein Leerzeichen; keines von `~ ^ : ? * [ \`; kein `..`, `@{`, `//`; beginnt nicht mit `/`, `-` oder `.`; endet nicht mit `/`, `.` oder `.lock`; kein Segment beginnt mit `.`.

- [ ] **Step 1: Failing tests.**

```ts
import { commitFiles, getTree, getBranchSha, createBranch, compare, createTag, isValidRefName } from "../../src/github/repo";
import { createGitHubClient } from "../../src/github/client";
import { mockFetch } from "./mock-fetch";
const R = "/repos/lr-bicc/demo";

test("commit sequence: blobs, tree, commit, fast-forward ref", async () => {
  let n = 0;
  const m = mockFetch({
    [`GET ${R}/git/commits/p1`]: () => ({ body: { tree: { sha: "t0" } } }),
    [`POST ${R}/git/blobs`]: () => ({ status: 201, body: { sha: `b${++n}` } }),
    [`POST ${R}/git/trees`]: () => ({ status: 201, body: { sha: "t1" } }),
    [`POST ${R}/git/commits`]: () => ({ status: 201, body: { sha: "c1" } }),
    [`PATCH ${R}/git/refs/heads/feature`]: () => ({ body: {} }),
  });
  const c = createGitHubClient({ token: "t", fetch: m.fetch });
  const sha = await commitFiles(c, "lr-bicc/demo", { branch: "feature", parentSha: "p1", message: "msg", changes: [
    { path: "objects/sheets/a.json", content: "{}" },
    { path: "appcontent/logo.png", content: new Uint8Array([1, 2, 3]) },
    { path: "objects/sheets/gone.json", content: null },
  ] });
  expect(sha).toBe("c1");
  const blobs = m.calls.filter(x => x.url.endsWith("/git/blobs")).map(x => x.body);
  expect(blobs).toContainEqual({ content: "{}", encoding: "utf-8" });
  expect(blobs).toContainEqual({ content: "AQID", encoding: "base64" });
  const tree = m.calls.find(x => x.url.endsWith("/git/trees"))!.body as { base_tree: string; tree: { path: string; sha: string | null }[] };
  expect(tree.base_tree).toBe("t0");
  expect(tree.tree.find(e => e.path === "objects/sheets/gone.json")!.sha).toBeNull();
  expect(m.calls.at(-2)!.body).toEqual({ message: "msg", tree: "t1", parents: ["p1"] });
  expect(m.calls.at(-1)!.body).toEqual({ sha: "c1", force: false });
});
test("rejected fast-forward surfaces as not-fast-forward; empty commit is refused", async () => {
  const m = mockFetch({
    [`GET ${R}/git/commits/p1`]: () => ({ body: { tree: { sha: "t0" } } }),
    [`POST ${R}/git/blobs`]: () => ({ status: 201, body: { sha: "b" } }),
    [`POST ${R}/git/trees`]: () => ({ status: 201, body: { sha: "t1" } }),
    [`POST ${R}/git/commits`]: () => ({ status: 201, body: { sha: "c1" } }),
    [`PATCH ${R}/git/refs/heads/main`]: () => ({ status: 422, body: { message: "Update is not a fast forward" } }),
  });
  const c = createGitHubClient({ token: "t", fetch: m.fetch });
  await expect(commitFiles(c, "lr-bicc/demo", { branch: "main", parentSha: "p1", message: "m",
    changes: [{ path: "a", content: "x" }] })).rejects.toMatchObject({ kind: "not-fast-forward" });
  await expect(commitFiles(c, "lr-bicc/demo", { branch: "main", parentSha: "p1", message: "m", changes: [] }))
    .rejects.toThrow("Nothing to commit");
});
test("tree, branch lookup, branch creation, compare, tag", async () => {
  const m = mockFetch({
    [`GET ${R}/git/trees/c1?recursive=1`]: () => ({ body: { truncated: false, tree: [
      { path: "objects", type: "tree", sha: "x" }, { path: "objects/appprops.json", type: "blob", sha: "s1" }] } }),
    [`GET ${R}/git/trees/big?recursive=1`]: () => ({ body: { truncated: true, tree: [] } }),
    [`GET ${R}/git/ref/heads/main`]: () => ({ body: { object: { sha: "c1" } } }),
    [`POST ${R}/git/refs`]: req => (req.body as { ref: string }).ref === "refs/heads/taken"
      ? { status: 422, body: { message: "Reference already exists" } } : { status: 201, body: {} },
    [`GET ${R}/compare/a...b`]: () => ({ body: { status: "behind", ahead_by: 0, behind_by: 2, commits: [] } }),
    [`POST ${R}/git/tags`]: () => ({ status: 201, body: { sha: "tag1" } }),
  });
  const c = createGitHubClient({ token: "t", fetch: m.fetch });
  expect([...await getTree(c, "lr-bicc/demo", "c1")]).toEqual([["objects/appprops.json", "s1"]]);
  await expect(getTree(c, "lr-bicc/demo", "big")).rejects.toThrow("too large");
  expect(await getBranchSha(c, "lr-bicc/demo", "main")).toBe("c1");
  expect(await getBranchSha(c, "lr-bicc/demo", "gone")).toBeNull();
  await expect(createBranch(c, "lr-bicc/demo", "taken", "c1")).rejects.toMatchObject({ kind: "name-exists" });
  expect(await compare(c, "lr-bicc/demo", "a", "b")).toMatchObject({ status: "behind", behindBy: 2, aheadBy: 0 });
  await createTag(c, "lr-bicc/demo", { name: "v1", sha: "c1", message: "release" });
  expect(m.calls.at(-1)!.body).toEqual({ ref: "refs/tags/v1", sha: "tag1" });
});
test("ref names", () => {
  for (const ok of ["main", "r.vasilev", "feature/x-1", "TEST"]) expect(isValidRefName(ok)).toBe(true);
  for (const bad of ["", "a b", "a..b", "-a", ".a", "a/", "a.lock", "a~1", "a:b", "x/.y", "a@{b"]) expect(isValidRefName(bad)).toBe(false);
});
```

- [ ] **Step 2:** Run: `npx vitest run tests/github/repo.test.ts` · Expected: FAIL
- [ ] **Step 3: Implementieren.** `getBranchSha` nutzt `GET /repos/{repo}/git/ref/heads/{branch}`; `listBranches` `GET /repos/{repo}/branches?per_page=100`; `listCommits` `GET /repos/{repo}/commits?sha={branch}&per_page=30&page={page}`; `listTags` `GET /repos/{repo}/tags?per_page=100`.
- [ ] **Step 4:** Run: wie Step 2 · Expected: PASS
- [ ] **Step 5: Commit.** `feat: github repository operations`

---

### Task 12: Repo-Stand als ZIP, Repo anlegen, Repo zu einer App finden

**Files:**
- Create: `src/github/snapshot.ts` · Test: `tests/github/snapshot.test.ts`

**Interfaces:**
- Consumes: `GitHubClient` (Task 10), `parseBranchTable`, `findBranchForApp` (Task 9), `groupOf` (Task 6)
- Produces:

```ts
export function downloadSnapshot(c: GitHubClient, repo: string, sha: string): Promise<FileMap>;
export function createRepo(c: GitHubClient, org: string, name: string): Promise<{ repo: string; defaultBranch: string }>;
export function listOrgRepos(c: GitHubClient, org: string): Promise<{ repo: string; defaultBranch: string }[]>;
export function findRepoForApp(c: GitHubClient, org: string, appId: string): Promise<{ repo: string; branch: string } | null>;
```

Regeln:
- `downloadSnapshot`: `c.raw("/repos/{repo}/zipball/{sha}")`, entpacken mit `fflate.unzipSync`, den obersten Ordner aus jedem Pfad entfernen, Verzeichniseinträge auslassen. `appcontent/*` bleibt `Uint8Array`, alles andere wird als UTF-8 zu `string` (ohne BOM-Entfernung, ohne Zeilenenden-Umwandlung).
- `createRepo`: `POST /orgs/{org}/repos` mit `{ name, private: true, auto_init: true }`; Rückgabe aus `full_name` und `default_branch`.
- `listOrgRepos` und `findRepoForApp` nutzen eine GraphQL-Abfrage über `organization(login).repositories(first: 100, after: $cursor)` mit `nameWithOwner`, `defaultBranchRef { name }` und `object(expression: "HEAD:README.md") { ... on Blob { text } }`; es wird bis `hasNextPage: false` geblättert. `findRepoForApp` liefert das erste Repo, dessen Branch-Tabelle die App-ID enthält, mit dem Branch aus `findBranchForApp`.

- [ ] **Step 1: Failing tests.**

```ts
import { zipSync, strToU8 } from "fflate";
import { downloadSnapshot, createRepo, findRepoForApp } from "../../src/github/snapshot";
import type { GitHubClient } from "../../src/github/client";

const fake = (over: Partial<GitHubClient>): GitHubClient => ({
  rest: async () => { throw new Error("unexpected rest"); },
  raw: async () => { throw new Error("unexpected raw"); },
  graphql: async () => { throw new Error("unexpected graphql"); }, ...over });

test("unzips a snapshot, strips the top folder, keeps binaries and line endings", async () => {
  const zip = zipSync({ "lr-bicc-demo-abc123/": new Uint8Array(0),
    "lr-bicc-demo-abc123/data_load_script/Main.qvs": strToU8("///$tab Main\r\nSET a=1;"),
    "lr-bicc-demo-abc123/objects/appprops.json": strToU8("[]"),
    "lr-bicc-demo-abc123/appcontent/logo.png": new Uint8Array([137, 80]) });
  const files = await downloadSnapshot(fake({ raw: async p => { expect(p).toBe("/repos/lr-bicc/demo/zipball/abc123"); return zip; } }), "lr-bicc/demo", "abc123");
  expect([...files.keys()].sort()).toEqual(["appcontent/logo.png", "data_load_script/Main.qvs", "objects/appprops.json"]);
  expect(files.get("data_load_script/Main.qvs")).toBe("///$tab Main\r\nSET a=1;");
  expect(files.get("appcontent/logo.png")).toEqual(new Uint8Array([137, 80]));
});
test("creates a private, initialized repository", async () => {
  let sent: unknown;
  const r = await createRepo(fake({ rest: (async (_m: string, p: string, b: unknown) => { expect(p).toBe("/orgs/lr-bicc/repos"); sent = b;
    return { full_name: "lr-bicc/demo", default_branch: "main" }; }) as GitHubClient["rest"] }), "lr-bicc", "demo");
  expect(sent).toEqual({ name: "demo", private: true, auto_init: true });
  expect(r).toEqual({ repo: "lr-bicc/demo", defaultBranch: "main" });
});
test("finds the repository and branch of an app across pages", async () => {
  const id = "cb1d418c-c2cd-4134-8b8d-bcef3a9a224d";
  const table = `Branch Name|Qlik application\n---|---\nfeature|[u](https://qs.example.com/qs/sense/app/${id})`;
  const page = (nodes: unknown[], next: string | null) => ({ organization: { repositories: {
    pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } } });
  const c = fake({ graphql: (async (_q: string, v: Record<string, unknown>) => v.cursor == null
    ? page([{ nameWithOwner: "lr-bicc/other", defaultBranchRef: { name: "main" }, object: null }], "c1")
    : page([{ nameWithOwner: "lr-bicc/demo", defaultBranchRef: { name: "main" }, object: { text: table } }], null)) as GitHubClient["graphql"] });
  expect(await findRepoForApp(c, "lr-bicc", id)).toEqual({ repo: "lr-bicc/demo", branch: "feature" });
  expect(await findRepoForApp(c, "lr-bicc", "00000000-0000-4000-8000-000000000000")).toBeNull();
});
```

- [ ] **Step 2:** Run: `npx vitest run tests/github/snapshot.test.ts` · Expected: FAIL
- [ ] **Step 3: Implementieren.**
- [ ] **Step 4: Gesamtlauf.** Run: `npm test && npm run typecheck` · Expected: alle Tests PASS, keine Typfehler.
- [ ] **Step 5: Commit.** `feat: snapshot download, repository creation and app lookup`

---

## Danach: Plan 2

Plan 2 wird geschrieben, sobald `docs/superpowers/spike/results.md` vorliegt, und baut auf den Schnittstellen dieses Plans auf: Manifest und Build der Extension, Service Worker mit Token-Verwaltung, Optionsseite, Engine-Adapter im Content Script (`AppSnapshot` lesen, `Action[]` ausführen), Link-Objekt, Side Panel mit den Abläufen aus Spec Abschnitt 6, Diff-Overlay, Abnahme-Checkliste.
