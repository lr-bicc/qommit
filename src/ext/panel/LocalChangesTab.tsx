import type { JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { CommitInfo } from "../../github/repo";
import type { LocalChanges } from "../flows/local-changes";
import type { CommitResult } from "../flows/commit";
import type { Command, CommandError } from "../shared/commands";
import type { Bridge } from "./bridge";
import { initialSelection, PARTS, pathsToggledWith, sections, togglePaths, triState, type ChangeGroup, type Tri } from "./changes-model";
import { toCommandError } from "./CreateBranchDialog";
import { CommitPicker } from "./CommitPicker";
import { Dialog } from "./Dialog";
import { ErrorMessage } from "./ErrorMessage";
import { errorText } from "./errors";
import { UpdateDialog } from "./UpdateDialog";
import type { UpdatePart } from "../flows/update";

const COLLAPSE_ABOVE = 20;

const UPDATE_PARTS: { part: UpdatePart; label: string }[] = [
  { part: "script", label: "Load script" },
  { part: "objects", label: "App Objects" },
  { part: "files", label: "Attached files" },
];
interface Target { sha: string; label: string; isHead: boolean }

type CommitCommand = Extract<Command, { cmd: "commit" }>;
type Failure = { source: "load" | "commit"; error: CommandError };

/** A checkbox with the three states of a selection; a click selects everything unless everything is selected. */
function TriCheckbox(props: { state: Tri; label?: string; ariaLabel?: string; disabled?: boolean; onToggle(on: boolean): void }): JSX.Element {
  const box = (
    <input
      type="checkbox"
      aria-label={props.ariaLabel}
      checked={props.state === "all"}
      disabled={props.disabled}
      ref={(el: HTMLInputElement | null) => { if (el) el.indeterminate = props.state === "some"; }}
      onChange={() => props.onToggle(props.state !== "all")}
    />
  );
  return props.label === undefined ? box : <label class="check">{box}<span>{props.label}</span></label>;
}

/** An error inside a dialog: the text and the action that fits it, but no Retry (the dialog's own buttons repeat). */
function DialogError(props: { error: CommandError; onOptions(): void }): JSX.Element {
  const { text, action } = errorText(props.error);
  return (
    <div class="error" role="alert">
      <p>{text}</p>
      {action === "options" && <button type="button" onClick={props.onOptions}>Open options</button>}
      {action === "sso" && props.error.ssoUrl !== undefined && <a class="button" href={props.error.ssoUrl} target="_blank" rel="noreferrer">Authorize</a>}
    </div>
  );
}

interface TabProps {
  bridge: Bridge;
  appId: string;
  readOnly: boolean;
  onSaved(): void;
  reloadToken?: number;
  repo?: string; // for the "details" links
  /** Updating from the repository: only for linked apps the user may write to. */
  update?: { repo: string; branch: string; headSha: string; behindBy: number; onUpdated(): void; interruptedUpdate: boolean };
  /** The panel's command runner and busy tracking, so an update started here is counted like every other command. */
  panel: { run<T>(command: Command): Promise<T>; isBusy(): boolean; busy: boolean };
}

export function LocalChangesTab(props: TabProps): JSX.Element {
  const { bridge, readOnly, reloadToken, update, repo } = props;
  const [data, setData] = useState<LocalChanges | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [removeUnmaintained, setRemoveUnmaintained] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [behind, setBehind] = useState<CommitInfo[] | null>(null);
  const [behindError, setBehindError] = useState<CommandError | null>(null); // a failed "Commit anyway", shown in the dialog
  const [expanded, setExpanded] = useState<Map<string, boolean>>(new Map());
  const [target, setTarget] = useState<Target | null>(null); // the commit chosen in the picker
  const [parts, setParts] = useState<Set<UpdatePart>>(new Set(UPDATE_PARTS.map((p) => p.part)));
  const [partsOpen, setPartsOpen] = useState(false);
  const [updating, setUpdating] = useState<{ sha: string; label: string; parts: UpdatePart[]; first: boolean } | null>(null); // the open update dialog
  const alive = useRef(true);
  const request = useRef(0); // answers of older loads are dropped
  const inflight = useRef(false); // a commit is on its way; unlike `saving` it is current before the next render
  const known = useRef<Set<string>>(new Set()); // paths of the list that is shown

  useEffect(() => () => { alive.current = false; }, []);

  /** Loads the list; the answer, or null when it failed or a newer load replaced it. */
  const load = useCallback(async (): Promise<LocalChanges | null> => {
    const mine = ++request.current;
    setLoading(true);
    setFailure((f) => (f?.source === "load" ? null : f));
    try {
      const next = await bridge.send<LocalChanges>({ cmd: "localChanges" });
      if (!alive.current || mine !== request.current) return null;
      const paths = new Set(next.items.map((i) => i.path));
      // A list that changed under an open selection: drop vanished paths, select new ones like at the start.
      setSelection((old) => new Set([...paths].filter((p) => old.has(p) || !known.current.has(p))));
      known.current = paths;
      setData(next);
      return next;
    } catch (e) {
      if (!alive.current || mine !== request.current) return null;
      known.current = new Set();
      setData(null);
      setCommitting(false);
      setFailure({ source: "load", error: toCommandError(e) });
      return null;
    } finally {
      if (alive.current && mine === request.current) setLoading(false);
    }
  }, [bridge]);

  useEffect(() => { void load(); }, [load, reloadToken]);

  const items = data?.items ?? [];
  const unmaintained = data?.unmaintained ?? [];
  const removing = removeUnmaintained && unmaintained.length > 0;
  const busy = loading || saving;
  const canSave = !busy && !saved && message.trim() !== "" && (selection.size > 0 || removing);

  /** The app may have changed since the list was loaded: the commit mode starts from what the app holds now. */
  async function startCommit(): Promise<void> {
    const fresh = await load();
    if (!alive.current || fresh === null) return;
    if (fresh.items.length === 0 && fresh.unmaintained.length === 0) return; // the list shows "No local changes"
    setSelection(initialSelection(fresh.items));
    setMessage("");
    setRemoveUnmaintained(true);
    setFailure(null);
    setCommitting(true);
  }

  const dialogProps = {
    run: props.panel.run,
    appId: props.appId,
    busy: props.panel.busy,
    isBusy: props.panel.isBusy,
    onOptions: () => bridge.openOptions(),
  };

  /** The update dialog finished: the panel loads status and list again; an "Update first" ends the commit. */
  function updated(): void {
    const first = updating?.first === true;
    setUpdating(null);
    if (first) leaveCommit();
    update?.onUpdated();
  }

  const showDiff = (path: string): void => {
    if (data === null || repo === undefined) return;
    void bridge.send({ cmd: "showDiff", repo, before: { kind: "commit", sha: data.baseSha }, after: { kind: "app" }, select: path, title: "Local changes" }).catch(() => undefined);
  };

  function leaveCommit(): void {
    setCommitting(false);
    setSaved(false);
    setBehind(null);
    setBehindError(null);
    setMessage("");
  }

  /** Sends the commit; one at a time. */
  async function submit(command: CommitCommand): Promise<void> {
    if (inflight.current) return;
    inflight.current = true;
    setSaving(true);
    setFailure(null);
    setBehindError(null);
    let result: CommitResult;
    try {
      result = await bridge.send<CommitResult>(command);
    } catch (e) {
      inflight.current = false;
      if (!alive.current) return;
      setSaving(false);
      // Inside the behind dialog the error is shown there; the dialog stays open.
      if (command.allowBehind) setBehindError(toCommandError(e));
      else setFailure({ source: "commit", error: toCommandError(e) });
      return;
    }
    inflight.current = false;
    if (!alive.current) return;
    setSaving(false);
    if ("behind" in result) {
      setBehind(result.behind);
      return;
    }
    setBehind(null);
    setSaved(true);
    props.onSaved();
    await load();
    if (alive.current) leaveCommit();
  }

  const commitCommand = (allowBehind: boolean): CommitCommand => ({
    cmd: "commit",
    appId: props.appId,
    message: message.trim(),
    paths: items.filter((i) => selection.has(i.path)).map((i) => i.path),
    removeUnmaintained: removing,
    allowBehind,
  });

  const isOpen = (key: string, group: ChangeGroup): boolean => expanded.get(key) ?? group.items.length <= COLLAPSE_ABOVE;
  const toggleOpen = (key: string, group: ChangeGroup): void =>
    setExpanded((old) => new Map(old).set(key, !isOpen(key, group)));

  const list = sections(items);

  const retry = (): void => {
    if (failure?.source === "commit") {
      void submit(commitCommand(false)); // what the form shows now; the behind check runs again
    } else {
      void load();
    }
  };

  return (
    <section class="changes">
      {failure && <ErrorMessage error={failure.error} onOptions={() => bridge.openOptions()} onRetry={retry} disabled={busy} />}
      {data === null && failure === null && <p class="muted">Loading…</p>}
      {update && !readOnly && !committing && (
        <div class="update">
          <CommitPicker key={reloadToken} bridge={bridge} repo={update.repo} branch={update.branch} value={target?.sha ?? ""} disabled={busy}
            onChange={(sha, label, isHead) => setTarget({ sha, label, isHead: isHead === true })} />
          <div class="buttons">
            <button type="button" class="primary" disabled={busy || target === null || parts.size === 0}
              onClick={() => target && setUpdating({ ...target, parts: UPDATE_PARTS.filter((p) => parts.has(p.part)).map((p) => p.part), first: false })}>
              {update.behindBy > 0 && target?.isHead === true ? `Update (${update.behindBy})` : "Update"}
            </button>
            <button type="button" aria-label="Choose what to update" aria-expanded={partsOpen} onClick={() => setPartsOpen(!partsOpen)}>▾</button>
          </div>
          {partsOpen && (
            <fieldset>
              {UPDATE_PARTS.map(({ part, label }) => (
                <label class="check" key={part}>
                  <input type="checkbox" checked={parts.has(part)} onChange={(e) => {
                    const on = e.currentTarget.checked;
                    setParts((old) => { const next = new Set(old); if (on) next.add(part); else next.delete(part); return next; });
                  }} />
                  <span>{label}</span>
                </label>
              ))}
            </fieldset>
          )}
        </div>
      )}
      {data !== null && !committing && (
        <>
          {!readOnly && (
            <div class="buttons">
              <button type="button" class="primary" disabled={busy} onClick={() => void startCommit()}>Save changes</button>
            </div>
          )}
          {items.length === 0 && <p class="muted">No local changes</p>}
        </>
      )}
      {data !== null && committing && (
        <div class="commit">
          <h2>Choose what to save</h2>
          <fieldset>
            {PARTS.filter(({ part }) => items.some((i) => i.part === part)).map(({ part, label }) => {
              const paths = items.filter((i) => i.part === part).map((i) => i.path);
              return <TriCheckbox key={part} label={label} state={triState(selection, paths)} disabled={busy || saved} onToggle={(on) => setSelection((s) => togglePaths(s, paths, on))} />;
            })}
          </fieldset>
        </div>
      )}
      {data !== null && list.map((section) => (
        <div class="section" key={section.key}>
          <h3>{section.label}</h3>
          {section.groups.map((group) => {
            const key = `${section.key}:${group.label}`;
            const open = isOpen(key, group);
            const paths = group.items.map((i) => i.path);
            return (
              <div class="group" key={key}>
                <div class="group-header">
                  {committing && (
                    <TriCheckbox ariaLabel={`Select all ${group.label}`} state={triState(selection, paths)} disabled={busy || saved} onToggle={(on) => setSelection((s) => togglePaths(s, paths, on))} />
                  )}
                  <button type="button" class="group-toggle" aria-expanded={open} onClick={() => toggleOpen(key, group)}>
                    <span aria-hidden="true">{open ? "▾" : "▸"}</span> <span>{`${group.label} (${group.items.length})`}</span>
                  </button>
                </div>
                {committing && group.label === "Script" && <p class="hint">The load script is saved as a whole.</p>}
                {open && (
                  <ul class="entries">
                    {group.items.map((item) => (
                      <li key={item.path} title={item.path}>
                        {committing
                          ? <TriCheckbox label={item.title} state={selection.has(item.path) ? "all" : "none"} disabled={busy || saved} onToggle={(on) => setSelection((s) => togglePaths(s, pathsToggledWith(items, item), on))} />
                          : item.title}
                        {repo !== undefined && <>{" "}<button type="button" class="link" onClick={() => showDiff(item.path)}>details</button></>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {data !== null && committing && (
        <div class="commit">
          {unmaintained.length > 0 && (
            <label class="check">
              <input type="checkbox" checked={removeUnmaintained} disabled={busy || saved} onChange={(e) => setRemoveUnmaintained(e.currentTarget.checked)} />
              <span>{`Remove files no longer maintained (${unmaintained.length})`}</span>
            </label>
          )}
          <textarea
            class="commit-message"
            rows={3}
            placeholder="Commit message"
            aria-label="Commit message"
            value={message}
            disabled={busy || saved}
            onInput={(e) => setMessage(e.currentTarget.value)}
            onChange={(e) => setMessage(e.currentTarget.value)}
          />
          <div class="buttons">
            <button type="button" class="primary" disabled={!canSave} onClick={() => void submit(commitCommand(false))}>{saved ? "Success" : "Save"}</button>
            <button type="button" disabled={busy || saved} onClick={() => { leaveCommit(); setFailure(null); }}>Back</button>
          </div>
        </div>
      )}
      {updating !== null && update && (
        <UpdateDialog {...dialogProps} interruptedUpdate={update.interruptedUpdate} repo={update.repo} target={updating} parts={updating.parts} onCancel={() => setUpdating(null)} onDone={updated} onUpdated={updated} />
      )}
      {behind !== null && committing && updating === null && (
        <Dialog title="The branch has moved on">
          <p>{`The branch has ${behind.length} new ${behind.length === 1 ? "commit" : "commits"} that this save would overwrite:`}</p>
          <ul class="commits">
            {behind.map((c) => <li key={c.sha}>{c.message.split("\n")[0]}</li>)}
          </ul>
          {behindError && <DialogError error={behindError} onOptions={() => bridge.openOptions()} />}
          <div class="buttons">
            {update && (
              <button type="button" class="primary" disabled={saving} onClick={() => setUpdating({ sha: update.headSha, label: update.headSha.slice(0, 7), parts: UPDATE_PARTS.map((p) => p.part), first: true })}>Update first</button>
            )}
            <button type="button" disabled={saving} onClick={() => void submit(commitCommand(true))}>Commit anyway</button>
            <button type="button" disabled={saving} onClick={() => { setBehind(null); setBehindError(null); }}>Cancel</button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
