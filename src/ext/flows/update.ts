import { deserializeApp } from "../../core/deserializer";
import { diffTrees, type Part } from "../../core/diff";
import { validateTarget, variableNameConflicts } from "../../core/target-validator";
import type { AppSnapshot, FileMap } from "../../core/types";
import { describeAction, planUpdate, summarize, type Action, type ActionItem, type PlanSummary } from "../../core/update-planner";
import type { LinkData } from "../../qlik/link";
import { readLocal } from "./local-changes";
import { GatewayError } from "../shared/github-port";
import type { FileChange } from "../../github/repo";
import { ApplyError } from "../../qlik/writer";
import { FlowError, isAncestor, saveLink, type AppInfo, type FlowPorts, type UpdateJournal } from "./ports";
import { loadTarget } from "./target";

export type { JournalEntry, UpdateJournal } from "./ports";

export type UpdatePart = "script" | "objects" | "files";
export const UPDATE_PARTS: UpdatePart[] = ["script", "objects", "files"];

export interface UpdateInput { link: LinkData; target: string; parts: UpdatePart[] }
export interface UpdatePreview {
  target: string; items: ActionItem[]; summary: PlanSummary; localChanges: number; onBranch: boolean;
  /** Nothing to apply, but the update still moves the link to the target commit. */
  advances: boolean;
}

type Progress = (done: number, total: number) => void;

export interface PreparedUpdate {
  info: AppInfo;
  local: { snapshot: AppSnapshot; files: FileMap; hashes: Map<string, string> };
  baseTree: Map<string, string>;
  actions: Action[];
  preview: UpdatePreview;
}

/** Loads and checks the target state and plans the update; writes nothing. Shared with the update itself. */
export async function prepareUpdate(ports: FlowPorts, input: UpdateInput, onProgress?: Progress): Promise<PreparedUpdate> {
  const { link, target, parts } = input;
  const info = await ports.app.info();
  if (info.published) throw new FlowError("published", "Published apps cannot be updated");
  if (!info.canWrite) throw new FlowError("cannot-write", "You have no permission to change this app");

  // The app reads report their own progress (the router); `onProgress` only follows the repository load.
  const local = await readLocal(ports, link.repo);
  const targetFiles = await loadTarget(ports.github, link.repo, target, local, onProgress);
  const baseTree = await ports.github.getTree(link.repo, link.syncedSha);

  const fileProblems = validateTarget(targetFiles);
  if (fileProblems.length > 0) throw new FlowError("invalid-target", "The selected state is not a valid app state", fileProblems);
  const current = deserializeApp(local.files, { targetAppId: info.id });
  const targetSnap = deserializeApp(targetFiles, { targetAppId: info.id });
  const conflicts = variableNameConflicts(local.snapshot, targetSnap);
  if (conflicts.length > 0) throw new FlowError("invalid-target", "The selected state is not a valid app state", conflicts);

  const actions = planUpdate(current, targetSnap, new Set<Part>(parts));
  const localChanges = diffTrees(baseTree, local.hashes).length;
  const head = await ports.github.getBranchSha(link.repo, link.branch);
  if (head === null) throw new FlowError("branch-not-found", `Branch ${link.branch} was not found`);
  const onBranch = await isAncestor(ports.github, link.repo, target, head);

  const items = actions.filter((a) => !(a.op === "upsert" && a.temporary)).map(describeAction);
  const advances = actions.length === 0 && onBranch && target !== link.syncedSha;
  return { info, local, baseTree, actions, preview: { target, items, summary: summarize(actions), localChanges, onBranch, advances } };
}

export async function previewUpdate(ports: FlowPorts, input: UpdateInput, onProgress?: Progress): Promise<UpdatePreview> {
  return (await prepareUpdate(ports, input, onProgress)).preview;
}

export interface UpdateResult { syncedSha: string; backupBranch: string | null; applied: number }

const MAX_BACKUP_ATTEMPTS = 20;

/** `backup/<branch>-<yyyymmdd-hhmm>` in local time. */
export function backupBranchName(branch: string, at: Date): string {
  const p = (n: number, width = 2): string => String(n).padStart(width, "0");
  const stamp = `${p(at.getFullYear(), 4)}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`;
  return `backup/${branch}-${stamp}`;
}

/** Saves the local state to a new backup branch; rethrows any failure, including 20 name collisions. */
async function createBackup(ports: FlowPorts, prepared: PreparedUpdate, link: LinkData, target: string): Promise<string> {
  const { local, baseTree } = prepared;
  const changes: FileChange[] = diffTrees(baseTree, local.hashes).map((c) => ({
    path: c.path, content: c.kind === "deleted" ? null : local.files.get(c.path)!,
  }));
  const baseName = backupBranchName(link.branch, ports.now());
  for (let attempt = 1; ; attempt++) {
    const name = attempt === 1 ? baseName : `${baseName}-${attempt}`;
    try {
      await ports.github.createBranch(link.repo, name, link.syncedSha);
    } catch (e) {
      if (e instanceof GatewayError && e.kind === "name-exists" && attempt < MAX_BACKUP_ATTEMPTS) continue;
      throw e;
    }
    await ports.github.commitFiles(link.repo, {
      branch: name, parentSha: link.syncedSha, message: `Backup before update to ${target.slice(0, 7)}`, changes,
    });
    return name;
  }
}

/**
 * Updates the app to the target commit. With local changes, the backup branch exists on GitHub before anything is
 * written to the app; if the backup fails, the app stays untouched.
 */
export async function runUpdate(
  ports: FlowPorts, journal: UpdateJournal, input: UpdateInput, onProgress?: (text: string) => void,
): Promise<UpdateResult> {
  const { link, target } = input;
  const prepared = await prepareUpdate(ports, input, (done, total) => onProgress?.(`Loading repository files… ${done}/${total}`));
  const { actions, preview } = prepared;
  let backupBranch: string | null = null;
  let applied = 0;

  if (actions.length > 0) {
    if (preview.localChanges > 0) {
      onProgress?.("Saving backup…");
      backupBranch = await createBackup(ports, prepared, link, target);
    }
    await journal.set({
      appId: prepared.info.id, repo: link.repo, branch: link.branch, target, backupBranch,
      total: actions.length, startedAt: ports.now().toISOString(),
    });
    try {
      await ports.app.apply(actions, (done, total) => onProgress?.(`Updating app… ${done}/${total}`));
    } catch (e) {
      if (!(e instanceof ApplyError)) throw e;
      const visible = (list: Action[]): ActionItem[] => list.filter((a) => !(a.op === "upsert" && a.temporary)).map(describeAction);
      throw new FlowError("update-failed", e.message, {
        done: visible(e.done), failed: describeAction(e.failed), remaining: visible(e.remaining), backupBranch,
      });
    }
    onProgress?.("Saving app…");
    await ports.app.save();
    await journal.clear(prepared.info.id);
    applied = actions.length;
  } else if (await journal.get(prepared.info.id)) {
    // An earlier update applied everything but did not finish saving: nothing is left to plan, so finish it.
    onProgress?.("Saving app…");
    await ports.app.save();
    await journal.clear(prepared.info.id);
  }

  if (preview.onBranch) await saveLink(ports, { ...link, syncedSha: target });
  return { syncedSha: preview.onBranch ? target : link.syncedSha, backupBranch, applied };
}
