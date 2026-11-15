import { createReadme, upsertBranchRow } from "../../src/core/repo-layout";
import { resolveStatus } from "../../src/ext/flows/status";
import { APP_ID, CANON_ID } from "../fixtures/snapshot";
import { fakePorts } from "./fake-ports";

const REPO = "lr-bicc/sales";
const urlFor = (id: string) => `https://qlik.example.com/qs/sense/app/${id}`;

function setup(init?: Parameters<typeof fakePorts>[0], opts: { devRow?: boolean; readmeApp?: string } = {}) {
  const f = fakePorts(init);
  let readme = createReadme({
    appTitle: "Sales", creatorLogin: "octocat", createdAt: new Date("2026-01-01T00:00:00Z"),
    sheets: [], defaultBranch: "main", appUrl: urlFor(opts.readmeApp ?? APP_ID),
  });
  if (opts.devRow) readme = upsertBranchRow(readme, { branch: "dev", appUrl: urlFor(APP_ID) });
  const first = f.github.seed(REPO, new Map([["README.md", readme]]));
  return { ...f, first };
}

async function commit(github: ReturnType<typeof fakePorts>["github"], branch: string, n: string) {
  const sha = await github.commitFiles(REPO, {
    branch, parentSha: github.head(REPO, branch), message: `change ${n}`,
    changes: [{ path: `objects/measures/m${n}.json`, content: `{"n":${n}}` }],
  });
  return sha;
}

