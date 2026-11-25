import { replaceAppContentIds } from "../../core/app-content-ids";
import type { TreeChange } from "../../core/diff";
import type { FileMap } from "../../core/types";
import { MAX_BLOBS_PER_CALL } from "../../github/repo";
import type { GitHubPort } from "../shared/github-port";

const NEUTRAL_ID = "00000000-0000-4000-8000-000000000000";

/** The content an app would write: app ids in appcontent urls aligned, gitoqlok's engine stamps in value colours dropped. */
export function comparable(text: string): string | null {
  try {
    const value = JSON.parse(replaceAppContentIds(text, NEUTRAL_ID)) as Record<string, unknown>;
    const colorMap = value?._ColorMapModel;
    if (colorMap && typeof colorMap === "object") delete (colorMap as Record<string, unknown>).qMeta;
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export function isScriptCreated(text: string | null): boolean {
  if (text === null) return false;
  try {
    return (JSON.parse(text) as { qIsScriptCreated?: unknown }).qIsScriptCreated === true;
  } catch {
    return false;
  }
}

/** Repository texts by blob SHA. A blob never changes, so entries stay valid; the size bound only limits memory. */
const texts = new Map<string, string | null>();
const MAX_CACHED_TEXTS = 5000;

async function textsOf(github: GitHubPort, repo: string, refs: { path: string; sha: string }[]): Promise<Map<string, string | null>> {
  const missing = refs.filter((r, i) => !texts.has(r.sha) && refs.findIndex((o) => o.sha === r.sha) === i);
  for (let i = 0; i < missing.length; i += MAX_BLOBS_PER_CALL) {
    const chunk = missing.slice(i, i + MAX_BLOBS_PER_CALL);
    const loaded = await github.readBlobs(repo, chunk);
    if (texts.size + chunk.length > MAX_CACHED_TEXTS) texts.clear();
    for (const { path, sha } of chunk) {
      const content = loaded.get(path);
      texts.set(sha, typeof content === "string" ? content : null);
    }
  }
  return new Map(refs.map((r) => [r.path, texts.get(r.sha) ?? null]));
}

export interface FormatCheck {
  /** The differences that remain once gitoqlok's format is set aside. */
  changes: TreeChange[];
  /** Files of script-created variables in the commit that the app does not hold; a commit may remove them. */
  scriptVariables: string[];
}

/**
 * Sets aside the differences between a commit (`tree`) and the app's files (`app`) that come only from the repository
 * format gitoqlok wrote: script-created variables, which the app never writes; another app id in appcontent urls;
 * and `qMeta` in the value colours of master dimensions. The commit's side of each such file is downloaded once.
 */
export async function withoutGitoqlokFormat(
  github: GitHubPort, repo: string, tree: Map<string, string>, app: FileMap, changes: TreeChange[],
): Promise<FormatCheck> {
  const candidates = changes.filter((c) => {
    if (!tree.has(c.path)) return false;
    const local = app.get(c.path);
    if (local === undefined) return c.group === "variables";
    return c.path.endsWith(".json") && typeof local === "string";
  });
  if (candidates.length === 0) return { changes, scriptVariables: [] };
  const repoTexts = await textsOf(github, repo, candidates.map((c) => ({ path: c.path, sha: tree.get(c.path)! })));

  const formatOnly = new Set<string>();
  const scriptVariables: string[] = [];
  for (const c of candidates) {
    const remote = repoTexts.get(c.path) ?? null;
    const local = app.get(c.path);
    if (local === undefined) {
      if (isScriptCreated(remote)) {
        formatOnly.add(c.path);
        scriptVariables.push(c.path);
      }
    } else if (remote !== null) {
      const own = comparable(local as string);
      if (own !== null && own === comparable(remote)) formatOnly.add(c.path);
    }
  }
  return { changes: changes.filter((c) => !formatOnly.has(c.path)), scriptVariables: scriptVariables.sort() };
}
