import type { AppSnapshot, FileContent, FileMap } from "./types";
import { TAB_ORDER_PATH, TAB_DIVIDER } from "./script-tabs";
import { groupOf } from "./diff";

export type TargetProblemReason =
  | "invalid-json" | "conflict-markers" | "missing-tab-file" | "unlisted-tab-file" | "missing-tab-order" | "invalid-object" | "variable-name-taken";
export interface TargetProblem { path: string; reason: TargetProblemReason }

const TAB_DIR = "data_load_script/";
const TREE_GROUPS: ReadonlySet<string> = new Set(["masterobjects", "sheets", "stories"]);

function asText(content: FileContent): string {
  return typeof content === "string" ? content : new TextDecoder("utf-8").decode(content);
}

// A bare "=======" line is deliberately not a marker: a load script may contain one legitimately.
function hasConflictMarkers(text: string): boolean {
  return text.split("\n").some((line) => line.startsWith("<<<<<<< ") || line.startsWith(">>>>>>> "));
}

/** Parses JSON; `undefined` means the text is not valid JSON (JSON itself has no undefined). */
function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idOfGeneric(value: unknown): unknown {
  return isRecord(value) && isRecord(value.qInfo) ? value.qInfo.qId : undefined;
}

// The planner tells trees from generic objects by `qChildren`, so a tree without it would be misread.
function idOfTree(value: unknown): unknown {
  return isRecord(value) && Array.isArray(value.qChildren) ? idOfGeneric(value.qProperty) : undefined;
}

/** True when a parsed file has the shape the deserializer and the update planner rely on. */
function isValidObject(path: string, group: string, value: unknown): boolean {
  if (group === "appprops") return Array.isArray(value) && value.every((t) => typeof idOfTree(t) === "string");
  const baseName = path.slice(path.lastIndexOf("/") + 1, -".json".length);
  const id = TREE_GROUPS.has(group) ? idOfTree(value) : idOfGeneric(value);
  return typeof id === "string" && id === baseName;
}

/** Checks every maintained file of a target snapshot; returns problems sorted by path (empty = fine). */
export function validateTarget(files: FileMap): TargetProblem[] {
  const problems = new Map<string, TargetProblemReason>();

  for (const [path, content] of files) {
    const group = groupOf(path);
    if (group === null || group === "attachedFiles") continue;
    const text = asText(content);
    if (hasConflictMarkers(text)) { problems.set(path, "conflict-markers"); continue; }
    if (!path.endsWith(".json")) continue;
    const value = parseJson(text);
    if (value === undefined) problems.set(path, "invalid-json");
    else if (!isValidObject(path, group, value)) problems.set(path, "invalid-object");
  }

  const order = files.get(TAB_ORDER_PATH);
  const listed = new Set<string>();
  // Without the order file the script would be restored as empty, wiping the app's load script.
  if (order === undefined) {
    problems.set(TAB_ORDER_PATH, "missing-tab-order");
  } else {
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

/**
 * Target variables that would take the name of a script-created or reserved variable of the app.
 * Those variables are never written, so Qlik would refuse the name; sorted by path.
 */
export function variableNameConflicts(app: AppSnapshot, target: AppSnapshot): TargetProblem[] {
  const owned = new Map<string, string>(); // name -> id of the app's own variable
  for (const v of app.variables) {
    if ((v.qIsScriptCreated === true || v.qIsReserved === true) && typeof v.qName === "string") owned.set(v.qName, v.qInfo.qId);
  }
  return target.variables
    .filter((v) => typeof v.qName === "string" && owned.has(v.qName) && owned.get(v.qName) !== v.qInfo.qId)
    .map((v): TargetProblem => ({ path: `objects/variables/${v.qInfo.qId}.json`, reason: "variable-name-taken" }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
