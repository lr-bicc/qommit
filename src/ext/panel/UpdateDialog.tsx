import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ActionItem } from "../../core/update-planner";
import type { TargetProblem } from "../../core/target-validator";
import type { UpdatePart, UpdatePreview, UpdateResult } from "../flows/update";
import type { CommandError } from "../shared/commands";
import { toCommandError, type DialogProps } from "./CreateBranchDialog";
import { Dialog } from "./Dialog";
import { ErrorMessage } from "./ErrorMessage";

interface Failed { done: ActionItem[]; failed: ActionItem; remaining: ActionItem[]; backupBranch: string | null }

const asProblems = (d: unknown): TargetProblem[] => (Array.isArray(d) ? (d as TargetProblem[]) : []);
const asFailed = (d: unknown): Failed | null =>
  typeof d === "object" && d !== null && Array.isArray((d as Failed).done) && Array.isArray((d as Failed).remaining) ? (d as Failed) : null;

/** A list of planned or finished actions behind a toggle. */
function Items(props: { label: string; items: ActionItem[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" class="group-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span> <span>{props.label}</span>
      </button>
      {open && <ul class="entries">{props.items.map((a, i) => <li key={`${a.group}:${a.id}:${i}`}>{`${a.kind}: ${a.title}`}</li>)}</ul>}
    </div>
  );
}

function BackupLink(props: { repo: string; branch: string }): JSX.Element {
  return <p>Backup: <a href={`https://github.com/${props.repo}/tree/${props.branch}`} target="_blank" rel="noreferrer">{props.branch}</a></p>;
}

export function UpdateDialog(props: DialogProps & { repo: string; target: { sha: string; label: string }; parts: UpdatePart[]; onUpdated(): void; interruptedUpdate?: boolean }): JSX.Element {
  const { repo, target, parts } = props;
  const [preview, setPreview] = useState<UpdatePreview | null>(null);
  const [error, setError] = useState<CommandError | null>(null); // of the preview
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<UpdateResult | null>(null);
  const [failure, setFailure] = useState<CommandError | null>(null); // of the update
  const alive = useRef(true);
  const request = useRef(0);
  const submitting = useRef(false); // current before the next render, unlike `working`

  useEffect(() => () => { alive.current = false; }, []);

  function loadPreview(): void {
    const mine = ++request.current;
    setPreview(null);
    setError(null);
    props.run<UpdatePreview>({ cmd: "updatePreview", appId: props.appId, target: target.sha, parts }).then(
      (p) => { if (alive.current && mine === request.current) setPreview(p); },
      (e) => { if (alive.current && mine === request.current) setError(toCommandError(e)); },
    );
  }
  useEffect(loadPreview, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(): Promise<void> {
    if (props.isBusy() || working || submitting.current) return;
    submitting.current = true;
    setWorking(true);
    setFailure(null);
    try {
      const done = await props.run<UpdateResult>({ cmd: "update", appId: props.appId, target: target.sha, parts });
      if (alive.current) setResult(done);
    } catch (e) {
      if (alive.current) setFailure(toCommandError(e));
    } finally {
      submitting.current = false;
      if (alive.current) setWorking(false);
    }
  }

  const commitLink = <a href={`https://github.com/${repo}/commit/${target.sha}`} target="_blank" rel="noreferrer">{target.sha.slice(0, 7)}</a>;
  const problems = (e: CommandError): JSX.Element => (
    <div class="error" role="alert">
      <p>The selected state contains files that cannot be applied:</p>
      <ul class="entries">
        {asProblems(e.detail).map((p) => (
          <li key={p.path}><a href={`https://github.com/${repo}/blob/${target.sha}/${p.path}`} target="_blank" rel="noreferrer">{`${p.path} (${p.reason})`}</a></li>
        ))}
      </ul>
    </div>
  );

  let body: JSX.Element;
  if (result !== null) {
    body = (
      <>
        <div class="buttons"><button type="button" class="primary" disabled>Success</button></div>
        {result.backupBranch !== null && <BackupLink repo={repo} branch={result.backupBranch} />}
        <div class="buttons"><button type="button" onClick={props.onUpdated}>Close</button></div>
      </>
    );
  } else if (failure !== null) {
    const failed = failure.code === "update-failed" ? asFailed(failure.detail) : null;
    body = (
      <>
        {failure.code === "invalid-target" ? problems(failure) : failed === null ? (
          <ErrorMessage error={failure} onOptions={props.onOptions} onRetry={() => void submit()} disabled={working} />
        ) : (
          <div class="error" role="alert">
            <p>{`The update stopped: ${failure.message}`}</p>
            <Items label={`Done: ${failed.done.length}`} items={failed.done} />
            <Items label={`Not done: ${failed.remaining.length + 1}`} items={[failed.failed, ...failed.remaining]} />
            {failed.backupBranch !== null && <BackupLink repo={repo} branch={failed.backupBranch} />}
          </div>
        )}
        <div class="buttons"><button type="button" onClick={props.onUpdated}>Close</button></div>
      </>
    );
  } else if (error !== null) {
    body = (
      <>
        {error.code === "invalid-target" ? problems(error) : <ErrorMessage error={error} onOptions={props.onOptions} onRetry={loadPreview} />}
        <div class="buttons"><button type="button" onClick={props.onCancel}>Close</button></div>
      </>
    );
  } else if (preview === null) {
    body = <p class="muted">Preparing…</p>;
  } else if (preview.items.length === 0 && !preview.advances && props.interruptedUpdate !== true) {
    body = (
      <>
        <p>The app already matches this state.</p>
        <div class="buttons"><button type="button" class="primary" onClick={props.onCancel}>Close</button></div>
      </>
    );
  } else if (preview.items.length === 0) {
    // Nothing to apply, but the update still finishes an interrupted one or moves the link to this commit.
    body = (
      <>
        <p>The app already matches this state.</p>
        <div class="buttons">
          <button type="button" class="primary" disabled={working || props.busy} onClick={() => void submit()}>Update</button>
          <button type="button" disabled={working} onClick={props.onCancel}>Cancel</button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <p>{`${preview.summary.create} to create, ${preview.summary.change} to change, ${preview.summary.delete} to delete`}</p>
        <Items label="Show details" items={preview.items} />
        {preview.localChanges > 0 && <p>Your local changes will be saved to a backup branch first.</p>}
        <div class="buttons">
          <button type="button" class="primary" disabled={working || props.busy} onClick={() => void submit()}>Update</button>
          <button type="button" disabled={working} onClick={props.onCancel}>Cancel</button>
        </div>
      </>
    );
  }

  return (
    <Dialog title="Update Application from the repository?">
      <p>{commitLink} {target.label}</p>
      {body}
    </Dialog>
  );
}
