import { unzipSync } from "fflate";
import type { FileMap } from "../core/types";
import { QOMMIT_TOPIC, findBranchForApp, parseBranchTable } from "../core/repo-layout";
import type { GitHubClient } from "./client";

export interface RepoRef { repo: string; defaultBranch: string }
/** A repository of the organisation; `marked` when it carries the Qommit topic. */
export interface OrgRepo extends RepoRef { marked: boolean }

/** Downloads the repository state at `sha` as one ZIP and returns it as a FileMap. */
export async function downloadSnapshot(c: GitHubClient, repo: string, sha: string): Promise<FileMap> {
  const entries = unzipSync(await c.raw(`/repos/${repo}/zipball/${sha}`));
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const files: FileMap = new Map();
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;
    const slash = name.indexOf("/");
    const path = slash === -1 ? name : name.slice(slash + 1);
    if (path === "") continue;
    files.set(path, path.startsWith("appcontent/") ? data : decoder.decode(data));
  }
  return files;
}

export async function createRepo(c: GitHubClient, org: string, name: string): Promise<RepoRef> {
  const r = await c.rest<{ full_name: string; default_branch: string }>(
    "POST", `/orgs/${org}/repos`, { name, private: true, auto_init: true });
  return { repo: r.full_name, defaultBranch: r.default_branch };
}

const ORG_REPOS_QUERY = `query($org: String!, $cursor: String) {
  organization(login: $org) {
    repositories(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        nameWithOwner
        defaultBranchRef { name }
        object(expression: "HEAD:README.md") { ... on Blob { text } }
        repositoryTopics(first: 20) { nodes { topic { name } } }
      }
    }
  }
}`;

interface RepoNode {
  nameWithOwner: string;
  defaultBranchRef: { name: string } | null;
  object: { text?: string } | null;
  repositoryTopics?: { nodes: ({ topic: { name: string } } | null)[] } | null;
}
interface OrgReposResponse {
  organization: { repositories: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (RepoNode | null)[];
  } };
}

async function* orgRepoNodes(c: GitHubClient, org: string): AsyncGenerator<RepoNode> {
  let cursor: string | null = null;
  for (;;) {
    const data: OrgReposResponse = await c.graphql<OrgReposResponse>(ORG_REPOS_QUERY, { org, cursor });
    const { nodes, pageInfo } = data.organization.repositories;
    for (const n of nodes) if (n) yield n;
    if (!pageInfo.hasNextPage || pageInfo.endCursor === null) return; // a null cursor would restart at page one
    cursor = pageInfo.endCursor;
  }
}

/** Lists the organisation's repositories that have a default branch. */
export async function listOrgRepos(c: GitHubClient, org: string): Promise<OrgRepo[]> {
  const out: OrgRepo[] = [];
  for await (const n of orgRepoNodes(c, org)) {
    if (!n.defaultBranchRef) continue;
    const marked = (n.repositoryTopics?.nodes ?? []).some((t) => t?.topic.name === QOMMIT_TOPIC);
    out.push({ repo: n.nameWithOwner, defaultBranch: n.defaultBranchRef.name, marked });
  }
  return out;
}

/** Finds the first repository whose README branch table contains the app. */
export async function findRepoForApp(c: GitHubClient, org: string, appId: string): Promise<{ repo: string; branch: string } | null> {
  for await (const n of orgRepoNodes(c, org)) {
    if (!n.defaultBranchRef || typeof n.object?.text !== "string") continue;
    const branch = findBranchForApp(parseBranchTable(n.object.text), appId);
    if (branch !== null) return { repo: n.nameWithOwner, branch };
  }
  return null;
}
