import { GatewayError } from "../../src/ext/shared/github-port";
import { fakeGitHub } from "./fake-ports";

test("fake readBlobs answers with the files of the commit", async () => {
  const gh = fakeGitHub();
  const sha = gh.seed("lr-bicc/sales", new Map([["objects/variables/v.json", "{}"]]));
  const tree = await gh.getTree("lr-bicc/sales", sha);
  const files = await gh.readBlobs("lr-bicc/sales", [{ path: "objects/variables/v.json", sha: tree.get("objects/variables/v.json")! }]);
  expect(files.get("objects/variables/v.json")).toBe("{}");
  expect(gh.blobReads()).toBe(1);
});

test("fake readBlobs refuses an unknown sha", async () => {
  const gh = fakeGitHub();
  gh.seed("lr-bicc/sales", new Map([["a", "x"]]));
  await expect(gh.readBlobs("lr-bicc/sales", [{ path: "a", sha: "f".repeat(40) }])).rejects.toMatchObject({ kind: "not-found" });
});

test("fake tags can be seeded, listed and created; an existing name is refused", async () => {
  const gh = fakeGitHub();
  const sha = gh.seed("lr-bicc/sales", new Map([["a", "x"]]));
  gh.tag("lr-bicc/sales", "v1", sha, "first");
  await gh.createTag("lr-bicc/sales", { name: "v2", sha, message: "second" });
  expect((await gh.listTags("lr-bicc/sales")).map((t) => [t.name, t.sha, t.message])).toEqual([["v1", sha, "first"], ["v2", sha, "second"]]);
  await expect(gh.createTag("lr-bicc/sales", { name: "v1", sha, message: "" })).rejects.toBeInstanceOf(GatewayError);
  await expect(gh.createTag("lr-bicc/sales", { name: "v1", sha, message: "" })).rejects.toMatchObject({ kind: "name-exists" });
});

test("fake listCommits returns the parents", async () => {
  const gh = fakeGitHub();
  const root = gh.seed("lr-bicc/sales", new Map([["a", "x"]]));
  const next = await gh.commitFiles("lr-bicc/sales", { branch: "main", parentSha: root, message: "m", changes: [{ path: "a", content: "y" }] });
  const commits = await gh.listCommits("lr-bicc/sales", "main", 1);
  expect(commits.find((c) => c.sha === next)!.parents).toEqual([root]);
  expect(commits.find((c) => c.sha === root)!.parents).toEqual([]);
});
