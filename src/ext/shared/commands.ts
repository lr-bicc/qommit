import type { AppInfo } from "../flows/ports";
import type { AppStatus } from "../flows/status";

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
  | { cmd: "history"; page: number };

export type StatusView = { page: "hub" } | { page: "app"; app: AppInfo; status: AppStatus; suggestedBranch: string };

export interface CommandError { code: string; message: string; detail?: unknown; ssoUrl?: string; resetAt?: number }
export type CommandResult = { ok: true; value: unknown } | { ok: false; error: CommandError };

/** Sent by the content script to the panel while a command runs. */
export interface ProgressEvent { event: "progress"; text: string }
