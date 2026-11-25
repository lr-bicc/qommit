import { createReadme } from "../../src/core/repo-layout";
import { serializeApp } from "../../src/core/serializer";
import type { AppSnapshot, FileMap } from "../../src/core/types";
import { openDiff } from "../../src/ext/flows/diff";
import { CANON_ID, makeSnapshot } from "../fixtures/snapshot";
import { fakePorts } from "./fake-ports";
import { gitoqlokFormat, legacyRepo, withValueColours } from "./helpers";

const REPO = "lr-bicc/sales";
const SHEET = "objects/sheets/sh-1.json";

function repoFiles(snap: AppSnapshot): FileMap {
  const files = serializeApp(snap, { canonicalAppId: CANON_ID });
  files.set("README.md", createReadme({ appTitle: "Sales", creatorLogin: "x", createdAt: new Date(0), sheets: [],
    defaultBranch: "main", appUrl: `https://qlik.example.com/qs/sense/app/${CANON_ID}` }));
  return files;
}

function setup() {
  const env = fakePorts();
  const c1 = env.github.seed(REPO, repoFiles(makeSnapshot()));
  const renamed = makeSnapshot();
  (renamed.sheets[0]!.qProperty as any).qMetaDef.title = "Renamed";
  const rename = async (): Promise<string> => {
    const files = repoFiles(renamed);
    const changes = [...files].filter(([p, c]) => c !== env.github.filesAt(REPO, c1).get(p)).map(([path, content]) => ({ path, content: content as string }));
    return env.github.commitFiles(REPO, { branch: "main", parentSha: c1, message: "rename", changes });
  };
  return { ...env, c1, rename, textAt: (sha: string) => env.github.filesAt(REPO, sha).get(SHEET)! };
}

test("commit against commit lists changed objects with their titles", async () => {
  const { ports, c1, rename, textAt } = setup();
  const c2sha = await rename();
  const d = await openDiff(ports, REPO, { kind: "commit", sha: c1 }, { kind: "commit", sha: c2sha });
  expect(d.entries).toEqual([{ path: SHEET, kind: "changed", group: "sheets", title: "Renamed" }]);
  expect(await d.contents(SHEET)).toEqual({ before: textAt(c1), after: textAt(c2sha) });
});

test("a deleted entry takes its title from the before side", async () => {
  const { ports, github, c1 } = setup();
  const c2 = await github.commitFiles(REPO, { branch: "main", parentSha: c1, message: "rm", changes: [{ path: SHEET, content: null }] });
  const d = await openDiff(ports, REPO, { kind: "commit", sha: c1 }, { kind: "commit", sha: c2 });
  expect(d.entries).toEqual([{ path: SHEET, kind: "deleted", group: "sheets", title: "Overview" }]);
  expect((await d.contents(SHEET)).after).toBeNull();
});

test("commit against app reads the app once; an added sheet in the app has its title", async () => {
  const { ports, app, github, c1 } = setup();
  app.snapshot.sheets.push({ qProperty: { qInfo: { qId: "sh-new", qType: "sheet" }, qMetaDef: { title: "Fresh" } }, qChildren: [] });
  const d = await openDiff(ports, REPO, { kind: "commit", sha: c1 }, { kind: "app" });
  expect(app.reads).toBe(1);
  expect(d.entries).toEqual([{ path: "objects/sheets/sh-new.json", kind: "added", group: "sheets", title: "Fresh" }]);
  const c = await d.contents("objects/sheets/sh-new.json");
  expect(c.before).toBeNull();
  expect(typeof c.after).toBe("string");
  expect(app.reads).toBe(1);
  expect(github.blobReads()).toBe(0);
});

test("contents are downloaded once", async () => {
  const { ports, github, c1, rename } = setup();
  const c2sha = await rename();
  const d = await openDiff(ports, REPO, { kind: "commit", sha: c1 }, { kind: "commit", sha: c2sha });
  expect(github.blobReads()).toBe(1); // preload: the title side only
  const first = await d.contents(SHEET);
  const afterFirst = github.blobReads();
  expect(afterFirst).toBe(2); // the other side was fetched lazily
  expect(await d.contents(SHEET)).toEqual(first);
  expect(github.blobReads()).toBe(afterFirst);
});

test("the preload fetches only the first 100 entries; the rest is lazy", async () => {
  const { ports, github, c1 } = setup();
  const changes = Array.from({ length: 105 }, (_, i) => ({ path: `objects/measures/m${i}.json`, content: JSON.stringify({ qMetaDef: { title: `M${i}` } }) }));
  const c2 = await github.commitFiles(REPO, { branch: "main", parentSha: c1, message: "many", changes });
  const calls: number[] = [];
  const original = github.readBlobs.bind(github);
  github.readBlobs = async (repo, items) => { calls.push(items.length); return original(repo, items); };
  const d = await openDiff(ports, REPO, { kind: "commit", sha: c1 }, { kind: "commit", sha: c2 });
  expect(calls).toEqual([100]);
  expect(d.entries).toHaveLength(105);
  const titled = d.entries.filter((e) => e.title.startsWith("M"));
  expect(titled).toHaveLength(100);
  expect(d.entries.filter((e) => e.title.endsWith(".json"))).toHaveLength(5);
  await d.contents(d.entries.find((e) => e.title.endsWith(".json"))!.path);
  expect(calls).toEqual([100, 1]);
});

test("equal sides give no entries and no download", async () => {
  const { ports, github, c1 } = setup();
  const d = await openDiff(ports, REPO, { kind: "commit", sha: c1 }, { kind: "commit", sha: c1 });
  expect(d.entries).toEqual([]);
  expect(github.blobReads()).toBe(0);
});

test("README and builds are never part of a diff", async () => {
  const { ports, github, c1 } = setup();
  const c2 = await github.commitFiles(REPO, {
    branch: "main", parentSha: c1, message: "noise",
    changes: [{ path: "README.md", content: "# changed" }, { path: "builds/x.qvf", content: "bin" }, { path: "loadScript.qvs", content: "x" }],
  });
  const d = await openDiff(ports, REPO, { kind: "commit", sha: c1 }, { kind: "commit", sha: c2 });
  expect(d.entries).toEqual([]);
  expect(github.blobReads()).toBe(0);
});

test("against the app, gitoqlok's format is no difference; between commits it stays one", async () => {
  const env = fakePorts();
  const c1 = legacyRepo(env.github);
  const c2 = await gitoqlokFormat(env.github);
  withValueColours(env.app.snapshot);
  const toApp = await openDiff(env.ports, REPO, { kind: "commit", sha: c2 }, { kind: "app" });
  expect(toApp.entries).toEqual([]);
  const fromApp = await openDiff(env.ports, REPO, { kind: "app" }, { kind: "commit", sha: c2 });
  expect(fromApp.entries).toEqual([]);
  const commits = await openDiff(env.ports, REPO, { kind: "commit", sha: c1 }, { kind: "commit", sha: c2 });
  expect(commits.entries.map((e) => e.path)).toEqual(["objects/dimensions/dim-1.json", SHEET]);
});
