import { diffTrees, groupOf, partOf, titleOf, lineDiff } from "../../src/core/diff";

test("classifies paths", () => {
  expect(groupOf("data_load_script/Main.qvs")).toBe("script");
  expect(groupOf("data_load_script/tab_order.txt")).toBe("script");
  expect(groupOf("objects/appprops.json")).toBe("appprops");
  expect(groupOf("objects/sheets/sh-1.json")).toBe("sheets");
  expect(groupOf("appcontent/logo.png")).toBe("attachedFiles");
  expect(partOf("variables")).toBe("objects");
  expect(partOf("appprops")).toBe("objects");
  expect(partOf("stories")).toBe("objects");
  expect(partOf("script")).toBe("script");
  expect(partOf("bookmarks")).toBe("bookmarks");
  expect(partOf("attachedFiles")).toBe("files");
});
test("groupOf returns null for unmaintained or malformed paths", () => {
  expect(groupOf("objects/fields.json")).toBeNull();
  expect(groupOf("objects/foo/x.json")).toBeNull();
  expect(groupOf("objects/sheets/x.txt")).toBeNull();
  expect(groupOf("objects/sheets/sub/x.json")).toBeNull();
  expect(groupOf("data_load_script/notes.md")).toBeNull();
  expect(groupOf("README.md")).toBeNull();
});
test("reports added, changed and deleted objects", () => {
  const base = new Map([["objects/sheets/a.json", "1"], ["objects/sheets/b.json", "2"], ["objects/measures/m.json", "3"]]);
  const local = new Map([["objects/sheets/a.json", "1"], ["objects/sheets/b.json", "9"], ["objects/variables/v.json", "4"]]);
  expect(diffTrees(base, local)).toEqual([
    { path: "objects/measures/m.json", kind: "deleted", group: "measures" },
    { path: "objects/sheets/b.json", kind: "changed", group: "sheets" },
    { path: "objects/variables/v.json", kind: "added", group: "variables" },
  ]);
});
test("ignores files the extension does not maintain", () => {
  const base = new Map([["README.md", "1"], ["loadScript.qvs", "2"], ["objects/fields.json", "3"],
    ["objects/themes.json", "4"], ["objects/glossarylinks.json", "5"], ["builds/x.qvf", "6"]]);
  expect(diffTrees(base, new Map())).toEqual([]);
});
test("titles", () => {
  expect(titleOf("objects/sheets/sh-1.json", '{"qProperty":{"qMetaDef":{"title":"Overview"}}}')).toBe("Overview");
  expect(titleOf("objects/dimensions/d.json", '{"qMetaDef":{"title":"Region"},"qName":"x"}')).toBe("Region");
  expect(titleOf("objects/variables/v.json", '{"qName":"vUser"}')).toBe("vUser");
  expect(titleOf("data_load_script/Load   Data.qvs", "///$tab Load / Data\r\nx")).toBe("Load / Data");
  expect(titleOf("data_load_script/Main.qvs", "no tab line")).toBe("Main.qvs");
  expect(titleOf("objects/sheets/x.json", "<<<<<<< HEAD")).toBe("x.json");
  expect(titleOf("objects/sheets/y.json", "{}")).toBe("y.json");
  expect(titleOf("objects/sheets/z.json", undefined)).toBe("z.json");
  expect(titleOf("appcontent/logo.png", undefined)).toBe("logo.png");
  expect(titleOf("appcontent/logo.png", new Uint8Array([1, 2]))).toBe("logo.png");
});
test("titles decode Uint8Array text as UTF-8", () => {
  const bytes = new TextEncoder().encode('{"qName":"Übersicht"}');
  expect(titleOf("objects/variables/v.json", bytes)).toBe("Übersicht");
});
test("line diff", () => {
  expect(lineDiff("a\nb\n", "a\nc\n")).toEqual([
    { kind: "same", text: "a" }, { kind: "removed", text: "b" }, { kind: "added", text: "c" }]);
});
test("line diff handles CRLF, blank lines and missing trailing newline", () => {
  expect(lineDiff("a\r\nb", "a\r\nb")).toEqual([{ kind: "same", text: "a" }, { kind: "same", text: "b" }]);
  expect(lineDiff("a\n\nb", "a\n\nb")).toEqual([
    { kind: "same", text: "a" }, { kind: "same", text: "" }, { kind: "same", text: "b" }]);
  expect(lineDiff("", "")).toEqual([]);
});
