import { createReadme } from "../../src/core/repo-layout";
import { serializeApp } from "../../src/core/serializer";
import type { AppSnapshot, FileMap } from "../../src/core/types";
import { FlowError } from "../../src/ext/flows/ports";
import { UPDATE_PARTS, prepareUpdate, previewUpdate, type UpdateInput } from "../../src/ext/flows/update";
import { CANON_ID, makeSnapshot } from "../fixtures/snapshot";
import { fakePorts } from "./fake-ports";

const REPO = "lr-bicc/sales";

function repoFiles(snap: AppSnapshot): FileMap {
  const files = serializeApp(snap, { canonicalAppId: CANON_ID });
  files.set("README.md", createReadme({ appTitle: "Sales", creatorLogin: "x", createdAt: new Date(0), sheets: [],
    defaultBranch: "main", appUrl: `https://qlik.example.com/qs/sense/app/${CANON_ID}` }));
  return files;
}

function setup(init: Parameters<typeof fakePorts>[0] = {}) {
  const env = fakePorts(init);
  const base = env.github.seed(REPO, repoFiles(makeSnapshot()));
  const link = { repo: REPO, branch: "main", appId: CANON_ID, syncedSha: base };
  const input = (target: string): UpdateInput => ({ link, target, parts: UPDATE_PARTS });
  /** Adds a commit on main changing the given files; returns its sha. */
  const commit = (changes: [string, string | null][]): Promise<string> =>
    env.github.commitFiles(REPO, {
      branch: "main", parentSha: env.github.head(REPO, "main"), message: "change",
      changes: changes.map(([path, content]) => ({ path, content })),
    });
  return { ...env, base, link, input, commit };
}

test("preview counts what an update to the head would do", async () => {
  const { ports, app, input, commit } = setup();
  const measure = makeSnapshot().measures[0]!;
  const changed = { ...measure, qMeasure: { qDef: "Avg(Sales)" } };
  const head = await commit([[`objects/measures/${measure.qInfo.qId}.json`, JSON.stringify(changed, null, 2) + "\n"]]);
  app.snapshot.sheets.push({ qProperty: { qInfo: { qId: "sh-extra", qType: "sheet" }, qMetaDef: { title: "Extra" } }, qChildren: [] });

  const preview = await previewUpdate(ports, input(head));
  expect(preview.target).toBe(head);
  expect(preview.summary).toEqual({ create: 0, change: 1, delete: 1 });
  expect(preview.localChanges).toBe(1);
  expect(preview.onBranch).toBe(true);
  expect(preview.items.map((i) => [i.kind, i.group, i.id])).toEqual([
    ["change", "measures", measure.qInfo.qId], ["delete", "sheets", "sh-extra"],
  ]);
});

test("a target that is not on the branch is flagged", async () => {
  const { ports, github, input, base } = setup();
  await github.createBranch(REPO, "other", base);
  const otherHead = await github.commitFiles(REPO, {
    branch: "other", parentSha: base, message: "o", changes: [{ path: "objects/measures/mes-1.json", content: null }],
  });
  expect((await previewUpdate(ports, input(otherHead))).onBranch).toBe(false);
});

test("a missing branch fails with branch-not-found", async () => {
  const { ports, github, input, base } = setup();
  github.deleteBranch(REPO, "main");
  await expect(previewUpdate(ports, input(base))).rejects.toMatchObject({ name: "FlowError", code: "branch-not-found" });
});

test("script-created variables of a gitoqlok target are neither created nor deleted", async () => {
  const { ports, input, commit } = setup();
  const target = await commit([["objects/variables/var-2.json",
    JSON.stringify({ qInfo: { qId: "var-2", qType: "variable" }, qName: "vToday", qDefinition: "x", qIsScriptCreated: true })]]);
  const preview = await previewUpdate(ports, input(target));
  expect(preview.items.filter((i) => i.group === "variables")).toEqual([]);
  expect(preview.summary).toEqual({ create: 0, change: 0, delete: 0 });
});

test("sheets of a target with a foreign app id point to the app itself after deserialising", async () => {
  const { ports, github, input } = setup();
  const head = github.head(REPO, "main");
  // The repo holds the canonical id in the sheet, the app its own id; both describe the same sheet.
  expect(github.filesAt(REPO, head).get("objects/sheets/sh-1.json")).toContain(`/appcontent/${CANON_ID}/`);
  const preview = await previewUpdate(ports, input(head));
  expect(preview.items.filter((i) => i.group === "sheets")).toEqual([]);
  expect(preview.summary).toEqual({ create: 0, change: 0, delete: 0 });
});

test("a broken target stops before anything is written", async () => {
  const { ports, app, input, commit } = setup();
  const before = structuredClone(app.snapshot);
  const applied = vi.spyOn(app, "apply");
  const target = await commit([["objects/sheets/sh-1.json", "<<<<<<< ours\n{}\n=======\n{}\n>>>>>>> theirs\n"]]);
  const error = await previewUpdate(ports, input(target)).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(FlowError);
  expect(error).toMatchObject({ code: "invalid-target", detail: [{ path: "objects/sheets/sh-1.json", reason: "conflict-markers" }] });
  expect(app.snapshot).toEqual(before);
  expect(applied).not.toHaveBeenCalled();
  expect(app.saves).toBe(0);
});

test("a target variable on the name of a script variable is reported", async () => {
  const { ports, input, commit } = setup();
  const target = await commit([["objects/variables/var-new.json",
    JSON.stringify({ qInfo: { qId: "var-new", qType: "variable" }, qName: "vToday", qDefinition: "2" })]]);
  await expect(previewUpdate(ports, input(target))).rejects.toMatchObject({
    code: "invalid-target", detail: [{ path: "objects/variables/var-new.json", reason: "variable-name-taken" }],
  });
});

test("published apps and apps without write permission get no preview", async () => {
  const published = setup({ info: { published: true } });
  await expect(previewUpdate(published.ports, published.input(published.base))).rejects.toMatchObject({ code: "published" });
  const readOnly = setup({ info: { canWrite: false } });
  await expect(previewUpdate(readOnly.ports, readOnly.input(readOnly.base))).rejects.toMatchObject({
    code: "cannot-write", message: "You have no permission to change this app",
  });
});

test("prepareUpdate hands the planned actions to the caller", async () => {
  const { ports, app, input, base } = setup();
  app.snapshot.script += "///$tab Extra\r\nSET b=2;\r\n";
  const prepared = await prepareUpdate(ports, input(base));
  expect(prepared.actions.map((a) => a.op)).toEqual(["setScript"]);
  expect(prepared.preview.summary).toEqual({ create: 0, change: 1, delete: 0 });
  expect(prepared.baseTree.size).toBeGreaterThan(0);
  expect(prepared.info.id).toBe(app.snapshot.appId);
});
