import { createReadme, parseBranchTable, repoSlug, repoSlugWithId, upsertBranchRow } from "../../core/repo-layout";
import { serializeApp } from "../../core/serializer";
import type { FileChange } from "../../github/repo";
import { isValidRefName } from "../../github/repo";
import type { LinkData } from "../../qlik/link";
import { GatewayError, type GitHubPort } from "../shared/github-port";
import { FlowError, cacheKey, isAncestor, saveLink, type AppInfo, type FlowPorts } from "./ports";
import type { CopySource } from "./status";

const TABLE_COMMIT_MESSAGE = "Update branches table";

export function suggestBranchName(user: string): string {
  return user.toLowerCase().replace(/[^a-z0-9._-]/g, "-") || "branch";
}

async function requireUnpublished(ports: FlowPorts): Promise<AppInfo> {
  const info = await ports.app.info();
  if (info.published) throw new FlowError("published", "A published app cannot be linked or unlinked");
  return info;
}

/** Checks that must pass before a new branch is written. */
async function requireFreeBranchName(github: GitHubPort, repo: string, name: string): Promise<void> {
  if (!isValidRefName(name)) throw new FlowError("invalid-branch-name", `"${name}" is not a valid branch name`);
  if ((await github.getBranchSha(repo, name)) !== null) throw new FlowError("branch-exists", `Branch ${name} already exists`);
}

async function requireRepo(github: GitHubPort, repo: string): Promise<{ repo: string; defaultBranch: string }> {
  const info = await github.getRepo(repo);
  if (!info) throw new FlowError("repo-not-found", `Repository ${repo} was not found`);
  return info;
}

async function headOf(github: GitHubPort, repo: string, branch: string): Promise<string> {
  const sha = await github.getBranchSha(repo, branch);
  if (sha === null) throw new FlowError("branch-not-found", `Branch ${branch} was not found`);
  return sha;
}

/** Commits the app's row of the branch table onto `onBranch`; returns the branch head (unchanged when the row is already there). */
async function commitRow(ports: FlowPorts, repo: string, onBranch: string, row: { branch: string; appUrl: string }): Promise<string> {
  const { github } = ports;
  const parentSha = await headOf(github, repo, onBranch);
  const current = (await github.readTextFile(repo, onBranch, "README.md")) ?? "";
  const content = upsertBranchRow(current, row);
  if (content === current) return parentSha;
  return github.commitFiles(repo, {
    branch: onBranch, parentSha, message: TABLE_COMMIT_MESSAGE, changes: [{ path: "README.md", content }],
  });
}

/** The branch table on the default branch has a row for `branch` that names an app. */
async function hasAppRow(github: GitHubPort, repo: string, branch: string): Promise<boolean> {
  const readme = await github.readTextFile(repo, branch, "README.md");
  return readme !== null && parseBranchTable(readme).some((r) => r.branch === branch && r.appId !== null);
}

const isProtected = (e: unknown): boolean => e instanceof GatewayError && e.kind === "protected-branch";

/**
 * Puts the app's row on `target` (a branch that is yet to be created) and creates it from `base`.
 * Returns the head of the new branch. When the row commit on `rowBranch` is refused because the
 * branch is protected, the branch is created first and the row goes onto the new branch.
 */
async function createBranchWithRow(
  ports: FlowPorts, repo: string, rowBranch: string, target: string, appUrl: string, base: string | null,
): Promise<string> {
  const { github } = ports;
  const row = { branch: target, appUrl };
  const baseSha = base ?? (await headOf(github, repo, rowBranch));
  try {
    const committed = await commitRow(ports, repo, rowBranch, row);
    await github.createBranch(repo, target, base ?? committed);
    return base ?? committed;
  } catch (e) {
    if (!isProtected(e)) throw e;
  }
  await github.createBranch(repo, target, baseSha);
  return commitRow(ports, repo, target, row);
}

function sheetsOf(snapshot: { sheets: { qProperty: Record<string, unknown> }[] }): { title: string; description: string }[] {
  const entries = snapshot.sheets.map((s, i) => {
    const meta = (s.qProperty.qMetaDef ?? {}) as { title?: unknown; description?: unknown };
    const rank = s.qProperty.rank;
    return {
      i, rank: typeof rank === "number" ? rank : null,
      title: typeof meta.title === "string" ? meta.title : "",
      description: typeof meta.description === "string" ? meta.description : "",
    };
  });
  entries.sort((a, b) => {
    if (a.rank !== null && b.rank !== null && a.rank !== b.rank) return a.rank - b.rank;
    if ((a.rank === null) !== (b.rank === null)) return a.rank === null ? 1 : -1;
    return a.i - b.i;
  });
  return entries.map(({ title, description }) => ({ title, description }));
}

