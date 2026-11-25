import { buildLocalFiles, computeLocalChanges, hashFiles, unmaintainedPaths } from "../../src/ext/flows/local-changes";
import { FlowError } from "../../src/ext/flows/ports";
import { CANON_ID, makeSnapshot } from "../fixtures/snapshot";
import { fakePorts } from "./fake-ports";
import { gitoqlokFormat, legacyRepo, withValueColours } from "./helpers";

test("first contact with a gitoqlok repository", async () => {
  const { ports, github, app } = fakePorts();
  const base = legacyRepo(github);
  app.snapshot.measures = app.snapshot.measures.slice(1);
  app.snapshot.dimensions.push({ qInfo: { qId: "d-new", qType: "dimension" }, qMetaDef: { title: "Region" } });
  const removed = makeSnapshot().measures[0]!.qInfo.qId;
  const changes = await computeLocalChanges(ports, { repo: "lr-bicc/sales", baseSha: base });
  expect(changes.repo).toBe("lr-bicc/sales");
  expect(changes.baseSha).toBe(base);
  expect(changes.items).toEqual([
    { path: "objects/dimensions/d-new.json", kind: "added", group: "dimensions", part: "objects", title: "Region" },
    { path: `objects/measures/${removed}.json`, kind: "deleted", group: "measures", part: "objects", title: `${removed}.json` },
  ]);
  // The script-created variable is not maintained: it is removable, not a local change.
  expect(changes.unmaintained).toEqual(["builds/a.qvf", "loadScript.qvs", "objects/fields.json", "objects/variables/v-script.json"]);
});

test("an unchanged app shows no changes although its own id differs from the canonical one", async () => {
  const { ports, github } = fakePorts();
  const base = legacyRepo(github);
  const { items } = await computeLocalChanges(ports, { repo: "lr-bicc/sales", baseSha: base });
  // legacyRepo also holds a script-created variable, which the tool never writes: not a local change.
  expect(items).toEqual([]);
});

test("without a branch table the app's own id is the canonical one", async () => {
  const { ports, github } = fakePorts();
  github.seed("lr-bicc/empty", new Map([["README.md", "# x"]]));
  const files = await buildLocalFiles(ports, "lr-bicc/empty");
  expect(JSON.stringify([...files.values()].filter((v) => typeof v === "string"))).not.toContain(CANON_ID);
});

test("a missing README yields the app's own id and does not fail", async () => {
  const { ports, github } = fakePorts();
  github.seed("lr-bicc/bare", new Map([["x.txt", "x"]]));
  const files = await buildLocalFiles(ports, "lr-bicc/bare");
  expect(files.has("objects/appprops.json")).toBe(true);
});

test("an unknown repository fails with repo-not-found", async () => {
  const { ports } = fakePorts();
  await expect(buildLocalFiles(ports, "lr-bicc/nope")).rejects.toMatchObject({ name: "FlowError", code: "repo-not-found" });
  await expect(buildLocalFiles(ports, "lr-bicc/nope")).rejects.toBeInstanceOf(FlowError);
});

test("a script tab carries the tab name as title", async () => {
  const { ports, github, app } = fakePorts();
  const base = legacyRepo(github);
  app.snapshot.script = app.snapshot.script.replace("SET a=1;", "SET a=2;");
  const { items } = await computeLocalChanges(ports, { repo: "lr-bicc/sales", baseSha: base });
  const scriptItems = items.filter((i) => i.group === "script");
  expect(scriptItems).toHaveLength(1);
  expect(scriptItems[0]).toMatchObject({ kind: "changed", group: "script", part: "script", title: "Main" });
});

test("a failing app read fails computeLocalChanges with the same error", async () => {
  const { ports, github, app } = fakePorts();
  const base = legacyRepo(github);
  const boom = new Error("engine down");
  app.read = async () => { throw boom; };
  await expect(computeLocalChanges(ports, { repo: "lr-bicc/sales", baseSha: base })).rejects.toBe(boom);
});

test("progress is passed through to the app read", async () => {
  const { ports, github } = fakePorts();
  legacyRepo(github);
  const seen: [number, number][] = [];
  await buildLocalFiles(ports, "lr-bicc/sales", (d, t) => seen.push([d, t]));
  expect(seen).toEqual([[1, 1]]);
});

test("unmaintainedPaths lists exactly the removable paths, sorted", () => {
  const tree = new Map(["objects/themes.json", "builds/z.qvf", "README.md", "objects/glossarylinks.json", "loadScript.qvs",
    "objects/fields.json", "objects/appprops.json", "builds/a/b.qvf", "buildsx/y"].map((p) => [p, "h"]));
  expect(unmaintainedPaths(tree)).toEqual(["builds/a/b.qvf", "builds/z.qvf", "loadScript.qvs", "objects/fields.json",
    "objects/glossarylinks.json", "objects/themes.json"]);
});

test("hashFiles hashes text and bytes like git", async () => {
  const hashes = await hashFiles(new Map<string, string | Uint8Array>([["a", "hello\n"], ["b", new Uint8Array()]]));
  expect(hashes.get("a")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  expect(hashes.get("b")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
});

test("gitoqlok's format alone is no local change: script variables, another app id in urls, qMeta in value colours", async () => {
  const { ports, github, app } = fakePorts();
  legacyRepo(github);
  const base = await gitoqlokFormat(github);
  withValueColours(app.snapshot);
  const changes = await computeLocalChanges(ports, { repo: "lr-bicc/sales", baseSha: base });
  expect(changes.items).toEqual([]);
  expect(changes.unmaintained).toContain("objects/variables/v-script.json");
});

test("real changes still show next to gitoqlok's format", async () => {
  const { ports, github, app } = fakePorts();
  legacyRepo(github);
  const base = await gitoqlokFormat(github);
  withValueColours(app.snapshot);
  app.snapshot.sheets[0]!.qProperty.qMetaDef = { title: "Overview (new)" };
  app.snapshot.variables = app.snapshot.variables.filter((v) => v.qInfo.qId !== "var-1"); // a maintained variable
  const { items } = await computeLocalChanges(ports, { repo: "lr-bicc/sales", baseSha: base });
  expect(items.map((i) => [i.path, i.kind])).toEqual([
    ["objects/sheets/sh-1.json", "changed"], ["objects/variables/var-1.json", "deleted"],
  ]);
});

test("repository blobs are downloaded once per content, not on every comparison", async () => {
  const { ports, github, app } = fakePorts();
  legacyRepo(github);
  await gitoqlokFormat(github);
  // A blob no other test holds, so the first comparison must download it.
  const base = await github.commitFiles("lr-bicc/sales", { branch: "main", parentSha: github.head("lr-bicc/sales", "main"), message: "v", changes: [
    { path: "objects/variables/v-once.json", content: '{"qInfo":{"qId":"v-once","qType":"variable"},"qName":"vOnce","qIsScriptCreated":true}' },
  ] });
  withValueColours(app.snapshot);
  const before = github.blobReads();
  await computeLocalChanges(ports, { repo: "lr-bicc/sales", baseSha: base });
  const first = github.blobReads();
  expect(first).toBeGreaterThan(before);
  await computeLocalChanges(ports, { repo: "lr-bicc/sales", baseSha: base });
  expect(github.blobReads()).toBe(first);
});
