import type { JSX } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { parseQlikUrl } from "../../qlik/location";
import type { Command, CommandError, StatusView } from "../shared/commands";
import type { AppStatus } from "../flows/status";
import { BridgeError, type Bridge } from "./bridge";
import { AddTagDialog } from "./AddTagDialog";
import { ConnectDialog } from "./ConnectDialog";
import { CreateBranchDialog, toCommandError } from "./CreateBranchDialog";
import { ErrorMessage } from "./ErrorMessage";
import { Header, UnlinkDialog } from "./Header";
import { ImportTab } from "./ImportTab";
import { HistoryTab } from "./HistoryTab";
import { LocalChangesTab } from "./LocalChangesTab";
import { SetupViews } from "./SetupViews";
import { TagsTab } from "./TagsTab";
import { UpdateDialog } from "./UpdateDialog";
import { watchTabServer } from "./tab-server";

type DialogKind = "connect" | "branch" | "unlink";

/** What a tab shows: the panel reloads when this changes, not on every sheet change. */
interface PageKey { kind: "hub" | "app" | "other"; appId: string | null }

function pageOfUrl(url: string): PageKey {
  const loc = parseQlikUrl(url);
  if (loc === null) return { kind: "other", appId: null };
  return loc.appId === null ? { kind: "hub", appId: null } : { kind: "app", appId: loc.appId.toLowerCase() };
}

/** The repository an app is (or was) linked to, for the header and the unlink question. */
function repoOf(status: AppStatus): { repo: string; branch: string | null } | null {
  switch (status.state) {
    case "linked":
    case "branch-missing": return { repo: status.link.repo, branch: status.link.branch };
    case "repo-missing": return { repo: status.repo, branch: null };
    case "published": return { repo: status.repo, branch: status.branch };
    default: return null;
  }
}

/** The panel of one tab: Qommit while the tab shows a configured Qlik server, the hint otherwise. */
export function PanelRoot(props: { tabId: number | null; createBridge: (tabId: number) => Bridge }): JSX.Element {
  const { tabId, createBridge } = props;
  const [onServer, setOnServer] = useState<boolean | null>(tabId === null ? false : null);
  useEffect(() => (tabId === null ? undefined : watchTabServer(tabId, setOnServer)), [tabId]);
  const bridge = useMemo(() => (onServer && tabId !== null ? createBridge(tabId) : null), [onServer, tabId, createBridge]);
  if (onServer === null) return <main class="panel" />; // still checking: no flash of the hint
  return <App bridge={bridge} />;
}

export function App(props: { bridge: Bridge | null }): JSX.Element {
  const { bridge } = props;
  if (bridge === null) {
    return (
      <main class="panel">
        <section class="view">
          <p>Qommit works on Qlik Sense servers that are listed in the options.</p>
          <button type="button" class="primary" onClick={() => void chrome.runtime.openOptionsPage()}>Open options</button>
        </section>
      </main>
    );
  }
  return <Panel bridge={bridge} />;
}

