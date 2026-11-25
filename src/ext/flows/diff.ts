import { diffTrees, titleOf, type ChangeKind, type ObjectGroup } from "../../core/diff";
import type { FileContent, FileMap } from "../../core/types";
import { MAX_BLOBS_PER_CALL } from "../../github/repo";
import { withoutGitoqlokFormat } from "./gitoqlok-format";
import { readLocal } from "./local-changes";
import type { FlowPorts } from "./ports";

export type DiffSide = { kind: "commit"; sha: string } | { kind: "app" };
export interface DiffEntry { path: string; kind: ChangeKind; group: ObjectGroup; title: string }
export interface DiffSource {
  repo: string;
  entries: DiffEntry[];
  /** Both sides of one file; a side without the file is null. Downloads each blob at most once. */
  contents(path: string): Promise<{ before: FileContent | null; after: FileContent | null }>;
}

/** Cache key of one blob: the same path can hold different content on the two sides. */
const keyOf = (path: string, sha: string): string => `${path}\0${sha}`;

/** The state of one side: blob SHAs for the comparison and a way to get a file's content. */
interface SideState {
  hashes: Map<string, string>;
  /** Content that needs no download (the app's own serialisation). */
  local: FileMap | null;
  /** Blob SHAs of a commit's files; used to download what is not local. */
  tree: Map<string, string> | null;
}

/** Lists the differences between two states; contents are downloaded lazily and kept. */
export async function openDiff(
  ports: FlowPorts, repo: string, before: DiffSide, after: DiffSide,
  onProgress?: (done: number, total: number) => void,
): Promise<DiffSource> {
  const needsApp = before.kind === "app" || after.kind === "app";
  const app = needsApp ? await readLocal(ports, repo, onProgress) : null;
  const stateOf = async (side: DiffSide): Promise<SideState> => {
    if (side.kind === "app") return { hashes: app!.hashes, local: app!.files, tree: null };
    const tree = await ports.github.getTree(repo, side.sha);
    return { hashes: tree, local: null, tree };
  };
  const [b, a] = await Promise.all([stateOf(before), stateOf(after)]);
  // Against the app, gitoqlok's format is no difference; between two commits it is what changed.
  const commitSide = before.kind === "commit" && after.kind === "app" ? b : before.kind === "app" && after.kind === "commit" ? a : null;
  const changes = commitSide === null
    ? diffTrees(b.hashes, a.hashes)
    : (await withoutGitoqlokFormat(ports.github, repo, commitSide.tree!, app!.files, diffTrees(b.hashes, a.hashes))).changes;

  const cache = new Map<string, Promise<FileContent | null>>();
  const download = async (state: SideState, path: string): Promise<FileContent | null> => {
    const sha = state.tree?.get(path);
    if (sha === undefined) return null;
    const key = keyOf(path, sha);
    let pending = cache.get(key);
    if (!pending) {
      pending = ports.github.readBlobs(repo, [{ path, sha }]).then((m) => m.get(path) ?? null);
      cache.set(key, pending);
    }
    return pending;
  };
  const sideContent = (state: SideState, path: string): Promise<FileContent | null> =>
    state.local ? Promise.resolve(state.local.get(path) ?? null) : download(state, path);

  // The title comes from the after side if present, else from the before side.
  const titleSide = (kind: ChangeKind): SideState => (kind === "deleted" ? b : a);
  const titled = (path: string, kind: ChangeKind) => ({ path, state: titleSide(kind) });

  // One readBlobs call preloads the title side of the first MAX_BLOBS_PER_CALL downloadable JSON/.qvs entries.
  const preload = changes
    .map((c) => titled(c.path, c.kind))
    .filter(({ path, state }) => state.local === null && (path.endsWith(".json") || path.endsWith(".qvs")))
    .slice(0, MAX_BLOBS_PER_CALL)
    .map(({ path, state }) => ({ path, sha: state.tree!.get(path)! }));
  const known = new Map<string, FileContent>(); // title-side content available without a further download
  if (preload.length > 0) {
    const loaded = await ports.github.readBlobs(repo, preload);
    for (const { path, sha } of preload) {
      const content = loaded.get(path);
      if (content === undefined) continue;
      known.set(path, content);
      cache.set(keyOf(path, sha), Promise.resolve(content));
    }
  }

  const entries: DiffEntry[] = changes.map((c) => {
    const { state } = titled(c.path, c.kind);
    const content = state.local ? state.local.get(c.path) : known.get(c.path);
    return { path: c.path, kind: c.kind, group: c.group, title: titleOf(c.path, content) };
  });

  return {
    repo,
    entries,
    async contents(path) {
      const [bc, ac] = await Promise.all([sideContent(b, path), sideContent(a, path)]);
      return { before: bc, after: ac };
    },
  };
}
