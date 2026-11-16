import { commitFiles, getTree, getBranchSha, createBranch, compare, createTag, isValidRefName, listBranches, listTags, listCommits, getRepo, markRepo, readTextFile, whoAmI } from "../../src/github/repo";
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
  expect(blobs).toEqual([{ content: "AQID", encoding: "base64" }]);
  const tree = m.calls.find(x => x.url.endsWith("/git/trees"))!.body as { base_tree: string; tree: unknown[] };
  expect(tree.base_tree).toBe("t0");
  expect(tree.tree).toEqual([
    { path: "objects/sheets/a.json", mode: "100644", type: "blob", content: "{}" },
    { path: "appcontent/logo.png", mode: "100644", type: "blob", sha: "b1" },
    { path: "objects/sheets/gone.json", mode: "100644", type: "blob", sha: null },
  ]);
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
  const before = m.calls.length;
  await expect(commitFiles(c, "lr-bicc/demo", { branch: "main", parentSha: "p1", message: "m", changes: [] }))
    .rejects.toThrow("Nothing to commit");
  expect(m.calls.length).toBe(before);
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
test("slash branch names, list mappings, non-not-found errors propagate, many blobs", async () => {
  const m = mockFetch({
    [`GET ${R}/git/ref/heads/feature/x`]: () => ({ body: { object: { sha: "c9" } } }),
    [`GET ${R}/git/ref/heads/boom`]: () => ({ status: 403, body: { message: "Forbidden" } }),
    [`GET ${R}/branches?per_page=100`]: () => ({ body: [{ name: "main", commit: { sha: "c1" } }] }),
    [`GET ${R}/tags?per_page=100`]: () => ({ body: [{ name: "v1", commit: { sha: "c1" } }] }),
    [`GET ${R}/commits?sha=feature/x&per_page=30&page=2`]: () => ({ body: [
      { sha: "c1", commit: { message: "m1", author: { name: "A", date: "2026-01-01T00:00:00Z" } } }] }),
    [`GET ${R}/compare/a...b`]: () => ({ body: { status: "ahead", ahead_by: 1, behind_by: 0, commits: [
      { sha: "c2", commit: { message: "m2", author: { name: "B", date: "d" } } }] } }),
    [`GET ${R}/git/commits/p1`]: () => ({ body: { tree: { sha: "t0" } } }),
    [`POST ${R}/git/blobs`]: () => ({ status: 201, body: { sha: "b" } }),
    [`POST ${R}/git/trees`]: () => ({ status: 201, body: { sha: "t1" } }),
    [`POST ${R}/git/commits`]: () => ({ status: 201, body: { sha: "c1" } }),
    [`PATCH ${R}/git/refs/heads/feature/x`]: () => ({ body: {} }),
  });
  const c = createGitHubClient({ token: "t", fetch: m.fetch });
  expect(await getBranchSha(c, "lr-bicc/demo", "feature/x")).toBe("c9");
  await expect(getBranchSha(c, "lr-bicc/demo", "boom")).rejects.toMatchObject({ kind: "forbidden" });
  expect(await listBranches(c, "lr-bicc/demo")).toEqual([{ name: "main", sha: "c1" }]);
  expect(await listTags(c, "lr-bicc/demo")).toEqual([{ name: "v1", sha: "c1" }]);
  expect(await listCommits(c, "lr-bicc/demo", "feature/x", 2)).toEqual([{ sha: "c1", message: "m1", author: "A", date: "2026-01-01T00:00:00Z" }]);
  expect((await compare(c, "lr-bicc/demo", "a", "b")).commits).toEqual([{ sha: "c2", message: "m2", author: "B", date: "d" }]);
  const changes = Array.from({ length: 12 }, (_, i) => ({ path: `f${i}`, content: new Uint8Array([i]) }));
  await commitFiles(c, "lr-bicc/demo", { branch: "feature/x", parentSha: "p1", message: "m", changes });
  expect(m.calls.filter(x => x.url.endsWith("/git/blobs")).length).toBe(12);
});
test("tree entries map each path to the sha of its own blob, even when blobs finish out of order", async () => {
  const changes = [
    { path: "appcontent/a.png", content: new Uint8Array([1]) },
    { path: "appcontent/b.png", content: new Uint8Array([2]) },
    { path: "appcontent/gone.png", content: null },
    { path: "appcontent/logo.png", content: new Uint8Array([1, 2, 3]) },
    { path: "appcontent/c.png", content: new Uint8Array([3]) },
    { path: "appcontent/d.png", content: new Uint8Array([4]) },
    { path: "appcontent/e.png", content: new Uint8Array([5]) },
    { path: "appcontent/f.png", content: new Uint8Array([6]) },
  ];
  const expectedBlobs = changes.filter((ch) => ch.content !== null).length;
  const shaOf = (body: { content: string; encoding: string }) => `sha(${body.encoding}:${body.content})`;
  let inFlight = 0, peak = 0, received = 0;
  let pending: (() => void)[] = [];
  const m = mockFetch({
    [`GET ${R}/git/commits/p1`]: () => ({ body: { tree: { sha: "t0" } } }),
    [`POST ${R}/git/blobs`]: (req) => new Promise((resolve) => {
      inFlight++; received++; peak = Math.max(peak, inFlight);
      pending.push(() => { inFlight--; resolve({ status: 201, body: { sha: shaOf(req.body as { content: string; encoding: string }) } }); });
      // Hold requests until the pool is full (or the last one arrived), then answer newest first.
      if (pending.length === 5 || received === expectedBlobs) {
        const batch = pending.reverse(); pending = [];
        setTimeout(() => batch.forEach((answer) => answer()), 0);
      }
    }),
    [`POST ${R}/git/trees`]: () => ({ status: 201, body: { sha: "t1" } }),
    [`POST ${R}/git/commits`]: () => ({ status: 201, body: { sha: "c1" } }),
    [`PATCH ${R}/git/refs/heads/main`]: () => ({ body: {} }),
  });
  const c = createGitHubClient({ token: "t", fetch: m.fetch });
  await commitFiles(c, "lr-bicc/demo", { branch: "main", parentSha: "p1", message: "m", changes });
  const tree = (m.calls.find(x => x.url.endsWith("/git/trees"))!.body as { tree: unknown[] }).tree;
  const blob = (path: string, sha: string | null) => ({ path, mode: "100644", type: "blob", sha });
  expect(tree).toEqual([
    blob("appcontent/a.png", "sha(base64:AQ==)"),
    blob("appcontent/b.png", "sha(base64:Ag==)"),
    blob("appcontent/gone.png", null),
    blob("appcontent/logo.png", "sha(base64:AQID)"),
    blob("appcontent/c.png", "sha(base64:Aw==)"),
    blob("appcontent/d.png", "sha(base64:BA==)"),
    blob("appcontent/e.png", "sha(base64:BQ==)"),
    blob("appcontent/f.png", "sha(base64:Bg==)"),
  ]);
  expect(received).toBe(expectedBlobs);
  expect(peak).toBeLessThanOrEqual(5);
});

