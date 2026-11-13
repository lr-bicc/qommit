import { handleGateway } from "../../src/ext/background/gateway";
import { createGitHubPort, GatewayError } from "../../src/ext/shared/github-port";
import { mockFetch } from "../github/mock-fetch";

let token = "ghp_secret123";
function setup(routes: Parameters<typeof mockFetch>[0] = {}) {
  const m = mockFetch(routes);
  const deps = { loadOptions: async () => ({ org: "lr-bicc", repoPrefix: "", servers: [] }), loadToken: async () => token, fetch: m.fetch };
  const port = createGitHubPort((r) => handleGateway(JSON.parse(JSON.stringify(r)), deps).then((x) => JSON.parse(JSON.stringify(x))));
  return { m, deps, port };
}
beforeEach(() => { token = "ghp_secret123"; });

test("empty token is answered with no-token and no fetch", async () => {
  token = "";
  const { m, deps } = setup();
  const res = await handleGateway({ op: "whoAmI", args: [] }, deps);
  expect(res).toMatchObject({ ok: false, error: { kind: "no-token" } });
  expect(m.calls.length).toBe(0);
});

test("unknown ops, foreign orgs and badly typed arguments are not allowed", async () => {
  const { m, deps } = setup({ "GET /repos/LR-BICC/app/git/ref/heads/main": () => ({ body: { object: { sha: "c1" } } }) });
  for (const request of [
    { op: "deleteRepo", args: [] },
    { op: "getBranchSha", args: ["other-org/app", "main"] },
    { op: "getBranchSha", args: ["lr-bicc/app/../x", "main"] },
    { op: "getBranchSha", args: ["lr-bicc/", "main"] },
    { op: "getBranchSha", args: [42, "main"] },
    { op: "getBranchSha", args: ["lr-bicc/app"] },
    { op: "getBranchSha", args: undefined },
    { op: "findRepoForApp", args: [{}] },
    { op: "commitFiles", args: ["lr-bicc/app", { branch: "b", parentSha: "p", message: "m", changes: [{ path: "a", content: { nope: 1 } }] }] },
  ]) {
    expect(await handleGateway(request as never, deps)).toMatchObject({ ok: false, error: { kind: "not-allowed" } });
  }
  // unknown op wins over an empty token
  token = "";
  expect(await handleGateway({ op: "deleteRepo" as never, args: [] }, deps)).toMatchObject({ error: { kind: "not-allowed" } });
  expect(m.calls.length).toBe(0);
  token = "ghp_secret123";
  const ok = await handleGateway({ op: "getBranchSha", args: ["LR-BICC/app", "main"] }, deps);
  expect(ok).toEqual({ ok: true, value: "c1" });
});

test("getTree crosses the wire as entries and comes back as a Map", async () => {
  const { port } = setup({ "GET /repos/lr-bicc/app/git/trees/c0ffee?recursive=1": () => ({ body: { truncated: false, tree: [{ path: "a.json", type: "blob", sha: "s1" }] } }) });
  const tree = await port.getTree("lr-bicc/app", "c0ffee");
  expect(tree).toBeInstanceOf(Map);
  expect([...tree]).toEqual([["a.json", "s1"]]);
});

test("commitFiles sends binary as base64 and deletions as null sha", async () => {
  const R = "/repos/lr-bicc/app";
  const { m, port } = setup({
    [`GET ${R}/git/commits/abc123`]: () => ({ body: { tree: { sha: "t0" } } }),
    [`POST ${R}/git/blobs`]: () => ({ status: 201, body: { sha: "b1" } }),
    [`POST ${R}/git/trees`]: () => ({ status: 201, body: { sha: "t1" } }),
    [`POST ${R}/git/commits`]: () => ({ status: 201, body: { sha: "c1" } }),
    [`PATCH ${R}/git/refs/heads/main`]: () => ({ body: {} }),
  });
  const sha = await port.commitFiles("lr-bicc/app", { branch: "main", parentSha: "abc123", message: "m", changes: [
    { path: "appcontent/a.png", content: new Uint8Array([1, 2, 3]) },
    { path: "gone.json", content: null },
  ] });
  expect(sha).toBe("c1");
  expect(m.calls.find((c) => c.url.endsWith("/git/blobs"))!.body).toEqual({ content: "AQID", encoding: "base64" });
  const tree = m.calls.find((c) => c.url.endsWith("/git/trees"))!.body as { tree: { path: string; sha: string | null }[] };
  expect(tree.tree.find((e) => e.path === "gone.json")!.sha).toBeNull();
});

