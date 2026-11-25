import { hashFiles } from "../../src/ext/flows/local-changes";
import { loadTarget } from "../../src/ext/flows/target";
import type { FileMap } from "../../src/core/types";
import { fakeGitHub } from "./fake-ports";

const REPO = "lr-bicc/sales";
const maintained = ["objects/dimensions/d1.json", "objects/dimensions/d2.json", "objects/measures/m1.json", "objects/measures/m2.json"];
const repoContent = (p: string): string => `{"at":"repo","p":"${p}"}`;

function seedRepo(github: ReturnType<typeof fakeGitHub>): string {
  const files: FileMap = new Map(maintained.map((p) => [p, repoContent(p)]));
  files.set("README.md", "# x");
  files.set("builds/x.qvf", new Uint8Array([1, 2]));
  files.set("loadScript.qvs", "x");
  return github.seed(REPO, files);
}

test("loadTarget downloads only maintained files that differ from the app", async () => {
  const github = fakeGitHub();
  const sha = seedRepo(github);
  const localFiles: FileMap = new Map([
    [maintained[0]!, repoContent(maintained[0]!)],
    [maintained[2]!, repoContent(maintained[2]!)],
    [maintained[1]!, "different"],
    [maintained[3]!, "different"],
  ]);
  const local = { files: localFiles, hashes: await hashFiles(localFiles) };
  const progress: [number, number][] = [];
  const files = await loadTarget(github, REPO, sha, local, (d, t) => progress.push([d, t]));
  expect([...files.keys()].sort()).toEqual(maintained);
  expect(files.get(maintained[1]!)).toBe(repoContent(maintained[1]!));
  expect(github.blobReads()).toBe(2);
  expect(progress.at(-1)).toEqual([4, 4]);
});

test("without local content every maintained file is downloaded", async () => {
  const github = fakeGitHub();
  const sha = seedRepo(github);
  const files = await loadTarget(github, REPO, sha);
  expect(files.size).toBe(4);
  expect(github.blobReads()).toBe(4);
});

test("downloads are split into groups of at most 100 blobs", async () => {
  const github = fakeGitHub();
  const many: FileMap = new Map();
  for (let i = 0; i < 250; i++) many.set(`objects/measures/m${i}.json`, `{"i":${i}}`);
  const sha = github.seed(REPO, many);
  const calls: number[] = [];
  const original = github.readBlobs.bind(github);
  github.readBlobs = async (repo, items) => { calls.push(items.length); return original(repo, items); };
  const files = await loadTarget(github, REPO, sha);
  expect(files.size).toBe(250);
  expect(calls).toEqual([100, 100, 50]);
});
