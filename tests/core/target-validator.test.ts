import { validateTarget } from "../../src/core/target-validator";
import { serializeApp } from "../../src/core/serializer";
import { makeSnapshot, CANON_ID } from "../fixtures/snapshot";
const TAB_ORDER = "data_load_script/tab_order.txt";
const good = () => serializeApp(makeSnapshot(), { canonicalAppId: CANON_ID });

test("a serialized snapshot is valid", () => expect(validateTarget(good())).toEqual([]));
test("finds broken json and conflict markers", () => {
  const f = good();
  f.set("objects/measures/mes-1.json", "{ not json");
  f.set("objects/sheets/sh-1.json", '<<<<<<< HEAD\n{"a":1}\n=======\n{"a":2}\n>>>>>>> feature\n');
  f.set("data_load_script/Main.qvs", "///$tab Main\r\n<<<<<<< HEAD\r\nSET a=1;");
  expect(validateTarget(f)).toEqual([
    { path: "data_load_script/Main.qvs", reason: "conflict-markers" },
    { path: "objects/measures/mes-1.json", reason: "invalid-json" },
    { path: "objects/sheets/sh-1.json", reason: "conflict-markers" },
  ]);
});
test("finds tab files that do not match the order file", () => {
  const f = good();
  f.delete("data_load_script/Main.qvs");
  f.set("data_load_script/Extra.qvs", "///$tab Extra\r\n");
  expect(validateTarget(f)).toEqual([
    { path: "data_load_script/Extra.qvs", reason: "unlisted-tab-file" },
    { path: "data_load_script/Main.qvs", reason: "missing-tab-file" },
  ]);
});
test("ignores unmaintained and binary files", () => {
  const f = good();
  f.set("README.md", "<<<<<<< HEAD"); f.set("objects/fields.json", "{ broken");
  f.set("appcontent/logo.png", new TextEncoder().encode("<<<<<<< HEAD"));
  expect(validateTarget(f)).toEqual([]);
});
test("a bare ======= line alone is not a conflict", () => {
  const f = good();
  f.set("data_load_script/Main.qvs", "///$tab Main\r\nSET a=1;\r\n=======\r\nSET b=2;");
  expect(validateTarget(f)).toEqual([]);
});
test("detects the end marker and markers with a trailing CR", () => {
  const f = good();
  f.set("data_load_script/Main.qvs", "///$tab Main\r\n>>>>>>> feature\r\n");
  expect(validateTarget(f)).toContainEqual({ path: "data_load_script/Main.qvs", reason: "conflict-markers" });
});
test("markers must start the line and carry the trailing space", () => {
  const f = good();
  f.set("data_load_script/Main.qvs", "///$tab Main\r\n x <<<<<<< HEAD\r\n<<<<<<<HEAD\r\n");
  expect(validateTarget(f)).toEqual([]);
});
test("checks conflict markers in the order file and decodes Uint8Array text", () => {
  const f = good();
  f.set("data_load_script/tab_order.txt", "<<<<<<< HEAD\nMain");
  f.set("objects/measures/mes-1.json", new TextEncoder().encode("{ not json"));
  const result = validateTarget(f);
  expect(result).toContainEqual({ path: "data_load_script/tab_order.txt", reason: "conflict-markers" });
  expect(result).toContainEqual({ path: "objects/measures/mes-1.json", reason: "invalid-json" });
});
test("an empty order file means no tabs", () => {
  const f = good();
  f.set("data_load_script/tab_order.txt", "");
  expect(validateTarget(f)).toEqual([
    { path: "data_load_script/Load   Data.qvs", reason: "unlisted-tab-file" },
    { path: "data_load_script/Main.qvs", reason: "unlisted-tab-file" },
  ]);
});
test("a missing order file reports every tab file as unlisted", () => {
  const f = good();
  f.delete("data_load_script/tab_order.txt");
  expect(validateTarget(f).map((p) => p.reason)).toEqual(["unlisted-tab-file", "unlisted-tab-file"]);
});
