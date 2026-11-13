import { gitBlobSha } from "../../src/core/git-hash";
import { findBranchForApp, parseBranchTable } from "../../src/core/repo-layout";
import type { AppSnapshot, FileContent, FileMap } from "../../src/core/types";
import type { AppInfo, AppPort, FlowPorts, LinkCache } from "../../src/ext/flows/ports";
import { GatewayError, type GitHubPort } from "../../src/ext/shared/github-port";
import type { CommitInfo } from "../../src/github/repo";
import type { LinkData } from "../../src/qlik/link";
import { APP_ID, makeSnapshot } from "../fixtures/snapshot";

const ORG = "lr-bicc";
const PAGE_SIZE = 30;
const FIXED_DATE = "2026-01-02T03:04:05.000Z";

interface FakeCommit { sha: string; parents: string[]; message: string; files: FileMap; seq: number }
interface FakeRepo {
  defaultBranch: string;
  commits: Map<string, FakeCommit>;
  branches: Map<string, string>;
  protectedBranches: Set<string>;
  race: boolean;
}

function cloneContent(c: FileContent): FileContent {
  return typeof c === "string" ? c : c.slice();
}
function cloneFiles(files: FileMap): FileMap {
  return new Map([...files].map(([p, c]) => [p, cloneContent(c)]));
}

export function fakeGitHub(): GitHubPort & {
  seed(repo: string, files: FileMap, defaultBranch?: string): string;
  head(repo: string, branch: string): string;
  filesAt(repo: string, sha: string): FileMap;
  commitCount(repo: string): number;
  messageOf(repo: string, sha: string): string;
  protect(repo: string, branch: string): void;
  raceOnce(repo: string): void;
  deleteBranch(repo: string, branch: string): void;
} {
  const repos = new Map<string, FakeRepo>();
  let counter = 0;

  const newSha = (): string => "c0de".repeat(8) + (++counter).toString(16).padStart(8, "0");
  const notFound = (what: string) => new GatewayError("not-found", `${what} not found`);
  const repoOf = (name: string): FakeRepo => {
    const r = repos.get(name);
    if (!r) throw notFound(`repository ${name}`);
    return r;
  };
  const commitOf = (r: FakeRepo, sha: string): FakeCommit => {
    const c = r.commits.get(sha);
    if (!c) throw notFound(`commit ${sha}`);
    return c;
  };
  const addCommit = (r: FakeRepo, parents: string[], message: string, files: FileMap): FakeCommit => {
    const c: FakeCommit = { sha: newSha(), parents, message, files, seq: counter };
    r.commits.set(c.sha, c);
    return c;
  };
  /** The commit and all its ancestors. */
  const reachable = (r: FakeRepo, sha: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length > 0) {
      const s = stack.pop()!;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...commitOf(r, s).parents);
    }
    return seen;
  };
  const info = (r: FakeRepo, c: FakeCommit): CommitInfo => ({ sha: c.sha, message: c.message, author: "octocat", date: FIXED_DATE });
  const createRepoState = (name: string, files: FileMap, defaultBranch: string, message: string): string => {
    const r: FakeRepo = { defaultBranch, commits: new Map(), branches: new Map(), protectedBranches: new Set(), race: false };
    const c = addCommit(r, [], message, cloneFiles(files));
    r.branches.set(defaultBranch, c.sha);
    repos.set(name, r);
    return c.sha;
  };
  const resolveRef = (r: FakeRepo, ref: string): string | null => r.branches.get(ref) ?? (r.commits.has(ref) ? ref : null);

  return {
    seed(repo, files, defaultBranch = "main") {
      if (repos.has(repo)) throw new Error(`repository ${repo} is already seeded`);
      return createRepoState(repo, files, defaultBranch, "Initial commit");
    },
    head(repo, branch) {
      const sha = repoOf(repo).branches.get(branch);
      if (!sha) throw new Error(`no branch ${branch} in ${repo}`);
      return sha;
    },
    filesAt: (repo, sha) => cloneFiles(commitOf(repoOf(repo), sha).files),
    commitCount: (repo) => repoOf(repo).commits.size,
    messageOf: (repo, sha) => commitOf(repoOf(repo), sha).message,
    protect: (repo, branch) => void repoOf(repo).protectedBranches.add(branch),
    raceOnce: (repo) => { repoOf(repo).race = true; },
    deleteBranch: (repo, branch) => void repoOf(repo).branches.delete(branch),

    async whoAmI() { return { login: "octocat" }; },
    async listOrgRepos() {
      return [...repos].filter(([n]) => n.startsWith(`${ORG}/`)).map(([repo, r]) => ({ repo, defaultBranch: r.defaultBranch }));
    },
    async findRepoForApp(appId) {
      for (const [repo, r] of repos) {
        if (!repo.startsWith(`${ORG}/`)) continue;
        const head = r.branches.get(r.defaultBranch);
        const readme = head ? r.commits.get(head)?.files.get("README.md") : undefined;
        if (typeof readme !== "string") continue;
        const branch = findBranchForApp(parseBranchTable(readme), appId);
        if (branch !== null) return { repo, branch };
      }
      return null;
    },
    async getRepo(repo) {
      const r = repos.get(repo);
      return r ? { repo, defaultBranch: r.defaultBranch } : null;
    },
    async createRepo(name) {
      const full = `${ORG}/${name}`;
      if (repos.has(full)) throw new GatewayError("name-exists", `${full} already exists`);
      createRepoState(full, new Map([["README.md", `# ${name}\n`]]), "main", "Initial commit");
      return { repo: full, defaultBranch: "main" };
    },
    async getBranchSha(repo, branch) { return repoOf(repo).branches.get(branch) ?? null; },
    async listBranches(repo) { return [...repoOf(repo).branches].map(([name, sha]) => ({ name, sha })); },
    async getTree(repo, commitSha) {
      const tree = new Map<string, string>();
      for (const [path, content] of commitOf(repoOf(repo), commitSha).files) tree.set(path, await gitBlobSha(content));
      return tree;
    },
    async readTextFile(repo, ref, path) {
      const r = repoOf(repo);
      const sha = resolveRef(r, ref);
      const content = sha === null ? undefined : r.commits.get(sha)?.files.get(path);
      if (content === undefined) return null;
      return typeof content === "string" ? content : new TextDecoder().decode(content);
    },
    async createBranch(repo, name, fromSha) {
      const r = repoOf(repo);
      commitOf(r, fromSha);
      if (r.branches.has(name)) throw new GatewayError("name-exists", `branch ${name} already exists`);
      r.branches.set(name, fromSha);
    },
    async commitFiles(repo, input) {
      const r = repoOf(repo);
      if (input.changes.length === 0) throw new Error("Nothing to commit");
      const current = r.branches.get(input.branch);
      if (current === undefined) throw notFound(`branch ${input.branch}`);
      if (r.protectedBranches.has(input.branch)) throw new GatewayError("protected-branch", `${input.branch} is protected`);
      if (r.race) {
        r.race = false;
        throw new GatewayError("not-fast-forward", "branch moved");
      }
      if (current !== input.parentSha) throw new GatewayError("not-fast-forward", "branch is not at parentSha");
      const files = cloneFiles(commitOf(r, input.parentSha).files);
      for (const ch of input.changes) {
        if (ch.content === null) files.delete(ch.path);
        else files.set(ch.path, cloneContent(ch.content));
      }
      const c = addCommit(r, [input.parentSha], input.message, files);
      r.branches.set(input.branch, c.sha);
      return c.sha;
    },
    async listCommits(repo, branch, page) {
      const r = repoOf(repo);
      const head = r.branches.get(branch);
      if (!head) throw notFound(`branch ${branch}`);
      const all = [...reachable(r, head)].map((s) => commitOf(r, s)).sort((a, b) => b.seq - a.seq);
      return all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((c) => info(r, c));
    },
    async compare(repo, base, head) {
      const r = repoOf(repo);
      commitOf(r, base);
      commitOf(r, head);
      const fromBase = reachable(r, base);
      const fromHead = reachable(r, head);
      const ahead = [...fromHead].filter((s) => !fromBase.has(s)).map((s) => commitOf(r, s)).sort((a, b) => a.seq - b.seq);
      const behindBy = [...fromBase].filter((s) => !fromHead.has(s)).length;
      const status = ahead.length === 0 ? (behindBy === 0 ? "identical" : "behind") : behindBy === 0 ? "ahead" : "diverged";
      return { status, aheadBy: ahead.length, behindBy, commits: ahead.map((c) => info(r, c)) };
    },
  };
}

