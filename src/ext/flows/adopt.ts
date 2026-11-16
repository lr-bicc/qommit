import { replaceAppContentIds } from "../../core/app-content-ids";
import { groupOf } from "../../core/diff";
import { gitBlobSha } from "../../core/git-hash";
import type { FileMap } from "../../core/types";
import { GatewayError, type GitHubPort } from "../shared/github-port";
import { buildLocalFiles } from "./local-changes";
import { sameMaintainedTree, type FlowPorts } from "./ports";

/** Above this many files that need a download to compare, the check gives up and answers "not contained". */
export const MAX_COMPARED_DOWNLOADS = 50;

const NEUTRAL_ID = "00000000-0000-4000-8000-000000000000";

/** The content an app would write: app ids in appcontent urls aligned, gitoqlok's engine stamps in value colours dropped. */
function comparable(text: string): string | null {
  try {
    const value = JSON.parse(replaceAppContentIds(text, NEUTRAL_ID)) as Record<string, unknown>;
    const colorMap = value?._ColorMapModel;
    if (colorMap && typeof colorMap === "object") delete (colorMap as Record<string, unknown>).qMeta;
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function isScriptCreated(text: string | null): boolean {
  if (text === null) return false;
  try {
    return (JSON.parse(text) as { qIsScriptCreated?: unknown }).qIsScriptCreated === true;
  } catch {
    return false;
  }
}

/**
 * True when the app already holds the head's version of every maintained file that changed between `base` and `head`,
 * so the app is up to date with `head` although its recorded commit is `base`. gitoqlok's last commit lags behind
 * merges that were published through the QMC; trusting it would report merged changes as new commits.
 * Whenever the answer is uncertain it is false, which keeps the recorded commit.
 */
export async function appHasCommits(github: GitHubPort, repo: string, files: FileMap, base: string, head: string): Promise<boolean> {
  if (base === head) return true;
  let baseTree: Map<string, string>, headTree: Map<string, string>;
  try {
    [baseTree, headTree] = await Promise.all([github.getTree(repo, base), github.getTree(repo, head)]);
  } catch (e) {
    if (e instanceof GatewayError && e.kind === "not-found") return false;
    throw e;
  }
  const changed = [...new Set([...baseTree.keys(), ...headTree.keys()])]
    .filter((p) => groupOf(p) !== null && baseTree.get(p) !== headTree.get(p));

  const toCompare: string[] = [];
  for (const path of changed) {
    const local = files.get(path);
    const headSha = headTree.get(path);
    if (local === undefined && headSha === undefined) continue; // deleted on both sides
    if (local !== undefined && headSha !== undefined && (await gitBlobSha(local)) === headSha) continue;
    toCompare.push(path);
  }
  if (toCompare.length > MAX_COMPARED_DOWNLOADS) return false;

  for (const path of toCompare) {
    const local = files.get(path);
    if (!headTree.has(path)) return false; // the branch removed it, the app still has it
    if (!path.endsWith(".json") || (local !== undefined && typeof local !== "string")) return false;
    const remote = await github.readTextFile(repo, head, path);
    if (local === undefined) {
      if (path.startsWith("objects/variables/") && isScriptCreated(remote)) continue; // never maintained by the app
      return false;
    }
    if (remote === null) return false;
    const a = comparable(local);
    if (a === null || a !== comparable(remote)) return false;
  }
  return true;
}

/**
 * The commit an app starts from when Qommit takes over a recorded commit (gitoqlok's last commit, or the one a copy
 * inherited): `recorded`, unless the app already holds `head`'s version of everything that changed since.
 * Reads the app only when maintained files differ between the two commits.
 */
export async function startingCommit(ports: FlowPorts, repo: string, recorded: string, head: string): Promise<string> {
  if (recorded === head || (await sameMaintainedTree(ports.github, repo, recorded, head))) return recorded;
  const files = await buildLocalFiles(ports, repo);
  return (await appHasCommits(ports.github, repo, files, recorded, head)) ? head : recorded;
}
