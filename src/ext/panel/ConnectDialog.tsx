import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { CommandError } from "../shared/commands";
import { toCommandError, type DialogProps } from "./CreateBranchDialog";
import { Dialog } from "./Dialog";
import { ErrorMessage } from "./ErrorMessage";

/** `marked`: the repository carries the Qommit topic. */
interface RepoRef { repo: string; defaultBranch: string; marked: boolean }
interface Branches { defaultBranch: string; branches: string[] }

export function ConnectDialog(props: DialogProps & { suggestedBranch: string }): JSX.Element {
  const [repos, setRepos] = useState<RepoRef[] | null>(null);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [repo, setRepo] = useState<string | null>(null);
  const [branches, setBranches] = useState<Branches | null>(null);
  const [mode, setMode] = useState<"new-branch" | "existing-branch">("new-branch");
  const [newName, setNewName] = useState(props.suggestedBranch);
  const [existing, setExisting] = useState("");
  const [error, setError] = useState<{ error: CommandError; retry(): void } | null>(null);

  async function loadRepos(): Promise<void> {
    setError(null);
    try {
      setRepos(await props.run<RepoRef[]>({ cmd: "listRepos" }));
    } catch (e) {
      setRepos([]);
      setError({ error: toCommandError(e), retry: () => void loadRepos() });
    }
  }

  useEffect(() => { void loadRepos(); }, []);

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

  const needle = search.trim().toLowerCase();
  // Only Qommit repositories by default; "Show all" reveals the rest, e.g. an empty repository an admin created.
  const shown = (repos ?? []).filter((r) => (showAll || r.marked) && r.repo.toLowerCase().includes(needle));
  const ready = repo !== null && branches !== null && (mode === "existing-branch" ? existing !== "" : newName.trim() !== "");

  return (
    <Dialog title="Connect to existing repository">
      <form onSubmit={submit}>
        {error && <ErrorMessage error={error.error} onOptions={props.onOptions} onRetry={error.retry} disabled={props.busy} />}
        <input type="search" placeholder="Search repositories" aria-label="Search repositories" value={search} onInput={(e) => setSearch(e.currentTarget.value)} />
        <label class="check">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.currentTarget.checked)} />
          <span>Show all repositories</span>
        </label>
        <ul class="repo-list">
          {repos === null && <li class="muted">Loading…</li>}
          {repos !== null && shown.length === 0 && <li class="muted">No repositories found.</li>}
          {shown.map((r) => (
            <li key={r.repo}>
              <button type="button" class={r.repo === repo ? "selected" : ""} aria-pressed={r.repo === repo} disabled={props.busy} onClick={() => void choose(r.repo)}>{r.repo}</button>
            </li>
          ))}
        </ul>
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
