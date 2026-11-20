import { gitBlobSha } from "../../src/core/git-hash";
import { findBranchForApp, parseBranchTable } from "../../src/core/repo-layout";
import type { Action, AppObjectGroup } from "../../src/core/update-planner";
import type { AppSnapshot, FileContent, FileMap, GenericProps, PropertyTree } from "../../src/core/types";
import type { AppInfo, AppPort, FlowPorts, LinkCache, ServerPort } from "../../src/ext/flows/ports";
import { GatewayError, type GitHubPort } from "../../src/ext/shared/github-port";
import type { BlobRef, CommitInfo, TagInfo } from "../../src/github/repo";
import type { LinkData } from "../../src/qlik/link";
import { ApplyError } from "../../src/qlik/writer";
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
  tags: Map<string, TagInfo>;
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
  isMarked(repo: string): boolean;
  failMarking(): void;
  tag(repo: string, name: string, sha: string, message?: string): void;
  /** Number of blobs read through readBlobs. */
  blobReads(): number;
} {
  const repos = new Map<string, FakeRepo>();
  const marked = new Set<string>();
  let markingFails = false;
  let counter = 0;
  let blobsRead = 0;

  const newSha = (): string => "c0de".repeat(8) + (++counter).toString(16).padStart(8, "0");
  const notFound = (what: string) => new GatewayError("not-found", `${what} not found`);
  /** Like the gateway: repositories outside the configured organisation are refused. */
  const guard = (name: string): void => {
    if (!name.toLowerCase().startsWith(`${ORG}/`)) throw new GatewayError("not-allowed", "Repository is outside the configured organisation");
  };
  const repoOf = (name: string): FakeRepo => {
    guard(name);
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
  const info = (r: FakeRepo, c: FakeCommit): CommitInfo => ({ sha: c.sha, message: c.message, author: "octocat", date: FIXED_DATE, parents: [...c.parents] });
  const createRepoState = (name: string, files: FileMap, defaultBranch: string, message: string): string => {
    const r: FakeRepo = { defaultBranch, commits: new Map(), branches: new Map(), protectedBranches: new Set(), race: false, tags: new Map() };
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
    isMarked: (repo) => marked.has(repo),
    failMarking: () => { markingFails = true; },
    tag(repo, name, sha, message = "") {
      const r = repoOf(repo);
      commitOf(r, sha);
      r.tags.set(name, { name, sha, date: FIXED_DATE, message });
    },
    blobReads: () => blobsRead,

    async whoAmI() { return { login: "octocat" }; },
    async listOrgRepos() {
      return [...repos].filter(([n]) => n.startsWith(`${ORG}/`)).map(([repo, r]) => ({ repo, defaultBranch: r.defaultBranch, marked: marked.has(repo) }));
    },
    async markRepo(repo) {
      repoOf(repo);
      if (markingFails) throw new GatewayError("forbidden", "Resource not accessible by personal access token");
      marked.add(repo);
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
      guard(repo);
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
    async listTags(repo) { return [...repoOf(repo).tags.values()].map((t) => ({ ...t })); },
    async createTag(repo, input) {
      const r = repoOf(repo);
      commitOf(r, input.sha);
      if (r.tags.has(input.name)) throw new GatewayError("name-exists", `tag ${input.name} already exists`);
      r.tags.set(input.name, { name: input.name, sha: input.sha, date: FIXED_DATE, message: input.message });
    },
    async readBlobs(repo, items: BlobRef[]) {
      const r = repoOf(repo);
      const bySha = new Map<string, FileContent>();
      for (const c of r.commits.values()) for (const content of c.files.values()) bySha.set(await gitBlobSha(content), content);
      const out: FileMap = new Map();
      for (const { path, sha } of items) {
        const content = bySha.get(sha);
        if (content === undefined) throw notFound(`blob ${sha}`);
        blobsRead++;
        out.set(path, cloneContent(content));
      }
      return out;
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
      if (input.replaceRoot && commitOf(r, input.parentSha).parents.length !== 0) throw new Error("not the first commit");
      const files = cloneFiles(commitOf(r, input.parentSha).files);
      for (const ch of input.changes) {
        if (ch.content === null) files.delete(ch.path);
        else files.set(ch.path, cloneContent(ch.content));
      }
      const c = addCommit(r, input.replaceRoot ? [] : [input.parentSha], input.message, files);
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

type Payload = GenericProps | PropertyTree;
const payloadId = (p: Payload): string => ("qChildren" in p && "qProperty" in p ? (p as PropertyTree).qProperty.qInfo.qId : p.qInfo.qId);
const GROUP_FIELD: Record<AppObjectGroup, "appProps" | "variables" | "dimensions" | "measures" | "masterObjects" | "sheets" | "stories"> = {
  appprops: "appProps", variables: "variables", dimensions: "dimensions", measures: "measures",
  masterobjects: "masterObjects", sheets: "sheets", stories: "stories",
};

export function fakeApp(init: {
  info?: Partial<AppInfo>; snapshot?: AppSnapshot; link?: LinkData | null;
  meta?: { repo: string | null; lastCommitId: string | null } | null; writable?: boolean;
}): AppPort & {
  snapshot: AppSnapshot; link: LinkData | null; meta: { repo: string | null; lastCommitId: string | null } | null;
  saves: number; reads: number; failApplyAt(index: number, message: string): void;
} {
  const appInfo: AppInfo = {
    id: APP_ID, title: "Sales", published: false, url: `https://qlik.example.com/qs/sense/app/${APP_ID}`, user: "r.vasilev", canWrite: true,
    ...init.info,
  };
  let failAt: { index: number; message: string } | null = null;
  const applyOne = (snap: AppSnapshot, a: Action): void => {
    switch (a.op) {
      case "upsert": {
        const list = snap[GROUP_FIELD[a.group]] as Payload[];
        const at = list.findIndex((p) => payloadId(p) === a.id);
        const payload = structuredClone(a.payload);
        if (at >= 0) list[at] = payload;
        else list.push(payload);
        return;
      }
      case "delete": {
        const list = snap[GROUP_FIELD[a.group]] as Payload[];
        const at = list.findIndex((p) => payloadId(p) === a.id);
        if (at >= 0) list.splice(at, 1);
        return;
      }
      case "setScript": snap.script = a.script; return;
      case "putFile": snap.staticFiles.set(a.name, a.bytes.slice()); return;
      case "deleteFile": snap.staticFiles.delete(a.name);
    }
  };
  const app = {
    snapshot: init.snapshot ?? makeSnapshot(),
    link: init.link ?? (null as LinkData | null),
    meta: init.meta ?? (null as { repo: string | null; lastCommitId: string | null } | null),
    saves: 0,
    reads: 0,
    failApplyAt(index: number, message: string) { failAt = { index, message }; },
    async info() { return { ...appInfo }; },
    async read(opts: { includeFiles: boolean; onProgress?: (done: number, total: number) => void }) {
      app.reads++;
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
    async apply(actions: Action[], onProgress?: (done: number, total: number) => void) {
      onProgress?.(0, actions.length);
      for (let i = 0; i < actions.length; i++) {
        if (failAt !== null && i === failAt.index) {
          throw new ApplyError(failAt.message, actions.slice(0, i), actions[i]!, actions.slice(i + 1));
        }
        applyOne(app.snapshot, actions[i]!);
        onProgress?.(i + 1, actions.length);
      }
    },
    async save() { app.saves++; },
  };
  return app;
}

/** A server whose new apps start empty (script "", no objects). */
export function fakeServer(): ServerPort & {
  created: { name: string; app: ReturnType<typeof fakeApp> }[]; failAfterCreate(message: string): void;
} {
  const created: { name: string; app: ReturnType<typeof fakeApp> }[] = [];
  let failure: string | null = null;
  return {
    created,
    failAfterCreate(message) { failure = message; },
    async createApp(name) {
      const id = `new-app-${created.length + 1}`;
      const snapshot: AppSnapshot = {
        appId: id, script: "", appProps: [], variables: [], dimensions: [], measures: [], masterObjects: [],
        sheets: [], stories: [], bookmarks: [], staticFiles: new Map(),
      };
      const app = fakeApp({ info: { id, title: name, url: `https://qlik.example.com/qs/sense/app/${id}` }, snapshot });
      created.push({ name, app });
      if (failure !== null) {
        const message = failure;
        failure = null;
        throw new Error(message);
      }
      return { app, close: async () => {} };
    },
  };
}

export function fakeCache(): LinkCache & { entries: Map<string, LinkData>; unlinked: Set<string> } {
  const entries = new Map<string, LinkData>();
  const unlinked = new Set<string>();
  return {
    entries,
    unlinked,
    async isUnlinked(key) { return unlinked.has(key); },
    async setUnlinked(key, value) { if (value) unlinked.add(key); else unlinked.delete(key); },
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
