import { zipSync, strToU8 } from "fflate";
import { serializeApp } from "../../src/core/serializer";
import { deserializeApp } from "../../src/core/deserializer";
import { validateTarget } from "../../src/core/target-validator";
import { planUpdate } from "../../src/core/update-planner";
import { diffTrees } from "../../src/core/diff";
import { gitBlobSha } from "../../src/core/git-hash";
import type { FileMap } from "../../src/core/types";
import { createGitHubClient } from "../../src/github/client";
import { downloadSnapshot } from "../../src/github/snapshot";
import { mockFetch } from "../github/mock-fetch";
import { makeSnapshot, APP_ID, CANON_ID } from "../fixtures/snapshot";

const ALL = new Set(["script", "objects", "bookmarks", "files"] as const);
const TOP = "lr-bicc-demo-abc123/";

async function shaMap(files: FileMap): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [path, content] of files) out.set(path, await gitBlobSha(content));
  return out;
}

test("an app survives serialize -> zipball -> download -> validate -> deserialize unchanged", async () => {
  const current = makeSnapshot();
  current.script += "///$tab Kennzahlen – Übersicht\r\nLET vÄ = 'größer';\r\n";
  current.staticFiles.set("data.bin", new Uint8Array([0, 255, 254, 128, 10, 13, 0xc3]));

  const serialized = serializeApp(current, { canonicalAppId: CANON_ID });
  expect(serialized.has("data_load_script/Kennzahlen – Übersicht.qvs")).toBe(true);

  const zipEntries: Record<string, Uint8Array> = { [TOP]: new Uint8Array(0) };
  for (const [path, content] of serialized) zipEntries[TOP + path] = typeof content === "string" ? strToU8(content) : content;
  const zip = zipSync(zipEntries);
  const m = mockFetch({ "GET /repos/lr-bicc/demo/zipball/abc123": () => ({ body: zip }) });
  const downloaded = await downloadSnapshot(createGitHubClient({ token: "t", fetch: m.fetch }), "lr-bicc/demo", "abc123");

  expect(validateTarget(downloaded)).toEqual([]);
  expect(diffTrees(await shaMap(serialized), await shaMap(downloaded))).toEqual([]);
  expect(downloaded.get("appcontent/data.bin")).toEqual(new Uint8Array([0, 255, 254, 128, 10, 13, 0xc3]));

  const target = deserializeApp(downloaded, { targetAppId: APP_ID });
  expect(planUpdate(current, target, ALL)).toEqual([]);
});
