import { groupOf } from "../../core/diff";
import type { CommitInfo, FileChange } from "../../github/repo";
import type { LinkData } from "../../qlik/link";
import { GatewayError } from "../shared/github-port";
import { buildLocalFiles, hashFiles, unmaintainedPaths } from "./local-changes";
import { FlowError, sameMaintainedTree, saveLink, type FlowPorts } from "./ports";

const SCRIPT_DIR = "data_load_script/";

export type CommitResult = { sha: string } | { behind: CommitInfo[] };

export interface CommitInput {
  link: LinkData;
  message: string;
  paths: string[];
  removeUnmaintained: boolean;
  allowBehind: boolean;
}

/** Writes the selected changes of the app to the linked branch as one commit. */
export async function commitChanges(
  ports: FlowPorts, input: CommitInput, onProgress?: (done: number, total: number) => void,
): Promise<CommitResult> {
  let { link } = input;
  if ((await ports.app.info()).published) throw new FlowError("published", "Published apps cannot be saved to GitHub");
  const message = input.message.trim();
  if (message === "") throw new FlowError("message-required", "A commit message is required");

  const head = await ports.github.getBranchSha(link.repo, link.branch);
  if (head === null) throw new FlowError("branch-not-found", `Branch ${link.branch} was not found in ${link.repo}`);
  if (head !== link.syncedSha && !input.allowBehind) {
    if (!(await sameMaintainedTree(ports.github, link.repo, link.syncedSha, head))) return behindOf(ports, link, head);
    link = { ...link, syncedSha: head }; // only the README or unmaintained files moved on
  }

  const files = await buildLocalFiles(ports, link.repo, onProgress);
  const [local, tree] = await Promise.all([hashFiles(files), ports.github.getTree(link.repo, head)]);

  const changes: FileChange[] = [];
  const seen = new Set<string>();
  const add = (path: string): void => {
    // Only paths the tool maintains can be selected; everything else is left alone.
    if (seen.has(path) || groupOf(path) === null) return;
    seen.add(path);
    const content = files.get(path);
    if (content === undefined) {
      if (tree.has(path)) changes.push({ path, content: null });
    } else if (local.get(path) !== tree.get(path)) {
      changes.push({ path, content });
    }
  };
  for (const path of input.paths) add(path);
  // The load script is saved as a whole: its tab files and tab order only make sense together.
  if (input.paths.some((p) => p.startsWith(SCRIPT_DIR) && groupOf(p) !== null)) {
    const scriptPaths = new Set([...files.keys(), ...tree.keys()].filter((p) => p.startsWith(SCRIPT_DIR)));
    for (const path of [...scriptPaths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) add(path);
  }
  if (input.removeUnmaintained) {
    for (const path of unmaintainedPaths(tree)) changes.push({ path, content: null });
  }
  if (changes.length === 0) throw new FlowError("nothing-to-commit", "The selected changes are already in the repository");

  let sha: string;
  try {
    sha = await ports.github.commitFiles(link.repo, { branch: link.branch, parentSha: head, message, changes });
  } catch (e) {
    if (e instanceof GatewayError && e.kind === "not-fast-forward") {
      const moved = await ports.github.getBranchSha(link.repo, link.branch);
      if (moved === null) throw new FlowError("branch-not-found", `Branch ${link.branch} was not found in ${link.repo}`);
      return behindOf(ports, link, moved);
    }
    throw e;
  }
  await saveLink(ports, { ...link, syncedSha: sha });
  return { sha };
}

async function behindOf(ports: FlowPorts, link: LinkData, head: string): Promise<{ behind: CommitInfo[] }> {
  return { behind: (await ports.github.compare(link.repo, link.syncedSha, head)).commits };
}
