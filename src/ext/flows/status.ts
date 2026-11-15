import { findBranchForApp, parseBranchTable } from "../../core/repo-layout";
import type { LinkData } from "../../qlik/link";
import { GatewayError } from "../shared/github-port";
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

/** The linked repository; null when it does not exist or lies outside the configured organisation. */
async function linkedRepo(github: GitHubPort, repo: string): Promise<{ repo: string; defaultBranch: string } | null> {
  try {
    return await github.getRepo(repo);
  } catch (e) {
    if (e instanceof GatewayError && e.kind === "not-allowed") return null;
    throw e;
  }
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
    if (info.published) return { state: "published", repo: link.repo, branch: link.branch, syncedSha: link.syncedSha };
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
  // Metadata naming a repository outside the organisation is ignored, like one that does not exist.
  const metaRepo = meta?.repo ? await linkedRepo(github, meta.repo) : null;
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
    if (info.published) return { state: "published", repo: hit.repo, branch: hit.branch, syncedSha: lastCommitId };
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
    const syncedSha = lastCommitId !== null && (await isAncestor(github, hit.repo, lastCommitId, head)) ? lastCommitId : head;
    const found: LinkData = { repo: hit.repo, branch: hit.branch, appId: info.id, syncedSha };
    const stored = await saveLink(ports, found);
    return resolveLinked(ports, found, stored);
  }

  if (metaRepo && meta) {
    if (info.published) return { state: "published", repo: metaRepo.repo, branch: null, syncedSha: lastCommitId };
    return {
      state: "duplicated",
      source: { repo: metaRepo.repo, branch: null, syncedSha: lastCommitId },
      defaultBranch: metaRepo.defaultBranch,
    };
  }
  return { state: "unlinked" };
}
