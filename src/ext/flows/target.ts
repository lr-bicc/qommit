import { groupOf } from "../../core/diff";
import type { FileMap } from "../../core/types";
import { MAX_BLOBS_PER_CALL } from "../../github/repo";
import type { GitHubPort } from "../shared/github-port";

/**
 * Loads the maintained files of a commit. Files whose blob SHA equals the one of the app's own serialisation
 * are taken from `local`; only the others are downloaded, in groups of MAX_BLOBS_PER_CALL.
 */
export async function loadTarget(
  github: GitHubPort, repo: string, sha: string,
  local?: { files: FileMap; hashes: Map<string, string> },
  onProgress?: (done: number, total: number) => void,
): Promise<FileMap> {
  const tree = await github.getTree(repo, sha);
  const files: FileMap = new Map();
  const missing: { path: string; sha: string }[] = [];
  for (const [path, blob] of tree) {
    if (groupOf(path) === null) continue;
    const reusable = local?.hashes.get(path) === blob ? local.files.get(path) : undefined;
    if (reusable !== undefined) files.set(path, reusable);
    else missing.push({ path, sha: blob });
  }
  const total = files.size + missing.length;
  onProgress?.(files.size, total);
  for (let i = 0; i < missing.length; i += MAX_BLOBS_PER_CALL) {
    const batch = missing.slice(i, i + MAX_BLOBS_PER_CALL);
    for (const [path, content] of await github.readBlobs(repo, batch)) files.set(path, content);
    onProgress?.(files.size, total);
  }
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
