import { parseBranchTable } from "../../src/core/repo-layout";
import { FlowError } from "../../src/ext/flows/ports";
import { connectRepository, createBranchForCopy, createRepository, suggestBranchName, unlinkApp } from "../../src/ext/flows/setup";
import { APP_ID } from "../fixtures/snapshot";
import { fakePorts } from "./fake-ports";
import { legacyRepo } from "./helpers";

const URL = `https://qlik.example.com/qs/sense/app/${APP_ID}`;
const readme = (github: ReturnType<typeof fakePorts>["github"], sha: string) => github.filesAt("lr-bicc/sales", sha).get("README.md") as string;

test("create repository commits the app and a readme with the branch table", async () => {
  const { ports, github, app } = fakePorts({ info: { title: "📝 Sales Überblick" } });
  const link = await createRepository(ports, {});
  expect(link.repo).toBe("lr-bicc/sales-ueberblick");
  const files = github.filesAt(link.repo, link.syncedSha);
  expect(parseBranchTable(files.get("README.md") as string)).toEqual([{ branch: "main", appUrl: URL, appId: APP_ID }]);
  expect(files.has("data_load_script/tab_order.txt")).toBe(true);
  expect(github.messageOf(link.repo, link.syncedSha)).toBe("Initial commit");
  expect(app.link).toEqual({ repo: link.repo, branch: "main", appId: APP_ID, syncedSha: github.head(link.repo, "main") });
});

test("the readme lists the sheets ordered by rank", async () => {
  const { ports, github, app } = fakePorts();
  const sheet = (id: string, title: string, rank?: unknown, description?: string) => ({
    qProperty: { qInfo: { qId: id, qType: "sheet" }, qMetaDef: { title, ...(description === undefined ? {} : { description }) }, ...(rank === undefined ? {} : { rank }) },
    qChildren: [],
  });
  app.snapshot.sheets = [sheet("a", "Second", 2, "two"), sheet("b", "First", 1), sheet("c", "Unranked")];
  const link = await createRepository(ports, {});
  const text = github.filesAt(link.repo, link.syncedSha).get("README.md") as string;
  expect(text).toContain("First|\nSecond|two\nUnranked|\n");
  expect(text).toContain("Created by octocat at 2026-01-02T03:04:05.000Z");
});

test("an existing repository name is reported with a suggestion", async () => {
  const { ports, github, app } = fakePorts();
  github.seed("lr-bicc/sales", new Map([["README.md", "x"]]));
  await expect(createRepository(ports, {})).rejects.toMatchObject({ code: "repo-exists", detail: { name: "sales", suggestion: "sales-11111111" } });
  expect(app.link).toBeNull();
  expect((await createRepository(ports, { name: "sales-11111111" })).repo).toBe("lr-bicc/sales-11111111");
});

test("create branch for a copy keeps the source's synced commit when it is in the history", async () => {
  const { ports, github } = fakePorts();
  const first = legacyRepo(github);
  const source = { repo: "lr-bicc/sales", branch: "main", syncedSha: first };
  const link = await createBranchForCopy(ports, { source, name: "feature/x", fromSource: false });
  const head = github.head("lr-bicc/sales", "feature/x");
  expect(github.messageOf("lr-bicc/sales", head)).toBe("Update branches table");
  expect(github.head("lr-bicc/sales", "main")).toBe(head);
  expect(link).toEqual({ repo: "lr-bicc/sales", branch: "feature/x", appId: APP_ID, syncedSha: first });
  const rows = parseBranchTable(readme(github, head));
  expect(rows.find((r) => r.branch === "feature/x")?.appId).toBe(APP_ID);
});

test("a synced commit outside the new branch's history is replaced by the branch head", async () => {
  const { ports, github } = fakePorts();
  const first = legacyRepo(github);
  void first;
  const unrelated = github.seed("lr-bicc/sales2", new Map([["a", "1"]]));
  const link = await createBranchForCopy(ports, {
    source: { repo: "lr-bicc/sales", branch: "main", syncedSha: unrelated }, name: "dev", fromSource: false,
  });
  expect(link.syncedSha).toBe(github.head("lr-bicc/sales", "dev"));
});

