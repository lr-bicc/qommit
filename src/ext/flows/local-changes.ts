import { diffTrees, partOf, titleOf, type ChangeKind, type ObjectGroup, type Part } from "../../core/diff";
import { gitBlobSha } from "../../core/git-hash";
import { canonicalAppId, parseBranchTable } from "../../core/repo-layout";
import { serializeApp } from "../../core/serializer";
import type { AppSnapshot, FileMap } from "../../core/types";
import { withoutGitoqlokFormat } from "./gitoqlok-format";
import { FlowError, type FlowPorts } from "./ports";

export interface ChangeItem { path: string; kind: ChangeKind; group: ObjectGroup; part: Part; title: string }
export interface LocalChanges { repo: string; baseSha: string; items: ChangeItem[]; unmaintained: string[] }

type Progress = (done: number, total: number) => void;

const UNMAINTAINED_FILES: ReadonlySet<string> = new Set([
  "loadScript.qvs", "objects/fields.json", "objects/themes.json", "objects/glossarylinks.json",
]);

/** Reads the app (with its static files), serialises it with the repository's canonical app id and hashes the files. */
export async function readLocal(
  ports: FlowPorts, repo: string, onProgress?: Progress,
): Promise<{ snapshot: AppSnapshot; files: FileMap; hashes: Map<string, string> }> {
  const snapshot = await ports.app.read({ includeFiles: true, onProgress });
  const info = await ports.github.getRepo(repo);
  if (!info) throw new FlowError("repo-not-found", `Repository ${repo} was not found`);
  const readme = await ports.github.readTextFile(repo, info.defaultBranch, "README.md");
  const rows = readme === null ? [] : parseBranchTable(readme);
  const files = serializeApp(snapshot, { canonicalAppId: canonicalAppId(rows, info.defaultBranch) ?? snapshot.appId });
  return { snapshot, files, hashes: await hashFiles(files) };
}

export async function buildLocalFiles(ports: FlowPorts, repo: string, onProgress?: Progress): Promise<FileMap> {
  return (await readLocal(ports, repo, onProgress)).files;
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
  const [{ files, hashes: local }, base] = await Promise.all([
    readLocal(ports, target.repo, onProgress), ports.github.getTree(target.repo, target.baseSha),
  ]);
  const { changes, scriptVariables } = await withoutGitoqlokFormat(ports.github, target.repo, base, files, diffTrees(base, local));
  const items = changes.map((c): ChangeItem => ({
    path: c.path, kind: c.kind, group: c.group, part: partOf(c.group),
    title: c.kind === "deleted" ? c.path.slice(c.path.lastIndexOf("/") + 1) : titleOf(c.path, files.get(c.path)),
  }));
  const unmaintained = [...unmaintainedPaths(base), ...scriptVariables].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { repo: target.repo, baseSha: target.baseSha, items, unmaintained };
}