describe("resolveStatus", () => {
  it("link with own id, syncedSha = head -> linked, behindBy 0, stored app", async () => {
    const { ports, app, first } = setup();
    app.link = { repo: REPO, branch: "main", appId: APP_ID, syncedSha: first };
    const s = await resolveStatus(ports);
    expect(s).toMatchObject({ state: "linked", behindBy: 0, stored: "app", headSha: first, defaultBranch: "main" });
  });

  it("link with own id, two commits later -> behindBy 2", async () => {
    const { ports, app, github, first } = setup();
    app.link = { repo: REPO, branch: "main", appId: APP_ID, syncedSha: first };
    await commit(github, "main", "1");
    await commit(github, "main", "2");
    expect(await resolveStatus(ports)).toMatchObject({ state: "linked", behindBy: 2 });
  });

  it("link with another appId -> duplicated with the link's data as source", async () => {
    const { ports, app, first } = setup();
    app.link = { repo: REPO, branch: "main", appId: CANON_ID, syncedSha: first };
    expect(await resolveStatus(ports)).toEqual({
      state: "duplicated", source: { repo: REPO, branch: "main", syncedSha: first }, defaultBranch: "main",
    });
  });

  it("unlinked marker, no link object, app in the branch table -> unlinked without calling GitHub", async () => {
    const { ports, github, cache } = setup({ meta: { repo: REPO, lastCommitId: null } });
    await cache.setUnlinked(urlFor(APP_ID), true);
    const calls: string[] = [];
    const spy = new Proxy(github, { get: (t, k, r) => { const v = Reflect.get(t, k, r); return typeof v === "function" ? (...a: unknown[]) => { calls.push(String(k)); return v.apply(t, a); } : v; } });
    expect(await resolveStatus({ ...ports, github: spy })).toEqual({ state: "unlinked" });
    expect(calls).toEqual([]);
  });

  it("unlinked marker, but the app has a link object with its own id -> linked", async () => {
    const { ports, app, cache, first } = setup();
    await cache.setUnlinked(urlFor(APP_ID), true);
    app.link = { repo: REPO, branch: "main", appId: APP_ID, syncedSha: first };
    expect(await resolveStatus(ports)).toMatchObject({ state: "linked", stored: "app" });
  });

  it("link, app published -> published", async () => {
    const { ports, app, first } = setup({ info: { published: true } });
    app.link = { repo: REPO, branch: "main", appId: APP_ID, syncedSha: first };
    expect(await resolveStatus(ports)).toEqual({ state: "published", repo: REPO, branch: "main", syncedSha: first });
  });

  it("link, branch deleted -> branch-missing", async () => {
    const { ports, app, github, first } = setup();
    await github.createBranch(REPO, "dev", first);
    app.link = { repo: REPO, branch: "dev", appId: APP_ID, syncedSha: first };
    github.deleteBranch(REPO, "dev");
    expect(await resolveStatus(ports)).toMatchObject({ state: "branch-missing", defaultBranch: "main", link: { branch: "dev" } });
  });

  it("branch head one 'Update branches table' commit ahead -> behindBy 0 and the link advanced", async () => {
    const { ports, app, github, first } = setup();
    app.link = { repo: REPO, branch: "main", appId: APP_ID, syncedSha: first };
    const readme = github.filesAt(REPO, first).get("README.md") as string;
    const head = await github.commitFiles(REPO, { branch: "main", parentSha: first, message: "Update branches table",
      changes: [{ path: "README.md", content: upsertBranchRow(readme, { branch: "dev", appUrl: urlFor(CANON_ID) }) }] });
    expect(await resolveStatus(ports)).toMatchObject({ state: "linked", behindBy: 0, headSha: head, link: { syncedSha: head } });
    expect(app.link).toEqual({ repo: REPO, branch: "main", appId: APP_ID, syncedSha: head });
  });

  it("branch head one real change ahead -> behindBy 1 and the link unchanged", async () => {
    const { ports, app, github, first } = setup();
    app.link = { repo: REPO, branch: "main", appId: APP_ID, syncedSha: first };
    await commit(github, "main", "1");
    expect(await resolveStatus(ports)).toMatchObject({ state: "linked", behindBy: 1, link: { syncedSha: first } });
    expect(app.link!.syncedSha).toBe(first);
  });

  it("duplicated with a deleted source branch -> source.branch null", async () => {
    const { ports, app, github, first } = setup();
    await github.createBranch(REPO, "dev", first);
    app.link = { repo: REPO, branch: "dev", appId: CANON_ID, syncedSha: first };
    github.deleteBranch(REPO, "dev");
    expect(await resolveStatus(ports)).toEqual({
      state: "duplicated", source: { repo: REPO, branch: null, syncedSha: first }, defaultBranch: "main",
    });
  });

  it("link to a repository outside the organisation -> repo-missing", async () => {
    const { ports, app } = setup();
    app.link = { repo: "other-org/x", branch: "main", appId: APP_ID, syncedSha: "a".repeat(40) };
    expect(await resolveStatus(ports)).toEqual({ state: "repo-missing", repo: "other-org/x" });
    app.link = { repo: "other-org/x", branch: "main", appId: CANON_ID, syncedSha: "a".repeat(40) };
    expect(await resolveStatus(ports)).toEqual({ state: "repo-missing", repo: "other-org/x" });
  });

  it("gitoqlok metadata naming a repository outside the organisation is ignored", async () => {
    const { ports } = setup({ meta: { repo: "other-org/x", lastCommitId: null } }, { readmeApp: CANON_ID });
    expect(await resolveStatus(ports)).toEqual({ state: "unlinked" });
  });

  it("link to lr-bicc/gone -> repo-missing", async () => {
    const { ports, app } = setup();
    app.link = { repo: "lr-bicc/gone", branch: "main", appId: APP_ID, syncedSha: "a".repeat(40) };
    expect(await resolveStatus(ports)).toEqual({ state: "repo-missing", repo: "lr-bicc/gone" });
  });

  it("no link, gitoqlok meta with first commit, app in table under dev, dev one commit ahead -> linked and link saved", async () => {
    const { ports, github, app, first } = setup({ meta: { repo: REPO, lastCommitId: null } }, { devRow: true, readmeApp: CANON_ID });
    await github.createBranch(REPO, "dev", first);
    await commit(github, "dev", "1");
    app.meta = { repo: REPO, lastCommitId: first };
    const s = await resolveStatus(ports);
    expect(s).toMatchObject({ state: "linked", behindBy: 1, stored: "app", link: { branch: "dev", syncedSha: first, repo: REPO, appId: APP_ID } });
    expect(app.link).toEqual({ repo: REPO, branch: "dev", appId: APP_ID, syncedSha: first });
  });

  it("same, lastCommitId unknown -> syncedSha is the head of dev", async () => {
    const { ports, github, first } = setup({ meta: { repo: REPO, lastCommitId: "unknown" } }, { devRow: true, readmeApp: CANON_ID });
    await github.createBranch(REPO, "dev", first);
    const devHead = await commit(github, "dev", "1");
    const s = await resolveStatus(ports);
    expect(s).toMatchObject({ state: "linked", behindBy: 0, link: { branch: "dev", syncedSha: devHead } });
  });

  it("no link, meta.repo set, app not in table -> duplicated with branch null", async () => {
    const { ports } = setup({ meta: { repo: REPO, lastCommitId: null } }, { readmeApp: CANON_ID });
    expect(await resolveStatus(ports)).toEqual({
      state: "duplicated", source: { repo: REPO, branch: null, syncedSha: null }, defaultBranch: "main",
    });
  });

  it("same, app published -> published with branch null", async () => {
    const { ports } = setup({ meta: { repo: REPO, lastCommitId: null }, info: { published: true } }, { readmeApp: CANON_ID });
    expect(await resolveStatus(ports)).toEqual({ state: "published", repo: REPO, branch: null, syncedSha: null });
  });

  it("no link, no gitoqlok data, app in a repo's table -> linked via findRepoForApp", async () => {
    const { ports, first } = setup();
    const s = await resolveStatus(ports);
    expect(s).toMatchObject({ state: "linked", behindBy: 0, link: { repo: REPO, branch: "main", syncedSha: first }, stored: "app" });
  });

  it("nothing -> unlinked", async () => {
    const { ports } = setup(undefined, { readmeApp: CANON_ID });
    expect(await resolveStatus(ports)).toEqual({ state: "unlinked" });
  });

  it("no link, hit via the table, writable false -> linked, stored local, cache entry under info.url", async () => {
    const { ports, cache, first } = setup({ writable: false });
    const s = await resolveStatus(ports);
    expect(s).toMatchObject({ state: "linked", stored: "local" });
    expect(cache.entries.get(urlFor(APP_ID))).toEqual({ repo: REPO, branch: "main", appId: APP_ID, syncedSha: first });
  });
});
