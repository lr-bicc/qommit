import type { FileContent } from "../core/types";
import { GitHubError } from "./errors";
import type { GitHubClient } from "./client";
import type { RepoRef } from "./snapshot";

export interface CommitInfo { sha: string; message: string; author: string; date: string }
export interface TagInfo { name: string; sha: string }
export interface FileChange { path: string; content: FileContent | null } // null = delete

const MAX_CONCURRENT_BLOBS = 5;

/** Encodes each path segment but keeps the slashes (branch names may contain `/`). */
function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

/** Base64 without Buffer so it works in Node and in a browser service worker. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

interface RawCommit { sha: string; commit: { message: string; author: { name: string; date: string } } }

function toCommitInfo(c: RawCommit): CommitInfo {
  return { sha: c.sha, message: c.commit.message, author: c.commit.author.name, date: c.commit.author.date };
}

export async function getBranchSha(c: GitHubClient, repo: string, branch: string): Promise<string | null> {
  try {
    const res = await c.rest<{ object: { sha: string } }>("GET", `/repos/${repo}/git/ref/heads/${encodePath(branch)}`);
    return res.object.sha;
  } catch (e) {
    if (e instanceof GitHubError && e.kind === "not-found") return null;
    throw e;
  }
}

export async function listBranches(c: GitHubClient, repo: string): Promise<{ name: string; sha: string }[]> {
  const res = await c.rest<{ name: string; commit: { sha: string } }[]>("GET", `/repos/${repo}/branches?per_page=100`);
  return res.map((b) => ({ name: b.name, sha: b.commit.sha }));
}

/** Maps path to blob SHA; only blobs are included. */
export async function getTree(c: GitHubClient, repo: string, commitSha: string): Promise<Map<string, string>> {
  const res = await c.rest<{ truncated: boolean; tree: { path: string; type: string; sha: string }[] }>(
    "GET", `/repos/${repo}/git/trees/${commitSha}?recursive=1`);
  if (res.truncated) throw new Error("Repository tree is too large");
  const out = new Map<string, string>();
  for (const e of res.tree) if (e.type === "blob") out.set(e.path, e.sha);
  return out;
}

export async function createBranch(c: GitHubClient, repo: string, name: string, fromSha: string): Promise<void> {
  await c.rest("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${name}`, sha: fromSha });
}

export async function commitFiles(c: GitHubClient, repo: string,
  input: { branch: string; parentSha: string; message: string; changes: FileChange[] }): Promise<string> {
  if (input.changes.length === 0) throw new Error("Nothing to commit");
  const parent = await c.rest<{ tree: { sha: string } }>("GET", `/repos/${repo}/git/commits/${input.parentSha}`);

  const entries: { path: string; mode: "100644"; type: "blob"; sha: string | null }[] = new Array(input.changes.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < input.changes.length) {
      const i = next++;
      const { path, content } = input.changes[i];
      if (content === null) {
        entries[i] = { path, mode: "100644", type: "blob", sha: null };
        continue;
      }
      const body = typeof content === "string"
        ? { content, encoding: "utf-8" }
        : { content: toBase64(content), encoding: "base64" };
      const blob = await c.rest<{ sha: string }>("POST", `/repos/${repo}/git/blobs`, body);
      entries[i] = { path, mode: "100644", type: "blob", sha: blob.sha };
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_BLOBS, input.changes.length) }, worker));

  const tree = await c.rest<{ sha: string }>("POST", `/repos/${repo}/git/trees`, { base_tree: parent.tree.sha, tree: entries });
  const commit = await c.rest<{ sha: string }>("POST", `/repos/${repo}/git/commits`,
    { message: input.message, tree: tree.sha, parents: [input.parentSha] });
  await c.rest("PATCH", `/repos/${repo}/git/refs/heads/${encodePath(input.branch)}`, { sha: commit.sha, force: false });
  return commit.sha;
}

export async function listCommits(c: GitHubClient, repo: string, branch: string, page: number): Promise<CommitInfo[]> {
  const res = await c.rest<RawCommit[]>("GET", `/repos/${repo}/commits?sha=${encodePath(branch)}&per_page=30&page=${page}`);
  return res.map(toCommitInfo);
}

export async function compare(c: GitHubClient, repo: string, base: string, head: string): Promise<{
  status: "identical" | "ahead" | "behind" | "diverged"; aheadBy: number; behindBy: number; commits: CommitInfo[];
}> {
  const res = await c.rest<{
    status: "identical" | "ahead" | "behind" | "diverged"; ahead_by: number; behind_by: number; commits: RawCommit[];
  }>("GET", `/repos/${repo}/compare/${encodePath(base)}...${encodePath(head)}`);
  return { status: res.status, aheadBy: res.ahead_by, behindBy: res.behind_by, commits: res.commits.map(toCommitInfo) };
}

export async function createTag(c: GitHubClient, repo: string, input: { name: string; sha: string; message: string }): Promise<void> {
  const tag = await c.rest<{ sha: string }>("POST", `/repos/${repo}/git/tags`,
    { tag: input.name, message: input.message, object: input.sha, type: "commit" });
  await c.rest("POST", `/repos/${repo}/git/refs`, { ref: `refs/tags/${input.name}`, sha: tag.sha });
}

export async function listTags(c: GitHubClient, repo: string): Promise<TagInfo[]> {
  const res = await c.rest<{ name: string; commit: { sha: string } }[]>("GET", `/repos/${repo}/tags?per_page=100`);
  return res.map((t) => ({ name: t.name, sha: t.commit.sha }));
}

export function isValidRefName(name: string): boolean {
  if (name === "") return false;
  if (/[\s~^:?*[\\]/.test(name)) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  if (/^[/.-]/.test(name)) return false;
  if (/[/.]$/.test(name) || name.endsWith(".lock")) return false;
  if (name.split("/").some((s) => s.startsWith("."))) return false;
  return true;
}

export async function getRepo(c: GitHubClient, repo: string): Promise<RepoRef | null> {
  try {
    const res = await c.rest<{ full_name: string; default_branch: string }>("GET", `/repos/${repo}`);
    return { repo: res.full_name, defaultBranch: res.default_branch };
  } catch (e) {
    if (e instanceof GitHubError && e.kind === "not-found") return null;
    throw e;
  }
}

/** Reads a text file at `ref`; null when it does not exist. Decodes Base64 without Buffer. */
export async function readTextFile(c: GitHubClient, repo: string, ref: string, path: string): Promise<string | null> {
  try {
    const res = await c.rest<{ content: string }>("GET", `/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
    const binary = atob(res.content.replace(/\s/g, ""));
    return new TextDecoder("utf-8").decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
  } catch (e) {
    if (e instanceof GitHubError && e.kind === "not-found") return null;
    throw e;
  }
}

export async function whoAmI(c: GitHubClient): Promise<{ login: string }> {
  const res = await c.rest<{ login: string }>("GET", "/user");
  return { login: res.login };
}
