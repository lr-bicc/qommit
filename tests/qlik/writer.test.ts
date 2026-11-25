import { readApp } from "../../src/qlik/reader";
import { ApplyError, applyActions, saveApp } from "../../src/qlik/writer";
import type { FileStore } from "../../src/qlik/writer";
import type { Action } from "../../src/core/update-planner";
import type { GenericProps, PropertyTree } from "../../src/core/types";
import { APP_ID, makeSnapshot } from "../fixtures/snapshot";
import { appFromSnapshot, fakeDoc } from "./fake-engine";
import { withoutSnapshotIdentity } from "../../src/core/embedded-snapshots";
import { SNAPSHOT_CONTENT, storyWithSnapshot } from "../fixtures/story-snapshot";

const varProps = (id: string, name: string): GenericProps => ({ qInfo: { qId: id, qType: "variable" }, qName: name, qDefinition: "1" });
const sheetTree = (id: string): PropertyTree => ({ qProperty: { qInfo: { qId: id, qType: "sheet" }, qMetaDef: { title: "T" } }, qChildren: [] });
const dimProps = (id: string, colors?: unknown): GenericProps => ({
  qInfo: { qId: id, qType: "dimension" }, qDim: { qFieldDefs: ["F"] }, qMetaDef: { title: id },
  ...(colors === undefined ? {} : { _ColorMapModel: colors }),
});
function memoryStore() {
  const files = new Map<string, Uint8Array>();
  const store: FileStore = {
    put: async (name, bytes) => { files.set(name, bytes); },
    remove: async (name) => { files.delete(name); },
  };
  return { files, store };
}

test("upserts create and change objects with their ids and keep the order", async () => {
  const { doc, calls } = fakeDoc(appFromSnapshot(makeSnapshot()));
  await applyActions(doc, [
    { op: "upsert", group: "variables", id: "vNew", exists: false, payload: varProps("vNew", "vNew") },
    { op: "upsert", group: "sheets", id: "sh-1", exists: true, payload: sheetTree("sh-1") },
    { op: "setScript", script: "///$tab Main\nLOAD 1;" },
  ], { files: memoryStore().store });
  expect(calls).toEqual(["createVariableEx vNew", "getObject sh-1", "setFullPropertyTree sh-1", "setScript -"]);
});

test("created and changed objects are read back by readApp", async () => {
  const app = appFromSnapshot(makeSnapshot());
  const { doc } = fakeDoc(app);
  await applyActions(doc, [
    { op: "upsert", group: "variables", id: "vNew", exists: false, payload: varProps("vNew", "vNew") },
    { op: "upsert", group: "variables", id: "var-1", exists: true, payload: varProps("var-1", "vRenamed") },
    { op: "upsert", group: "measures", id: "m9", exists: false, payload: { qInfo: { qId: "m9", qType: "measure" }, qMeasure: { qDef: "1" }, qMetaDef: { title: "M" } } },
    { op: "upsert", group: "sheets", id: "sh9", exists: false, payload: sheetTree("sh9") },
    { op: "delete", group: "dimensions", id: "dim-1" },
    { op: "delete", group: "sheets", id: "sh-1" },
    { op: "setScript", script: "NEW;" },
  ], { files: memoryStore().store });
  const snap = await readApp(fakeDoc(app).doc, APP_ID, { published: false });
  expect(snap.variables.map((v) => v.qName).sort()).toEqual(["vNew", "vRenamed", "vToday"]);
  expect(snap.measures.map((m) => m.qInfo.qId).sort()).toEqual(["m9", "mes-1"]);
  expect(snap.sheets.map((s) => s.qProperty.qInfo.qId)).toEqual(["sh9"]);
  expect(snap.dimensions).toEqual([]);
  expect(snap.script).toBe("NEW;");
});

test("a dimension with colours writes its ColorMap object; without colours the object is removed", async () => {
  const app = appFromSnapshot(makeSnapshot());
  app.objects.push({ props: { qInfo: { qId: "ColorMapModel_d2", qType: "ColorMap" }, colorMap: {} } });
  const { doc, calls } = fakeDoc(app);
  const colors = { qInfo: { qId: "ColorMapModel_d1", qType: "ColorMap" }, colorMap: { colors: [{ value: "A" }] } };
  await applyActions(doc, [
    { op: "upsert", group: "dimensions", id: "d1", exists: false, payload: dimProps("d1", colors) },
    { op: "upsert", group: "dimensions", id: "d2", exists: false, payload: dimProps("d2") },
  ], { files: memoryStore().store });
  expect(calls).toContain("createObject ColorMapModel_d1");
  expect(calls).toContain("setProperties ColorMapModel_d1");
  expect(calls).toContain("destroyObject ColorMapModel_d2");
  expect(app.dimensions.find((d) => d.qInfo.qId === "d1")).toEqual(dimProps("d1")); // no _ColorMapModel in the dimension
  expect(app.objects.find((o) => o.props.qInfo.qId === "ColorMapModel_d1")?.props)
    .toEqual({ qInfo: colors.qInfo, colorMap: colors.colorMap });
  expect(app.objects.some((o) => o.props.qInfo.qId === "ColorMapModel_d2")).toBe(false);
});

