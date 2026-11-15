import { partOf, type ChangeKind, type ObjectGroup } from "../../src/core/diff";
import type { ChangeItem } from "../../src/ext/flows/local-changes";
import { initialSelection, PARTS, pathsToggledWith, pullRequestUrl, sections, togglePart } from "../../src/ext/panel/changes-model";

const item = (path: string, kind: ChangeKind, group: ObjectGroup, title: string): ChangeItem => ({ path, kind, group, part: partOf(group), title });

test("groups changes like gitoqlok", () => {
  const items = [
    item("objects/measures/m1.json", "changed", "measures", "Sales"),
    item("objects/dimensions/d1.json", "changed", "dimensions", "Region"),
    item("objects/sheets/s1.json", "changed", "sheets", "Overview"),
    item("data_load_script/Main.qvs", "added", "script", "Main"),
  ];
  expect(sections(items).map((s) => [s.label, s.groups.map((g) => [g.label, g.items.map((i) => i.title)])])).toEqual([
    ["Added objects", [["Script", ["Main"]]]],
    ["Changed objects", [["Sheets", ["Overview"]], ["Master Items", ["Region", "Sales"]]]],
  ]);
});

test("sections keep the fixed order of sections and groups and leave out empty ones", () => {
  const items = [
    item("a", "deleted", "appprops", "x"), item("b", "deleted", "bookmarks", "x"), item("c", "deleted", "stories", "x"),
    item("d", "deleted", "attachedFiles", "x"), item("e", "deleted", "script", "x"), item("f", "deleted", "variables", "x"),
    item("g", "deleted", "sheets", "x"), item("h", "added", "sheets", "x"),
  ];
  const result = sections(items);
  expect(result.map((s) => s.key)).toEqual(["added", "deleted"]);
  expect(result[1]!.groups.map((g) => g.label)).toEqual([
    "Sheets", "Variables", "Script", "Attached files", "Stories", "Bookmarks", "App properties",
  ]);
  expect(sections([])).toEqual([]);
});

test("items of a group are sorted by title", () => {
  const items = [item("p2", "added", "sheets", "b"), item("p1", "added", "sheets", "a"), item("p3", "added", "sheets", "C")];
  expect(sections(items)[0]!.groups[0]!.items.map((i) => i.title)).toEqual(["a", "b", "C"]);
});

test("the parts are listed in the fixed order", () => {
  expect(PARTS.map((p) => [p.part, p.label])).toEqual([
    ["script", "Load script"], ["objects", "App Objects"], ["bookmarks", "Bookmarks"], ["files", "Attached files"],
  ]);
});

test("parts select and deselect their paths", () => {
  const items = [item("data_load_script/Main.qvs", "changed", "script", "Main"), item("objects/sheets/s1.json", "changed", "sheets", "S")];
  const none = togglePart(initialSelection(items), items, "objects", false);
  expect([...none]).toEqual(["data_load_script/Main.qvs"]);
  expect(togglePart(none, items, "objects", true).size).toBe(2);
});

test("toggling a part leaves the given set untouched", () => {
  const items = [item("x", "changed", "bookmarks", "B")];
  const before = initialSelection(items);
  togglePart(before, items, "bookmarks", false);
  expect([...before]).toEqual(["x"]);
});

test("pull request url encodes branch segments", () => {
  expect(pullRequestUrl("lr-bicc/sales", "main", "feature/währung")).toBe("https://github.com/lr-bicc/sales/compare/main...feature/w%C3%A4hrung");
});

test("a script entry is toggled together with every script entry; other entries alone", () => {
  const items = [
    item("data_load_script/Main.qvs", "changed", "script", "Main"),
    item("data_load_script/New.qvs", "added", "script", "New"),
    item("data_load_script/tab_order.txt", "changed", "script", "tab_order.txt"),
    item("objects/sheets/s1.json", "changed", "sheets", "Overview"),
  ];
  const script = ["data_load_script/Main.qvs", "data_load_script/New.qvs", "data_load_script/tab_order.txt"];
  expect(pathsToggledWith(items, items[0]!)).toEqual(script);
  expect(pathsToggledWith(items, items[1]!)).toEqual(script);
  expect(pathsToggledWith(items, items[3]!)).toEqual(["objects/sheets/s1.json"]);
});
