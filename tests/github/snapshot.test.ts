import { zipSync, strToU8 } from "fflate";
import { downloadSnapshot, createRepo, findRepoForApp, listOrgRepos } from "../../src/github/snapshot";
import type { GitHubClient } from "../../src/github/client";

const fake = (over: Partial<GitHubClient>): GitHubClient => ({
  rest: async () => { throw new Error("unexpected rest"); },
  raw: async () => { throw new Error("unexpected raw"); },
  graphql: async () => { throw new Error("unexpected graphql"); }, ...over });

test("unzips a snapshot, strips the top folder, keeps binaries and line endings", async () => {
  const zip = zipSync({ "lr-bicc-demo-abc123/": new Uint8Array(0),
    "lr-bicc-demo-abc123/data_load_script/Main.qvs": strToU8("///$tab Main\r\nSET a=1;"),
    "lr-bicc-demo-abc123/objects/appprops.json": strToU8("[]"),
    "lr-bicc-demo-abc123/appcontent/logo.png": new Uint8Array([137, 80]) });
  const files = await downloadSnapshot(fake({ raw: async p => { expect(p).toBe("/repos/lr-bicc/demo/zipball/abc123"); return zip; } }), "lr-bicc/demo", "abc123");
  expect([...files.keys()].sort()).toEqual(["appcontent/logo.png", "data_load_script/Main.qvs", "objects/appprops.json"]);
  expect(files.get("data_load_script/Main.qvs")).toBe("///$tab Main\r\nSET a=1;");
  expect(files.get("appcontent/logo.png")).toEqual(new Uint8Array([137, 80]));
});
test("creates a private, initialized repository", async () => {
  let sent: unknown;
  const r = await createRepo(fake({ rest: (async (_m: string, p: string, b: unknown) => { expect(p).toBe("/orgs/lr-bicc/repos"); sent = b;
    return { full_name: "lr-bicc/demo", default_branch: "main" }; }) as GitHubClient["rest"] }), "lr-bicc", "demo");
  expect(sent).toEqual({ name: "demo", private: true, auto_init: true });
  expect(r).toEqual({ repo: "lr-bicc/demo", defaultBranch: "main" });
});
test("finds the repository and branch of an app across pages", async () => {
  const id = "cb1d418c-c2cd-4134-8b8d-bcef3a9a224d";
  const table = `Branch Name|Qlik application\n---|---\nfeature|[u](https://qs.example.com/qs/sense/app/${id})`;
  const page = (nodes: unknown[], next: string | null) => ({ organization: { repositories: {
    pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } } });
  const c = fake({ graphql: (async (_q: string, v: Record<string, unknown>) => v.cursor == null
    ? page([{ nameWithOwner: "lr-bicc/other", defaultBranchRef: { name: "main" }, object: null }], "c1")
    : page([{ nameWithOwner: "lr-bicc/demo", defaultBranchRef: { name: "main" }, object: { text: table } }], null)) as GitHubClient["graphql"] });
  expect(await findRepoForApp(c, "lr-bicc", id)).toEqual({ repo: "lr-bicc/demo", branch: "feature" });
  expect(await findRepoForApp(c, "lr-bicc", "00000000-0000-4000-8000-000000000000")).toBeNull();
});
test("the repository pager stops when GitHub sends no end cursor", async () => {
  let calls = 0;
  const c = fake({ graphql: (async () => {
    if (++calls > 3) throw new Error("pager did not stop");
    return { organization: { repositories: { pageInfo: { hasNextPage: true, endCursor: null },
      nodes: [{ nameWithOwner: "lr-bicc/demo", defaultBranchRef: { name: "main" }, object: null }] } } };
  }) as GitHubClient["graphql"] });
  expect(await listOrgRepos(c, "lr-bicc")).toEqual([{ repo: "lr-bicc/demo", defaultBranch: "main", marked: false }]);
  expect(calls).toBe(1);
});
test("listOrgRepos tells which repositories carry the qommit topic", async () => {
  const c = fake({ graphql: (async () => ({ organization: { repositories: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
    { nameWithOwner: "lr-bicc/sales", defaultBranchRef: { name: "main" }, object: null, repositoryTopics: { nodes: [{ topic: { name: "finance" } }, { topic: { name: "qommit" } }] } },
    { nameWithOwner: "lr-bicc/pyrunner", defaultBranchRef: { name: "main" }, object: null, repositoryTopics: { nodes: [] } },
    { nameWithOwner: "lr-bicc/empty", defaultBranchRef: null, object: null, repositoryTopics: { nodes: [] } },
  ] } } })) as GitHubClient["graphql"] });
  expect(await listOrgRepos(c, "lr-bicc")).toEqual([
    { repo: "lr-bicc/sales", defaultBranch: "main", marked: true },
    { repo: "lr-bicc/pyrunner", defaultBranch: "main", marked: false },
  ]);
});