test("fromSource branches off the source branch, the row still lands on main", async () => {
  const { ports, github } = fakePorts();
  const first = legacyRepo(github);
  const tip = await github.commitFiles("lr-bicc/sales", { branch: "main", parentSha: first, message: "m", changes: [{ path: "x.txt", content: "x" }] });
  await github.createBranch("lr-bicc/sales", "feat", first);
  const link = await createBranchForCopy(ports, { source: { repo: "lr-bicc/sales", branch: "feat", syncedSha: first }, name: "copy", fromSource: true });
  expect(github.head("lr-bicc/sales", "copy")).toBe(first);
  expect(link.syncedSha).toBe(first);
  const main = github.head("lr-bicc/sales", "main");
  expect(main).not.toBe(tip);
  expect(github.messageOf("lr-bicc/sales", main)).toBe("Update branches table");
  expect(parseBranchTable(readme(github, main)).some((r) => r.branch === "copy" && r.appId === APP_ID)).toBe(true);
});

test("fromSource falls back to the default branch when the source branch is gone", async () => {
  const { ports, github } = fakePorts();
  const first = legacyRepo(github);
  const link = await createBranchForCopy(ports, { source: { repo: "lr-bicc/sales", branch: "gone", syncedSha: first }, name: "copy", fromSource: true });
  expect(github.head("lr-bicc/sales", "copy")).toBe(github.head("lr-bicc/sales", "main"));
  expect(link.syncedSha).toBe(first);
});

test("nothing is written when the branch name is taken or invalid", async () => {
  const { ports, github, app } = fakePorts();
  const first = legacyRepo(github);
  const source = { repo: "lr-bicc/sales", branch: "main", syncedSha: first };
  const before = github.commitCount("lr-bicc/sales");
  await expect(createBranchForCopy(ports, { source, name: "main", fromSource: false })).rejects.toMatchObject({ code: "branch-exists" });
  await expect(createBranchForCopy(ports, { source, name: "a..b", fromSource: false })).rejects.toMatchObject({ code: "invalid-branch-name" });
  expect(github.commitCount("lr-bicc/sales")).toBe(before);
  expect(app.link).toBeNull();
});

test("with a protected default branch the table row lands on the new branch", async () => {
  const { ports, github } = fakePorts();
  const first = legacyRepo(github);
  github.protect("lr-bicc/sales", "main");
  const link = await createBranchForCopy(ports, { source: { repo: "lr-bicc/sales", branch: null, syncedSha: first }, name: "dev", fromSource: false });
  expect(github.head("lr-bicc/sales", "main")).toBe(first);
  expect(github.messageOf("lr-bicc/sales", github.head("lr-bicc/sales", "dev"))).toBe("Update branches table");
  expect(link.syncedSha).toBe(first);
});

test("connect as a new branch", async () => {
  const { ports, github, app } = fakePorts();
  const first = legacyRepo(github);
  const link = await connectRepository(ports, { repo: "lr-bicc/sales", mode: "new-branch", branch: "r.vasilev" });
  const head = github.head("lr-bicc/sales", "r.vasilev");
  expect(head).toBe(github.head("lr-bicc/sales", "main"));
  expect(head).not.toBe(first);
  expect(link).toEqual({ repo: "lr-bicc/sales", branch: "r.vasilev", appId: APP_ID, syncedSha: head });
  expect(app.link).toEqual(link);
});

test("connect as a new branch with a protected default branch", async () => {
  const { ports, github } = fakePorts();
  const first = legacyRepo(github);
  github.protect("lr-bicc/sales", "main");
  const link = await connectRepository(ports, { repo: "lr-bicc/sales", mode: "new-branch", branch: "dev" });
  expect(github.head("lr-bicc/sales", "main")).toBe(first);
  expect(link.syncedSha).toBe(github.head("lr-bicc/sales", "dev"));
  expect(parseBranchTable(readme(github, link.syncedSha)).some((r) => r.branch === "dev")).toBe(true);
});

test("connect to an existing branch creates no branch and keeps one row per branch", async () => {
  const { ports, github } = fakePorts();
  const first = legacyRepo(github);
  await github.createBranch("lr-bicc/sales", "dev", first);
  const branches = (await github.listBranches("lr-bicc/sales")).length;
  const link = await connectRepository(ports, { repo: "lr-bicc/sales", mode: "existing-branch", branch: "dev" });
  expect((await github.listBranches("lr-bicc/sales")).length).toBe(branches);
  expect(link.syncedSha).toBe(github.head("lr-bicc/sales", "dev"));
  const again = await connectRepository(ports, { repo: "lr-bicc/sales", mode: "existing-branch", branch: "dev" });
  const rows = parseBranchTable(readme(github, github.head("lr-bicc/sales", "main")));
  expect(rows.filter((r) => r.branch === "dev")).toHaveLength(1);
  expect(again.syncedSha).toBe(github.head("lr-bicc/sales", "dev"));
});