test("an existing ColorMap object is reused and an absent one is no error when it is removed", async () => {
  const app = appFromSnapshot(makeSnapshot());
  app.dimensions.push(dimProps("d1"));
  app.objects.push({ props: { qInfo: { qId: "ColorMapModel_d1", qType: "ColorMap" }, colorMap: { old: true } } });
  const { doc, calls } = fakeDoc(app);
  await applyActions(doc, [
    { op: "upsert", group: "dimensions", id: "d1", exists: true, payload: dimProps("d1", { colorMap: { fresh: true } }) },
    { op: "upsert", group: "dimensions", id: "nope", exists: false, payload: dimProps("nope") }, // destroyObject on an absent ColorMap
    { op: "delete", group: "dimensions", id: "d1" },
  ], { files: memoryStore().store });
  expect(calls).not.toContain("createObject ColorMapModel_d1");
  expect(calls).toContain("getObject ColorMapModel_d1");
  expect(calls).toContain("destroyDimension d1");
  expect(app.objects.some((o) => o.props.qInfo.qId === "ColorMapModel_d1")).toBe(false);
});

test("a false answer for an absent ColorMap object is no error either", async () => {
  const doc = {
    createDimension: async () => ({}),
    destroyObject: async () => false,
  };
  await expect(applyActions(doc, [{ op: "upsert", group: "dimensions", id: "d1", exists: false, payload: dimProps("d1") }], { files: memoryStore().store }))
    .resolves.toBeUndefined();
});

test("other destroyObject failures are errors", async () => {
  const { doc, failOn } = fakeDoc(appFromSnapshot(makeSnapshot()));
  failOn("destroyObject", "ColorMapModel_d1");
  const action: Action = { op: "delete", group: "dimensions", id: "dim-1" };
  const dim: Action = { op: "upsert", group: "dimensions", id: "d1", exists: false, payload: dimProps("d1") };
  const err = await applyActions(doc, [dim, action], { files: memoryStore().store }).catch((e) => e);
  expect(err).toBeInstanceOf(ApplyError);
  expect(err.failed).toBe(dim);
});

test("files go to the file store", async () => {
  const { doc } = fakeDoc(appFromSnapshot(makeSnapshot()));
  const { files, store } = memoryStore();
  await applyActions(doc, [
    { op: "putFile", name: "a.png", exists: false, bytes: new Uint8Array([1]) },
    { op: "putFile", name: "b.png", exists: false, bytes: new Uint8Array([2]) },
    { op: "deleteFile", name: "b.png" },
  ], { files: store });
  expect([...files.keys()]).toEqual(["a.png"]);
});

test("the first failure stops the update and names done and remaining actions", async () => {
  const { doc, failOn, calls } = fakeDoc(appFromSnapshot(makeSnapshot()));
  failOn("createDimension", "d9");
  const a1: Action = { op: "upsert", group: "variables", id: "v1", exists: false, payload: varProps("v1", "v1") };
  const dimD9: Action = { op: "upsert", group: "dimensions", id: "d9", exists: false, payload: dimProps("d9") };
  const a3: Action = { op: "setScript", script: "X;" };
  const err = await applyActions(doc, [a1, dimD9, a3], { files: memoryStore().store }).catch((e) => e);
  expect(err).toBeInstanceOf(ApplyError);
  expect(err.done).toEqual([a1]);
  expect(err.done[0]).toBe(a1);
  expect(err.failed).toBe(dimD9);
  expect(err.remaining).toEqual([a3]);
  expect(err.remaining[0]).toBe(a3);
  expect(err.message).toBe("forced failure: createDimension d9");
  expect(calls).not.toContain("setScript -");
});

test("onProgress counts every action", async () => {
  const { doc } = fakeDoc(appFromSnapshot(makeSnapshot()));
  const progress: [number, number][] = [];
  await applyActions(doc, [
    { op: "upsert", group: "variables", id: "v1", exists: false, payload: varProps("v1", "v1") },
    { op: "setScript", script: "A;" },
    { op: "deleteFile", name: "x" },
  ], { files: memoryStore().store, onProgress: (d, t) => progress.push([d, t]) });
  expect(progress).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);
});

