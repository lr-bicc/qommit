import { GatewayError } from "../../src/ext/shared/github-port";
import { ApplyError } from "../../src/qlik/writer";
import { makeSnapshot } from "../fixtures/snapshot";
import { fakeApp, fakeGitHub, fakeServer } from "./fake-ports";

test("fake readBlobs answers with the files of the commit", async () => {
  const gh = fakeGitHub();
  const sha = gh.seed("lr-bicc/sales", new Map([["objects/variables/v.json", "{}"]]));
  const tree = await gh.getTree("lr-bicc/sales", sha);
  const files = await gh.readBlobs("lr-bicc/sales", [{ path: "objects/variables/v.json", sha: tree.get("objects/variables/v.json")! }]);
  expect(files.get("objects/variables/v.json")).toBe("{}");
  expect(gh.blobReads()).toBe(1);
});

test("fake readBlobs refuses an unknown sha", async () => {
  const gh = fakeGitHub();
  gh.seed("lr-bicc/sales", new Map([["a", "x"]]));
  await expect(gh.readBlobs("lr-bicc/sales", [{ path: "a", sha: "f".repeat(40) }])).rejects.toMatchObject({ kind: "not-found" });
});

test("fake tags can be seeded, listed and created; an existing name is refused", async () => {
  const gh = fakeGitHub();
  const sha = gh.seed("lr-bicc/sales", new Map([["a", "x"]]));
  gh.tag("lr-bicc/sales", "v1", sha, "first");
  await gh.createTag("lr-bicc/sales", { name: "v2", sha, message: "second" });
  expect((await gh.listTags("lr-bicc/sales")).map((t) => [t.name, t.sha, t.message])).toEqual([["v1", sha, "first"], ["v2", sha, "second"]]);
  await expect(gh.createTag("lr-bicc/sales", { name: "v1", sha, message: "" })).rejects.toBeInstanceOf(GatewayError);
  await expect(gh.createTag("lr-bicc/sales", { name: "v1", sha, message: "" })).rejects.toMatchObject({ kind: "name-exists" });
});

test("fake listCommits returns the parents", async () => {
  const gh = fakeGitHub();
  const root = gh.seed("lr-bicc/sales", new Map([["a", "x"]]));
  const next = await gh.commitFiles("lr-bicc/sales", { branch: "main", parentSha: root, message: "m", changes: [{ path: "a", content: "y" }] });
  const commits = await gh.listCommits("lr-bicc/sales", "main", 1);
  expect(commits.find((c) => c.sha === next)!.parents).toEqual([root]);
  expect(commits.find((c) => c.sha === root)!.parents).toEqual([]);
});

test("fake app apply changes the snapshot that read returns", async () => {
  const app = fakeApp({});
  const v = makeSnapshot().variables[0]!;
  const id = v.qInfo.qId;
  await app.apply([
    { op: "upsert", group: "variables", id, exists: true, payload: { ...v, qComment: "changed" } },
    { op: "setScript", script: "LOAD 1;" },
    { op: "putFile", name: "n.png", exists: false, bytes: new Uint8Array([7]) },
    { op: "deleteFile", name: "logo.png" },
  ]);
  const snap = await app.read({ includeFiles: true });
  expect(snap.script).toBe("LOAD 1;");
  expect(snap.variables.find((x) => x.qInfo.qId === id)!.qComment).toBe("changed");
  expect([...snap.staticFiles.keys()]).toEqual(["n.png"]);
  await app.apply([{ op: "delete", group: "variables", id }]);
  expect((await app.read({ includeFiles: false })).variables.some((x) => x.qInfo.qId === id)).toBe(false);
  await app.save();
  expect([app.saves, app.reads]).toEqual([1, 2]);
});

test("fake app failApplyAt applies the actions before the index and throws ApplyError", async () => {
  const app = fakeApp({});
  app.failApplyAt(1, "boom");
  const actions = [{ op: "setScript" as const, script: "A" }, { op: "setScript" as const, script: "B" }, { op: "setScript" as const, script: "C" }];
  const err = await app.apply(actions).catch((e) => e);
  expect(err).toBeInstanceOf(ApplyError);
  expect(err.message).toBe("boom");
  expect([err.done, err.failed, err.remaining]).toEqual([[actions[0]], actions[1], [actions[2]]]);
  expect(app.snapshot.script).toBe("A");
});

test("fake server creates empty apps; failAfterCreate records the app and rejects", async () => {
  const server = fakeServer();
  const { app } = await server.createApp("Sales (main)");
  expect((await app.read({ includeFiles: true })).script).toBe("");
  expect(server.created.map((c) => c.name)).toEqual(["Sales (main)"]);
  server.failAfterCreate("open failed");
  await expect(server.createApp("Second")).rejects.toThrow("open failed");
  expect(server.created.map((c) => c.name)).toEqual(["Sales (main)", "Second"]);
});
