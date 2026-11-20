import type { FileContent, FileMap } from "../core/types";
import { GitHubError } from "./errors";
import type { GitHubClient } from "./client";
import type { RepoRef } from "./snapshot";
import { QOMMIT_TOPIC } from "../core/repo-layout";

export interface CommitInfo { sha: string; message: string; author: string; date: string; parents: string[] }
export interface TagInfo { name: string; sha: string /* commit */; date: string | null; message: string }
export interface BlobRef { path: string; sha: string }
export interface FileChange { path: string; content: FileContent | null } // null = delete

const MAX_CONCURRENT_BLOBS = 5;
export const MAX_BLOBS_PER_CALL = 100;
const MAX_CONCURRENT_BLOB_READS = 8;
/** Largest text (in UTF-8 bytes) sent inline, and the most inline content one tree request carries. */
const MAX_INLINE_BYTES = 1_000_000;

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

interface RawCommit { sha: string; parents: { sha: string }[]; commit: { message: string; author: { name: string; date: string } } }

function toCommitInfo(c: RawCommit): CommitInfo {
  return { sha: c.sha, message: c.commit.message, author: c.commit.author.name, date: c.commit.author.date, parents: c.parents.map((p) => p.sha) };
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
  const out: { name: string; sha: string }[] = [];
  for (let page = 1; ; page++) {
    const res = await c.rest<{ name: string; commit: { sha: string } }[]>("GET", `/repos/${repo}/branches?per_page=100&page=${page}`);
    for (const b of res) out.push({ name: b.name, sha: b.commit.sha });
    if (res.length < 100) return out;
  }
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

type TreeEntry =
  | { path: string; mode: "100644"; type: "blob"; content: string }
  | { path: string; mode: "100644"; type: "blob"; sha: string | null };

/**
 * Text up to MAX_INLINE_BYTES travels inline in the tree requests; binary content and larger text
 * are uploaded as blobs first. Trees are chained so no request carries more than MAX_INLINE_BYTES
 * of inline content. The branch only moves with the final ref update.
 *
 * `replaceRoot` replaces a first commit (one without parents, such as the one GitHub creates with `auto_init`)
 * instead of building on it: the new commit has no parents and the branch is forced onto it.
 */
export async function commitFiles(c: GitHubClient, repo: string,
  input: { branch: string; parentSha: string; message: string; changes: FileChange[]; replaceRoot?: boolean }): Promise<string> {
  if (input.changes.length === 0) throw new Error("Nothing to commit");
  const parent = await c.rest<{ tree: { sha: string }; parents?: unknown[] }>("GET", `/repos/${repo}/git/commits/${input.parentSha}`);
  if (input.replaceRoot && (parent.parents ?? []).length !== 0) throw new Error(`${input.parentSha} is not the first commit`);

  const encoder = new TextEncoder();
  const entries: TreeEntry[] = new Array(input.changes.length);
  const inlineBytes: number[] = new Array(input.changes.length).fill(0);
  const uploads: number[] = [];
  input.changes.forEach(({ path, content }, i) => {
    if (content === null) {
      entries[i] = { path, mode: "100644", type: "blob", sha: null };
    } else if (typeof content === "string") {
      const bytes = encoder.encode(content).length;
      if (bytes <= MAX_INLINE_BYTES) {
        entries[i] = { path, mode: "100644", type: "blob", content };
        inlineBytes[i] = bytes;
      } else {
        uploads.push(i);
      }
    } else {
      uploads.push(i);
    }
  });

  let next = 0;
  async function worker(): Promise<void> {
    while (next < uploads.length) {
      const i = uploads[next++];
      const { path, content } = input.changes[i];
      const body = typeof content === "string"
        ? { content, encoding: "utf-8" }
        : { content: toBase64(content as Uint8Array), encoding: "base64" };
      const blob = await c.rest<{ sha: string }>("POST", `/repos/${repo}/git/blobs`, body);
      entries[i] = { path, mode: "100644", type: "blob", sha: blob.sha };
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_BLOBS, uploads.length) }, worker));

  let treeSha = parent.tree.sha;
  let batch: TreeEntry[] = [];
  let batchBytes = 0;
  const flush = async (): Promise<void> => {
    const tree = await c.rest<{ sha: string }>("POST", `/repos/${repo}/git/trees`, { base_tree: treeSha, tree: batch });
    treeSha = tree.sha;
    batch = [];
    batchBytes = 0;
  };
  for (let i = 0; i < entries.length; i++) {
    if (batch.length > 0 && batchBytes + inlineBytes[i] > MAX_INLINE_BYTES) await flush();
    batch.push(entries[i]);
    batchBytes += inlineBytes[i];
  }
  await flush();

  const commit = await c.rest<{ sha: string }>("POST", `/repos/${repo}/git/commits`,
    { message: input.message, tree: treeSha, parents: input.replaceRoot ? [] : [input.parentSha] });
  await c.rest("PATCH", `/repos/${repo}/git/refs/heads/${encodePath(input.branch)}`,
    { sha: commit.sha, force: input.replaceRoot === true });
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

