import { createReadme } from "../../src/core/repo-layout";
import { serializeApp } from "../../src/core/serializer";
import type { AppSnapshot, FileMap } from "../../src/core/types";
import { CANON_ID, makeSnapshot } from "../fixtures/snapshot";
import type { fakeGitHub } from "./fake-ports";

/** Seeds lr-bicc/sales the way gitoqlok leaves it: the app's files, a branch table, and files the tool does not maintain. */
export function legacyRepo(github: ReturnType<typeof fakeGitHub>, snap = makeSnapshot()): string {
  const files: FileMap = serializeApp(snap, { canonicalAppId: CANON_ID });
  files.set("README.md", createReadme({ appTitle: "Sales", creatorLogin: "x", createdAt: new Date(0), sheets: [],
    defaultBranch: "main", appUrl: `https://qlik.example.com/qs/sense/app/${CANON_ID}` }));
  files.set("loadScript.qvs", "x"); files.set("builds/a.qvf", new Uint8Array([1])); files.set("objects/fields.json", "[]");
  files.set("objects/variables/v-script.json", '{"qInfo":{"qId":"v-script","qType":"variable"},"qName":"vNow","qIsScriptCreated":true}');
  return github.seed("lr-bicc/sales", files);
}

/** gitoqlok's app id in appcontent urls; the repository's canonical id is CANON_ID. */
export const GITOQLOK_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COLOR_MAP = { qInfo: { qId: "ColorMapModel_dim-1", qType: "ColorMap" }, colorMap: { colors: [{ value: "DE", baseColor: { color: "#ff0000" } }] } };

/** Gives dimension dim-1 of `snap` value colours, as the engine holds them. */
export function withValueColours(snap: AppSnapshot): AppSnapshot {
  snap.dimensions[0] = { ...snap.dimensions[0]!, _ColorMapModel: COLOR_MAP };
  return snap;
}

/**
 * Commits on main what gitoqlok writes for an unchanged app beyond legacyRepo's script variable: the sheet with
 * gitoqlok's app id in its thumbnail url and dim-1's value colours with the engine's `qMeta`. Returns the commit.
 */
export function gitoqlokFormat(github: ReturnType<typeof fakeGitHub>, repo = "lr-bicc/sales"): Promise<string> {
  const files = serializeApp(withValueColours(makeSnapshot()), { canonicalAppId: GITOQLOK_ID });
  const dim = JSON.parse(files.get("objects/dimensions/dim-1.json") as string) as Record<string, unknown>;
  dim._ColorMapModel = { qInfo: COLOR_MAP.qInfo, qMeta: { createdDate: "2025-02-07T12:13:34.102Z" }, colorMap: COLOR_MAP.colorMap };
  return github.commitFiles(repo, { branch: "main", parentSha: github.head(repo, "main"), message: "gitoqlok", changes: [
    { path: "objects/sheets/sh-1.json", content: files.get("objects/sheets/sh-1.json") as string },
    { path: "objects/dimensions/dim-1.json", content: JSON.stringify(dim, null, 2) },
  ] });
}