test("a text change is sent inline, without a blob request", async () => {
  const m = mockFetch({
    [`GET ${R}/git/commits/p1`]: () => ({ body: { tree: { sha: "t0" } } }),
    [`POST ${R}/git/trees`]: () => ({ status: 201, body: { sha: "t1" } }),
    [`POST ${R}/git/commits`]: () => ({ status: 201, body: { sha: "c1" } }),
    [`PATCH ${R}/git/refs/heads/main`]: () => ({ body: {} }),
  });
  const c = createGitHubClient({ token: "t", fetch: m.fetch });
  await commitFiles(c, "lr-bicc/demo", { branch: "main", parentSha: "p1", message: "m",
    changes: [{ path: "data_load_script/Main.qvs", content: "///$tab Main\r\nSET a=1;" }] });
  expect(m.calls.some(x => x.url.endsWith("/git/blobs"))).toBe(false);
  expect(m.calls.find(x => x.url.endsWith("/git/trees"))!.body).toEqual({ base_tree: "t0", tree: [
    { path: "data_load_script/Main.qvs", mode: "100644", type: "blob", content: "///$tab Main\r\nSET a=1;" }] });
});
test("large text is split over chained tree requests; deletions travel with their batch", async () => {
  let k = 0;
  const m = mockFetch({
    [`GET ${R}/git/commits/p1`]: () => ({ body: { tree: { sha: "t0" } } }),
    [`POST ${R}/git/trees`]: () => ({ status: 201, body: { sha: `t${++k}` } }),
    [`POST ${R}/git/commits`]: () => ({ status: 201, body: { sha: "c1" } }),
    [`PATCH ${R}/git/refs/heads/main`]: () => ({ body: {} }),
  });
  const c = createGitHubClient({ token: "t", fetch: m.fetch });
  const big = (ch: string) => ch.repeat(600_000);
  await commitFiles(c, "lr-bicc/demo", { branch: "main", parentSha: "p1", message: "m", changes: [
    { path: "a.json", content: big("a") },
    { path: "b.json", content: big("b") },
    { path: "gone.json", content: null },
    { path: "c.json", content: big("c") },
  ] });
  expect(m.calls.some(x => x.url.endsWith("/git/blobs"))).toBe(false);
  const trees = m.calls.filter(x => x.url.endsWith("/git/trees")).map(x => x.body as { base_tree: string; tree: { path: string; sha?: string | null }[] });
  expect(trees.map(t => t.base_tree)).toEqual(["t0", "t1", "t2"]);
  expect(trees.map(t => t.tree.map(e => e.path))).toEqual([["a.json"], ["b.json", "gone.json"], ["c.json"]]);
  expect(trees[1].tree[1]).toEqual({ path: "gone.json", mode: "100644", type: "blob", sha: null });
  expect(m.calls.at(-2)!.body).toEqual({ message: "m", tree: "t3", parents: ["p1"] });
});
test("two 400,000-byte texts share one tree request, the third opens the next", async () => {
  let k = 0;
  const m = mockFetch({
    [`GET ${R}/git/commits/p1`]: () => ({ body: { tree: { sha: "t0" } } }),
    [`POST ${R}/git/trees`]: () => ({ status: 201, body: { sha: `t${++k}` } }),
    [`POST ${R}/git/commits`]: () => ({ status: 201, body: { sha: "c1" } }),
    [`PATCH ${R}/git/refs/heads/main`]: () => ({ body: {} }),
  });
  const c = createGitHubClient({ token: "t", fetch: m.fetch });
  await commitFiles(c, "lr-bicc/demo", { branch: "main", parentSha: "p1", message: "m", changes: [
    { path: "a.json", content: "a".repeat(400_000) },
    { path: "b.json", content: "b".repeat(400_000) },
    { path: "c.json", content: "c".repeat(400_000) },
  ] });
  const trees = m.calls.filter(x => x.url.endsWith("/git/trees")).map(x => x.body as { base_tree: string; tree: { path: string }[] });
  expect(trees.map(t => [t.base_tree, t.tree.map(e => e.path)])).toEqual([["t0", ["a.json", "b.json"]], ["t1", ["c.json"]]]);
  expect(m.calls.at(-2)!.body).toEqual({ message: "m", tree: "t2", parents: ["p1"] });
});
test("a text above 1,000,000 UTF-8 bytes goes through a blob; a tree failure leaves the branch untouched", async () => {
  const huge = "ä".repeat(600_000); // 1,200,000 bytes in UTF-8
  const m = mockFetch({
    [`GET ${R}/git/commits/p1`]: () => ({ body: { tree: { sha: "t0" } } }),
    [`POST ${R}/git/blobs`]: () => ({ status: 201, body: { sha: "b1" } }),
    [`POST ${R}/git/trees`]: () => ({ status: 201, body: { sha: "t1" } }),
    [`POST ${R}/git/commits`]: () => ({ status: 201, body: { sha: "c1" } }),
    [`PATCH ${R}/git/refs/heads/main`]: () => ({ body: {} }),
  });
  const c = createGitHubClient({ token: "t", fetch: m.fetch });
  await commitFiles(c, "lr-bicc/demo", { branch: "main", parentSha: "p1", message: "m", changes: [{ path: "big.json", content: huge }] });
  expect(m.calls.filter(x => x.url.endsWith("/git/blobs")).map(x => x.body)).toEqual([{ content: huge, encoding: "utf-8" }]);
  expect((m.calls.find(x => x.url.endsWith("/git/trees"))!.body as { tree: unknown[] }).tree)
    .toEqual([{ path: "big.json", mode: "100644", type: "blob", sha: "b1" }]);

  let k = 0;
  const failing = mockFetch({
    [`GET ${R}/git/commits/p1`]: () => ({ body: { tree: { sha: "t0" } } }),
    [`POST ${R}/git/trees`]: () => (++k === 2 ? { status: 500, body: { message: "boom" } } : { status: 201, body: { sha: "t1" } }),
  });
  const c2 = createGitHubClient({ token: "t", fetch: failing.fetch });
  await expect(commitFiles(c2, "lr-bicc/demo", { branch: "main", parentSha: "p1", message: "m", changes: [
    { path: "a.json", content: "a".repeat(600_000) }, { path: "b.json", content: "b".repeat(600_000) }] })).rejects.toBeInstanceOf(Error);
  expect(failing.calls.some(x => x.method === "PATCH" || x.url.endsWith("/git/commits"))).toBe(false);
});