export function fakeApp(init: {
  info?: Partial<AppInfo>; snapshot?: AppSnapshot; link?: LinkData | null;
  meta?: { repo: string | null; lastCommitId: string | null } | null; writable?: boolean;
}): AppPort & { snapshot: AppSnapshot; link: LinkData | null; meta: { repo: string | null; lastCommitId: string | null } | null } {
  const appInfo: AppInfo = {
    id: APP_ID, title: "Sales", published: false, url: `https://qlik.example.com/qs/sense/app/${APP_ID}`, user: "r.vasilev",
    ...init.info,
  };
  const app = {
    snapshot: init.snapshot ?? makeSnapshot(),
    link: init.link ?? (null as LinkData | null),
    meta: init.meta ?? (null as { repo: string | null; lastCommitId: string | null } | null),
    async info() { return { ...appInfo }; },
    async read(opts: { includeFiles: boolean; onProgress?: (done: number, total: number) => void }) {
      const copy = structuredClone(app.snapshot);
      if (!opts.includeFiles) copy.staticFiles = new Map();
      opts.onProgress?.(1, 1);
      return copy;
    },
    async readLink() { return app.link ? { ...app.link } : null; },
    async writeLink(link: LinkData) {
      if (init.writable === false) throw new Error("app is not writable");
      app.link = { ...link };
    },
    async removeLink() { app.link = null; },
    async readGitoqlokMeta() { return app.meta ? { ...app.meta } : null; },
  };
  return app;
}

export function fakeCache(): LinkCache & { entries: Map<string, LinkData> } {
  const entries = new Map<string, LinkData>();
  return {
    entries,
    async get(key) { const l = entries.get(key); return l ? { ...l } : null; },
    async set(key, link) { entries.set(key, { ...link }); },
    async remove(key) { entries.delete(key); },
  };
}

export function fakePorts(init: Parameters<typeof fakeApp>[0] = {}): {
  ports: FlowPorts; github: ReturnType<typeof fakeGitHub>; app: ReturnType<typeof fakeApp>; cache: ReturnType<typeof fakeCache>;
} {
  const github = fakeGitHub();
  const app = fakeApp(init);
  const cache = fakeCache();
  return { ports: { app, github, cache, repoPrefix: "", now: () => new Date("2026-01-02T03:04:05Z") }, github, app, cache };
}
