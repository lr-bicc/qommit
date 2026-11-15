import { commitChanges } from "../../src/ext/flows/commit";
import { FlowError } from "../../src/ext/flows/ports";
import type { CommitInfo } from "../../src/github/repo";
import type { LinkData } from "../../src/qlik/link";
import { APP_ID } from "../fixtures/snapshot";
import { fakePorts } from "./fake-ports";
import { legacyRepo } from "./helpers";

const NEW_DIM = "objects/dimensions/d-new.json";

async function linked(init: Parameters<typeof fakePorts>[0] = {}) {
  const { ports, github, app, cache } = fakePorts(init);
  const base = legacyRepo(github);
  const link: LinkData = { repo: "lr-bicc/sales", branch: "main", appId: APP_ID, syncedSha: base };
  app.link = link;
  app.snapshot.variables[0]!.qDefinition = "changed";
  app.snapshot.dimensions.push({ qInfo: { qId: "d-new", qType: "dimension" }, qMetaDef: { title: "Region" } });
  const changedVar = `objects/variables/${app.snapshot.variables[0]!.qInfo.qId}.json`;
  return { ports, github, app, cache, link, changedVar };
}

const input = (link: LinkData, over: Partial<Parameters<typeof commitChanges>[1]> = {}) =>
  ({ link, message: "m", paths: [NEW_DIM], removeUnmaintained: false, allowBehind: false, ...over });

test("commits only the selected paths", async () => {
  const { ports, github, app, link, changedVar } = await linked();
  const result = await commitChanges(ports, { link, message: "Add region", paths: ["objects/dimensions/d-new.json"], removeUnmaintained: false, allowBehind: false });
  const sha = (result as { sha: string }).sha;
  const files = github.filesAt(link.repo, sha);
  expect(files.has("objects/dimensions/d-new.json")).toBe(true);
  expect(files.get(changedVar)).toEqual(github.filesAt(link.repo, link.syncedSha).get(changedVar));   // not selected, untouched
  expect(files.has("loadScript.qvs")).toBe(true);
  expect(github.messageOf(link.repo, sha)).toBe("Add region");
  expect(app.link!.syncedSha).toBe(sha);
  expect(github.head(link.repo, "main")).toBe(sha);
});

test("a changed selected file is written", async () => {
  const { ports, github, link, changedVar } = await linked();
  const { sha } = (await commitChanges(ports, input(link, { paths: [changedVar] }))) as { sha: string };
  expect(github.filesAt(link.repo, sha).get(changedVar)).not.toEqual(github.filesAt(link.repo, link.syncedSha).get(changedVar));
  expect(github.filesAt(link.repo, sha).has(NEW_DIM)).toBe(false);
});

test("a moved branch is reported instead of committed", async () => {
  const { ports, github, link } = await linked();
  await github.commitFiles(link.repo, { branch: "main", parentSha: link.syncedSha, message: "theirs", changes: [{ path: "objects/measures/m-theirs.json", content: "{}" }] });
  const count = github.commitCount(link.repo);
  const result = await commitChanges(ports, { link, message: "m", paths: ["objects/dimensions/d-new.json"], removeUnmaintained: false, allowBehind: false });
  expect((result as { behind: CommitInfo[] }).behind.map((c) => c.message)).toEqual(["theirs"]);
  expect(github.commitCount(link.repo)).toBe(count);
});

test("a head that moved only outside the maintained files is not behind: the commit builds on it", async () => {
  const { ports, github, app, link } = await linked();
  const readme = github.filesAt(link.repo, link.syncedSha).get("README.md") as string;
  const head = await github.commitFiles(link.repo, { branch: "main", parentSha: link.syncedSha, message: "Update branches table",
    changes: [{ path: "README.md", content: `${readme}\n` }, { path: "builds/b.qvf", content: new Uint8Array([2]) }] });
  const spy = github.commitFiles;
  let parent = "";
  github.commitFiles = (repo, inp) => { parent = inp.parentSha; return spy(repo, inp); };
  const result = await commitChanges(ports, input(link, { allowBehind: false }));
  expect(parent).toBe(head);
  const { sha } = result as { sha: string };
  expect(github.head(link.repo, "main")).toBe(sha);
  expect(app.link!.syncedSha).toBe(sha);
});

