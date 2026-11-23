import { createReadme } from "../../src/core/repo-layout";
import { serializeApp } from "../../src/core/serializer";
import type { AppSnapshot, FileMap } from "../../src/core/types";
import { FlowError } from "../../src/ext/flows/ports";
import { UPDATE_PARTS, backupBranchName, prepareUpdate, previewUpdate, runUpdate, type UpdateInput } from "../../src/ext/flows/update";
import { APP_ID, CANON_ID, makeSnapshot } from "../fixtures/snapshot";
import type { Action } from "../../src/core/update-planner";
import { buildLocalFiles } from "../../src/ext/flows/local-changes";
import { GatewayError } from "../../src/ext/shared/github-port";
import { ApplyError } from "../../src/qlik/writer";
import { fakePorts, memoryJournal } from "./fake-ports";

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

describe("runUpdate", () => {
  const BACKUP = "backup/main-20260102-0304";
  const extraSheet = { qProperty: { qInfo: { qId: "sh-extra", qType: "sheet" }, qMetaDef: { title: "Extra" } }, qChildren: [] };
  const hasExtraSheet = (snap: AppSnapshot): boolean => snap.sheets.some((s) => s.qProperty.qInfo.qId === "sh-extra");

  /** The repo head carries an extra script tab; the app (linked at base) does not. */
  async function withHeadScript() {
    const env = setup();
    const targetSnap = makeSnapshot();
    targetSnap.script += "///$tab Head\r\nSET h=1;\r\n";
    const head = await env.commit([...serializeApp(targetSnap, { canonicalAppId: CANON_ID })].map(([p, c]) => [p, c as string]));
    env.app.link = { ...env.link };
    return { ...env, head, journal: memoryJournal(), targetSnap };
  }

  test("backupBranchName uses local time", () => {
    expect(backupBranchName("main", new Date(2026, 0, 2, 3, 4, 5))).toBe("backup/main-20260102-0304");
    expect(backupBranchName("feat/x", new Date(2026, 10, 20, 15, 9))).toBe("backup/feat/x-20261120-1509");
  });

  test("an update without local changes makes no backup and moves syncedSha to the target", async () => {
    const { ports, app, github, journal, input, head, targetSnap } = await withHeadScript();
    const commitsBefore = github.commitCount(REPO);
    const r = await runUpdate(ports, journal, input(head));
    expect(r.backupBranch).toBeNull();
    expect(r.syncedSha).toBe(head);
    expect(app.snapshot.script).toBe(targetSnap.script);
    expect(app.link!.syncedSha).toBe(head);
    expect(app.saves).toBe(1);
    expect(github.commitCount(REPO)).toBe(commitsBefore);
    expect((await github.listBranches(REPO)).map((b) => b.name)).toEqual(["main"]);
    expect(journal.entries.size).toBe(0);
  });

  test("local changes are saved to a backup branch before anything is written", async () => {
    const { ports, app, github, journal, input, head } = await withHeadScript();
    app.snapshot.sheets.push(extraSheet);
    const localFilesBefore = await buildLocalFiles(ports, REPO);
    const order: string[] = [];
    const create = github.createBranch.bind(github);
    github.createBranch = async (...a) => { order.push("backup"); return create(...a); };
    const apply = app.apply.bind(app);
    app.apply = async (...a) => { order.push("apply"); return apply(...a); };

    const r = await runUpdate(ports, journal, input(head));
    expect(order).toEqual(["backup", "apply"]);
    expect(r.backupBranch).toBe(BACKUP);
    const backupHead = github.head(REPO, r.backupBranch!);
    expect(github.messageOf(REPO, backupHead)).toBe("Backup before update to " + head.slice(0, 7));
    const saved = github.filesAt(REPO, backupHead);
    for (const [path, content] of localFilesBefore) expect(saved.get(path)).toEqual(content);
    expect(saved.has("objects/sheets/sh-extra.json")).toBe(true);
    expect(hasExtraSheet(app.snapshot)).toBe(false);
    expect(github.head(REPO, "main")).toBe(head);
  });

  test("a second update in the same minute gets backup/main-20260102-0304-2", async () => {
    const { ports, app, github, journal, input, head, base } = await withHeadScript();
    await github.createBranch(REPO, BACKUP, base);
    app.snapshot.sheets.push(extraSheet);
    expect((await runUpdate(ports, journal, input(head))).backupBranch).toBe(BACKUP + "-2");
  });

  test("after 20 name collisions the error is rethrown and nothing is written", async () => {
    const { ports, app, github, journal, input, head, base } = await withHeadScript();
    for (let i = 1; i <= 20; i++) await github.createBranch(REPO, i === 1 ? BACKUP : `${BACKUP}-${i}`, base);
    app.snapshot.sheets.push(extraSheet);
    const before = structuredClone(app.snapshot);
    const err = await runUpdate(ports, journal, input(head)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err).toMatchObject({ kind: "name-exists" });
    expect(app.snapshot).toEqual(before);
    expect(journal.entries.size).toBe(0);
  });

  test("a failing backup leaves the app untouched", async () => {
    const { ports, app, github, journal, input, head } = await withHeadScript();
    app.snapshot.sheets.push(extraSheet);
    const before = structuredClone(app.snapshot);
    github.createBranch = async () => { throw new GatewayError("forbidden", "no access"); };
    await expect(runUpdate(ports, journal, input(head))).rejects.toMatchObject({ kind: "forbidden" });
    expect(app.snapshot).toEqual(before);
    expect(app.saves).toBe(0);
    expect(journal.entries.size).toBe(0);
  });

  test("a failing backup commit leaves the app untouched", async () => {
    const { ports, app, github, journal, input, head } = await withHeadScript();
    app.snapshot.sheets.push(extraSheet);
    const before = structuredClone(app.snapshot);
    github.commitFiles = async () => { throw new GatewayError("unauthorized", "slow down"); };
    await expect(runUpdate(ports, journal, input(head))).rejects.toMatchObject({ kind: "unauthorized" });
    expect(app.snapshot).toEqual(before);
    expect(journal.entries.size).toBe(0);
  });

  test("a failure mid-way keeps syncedSha, keeps the journal and reports done and remaining", async () => {
    const { ports, app, journal, input, head, base } = await withHeadScript();
    app.snapshot.sheets.push(extraSheet);
    app.snapshot.sheets.push({ ...extraSheet, qProperty: { qInfo: { qId: "sh-extra2", qType: "sheet" }, qMetaDef: { title: "Extra 2" } } });
    app.failApplyAt(1, "Access denied");
    const err = await runUpdate(ports, journal, input(head)).catch((e: unknown) => e) as FlowError & { detail: { done: unknown[]; remaining: unknown[]; backupBranch: string } };
    expect(err).toMatchObject({ code: "update-failed", message: "Access denied" });
    expect(err.detail.done).toHaveLength(1);
    expect(err.detail.remaining.length).toBeGreaterThan(0);
    expect(err.detail.backupBranch).toBe(BACKUP);
    expect(app.link!.syncedSha).toBe(base);
    expect(app.saves).toBe(0);
    expect(await journal.get(APP_ID)).toMatchObject({ target: head, backupBranch: BACKUP, total: expect.any(Number) });
  });

  test("temporary upserts are hidden from done and remaining but described when they fail", async () => {
    const { ports, app, journal, input, head } = await withHeadScript();
    const real = (await prepareUpdate(ports, input(head))).actions[0]!;
    const temp = (id: string): Action => ({
      op: "upsert", group: "variables", id, exists: true, temporary: true,
      payload: { qInfo: { qId: id, qType: "variable" }, qName: id, qDefinition: "" },
    });
    app.apply = async () => { throw new ApplyError("boom", [temp("t1"), real], temp("t2"), [temp("t3"), real]); };
    const err = await runUpdate(ports, journal, input(head)).catch((e: unknown) => e) as FlowError & { detail: { done: unknown[]; failed: unknown; remaining: unknown[] } };
    expect(err.code).toBe("update-failed");
    expect(err.detail.done).toHaveLength(1);
    expect(err.detail.remaining).toHaveLength(1);
    expect(err.detail.failed).toMatchObject({ group: "variables", id: "t2" });
  });

  test("an error that is not an ApplyError is rethrown, the journal and syncedSha stay", async () => {
    const { ports, app, journal, input, head, base } = await withHeadScript();
    app.apply = async () => { throw new Error("socket closed"); };
    await expect(runUpdate(ports, journal, input(head))).rejects.toThrow("socket closed");
    expect(app.link!.syncedSha).toBe(base);
    expect(await journal.get(APP_ID)).not.toBeNull();
  });

  test("a failing save keeps the journal and syncedSha", async () => {
    const { ports, app, journal, input, head, base } = await withHeadScript();
    app.save = async () => { throw new Error("save timed out"); };
    await expect(runUpdate(ports, journal, input(head))).rejects.toThrow("save timed out");
    expect(app.link!.syncedSha).toBe(base);
    expect(await journal.get(APP_ID)).not.toBeNull();
  });

  test("an update to a commit outside the branch keeps syncedSha", async () => {
    const { ports, app, github, input, base, link } = setup();
    app.link = { ...link };
    await github.createBranch(REPO, "other", base);
    const otherHead = await github.commitFiles(REPO, {
      branch: "other", parentSha: base, message: "o", changes: [{ path: "objects/measures/mes-1.json", content: null }],
    });
    const r = await runUpdate(ports, memoryJournal(), input(otherHead));
    expect(r.syncedSha).toBe(base);
    expect(app.link!.syncedSha).toBe(base);
    expect(app.saves).toBe(1);
    expect(app.snapshot.measures).toEqual([]);
  });

  test("an update to an older commit of the branch sets syncedSha to it", async () => {
    const { ports, app, github, base, commit } = setup();
    const head = await commit([["objects/measures/mes-1.json", null]]);
    app.snapshot.measures = [];
    app.link = { repo: REPO, branch: "main", appId: CANON_ID, syncedSha: head };
    const r = await runUpdate(ports, memoryJournal(), { link: app.link, target: base, parts: UPDATE_PARTS });
    expect(r.syncedSha).toBe(base);
    expect(app.link.syncedSha).toBe(base);
    expect(app.snapshot.measures.length).toBe(1);
    expect(github.head(REPO, "main")).toBe(head);
  });

  test("only the chosen parts are written", async () => {
    const { ports, app, journal, input, head, targetSnap } = await withHeadScript();
    app.snapshot.sheets.push(extraSheet);
    const r = await runUpdate(ports, journal, { ...input(head), parts: ["script"] });
    expect(app.snapshot.script).toBe(targetSnap.script);
    expect(hasExtraSheet(app.snapshot)).toBe(true);
    expect(r.applied).toBe(1);
  });

  test("nothing to apply writes nothing and still moves syncedSha", async () => {
    const { ports, app, github, input, commit, link } = setup();
    app.link = { ...link };
    const head = await commit([["README.md", "# changed\n"]]);
    const spy = vi.spyOn(app, "apply");
    const r = await runUpdate(ports, memoryJournal(), input(head));
    expect(spy).not.toHaveBeenCalled();
    expect(app.saves).toBe(0);
    expect(r).toEqual({ syncedSha: head, backupBranch: null, applied: 0 });
    expect(app.link!.syncedSha).toBe(head);
    expect((await github.listBranches(REPO)).length).toBe(1);
  });

  test("an empty plan with an interrupted journal entry saves the app and clears the journal, without a backup", async () => {
    const { ports, app, github, input, base, link } = setup();
    const journal = memoryJournal();
    app.link = { ...link };
    await journal.set({ appId: (await ports.app.info()).id, repo: REPO, branch: "main", target: base, backupBranch: null, total: 2, startedAt: "2026-01-01T00:00:00.000Z" });
    const r = await runUpdate(ports, journal, input(base));
    expect(app.saves).toBe(1);
    expect(journal.entries.size).toBe(0);
    expect(r).toEqual({ syncedSha: base, backupBranch: null, applied: 0 });
    expect((await github.listBranches(REPO)).length).toBe(1);
  });

  test("an empty plan without a journal entry does not save", async () => {
    const { ports, app, input, base } = setup();
    await runUpdate(ports, memoryJournal(), input(base));
    expect(app.saves).toBe(0);
  });

  test("the preview says an empty plan advances syncedSha only for a new commit on the branch", async () => {
    const { ports, input, commit, base } = setup();
    expect((await previewUpdate(ports, input(base))).advances).toBe(false);
    const head = await commit([["README.md", "# changed\n"]]);
    const moved = await previewUpdate(ports, input(head));
    expect(moved.items).toEqual([]);
    expect(moved.advances).toBe(true);
  });

  test("a plan with actions does not advance", async () => {
    const { ports, app, input, base } = setup();
    app.snapshot.sheets.push(extraSheet);
    expect((await previewUpdate(ports, input(base))).advances).toBe(false);
  });

  test("the app is read without progress, so the footer only follows the repository files", async () => {
    const { ports, app, input, base } = setup();
    const read = vi.spyOn(app, "read");
    await prepareUpdate(ports, input(base), () => {});
    expect(read).toHaveBeenCalled();
    for (const call of read.mock.calls) expect(call[0]?.onProgress).toBeUndefined();
  });

  test("progress texts for an update with local changes", async () => {
    const { ports, app, journal, input, head } = await withHeadScript();
    app.snapshot.sheets.push(extraSheet);
    const texts: string[] = [];
    await runUpdate(ports, journal, input(head), (t) => texts.push(t));
    const first = texts.indexOf("Saving backup…");
    expect(first).toBeGreaterThan(0);
    expect(texts.slice(0, first).every((t) => /^Loading repository files… \d+\/\d+$/.test(t))).toBe(true);
    expect(texts.slice(first)).toEqual(["Saving backup…", "Updating app… 0/2", "Updating app… 1/2", "Updating app… 2/2", "Saving app…"]);
  });
});
