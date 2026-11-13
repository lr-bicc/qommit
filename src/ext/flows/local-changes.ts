import { diffTrees, partOf, titleOf, type ChangeKind, type ObjectGroup, type Part } from "../../core/diff";
import { gitBlobSha } from "../../core/git-hash";
import { canonicalAppId, parseBranchTable } from "../../core/repo-layout";
import { serializeApp } from "../../core/serializer";
import type { FileMap } from "../../core/types";
import { FlowError, type FlowPorts } from "./ports";

export interface ChangeItem { path: string; kind: ChangeKind; group: ObjectGroup; part: Part; title: string }
export interface LocalChanges { repo: string; baseSha: string; items: ChangeItem[]; unmaintained: string[] }

type Progress = (done: number, total: number) => void;

const UNMAINTAINED_FILES: ReadonlySet<string> = new Set([
  "loadScript.qvs", "objects/fields.json", "objects/themes.json", "objects/glossarylinks.json",
]);

/** Reads the app and serialises it with the repository's canonical app id. */
export async function buildLocalFiles(ports: FlowPorts, repo: string, onProgress?: Progress): Promise<FileMap> {
  const snap = await ports.app.read({ includeFiles: true, onProgress });
  const info = await ports.github.getRepo(repo);
  if (!info) throw new FlowError("repo-not-found", `Repository ${repo} was not found`);
  const readme = await ports.github.readTextFile(repo, info.defaultBranch, "README.md");
  const rows = readme === null ? [] : parseBranchTable(readme);
  return serializeApp(snap, { canonicalAppId: canonicalAppId(rows, info.defaultBranch) ?? snap.appId });
}

export async function hashFiles(files: FileMap): Promise<Map<string, string>> {
  const entries = await Promise.all([...files].map(async ([path, content]) => [path, await gitBlobSha(content)] as const));
  return new Map(entries);
}

/** Paths of the base tree that the tool does not maintain but a commit may remove. */
export function unmaintainedPaths(tree: Map<string, string>): string[] {
  return [...tree.keys()]
    .filter((p) => UNMAINTAINED_FILES.has(p) || p.startsWith("builds/"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export async function computeLocalChanges(
  ports: FlowPorts, target: { repo: string; baseSha: string }, onProgress?: Progress,
): Promise<LocalChanges> {
  const files = await buildLocalFiles(ports, target.repo, onProgress);
  const [local, base] = await Promise.all([hashFiles(files), ports.github.getTree(target.repo, target.baseSha)]);
  const items = diffTrees(base, local).map((c): ChangeItem => ({
    path: c.path, kind: c.kind, group: c.group, part: partOf(c.group),
    title: c.kind === "deleted" ? c.path.slice(c.path.lastIndexOf("/") + 1) : titleOf(c.path, files.get(c.path)),
  }));
  return { repo: target.repo, baseSha: target.baseSha, items, unmaintained: unmaintainedPaths(base) };
}