test("org-level operations use the org from the options", async () => {
  const { port } = setup({
    "POST /graphql": (req) => {
      expect((req.body as { variables: { org: string } }).variables.org).toBe("lr-bicc");
      return { body: { data: { organization: { repositories: { pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ nameWithOwner: "lr-bicc/x", defaultBranchRef: { name: "main" }, object: null }] } } } } };
    },
    "GET /user": () => ({ body: { login: "rumen" } }),
  });
  expect(await port.whoAmI()).toEqual({ login: "rumen" });
  expect(await port.listOrgRepos()).toEqual([{ repo: "lr-bicc/x", defaultBranch: "main" }]);
});

test("a 401 becomes a GatewayError without the token", async () => {
  const { port } = setup({ "GET /repos/lr-bicc/app/git/ref/heads/main": () => ({ status: 401, body: { message: "Bad credentials" } }) });
  const err = await port.getBranchSha("lr-bicc/app", "main").catch((e) => e);
  expect(err).toBeInstanceOf(GatewayError);
  expect(err.kind).toBe("unauthorized");
  expect(err.message).not.toContain("ghp_secret123");
});

test("rate limit reset and sso url survive; other errors become internal", async () => {
  const reset = Math.floor(Date.now() / 1000) + 60;
  const { port } = setup({
    "GET /repos/lr-bicc/a/git/ref/heads/main": () => ({ status: 403, body: { message: "rate limit" }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } }),
    "GET /repos/lr-bicc/b/git/ref/heads/main": () => ({ status: 403, body: { message: "sso" }, headers: { "x-github-sso": "required; url=https://github.com/sso/x" } }),
  });
  const a = await port.getBranchSha("lr-bicc/a", "main").catch((e) => e);
  expect(a).toMatchObject({ kind: "rate-limited", extra: { resetAt: reset * 1000 } });
  const b = await port.getBranchSha("lr-bicc/b", "main").catch((e) => e);
  expect(b).toMatchObject({ kind: "sso-required", extra: { ssoUrl: "https://github.com/sso/x" } });
  const c = await port.commitFiles("lr-bicc/a", { branch: "main", parentSha: "abc123", message: "m", changes: [] }).catch((e) => e);
  expect(c).toMatchObject({ kind: "internal" });
});

test("traversal and malformed refs, shas, paths and names are rejected before any fetch", async () => {
  const { m, deps } = setup();
  const commit = (over: Record<string, unknown>) => ({ op: "commitFiles", args: ["lr-bicc/app", { branch: "main", parentSha: "abc123", message: "m", changes: [{ path: "a.json", content: { text: "x" } }], ...over }] });
  const bad = [
    { op: "getTree", args: ["lr-bicc/app", "../../../../../repos/other-org/priv/git/trees/abc123"] },
    { op: "getBranchSha", args: ["lr-bicc/app", "../../../x"] },
    { op: "getBranchSha", args: ["lr-bicc/app", "a?b"] },
    { op: "readTextFile", args: ["lr-bicc/app", "../../x", "a.json"] },
    { op: "readTextFile", args: ["lr-bicc/app", "main", "a/../../b.json"] },
    { op: "readTextFile", args: ["lr-bicc/app", "main", "/abs.json"] },
    { op: "compare", args: ["lr-bicc/app", "../x", "main"] },
    { op: "compare", args: ["lr-bicc/app", "main", "a\\b"] },
    { op: "listCommits", args: ["lr-bicc/app", "a#b", 1] },
    { op: "createBranch", args: ["lr-bicc/app", "x", "../y"] },
    { op: "createBranch", args: ["lr-bicc/app", "a//b", "abc123"] },
    commit({ parentSha: "../../x" }),
    commit({ changes: [{ path: "a/../../b.json", content: null }] }),
    commit({ branch: ".." }),
    { op: "getRepo", args: ["lr-bicc/.."] },
    { op: "getRepo", args: ["lr-bicc/."] },
    { op: "createRepo", args: [".."] },
    { op: "createRepo", args: ["a/b"] },
  ];
  for (const request of bad) {
    expect(await handleGateway(request as never, deps), JSON.stringify(request)).toMatchObject({ ok: false, error: { kind: "not-allowed" } });
  }
  expect(m.calls.length).toBe(0);
});

test("branch names and paths with slashes, spaces and non-ASCII letters still reach fetch", async () => {
  const { m, deps } = setup();
  await handleGateway({ op: "getBranchSha", args: ["lr-bicc/app", "feature/währung"] }, deps);
  await handleGateway({ op: "readTextFile", args: ["lr-bicc/app", "main", "appcontent/Stock Availability.png"] }, deps);
  await handleGateway({ op: "readTextFile", args: ["lr-bicc/app", "v1.0", "data_load_script/Überblick.qvs"] }, deps);
  expect(m.calls.length).toBe(3);
});
