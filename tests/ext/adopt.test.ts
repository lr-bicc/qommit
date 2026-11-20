import { serializeApp } from "../../src/core/serializer";
import type { AppSnapshot, FileMap } from "../../src/core/types";
import { appHasCommits, MAX_COMPARED_DOWNLOADS } from "../../src/ext/flows/adopt";
import { CANON_ID, makeSnapshot } from "../fixtures/snapshot";
import { fakeGitHub } from "./fake-ports";
import { legacyRepo } from "./helpers";

const REPO = "lr-bicc/sales";
const OTHER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // the app id gitoqlok left in the repository's urls

function setup() {
  const github = fakeGitHub();
  const base = legacyRepo(github);
  /** Commits `files` (written as gitoqlok would, with another app's id in appcontent urls) on main. */
  const commit = (changes: { path: string; content: string | null }[]) =>
    github.commitFiles(REPO, { branch: "main", parentSha: github.head(REPO, "main"), message: "merge", changes });
  return { github, base, commit };
}

/** The repository files of `snap` as the app would write them. */
const appFiles = (snap: AppSnapshot, id = CANON_ID): FileMap => serializeApp(snap, { canonicalAppId: id });
const text = (files: FileMap, path: string) => files.get(path) as string;
const SHEET = "objects/sheets/sh-1.json";

function renamedSheet(): AppSnapshot {
  const snap = makeSnapshot();
  snap.sheets[0]!.qProperty.qMetaDef = { title: "Overview (Nordics)" };
  return snap;
}

test("only the README moved on: the app holds the head", async () => {
  const { github, base, commit } = setup();
  const head = await commit([{ path: "README.md", content: "# changed\n" }]);
  expect(await appHasCommits(github, REPO, appFiles(makeSnapshot()), base, head)).toBe(true);
});

test("a merged sheet change the app already has counts as contained, whatever app id the repository's urls carry", async () => {
  const { github, base, commit } = setup();
  const head = await commit([{ path: SHEET, content: text(appFiles(renamedSheet(), OTHER_ID), SHEET) }]);
  expect(await appHasCommits(github, REPO, appFiles(renamedSheet()), base, head)).toBe(true);
});

test("an app that still has the old sheet does not hold the head", async () => {
  const { github, base, commit } = setup();
  const head = await commit([{ path: SHEET, content: text(appFiles(renamedSheet(), OTHER_ID), SHEET) }]);
  expect(await appHasCommits(github, REPO, appFiles(makeSnapshot()), base, head)).toBe(false);
});

test("script-created variables that changed on reload are ignored", async () => {
  const { github, base, commit } = setup();
  const head = await commit([{ path: "objects/variables/v-script.json",
    content: '{"qInfo":{"qId":"v-script","qType":"variable"},"qName":"vNow","qDefinition":"02.11.2026","qIsScriptCreated":true}' }]);
  expect(await appHasCommits(github, REPO, appFiles(makeSnapshot()), base, head)).toBe(true);
});

test("a file the branch deleted but the app still has: not contained", async () => {
  const { github, base, commit } = setup();
  const head = await commit([{ path: "objects/measures/mes-1.json", content: null }]);
  expect(await appHasCommits(github, REPO, appFiles(makeSnapshot()), base, head)).toBe(false);
});

test("a file the branch added that the app lacks: not contained", async () => {
  const { github, base, commit } = setup();
  const head = await commit([{ path: "objects/measures/mes-2.json", content: '{"qInfo":{"qId":"mes-2","qType":"measure"}}' }]);
  expect(await appHasCommits(github, REPO, appFiles(makeSnapshot()), base, head)).toBe(false);
});

test("gitoqlok's qMeta inside _ColorMapModel is not a difference", async () => {
  const { github, base, commit } = setup();
  const snap = makeSnapshot();
  const colorMap = { qInfo: { qId: "ColorMapModel_dim-1", qType: "ColorMap" }, colorMap: { colors: [{ value: "DE", baseColor: { color: "#ff0000" } }] } };
  snap.dimensions[0] = { ...snap.dimensions[0]!, _ColorMapModel: colorMap };
  const inRepo = { ...snap.dimensions[0]!, _ColorMapModel: { qInfo: colorMap.qInfo, qMeta: { createdDate: "2026-01-01" }, colorMap: colorMap.colorMap } };
  const head = await commit([{ path: "objects/dimensions/dim-1.json", content: JSON.stringify(inRepo, null, 2) }]);
  expect(await appHasCommits(github, REPO, appFiles(snap), base, head)).toBe(true);
});

test("an unknown base commit is not trusted", async () => {
  const { github, commit } = setup();
  const head = await commit([{ path: "README.md", content: "# changed\n" }]);
  expect(await appHasCommits(github, REPO, appFiles(makeSnapshot()), "f".repeat(40), head)).toBe(false);
});

test("too many files to download: not contained (the old behaviour)", async () => {
  const { github, base, commit } = setup();
  const snap = makeSnapshot();
  snap.sheets = Array.from({ length: MAX_COMPARED_DOWNLOADS + 1 }, (_, i) => ({
    qProperty: { qInfo: { qId: `s-${i}`, qType: "sheet" }, url: `/appcontent/${CANON_ID}/x.png` }, qChildren: [],
  }));
  const repoFiles = appFiles(snap, OTHER_ID);
  const head = await commit([...repoFiles].filter(([p]) => p.startsWith("objects/sheets/")).map(([path, content]) => ({ path, content: content as string })));
  expect(await appHasCommits(github, REPO, appFiles(snap), base, head)).toBe(false);
});
