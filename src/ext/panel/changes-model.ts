import type { ChangeKind, ObjectGroup, Part } from "../../core/diff";
import type { ChangeItem } from "../flows/local-changes";

export type SectionKey = ChangeKind;
export interface ChangeGroup { label: string; items: ChangeItem[] }
export interface ChangeSection { key: SectionKey; label: string; groups: ChangeGroup[] }

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "added", label: "Added objects" },
  { key: "deleted", label: "Deleted objects" },
  { key: "changed", label: "Changed objects" },
];

const GROUPS: { label: string; groups: ObjectGroup[] }[] = [
  { label: "Sheets", groups: ["sheets"] },
  { label: "Master Items", groups: ["dimensions", "measures", "masterobjects"] },
  { label: "Variables", groups: ["variables"] },
  { label: "Script", groups: ["script"] },
  { label: "Attached files", groups: ["attachedFiles"] },
  { label: "Stories", groups: ["stories"] },
  { label: "Bookmarks", groups: ["bookmarks"] },
  { label: "App properties", groups: ["appprops"] },
];

export const PARTS: { part: Part; label: string }[] = [
  { part: "script", label: "Load script" },
  { part: "objects", label: "App Objects" },
  { part: "bookmarks", label: "Bookmarks" },
  { part: "files", label: "Attached files" },
];

const byTitle = (a: ChangeItem, b: ChangeItem): number => {
  const x = a.title.toLowerCase();
  const y = b.title.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
};

/** The changes as the panel lists them; empty sections and groups are left out. */
export function sections(items: ChangeItem[]): ChangeSection[] {
  const result: ChangeSection[] = [];
  for (const section of SECTIONS) {
    const groups: ChangeGroup[] = [];
    for (const group of GROUPS) {
      const members = items.filter((i) => i.kind === section.key && group.groups.includes(i.group)).sort(byTitle);
      if (members.length > 0) groups.push({ label: group.label, items: members });
    }
    if (groups.length > 0) result.push({ ...section, groups });
  }
  return result;
}

export function initialSelection(items: ChangeItem[]): Set<string> {
  return new Set(items.map((i) => i.path));
}

/** Selects or deselects the given paths in a copy of the selection. */
export function togglePaths(selection: Set<string>, paths: string[], on: boolean): Set<string> {
  const next = new Set(selection);
  for (const path of paths) {
    if (on) next.add(path);
    else next.delete(path);
  }
  return next;
}

/** The paths that a tick on `item` selects or deselects: the load script is saved as a whole. */
export function pathsToggledWith(items: ChangeItem[], item: ChangeItem): string[] {
  if (item.group !== "script") return [item.path];
  return items.filter((i) => i.group === "script").map((i) => i.path);
}

export function togglePart(selection: Set<string>, items: ChangeItem[], part: Part, on: boolean): Set<string> {
  return togglePaths(selection, items.filter((i) => i.part === part).map((i) => i.path), on);
}

export type Tri = "all" | "some" | "none";

export function triState(selection: Set<string>, paths: string[]): Tri {
  const chosen = paths.filter((p) => selection.has(p)).length;
  return chosen === 0 ? "none" : chosen === paths.length ? "all" : "some";
}

export function pullRequestUrl(repo: string, defaultBranch: string, branch: string): string {
  const encode = (name: string): string => name.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repo}/compare/${encode(defaultBranch)}...${encode(branch)}`;
}
