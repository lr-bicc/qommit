import { splitScript, scriptToFiles, filesToScript, TAB_ORDER_PATH } from "../../src/core/script-tabs";
import { makeSnapshot } from "../fixtures/snapshot";
const script = makeSnapshot().script;

test("splits at tab markers and drops the line break before a marker", () => {
  expect(splitScript(script)).toEqual([
    { name: "Main", content: "///$tab Main\r\nSET a=1;" },
    { name: "Load / Data", content: "///$tab Load / Data\r\nLOAD * INLINE [x];\r\n" },
  ]);
});
test("writes one file per tab and the order file", () => {
  const files = scriptToFiles(script);
  expect([...files.keys()].sort()).toEqual([
    "data_load_script/Load   Data.qvs", "data_load_script/Main.qvs", TAB_ORDER_PATH]);
  expect(files.get(TAB_ORDER_PATH)).toBe("Main%tab_file_order_divider%Load   Data");
});
test("round-trips CRLF and LF scripts exactly", () => {
  expect(filesToScript(scriptToFiles(script))).toBe(script);
  const lf = script.replaceAll("\r\n", "\n");
  expect(filesToScript(scriptToFiles(lf))).toBe(lf);
});
test("keeps tabs apart whose names collide after sanitizing", () => {
  const s = "///$tab A/B\r\n1;\r\n///$tab A B\r\n2;\r\n///$tab a b\r\n3;";
  const files = scriptToFiles(s);
  expect(files.get(TAB_ORDER_PATH)).toBe(["A B", "A B (2)", "a b (3)"].join("%tab_file_order_divider%"));
  expect(filesToScript(files)).toBe(s);
});
test("empty script and missing files", () => {
  expect([...scriptToFiles("").entries()]).toEqual([[TAB_ORDER_PATH, ""]]);
  expect(filesToScript(new Map())).toBe("");
  expect(filesToScript(scriptToFiles(""))).toBe("");
  expect(() => filesToScript(new Map([[TAB_ORDER_PATH, "Main"]]))).toThrow(/Main\.qvs/);
});
test("text before the first marker becomes a Main tab", () => {
  const s = "SET x=1;\r\n///$tab Two\r\nSET y=2;";
  expect(splitScript(s)).toEqual([
    { name: "Main", content: "SET x=1;" },
    { name: "Two", content: "///$tab Two\r\nSET y=2;" },
  ]);
  expect(filesToScript(scriptToFiles(s))).toBe(s);
});
test("decodes Uint8Array tab files as UTF-8", () => {
  const files = new Map<string, string | Uint8Array>([
    [TAB_ORDER_PATH, "Main"],
    ["data_load_script/Main.qvs", new TextEncoder().encode("///$tab Main\r\nSET a='ä';")],
  ]);
  expect(filesToScript(files)).toBe("///$tab Main\r\nSET a='ä';");
});
test("documented exception to the lossless round trip: LF script without any line break inside a tab is restored with CRLF", () => {
  expect(filesToScript(scriptToFiles("///$tab A\n///$tab B"))).toBe("///$tab A\r\n///$tab B");
});
test("an empty tab name gets the file name Tab and round-trips exactly", () => {
  const s = "///$tab \r\nSET a=1;";
  const files = scriptToFiles(s);
  expect(files.has("data_load_script/Tab.qvs")).toBe(true);
  expect(files.get(TAB_ORDER_PATH)).toBe("Tab");
  expect(filesToScript(files)).toBe(s);
});
test("several tabs with empty or whitespace-only file names are numbered", () => {
  const s = "///$tab \r\n1;\r\n///$tab ???\r\n2;";
  const files = scriptToFiles(s);
  expect(files.get(TAB_ORDER_PATH)).toBe("Tab%tab_file_order_divider%Tab (2)");
  expect(filesToScript(files)).toBe(s);
});
