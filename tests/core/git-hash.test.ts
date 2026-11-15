import { gitBlobSha } from "../../src/core/git-hash";

test("matches git hash-object", async () => {
  expect(await gitBlobSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  expect(await gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  expect(await gitBlobSha(new TextEncoder().encode("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
});

test("uses UTF-8 byte length for non-ASCII text", async () => {
  expect(await gitBlobSha("Umsätze")).toBe(await gitBlobSha(new TextEncoder().encode("Umsätze")));
  expect(await gitBlobSha("Umsätze")).not.toBe(await gitBlobSha("Umsatze"));
});
