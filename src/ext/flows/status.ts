import { findBranchForApp, parseBranchTable } from "../../core/repo-layout";
import type { LinkData } from "../../qlik/link";
import { GatewayError } from "../shared/github-port";
import { startingCommit } from "./adopt";
import type { GitHubPort } from "../shared/github-port";
import { cacheKey, isAncestor, sameMaintainedTree, saveLink, type FlowPorts } from "./ports";

export interface CopySource { repo: string; branch: string | null; syncedSha: string | null }

export type AppStatus =
  | { state: "unlinked" }
  | { state: "linked"; link: LinkData; defaultBranch: string; headSha: string; behindBy: number; stored: "app" | "local" }
  | { state: "branch-missing"; link: LinkData; defaultBranch: string }
  | { state: "repo-missing"; repo: string }
  | { state: "duplicated"; source: CopySource; defaultBranch: string }
  | { state: "published"; repo: string; branch: string | null; syncedSha: string | null };

const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

type RepoRef = { repo: string; defaultBranch: string };

/** The repository; "outside" when it lies outside the configured organisation, null when GitHub does not show it. */
async function lookupRepo(github: GitHubPort, repo: string): Promise<RepoRef | "outside" | null> {
  try {
    return await github.getRepo(repo);
  } catch (e) {
    if (e instanceof GatewayError && e.kind === "not-allowed") return "outside";
    throw e;
  }
}

/** The linked repository; null when it does not exist or lies outside the configured organisation. */
async function linkedRepo(github: GitHubPort, repo: string): Promise<RepoRef | null> {
  const found = await lookupRepo(github, repo);
  return found === "outside" ? null : found;
}

/**
 * The commit a published app was published from: the recorded one (gitoqlok's last commit or the link's), or the
 * head of its branch (the default branch when unknown) when the app already holds it. Publishing through the QMC
 * after a merge leaves the recorded commit behind.
 */
async function publishedFrom(ports: FlowPorts, repo: string, branch: string, recorded: string | null): Promise<string | null> {
  if (!recorded) return recorded;
  const head = await ports.github.getBranchSha(repo, branch);
  if (head === null || head === recorded || !(await isAncestor(ports.github, repo, recorded, head))) return recorded;
  return startingCommit(ports, repo, recorded, head);
}

async function resolveLinked(ports: FlowPorts, link: LinkData, stored: "app" | "local"): Promise<AppStatus> {
  const { github } = ports;
  const repo = await linkedRepo(github, link.repo);
  if (!repo) return { state: "repo-missing", repo: link.repo };
  const headSha = await github.getBranchSha(link.repo, link.branch);
  if (headSha === null) return { state: "branch-missing", link, defaultBranch: repo.defaultBranch };
  if (link.syncedSha !== headSha && (await sameMaintainedTree(github, link.repo, link.syncedSha, headSha))) {
    // Only the README or unmaintained files moved on: the app is up to date with the head.
    const advanced: LinkData = { ...link, syncedSha: headSha };
    const savedTo = await saveLink(ports, advanced);
    return { state: "linked", link: advanced, defaultBranch: repo.defaultBranch, headSha, behindBy: 0, stored: savedTo };
  }
  let behindBy = 0;
  if (link.syncedSha !== headSha) {
    try {
      behindBy = (await github.compare(link.repo, link.syncedSha, headSha)).aheadBy;
    } catch (e) {
      if (!(e instanceof GatewayError && e.kind === "not-found")) throw e; // unknown commit: cannot count
    }
  }
  return { state: "linked", link, defaultBranch: repo.defaultBranch, headSha, behindBy, stored };
}

export async function resolveStatus(ports: FlowPorts): Promise<AppStatus> {
  const { app, github, cache } = ports;
  const info = await app.info();
  const link = await app.readLink();

  if (link) {
    if (info.published) {
      const syncedSha = await publishedFrom(ports, link.repo, link.branch, link.syncedSha);
      return { state: "published", repo: link.repo, branch: link.branch, syncedSha };
    }
    if (sameId(link.appId, info.id)) return resolveLinked(ports, link, "app");
    const repo = await linkedRepo(github, link.repo);
    if (!repo) return { state: "repo-missing", repo: link.repo };
    const branch = (await github.getBranchSha(link.repo, link.branch)) === null ? null : link.branch;
    return {
      state: "duplicated",
      source: { repo: link.repo, branch, syncedSha: link.syncedSha },
      defaultBranch: repo.defaultBranch,
    };
  }

  if (!info.published) {
    if (await cache.isUnlinked(cacheKey(info))) return { state: "unlinked" };
    const cached = await cache.get(cacheKey(info));
    if (cached && sameId(cached.appId, info.id)) return resolveLinked(ports, cached, "local");
  }

  // No link anywhere: look for the app in the repositories.
  const meta = await app.readGitoqlokMeta();
  // Metadata naming a repository outside the organisation is ignored. One inside it that GitHub does not show
  // (deleted, or the token has no access to it) is reported: treating the app as unlinked would hide the cause.
  let metaRepo: RepoRef | null = null;
  if (meta?.repo) {
    const found = await lookupRepo(github, meta.repo);
    if (found === null) return { state: "repo-missing", repo: meta.repo };
    if (found !== "outside") metaRepo = found;
  }
  let hit: { repo: string; branch: string } | null = null;
  if (metaRepo) {
    const readme = await github.readTextFile(metaRepo.repo, metaRepo.defaultBranch, "README.md");
    const branch = readme === null ? null : findBranchForApp(parseBranchTable(readme), info.id);
    if (branch !== null) hit = { repo: metaRepo.repo, branch };
  } else {
    hit = await github.findRepoForApp(info.id);
  }
  const lastCommitId = meta?.lastCommitId ?? null;

  if (hit) {
    if (info.published) {
      return { state: "published", repo: hit.repo, branch: hit.branch, syncedSha: await publishedFrom(ports, hit.repo, hit.branch, lastCommitId) };
    }
    const head = await github.getBranchSha(hit.repo, hit.branch);
    if (head === null) {
      // Listed in the table, but the branch is gone: report it, nothing to store yet.
      const repo = metaRepo ?? (await github.getRepo(hit.repo));
      if (!repo) return { state: "repo-missing", repo: hit.repo };
      return {
        state: "branch-missing",
        link: { repo: hit.repo, branch: hit.branch, appId: info.id, syncedSha: lastCommitId ?? "" },
        defaultBranch: repo.defaultBranch,
      };
    }
    const syncedSha = lastCommitId !== null && (await isAncestor(github, hit.repo, lastCommitId, head))
      ? await startingCommit(ports, hit.repo, lastCommitId, head) // gitoqlok's last commit can lag behind a merge
      : head;
    const found: LinkData = { repo: hit.repo, branch: hit.branch, appId: info.id, syncedSha };
    const stored = await saveLink(ports, found);
    return resolveLinked(ports, found, stored);
  }

  if (metaRepo && meta) {
    if (info.published) {
      const syncedSha = await publishedFrom(ports, metaRepo.repo, metaRepo.defaultBranch, lastCommitId);
      return { state: "published", repo: metaRepo.repo, branch: null, syncedSha };
    }
    return {
      state: "duplicated",
      source: { repo: metaRepo.repo, branch: null, syncedSha: lastCommitId },
      defaultBranch: metaRepo.defaultBranch,
    };
  }
  return { state: "unlinked" };
}
