import type { QlikLocation } from "../../qlik/location";
import { parseQlikUrl } from "../../qlik/location";
import { QlikReadError } from "../../qlik/reader";
import { QlikSessionError, type EngineSession } from "../../qlik/session";
import { commitChanges } from "../flows/commit";
import { computeLocalChanges } from "../flows/local-changes";
import { FlowError, type AppPort, type FlowPorts, type LinkCache } from "../flows/ports";
import { connectRepository, createBranchForCopy, createRepository, suggestBranchName, unlinkApp } from "../flows/setup";
import { resolveStatus, type AppStatus, type CopySource } from "../flows/status";
import type { Command, CommandError, CommandResult, ProgressEvent, StatusView } from "../shared/commands";
import { GatewayError, type GitHubPort } from "../shared/github-port";
import type { Options } from "../shared/options";
import { createAppPort } from "./app-port";

export interface RouterDeps {
  currentUrl(): string;
  openSession(loc: QlikLocation & { appId: string }): Promise<EngineSession>;
  github: GitHubPort;
  cache: LinkCache;
  loadOptions(): Promise<Options>;
  fetch: typeof fetch;
  now(): Date;
  emit(event: ProgressEvent): void;
}

const PROGRESS_INTERVAL_MS = 250;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function toCommandError(e: unknown): CommandError {
  if (e instanceof GatewayError) {
    const error: CommandError = { code: e.kind, message: e.message };
    if (e.extra?.ssoUrl !== undefined) error.ssoUrl = e.extra.ssoUrl;
    if (e.extra?.resetAt !== undefined) error.resetAt = e.extra.resetAt;
    return error;
  }
  if (e instanceof FlowError) {
    const error: CommandError = { code: e.code, message: e.message };
    if (e.detail !== undefined) error.detail = e.detail;
    return error;
  }
  if (e instanceof NoAppError) return { code: "no-app", message: e.message };
  if (e instanceof QlikReadError) return { code: "qlik-read", message: e.message };
  if (e instanceof QlikSessionError) return { code: "qlik-session", message: e.message };
  return { code: "internal", message: messageOf(e) };
}

/** The current tab shows no Qlik app. */
class NoAppError extends Error {}

const notLinked = (what: string): FlowError => new FlowError("not-linked", `${what} needs an app that is linked to a repository`);

