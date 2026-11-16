import { parseBranchTable, upsertBranchRow } from "../../src/core/repo-layout";
import { serializeApp } from "../../src/core/serializer";
import { FlowError } from "../../src/ext/flows/ports";
import { resolveStatus } from "../../src/ext/flows/status";
import { connectRepository, createBranchForCopy, createRepository, suggestBranchName, unlinkApp } from "../../src/ext/flows/setup";
import { APP_ID, CANON_ID, makeSnapshot } from "../fixtures/snapshot";
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

test("connect to the default branch whose row carries another app's id: no commit, row unchanged, app linked", async () => {
  const { ports, github, app } = fakePorts();
  const first = legacyRepo(github);
  const before = readme(github, first);
  expect(parseBranchTable(before).find((r) => r.branch === "main")?.appId).toBe(CANON_ID);
  const link = await connectRepository(ports, { repo: "lr-bicc/sales", mode: "existing-branch", branch: "main" });
  expect(github.head("lr-bicc/sales", "main")).toBe(first);
  expect(readme(github, github.head("lr-bicc/sales", "main"))).toBe(before);
  expect(link).toEqual({ repo: "lr-bicc/sales", branch: "main", appId: APP_ID, syncedSha: first });
  expect(app.link).toEqual(link);
});

test("connect to a non-default branch whose row carries another app's id: the row is replaced", async () => {
  const { ports, github } = fakePorts();
  const first = legacyRepo(github);
  const withDev = upsertBranchRow(readme(github, first), { branch: "dev", appUrl: `https://qlik.example.com/qs/sense/app/${CANON_ID}` });
  const base = await github.commitFiles("lr-bicc/sales", { branch: "main", parentSha: first, message: "Update branches table", changes: [{ path: "README.md", content: withDev }] });
  await github.createBranch("lr-bicc/sales", "dev", base);
  await connectRepository(ports, { repo: "lr-bicc/sales", mode: "existing-branch", branch: "dev" });
  const main = github.head("lr-bicc/sales", "main");
  expect(main).not.toBe(base);
  const rows = parseBranchTable(readme(github, main));
  expect(rows.filter((r) => r.branch === "dev")).toEqual([{ branch: "dev", appUrl: URL, appId: APP_ID }]);
  expect(rows.find((r) => r.branch === "main")?.appId).toBe(CANON_ID);
});

test("existing branch, default branch protected: the row lands on the chosen branch", async () => {
  const { ports, github } = fakePorts();
  const first = legacyRepo(github);
  await github.createBranch("lr-bicc/sales", "dev", first);
  github.protect("lr-bicc/sales", "main");
  const link = await connectRepository(ports, { repo: "lr-bicc/sales", mode: "existing-branch", branch: "dev" });
  const dev = github.head("lr-bicc/sales", "dev");
  expect(dev).not.toBe(first);
  expect(github.messageOf("lr-bicc/sales", dev)).toBe("Update branches table");
  expect(github.head("lr-bicc/sales", "main")).toBe(first);
  expect(link.syncedSha).toBe(dev);
  expect(parseBranchTable(readme(github, dev)).some((r) => r.branch === "dev" && r.appId === APP_ID)).toBe(true);
});

test("existing branch that is the protected default: no row, the app is linked anyway", async () => {
  const { ports, github, app } = fakePorts();
  const first = legacyRepo(github);
  github.protect("lr-bicc/sales", "main");
  const count = github.commitCount("lr-bicc/sales");
  const link = await connectRepository(ports, { repo: "lr-bicc/sales", mode: "existing-branch", branch: "main" });
  expect(github.commitCount("lr-bicc/sales")).toBe(count);
  expect(link).toEqual({ repo: "lr-bicc/sales", branch: "main", appId: APP_ID, syncedSha: first });
  expect(app.link).toEqual(link);
});

test("existing branch, both it and the default branch protected: no row, linked on the chosen branch", async () => {
  const { ports, github } = fakePorts();
  const first = legacyRepo(github);
  await github.createBranch("lr-bicc/sales", "dev", first);
  github.protect("lr-bicc/sales", "main");
  github.protect("lr-bicc/sales", "dev");
  const count = github.commitCount("lr-bicc/sales");
  const link = await connectRepository(ports, { repo: "lr-bicc/sales", mode: "existing-branch", branch: "dev" });
  expect(github.commitCount("lr-bicc/sales")).toBe(count);
  expect(link).toEqual({ repo: "lr-bicc/sales", branch: "dev", appId: APP_ID, syncedSha: first });
});

