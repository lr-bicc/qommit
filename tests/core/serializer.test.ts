import { serializeApp } from "../../src/core/serializer";
import { deserializeApp } from "../../src/core/deserializer";
import { makeSnapshot, APP_ID, CANON_ID } from "../fixtures/snapshot";

test("writes exactly the maintained files", () => {
  const files = serializeApp(makeSnapshot(), { canonicalAppId: CANON_ID });
  expect([...files.keys()].sort()).toEqual([
    "appcontent/logo.png",
    "data_load_script/Load   Data.qvs", "data_load_script/Main.qvs", "data_load_script/tab_order.txt",
    "objects/appprops.json", "objects/bookmarks/bm-1.json", "objects/dimensions/dim-1.json",
    "objects/masterobjects/mo-1.json", "objects/measures/mes-1.json", "objects/sheets/sh-1.json",
    "objects/variables/var-1.json",
  ]);
});
test("formats JSON like gitoqlok", () => {
  const files = serializeApp(makeSnapshot(), { canonicalAppId: CANON_ID });
  expect(files.get("objects/variables/var-1.json")).toBe(
    '{\n  "qInfo": {\n    "qId": "var-1",\n    "qType": "variable"\n  },\n  "qName": "vUser",\n  "qDefinition": "1"\n}');
});
test("normalizes the app id in content URLs both ways", () => {
  const files = serializeApp(makeSnapshot(), { canonicalAppId: CANON_ID });
  const sheet = files.get("objects/sheets/sh-1.json") as string;
  expect(sheet).toContain(`/appcontent/${CANON_ID}/logo.png`);
  expect(sheet).not.toContain(APP_ID);
  const other = "22222222-2222-4222-8222-222222222222";
  const back = deserializeApp(files, { targetAppId: other, knownAppIds: [CANON_ID] });
  expect(JSON.stringify(back.sheets)).toContain(`/appcontent/${other}/logo.png`);
});
test("round trip keeps everything except script-created variables", () => {
  const snap = makeSnapshot();
  const back = deserializeApp(serializeApp(snap, { canonicalAppId: CANON_ID }), { targetAppId: APP_ID, knownAppIds: [CANON_ID] });
  expect(back).toEqual({ ...snap, variables: [snap.variables[0]] });
});
test("serializing twice yields identical bytes", () => {
  const a = serializeApp(makeSnapshot(), { canonicalAppId: CANON_ID });
  const b = serializeApp(makeSnapshot(), { canonicalAppId: CANON_ID });
  expect([...a.entries()]).toEqual([...b.entries()]);
});
test("refuses object ids it cannot store", () => {
  const slash = makeSnapshot();
  slash.measures[0] = { ...slash.measures[0], qInfo: { qId: "a/b", qType: "measure" } };
  expect(() => serializeApp(slash, { canonicalAppId: CANON_ID }))
    .toThrow('Cannot store measure with id "a/b": ids must be non-empty and must not contain "/"');
  const empty = makeSnapshot();
  empty.sheets[0] = { ...empty.sheets[0], qProperty: { ...empty.sheets[0].qProperty, qInfo: { qId: "", qType: "sheet" } } };
  expect(() => serializeApp(empty, { canonicalAppId: CANON_ID }))
    .toThrow('Cannot store sheet with id "": ids must be non-empty and must not contain "/"');
  const skipped = makeSnapshot();
  skipped.variables[1] = { ...skipped.variables[1], qInfo: { qId: "x/y", qType: "variable" } };
  expect(() => serializeApp(skipped, { canonicalAppId: CANON_ID })).not.toThrow();
  expect(serializeApp(makeSnapshot(), { canonicalAppId: CANON_ID }).size).toBe(11);
});
test("checks the id of every object group", () => {
  const cases: [string, (s: ReturnType<typeof makeSnapshot>) => void][] = [
    ["variable", (s) => { s.variables[0] = { ...s.variables[0], qInfo: { qId: "v/1", qType: "variable" } }; }],
    ["dimension", (s) => { s.dimensions[0] = { ...s.dimensions[0], qInfo: { qId: "v/1", qType: "dimension" } }; }],
    ["master object", (s) => { s.masterObjects[0].qProperty.qInfo.qId = "v/1"; }],
    ["story", (s) => { s.stories.push({ qProperty: { qInfo: { qId: "v/1", qType: "story" } }, qChildren: [] }); }],
    ["bookmark", (s) => { s.bookmarks[0] = { ...s.bookmarks[0], qInfo: { qId: "v/1", qType: "bookmark" } }; }],
  ];
  for (const [group, mutate] of cases) {
    const s = makeSnapshot(); mutate(s);
    expect(() => serializeApp(s, { canonicalAppId: CANON_ID })).toThrow(`Cannot store ${group} with id "v/1"`);
  }
});