/** Runs panel commands one after another against the app of the current tab. Never throws; errors become results. */
export function createRouter(deps: RouterDeps): (command: Command) => Promise<CommandResult> {
  let session: EngineSession | null = null;
  const statuses = new Map<string, AppStatus>();
  let tail: Promise<unknown> = Promise.resolve();

  const emit = (event: ProgressEvent): void => {
    try {
      const result: unknown = deps.emit(event);
      if (result instanceof Promise) result.catch(() => {});
    } catch {
      // a missing or failing listener must not fail the command
    }
  };

  async function dropSession(): Promise<void> {
    const old = session;
    session = null;
    if (!old) return;
    try {
      await old.close();
    } catch {
      // closing an old session is best effort
    }
  }

  async function sessionFor(loc: QlikLocation & { appId: string }): Promise<EngineSession> {
    if (session && session.appId === loc.appId && !session.isClosed()) return session;
    await dropSession();
    session = await deps.openSession(loc);
    return session;
  }

  async function execute(command: Command): Promise<unknown> {
    if (command.cmd === "ping") return "pong";
    const loc = parseQlikUrl(deps.currentUrl());
    if (!loc || loc.appId === null) {
      if (command.cmd === "status") return { page: "hub" } satisfies StatusView;
      throw new NoAppError("Open a Qlik Sense app to use this command");
    }
    const appLoc = { ...loc, appId: loc.appId };
    const appId = appLoc.appId;

    if (command.cmd === "listRepos") return deps.github.listOrgRepos();
    if (command.cmd === "listBranches") {
      const repo = await deps.github.getRepo(command.repo);
      if (!repo) throw new FlowError("repo-not-found", `Repository ${command.repo} was not found`);
      const branches = await deps.github.listBranches(command.repo);
      return { defaultBranch: repo.defaultBranch, branches: branches.map((b) => b.name) };
    }

    const options = await deps.loadOptions();
    const live = createAppPort(await sessionFor(appLoc), appLoc, deps.fetch);
    let lastProgress = Number.NEGATIVE_INFINITY;
    const onProgress = (done: number, total: number): void => {
      const at = deps.now().getTime();
      if (done !== total && at - lastProgress < PROGRESS_INTERVAL_MS) return;
      lastProgress = at;
      emit({ event: "progress", text: `Loading application data… ${done}/${total}` });
    };
    const app: AppPort = { ...live, read: (opts) => live.read({ ...opts, onProgress: (d, t) => { onProgress(d, t); opts.onProgress?.(d, t); } }) };
    const ports: FlowPorts = { app, github: deps.github, cache: deps.cache, repoPrefix: options.repoPrefix, now: deps.now };

    const freshStatus = async (): Promise<AppStatus> => {
      const status = await resolveStatus(ports);
      statuses.set(appId, status);
      return status;
    };
    const currentStatus = async (): Promise<AppStatus> => statuses.get(appId) ?? freshStatus();
    const linkedStatus = async (): Promise<AppStatus & { state: "linked" }> => {
      const status = await currentStatus();
      if (status.state !== "linked") throw notLinked(command.cmd);
      return status;
    };

    switch (command.cmd) {
      case "status": {
        const status = await freshStatus();
        const info = await app.info();
        return { page: "app", app: info, status, suggestedBranch: suggestBranchName(info.user) } satisfies StatusView;
      }
      case "localChanges": {
        const status = await currentStatus();
        if (status.state === "linked") return computeLocalChanges(ports, { repo: status.link.repo, baseSha: status.link.syncedSha });
        if (status.state === "published" && status.syncedSha) return computeLocalChanges(ports, { repo: status.repo, baseSha: status.syncedSha });
        throw notLinked(command.cmd);
      }
      case "createRepository": {
        const link = await createRepository(ports, { name: command.name });
        statuses.delete(appId);
        return link;
      }
      case "connect": {
        const link = await connectRepository(ports, { repo: command.repo, mode: command.mode, branch: command.branch });
        statuses.delete(appId);
        return link;
      }
      case "createBranch": {
        const status = await currentStatus();
        let source: CopySource;
        if (status.state === "duplicated") source = status.source;
        else if (status.state === "branch-missing") source = { repo: status.link.repo, branch: null, syncedSha: status.link.syncedSha || null };
        else throw notLinked(command.cmd);
        const link = await createBranchForCopy(ports, { source, name: command.name, fromSource: command.fromSource });
        statuses.delete(appId);
        return link;
      }
      case "unlink": {
        await unlinkApp(ports);
        statuses.delete(appId);
        return null;
      }
      case "commit": {
        const { link } = await linkedStatus();
        const result = await commitChanges(ports, {
          link, message: command.message, paths: command.paths,
          removeUnmaintained: command.removeUnmaintained, allowBehind: command.allowBehind,
        });
        if ("sha" in result) statuses.delete(appId);
        return result;
      }
      case "history": {
        const { link } = await linkedStatus();
        const repo = await deps.github.getRepo(link.repo);
        if (!repo) throw new FlowError("repo-not-found", `Repository ${link.repo} was not found`);
        const commits = await deps.github.listCommits(link.repo, link.branch, command.page);
        return { commits, defaultBranch: repo.defaultBranch };
      }
      default:
        throw new Error(`Unknown command: ${String((command as { cmd?: unknown }).cmd)}`);
    }
  }

  async function runOne(command: Command): Promise<CommandResult> {
    try {
      return { ok: true, value: await execute(command) };
    } catch (e) {
      const error = toCommandError(e);
      if (error.code === "qlik-read" || error.code === "qlik-session") await dropSession();
      return { ok: false, error };
    } finally {
      emit({ event: "progress", text: "Ready" });
    }
  }

  return (command) => {
    const result = tail.then(() => runOne(command));
    tail = result;
    return result;
  };
}
