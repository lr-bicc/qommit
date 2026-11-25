import type { JSX } from "preact";
import { useMemo, useState } from "preact/hooks";
import type { CommandError } from "../shared/commands";
import { toCommandError, type DialogProps } from "./CreateBranchDialog";
import { Dialog } from "./Dialog";
import { ErrorMessage } from "./ErrorMessage";
import { RepoList } from "./RepoList";

interface Branches { defaultBranch: string; branches: string[] }

export function ConnectDialog(props: DialogProps & { suggestedBranch: string }): JSX.Element {
  const [repo, setRepo] = useState<string | null>(null);
  const [branches, setBranches] = useState<Branches | null>(null);
  const [mode, setMode] = useState<"new-branch" | "existing-branch">("new-branch");
  const [newName, setNewName] = useState(props.suggestedBranch);
  const [existing, setExisting] = useState("");
  const [error, setError] = useState<{ error: CommandError; retry(): void } | null>(null);
  const sender = useMemo(() => ({ send: props.run }), [props.run]);

  async function choose(name: string): Promise<void> {
    setRepo(name);
    setBranches(null);
    setError(null);
    try {
      const found = await props.run<Branches>({ cmd: "listBranches", repo: name });
      setBranches(found);
      setExisting(found.defaultBranch);
    } catch (e) {
      setError({ error: toCommandError(e), retry: () => void choose(name) });
    }
  }

  async function submit(e?: Event): Promise<void> {
    e?.preventDefault();
    if (repo === null || props.isBusy()) return;
    setError(null);
    try {
      await props.run({ cmd: "connect", appId: props.appId, repo, mode, branch: mode === "new-branch" ? newName.trim() : existing });
      props.onDone();
    } catch (err) {
      setError({ error: toCommandError(err), retry: () => void submit() });
    }
  }

  const ready = repo !== null && branches !== null && (mode === "existing-branch" ? existing !== "" : newName.trim() !== "");

  return (
    <Dialog title="Connect to existing repository">
      <form onSubmit={submit}>
        {error && <ErrorMessage error={error.error} onOptions={props.onOptions} onRetry={error.retry} disabled={props.busy} />}
        <RepoList bridge={sender} value={repo} onChange={(name) => void choose(name)} onError={(e, retry) => setError(e && retry ? { error: e, retry } : null)} disabled={props.busy} />
        {repo !== null && branches !== null && (
          <fieldset>
            <label class="check">
              <input type="radio" name="mode" checked={mode === "new-branch"} onChange={() => setMode("new-branch")} />
              <span>As a new branch</span>
            </label>
            <label class="check">
              <input type="radio" name="mode" checked={mode === "existing-branch"} onChange={() => setMode("existing-branch")} />
              <span>To existing branch</span>
            </label>
            {mode === "new-branch" ? (
              <label class="field">
                <span>Branch name</span>
                <input type="text" value={newName} onInput={(e) => setNewName(e.currentTarget.value)} />
              </label>
            ) : (
              <label class="field">
                <span>Branch</span>
                <select value={existing} onChange={(e) => setExisting(e.currentTarget.value)}>
                  {branches.branches.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </label>
            )}
          </fieldset>
        )}
        <div class="buttons">
          <button type="submit" class="primary" disabled={props.busy || !ready}>Connect</button>
          <button type="button" disabled={props.busy} onClick={props.onCancel}>Cancel</button>
        </div>
      </form>
    </Dialog>
  );
}
