import type { AppSnapshot } from "../../core/types";
import type { LinkData } from "../../qlik/link";
import type { GitHubPort } from "../shared/github-port";
import { GatewayError } from "../shared/github-port";

export interface AppInfo { id: string; title: string; published: boolean; url: string; user: string }

export interface AppPort {
  info(): Promise<AppInfo>;
  read(opts: { includeFiles: boolean; onProgress?: (done: number, total: number) => void }): Promise<AppSnapshot>;
  readLink(): Promise<LinkData | null>;
  writeLink(link: LinkData): Promise<void>;
  removeLink(): Promise<void>;
  readGitoqlokMeta(): Promise<{ repo: string | null; lastCommitId: string | null } | null>;
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
  | "repo-not-found" | "nothing-to-commit" | "message-required";

export class FlowError extends Error {
  constructor(public code: FlowErrorCode, message: string, public detail?: unknown) {
    super(message);
    this.name = "FlowError";
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
