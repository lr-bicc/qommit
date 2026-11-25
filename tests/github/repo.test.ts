import { commitFiles, getTree, getBranchSha, createBranch, compare, createTag, isValidRefName, listBranches, listTags, listCommits, getRepo, markRepo, readTextFile, whoAmI, readBlobs, MAX_BLOBS_PER_CALL } from "../../src/github/repo";
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
test("replacing the first commit: a commit without parents, forced onto the branch", async () => {
  const m = mockFetch({
    [`GET ${R}/git/commits/p1`]: () => ({ body: { tree: { sha: "t0" }, parents: [] } }),
    [`POST ${R}/git/trees`]: () => ({ status: 201, body: { sha: "t1" } }),
    [`POST ${R}/git/commits`]: () => ({ status: 201, body: { sha: "c1" } }),
    [`PATCH ${R}/git/refs/heads/main`]: () => ({ body: {} }),
  });
  const c = createGitHubClient({ token: "t", fetch: m.fetch });
  expect(await commitFiles(c, "lr-bicc/demo", { branch: "main", parentSha: "p1", message: "Initial commit",
    changes: [{ path: "README.md", content: "# x" }], replaceRoot: true })).toBe("c1");
  expect(m.calls.at(-2)!.body).toEqual({ message: "Initial commit", tree: "t1", parents: [] });
  expect(m.calls.at(-1)!.body).toEqual({ sha: "c1", force: true });
});
test("only a first commit can be replaced", async () => {
  const m = mockFetch({
    [`GET ${R}/git/commits/p1`]: () => ({ body: { tree: { sha: "t0" }, parents: [{ sha: "p0" }] } }),
  });
  const c = createGitHubClient({ token: "t", fetch: m.fetch });
  await expect(commitFiles(c, "lr-bicc/demo", { branch: "main", parentSha: "p1", message: "m",
    changes: [{ path: "a", content: "x" }], replaceRoot: true })).rejects.toThrow("not the first commit");
  expect(m.calls.length).toBe(1);
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
    [`GET ${R}/branches?per_page=100&page=1`]: () => ({ body: [{ name: "main", commit: { sha: "c1" } }] }),
    [`GET ${R}/commits?sha=feature/x&per_page=30&page=2`]: () => ({ body: [
      { sha: "c1", parents: [{ sha: "c0" }], commit: { message: "m1", author: { name: "A", date: "2026-01-01T00:00:00Z" } } }] }),
    [`GET ${R}/compare/a...b`]: () => ({ body: { status: "ahead", ahead_by: 1, behind_by: 0, commits: [
      { sha: "c2", parents: [], commit: { message: "m2", author: { name: "B", date: "d" } } }] } }),
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
  expect(await listCommits(c, "lr-bicc/demo", "feature/x", 2)).toEqual([{ sha: "c1", message: "m1", author: "A", date: "2026-01-01T00:00:00Z", parents: ["c0"] }]);
  expect((await compare(c, "lr-bicc/demo", "a", "b")).commits).toEqual([{ sha: "c2", message: "m2", author: "B", date: "d", parents: [] }]);
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

const S = "lr-bicc/sales";
const SR = "/repos/lr-bicc/sales";
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

test("listCommits returns the parents of each commit", async () => {
  const m = mockFetch({ [`GET ${SR}/commits?sha=main&per_page=30&page=1`]: () => ({ body: [
    { sha: "b", parents: [{ sha: "a" }], commit: { message: "m", author: { name: "A", date: "d" } } }] }) });
  const c = createGitHubClient({ token: "t", fetch: m.fetch });
  expect((await listCommits(c, S, "main", 1))[0].parents).toEqual(["a"]);
});
test("listBranches reads every page", async () => {
  const branch = (i: number) => ({ name: `b${i}`, commit: { sha: `s${i}` } });
  const m = mockFetch({
    [`GET ${SR}/branches?per_page=100&page=1`]: () => ({ body: Array.from({ length: 100 }, (_, i) => branch(i)) }),
    [`GET ${SR}/branches?per_page=100&page=2`]: () => ({ body: Array.from({ length: 3 }, (_, i) => branch(100 + i)) }),
  });
  const c = createGitHubClient({ token: "t", fetch: m.fetch });
  const all = await listBranches(c, S);
  expect(all.length).toBe(103);
  expect(all[102]).toEqual({ name: "b102", sha: "s102" });
  expect(m.calls.length).toBe(2);
});
test("listTags reads annotated and lightweight tags over all pages", async () => {
  const m = mockFetch({ "POST /graphql": (req) => {
    const v = (req.body as { variables: Record<string, unknown> }).variables;
    return v.cursor == null
      ? { body: { data: { repository: { refs: { pageInfo: { hasNextPage: true, endCursor: "cur1" }, nodes: [
        { name: "v1", target: { __typename: "Tag", oid: "t1", message: "first", tagger: { date: "2026-01-01T00:00:00Z" }, target: { oid: "c1" } } }] } } } } }
      : { body: { data: { repository: { refs: { pageInfo: { hasNextPage: false, endCursor: "cur2" }, nodes: [
        { name: "v0", target: { __typename: "Commit", oid: "c0", committedDate: "2025-12-01T00:00:00Z" } }] } } } } };
  } });
  const c = createGitHubClient({ token: "t", fetch: m.fetch });
  expect(await listTags(c, S)).toEqual([
    { name: "v1", sha: "c1", date: "2026-01-01T00:00:00Z", message: "first" },
    { name: "v0", sha: "c0", date: "2025-12-01T00:00:00Z", message: "" },
  ]);
  const vars = m.calls.map((x) => (x.body as { variables: Record<string, unknown> }).variables);
  expect(vars[0]).toMatchObject({ owner: "lr-bicc", name: "sales" });
  expect(vars[0].cursor ?? null).toBeNull();
  expect(vars[1]).toMatchObject({ owner: "lr-bicc", name: "sales", cursor: "cur1" });
});
test("listTags stops on a null cursor instead of restarting", async () => {
  const m = mockFetch({ "POST /graphql": () => ({ body: { data: { repository: { refs: {
    pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] } } } } }) });
  const c = createGitHubClient({ token: "t", fetch: m.fetch });
  expect(await listTags(c, S)).toEqual([]);
  expect(m.calls.length).toBe(1);
});
test("readBlobs decodes text with its BOM and appcontent as bytes", async () => {
  const m = mockFetch({
    [`GET ${SR}/git/blobs/s1`]: () => ({ body: { encoding: "base64", content: b64([0xef, 0xbb, 0xbf, 0x61, 0x0a]) } }),
    [`GET ${SR}/git/blobs/s2`]: () => ({ body: { encoding: "base64", content: b64([0, 255]) } }),
  });
  const c = createGitHubClient({ token: "t", fetch: m.fetch });
  const files = await readBlobs(c, S, [{ path: "data_load_script/Main.qvs", sha: "s1" }, { path: "appcontent/a.png", sha: "s2" }]);
  expect(files.get("data_load_script/Main.qvs")).toBe("\ufeffa\n");
  expect(files.get("appcontent/a.png")).toEqual(new Uint8Array([0, 255]));
});
test("readBlobs refuses more than 100 items and stops starting requests after a failure", async () => {
  const slowOk = () => new Promise<{ body: unknown }>((r) => setTimeout(() => r({ body: { encoding: "base64", content: "YQ==" } }), 5));
  const routes: Record<string, () => unknown> = { [`GET ${SR}/git/blobs/s0`]: () => ({ status: 500, body: { message: "boom" } }) };
  for (let i = 1; i < 20; i++) routes[`GET ${SR}/git/blobs/s${i}`] = slowOk;
  const m = mockFetch(routes as Parameters<typeof mockFetch>[0]);
  const c = createGitHubClient({ token: "t", fetch: m.fetch });
  expect(MAX_BLOBS_PER_CALL).toBe(100);
  await expect(readBlobs(c, S, Array.from({ length: 101 }, (_, i) => ({ path: `p${i}`, sha: "s" })))).rejects.toThrow("Too many blobs");
  expect(m.calls.length).toBe(0);
  const items = Array.from({ length: 20 }, (_, i) => ({ path: `p${i}`, sha: `s${i}` }));
  await expect(readBlobs(c, S, items)).rejects.toThrow();
  await new Promise((r) => setTimeout(r, 50)); // let the other workers' in-flight requests finish and loop
  expect(m.calls.length).toBeLessThanOrEqual(8);
});
test("readBlobs runs at most 8 requests at a time and reads them all", async () => {
  let inFlight = 0, peak = 0;
  const routes: Record<string, () => unknown> = {};
  for (let i = 0; i < 30; i++) routes[`GET ${SR}/git/blobs/s${i}`] = () => new Promise((resolve) => {
    inFlight++; peak = Math.max(peak, inFlight);
    setTimeout(() => { inFlight--; resolve({ body: { encoding: "base64", content: "YQ==" } }); }, 2);
  });
  const m = mockFetch(routes as Parameters<typeof mockFetch>[0]);
  const c = createGitHubClient({ token: "t", fetch: m.fetch });
  const files = await readBlobs(c, S, Array.from({ length: 30 }, (_, i) => ({ path: `p${i}`, sha: `s${i}` })));
  expect(files.size).toBe(30);
  expect(peak).toBe(8);
});
test("readBlobs reads JSON files in one GraphQL query and falls back to REST for what it does not return in full", async () => {
  const m = mockFetch({
    "POST /graphql": (req) => {
      const { query, variables } = req.body as { query: string; variables: Record<string, string> };
      expect(query).toContain("on Blob");
      expect(variables).toMatchObject({ owner: "lr-bicc", name: "sales", o0: "j1", o1: "j2", o2: "j3" });
      return { body: { data: { repository: {
        b0: { text: '{"a":1}', isTruncated: false, isBinary: false },
        b1: { text: '{"b":', isTruncated: true, isBinary: false },
        b2: null,
      } } } };
    },
    [`GET ${SR}/git/blobs/j2`]: () => ({ body: { encoding: "base64", content: btoa('{"b":2}') } }),
    [`GET ${SR}/git/blobs/j3`]: () => ({ body: { encoding: "base64", content: btoa('{"c":3}') } }),
    [`GET ${SR}/git/blobs/s1`]: () => ({ body: { encoding: "base64", content: btoa("x") } }),
  });
  const c = createGitHubClient({ token: "t", fetch: m.fetch });
  const files = await readBlobs(c, S, [
    { path: "objects/a.json", sha: "j1" }, { path: "objects/b.json", sha: "j2" }, { path: "objects/c.json", sha: "j3" },
    { path: "data_load_script/Main.qvs", sha: "s1" },
  ]);
  expect([...files].sort()).toEqual([
    ["data_load_script/Main.qvs", "x"], ["objects/a.json", '{"a":1}'], ["objects/b.json", '{"b":2}'], ["objects/c.json", '{"c":3}'],
  ]);
  expect(m.calls.filter((r) => r.url.endsWith("/graphql"))).toHaveLength(1);
  expect(m.calls.filter((r) => r.url.includes("/git/blobs/")).map((r) => r.url.slice(r.url.lastIndexOf("/") + 1)).sort()).toEqual(["j2", "j3", "s1"]);
});
