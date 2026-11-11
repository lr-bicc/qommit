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