test("getRepo returns name and default branch, null when missing", async () => {
  const m = mockFetch({ [`GET ${R}`]: () => ({ body: { full_name: "lr-bicc/app", default_branch: "main" } }) });
  const c = createGitHubClient({ token: "t", fetch: m.fetch });
  expect(await getRepo(c, "lr-bicc/demo")).toEqual({ repo: "lr-bicc/app", defaultBranch: "main" });
  expect(await getRepo(c, "lr-bicc/other")).toBeNull();
});
test("readTextFile decodes base64 as UTF-8, encodes the path per segment, null on 404, rethrows other errors", async () => {
  const m = mockFetch({
    [`GET ${R}/contents/docs/My%20File.md?ref=main`]: () => ({ body: { content: "w6Rw\nZmVs\n", encoding: "base64" } }),
    [`GET ${R}/contents/secret.md?ref=main`]: () => ({ status: 403, body: { message: "Forbidden" } }),
  });
  const c = createGitHubClient({ token: "t", fetch: m.fetch });
  expect(await readTextFile(c, "lr-bicc/demo", "main", "docs/My File.md")).toBe("äpfel");
  expect(await readTextFile(c, "lr-bicc/demo", "main", "missing.md")).toBeNull();
  await expect(readTextFile(c, "lr-bicc/demo", "main", "secret.md")).rejects.toBeInstanceOf(Error);
});
test("whoAmI returns the login", async () => {
  const m = mockFetch({ ["GET /user"]: () => ({ body: { login: "octocat", id: 1 } }) });
  const c = createGitHubClient({ token: "t", fetch: m.fetch });
  expect(await whoAmI(c)).toEqual({ login: "octocat" });
});

test("markRepo adds the qommit topic and keeps the existing ones", async () => {
  const m = mockFetch({
    [`GET ${R}/topics`]: () => ({ body: { names: ["qlik", "finance"] } }),
    [`PUT ${R}/topics`]: (req) => ({ body: req.body }),
  });
  await markRepo(createGitHubClient({ token: "t", fetch: m.fetch }), "lr-bicc/demo");
  expect(m.calls.find((x) => x.method === "PUT")!.body).toEqual({ names: ["qlik", "finance", "qommit"] });
});
test("markRepo writes nothing when the topic is already set", async () => {
  const m = mockFetch({ [`GET ${R}/topics`]: () => ({ body: { names: ["qommit"] } }) });
  await markRepo(createGitHubClient({ token: "t", fetch: m.fetch }), "lr-bicc/demo");
  expect(m.calls.map((x) => x.method)).toEqual(["GET"]);
});
