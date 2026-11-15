import { diffLines } from "diff";
import type { FileContent } from "./types";

export type ChangeKind = "added" | "deleted" | "changed";
export type ObjectGroup = "script" | "appprops" | "variables" | "dimensions" | "measures"
  | "masterobjects" | "sheets" | "stories" | "bookmarks" | "attachedFiles";
export type Part = "script" | "objects" | "bookmarks" | "files";
export interface TreeChange { path: string; kind: ChangeKind; group: ObjectGroup }
export interface LineChange { kind: "same" | "added" | "removed"; text: string }

const OBJECT_FOLDERS: ReadonlySet<string> = new Set([
  "variables", "dimensions", "measures", "masterobjects", "sheets", "stories", "bookmarks",
]);

/** Classifies a repo path into an object group; null means the extension does not maintain the path. */
export function groupOf(path: string): ObjectGroup | null {
  const parts = path.split("/");
  const [root, second, third] = parts;
  if (root === "data_load_script" && parts.length === 2) {
    return second!.endsWith(".qvs") || second === "tab_order.txt" ? "script" : null;
  }
  if (root === "appcontent" && parts.length >= 2 && parts.slice(1).every((p) => p !== "")) return "attachedFiles";
  if (root === "objects") {
    if (parts.length === 2 && second === "appprops.json") return "appprops";
    if (parts.length === 3 && OBJECT_FOLDERS.has(second!) && third!.endsWith(".json") && third !== ".json") {
      return second as ObjectGroup;
    }
  }
  return null;
}

export function partOf(group: ObjectGroup): Part {
  switch (group) {
    case "script": return "script";
    case "bookmarks": return "bookmarks";
    case "attachedFiles": return "files";
    default: return "objects";
  }
}

/** Compares two path -> blob SHA maps; result is sorted by path. */
export function diffTrees(base: Map<string, string>, local: Map<string, string>): TreeChange[] {
  const changes: TreeChange[] = [];
  const paths = new Set([...base.keys(), ...local.keys()]);
  for (const path of paths) {
    const group = groupOf(path);
    if (group === null) continue;
    const before = base.get(path);
    const after = local.get(path);
    if (before === after) continue;
    const kind: ChangeKind = before === undefined ? "added" : after === undefined ? "deleted" : "changed";
    changes.push({ path, kind, group });
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((v): v is string => typeof v === "string" && v !== "");
}

/** Derives a display title for a repo file; falls back to the file name. */
export function titleOf(path: string, content: FileContent | undefined): string {
  const name = fileName(path);
  if (content === undefined || path.startsWith("appcontent/")) return name;
  const text = typeof content === "string" ? content : new TextDecoder("utf-8").decode(content);
  if (path.endsWith(".json")) {
    try {
      const json = JSON.parse(text) as any;
      return firstString(json?.qMetaDef?.title, json?.qProperty?.qMetaDef?.title, json?.qName) ?? name;
    } catch {
      return name;
    }
  }
  if (path.endsWith(".qvs")) {
    const firstLine = text.split("\n", 1)[0]!.replace(/\r$/, "");
    const match = /^\/\/\/\$tab (.*)$/.exec(firstLine);
    if (match && match[1] !== "") return match[1]!;
  }
  return name;
}

/** Line-based diff; every line is one entry, a trailing "\r" is dropped from the text. */
export function lineDiff(before: string, after: string): LineChange[] {
  const result: LineChange[] = [];
  for (const part of diffLines(before, after)) {
    const kind = part.added ? "added" : part.removed ? "removed" : "same";
    const lines = part.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) result.push({ kind, text: line.replace(/\r$/, "") });
  }
  return result;
}