test("saveApp calls DoSave", async () => {
  const app = appFromSnapshot(makeSnapshot());
  const { doc, calls } = fakeDoc(app);
  await saveApp(doc);
  expect(calls).toContain("doSave -");
  expect(app.saved).toBe(1);
});

describe("embedded snapshots", () => {
  // The engine ignores qEmbeddedSnapshotRef in setFullPropertyTree; the writer embeds each snapshot from a temporary bookmark.
  const storyAction = (tree: PropertyTree, exists: boolean): Action => ({ op: "upsert", group: "stories", id: "story-1", exists, payload: withoutSnapshotIdentity(tree) });
  const stories = async (app: ReturnType<typeof appFromSnapshot>) => (await readApp(fakeDoc(app).doc, APP_ID, { published: false })).stories;
  const bookmarkIds = (app: ReturnType<typeof appFromSnapshot>) => app.bookmarks.map((b) => b.props.qInfo.qId);

  test("a new story gets its snapshot; the temporary bookmark is gone afterwards", async () => {
    const app = appFromSnapshot(makeSnapshot());
    const before = bookmarkIds(app);
    const { doc, calls } = fakeDoc(app);
    await applyActions(doc, [storyAction(storyWithSnapshot(), false)], { files: memoryStore().store });
    expect(await stories(app)).toEqual([withoutSnapshotIdentity(storyWithSnapshot())]);
    expect(bookmarkIds(app)).toEqual(before);
    const temp = calls.find((c) => c.startsWith("createBookmark "))!.slice("createBookmark ".length);
    expect(temp).toMatch(/^qommit-snapshot-/);
    expect(calls.slice(calls.indexOf(`createBookmark ${temp}`))).toEqual([
      `createBookmark ${temp}`, "getObject item-snap", "embedSnapshotObject item-snap", `destroyBookmark ${temp}`,
    ]);
  });

  test("the temporary bookmark carries the snapshot's content", async () => {
    const app = appFromSnapshot(makeSnapshot());
    const { doc } = fakeDoc(app);
    const created: GenericProps[] = [];
    const createBookmark = doc.createBookmark!;
    doc.createBookmark = (p: GenericProps) => { created.push(structuredClone(p)); return createBookmark(p); };
    await applyActions(doc, [storyAction(storyWithSnapshot(), false)], { files: memoryStore().store });
    expect(created).toEqual([{ qInfo: { qId: expect.stringMatching(/^qommit-snapshot-/), qType: "embeddedsnapshot" }, ...SNAPSHOT_CONTENT }]);
  });

  test("a story whose snapshot the app already holds is written without embedding again", async () => {
    const app = appFromSnapshot(makeSnapshot());
    await applyActions(fakeDoc(app).doc, [storyAction(storyWithSnapshot(), false)], { files: memoryStore().store });
    const { doc, calls } = fakeDoc(app);
    const retitled = storyWithSnapshot("other-id");
    retitled.qProperty.qMetaDef = { title: "New title" };
    await applyActions(doc, [storyAction(retitled, true)], { files: memoryStore().store });
    expect(calls.filter((c) => /Bookmark|embed/.test(c))).toEqual([]);
    expect((await stories(app))[0]).toEqual(withoutSnapshotIdentity(retitled));
  });

  test("a changed snapshot is embedded anew", async () => {
    const app = appFromSnapshot(makeSnapshot());
    await applyActions(fakeDoc(app).doc, [storyAction(storyWithSnapshot(), false)], { files: memoryStore().store });
    const changed = storyWithSnapshot();
    const ref = (changed.qChildren[0]!.qChildren[1] as PropertyTree & { qEmbeddedSnapshotRef: { qProperties: GenericProps } }).qEmbeddedSnapshotRef;
    ref.qProperties = { ...ref.qProperties, title: "Changed" };
    const { doc, calls } = fakeDoc(app);
    await applyActions(doc, [storyAction(changed, true)], { files: memoryStore().store });
    expect(calls.filter((c) => c.startsWith("embedSnapshotObject"))).toEqual(["embedSnapshotObject item-snap"]);
    expect((await stories(app))[0]).toEqual(withoutSnapshotIdentity(changed));
  });

  test("a failed embedding still removes the temporary bookmark and fails the action", async () => {
    const app = appFromSnapshot(makeSnapshot());
    const before = bookmarkIds(app);
    const { doc, failOn } = fakeDoc(app);
    failOn("embedSnapshotObject", "item-snap");
    const action = storyAction(storyWithSnapshot(), false);
    await expect(applyActions(doc, [action], { files: memoryStore().store })).rejects.toMatchObject({ name: "ApplyError", failed: action });
    expect(bookmarkIds(app)).toEqual(before);
  });
});
