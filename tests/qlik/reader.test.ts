import { serializeApp } from "../../src/core/serializer";
import { QlikReadError, readApp } from "../../src/qlik/reader";
import { QlikTimeoutError } from "../../src/qlik/timeout";
import { APP_ID, CANON_ID, makeSnapshot } from "../fixtures/snapshot";
import { appFromSnapshot, fakeDoc } from "./fake-engine";
import type { FakeApp } from "./fake-engine";

const read = (app: FakeApp, published = false) => readApp(fakeDoc(app).doc, APP_ID, { published });

test("reads back what the serializer needs", async () => {
  const expected = { ...makeSnapshot(), staticFiles: new Map() };
  const snap = await read(appFromSnapshot(makeSnapshot()));
  expect(serializeApp(snap, { canonicalAppId: CANON_ID })).toEqual(serializeApp(expected, { canonicalAppId: CANON_ID }));
});
test("flags from the variable list exclude script-created and reserved variables", async () => {
  const app = appFromSnapshot(makeSnapshot());
  app.variables = [
    { props: { qInfo: { qId: "v1", qType: "variable" }, qName: "vKeep" } },
    { props: { qInfo: { qId: "v2", qType: "variable" }, qName: "vScript" }, list: { qIsScriptCreated: true } },
    { props: { qInfo: { qId: "v3", qType: "variable" }, qName: "vReserved" }, list: { qIsReserved: true } },
  ];
  const files = serializeApp(await read(app), { canonicalAppId: CANON_ID });
  expect([...files.keys()].filter((p) => p.startsWith("objects/variables/"))).toEqual(["objects/variables/v1.json"]);
});
test("value colours are embedded as the last key of the dimension", async () => {
  const app = appFromSnapshot(makeSnapshot());
  app.dimensions = [{ qInfo: { qId: "d1", qType: "dimension" }, qDim: { title: "Class" }, qMetaDef: { title: "Class" } }];
  app.objects.push({ props: { qInfo: { qId: "ColorMapModel_d1", qType: "ColorMap" }, qMetaDef: {}, colorMap: { colors: [{ value: "A" }] } } });
  const dim = JSON.parse(serializeApp(await read(app), { canonicalAppId: CANON_ID }).get("objects/dimensions/d1.json") as string);
  expect(Object.keys(dim)).toEqual(["qInfo", "qDim", "qMetaDef", "_ColorMapModel"]);
  expect(dim._ColorMapModel).toEqual({ qInfo: { qId: "ColorMapModel_d1", qType: "ColorMap" }, colorMap: { colors: [{ value: "A" }] } });
});
test("a published app yields only approved sheets", async () => {
  const app = appFromSnapshot(makeSnapshot(), { published: true });
  app.objects.push({ props: { qInfo: { qId: "private", qType: "sheet" } }, children: [], approved: false });
  expect((await read(app, true)).sheets.map((s) => s.qProperty.qInfo.qId)).not.toContain("private");
  expect((await read(app, false)).sheets.map((s) => s.qProperty.qInfo.qId)).toContain("private");
});
test("one failed object fails the whole read", async () => {
  const fake = fakeDoc(appFromSnapshot(makeSnapshot()));
  const id = makeSnapshot().sheets[0]!.qProperty.qInfo.qId;
  fake.failOn("getFullPropertyTree", id);
  await expect(readApp(fake.doc, APP_ID, { published: false })).rejects.toThrow(new RegExp(`sheet ${id}`));
});
test("reads in parallel, at most 8 calls at a time, and cleans up", async () => {
  const app = appFromSnapshot(makeSnapshot());
  for (let i = 0; i < 40; i++) app.measures.push({ qInfo: { qId: `m${i}`, qType: "measure" } });
  const fake = fakeDoc(app);
  await readApp(fake.doc, APP_ID, { published: false });
  expect(fake.maxInFlight()).toBeGreaterThan(1);
  expect(fake.maxInFlight()).toBeLessThanOrEqual(8);
  expect(fake.calls.filter((c) => c.startsWith("createSessionObject")).length)
    .toBe(fake.calls.filter((c) => c.startsWith("destroySessionObject")).length);
  expect(fake.calls.some((c) => c.startsWith("doSave"))).toBe(false);
});

