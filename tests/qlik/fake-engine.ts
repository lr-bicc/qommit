import type { AppSnapshot, GenericProps, PropertyTree } from "../../src/core/types";
import type { EngineApi } from "../../src/qlik/engine-types";

export interface FakeObject { props: GenericProps; children?: PropertyTree[]; approved?: boolean }
export interface FakeApp {
  title: string; published: boolean; script: string;
  objects: FakeObject[]; // generic objects of any type: sheet, story, masterobject, appprops, ColorMap, qommit-link, _gitoqlikMetaData
  dimensions: GenericProps[]; measures: GenericProps[];
  bookmarks: { props: GenericProps; approved?: boolean }[];
  variables: { props: GenericProps; list?: { qIsScriptCreated?: boolean; qIsReserved?: boolean } }[];
  libraryFiles: string[]; // qUrl values of the app-specific content library
}
export interface FakeDoc extends EngineApi { }

const clone = <T>(v: T): T => structuredClone(v);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Engine test double. Every answer arrives after a `setTimeout(0)`; answers are deep copies (the real
 * engine serialises). `calls` holds `"<method> <id>"` entries, with `-` as id for document-level calls
 * without one. An unknown object rejects. `failOn(method, id)` makes that one call reject.
 */
export function fakeDoc(app: FakeApp): {
  doc: FakeDoc; calls: string[]; maxInFlight(): number; failOn(method: string, id: string): void;
  /** The definitions passed to createSessionObject, in call order. */
  sessionDefs: Record<string, unknown>[];
} {
  const calls: string[] = [];
  const sessionDefs: Record<string, unknown>[] = [];
  const failing = new Set<string>();
  const sessions = new Set<string>();
  let inFlight = 0;
  let peak = 0;

  async function call<T>(method: string, id: string | undefined, answer: () => T): Promise<T> {
    const key = `${method} ${id ?? "-"}`;
    calls.push(key);
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      await tick();
      if (failing.has(key)) throw { code: 15, message: `forced failure: ${key}` };
      return answer();
    } finally {
      inFlight--;
    }
  }
  const unknown = (what: string, id: string) => ({ code: 2, message: `${what} not found: ${id}` });
  const idOf = (p: GenericProps) => p.qInfo.qId;

  /** Properties holder of any object kind: generic objects, dimensions, measures, bookmarks, variables. */
  function find(id: string): { get(): GenericProps; set(p: GenericProps): void; children(): PropertyTree[] } | undefined {
    const o = app.objects.find((x) => idOf(x.props) === id);
    if (o) return { get: () => o.props, set: (p) => { o.props = p; }, children: () => o.children ?? [] };
    for (const list of [app.dimensions, app.measures]) {
      const i = list.findIndex((p) => idOf(p) === id);
      if (i >= 0) return { get: () => list[i]!, set: (p) => { list[i] = p; }, children: () => [] };
    }
    const b = app.bookmarks.find((x) => idOf(x.props) === id);
    if (b) return { get: () => b.props, set: (p) => { b.props = p; }, children: () => [] };
    const v = app.variables.find((x) => idOf(x.props) === id);
    if (v) return { get: () => v.props, set: (p) => { v.props = p; }, children: () => [] };
    return undefined;
  }

  function handle(id: string, h: { get(): GenericProps; set(p: GenericProps): void; children(): PropertyTree[] }): EngineApi {
    return {
      getProperties: () => call("getProperties", id, () => clone(h.get())),
      getFullPropertyTree: () => call("getFullPropertyTree", id, () => clone({ qProperty: h.get(), qChildren: h.children() })),
      setProperties: (p: GenericProps) => call("setProperties", id, () => { h.set(clone(p)); }),
    };
  }
  const opener = (method: string, what: string, exists: (id: string) => boolean) => (id: string) =>
    call(method, id, () => {
      const h = find(id);
      if (!h || !exists(id)) throw unknown(what, id);
      return handle(id, h);
    });

  function allInfos() {
    const infos: { qId: string; qType: string }[] = [];
    const walk = (trees: PropertyTree[]) => {
      for (const t of trees) {
        infos.push({ ...t.qProperty.qInfo });
        walk(t.qChildren);
      }
    };
    for (const o of app.objects) {
      infos.push({ ...o.props.qInfo });
      walk(o.children ?? []);
    }
    for (const p of [...app.dimensions, ...app.measures, ...app.bookmarks.map((b) => b.props)]) infos.push({ ...p.qInfo });
    for (const v of app.variables) if (v.list?.qIsReserved !== true) infos.push({ ...v.props.qInfo });
    return infos;
  }

  function layoutOf(def: Record<string, unknown>): unknown {
    if (def.qVariableListDef) {
      // Like the engine: only qType "variable" lists variables, reserved ones only with qShowReserved.
      const d = def.qVariableListDef as { qType?: string; qShowReserved?: boolean };
      const items = d.qType !== "variable" ? [] : app.variables
        .filter((v) => d.qShowReserved === true || v.list?.qIsReserved !== true)
        .map((v) => ({ qName: v.props.qName, qInfo: clone(v.props.qInfo), ...v.list }));
      return { qVariableList: { qItems: items } };
    }
    if (def.qAppObjectListDef) {
      const type = (def.qAppObjectListDef as { qType: string }).qType;
      return {
        qAppObjectList: {
          qItems: app.objects.filter((o) => o.props.qInfo.qType === type)
            .map((o) => ({ qInfo: clone(o.props.qInfo), qMeta: { approved: o.approved !== false } })),
        },
      };
    }
    if (def.qBookmarkListDef) {
      return {
        qBookmarkList: {
          qItems: app.bookmarks.map((b) => ({ qInfo: clone(b.props.qInfo), qMeta: { approved: b.approved !== false } })),
        },
      };
    }
    throw { code: 1, message: "unsupported session object definition" };
  }

  const doc: FakeDoc = {
    getAllInfos: () => call("getAllInfos", undefined, () => allInfos()),
    getObject: opener("getObject", "object", () => true),
    getDimension: opener("getDimension", "dimension", (id) => app.dimensions.some((p) => idOf(p) === id)),
    getMeasure: opener("getMeasure", "measure", (id) => app.measures.some((p) => idOf(p) === id)),
    getBookmark: opener("getBookmark", "bookmark", (id) => app.bookmarks.some((b) => idOf(b.props) === id)),
    getVariableById: opener("getVariableById", "variable", (id) => app.variables.some((v) => idOf(v.props) === id)),
    createSessionObject: (props: Record<string, unknown> & { qInfo: { qId: string } }) => {
      const id = props.qInfo.qId;
      return call("createSessionObject", id, () => {
        sessions.add(id);
        const def = clone(props);
        sessionDefs.push(def);
        return {
          getLayout: () => call("getLayout", id, () => {
            if (!sessions.has(id)) throw unknown("session object", id);
            return layoutOf(def);
          }),
        } as EngineApi;
      });
    },
    destroySessionObject: (id: string) => call("destroySessionObject", id, () => sessions.delete(id)),
    getScript: () => call("getScript", undefined, () => app.script),
    getAppLayout: () => call("getAppLayout", undefined, () => ({ qTitle: app.title, published: app.published })),
    getContentLibraries: () => call("getContentLibraries", undefined, () => ({
      // like the real engine: the app-specific library exists only once the app has content files
      qItems: [{ qName: "StaticContent", qAppSpecific: false }, ...(app.libraryFiles.length > 0 ? [{ qName: "__appcontent", qAppSpecific: true }] : [])],
    })),
    getLibraryContent: (name: string) => call("getLibraryContent", name, () => {
      if (name !== "__appcontent") return { qItems: [] };
      return { qItems: app.libraryFiles.map((qUrl) => ({ qUrl })) };
    }),
    createObject: (props: GenericProps) => call("createObject", idOf(props), () => {
      app.objects.push({ props: clone(props) });
      return handle(idOf(props), find(idOf(props))!);
    }),
    destroyObject: (id: string) => call("destroyObject", id, () => {
      const i = app.objects.findIndex((o) => idOf(o.props) === id);
      if (i < 0) throw unknown("object", id);
      app.objects.splice(i, 1);
      return true;
    }),
  };

  return { doc, calls, sessionDefs, maxInFlight: () => peak, failOn: (method, id) => { failing.add(`${method} ${id}`); } };
}

const encodePath = (name: string) => name.split("/").map(encodeURIComponent).join("/");

export function appFromSnapshot(snap: AppSnapshot, extra: Partial<FakeApp> = {}): FakeApp {
  const generic = (t: PropertyTree): FakeObject => ({ props: clone(t.qProperty), children: clone(t.qChildren) });
  return {
    title: "Test app",
    published: false,
    script: snap.script,
    objects: [...snap.appProps, ...snap.masterObjects, ...snap.sheets, ...snap.stories].map(generic),
    dimensions: clone(snap.dimensions),
    measures: clone(snap.measures),
    bookmarks: snap.bookmarks.map((props) => ({ props: clone(props) })),
    variables: snap.variables.map((props) => ({ props: clone(props) })), // script-created flags stay in the properties
    libraryFiles: [...snap.staticFiles.keys()].map((n) => `/appcontent/${snap.appId}/${encodePath(n)}`),
    ...extra,
  };
}
