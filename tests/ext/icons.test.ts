import { readFileSync } from "node:fs";

test("every icon PNG has its size", () => {
  const cases: [string, number, number][] = [
    ["src/ext/icons/icon-16.png", 16, 16],
    ["src/ext/icons/icon-32.png", 32, 32],
    ["src/ext/icons/icon-48.png", 48, 48],
    ["src/ext/icons/icon-128.png", 128, 128],
    ["store/promo-small-440x280.png", 440, 280],
  ];
  for (const [file, w, h] of cases) {
    const buf = readFileSync(file);
    expect([buf.readUInt32BE(16), buf.readUInt32BE(20)], file).toEqual([w, h]);
  }
});
