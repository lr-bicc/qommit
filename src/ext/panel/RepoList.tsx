import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Command, CommandError } from "../shared/commands";
import { toCommandError } from "./CreateBranchDialog";

/** `marked`: the repository carries the Qommit topic. */
export interface RepoRef { repo: string; defaultBranch: string; marked: boolean }

interface Props {
  /** Anything that can send a command: the panel's bridge, or the dialogs' `run`. */
  bridge: { send<T>(command: Command): Promise<T> };
  value: string | null;
  onChange(repo: string): void;
  /** The list could not be loaded (`retry` loads it again); null when a new load starts. */
  onError(error: CommandError | null, retry?: () => void): void;
  disabled?: boolean;
}

/** The repositories of the organization with a filter field; only Qommit repositories unless "Show all" is checked. */
export function RepoList(props: Props): JSX.Element {
  const { bridge, value, disabled } = props;
  const [repos, setRepos] = useState<RepoRef[] | null>(null);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const alive = useRef(true);
  const onError = useRef(props.onError);
  onError.current = props.onError;

  async function load(): Promise<void> {
    onError.current(null);
    try {
      const list = await bridge.send<RepoRef[]>({ cmd: "listRepos" });
      if (alive.current) setRepos(list);
    } catch (e) {
      if (!alive.current) return;
      setRepos([]);
      onError.current(toCommandError(e), () => void load());
    }
  }

  useEffect(() => {
    void load();
    return () => { alive.current = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const needle = search.trim().toLowerCase();
  // Only Qommit repositories by default; "Show all" reveals the rest, e.g. an empty repository an admin created.
  const shown = (repos ?? []).filter((r) => (showAll || r.marked) && r.repo.toLowerCase().includes(needle));

  return (
    <>
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
            <button type="button" class={r.repo === value ? "selected" : ""} aria-pressed={r.repo === value} disabled={disabled} onClick={() => props.onChange(r.repo)}>{r.repo}</button>
          </li>
        ))}
      </ul>
    </>
  );
}
