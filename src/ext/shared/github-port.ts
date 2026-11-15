import type { CommitInfo, FileChange } from "../../github/repo";
import type { GitHubErrorKind } from "../../github/errors";
import type { RepoRef } from "../../github/snapshot";
import { toWire, type WireContent } from "./wire";

export interface GitHubPort {
  whoAmI(): Promise<{ login: string }>;
  listOrgRepos(): Promise<RepoRef[]>;
  findRepoForApp(appId: string): Promise<{ repo: string; branch: string } | null>;
  getRepo(repo: string): Promise<RepoRef | null>;
  createRepo(name: string): Promise<RepoRef>;
  getBranchSha(repo: string, branch: string): Promise<string | null>;
  listBranches(repo: string): Promise<{ name: string; sha: string }[]>;
  getTree(repo: string, commitSha: string): Promise<Map<string, string>>;
  readTextFile(repo: string, ref: string, path: string): Promise<string | null>;
  createBranch(repo: string, name: string, fromSha: string): Promise<void>;
  commitFiles(repo: string, input: { branch: string; parentSha: string; message: string; changes: FileChange[] }): Promise<string>;
  listCommits(repo: string, branch: string, page: number): Promise<CommitInfo[]>;
  compare(repo: string, base: string, head: string): Promise<{ status: "identical" | "ahead" | "behind" | "diverged"; aheadBy: number; behindBy: number; commits: CommitInfo[] }>;
}

export type GatewayErrorKind = GitHubErrorKind | "no-token" | "not-allowed" | "internal";
export interface WireError { kind: GatewayErrorKind; message: string; ssoUrl?: string; resetAt?: number }
export interface GatewayRequest { op: keyof GitHubPort; args: unknown[] }
export type GatewayResponse = { ok: true; value: unknown } | { ok: false; error: WireError };

export class GatewayError extends Error {
  constructor(public kind: GatewayErrorKind, message: string, public extra?: { ssoUrl?: string; resetAt?: number }) {
    super(message);
    this.name = "GatewayError";
  }
}

const isOk = (res: GatewayResponse): res is { ok: true; value: unknown } => res.ok;

/** Builds a GitHubPort that sends every call as a JSON-safe request through `send`. */
export function createGitHubPort(send: (request: GatewayRequest) => Promise<GatewayResponse>): GitHubPort {
  async function call(op: keyof GitHubPort, ...args: unknown[]): Promise<unknown> {
    const res: unknown = await send({ op, args });
    // A stopped or restarting service worker answers with nothing at all.
    if (typeof res !== "object" || res === null || typeof (res as { ok?: unknown }).ok !== "boolean") {
      throw new GatewayError("internal", "The extension's background service did not answer. Try again.");
    }
    if (!isOk(res as GatewayResponse)) {
      const { kind, message, ssoUrl, resetAt } = (res as { error: WireError }).error;
      const extra: { ssoUrl?: string; resetAt?: number } = {};
      if (ssoUrl !== undefined) extra.ssoUrl = ssoUrl;
      if (resetAt !== undefined) extra.resetAt = resetAt;
      throw new GatewayError(kind, message, extra);
    }
    return (res as { value: unknown }).value;
  }
  return {
    whoAmI: () => call("whoAmI") as Promise<{ login: string }>,
    listOrgRepos: () => call("listOrgRepos") as Promise<RepoRef[]>,
    findRepoForApp: (appId) => call("findRepoForApp", appId) as Promise<{ repo: string; branch: string } | null>,
    getRepo: (repo) => call("getRepo", repo) as Promise<RepoRef | null>,
    createRepo: (name) => call("createRepo", name) as Promise<RepoRef>,
    getBranchSha: (repo, branch) => call("getBranchSha", repo, branch) as Promise<string | null>,
    listBranches: (repo) => call("listBranches", repo) as Promise<{ name: string; sha: string }[]>,
    getTree: async (repo, commitSha) => new Map((await call("getTree", repo, commitSha)) as [string, string][]),
    readTextFile: (repo, ref, path) => call("readTextFile", repo, ref, path) as Promise<string | null>,
    createBranch: async (repo, name, fromSha) => void (await call("createBranch", repo, name, fromSha)),
    commitFiles: (repo, input) => {
      const wireInput = {
        ...input,
        changes: input.changes.map((c): { path: string; content: WireContent | null } => ({
          path: c.path,
          content: c.content === null ? null : toWire(c.content),
        })),
      };
      return call("commitFiles", repo, wireInput) as Promise<string>;
    },
    listCommits: (repo, branch, page) => call("listCommits", repo, branch, page) as Promise<CommitInfo[]>,
    compare: (repo, base, head) => call("compare", repo, base, head) as ReturnType<GitHubPort["compare"]>,
  };
}
