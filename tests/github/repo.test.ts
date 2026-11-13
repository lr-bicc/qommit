import { commitFiles, getTree, getBranchSha, createBranch, compare, createTag, isValidRefName, listBranches, listTags, listCommits, getRepo, readTextFile, whoAmI } from "../../src/github/repo";
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
  const changes = Array.from({ length: 12 }, (_, i) => ({ path: `f${i}`, content: "x" }));
  await commitFiles(c, "lr-bicc/demo", { branch: "feature/x", parentSha: "p1", message: "m", changes });
  expect(m.calls.filter(x => x.url.endsWith("/git/blobs")).length).toBe(12);
});
test("tree entries map each path to the sha of its own blob, even when blobs finish out of order", async () => {
  const changes = [
    { path: "objects/sheets/a.json", content: "{\"a\":1}" },
    { path: "objects/sheets/b.json", content: "{\"b\":2}" },
    { path: "objects/sheets/gone.json", content: null },
    { path: "appcontent/logo.png", content: new Uint8Array([1, 2, 3]) },
    { path: "data_load_script/Main.qvs", content: "///$tab Main\r\nSET a=1;" },
    { path: "objects/measures/m.json", content: "{\"m\":3}" },
    { path: "objects/variables/v.json", content: "{\"v\":4}" },
    { path: "objects/dimensions/d.json", content: "{\"d\":5}" },
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
    blob("objects/sheets/a.json", "sha(utf-8:{\"a\":1})"),
    blob("objects/sheets/b.json", "sha(utf-8:{\"b\":2})"),
    blob("objects/sheets/gone.json", null),
    blob("appcontent/logo.png", "sha(base64:AQID)"),
    blob("data_load_script/Main.qvs", "sha(utf-8:///$tab Main\r\nSET a=1;)"),
    blob("objects/measures/m.json", "sha(utf-8:{\"m\":3})"),
    blob("objects/variables/v.json", "sha(utf-8:{\"v\":4})"),
    blob("objects/dimensions/d.json", "sha(utf-8:{\"d\":5})"),
  ]);
  expect(received).toBe(expectedBlobs);
  expect(peak).toBeLessThanOrEqual(5);
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
