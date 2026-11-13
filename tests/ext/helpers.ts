import { createReadme } from "../../src/core/repo-layout";
import { serializeApp } from "../../src/core/serializer";
import type { FileMap } from "../../src/core/types";
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
