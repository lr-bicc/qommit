import { isValidRefName } from "../../github/repo";
import { GatewayError, type GitHubPort } from "../shared/github-port";
import { FlowError } from "./ports";

/** Creates an annotated tag on a commit. The name is trimmed; an existing tag is never changed. */
export async function addTag(
  github: GitHubPort, input: { repo: string; sha: string; name: string; message: string },
): Promise<void> {
  const name = input.name.trim();
  if (!isValidRefName(name)) throw new FlowError("invalid-tag-name", `"${name}" is not a valid tag name`);
  const exists = (): FlowError => new FlowError("tag-exists", `Tag ${name} already exists`);
  if ((await github.listTags(input.repo)).some((t) => t.name === name)) throw exists();
  try {
    await github.createTag(input.repo, { name, sha: input.sha, message: input.message });
  } catch (e) {
    if (e instanceof GatewayError && e.kind === "name-exists") throw exists();
    throw e;
  }
}
