import type { AppInfo } from "../flows/ports";
import type { AppStatus } from "../flows/status";

/** Commands the side panel sends to the content script. */
export type Command =
  | { cmd: "ping" } | { cmd: "status" } | { cmd: "localChanges" } | { cmd: "listRepos" }
  | { cmd: "listBranches"; repo: string }
  | { cmd: "createRepository"; name?: string }
  | { cmd: "connect"; repo: string; mode: "new-branch" | "existing-branch"; branch: string }
  | { cmd: "createBranch"; name: string; fromSource: boolean }
  | { cmd: "unlink" }
  | { cmd: "commit"; message: string; paths: string[]; removeUnmaintained: boolean; allowBehind: boolean }
  | { cmd: "history"; page: number };

export type StatusView = { page: "hub" } | { page: "app"; app: AppInfo; status: AppStatus; suggestedBranch: string };

export interface CommandError { code: string; message: string; detail?: unknown; ssoUrl?: string; resetAt?: number }
export type CommandResult = { ok: true; value: unknown } | { ok: false; error: CommandError };

/** Sent by the content script to the panel while a command runs. */
export interface ProgressEvent { event: "progress"; text: string }
