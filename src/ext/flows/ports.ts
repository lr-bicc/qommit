import { groupOf } from "../../core/diff";
import type { AppSnapshot } from "../../core/types";
import type { Action } from "../../core/update-planner";
import type { LinkData } from "../../qlik/link";
import type { GitHubPort } from "../shared/github-port";
import { GatewayError } from "../shared/github-port";

export interface AppInfo { id: string; title: string; published: boolean; url: string; user: string; canWrite: boolean }

export interface AppPort {
  info(): Promise<AppInfo>;
  read(opts: { includeFiles: boolean; onProgress?: (done: number, total: number) => void }): Promise<AppSnapshot>;
  readLink(): Promise<LinkData | null>;
  writeLink(link: LinkData): Promise<void>;
  removeLink(): Promise<void>;
  /** Applies the actions in order; a failure rejects with ApplyError. Does not save the app. */
  apply(actions: Action[], onProgress?: (done: number, total: number) => void): Promise<void>;
  save(): Promise<void>;
  readGitoqlokMeta(): Promise<{ repo: string | null; lastCommitId: string | null } | null>;
}

/** Server-wide actions: creating a new app and opening it. */
export interface ServerPort {
  createApp(name: string): Promise<{ app: AppPort; close(): Promise<void> }>;
}

export interface LinkCache {
  get(key: string): Promise<LinkData | null>;
  set(key: string, link: LinkData): Promise<void>;
  remove(key: string): Promise<void>;
  /** Set by "Unlink": the app is not offered as linked again from the README table or gitoqlok's metadata. */
  isUnlinked(key: string): Promise<boolean>;
  setUnlinked(key: string, value: boolean): Promise<void>;
}

export interface FlowPorts { app: AppPort; github: GitHubPort; cache: LinkCache; repoPrefix: string; now(): Date }

export type FlowErrorCode =
  | "published" | "not-linked" | "branch-exists" | "branch-not-found" | "invalid-branch-name" | "repo-exists"
  | "repo-not-found" | "nothing-to-commit" | "message-required"
  | "invalid-target" | "update-failed" | "cannot-write" | "tag-exists" | "invalid-tag-name" | "import-failed";

export class FlowError extends Error {
  constructor(public code: FlowErrorCode, message: string, public detail?: unknown) {
    super(message);
    this.name = "FlowError";
  }
}

/**
 * Marks the repository with the Qommit topic so that it is listed for "Connect to existing repository".
 * Best effort: setting topics needs the admin role on the repository, and its absence must not fail the action.
 */
export async function markRepository(github: GitHubPort, repo: string): Promise<void> {
  try {
    await github.markRepo(repo);
  } catch {
    // The repository stays usable; it is only missing from the filtered list.
  }
}

export function cacheKey(info: AppInfo): string {
  return info.url;
}

/** Stores the link in the app object; when that fails, in the local cache. */
export async function saveLink(ports: FlowPorts, link: LinkData): Promise<"app" | "local"> {
  const key = cacheKey(await ports.app.info());
  const clearMarker = async (): Promise<void> => {
    try {
      await ports.cache.setUnlinked(key, false);
    } catch {
      // the marker only hides a link that exists again; failing to clear it must not fail the save
    }
  };
  try {
    await ports.app.writeLink(link);
  } catch {
    await ports.cache.set(key, link);
    await clearMarker();
    return "local";
  }
  await ports.cache.remove(key); // the app object is authoritative; drop a stale local copy
  await clearMarker();
  return "app";
}

export async function isAncestor(github: GitHubPort, repo: string, sha: string, head: string): Promise<boolean> {
  if (sha === head) return true;
  try {
    const { status } = await github.compare(repo, sha, head);
    return status === "ahead" || status === "identical";
  } catch (e) {
    if (e instanceof GatewayError && e.kind === "not-found") return false;
    throw e;
  }
}

/**
 * True when both commits have the same blob for every path the tool maintains; README.md and the
 * unmaintained files do not count. An unknown commit counts as different.
 */
export async function sameMaintainedTree(github: GitHubPort, repo: string, shaA: string, shaB: string): Promise<boolean> {
  if (shaA === shaB) return true;
  let a: Map<string, string>, b: Map<string, string>;
  try {
    [a, b] = await Promise.all([github.getTree(repo, shaA), github.getTree(repo, shaB)]);
  } catch (e) {
    if (e instanceof GatewayError && e.kind === "not-found") return false;
    throw e;
  }
  const maintained = (tree: Map<string, string>) => [...tree].filter(([path]) => groupOf(path) !== null);
  const left = maintained(a);
  const right = maintained(b);
  return left.length === right.length && left.every(([path, sha]) => b.get(path) === sha);
}