test("a failing whoAmI leaves no repository behind", async () => {
  const { ports, github } = fakePorts();
  const failing = { ...github, whoAmI: async () => { throw new Error("offline"); } };
  await expect(createRepository({ ...ports, github: failing }, { name: "fresh" })).rejects.toThrow("offline");
  expect(await github.getRepo("lr-bicc/fresh")).toBeNull();
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

test("unlink sticks until the app is connected again", async () => {
  const { ports, github, cache } = fakePorts();
  legacyRepo(github);
  await connectRepository(ports, { repo: "lr-bicc/sales", mode: "existing-branch", branch: "main" });
  await unlinkApp(ports);
  expect(cache.unlinked.has(URL)).toBe(true);
  expect(await resolveStatus(ports)).toEqual({ state: "unlinked" });
  await connectRepository(ports, { repo: "lr-bicc/sales", mode: "existing-branch", branch: "main" });
  expect(cache.unlinked.size).toBe(0);
  expect(await resolveStatus(ports)).toMatchObject({ state: "linked" });
});

test("a failing setUnlinked(false) does not fail the link", async () => {
  const { ports, github, app, cache } = fakePorts();
  legacyRepo(github);
  cache.setUnlinked = async () => { throw new Error("storage"); };
  const link = await connectRepository(ports, { repo: "lr-bicc/sales", mode: "existing-branch", branch: "main" });
  expect(app.link).toEqual(link);
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

test("create repository, connect and create branch mark the repository with the qommit topic", async () => {
  const created = fakePorts();
  const link = await createRepository(created.ports, {});
  expect(created.github.isMarked(link.repo)).toBe(true);

  for (const mode of ["new-branch", "existing-branch"] as const) {
    const { ports, github } = fakePorts();
    legacyRepo(github);
    await connectRepository(ports, { repo: "lr-bicc/sales", mode, branch: mode === "new-branch" ? "r.vasilev" : "main" });
    expect(github.isMarked("lr-bicc/sales")).toBe(true);
  }

  const copy = fakePorts();
  const first = legacyRepo(copy.github);
  await createBranchForCopy(copy.ports, { source: { repo: "lr-bicc/sales", branch: "main", syncedSha: first }, name: "feature/x", fromSource: false });
  expect(copy.github.isMarked("lr-bicc/sales")).toBe(true);
});

test("a repository that cannot be marked (no admin role) does not fail the flows", async () => {
  const created = fakePorts();
  created.github.failMarking();
  const link = await createRepository(created.ports, {});
  expect(created.app.link).toEqual(link);
  expect(created.github.isMarked(link.repo)).toBe(false);

  const { ports, github, app } = fakePorts();
  legacyRepo(github);
  github.failMarking();
  const connected = await connectRepository(ports, { repo: "lr-bicc/sales", mode: "new-branch", branch: "r.vasilev" });
  expect(app.link).toEqual(connected);
});

describe("create branch for a copy whose recorded commit lags behind (gitoqlok)", () => {
  const SHEET = "objects/sheets/sh-1.json";
  const GITOQLOK_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  async function lagging(appHasMerge: boolean) {
    const { ports, github, app } = fakePorts();
    const first = legacyRepo(github);
    const merged = makeSnapshot();
    merged.sheets[0]!.qProperty.qMetaDef = { title: "Overview (Nordics)" };
    await github.commitFiles("lr-bicc/sales", { branch: "main", parentSha: first, message: "Merge pull request #31",
      changes: [{ path: SHEET, content: serializeApp(merged, { canonicalAppId: GITOQLOK_ID }).get(SHEET)! }] });
    if (appHasMerge) app.snapshot = merged;
    const link = await createBranchForCopy(ports, { source: { repo: "lr-bicc/sales", branch: null, syncedSha: first }, name: "feature/x", fromSource: false });
    return { link, head: github.head("lr-bicc/sales", "feature/x"), first };
  }

  test("the app already holds the merge: the copy starts at the head", async () => {
    const { link, head } = await lagging(true);
    expect(link.syncedSha).toBe(head);
  });

  test("the app is really older: the recorded commit is kept", async () => {
    const { link, first } = await lagging(false);
    expect(link.syncedSha).toBe(first);
  });
});