export async function createRepository(ports: FlowPorts, input: { name?: string }): Promise<LinkData> {
  const { github } = ports;
  const info = await requireUnpublished(ports);
  const name = input.name ?? repoSlug(info.title, ports.repoPrefix);
  // Read and serialise first: a failing read must not leave an empty repository behind.
  const snapshot = await ports.app.read({ includeFiles: true });
  const files = serializeApp(snapshot, { canonicalAppId: snapshot.appId });

  const { login } = await github.whoAmI(); // before createRepo: a failure here must not leave a repository behind
  let created;
  try {
    created = await github.createRepo(name);
  } catch (e) {
    if (e instanceof GatewayError && e.kind === "name-exists") {
      throw new FlowError("repo-exists", `Repository ${name} already exists`, {
        name, suggestion: repoSlugWithId(info.title, info.id, ports.repoPrefix),
      });
    }
    throw e;
  }
  const { repo, defaultBranch } = created;
  const readme = createReadme({
    appTitle: info.title, creatorLogin: login, createdAt: ports.now(),
    sheets: sheetsOf(snapshot), defaultBranch, appUrl: info.url,
  });
  files.set("README.md", readme);
  const changes: FileChange[] = [...files].map(([path, content]) => ({ path, content }));
  const syncedSha = await github.commitFiles(repo, {
    branch: defaultBranch, parentSha: await headOf(github, repo, defaultBranch), message: "Initial commit", changes,
  });
  const link: LinkData = { repo, branch: defaultBranch, appId: info.id, syncedSha };
  await saveLink(ports, link);
  return link;
}

export async function connectRepository(
  ports: FlowPorts, input: { repo: string; mode: "new-branch" | "existing-branch"; branch: string },
): Promise<LinkData> {
  const { github } = ports;
  const { repo, mode, branch } = input;
  const info = await requireUnpublished(ports);
  let syncedSha: string;

  if (mode === "new-branch") {
    const { defaultBranch } = await requireRepo(github, repo);
    await requireFreeBranchName(github, repo, branch);
    syncedSha = await createBranchWithRow(ports, repo, defaultBranch, branch, info.url, null);
  } else {
    const { defaultBranch } = await requireRepo(github, repo);
    await headOf(github, repo, branch);
    const row = { branch, appUrl: info.url };
    // The default branch's row is a fixed marker (it names the canonical app id): once it carries an app,
    // connecting another app to the default branch leaves it as it is.
    const keepRow = branch === defaultBranch && (await hasAppRow(github, repo, defaultBranch));
    // The link object in the app is the binding record, the row a convenience: when every branch that
    // could carry the row is protected, the app is linked without it.
    if (!keepRow) {
      try {
        await commitRow(ports, repo, defaultBranch, row);
      } catch (e) {
        if (!isProtected(e)) throw e;
        if (branch !== defaultBranch) {
          try {
            await commitRow(ports, repo, branch, row);
          } catch (e2) {
            if (!isProtected(e2)) throw e2;
          }
        }
      }
    }
    syncedSha = await headOf(github, repo, branch);
  }
  const link: LinkData = { repo, branch, appId: info.id, syncedSha };
  await saveLink(ports, link);
  return link;
}

export async function createBranchForCopy(
  ports: FlowPorts, input: { source: CopySource; name: string; fromSource: boolean },
): Promise<LinkData> {
  const { github } = ports;
  const { source, name, fromSource } = input;
  const info = await requireUnpublished(ports);
  const { defaultBranch } = await requireRepo(github, source.repo);
  await requireFreeBranchName(github, source.repo, name);

  let base: string | null = null;
  if (fromSource && source.branch !== null) base = await github.getBranchSha(source.repo, source.branch);

  const head = await createBranchWithRow(ports, source.repo, defaultBranch, name, info.url, base);
  const keep = source.syncedSha !== null && (await isAncestor(github, source.repo, source.syncedSha, head));
  const link: LinkData = { repo: source.repo, branch: name, appId: info.id, syncedSha: keep ? source.syncedSha! : head };
  await saveLink(ports, link);
  return link;
}

export async function unlinkApp(ports: FlowPorts): Promise<void> {
  const info = await requireUnpublished(ports);
  try {
    await ports.app.removeLink();
  } catch {
    // The link may live only in the local cache, or the app may not be writable.
  }
  const key = cacheKey(info);
  await ports.cache.remove(key);
  await ports.cache.setUnlinked(key, true);
}
