import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { CommandError } from "../shared/commands";
import { toCommandError, type DialogProps } from "./CreateBranchDialog";
import { Dialog } from "./Dialog";
import { ErrorMessage } from "./ErrorMessage";

export interface HeaderProps {
  title: string;
  repo?: string;
  branch?: string | null;
  behindBy?: number;
  canUnlink: boolean;
  busy: boolean;
  onUnlink(): void;
  onRefresh(): void;
}

export function Header(props: HeaderProps): JSX.Element {
  const behind = props.behindBy ?? 0;
  return (
    <header class="header">
      <div class="header-row">
        <h1>{props.title}</h1>
        <span class="header-buttons">
          {props.canUnlink && (
            <button type="button" class="icon" title="Unlink repository" aria-label="Unlink repository" disabled={props.busy} onClick={props.onUnlink}>⛓</button>
          )}
          <button type="button" class="icon" title="Refresh" aria-label="Refresh" disabled={props.busy} onClick={props.onRefresh}>↻</button>
        </span>
      </div>
      {props.repo !== undefined && (
        <div class="header-row">
          <a href={`https://github.com/${props.repo}`} target="_blank" rel="noreferrer">{props.repo}</a>
          {props.branch && <span class="badge">{props.branch}</span>}
        </div>
      )}
      {behind > 0 && <p class="notice">{behind === 1 ? "Repository has 1 new commit" : `Repository has ${behind} new commits`}</p>}
    </header>
  );
}

export function UnlinkDialog(props: DialogProps & { repo: string }): JSX.Element {
  const [error, setError] = useState<CommandError | null>(null);

  async function confirm(): Promise<void> {
    if (props.isBusy()) return;
    setError(null);
    try {
      await props.run({ cmd: "unlink", appId: props.appId });
      props.onDone();
    } catch (e) {
      setError(toCommandError(e));
    }
  }

  return (
    <Dialog title={`Unlink this app from ${props.repo}?`}>
      {error && <ErrorMessage error={error} onOptions={props.onOptions} onRetry={() => void confirm()} disabled={props.busy} />}
      <div class="buttons">
        <button type="button" class="primary" disabled={props.busy} onClick={() => void confirm()}>Unlink</button>
        <button type="button" disabled={props.busy} onClick={props.onCancel}>Cancel</button>
      </div>
    </Dialog>
  );
}