function Panel({ bridge: tabBridge }: { bridge: Bridge }): JSX.Element {
  const [view, setView] = useState<StatusView | null>(null);
  const [error, setError] = useState<CommandError | null>(null);
  const [loadFailed, setLoadFailed] = useState(false); // the last status load failed: hide the stale view
  const [running, setRunning] = useState(0);
  const [progress, setProgress] = useState("Ready");
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [tab, setTab] = useState<"changes" | "history" | "tags" | "import">("changes");
  const [tagging, setTagging] = useState<string | null>(null); // the commit an "Add tag" dialog is open for
  const [updating, setUpdating] = useState<{ sha: string; label: string } | null>(null); // target of an update from History or Tags
  const [reloadToken, setReloadToken] = useState(0); // a new value makes the open tab load its data again
  const alive = useRef(true);
  const inflight = useRef(0); // commands in flight; unlike `running` it is current before the next render
  const shown = useRef<PageKey | null>(null); // the page the shown status belongs to
  const reload = useRef<() => Promise<void>>(async () => undefined);
  const busy = running > 0;

  /** The tab's bridge, except that "app-changed" closes any dialog and reloads the status before it is reported. */
  const bridge = useMemo<Bridge>(() => ({
    ...tabBridge,
    async send<T>(command: Command): Promise<T> {
      try {
        return await tabBridge.send<T>(command);
      } catch (e) {
        if (e instanceof BridgeError && e.error.code === "app-changed" && alive.current) {
          setDialog(null);
          setTagging(null);
          setUpdating(null);
          await reload.current();
          if (alive.current) setError(e.error);
        }
        throw e;
      }
    },
  }), [tabBridge]);

  useEffect(() => bridge.onProgress(setProgress), [bridge]);
  useEffect(() => () => { alive.current = false; }, []);

  /** Sends a command; the buttons stay locked until it is answered. Rejects with BridgeError. */
  const run = useCallback(async <T,>(command: Command): Promise<T> => {
    inflight.current++;
    setRunning((n) => n + 1);
    try {
      return await bridge.send<T>(command);
    } finally {
      inflight.current--;
      if (alive.current) setRunning((n) => n - 1);
    }
  }, [bridge]);

  const load = useCallback(async (reloadTab = true): Promise<void> => {
    if (reloadTab) setReloadToken((n) => n + 1);
    try {
      const next = await run<StatusView>({ cmd: "status" });
      if (!alive.current) return;
      if (next.page === "app") shown.current = { kind: "app", appId: next.app.id.toLowerCase() };
      else if (shown.current?.kind !== "other") shown.current = { kind: "hub", appId: null };
      setView(next);
      setError(null);
      setLoadFailed(false);
    } catch (e) {
      if (!alive.current) return;
      setError(toCommandError(e));
      setLoadFailed(true); // the view below is stale: its own requests would only repeat the message
    }
  }, [run]);

  useEffect(() => { void load(); }, [load]);
  reload.current = load;

  // A new URL in the tab: reload when it shows another kind of page or another app.
  useEffect(() => bridge.onTabUrl((url) => {
    const next = pageOfUrl(url);
    const current = shown.current;
    if (current !== null && current.kind === next.kind && current.appId === next.appId) return;
    shown.current = next;
    setDialog(null);
    setTagging(null);
    setUpdating(null);
    void load();
  }), [bridge, load]);

  /** A command that changes the link: on success the status is loaded again. */
  async function mutate(command: Command, onError?: (error: CommandError) => boolean): Promise<void> {
    if (inflight.current > 0) return;
    setError(null);
    try {
      await run(command);
    } catch (e) {
      const failure = toCommandError(e);
      if (!onError?.(failure)) setError(failure);
      return;
    }
    setDialog(null);
    await load();
  }

  const app = view?.page === "app" ? view : null;
  const status = app?.status ?? null;
  const known = status ? repoOf(status) : null;
  const unlinkRepo = known?.repo ?? (status?.state === "duplicated" ? status.source.repo : null);
  const canUpdate = app !== null && status?.state === "linked" && app.app.canWrite && !app.app.published;
  const closeDialog = (): void => setDialog(null);
  const appId = app?.app.id ?? "";
  const dialogProps = { run, appId, busy, isBusy: () => inflight.current > 0, onOptions: () => bridge.openOptions(), onCancel: closeDialog, onDone: () => { setDialog(null); setTagging(null); setUpdating(null); void load(); } };

  let body: JSX.Element | null = null;
  if (view?.page === "hub") {
    body = (
      <section class="view">
        <p>Open an app to use Qommit.</p>
        <button type="button" disabled={busy} onClick={() => void load()}>Refresh</button>
        <ImportTab bridge={bridge} />
      </section>
    );
  } else if (app && status) {
    if (status.state === "linked") {
      body = (
        <>
          <div class="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "changes"} onClick={() => setTab("changes")}>Local Changes</button>
            <button type="button" role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>History</button>
            <button type="button" role="tab" aria-selected={tab === "tags"} onClick={() => setTab("tags")}>Tags</button>
            <button type="button" role="tab" aria-selected={tab === "import"} onClick={() => setTab("import")}>Import</button>
          </div>
          {tab === "changes"
            ? <LocalChangesTab key={appId} bridge={bridge} appId={appId} readOnly={false} repo={status.link.repo} onSaved={() => void load(false)} reloadToken={reloadToken}
              update={app.app.canWrite && !app.app.published ? { repo: status.link.repo, branch: status.link.branch, headSha: status.headSha, behindBy: status.behindBy, onUpdated: () => void load() } : undefined} />
            : tab === "history"
              ? <HistoryTab bridge={bridge} repo={status.link.repo} branch={status.link.branch} defaultBranch={status.defaultBranch} reloadToken={reloadToken}
                canUpdate={canUpdate} onAddTag={setTagging} onUpdate={setUpdating} />
              : tab === "tags"
                ? <TagsTab bridge={bridge} repo={status.link.repo} canUpdate={canUpdate} onUpdate={setUpdating} reloadToken={reloadToken} />
                : <ImportTab bridge={bridge} />}
        </>
      );
    } else {
      body = (
        <>
          <SetupViews
            status={status}
            appId={appId}
            published={app?.app.published ?? false}
            busy={busy}
            mutate={mutate}
            onConnect={() => setDialog("connect")}
            onCreateBranch={() => setDialog("branch")}
            onUnlink={() => setDialog("unlink")}
          />
          {status.state === "published" && status.syncedSha !== null && status.syncedSha !== "" && (
            <LocalChangesTab key={appId} bridge={bridge} appId={appId} readOnly={true} repo={status.repo} onSaved={() => void load(false)} reloadToken={reloadToken} />
          )}
        </>
      );
    }
  }

  return (
    <main class="panel">
      {app && (
        <Header
          title={app.app.title}
          repo={known?.repo}
          branch={known?.branch}
          behindBy={status?.state === "linked" ? status.behindBy : 0}
          canUnlink={!app?.app.published && (status?.state === "linked" || status?.state === "branch-missing" || status?.state === "repo-missing")}
          busy={busy}
          onUnlink={() => setDialog("unlink")}
          onRefresh={() => void load()}
        />
      )}
      {app?.interruptedUpdate && (
        <p class="notice">
          {`The last update did not finish (${app.interruptedUpdate.total} changes planned). Update again`}
          {app.interruptedUpdate.backupBranch !== null ? `, or restore your work from ${app.interruptedUpdate.backupBranch}.` : "."}
        </p>
      )}
      {view === null && error === null && <p class="muted">Loading…</p>}
      {error && <ErrorMessage error={error} onOptions={() => bridge.openOptions()} onRetry={() => void load()} disabled={busy} />}
      {!app && view === null && error !== null && (
        <button type="button" class="icon" title="Refresh" aria-label="Refresh" disabled={busy} onClick={() => void load()}>↻</button>
      )}
      {!loadFailed && <div class="content">{body}</div>}
      {dialog === "connect" && app && <ConnectDialog {...dialogProps} suggestedBranch={app.suggestedBranch} />}
      {dialog === "branch" && app && status && (status.state === "duplicated" || status.state === "branch-missing") && (
        <CreateBranchDialog
          {...dialogProps}
          suggestedBranch={app.suggestedBranch}
          sourceBranch={status.state === "duplicated" ? status.source.branch : null}
        />
      )}
      {dialog === "unlink" && unlinkRepo !== null && (
        <UnlinkDialog {...dialogProps} repo={unlinkRepo} />
      )}
      {tagging !== null && status?.state === "linked" && (
        <AddTagDialog {...dialogProps} repo={status.link.repo} sha={tagging} onCancel={() => setTagging(null)} />
      )}
      {updating !== null && canUpdate && status?.state === "linked" && (
        <UpdateDialog {...dialogProps} repo={status.link.repo} target={updating} parts={["script", "objects", "files"]} onCancel={() => setUpdating(null)} onUpdated={dialogProps.onDone} />
      )}
      <footer class="footer" aria-live="polite">{progress}</footer>
    </main>
  );
}
