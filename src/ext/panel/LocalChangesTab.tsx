import type { JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { CommitInfo } from "../../github/repo";
import type { LocalChanges } from "../flows/local-changes";
import type { CommitResult } from "../flows/commit";
import type { Command, CommandError } from "../shared/commands";
import type { Bridge } from "./bridge";
import { initialSelection, PARTS, pathsToggledWith, sections, togglePaths, triState, type ChangeGroup, type Tri } from "./changes-model";
import { toCommandError } from "./CreateBranchDialog";
import { Dialog } from "./Dialog";
import { ErrorMessage } from "./ErrorMessage";
import { errorText } from "./errors";

const COLLAPSE_ABOVE = 20;

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

export function LocalChangesTab(props: { bridge: Bridge; appId: string; readOnly: boolean; onSaved(): void; reloadToken?: number }): JSX.Element {
  const { bridge, readOnly, reloadToken } = props;
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
  const alive = useRef(true);
  const request = useRef(0); // answers of older loads are dropped
  const inflight = useRef(false); // a commit is on its way; unlike `saving` it is current before the next render
  const known = useRef<Set<string>>(new Set()); // paths of the list that is shown

  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async (): Promise<boolean> => {
    const mine = ++request.current;
    setLoading(true);
    setFailure((f) => (f?.source === "load" ? null : f));
    try {
      const next = await bridge.send<LocalChanges>({ cmd: "localChanges" });
      if (!alive.current || mine !== request.current) return false;
      const paths = new Set(next.items.map((i) => i.path));
      // A list that changed under an open selection: drop vanished paths, select new ones like at the start.
      setSelection((old) => new Set([...paths].filter((p) => old.has(p) || !known.current.has(p))));
      known.current = paths;
      setData(next);
      return true;
    } catch (e) {
      if (!alive.current || mine !== request.current) return false;
      known.current = new Set();
      setData(null);
      setCommitting(false);
      setFailure({ source: "load", error: toCommandError(e) });
      return false;
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

  function startCommit(): void {
    setSelection(initialSelection(items));
    setMessage("");
    setRemoveUnmaintained(true);
    setFailure(null);
    setCommitting(true);
  }

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
      {data !== null && !committing && (
        <>
          {!readOnly && (
            <div class="buttons">
              <button type="button" class="primary" disabled={busy || (items.length === 0 && unmaintained.length === 0)} onClick={startCommit}>Save changes</button>
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
      {behind !== null && committing && (
        <Dialog title="The branch has moved on">
          <p>{`The branch has ${behind.length} new ${behind.length === 1 ? "commit" : "commits"} that this save would overwrite:`}</p>
          <ul class="commits">
            {behind.map((c) => <li key={c.sha}>{c.message.split("\n")[0]}</li>)}
          </ul>
          {behindError && <DialogError error={behindError} onOptions={() => bridge.openOptions()} />}
          <p class="muted">Updating the app is not part of this version yet.</p>
          <div class="buttons">
            <button type="button" class="primary" disabled={saving} onClick={() => void submit(commitCommand(true))}>Commit anyway</button>
            <button type="button" disabled={saving} onClick={() => { setBehind(null); setBehindError(null); }}>Cancel</button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
