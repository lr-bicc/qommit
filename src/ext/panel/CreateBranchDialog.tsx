import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { Command, CommandError } from "../shared/commands";
import { BridgeError } from "./bridge";
import { Dialog } from "./Dialog";
import { ErrorMessage } from "./ErrorMessage";

export interface DialogProps {
  run<T>(command: Command): Promise<T>; // rejects with BridgeError
  busy: boolean;
  isBusy(): boolean; // a command is in flight right now (not yet reflected in `busy`)
  onOptions(): void;
  onCancel(): void;
  onDone(): void;
}

export const toCommandError = (e: unknown): CommandError =>
  e instanceof BridgeError ? e.error : { code: "internal", message: e instanceof Error ? e.message : String(e) };

export function CreateBranchDialog(props: DialogProps & { suggestedBranch: string; sourceBranch: string | null }): JSX.Element {
  const [name, setName] = useState(props.suggestedBranch);
  const [fromSource, setFromSource] = useState(false);
  const [error, setError] = useState<CommandError | null>(null);

  async function submit(e?: Event): Promise<void> {
    e?.preventDefault();
    if (props.isBusy()) return;
    setError(null);
    try {
      await props.run({ cmd: "createBranch", name: name.trim(), fromSource: props.sourceBranch !== null && fromSource });
      props.onDone();
    } catch (err) {
      setError(toCommandError(err));
    }
  }

  return (
    <Dialog title="Create Branch">
      <form onSubmit={submit}>
        {error && <ErrorMessage error={error} onOptions={props.onOptions} onRetry={() => void submit()} disabled={props.busy} />}
        <label class="field">
          <span>Branch Name</span>
          <input type="text" value={name} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        {props.sourceBranch !== null && (
          <label class="check">
            <input type="checkbox" checked={fromSource} onChange={(e) => setFromSource(e.currentTarget.checked)} />
            <span>Branch off from the branch that is used in the app you are duplicating from <strong>{props.sourceBranch}</strong></span>
          </label>
        )}
        <div class="buttons">
          <button type="submit" class="primary" disabled={props.busy || name.trim() === ""}>Create Branch</button>
          <button type="button" disabled={props.busy} onClick={props.onCancel}>Cancel</button>
        </div>
      </form>
    </Dialog>
  );
}
