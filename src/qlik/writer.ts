import type { Action } from "../core/update-planner";
import type { GenericProps, PropertyTree } from "../core/types";
import type { EngineApi } from "./engine-types";
import { ENGINE_TIMEOUT_MESSAGE, engineCall, withTimeout } from "./timeout";

export interface FileStore {
  put(name: string, bytes: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
}

export class ApplyError extends Error {
  constructor(message: string, public done: Action[], public failed: Action, public remaining: Action[]) {
    super(message);
    this.name = "ApplyError";
  }
}

const TREE_TIMEOUT_MS = 60_000;
const SAVE_TIMEOUT_MS = 150_000;
const COLOR_MAP_PREFIX = "ColorMapModel_";

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message
    : typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string" ? (e as { message: string }).message
      : String(e);
// The engine answers a missing object with code 2 (LOCERR_GENERIC_NOT_FOUND) / "object not found".
const isNotFound = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === 2 || /not found/i.test(messageOf(e));

const treeCall = <T>(promise: Promise<T>): Promise<T> => withTimeout(promise, TREE_TIMEOUT_MS, ENGINE_TIMEOUT_MESSAGE);

/** Destroys the ColorMap object of a dimension; an absent object (false answer or "not found") is fine. */
async function destroyColorMap(doc: EngineApi, dimensionId: string): Promise<void> {
  try {
    await engineCall(doc.destroyObject!(COLOR_MAP_PREFIX + dimensionId));
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
}

async function writeColorMap(doc: EngineApi, dimensionId: string, model: { colorMap?: unknown }): Promise<void> {
  const id = COLOR_MAP_PREFIX + dimensionId;
  const qInfo = { qId: id, qType: "ColorMap" };
  let handle: EngineApi;
  try {
    handle = await engineCall(doc.getObject!(id));
  } catch (e) {
    if (!isNotFound(e)) throw e;
    handle = await engineCall(doc.createObject!({ qInfo }));
  }
  await engineCall(handle.setProperties!({ qInfo, colorMap: model.colorMap }));
}

async function upsertDimension(doc: EngineApi, id: string, exists: boolean, payload: GenericProps): Promise<void> {
  const { _ColorMapModel: colors, ...props } = payload as GenericProps & { _ColorMapModel?: { colorMap?: unknown } };
  if (exists) await engineCall((await engineCall(doc.getDimension!(id))).setProperties!(props));
  else await engineCall(doc.createDimension!(props));
  if (colors && typeof colors === "object") await writeColorMap(doc, id, colors);
  else await destroyColorMap(doc, id);
}

async function upsert(doc: EngineApi, a: Extract<Action, { op: "upsert" }>): Promise<void> {
  const { group, id, exists } = a;
  switch (group) {
    case "variables":
      if (exists) await engineCall((await engineCall(doc.getVariableById!(id))).setProperties!(a.payload));
      else await engineCall(doc.createVariableEx!(a.payload));
      return;
    case "dimensions": return upsertDimension(doc, id, exists, a.payload as GenericProps);
    case "measures":
      if (exists) await engineCall((await engineCall(doc.getMeasure!(id))).setProperties!(a.payload));
      else await engineCall(doc.createMeasure!(a.payload));
      return;
    default: {
      const tree = a.payload as PropertyTree;
      const handle = exists
        ? await engineCall(doc.getObject!(id))
        : await engineCall(doc.createObject!({ qInfo: tree.qProperty.qInfo }));
      await treeCall(handle.setFullPropertyTree!(tree));
    }
  }
}

async function remove(doc: EngineApi, group: Extract<Action, { op: "delete" }>["group"], id: string): Promise<void> {
  switch (group) {
    case "variables": await engineCall(doc.destroyVariableById!(id)); return;
    case "dimensions":
      await engineCall(doc.destroyDimension!(id));
      await destroyColorMap(doc, id);
      return;
    case "measures": await engineCall(doc.destroyMeasure!(id)); return;
    default: await engineCall(doc.destroyObject!(id));
  }
}

async function apply(doc: EngineApi, a: Action, files: FileStore): Promise<void> {
  switch (a.op) {
    case "upsert": return upsert(doc, a);
    case "delete": return remove(doc, a.group, a.id);
    case "putFile": return files.put(a.name, a.bytes);
    case "deleteFile": return files.remove(a.name);
    case "setScript": await engineCall(doc.setScript!(a.script));
  }
}

/** Applies the actions one after the other, in the given order; the first failure stops with an ApplyError. */
export async function applyActions(
  doc: EngineApi,
  actions: Action[],
  opts: { files: FileStore; onProgress?(done: number, total: number): void },
): Promise<void> {
  opts.onProgress?.(0, actions.length);
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;
    try {
      await apply(doc, action, opts.files);
    } catch (e) {
      throw new ApplyError(messageOf(e), actions.slice(0, i), action, actions.slice(i + 1));
    }
    opts.onProgress?.(i + 1, actions.length);
  }
}

/** Saves the app (DoSave). */
export async function saveApp(doc: EngineApi): Promise<void> {
  await withTimeout(doc.doSave!(), SAVE_TIMEOUT_MS, ENGINE_TIMEOUT_MESSAGE);
}
