import type { AppSnapshot, GenericProps, PropertyTree } from "../core/types";
import type { ContentFiles } from "./content-files";
import type { EngineApi, NxInfo } from "./engine-types";
import { engineCall as call } from "./timeout";

export class QlikReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "QlikReadError";
  }
}

const MAX_IN_FLIGHT = 8;
const COLOR_MAP_PREFIX = "ColorMapModel_";
const FLAG_KEYS = ["qIsScriptCreated", "qIsReserved"] as const;

interface VariableListItem { qName?: string; qInfo: NxInfo; qIsScriptCreated?: boolean; qIsReserved?: boolean }
interface ListItem { qInfo: NxInfo; qMeta?: { approved?: boolean } }

const messageOf = (e: unknown): string => {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
};

/** Runs an engine step; any failure becomes a QlikReadError naming what was being read. */
async function step<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof QlikReadError) throw e;
    throw new QlikReadError(`Could not read ${what}: ${messageOf(e)}`, { cause: e });
  }
}

/** Runs the tasks with at most `limit` at a time; after the first failure nothing new starts, and that failure is thrown. */
async function runPool(tasks: (() => Promise<void>)[], limit = MAX_IN_FLIGHT): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && next < tasks.length) {
      const task = tasks[next++]!;
      try {
        await task();
      } catch (e) {
        failure ??= { error: e };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  if (failure) throw failure.error;
}

/**
 * Creates a session object, reads its layout, and destroys it again, also when reading fails. The engine
 * assigns the id, so a second tab on the same app or a leftover of an interrupted read cannot collide.
 */
async function readSessionList<T>(doc: EngineApi, what: string, type: string, def: Record<string, unknown>, key: string): Promise<T> {
  return step(what, async () => {
    const list = (await call(doc.createSessionObject({ qInfo: { qType: type }, ...def }))) as EngineApi & { id?: unknown };
    const id = list.id;
    try {
      const layout = (await call(list.getLayout())) as Record<string, unknown> | undefined;
      // An answer without the list itself is a failure, not an empty list: it would hide flags, approvals or objects.
      if (!layout || typeof layout[key] !== "object" || layout[key] === null) throw new Error(`the answer has no ${key}`);
      return layout as T;
    } finally {
      try {
        if (typeof id === "string") await call(doc.destroySessionObject(id));
      } catch {
        /* a session object does not outlive its session; the read result does not depend on it */
      }
    }
  });
}

const hasOwnFlag = (v: GenericProps): boolean => FLAG_KEYS.some((k) => k in v);

/**
 * Reads a live app into the snapshot the serializer writes. Any failing call fails the whole read
 * with a QlikReadError; a partial snapshot is never returned. `onProgress(done, total)` counts the
 * objects read (static file downloads and the script are not counted).
 */
export async function readApp(
  doc: EngineApi,
  appId: string,
  opts: { published: boolean; files?: ContentFiles; onProgress?: (done: number, total: number) => void },
): Promise<AppSnapshot> {
  const infos = (await step("object list", () => call(doc.getAllInfos()))) as NxInfo[];
  const idsOf = (type: string) => infos.filter((i) => i.qType === type).map((i) => i.qId);

  // Phase 1: everything that decides what is read.
  let script = "";
  let fileNames: string[] = [];
  let variableList: VariableListItem[] = [];
  const approved: Record<"sheet" | "story" | "bookmark", Set<string> | undefined> = { sheet: undefined, story: undefined, bookmark: undefined };
  const approvedIds = (items: ListItem[] | undefined) => new Set((items ?? []).filter((i) => i.qMeta?.approved === true).map((i) => i.qInfo.qId));

  const phase1: (() => Promise<void>)[] = [
    async () => {
      const layout = await readSessionList<{ qVariableList?: { qItems?: VariableListItem[] } }>(doc, "variable list", "qommit-variable-list", {
        qVariableListDef: { qType: "variable", qShowReserved: true, qShowConfig: true, qData: {} },
      }, "qVariableList");
      variableList = layout.qVariableList?.qItems ?? [];
    },
    async () => {
      script = (await step("script", () => call(doc.getScript()))) as string;
    },
  ];
  if (opts.files) {
    const files = opts.files;
    phase1.push(async () => {
      fileNames = await files.list();
    });
  }
  if (opts.published) {
    for (const type of ["sheet", "story"] as const) {
      phase1.push(async () => {
        const layout = await readSessionList<{ qAppObjectList?: { qItems?: ListItem[] } }>(doc, `${type} list`, `qommit-${type}-list`, {
          qAppObjectListDef: { qType: type, qData: {} },
        }, "qAppObjectList");
        approved[type] = approvedIds(layout.qAppObjectList?.qItems);
      });
    }
    phase1.push(async () => {
      const layout = await readSessionList<{ qBookmarkList?: { qItems?: ListItem[] } }>(doc, "bookmark list", "qommit-bookmark-list", {
        qBookmarkListDef: { qType: "bookmark", qData: {} },
      }, "qBookmarkList");
      approved.bookmark = approvedIds(layout.qBookmarkList?.qItems);
    });
  }
  await runPool(phase1);

  const visible = (type: "sheet" | "story" | "bookmark") => idsOf(type).filter((id) => !approved[type] || approved[type]!.has(id));
  const listById = new Map(variableList.map((i) => [i.qInfo.qId, i]));
  const variableIds = [...new Set([...idsOf("variable"), ...variableList.map((i) => i.qInfo.qId)])];
  const colorMapIds = new Set(idsOf("ColorMap"));

  const ids = {
    appprops: idsOf("appprops"), masterobject: idsOf("masterobject"), sheet: visible("sheet"), story: visible("story"),
    dimension: idsOf("dimension"), measure: idsOf("measure"), bookmark: visible("bookmark"),
  };
  const dimensionColorMaps = ids.dimension.filter((id) => colorMapIds.has(COLOR_MAP_PREFIX + id));
  const total = variableIds.length + dimensionColorMaps.length + Object.values(ids).reduce((n, a) => n + a.length, 0);
  let done = 0;
  opts.onProgress?.(0, total);
  const counted = async <T>(what: string, read: () => Promise<T>): Promise<T> => {
    const result = await step(what, read);
    opts.onProgress?.(++done, total);
    return result;
  };

  // Phase 2: the objects; every result lands at its index, so the order is that of getAllInfos.
  const tasks: (() => Promise<void>)[] = [];
  const collect = <T>(type: string, list: string[], read: (id: string) => Promise<T>): T[] => {
    const out = new Array<T>(list.length);
    list.forEach((id, i) => tasks.push(async () => { out[i] = await counted(`${type} ${id}`, () => read(id)); }));
    return out;
  };
  const tree = (id: string) => async () => {
    const obj = (await call(doc.getObject(id))) as EngineApi;
    return (await call(obj.getFullPropertyTree())) as PropertyTree;
  };
  const props = (open: (id: string) => Promise<EngineApi>) => async (id: string) =>
    call(((await call(open(id))) as EngineApi).getProperties() as Promise<GenericProps>);

  const appProps = collect("appprops", ids.appprops, (id) => tree(id)());
  const masterObjects = collect("masterobject", ids.masterobject, (id) => tree(id)());
  const sheets = collect("sheet", ids.sheet, (id) => tree(id)());
  const stories = collect("story", ids.story, (id) => tree(id)());
  const dimensions = collect("dimension", ids.dimension, props((id) => doc.getDimension(id)));
  const measures = collect("measure", ids.measure, props((id) => doc.getMeasure(id)));
  const bookmarks = collect("bookmark", ids.bookmark, props((id) => doc.getBookmark(id)));
  const variables = collect("variable", variableIds, props((id) => doc.getVariableById(id)));
  const colorMaps = collect("ColorMap", dimensionColorMaps.map((id) => COLOR_MAP_PREFIX + id), props((id) => doc.getObject(id)));

  const staticFiles = new Map<string, Uint8Array>();
  const downloaded = new Array<Uint8Array>(fileNames.length);
  fileNames.forEach((name, i) => tasks.push(async () => { downloaded[i] = await opts.files!.download(name); }));

  await runPool(tasks);
  fileNames.forEach((name, i) => staticFiles.set(name, downloaded[i]!));

  // Assemble. Copies only where something is added; everything else stays as read.
  const colorOf = new Map(dimensionColorMaps.map((id, i) => [id, colorMaps[i]!]));
  const finalDimensions = dimensions.map((dim, i) => {
    const map = colorOf.get(ids.dimension[i]!);
    if (!map) return dim;
    const { _ColorMapModel: _previous, ...rest } = dim;
    return { ...rest, _ColorMapModel: { qInfo: { qId: map.qInfo.qId, qType: map.qInfo.qType }, colorMap: map.colorMap } } as GenericProps;
  });
  const finalVariables = variables.map((v, i) => {
    const flags = listById.get(variableIds[i]!);
    if (!flags || hasOwnFlag(v)) return v;
    const add = FLAG_KEYS.filter((k) => flags[k] === true);
    return add.length === 0 ? v : ({ ...v, ...Object.fromEntries(add.map((k) => [k, true])) } as GenericProps);
  });

  return {
    appId, script, appProps, variables: finalVariables, dimensions: finalDimensions, measures, masterObjects, sheets, stories, bookmarks, staticFiles,
  };
}
