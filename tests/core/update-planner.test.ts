import { planUpdate, summarize, describeAction } from "../../src/core/update-planner";
import type { Action } from "../../src/core/update-planner";
import type { AppSnapshot, GenericProps, PropertyTree } from "../../src/core/types";
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

const snap = (over: Partial<AppSnapshot>): AppSnapshot => ({ ...makeSnapshot(), variables: [], dimensions: [], measures: [], masterObjects: [], sheets: [],
  appProps: [], script: "", staticFiles: new Map(), ...over });
const v = (id: string, qName: string): GenericProps => ({ qInfo: { qId: id, qType: "variable" }, qName, qDefinition: "1" });
const tree = (id: string, props: Record<string, unknown>): PropertyTree => ({ qProperty: { qInfo: { qId: id, qType: "sheet" }, ...props }, qChildren: [] });
const isUpsert = (a: Action): a is Extract<Action, { op: "upsert" }> => a.op === "upsert";

test("two variables that swap their names go through a temporary name", () => {
  const cur = snap({ variables: [v("a", "vX"), v("b", "vY")] });
  const tgt = snap({ variables: [v("a", "vY"), v("b", "vX")] });
  const actions = planUpdate(cur, tgt, new Set(["objects"]));
  const names = actions.filter(isUpsert).map((a) => `${a.id}:${(a.payload as GenericProps).qName}${a.temporary ? "*" : ""}`);
  expect(names).toEqual(["a:vX__qommit_a*", "b:vX", "a:vY"]);
  expect(summarize(actions)).toEqual({ create: 0, change: 2, delete: 0 });
});
test("a plain rename needs no temporary name", () => {
  const actions = planUpdate(snap({ variables: [v("a", "vX")] }), snap({ variables: [v("a", "vZ")] }), new Set(["objects"]));
  expect(actions.filter(isUpsert).some((a) => a.temporary)).toBe(false);
});
test("describeAction names objects by their title", () => {
  expect(describeAction({ op: "upsert", group: "sheets", id: "s1", exists: false, payload: tree("s1", { qMetaDef: { title: "Overview" } }) }))
    .toEqual({ kind: "create", group: "sheets", id: "s1", title: "Overview" });
  expect(describeAction({ op: "upsert", group: "variables", id: "a", exists: true, payload: v("a", "vX") }))
    .toEqual({ kind: "change", group: "variables", id: "a", title: "vX" });
  expect(describeAction({ op: "delete", group: "measures", id: "m1" })).toEqual({ kind: "delete", group: "measures", id: "m1", title: "m1" });
  expect(describeAction({ op: "setScript", script: "" })).toEqual({ kind: "change", group: "script", id: "script", title: "Load script" });
  expect(describeAction({ op: "deleteFile", name: "logo.png" })).toEqual({ kind: "delete", group: "files", id: "logo.png", title: "logo.png" });
});
test("a chain of renames runs the last link first, without a temporary name", () => {
  const cur = snap({ variables: [v("a", "vX"), v("b", "vY")] });
  const tgt = snap({ variables: [v("a", "vY"), v("b", "vZ")] });
  const ups = planUpdate(cur, tgt, new Set(["objects"])).filter(isUpsert);
  expect(ups.map((a) => `${a.id}:${(a.payload as GenericProps).qName}${a.temporary ? "*" : ""}`)).toEqual(["b:vZ", "a:vY"]);
});
