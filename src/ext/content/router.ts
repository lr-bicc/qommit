import type { QlikLocation } from "../../qlik/location";
import { parseQlikUrl } from "../../qlik/location";
import { QlikReadError } from "../../qlik/reader";
import { QlikSessionError, type EngineSession } from "../../qlik/session";
import { QlikTimeoutError } from "../../qlik/timeout";
import { commitChanges } from "../flows/commit";
import { openDiff, type DiffSource } from "../flows/diff";
import { importApp } from "../flows/import";
import { computeLocalChanges } from "../flows/local-changes";
import { FlowError, type AppPort, type FlowPorts, type LinkCache, type ServerPort, type UpdateJournal } from "../flows/ports";
import { connectRepository, createBranchForCopy, createRepository, suggestBranchName, unlinkApp } from "../flows/setup";
import { resolveStatus, type AppStatus, type CopySource } from "../flows/status";
import { addTag } from "../flows/tags";
import { previewUpdate, runUpdate } from "../flows/update";
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
  journal: UpdateJournal;
  server(loc: QlikLocation): ServerPort;
  /** Shows the differences in the page; the panel stays as it is. */
  showDiff(source: DiffSource, opts: { select?: string; title: string }): void;
}

const PROGRESS_INTERVAL_MS = 250;

const messageOf = (e: unknown): string => {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
};

/** enigma.js rejects every pending and later call with this code once the socket is gone. */
const SOCKET_CLOSED_CODE = -1;

/** A timeout or a closed socket, also when wrapped (e.g. as a read error): the session is lost. */
function isSessionLoss(e: unknown): boolean {
  for (let cause = e, depth = 0; cause !== undefined && cause !== null && depth < 5; depth++) {
    if (cause instanceof QlikTimeoutError) return true;
    if (typeof cause === "object" && (cause as { code?: unknown }).code === SOCKET_CLOSED_CODE) return true;
    cause = typeof cause === "object" ? (cause as { cause?: unknown }).cause : undefined;
  }
  return false;
}

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
  if (e instanceof AppChangedError) return { code: "app-changed", message: e.message };
  if (isSessionLoss(e)) return { code: "qlik-session", message: messageOf(e) };
  if (e instanceof QlikReadError) return { code: "qlik-read", message: e.message };
  if (e instanceof QlikSessionError) return { code: "qlik-session", message: e.message };
  return { code: "internal", message: messageOf(e) };
}

/** The current tab shows no Qlik app. */
class NoAppError extends Error {}

/** A command names another app than the one the tab shows now. */
class AppChangedError extends Error {}

const notLinked = (what: string): FlowError => new FlowError("not-linked", `${what} needs an app that is linked to a repository`);

