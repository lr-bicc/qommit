import { deserializeApp } from "../../core/deserializer";
import { readmeTitle } from "../../core/repo-layout";
import { serializeApp } from "../../core/serializer";
import { validateTarget } from "../../core/target-validator";
import type { Part } from "../../core/diff";
import { planUpdate } from "../../core/update-planner";
import type { GitHubPort } from "../shared/github-port";
import { FlowError, type ServerPort } from "./ports";
import { loadTarget } from "./target";

export interface ImportResult { appId: string; name: string; url: string }

const ALL_PARTS: ReadonlySet<Part> = new Set<Part>(["script", "objects", "files"]);

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Creates a new app named "<title> (<label>)" and fills it from the repository state at `sha`. The state is loaded
 * and checked before anything is created. A failure after the app exists leaves it in place and reports its id.
 */
export async function importApp(
  deps: { github: GitHubPort; server: ServerPort },
  input: { repo: string; sha: string; label: string },
  onProgress?: (text: string) => void,
): Promise<ImportResult> {
  const { github, server } = deps;
  const { repo, sha, label } = input;
  const files = await loadTarget(github, repo, sha, undefined, (done, total) => onProgress?.(`Loading repository files… ${done}/${total}`));
  const problems = validateTarget(files);
  if (problems.length > 0) throw new FlowError("invalid-target", "The selected state is not a valid app state", problems);

  const readme = await github.readTextFile(repo, sha, "README.md");
  const title = (readme === null ? null : readmeTitle(readme)) ?? repo.split("/").pop()!;
  const name = `${title} (${label})`;

  onProgress?.("Creating app…");
  let created: Awaited<ReturnType<ServerPort["createApp"]>>;
  try {
    created = await server.createApp(name);
  } catch (e) {
    const appId = (e as { appId?: unknown } | null)?.appId;
    if (typeof appId === "string") throw new FlowError("import-failed", messageOf(e), { appId, url: server.appUrl(appId) });
    throw new FlowError("import-failed", messageOf(e), { appId: null, url: null });
  }

  const { app, close } = created;
  let appId: string | null = null;
  try {
    appId = (await app.info()).id;
    const snapshot = await app.read({ includeFiles: true });
    const current = deserializeApp(serializeApp(snapshot, { canonicalAppId: snapshot.appId }), { targetAppId: appId });
    const target = deserializeApp(files, { targetAppId: appId });
    const actions = planUpdate(current, target, ALL_PARTS);
    await app.apply(actions, (done, total) => onProgress?.(`Writing app… ${done}/${total}`));
    onProgress?.("Saving app…");
    await app.save();
    return { appId, name, url: server.appUrl(appId) };
  } catch (e) {
    throw new FlowError("import-failed", messageOf(e), { appId, url: appId === null ? null : server.appUrl(appId) });
  } finally {
    // Closing may never settle on a dead socket; the result or error must not wait for it.
    try { void Promise.resolve(close()).catch(() => {}); } catch { /* already closed */ }
  }
}
