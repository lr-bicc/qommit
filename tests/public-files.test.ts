import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (file: string): string => readFileSync(join(root, file), "utf8");

describe("public files", () => {
  test("public texts name nothing internal", () => {
    const banned = ["lrworld", "lr-analytics", "LR\\", "R.Vasilev@", "Supply Chain"];
    for (const file of ["site/index.html", "store/listing.md", "README.md", "LICENSE", "docs/release.md", "src/ext/manifest.json"]) {
      const text = read(file).toLowerCase();
      for (const word of banned) expect(text, `${file} contains ${word}`).not.toContain(word.toLowerCase());
    }
  });

  test("the store short description fits", () => {
    const match = /\*\*Short description:\*\* (.+)/.exec(read("store/listing.md"));
    expect(match).not.toBeNull();
    const length = match![1]!.trim().length;
    expect(length).toBeGreaterThanOrEqual(1);
    expect(length).toBeLessThanOrEqual(132);
  });

  test("the privacy page says where data goes", () => {
    const page = read("site/index.html");
    for (const text of ["chrome.storage.local", "api.github.com", "https://github.com/lr-bicc/qommit/issues"]) {
      expect(page).toContain(text);
    }
  });

  test("MIT license with its holder", () => {
    const license = read("LICENSE");
    expect(license.startsWith("MIT License")).toBe(true);
    expect(license).toContain("Copyright (c) 2026 Rumen Vasilev");
  });

  test("README links the privacy policy", () => {
    expect(read("README.md")).toContain("https://lr-bicc.github.io/qommit/");
  });
});