/** Ports for commands that compare commits only: the app side is never touched. */
function noAppPorts(deps: RouterDeps, options: Options): FlowPorts {
  const refuse = (): never => { throw new NoAppError("Open a Qlik Sense app to use this command"); };
  const app: AppPort = { info: refuse, read: refuse, readLink: refuse, writeLink: refuse, removeLink: refuse, apply: refuse, save: refuse, readGitoqlokMeta: refuse };
  return { app, github: deps.github, cache: deps.cache, repoPrefix: options.repoPrefix, now: deps.now };
}

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

  /** Forgets the session at once; closing may never settle on a dead socket, so it runs in the background. */
  function dropSession(): void {
    const old = session;
    session = null;
    if (!old) return;
    void Promise.resolve().then(() => old.close()).catch(() => {});
  }

  async function sessionFor(loc: QlikLocation & { appId: string }): Promise<EngineSession> {
    if (session && session.appId === loc.appId && !session.isClosed()) return session;
    dropSession();
    session = await deps.openSession(loc);
    return session;
  }

  async function execute(command: Command): Promise<unknown> {
    if (command.cmd === "ping") return "pong";
    const loc = parseQlikUrl(deps.currentUrl());
    const appLoc = loc && loc.appId !== null ? { ...loc, appId: loc.appId } : null;
    const needApp = (): QlikLocation & { appId: string } => {
      if (!appLoc) throw new NoAppError("Open a Qlik Sense app to use this command");
      return appLoc;
    };
    if (command.cmd === "status" && !appLoc) return { page: "hub" } satisfies StatusView;
    if ("appId" in command && command.appId.toLowerCase() !== needApp().appId.toLowerCase()) {
      throw new AppChangedError("The tab now shows another app");
    }

    // These commands only talk to GitHub (or the Qlik server) and work on the hub, too.
    switch (command.cmd) {
      case "listRepos": return deps.github.listOrgRepos();
      case "listBranches": {
        const repo = await deps.github.getRepo(command.repo);
        if (!repo) throw new FlowError("repo-not-found", `Repository ${command.repo} was not found`);
        const branches = await deps.github.listBranches(command.repo);
        return { defaultBranch: repo.defaultBranch, branches: branches.map((b) => b.name) };
      }
      case "commits": return deps.github.listCommits(command.repo, command.branch, command.page);
      case "tags": return deps.github.listTags(command.repo);
      case "addTag": {
        await addTag(deps.github, command);
        return null;
      }
      case "importApp": {
        if (!loc) throw new NoAppError("Open Qlik Sense to use this command");
        const server = deps.server({ origin: loc.origin, prefix: loc.prefix, appId: null });
        return importApp({ github: deps.github, server }, command, (text) => emit({ event: "progress", text }));
      }
      case "showDiff":
        if (command.before.kind === "commit" && command.after.kind === "commit") {
          const source = await openDiff(noAppPorts(deps, await deps.loadOptions()), command.repo, command.before, command.after);
          deps.showDiff(source, { select: command.select, title: command.title });
          return null;
        }
        break;
    }

    const appLocation = needApp();
    const appId = appLocation.appId;
    const options = await deps.loadOptions();
    const live = createAppPort(await sessionFor(appLocation), appLocation, deps.fetch);
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

    // Fresh status: the link may have changed elsewhere (same app open in another tab).
    const freshLinked = async (): Promise<AppStatus & { state: "linked" }> => {
      const status = await freshStatus();
      if (status.state !== "linked") throw notLinked(command.cmd);
      return status;
    };

    // Mutating commands are multi-step: whatever fails, the app or GitHub may have changed already.
    let forget = false;
    try {
    switch (command.cmd) {
      case "status": {
        const status = await freshStatus();
        const info = await app.info();
        const interruptedUpdate = await deps.journal.get(info.id);
        return { page: "app", app: info, status, suggestedBranch: suggestBranchName(info.user), interruptedUpdate } satisfies StatusView;
      }
      case "localChanges": {
        const status = await currentStatus();
        if (status.state === "linked") return computeLocalChanges(ports, { repo: status.link.repo, baseSha: status.link.syncedSha });
        if (status.state === "published" && status.syncedSha) return computeLocalChanges(ports, { repo: status.repo, baseSha: status.syncedSha });
        throw notLinked(command.cmd);
      }
      case "createRepository": {
        forget = true;
        return createRepository(ports, { name: command.name });
      }
      case "connect": {
        forget = true;
        return connectRepository(ports, { repo: command.repo, mode: command.mode, branch: command.branch });
      }
      case "createBranch": {
        const status = await currentStatus();
        let source: CopySource;
        if (status.state === "duplicated") source = status.source;
        else if (status.state === "branch-missing") source = { repo: status.link.repo, branch: null, syncedSha: status.link.syncedSha || null };
        else throw notLinked(command.cmd);
        forget = true;
        return createBranchForCopy(ports, { source, name: command.name, fromSource: command.fromSource });
      }
      case "unlink": {
        forget = true;
        await unlinkApp(ports);
        return null;
      }
      case "commit": {
        const { link } = await freshLinked();
        forget = true;
        const result = await commitChanges(ports, {
          link, message: command.message, paths: command.paths,
          removeUnmaintained: command.removeUnmaintained, allowBehind: command.allowBehind,
        });
        if ("behind" in result) forget = false; // nothing was written
        return result;
      }
      case "history": {
        const { link } = await linkedStatus();
        const repo = await deps.github.getRepo(link.repo);
        if (!repo) throw new FlowError("repo-not-found", `Repository ${link.repo} was not found`);
        const commits = await deps.github.listCommits(link.repo, link.branch, command.page);
        return { commits, defaultBranch: repo.defaultBranch };
      }
      case "updatePreview": {
        const { link } = await freshLinked();
        return previewUpdate(ports, { link, target: command.target, parts: command.parts });
      }
      case "update": {
        const { link } = await freshLinked();
        forget = true;
        return runUpdate(ports, deps.journal, { link, target: command.target, parts: command.parts }, (text) => emit({ event: "progress", text }));
      }
      case "showDiff": {
        const source = await openDiff(ports, command.repo, command.before, command.after);
        deps.showDiff(source, { select: command.select, title: command.title });
        return null;
      }
      default:
        throw new Error(`Unknown command: ${String((command as { cmd?: unknown }).cmd)}`);
    }
    } finally {
      if (forget) statuses.delete(appId);
    }
  }

  async function runOne(command: Command): Promise<CommandResult> {
    try {
      return { ok: true, value: await execute(command) };
    } catch (e) {
      const error = toCommandError(e);
      if (error.code === "qlik-read" || error.code === "qlik-session") dropSession();
      console.warn("[qommit]", command.cmd, error.code, error.message);
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
