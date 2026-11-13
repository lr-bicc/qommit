import { base64ToBytes, bytesToBase64, fromWire, toWire } from "../../src/ext/shared/wire";

test("binary content survives the wire format", () => {
  const bytes = new Uint8Array([0, 255, 137, 80, 78, 71]);
  const wire = JSON.parse(JSON.stringify(toWire(bytes)));
  expect(fromWire(wire)).toEqual(bytes);
  expect(fromWire(JSON.parse(JSON.stringify(toWire("äö€"))))).toBe("äö€");
  const big = new Uint8Array(300_000).map((_, i) => i % 251);
  expect(base64ToBytes(bytesToBase64(big))).toEqual(big);
});

test("base64 helpers match known values", () => {
  expect(bytesToBase64(new Uint8Array([1, 2, 3]))).toBe("AQID");
  expect(bytesToBase64(new Uint8Array([]))).toBe("");
  expect(base64ToBytes("AQID")).toEqual(new Uint8Array([1, 2, 3]));
});
