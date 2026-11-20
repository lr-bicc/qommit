import type { AppSnapshot, GenericProps, PropertyTree } from "./types";
import type { Part } from "./diff";
import { toJson } from "./serializer";

export type AppObjectGroup = "appprops" | "variables" | "dimensions" | "measures" | "masterobjects" | "sheets" | "stories";
export type Action =
  | { op: "upsert"; group: AppObjectGroup; id: string; exists: boolean; payload: GenericProps | PropertyTree; temporary?: true }
  | { op: "delete"; group: AppObjectGroup; id: string }
  | { op: "putFile"; name: string; exists: boolean; bytes: Uint8Array }
  | { op: "deleteFile"; name: string }
  | { op: "setScript"; script: string };
export interface PlanSummary { create: number; change: number; delete: number }

// Dependency order: later groups may reference earlier ones.
const GROUP_ORDER: AppObjectGroup[] = ["appprops", "variables", "dimensions", "measures", "masterobjects", "sheets", "stories"];

type Payload = GenericProps | PropertyTree;
const isTree = (p: Payload): p is PropertyTree => "qChildren" in p && "qProperty" in p;
const idOf = (p: Payload): string => (isTree(p) ? p.qProperty.qInfo.qId : p.qInfo.qId);
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Script-created and reserved variables belong to the app, not to the repository.
function isManagedVariable(v: GenericProps): boolean {
  return v.qIsScriptCreated !== true && v.qIsReserved !== true;
}

function objectsOf(snap: AppSnapshot, group: AppObjectGroup): Payload[] {
  switch (group) {
    case "appprops": return snap.appProps;
    case "variables": return snap.variables.filter(isManagedVariable);
    case "dimensions": return snap.dimensions;
    case "measures": return snap.measures;
    case "masterobjects": return snap.masterObjects;
    case "sheets": return snap.sheets;
    case "stories": return snap.stories;
  }
}

const nameOf = (p: Payload): string | undefined =>
  isTree(p) ? undefined : typeof p.qName === "string" ? p.qName : undefined;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Variables that swap names (a cycle of renames) cannot be written one by one, because the name
 * each wants is still held by another. One variable per cycle (the lowest id) first moves to a
 * temporary name, which frees its old name.
 */
function temporaryRenames(cur: Map<string, Payload>, tgt: Map<string, Payload>): Action[] {
  const holderOfTarget = new Map<string, string>(); // target name -> id
  for (const [id, p] of tgt) { const n = nameOf(p); if (n !== undefined) holderOfTarget.set(n, id); }
  const renamed = (id: string): boolean => {
    const c = cur.get(id), t = tgt.get(id);
    return c !== undefined && t !== undefined && nameOf(c) !== undefined && nameOf(c) !== nameOf(t);
  };
  // The variable that takes over the old name of `id` (if it is another one that is renamed as well).
  const successor = (id: string): string | undefined => {
    const next = holderOfTarget.get(nameOf(cur.get(id)!)!);
    return next !== undefined && next !== id && renamed(next) ? next : undefined;
  };
  const actions: Action[] = [];
  const seen = new Set<string>();
  for (const start of [...cur.keys()].filter(renamed).sort()) {
    if (seen.has(start)) continue;
    const path: string[] = [];
    let id: string | undefined = start;
    while (id !== undefined && !seen.has(id) && !path.includes(id)) { path.push(id); id = successor(id); }
    path.forEach(p => seen.add(p));
    if (id === undefined || seen.has(id) && !path.includes(id)) continue; // a chain or an already handled cycle
    const cycle = path.slice(path.indexOf(id));
    const pick = [...cycle].sort()[0];
    const payload = { ...(cur.get(pick) as GenericProps), qName: `${nameOf(cur.get(pick)!)}__qommit_${pick}` };
    actions.push({ op: "upsert", group: "variables", id: pick, exists: true, payload, temporary: true });
  }
  return actions.sort((a, b) => (a as { id: string }).id < (b as { id: string }).id ? -1 : 1);
}