test("selecting one changed script file commits the whole load script", async () => {
  const { ports, github, app, link } = await linked();
  app.snapshot.script = "///$tab Main\r\nSET a=2;\r\n///$tab Extra\r\nSET b=1;\r\n///$tab Load / Data\r\nLOAD * INLINE [x];\r\n";
  const before = github.filesAt(link.repo, link.syncedSha);
  const spy = github.commitFiles;
  let changes: { path: string }[] = [];
  github.commitFiles = (repo, inp) => { changes = inp.changes; return spy(repo, inp); };
  await commitChanges(ports, input(link, { paths: ["data_load_script/Main.qvs"] }));
  expect(changes.map((c) => c.path)).toEqual(["data_load_script/Main.qvs", "data_load_script/Extra.qvs", "data_load_script/tab_order.txt"]);
  expect(before.has("data_load_script/tab_order.txt")).toBe(true);
});

test("a commit without any script path leaves the script files alone", async () => {
  const { ports, github, app, link } = await linked();
  app.snapshot.script = "///$tab Main\r\nSET a=2;\r\n";
  const spy = github.commitFiles;
  let changes: { path: string }[] = [];
  github.commitFiles = (repo, inp) => { changes = inp.changes; return spy(repo, inp); };
  await commitChanges(ports, input(link, { paths: [NEW_DIM] }));
  expect(changes.map((c) => c.path)).toEqual([NEW_DIM]);
});

test("a deleted script tab is part of the whole script", async () => {
  const { ports, github, app, link } = await linked();
  app.snapshot.script = "///$tab Main\r\nSET a=2;\r\n";
  const removed = [...github.filesAt(link.repo, link.syncedSha).keys()]
    .filter((p) => p.startsWith("data_load_script/") && p !== "data_load_script/Main.qvs" && p !== "data_load_script/tab_order.txt");
  expect(removed).toHaveLength(1);
  const spy = github.commitFiles;
  let changes: { path: string; content: unknown }[] = [];
  github.commitFiles = (repo, inp) => { changes = inp.changes; return spy(repo, inp); };
  await commitChanges(ports, input(link, { paths: ["data_load_script/Main.qvs"] }));
  expect(changes.map((c) => [c.path, c.content === null])).toEqual([
    ["data_load_script/Main.qvs", false], [removed[0], true], ["data_load_script/tab_order.txt", false],
  ]);
});

test("commit anyway builds on the head and keeps what was not selected", async () => {
  const { ports, github, link } = await linked();
  await github.commitFiles(link.repo, { branch: "main", parentSha: link.syncedSha, message: "theirs", changes: [{ path: "objects/measures/m-theirs.json", content: "{}" }] });
  const result = await commitChanges(ports, { link, message: "m", paths: ["objects/dimensions/d-new.json"], removeUnmaintained: false, allowBehind: true });
  const files = github.filesAt(link.repo, (result as { sha: string }).sha);
  expect(files.has("objects/measures/m-theirs.json")).toBe(true);
  expect(files.has("objects/dimensions/d-new.json")).toBe(true);
});

test("a commit that loses the race is reported as behind", async () => {
  const { ports, github, app, link } = await linked();
  github.raceOnce(link.repo);
  const result = await commitChanges(ports, { link, message: "m", paths: ["objects/dimensions/d-new.json"], removeUnmaintained: false, allowBehind: false });
  expect("behind" in result).toBe(true);
  expect(app.link!.syncedSha).toBe(link.syncedSha);
});

test("behind after a lost race is computed against the head read afterwards", async () => {
  const { ports, github, link } = await linked();
  const original = github.commitFiles;
  let raced = false;
  github.commitFiles = async (repo, inp) => {
    if (!raced) {
      raced = true;
      await original(repo, { branch: "main", parentSha: link.syncedSha, message: "theirs", changes: [{ path: "x.txt", content: "1" }] });
    }
    return original(repo, inp);
  };
  const result = await commitChanges(ports, input(link));
  expect((result as { behind: CommitInfo[] }).behind.map((c) => c.message)).toEqual(["theirs"]);
});

test("a selected deleted path is removed from the tree", async () => {
  const { ports, github, link } = await linked();
  const { sha } = (await commitChanges(ports, input(link, { paths: ["objects/variables/v-script.json"] }))) as { sha: string };
  const files = github.filesAt(link.repo, sha);
  expect(files.has("objects/variables/v-script.json")).toBe(false);
  expect(files.has(NEW_DIM)).toBe(false);
});