test("connect to an existing branch whose row is already there commits nothing", async () => {
  const { ports, github } = fakePorts();
  legacyRepo(github);
  await connectRepository(ports, { repo: "lr-bicc/sales", mode: "existing-branch", branch: "main" });
  const count = github.commitCount("lr-bicc/sales");
  const link = await connectRepository(ports, { repo: "lr-bicc/sales", mode: "existing-branch", branch: "main" });
  expect(github.commitCount("lr-bicc/sales")).toBe(count);
  expect(link.syncedSha).toBe(github.head("lr-bicc/sales", "main"));
});

test("connect reports unknown repository, missing branch and taken branch without writing", async () => {
  const { ports, github, app } = fakePorts();
  legacyRepo(github);
  const before = github.commitCount("lr-bicc/sales");
  await expect(connectRepository(ports, { repo: "lr-bicc/nope", mode: "new-branch", branch: "x" })).rejects.toMatchObject({ code: "repo-not-found" });
  await expect(connectRepository(ports, { repo: "lr-bicc/sales", mode: "existing-branch", branch: "nope" })).rejects.toMatchObject({ code: "branch-not-found" });
  await expect(connectRepository(ports, { repo: "lr-bicc/sales", mode: "new-branch", branch: "main" })).rejects.toMatchObject({ code: "branch-exists" });
  await expect(connectRepository(ports, { repo: "lr-bicc/sales", mode: "new-branch", branch: "a b" })).rejects.toMatchObject({ code: "invalid-branch-name" });
  expect(github.commitCount("lr-bicc/sales")).toBe(before);
  expect(app.link).toBeNull();
});

test("the flow succeeds when the link can only be stored locally", async () => {
  const { ports, github, cache } = fakePorts({ writable: false });
  legacyRepo(github);
  const link = await connectRepository(ports, { repo: "lr-bicc/sales", mode: "existing-branch", branch: "main" });
  expect([...cache.entries.values()]).toEqual([link]);
});

test("a published app is rejected by all four flows before anything is written", async () => {
  const { ports, github, app } = fakePorts({ info: { published: true } });
  const first = legacyRepo(github);
  const before = github.commitCount("lr-bicc/sales");
  const source = { repo: "lr-bicc/sales", branch: "main", syncedSha: first };
  const calls = [
    createRepository(ports, { name: "fresh" }),
    connectRepository(ports, { repo: "lr-bicc/sales", mode: "new-branch", branch: "x" }),
    createBranchForCopy(ports, { source, name: "x", fromSource: false }),
    unlinkApp(ports),
  ];
  for (const c of calls) await expect(c).rejects.toBeInstanceOf(FlowError);
  for (const c of calls) await expect(c).rejects.toMatchObject({ code: "published" });
  expect(github.commitCount("lr-bicc/sales")).toBe(before);
  expect(await github.getRepo("lr-bicc/fresh")).toBeNull();
  expect(app.link).toBeNull();
});

test("unlink removes the link and the cache entry", async () => {
  const { ports, github, app, cache } = fakePorts();
  legacyRepo(github);
  const link = await connectRepository(ports, { repo: "lr-bicc/sales", mode: "existing-branch", branch: "main" });
  await cache.set(URL, link);
  await unlinkApp(ports);
  expect(app.link).toBeNull();
  expect(cache.entries.size).toBe(0);
});

test("unlink ignores a failing removeLink", async () => {
  const { ports, app, cache } = fakePorts();
  app.removeLink = async () => { throw new Error("read-only"); };
  await cache.set(URL, { repo: "r", branch: "b", appId: APP_ID, syncedSha: "s" });
  await unlinkApp(ports);
  expect(cache.entries.size).toBe(0);
});

test("suggestBranchName", () => {
  expect(suggestBranchName("R.Vasilev")).toBe("r.vasilev");
  expect(suggestBranchName("Jörg Müller")).toBe("j-rg-m-ller");
  expect(suggestBranchName("")).toBe("branch");
});
