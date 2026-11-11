import { repoSlug, repoSlugWithId, parseBranchTable, upsertBranchRow, canonicalAppId, findBranchForApp, createReadme }
  from "../../src/core/repo-layout";

test("slugs", () => {
  expect(repoSlug("Supply Chain Performance")).toBe("supply-chain-performance");
  expect(repoSlug("Umsätze & Bestände (DE)")).toBe("umsaetze-bestaende-de");
  expect(repoSlug("Café  Größe", "qlik-")).toBe("qlik-cafe-groesse");
  expect(repoSlug("Продажби")).toBe("app");
  expect(repoSlug("x".repeat(200)).length).toBe(80);
  expect(repoSlugWithId("Продажби", "def7f0fe-1253-41bf-a3f2-b72b72fe7804")).toBe("app-def7f0fe");
});

test("slug limit includes the prefix and never ends with a dash", () => {
  expect(repoSlug("x".repeat(200), "qlik-").length).toBe(80);
  expect(repoSlug("x".repeat(200), "qlik-").startsWith("qlik-x")).toBe(true);
  const s = repoSlug("a".repeat(74) + " " + "b".repeat(20), "qlik-"); // dash lands exactly at position 80
  expect(s).toBe("qlik-" + "a".repeat(74));
  expect(s.endsWith("-")).toBe(false);
  expect(repoSlug("Ärger ÖL Über Straße")).toBe("aerger-oel-ueber-strasse");
  expect(repoSlug("  --  ")).toBe("app");
});

const A = "a600a3f7-cc53-4822-a600-13522fc2e6a8", B = "cb1d418c-c2cd-4134-8b8d-bcef3a9a224d", C = "fa823547-0a1f-4b57-acd0-d3be1fa40cea";
const readme = [
  "# Qlik Application Repository ", "# Demo", "", "Sheet Title | Description", "------------ | -------------", "About|", "", "",
  "Branch Name|Qlik application", "---|---",
  `main|[https://qs.example.com/sense/app/${A}](https://qs.example.com/sense/app/${A})`,
  `test-branch|[https://qs.example.com/qs/sense/app/${B}](https://qs.example.com/qs/sense/app/${B})`,
  `test-branch|[https://qs.example.com/qs/sense/app/${B}](https://qs.example.com/qs/sense/app/${B})`,
  `old|[https://qs-test/sense/app/${C}](https://qs-test/sense/app/${C})`,
].join("\n");

test("reads the table gitoqlok leaves behind", () => {
  const rows = parseBranchTable(readme);
  expect(rows.map(r => [r.branch, r.appId])).toEqual([["main", A], ["test-branch", B], ["old", C]]);
  expect(canonicalAppId(rows, "main")).toBe(A);
  expect(findBranchForApp(rows, C)).toBe("old");
  expect(findBranchForApp(rows, "nope")).toBeNull();
  expect(parseBranchTable("# no table")).toEqual([]);
});
test("writes exactly one row per branch and keeps the rest", () => {
  const url = "https://qs.example.com/qs/sense/app/11111111-1111-4111-8111-111111111111";
  const out = upsertBranchRow(readme, { branch: "test-branch", appUrl: url });
  expect(out.split("\n").filter(l => l.startsWith("test-branch|"))).toEqual([`test-branch|[${url}](${url})`]);
  expect(out.startsWith(readme.split("Branch Name")[0])).toBe(true);
  expect(parseBranchTable(upsertBranchRow(out, { branch: "new", appUrl: url })).map(r => r.branch))
    .toEqual(["main", "test-branch", "old", "new"]);
  expect(parseBranchTable(upsertBranchRow("# no table", { branch: "main", appUrl: url }))).toHaveLength(1);
});
test("creates a readme the parser understands", () => {
  const url = `https://qs.example.com/qs/sense/app/${A}`;
  const md = createReadme({ appTitle: "Demo", creatorLogin: "rumen-vasilev", createdAt: new Date("2026-11-11T10:00:00Z"),
    sheets: [{ title: "About", description: "" }], defaultBranch: "main", appUrl: url });
  expect(md).toContain("# Demo");
  expect(md).toContain("2026-11-11T10:00:00.000Z");
  expect(md).toContain("About|");
  expect(parseBranchTable(md)).toEqual([{ branch: "main", appUrl: url, appId: A }]);
});

test("appUrl comes from the link target, appId is lower-cased", () => {
  const md = [
    "Branch Name|Qlik application", "---|---",
    `main|[Open the app](https://qs.example.com/sense/app/${A.toUpperCase()}/overview)`,
    "plain|https://qs.example.com/sense/app/" + B,
    "nolink|[text](https://qs.example.com/hub)",
    "| |[x](https://x/app/" + C + ")",
  ].join("\n");
  const rows = parseBranchTable(md);
  expect(rows).toEqual([
    { branch: "main", appUrl: `https://qs.example.com/sense/app/${A.toUpperCase()}/overview`, appId: A },
    { branch: "nolink", appUrl: "https://qs.example.com/hub", appId: null },
  ]);
  expect(findBranchForApp(rows, A.toUpperCase())).toBe("main");
  expect(findBranchForApp(rows, A)).toBe("main");
});

test("copes with CRLF and trailing spaces on the header line", () => {
  const md = ["# T", "", "Branch Name|Qlik application  ", "---|---  ",
    `main|[u](https://q/app/${A})`, `dev|[u](https://q/app/${B})`, "", "tail text"].join("\r\n");
  expect(parseBranchTable(md).map(r => [r.branch, r.appId])).toEqual([["main", A], ["dev", B]]);
  const url = `https://q/app/${C}`;
  const out = upsertBranchRow(md, { branch: "dev", appUrl: url });
  expect(out).toBe(md.replace(`dev|[u](https://q/app/${B})`, `dev|[${url}](${url})`));
  const added = upsertBranchRow(md, { branch: "feat", appUrl: url });
  expect(added).toBe(md.replace(`dev|[u](https://q/app/${B})`, `dev|[u](https://q/app/${B})\r\nfeat|[${url}](${url})`));
  expect(added.replace(/\r\n/g, "").includes("\n")).toBe(false);
});

test("non-link rows are left untouched by the writer", () => {
  const md = ["Branch Name|Qlik application", "---|---", "main|n/a", `dev|[u](https://q/app/${B})`, ""].join("\n");
  const url = `https://q/app/${C}`;
  const out = upsertBranchRow(md, { branch: "main", appUrl: url });
  expect(out.split("\n")[2]).toBe("main|n/a");
  expect(out.split("\n")).toContain(`main|[${url}](${url})`);
  expect(parseBranchTable(out).map(r => r.branch)).toEqual(["dev", "main"]);
});

test("appends the table after two blank lines and keeps the line ending", () => {
  const url = `https://q/app/${A}`;
  expect(upsertBranchRow("# x", { branch: "main", appUrl: url }))
    .toBe(`# x\n\n\nBranch Name|Qlik application\n---|---\nmain|[${url}](${url})\n`);
  expect(upsertBranchRow("# x\r\n", { branch: "main", appUrl: url }))
    .toBe(`# x\r\n\r\n\r\nBranch Name|Qlik application\r\n---|---\r\nmain|[${url}](${url})\r\n`);
});

test("canonicalAppId and findBranchForApp with missing data", () => {
  const rows = [{ branch: "dev", appUrl: "u", appId: B }];
  expect(canonicalAppId(rows, "main")).toBeNull();
  expect(findBranchForApp(rows, B.toUpperCase())).toBe("dev");
});