describe("variables", () => {
  const v = (qId: string, extra: object = {}) => ({ qInfo: { qId, qType: "variable" }, qName: qId, ...extra });
  const ids = (s: { variables: { qInfo: { qId: string } }[] }) => s.variables.map((x) => x.qInfo.qId);

  test("every variable is in the snapshot; the list flag goes onto a copy, own flags and unflagged ones stay as read", async () => {
    const app = appFromSnapshot(makeSnapshot());
    app.variables = [
      { props: v("plain", { qDefinition: "1" }) },
      { props: v("own", { qIsScriptCreated: true, qDefinition: "2" }), list: { qIsScriptCreated: true } },
      { props: v("listOnly", { qDefinition: "3" }), list: { qIsScriptCreated: true } },
      { props: v("reserved", { qDefinition: "4" }), list: { qIsReserved: true } },
    ];
    const snap = await read(app);
    const by = Object.fromEntries(snap.variables.map((x) => [x.qInfo.qId, x]));
    expect(ids(snap)).toEqual(["plain", "own", "listOnly", "reserved"]);
    expect(JSON.stringify(by.plain)).toBe(JSON.stringify(v("plain", { qDefinition: "1" })));
    expect(JSON.stringify(by.own)).toBe(JSON.stringify(v("own", { qIsScriptCreated: true, qDefinition: "2" })));
    expect(by.listOnly).toEqual(v("listOnly", { qDefinition: "3", qIsScriptCreated: true }));
    expect(by.reserved).toEqual(v("reserved", { qDefinition: "4", qIsReserved: true }));
    // the engine's own data is not mutated by the flag
    expect(app.variables[2]!.props).toEqual(v("listOnly", { qDefinition: "3" }));
  });
  test("order: getAllInfos order first, then list-only ids", async () => {
    const app = appFromSnapshot(makeSnapshot());
    app.variables = [
      { props: v("r1"), list: { qIsReserved: true } },
      { props: v("a") },
      { props: v("r2"), list: { qIsReserved: true } },
      { props: v("b") },
    ];
    expect(ids(await read(app))).toEqual(["a", "b", "r1", "r2"]);
  });
});