test("removeUnmaintained also deletes files the tool does not maintain", async () => {
  const { ports, github, link } = await linked();
  const { sha } = (await commitChanges(ports, input(link, { removeUnmaintained: true }))) as { sha: string };
  const files = github.filesAt(link.repo, sha);
  for (const p of ["loadScript.qvs", "builds/a.qvf", "objects/fields.json"]) expect(files.has(p)).toBe(false);
  expect(files.has("README.md")).toBe(true);
  expect(files.has(NEW_DIM)).toBe(true);
});

test("unmaintained files are kept without removeUnmaintained, even when selected", async () => {
  const { ports, github, link } = await linked();
  const { sha } = (await commitChanges(ports, input(link, { paths: [NEW_DIM, "loadScript.qvs", "README.md", "builds/a.qvf"] }))) as { sha: string };
  const files = github.filesAt(link.repo, sha);
  for (const p of ["loadScript.qvs", "README.md", "builds/a.qvf"]) expect(files.has(p)).toBe(true);
});

test("removeUnmaintained alone is enough for a commit", async () => {
  const { ports, github, link } = await linked();
  const { sha } = (await commitChanges(ports, input(link, { paths: [], removeUnmaintained: true }))) as { sha: string };
  expect(github.filesAt(link.repo, sha).has("loadScript.qvs")).toBe(false);
});

test("a path listed twice is committed once", async () => {
  const { ports, github, link } = await linked();
  const spy = github.commitFiles;
  let changes: { path: string }[] = [];
  github.commitFiles = (repo, inp) => { changes = inp.changes; return spy(repo, inp); };
  await commitChanges(ports, input(link, { paths: [NEW_DIM, NEW_DIM] }));
  expect(changes.map((c) => c.path)).toEqual([NEW_DIM]);
});

test("changes follow the selection order, then the unmaintained paths sorted", async () => {
  const { ports, github, link, changedVar } = await linked();
  const spy = github.commitFiles;
  let changes: { path: string }[] = [];
  github.commitFiles = (repo, inp) => { changes = inp.changes; return spy(repo, inp); };
  await commitChanges(ports, input(link, { paths: [NEW_DIM, changedVar], removeUnmaintained: true }));
  expect(changes.map((c) => c.path)).toEqual([NEW_DIM, changedVar, "builds/a.qvf", "loadScript.qvs", "objects/fields.json"]);
});

test("selected paths identical to the head give nothing-to-commit", async () => {
  const { ports, github, link } = await linked();
  const count = github.commitCount(link.repo);
  await expect(commitChanges(ports, input(link, { paths: ["objects/measures/mes-1.json", "objects/variables/not-there.json"] })))
    .rejects.toMatchObject({ name: "FlowError", code: "nothing-to-commit" });
  expect(github.commitCount(link.repo)).toBe(count);
});

test("an empty message is refused", async () => {
  const { ports, link } = await linked();
  const err = await commitChanges(ports, input(link, { message: "  \n " })).catch((e) => e);
  expect(err).toBeInstanceOf(FlowError);
  expect(err.code).toBe("message-required");
});

test("a published app cannot be committed", async () => {
  const { ports, github, link } = await linked({ info: { published: true } });
  const count = github.commitCount(link.repo);
  await expect(commitChanges(ports, input(link))).rejects.toMatchObject({ code: "published" });
  expect(github.commitCount(link.repo)).toBe(count);
});

test("a missing branch fails with branch-not-found", async () => {
  const { ports, github, link } = await linked();
  github.deleteBranch(link.repo, "main");
  await expect(commitChanges(ports, input(link))).rejects.toMatchObject({ code: "branch-not-found" });
});

test("a protected branch is passed through and the link stays", async () => {
  const { ports, github, app, link } = await linked();
  github.protect(link.repo, "main");
  await expect(commitChanges(ports, input(link))).rejects.toMatchObject({ name: "GatewayError", kind: "protected-branch" });
  expect(app.link).toEqual(link);
});

test("a failing saveLink after the commit leaves the commit standing", async () => {
  const { ports, github, app, cache, link } = await linked();
  app.writeLink = async () => { throw new Error("read-only"); };
  cache.set = async () => { throw new Error("cache down"); };
  const before = github.commitCount(link.repo);
  await expect(commitChanges(ports, input(link))).rejects.toThrow("cache down");
  expect(github.commitCount(link.repo)).toBe(before + 1);
});

test("progress of reading the app is forwarded", async () => {
  const { ports, link } = await linked();
  const calls: [number, number][] = [];
  await commitChanges(ports, input(link), (d, t) => calls.push([d, t]));
  expect(calls).toEqual([[1, 1]]);
});