const TAGS_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/tags/", first: 100, after: $cursor, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { name target { __typename oid ... on Tag { message tagger { date } target { oid } } ... on Commit { committedDate } } }
    }
  }
}`;

interface TagsResponse {
  repository: { refs: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: ({ name: string; target: {
      __typename: string; oid: string; message?: string; tagger?: { date: string | null } | null;
      target?: { oid: string }; committedDate?: string | null;
    } } | null)[];
  } };
}

/** Lists all tags, newest first. Annotated tags resolve to the commit they point at. */
export async function listTags(c: GitHubClient, repo: string): Promise<TagInfo[]> {
  const [owner, name] = repo.split("/");
  const out: TagInfo[] = [];
  let cursor: string | null = null;
  for (;;) {
    const data: TagsResponse = await c.graphql<TagsResponse>(TAGS_QUERY, { owner, name, cursor });
    const { nodes, pageInfo } = data.repository.refs;
    for (const n of nodes) {
      if (!n) continue;
      const t = n.target;
      if (t.__typename === "Tag" && t.target) out.push({ name: n.name, sha: t.target.oid, date: t.tagger?.date ?? null, message: t.message ?? "" });
      else out.push({ name: n.name, sha: t.oid, date: t.committedDate ?? null, message: "" });
    }
    if (!pageInfo.hasNextPage || pageInfo.endCursor === null) return out; // a null cursor would restart at page one
    cursor = pageInfo.endCursor;
  }
}

/** Reads blobs by SHA (at most 8 at a time). Paths under `appcontent/` come back as bytes, all others as UTF-8 text with their BOM kept. */
export async function readBlobs(c: GitHubClient, repo: string, items: BlobRef[]): Promise<FileMap> {
  if (items.length > MAX_BLOBS_PER_CALL) throw new Error("Too many blobs in one call");
  const out: FileMap = new Map();
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let next = 0;
  let failed = false;
  async function worker(): Promise<void> {
    while (!failed && next < items.length) {
      const { path, sha } = items[next++];
      try {
        const res = await c.rest<{ content: string }>("GET", `/repos/${repo}/git/blobs/${sha}`);
        const bytes = Uint8Array.from(atob(res.content.replace(/\s/g, "")), (ch) => ch.charCodeAt(0));
        out.set(path, path.startsWith("appcontent/") ? bytes : decoder.decode(bytes));
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_BLOB_READS, items.length) }, worker));
  return out;
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

/** Adds the Qommit topic to the repository, keeping its other topics. Writes nothing when it is already set. */
export async function markRepo(c: GitHubClient, repo: string): Promise<void> {
  const { names } = await c.rest<{ names: string[] }>("GET", `/repos/${repo}/topics`);
  if (names.includes(QOMMIT_TOPIC)) return;
  await c.rest("PUT", `/repos/${repo}/topics`, { names: [...names, QOMMIT_TOPIC] });
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
