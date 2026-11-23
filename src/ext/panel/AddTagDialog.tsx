import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { CommandError } from "../shared/commands";
import { toCommandError, type DialogProps } from "./CreateBranchDialog";
import { Dialog } from "./Dialog";
import { ErrorMessage } from "./ErrorMessage";

export function AddTagDialog(props: DialogProps & { repo: string; sha: string; onDone(): void }): JSX.Element {
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<CommandError | null>(null);

  async function submit(e?: Event): Promise<void> {
    e?.preventDefault();
    if (props.isBusy()) return;
    setError(null);
    try {
      await props.run({ cmd: "addTag", repo: props.repo, sha: props.sha, name: name.trim(), message });
      props.onDone();
    } catch (err) {
      setError(toCommandError(err));
    }
  }

  return (
    <Dialog title={`Add tag to ${props.sha.slice(0, 7)}`}>
      <form onSubmit={submit}>
        {error && <ErrorMessage error={error} onOptions={props.onOptions} onRetry={() => void submit()} disabled={props.busy} />}
        <label class="field">
          <span>Tag name</span>
          <input type="text" value={name} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        <label class="field">
          <span>Description (optional)</span>
          <textarea rows={3} value={message} onInput={(e) => setMessage(e.currentTarget.value)} />
        </label>
        <div class="buttons">
          <button type="submit" class="primary" disabled={props.busy || name.trim() === ""}>Add tag</button>
          <button type="button" disabled={props.busy} onClick={props.onCancel}>Cancel</button>
        </div>
      </form>
    </Dialog>
  );
}
