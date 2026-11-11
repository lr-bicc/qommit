import type { FileContent, FileMap } from "./types";
import { TAB_ORDER_PATH, TAB_DIVIDER } from "./script-tabs";
import { groupOf } from "./diff";

export type TargetProblemReason = "invalid-json" | "conflict-markers" | "missing-tab-file" | "unlisted-tab-file";
export interface TargetProblem { path: string; reason: TargetProblemReason }

const TAB_DIR = "data_load_script/";

function asText(content: FileContent): string {
  return typeof content === "string" ? content : new TextDecoder("utf-8").decode(content);
}

// A bare "=======" line is deliberately not a marker: a load script may contain one legitimately.
function hasConflictMarkers(text: string): boolean {
  return text.split("\n").some((line) => line.startsWith("<<<<<<< ") || line.startsWith(">>>>>>> "));
}

function isValidJson(text: string): boolean {
  try { JSON.parse(text); return true; } catch { return false; }
}

/** Checks every maintained file of a target snapshot; returns problems sorted by path (empty = fine). */
export function validateTarget(files: FileMap): TargetProblem[] {
  const problems = new Map<string, TargetProblemReason>();

  for (const [path, content] of files) {
    const group = groupOf(path);
    if (group === null || group === "attachedFiles") continue;
    const text = asText(content);
    if (hasConflictMarkers(text)) problems.set(path, "conflict-markers");
    else if (path.endsWith(".json") && !isValidJson(text)) problems.set(path, "invalid-json");
  }

  const order = files.get(TAB_ORDER_PATH);
  const listed = new Set<string>();
  if (order !== undefined) {
    const orderText = asText(order);
    if (orderText !== "") {
      for (const name of orderText.split(TAB_DIVIDER)) listed.add(`${TAB_DIR}${name}.qvs`);
    }
  }
  for (const path of listed) {
    if (!files.has(path) && !problems.has(path)) problems.set(path, "missing-tab-file");
  }
  for (const path of files.keys()) {
    if (path.endsWith(".qvs") && groupOf(path) === "script" && !listed.has(path) && !problems.has(path)) {
      problems.set(path, "unlisted-tab-file");
    }
  }

  return [...problems].map(([path, reason]) => ({ path, reason }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
