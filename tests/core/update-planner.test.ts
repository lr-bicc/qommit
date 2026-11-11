import { planUpdate, summarize } from "../../src/core/update-planner";
import { makeSnapshot } from "../fixtures/snapshot";
const ALL = new Set(["script", "objects", "bookmarks", "files"] as const);

test("identical snapshots need no actions", () => {
  expect(planUpdate(makeSnapshot(), makeSnapshot(), ALL)).toEqual([]);
});
test("orders upserts by dependency, then deletes in reverse", () => {
  const cur = makeSnapshot(); const tgt = makeSnapshot();
  tgt.measures[0] = { ...tgt.measures[0], qMeasure: { qDef: "Sum(Qty)" } };
  tgt.dimensions.push({ qInfo: { qId: "dim-2", qType: "dimension" }, qDim: {} });
  tgt.sheets = []; tgt.masterObjects = [];
  tgt.script = cur.script + "// x";
  tgt.staticFiles.set("new.png", new Uint8Array([1]));
  tgt.staticFiles.delete("logo.png");
  const ops = planUpdate(cur, tgt, ALL).map(a =>
    a.op === "upsert" || a.op === "delete" ? `${a.op}:${a.group}:${a.id}` : a.op === "setScript" ? a.op : `${a.op}:${a.name}`);
  expect(ops).toEqual([
    "upsert:dimensions:dim-2", "upsert:measures:mes-1", "putFile:new.png", "setScript",
    "delete:sheets:sh-1", "delete:masterobjects:mo-1", "deleteFile:logo.png"]);
  expect(summarize(planUpdate(cur, tgt, ALL))).toEqual({ create: 2, change: 2, delete: 3 });
});
test("never touches script-created variables", () => {
  const cur = makeSnapshot(); const tgt = makeSnapshot();
  tgt.variables = tgt.variables.filter(v => !v.qIsScriptCreated);
  expect(planUpdate(cur, tgt, ALL)).toEqual([]);
});
test("never creates or changes script-created or reserved variables from the target", () => {
  const cur = makeSnapshot(); const tgt = makeSnapshot();
  tgt.variables.push({ qInfo: { qId: "var-3", qType: "variable" }, qName: "vNew", qDefinition: "1", qIsScriptCreated: true });
  tgt.variables.push({ qInfo: { qId: "var-4", qType: "variable" }, qName: "vRes", qDefinition: "1", qIsReserved: true });
  tgt.variables[1] = { ...tgt.variables[1], qDefinition: "changed" };
  expect(planUpdate(cur, tgt, ALL)).toEqual([]);
});
test("never deletes reserved variables of the app", () => {
  const cur = makeSnapshot(); const tgt = makeSnapshot();
  cur.variables.push({ qInfo: { qId: "var-5", qType: "variable" }, qName: "vRes", qDefinition: "1", qIsReserved: true });
  expect(planUpdate(cur, tgt, ALL)).toEqual([]);
});
test("never writes bookmarks", () => {
  const tgt = makeSnapshot(); tgt.bookmarks = [];
  expect(planUpdate(makeSnapshot(), tgt, ALL)).toEqual([]);
});
test("respects the selected parts", () => {
  const tgt = makeSnapshot(); tgt.script = "///$tab Main\r\n"; tgt.sheets = [];
  expect(planUpdate(makeSnapshot(), tgt, new Set(["script"] as const)).map(a => a.op)).toEqual(["setScript"]);
  expect(planUpdate(makeSnapshot(), tgt, new Set(["objects"] as const)).map(a => a.op)).toEqual(["delete"]);
});
test("frees a variable name before reusing it under a new id", () => {
  const tgt = makeSnapshot();
  tgt.variables[0] = { ...tgt.variables[0], qInfo: { qId: "var-9", qType: "variable" } };
  expect(planUpdate(makeSnapshot(), tgt, ALL).map(a => `${a.op}:${"id" in a ? a.id : ""}`))
    .toEqual(["delete:var-1", "upsert:var-9"]);
});
test("never deletes appprops and reports exists flags", () => {
  const cur = makeSnapshot(); const tgt = makeSnapshot();
  tgt.appProps = [];
  expect(planUpdate(cur, tgt, ALL)).toEqual([]);
  tgt.appProps = [{ qProperty: { ...cur.appProps[0].qProperty, theme: "u" }, qChildren: [] }];
  tgt.staticFiles.set("logo.png", new Uint8Array([1]));
  const acts = planUpdate(cur, tgt, ALL);
  expect(acts.map(a => a.op === "upsert" ? `${a.group}:${a.exists}` : a.op === "putFile" ? `${a.name}:${a.exists}` : a.op))
    .toEqual(["appprops:true", "logo.png:true"]);
  expect(summarize(acts)).toEqual({ create: 0, change: 2, delete: 0 });
});
test("nothing outside the selected parts is planned", () => {
  const tgt = makeSnapshot(); tgt.sheets = []; tgt.script = "x"; tgt.staticFiles.clear();
  expect(planUpdate(makeSnapshot(), tgt, new Set(["bookmarks"] as const))).toEqual([]);
  expect(planUpdate(makeSnapshot(), tgt, new Set(["files"] as const)).map(a => a.op)).toEqual(["deleteFile"]);
});
