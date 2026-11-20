import { deserializeApp } from "../../core/deserializer";
import { diffTrees, type Part } from "../../core/diff";
import { validateTarget, variableNameConflicts } from "../../core/target-validator";
import type { AppSnapshot, FileMap } from "../../core/types";
import { describeAction, planUpdate, summarize, type Action, type ActionItem, type PlanSummary } from "../../core/update-planner";
import type { LinkData } from "../../qlik/link";
import { readLocal } from "./local-changes";
import { FlowError, isAncestor, type AppInfo, type FlowPorts } from "./ports";
import { loadTarget } from "./target";

export type UpdatePart = "script" | "objects" | "files";
export const UPDATE_PARTS: UpdatePart[] = ["script", "objects", "files"];

export interface UpdateInput { link: LinkData; target: string; parts: UpdatePart[] }
export interface UpdatePreview { target: string; items: ActionItem[]; summary: PlanSummary; localChanges: number; onBranch: boolean }

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

  const local = await readLocal(ports, link.repo, onProgress);
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
  return { info, local, baseTree, actions, preview: { target, items, summary: summarize(actions), localChanges, onBranch } };
}

export async function previewUpdate(ports: FlowPorts, input: UpdateInput, onProgress?: Progress): Promise<UpdatePreview> {
  return (await prepareUpdate(ports, input, onProgress)).preview;
}
