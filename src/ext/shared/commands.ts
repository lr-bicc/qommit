import type { CommitInfo, TagInfo } from "../../github/repo";
import type { DiffSide } from "../flows/diff";
import type { AppInfo, JournalEntry } from "../flows/ports";
import type { AppStatus } from "../flows/status";
import type { UpdatePart } from "../flows/update";

/**
 * Commands the side panel sends to the content script. The commands that change something name the app
 * the panel shows (`appId`); the content script refuses them when its tab shows another app.
 */
export type Command =
  | { cmd: "ping" } | { cmd: "status" } | { cmd: "localChanges" } | { cmd: "listRepos" }
  | { cmd: "listBranches"; repo: string }
  | { cmd: "createRepository"; appId: string; name?: string }
  | { cmd: "connect"; appId: string; repo: string; mode: "new-branch" | "existing-branch"; branch: string }
  | { cmd: "createBranch"; appId: string; name: string; fromSource: boolean }
  | { cmd: "unlink"; appId: string }
  | { cmd: "commit"; appId: string; message: string; paths: string[]; removeUnmaintained: boolean; allowBehind: boolean }
  | { cmd: "history"; page: number }
  | { cmd: "commits"; repo: string; branch: string; page: number }
  | { cmd: "tags"; repo: string }
  | { cmd: "addTag"; repo: string; sha: string; name: string; message: string }
  | { cmd: "updatePreview"; appId: string; target: string; parts: UpdatePart[] }
  | { cmd: "update"; appId: string; target: string; parts: UpdatePart[] }
  | { cmd: "showDiff"; repo: string; before: DiffSide; after: DiffSide; select?: string; title: string }
  | { cmd: "closeDiff" }
  | { cmd: "importApp"; repo: string; sha: string; label: string };

/** Result types of the commands that answer with more than a status or null. */
export type CommitsResult = CommitInfo[];
export type TagsResult = TagInfo[];

export type StatusView = { page: "hub" } | { page: "app"; app: AppInfo; status: AppStatus; suggestedBranch: string; interruptedUpdate: JournalEntry | null };

export interface CommandError { code: string; message: string; detail?: unknown; ssoUrl?: string; resetAt?: number }
export type CommandResult = { ok: true; value: unknown } | { ok: false; error: CommandError };

/** Sent by the content script to the panel while a command runs. */
export interface ProgressEvent { event: "progress"; text: string }