export function planUpdate(current: AppSnapshot, target: AppSnapshot, parts: ReadonlySet<Part>): Action[] {
  const upserts: Action[] = [];
  const deletes: Action[] = [];

  if (parts.has("objects")) {
    for (const group of GROUP_ORDER) {
      const cur = new Map(objectsOf(current, group).map(p => [idOf(p), p]));
      const tgt = new Map(objectsOf(target, group).map(p => [idOf(p), p]));
      const groupUpserts: Extract<Action, { op: "upsert" }>[] = [];
      for (const [id, payload] of tgt) {
        const existing = cur.get(id);
        if (existing && toJson(existing) === toJson(payload)) continue;
        groupUpserts.push({ op: "upsert", group, id, exists: existing !== undefined, payload });
      }
      const groupDeletes: Extract<Action, { op: "delete" }>[] = [];
      if (group !== "appprops") {
        for (const id of cur.keys()) if (!tgt.has(id)) groupDeletes.push({ op: "delete", group, id });
      }
      groupUpserts.sort(byId);
      groupDeletes.sort(byId);

      if (group === "variables") {
        upserts.push(...temporaryRenames(cur, tgt));
        // A deleted variable must free its name immediately before another variable takes it.
        const freed = new Map<string, Action[]>();
        for (const d of groupDeletes) {
          const name = nameOf(cur.get(d.id)!);
          if (name !== undefined) freed.set(name, [...(freed.get(name) ?? []), d]);
        }
        const early = new Set<Action>();
        for (const u of groupUpserts) {
          const name = nameOf(u.payload);
          const blockers = name === undefined ? undefined : freed.get(name);
          if (blockers) { upserts.push(...blockers); blockers.forEach(b => early.add(b)); freed.delete(name!); }
          upserts.push(u);
        }
        deletes.unshift(...groupDeletes.filter(d => !early.has(d)));
      } else {
        upserts.push(...groupUpserts);
        deletes.unshift(...groupDeletes);
      }
    }
  }

  const files: Action[] = [];
  const fileDeletes: Action[] = [];
  if (parts.has("files")) {
    for (const name of [...target.staticFiles.keys()].sort()) {
      const bytes = target.staticFiles.get(name)!;
      const existing = current.staticFiles.get(name);
      if (existing && sameBytes(existing, bytes)) continue;
      files.push({ op: "putFile", name, exists: existing !== undefined, bytes });
    }
    for (const name of [...current.staticFiles.keys()].sort()) {
      if (!target.staticFiles.has(name)) fileDeletes.push({ op: "deleteFile", name });
    }
  }

  const script: Action[] =
    parts.has("script") && current.script !== target.script ? [{ op: "setScript", script: target.script }] : [];

  return [...upserts, ...files, ...script, ...deletes, ...fileDeletes];
}

export function summarize(actions: Action[]): PlanSummary {
  const s: PlanSummary = { create: 0, change: 0, delete: 0 };
  for (const a of actions) {
    if (a.op === "upsert" && a.temporary) continue;
    if (a.op === "delete" || a.op === "deleteFile") s.delete++;
    else if (a.op === "setScript" || a.exists) s.change++;
    else s.create++;
  }
  return s;
}

export interface ActionItem {
  kind: "create" | "change" | "delete";
  group: AppObjectGroup | "files" | "script";
  id: string;
  title: string;
}

/** A human-readable view of one action: what is touched and how it is called. */
export function describeAction(a: Action): ActionItem {
  switch (a.op) {
    case "setScript": return { kind: "change", group: "script", id: "script", title: "Load script" };
    case "deleteFile": return { kind: "delete", group: "files", id: a.name, title: a.name };
    case "putFile": return { kind: a.exists ? "change" : "create", group: "files", id: a.name, title: a.name };
    case "delete": return { kind: "delete", group: a.group, id: a.id, title: a.id };
    case "upsert": {
      const props = isTree(a.payload) ? a.payload.qProperty : a.payload;
      const metaDef = props.qMetaDef as { title?: unknown } | undefined;
      const title = typeof metaDef?.title === "string" && metaDef.title !== "" ? metaDef.title
        : typeof props.qName === "string" && props.qName !== "" ? props.qName : a.id;
      return { kind: a.exists ? "change" : "create", group: a.group, id: a.id, title };
    }
  }
}