describe("reading rules", () => {
  test("a dimension without a colour map is unchanged, the ColorMap itself is no snapshot entry", async () => {
    const app = appFromSnapshot(makeSnapshot());
    app.objects.push({ props: { qInfo: { qId: "ColorMapModel_other", qType: "ColorMap" }, colorMap: {} } });
    const snap = await read(app);
    expect(snap.dimensions).toEqual(makeSnapshot().dimensions);
    expect(JSON.stringify(snap.dimensions)).toBe(JSON.stringify(makeSnapshot().dimensions));
    expect(JSON.stringify(snap)).not.toContain("ColorMapModel_other");
  });
  test("types the tool does not version and child objects are not read", async () => {
    const app = appFromSnapshot(makeSnapshot());
    app.objects.push(
      { props: { qInfo: { qId: "link", qType: "qommit-link" } } },
      { props: { qInfo: { qId: "meta", qType: "_gitoqlikMetaData" } } },
    );
    const fake = fakeDoc(app);
    await readApp(fake.doc, APP_ID, { published: false });
    for (const id of ["link", "meta", "obj-1"]) expect(fake.calls.some((c) => c.endsWith(` ${id}`))).toBe(false);
  });
  test("order follows getAllInfos", async () => {
    const app = appFromSnapshot(makeSnapshot());
    app.objects.unshift({ props: { qInfo: { qId: "sh-0", qType: "sheet" } }, children: [] });
    expect((await read(app)).sheets.map((s) => s.qProperty.qInfo.qId)).toEqual(["sh-0", "sh-1"]);
  });
  test("a published app yields only approved bookmarks and stories; other kinds are read in full", async () => {
    const app = appFromSnapshot(makeSnapshot(), { published: true });
    app.bookmarks.push({ props: { qInfo: { qId: "bm-priv", qType: "bookmark" } }, approved: false });
    app.objects.push({ props: { qInfo: { qId: "st-priv", qType: "story" } }, children: [], approved: false });
    app.objects.push({ props: { qInfo: { qId: "st-pub", qType: "story" } }, children: [] });
    const snap = await read(app, true);
    expect(snap.bookmarks.map((b) => b.qInfo.qId)).toEqual(["bm-1"]);
    expect(snap.stories.map((s) => s.qProperty.qInfo.qId)).toEqual(["st-pub"]);
    expect(snap.masterObjects).toHaveLength(1);
  });
  test("session objects get no fixed id and are destroyed by the id the engine assigned", async () => {
    const fake = fakeDoc(appFromSnapshot(makeSnapshot(), { published: true }));
    await readApp(fake.doc, APP_ID, { published: true });
    expect(fake.sessionDefs).toHaveLength(4);
    for (const def of fake.sessionDefs) {
      expect((def.qInfo as { qId?: string }).qId).toBeUndefined();
      expect((def.qInfo as { qType: string }).qType).toMatch(/^qommit-/);
    }
    const destroyed = fake.calls.filter((c) => c.startsWith("destroySessionObject")).map((c) => c.split(" ")[1]).sort();
    const assigned = fake.calls.filter((c) => c.startsWith("getLayout")).map((c) => c.split(" ")[1]).sort();
    expect(destroyed).toEqual(assigned);
    expect(destroyed.every((id) => /#\d+$/.test(id!))).toBe(true);
  });
  test("two reads of the same app at once do not collide", async () => {
    const fake = fakeDoc(appFromSnapshot(makeSnapshot(), { published: true }));
    const [a, b] = await Promise.all([readApp(fake.doc, APP_ID, { published: true }), readApp(fake.doc, APP_ID, { published: true })]);
    expect(a.sheets).toEqual(b.sheets);
  });
  test("session objects are destroyed after a failed read too", async () => {
    const fake = fakeDoc(appFromSnapshot(makeSnapshot()));
    fake.failOn("getLayout", "qommit-variable-list");
    await expect(readApp(fake.doc, APP_ID, { published: false })).rejects.toThrow(/variable list/);
    expect(fake.calls.filter((c) => c.startsWith("destroySessionObject")).length).toBe(1);
  });
});

describe("failures", () => {
  test("a failing call is a QlikReadError naming type and id", async () => {
    const fake = fakeDoc(appFromSnapshot(makeSnapshot()));
    fake.failOn("getProperties", "mes-1");
    const err = await readApp(fake.doc, APP_ID, { published: false }).catch((e) => e);
    expect(err).toBeInstanceOf(QlikReadError);
    expect(err.message).toMatch(/^Could not read measure mes-1: .*forced failure/);
  });
  test("an unknown object in getAllInfos fails, no partial snapshot", async () => {
    const fake = fakeDoc(appFromSnapshot(makeSnapshot()));
    fake.failOn("getVariableById", "var-1");
    await expect(readApp(fake.doc, APP_ID, { published: false })).rejects.toThrow(/variable var-1/);
  });
  test("a dying session (every pending call rejects) is a QlikReadError", async () => {
    const { doc } = fakeDoc(appFromSnapshot(makeSnapshot()));
    const dying = new Proxy(doc, {
      get: (t, k: string) => k === "getAllInfos" ? t[k] : () => Promise.reject(new Error("Session closed")),
    });
    const err = await readApp(dying, APP_ID, { published: false }).catch((e) => e);
    expect(err).toBeInstanceOf(QlikReadError);
  });
  test("getAllInfos and getScript failures are QlikReadErrors", async () => {
    for (const m of ["getAllInfos", "getScript"]) {
      const { doc } = fakeDoc(appFromSnapshot(makeSnapshot()));
      const broken = { ...doc, [m]: () => Promise.reject({ code: -1, message: "gone" }) };
      const err = await readApp(broken, APP_ID, { published: false }).catch((e) => e);
      expect(err).toBeInstanceOf(QlikReadError);
      expect(err.message).toContain("gone");
    }
  });
});

describe("timeouts", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  test.each([
    ["getProperties", "mes-1", /^Could not read measure mes-1: Qlik did not answer in time\.$/],
    ["getAllInfos", "-", /^Could not read object list: Qlik did not answer in time\.$/],
    ["getLayout", "qommit-variable-list", /^Could not read variable list: Qlik did not answer in time\.$/],
  ])("an engine call (%s %s) that never answers fails the read after 30 seconds", async (method, id, message) => {
    const fake = fakeDoc(appFromSnapshot(makeSnapshot()));
    fake.hangOn(method, id);
    const outcome = readApp(fake.doc, APP_ID, { published: false }).catch((e) => e);
    let settled = false;
    void outcome.then(() => { settled = true; });
    // The fake engine answers each call after a zero-delay timer, so the hanging call starts a few milliseconds in.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    const err = await outcome;
    expect(err).toBeInstanceOf(QlikReadError);
    expect(err.message).toMatch(message);
    expect(err.cause).toBeInstanceOf(QlikTimeoutError);
  });
});

describe("onProgress", () => {
  test("counts up to the number of objects, the last call has done === total", async () => {
    const calls: [number, number][] = [];
    const snap = makeSnapshot();
    await readApp(fakeDoc(appFromSnapshot(snap)).doc, APP_ID, { published: false, onProgress: (d, t) => calls.push([d, t]) });
    const total = snap.appProps.length + snap.masterObjects.length + snap.sheets.length + snap.stories.length
      + snap.dimensions.length + snap.measures.length + snap.bookmarks.length + snap.variables.length;
    expect(calls.at(-1)).toEqual([total, total]);
    expect(new Set(calls.map((c) => c[1]))).toEqual(new Set([total]));
    expect(calls.map((c) => c[0])).toEqual([...calls.map((c) => c[0])].sort((a, b) => a - b));
  });
});

describe("list answers", () => {
  const withLayout = (layout: unknown) => {
    const { doc } = fakeDoc(appFromSnapshot(makeSnapshot(), { published: true }));
    return {
      ...doc,
      createSessionObject: async (props: { qInfo: { qType: string } }) => {
        const inner = (await doc.createSessionObject!(props)) as { getLayout(): Promise<unknown> };
        return { getLayout: () => inner.getLayout().then((real) => (layout === "real" ? real : layout)) };
      },
    };
  };
  test.each([["variable list"], ["sheet list"], ["bookmark list"]])("a layout without the list fails the read (%s)", async (name) => {
    const doc = withLayout({});
    const broken = { ...doc, createSessionObject: (p: { qInfo: { qType: string } }) =>
      p.qInfo.qType === `qommit-${name.replace(" ", "-")}` ? doc.createSessionObject(p) : fakeDoc(appFromSnapshot(makeSnapshot(), { published: true })).doc.createSessionObject!(p) };
    const err = await readApp(broken, APP_ID, { published: true }).catch((e) => e);
    expect(err).toBeInstanceOf(QlikReadError);
    expect(err.message).toMatch(new RegExp(`Could not read ${name}: the answer has no q(Variable|AppObject|Bookmark)List`));
  });
  test("an existing list without qItems is an empty list", async () => {
    const snap = await readApp(withLayout({ qVariableList: {}, qAppObjectList: {}, qBookmarkList: {} }) as never, APP_ID, { published: true });
    expect(snap.sheets).toEqual([]);
    expect(snap.bookmarks).toEqual([]);
  });
});

describe("the variable list definition", () => {
  test("readApp asks for reserved and config variables of type variable", async () => {
    const fake = fakeDoc(appFromSnapshot(makeSnapshot()));
    await readApp(fake.doc, APP_ID, { published: false });
    expect(fake.sessionDefs.map((d) => d.qVariableListDef)).toContainEqual({ qType: "variable", qShowReserved: true, qShowConfig: true, qData: {} });
  });
  test("the fake omits reserved variables unless qShowReserved is set, and lists only qType variable", async () => {
    const app = appFromSnapshot(makeSnapshot());
    app.variables = [
      { props: { qInfo: { qId: "a", qType: "variable" }, qName: "a" } },
      { props: { qInfo: { qId: "r", qType: "variable" }, qName: "r" }, list: { qIsReserved: true } },
    ];
    const { doc } = fakeDoc(app);
    const items = async (def: object) => {
      const list = await doc.createSessionObject({ qInfo: { qType: "x" }, qVariableListDef: def });
      return (await list.getLayout()).qVariableList.qItems.map((i: { qInfo: { qId: string } }) => i.qInfo.qId);
    };
    expect(await items({ qType: "variable", qShowReserved: true, qData: {} })).toEqual(["a", "r"]);
    expect(await items({ qType: "variable", qData: {} })).toEqual(["a"]);
    expect(await items({ qShowReserved: true, qData: {} })).toEqual([]);
  });
  test("without qShowReserved a reserved variable would be missing (the reader relies on the flag)", async () => {
    const app = appFromSnapshot(makeSnapshot());
    app.variables = [{ props: { qInfo: { qId: "r", qType: "variable" }, qName: "r" }, list: { qIsReserved: true } }];
    const snap = await read(app);
    expect(snap.variables[0]).toMatchObject({ qIsReserved: true });
  });
});
