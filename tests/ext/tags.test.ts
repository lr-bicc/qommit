import { addTag } from "../../src/ext/flows/tags";
import { GatewayError } from "../../src/ext/shared/github-port";
import { fakeGitHub } from "./fake-ports";

const repo = "lr-bicc/sales";

function setup() {
  const github = fakeGitHub();
  const sha = github.seed(repo, new Map([["README.md", "# Sales\n"]]));
  return { github, sha };
}

test("addTag creates an annotated tag with the trimmed name and the message", async () => {
  const { github, sha } = setup();
  await addTag(github, { repo, sha, name: "  v1  ", message: "First release" });
  expect(await github.listTags(repo)).toEqual([expect.objectContaining({ name: "v1", sha, message: "First release" })]);
});

test("addTag refuses an existing name and changes nothing", async () => {
  const { github, sha } = setup();
  github.tag(repo, "v1", sha, "original");
  const before = await github.listTags(repo);
  const createTag = vi.spyOn(github, "createTag");
  await expect(addTag(github, { repo, sha, name: "v1", message: "other" })).rejects.toMatchObject({ code: "tag-exists" });
  expect(createTag).not.toHaveBeenCalled();
  expect(await github.listTags(repo)).toEqual(before);
});

test("addTag refuses invalid names", async () => {
  const { github, sha } = setup();
  for (const name of ["bad name", "a..b", "  ", ""]) {
    await expect(addTag(github, { repo, sha, name, message: "" })).rejects.toMatchObject({ code: "invalid-tag-name" });
  }
  expect(await github.listTags(repo)).toEqual([]);
});

test("a name-exists race on createTag becomes tag-exists", async () => {
  const { github, sha } = setup();
  vi.spyOn(github, "createTag").mockRejectedValueOnce(new GatewayError("name-exists", "exists"));
  await expect(addTag(github, { repo, sha, name: "v2", message: "" })).rejects.toMatchObject({ code: "tag-exists" });
});

test("other createTag failures pass through", async () => {
  const { github, sha } = setup();
  vi.spyOn(github, "createTag").mockRejectedValueOnce(new GatewayError("network", "down"));
  await expect(addTag(github, { repo, sha, name: "v2", message: "" })).rejects.toMatchObject({ kind: "network" });
});
