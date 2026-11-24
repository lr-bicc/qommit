import type { JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { CommitInfo, TagInfo } from "../../github/repo";
import type { CommandError } from "../shared/commands";
import type { Bridge } from "./bridge";
import { toCommandError } from "./CreateBranchDialog";
import { ErrorMessage } from "./ErrorMessage";

const PAGE_SIZE = 30;

interface Props {
  bridge: Bridge;
  repo: string;
  branch: string; // the branch of the app
  value: string; // the chosen commit
  /** `isHead`: the chosen commit is the newest one of the shown branch. */
  onChange(sha: string, label: string, isHead?: boolean): void;
  disabled: boolean;
}

/** Branch selection (the app's branch first, backup branches included) and the commits of the chosen branch. */
export function CommitPicker(props: Props): JSX.Element {
  const { bridge, repo, branch, value, disabled } = props;
  const [branches, setBranches] = useState<string[]>([branch]);
  const [shown, setShown] = useState(branch);
  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<CommandError | null>(null);
  const [loading, setLoading] = useState(false);
  const page = useRef(0);
  const request = useRef(0); // answers of older requests are dropped
  const alive = useRef(true);
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;

  useEffect(() => () => { alive.current = false; }, []);

  const labelOf = (name: string, sha: string): string => (name === branch ? sha.slice(0, 7) : `${name}@${sha.slice(0, 7)}`);

  useEffect(() => {
    bridge.send<{ defaultBranch: string; branches: string[] }>({ cmd: "listBranches", repo }).then(
      (r) => { if (alive.current) setBranches(r?.branches?.includes(branch) ? r.branches : [branch, ...(r?.branches ?? [])]); },
      (e) => { if (alive.current) setError(toCommandError(e)); },
    );
    bridge.send<TagInfo[]>({ cmd: "tags", repo }).then(
      (r) => { if (alive.current) setTags(r ?? []); },
      () => undefined, // badges are a convenience
    );
  }, [bridge, repo, branch]);

  const load = useCallback(async (name: string, next: number): Promise<void> => {
    const mine = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const result = (await bridge.send<CommitInfo[]>({ cmd: "commits", repo, branch: name, page: next })) ?? [];
      if (!alive.current || mine !== request.current) return;
      page.current = next;
      setCommits((old) => (next === 1 ? result : [...(old ?? []), ...result]));
      setMore(result.length === PAGE_SIZE);
      if (next === 1 && result.length > 0) onChange.current(result[0].sha, labelOf(name, result[0].sha), name === branch);
    } catch (e) {
      if (!alive.current || mine !== request.current) return;
      setError(toCommandError(e));
    } finally {
      if (alive.current && mine === request.current) setLoading(false);
    }
  }, [bridge, repo, branch]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setCommits(null);
    void load(shown, 1);
  }, [load, shown]);

  const query = search.trim().toLowerCase();
  const visible = (commits ?? []).filter((c) => query === "" || c.message.toLowerCase().includes(query) || c.sha.toLowerCase().includes(query));

  return (
    <div class="picker">
      <label class="field">
        <span>Branch</span>
        <select value={shown} disabled={disabled} onChange={(e) => setShown(e.currentTarget.value)}>
          {branches.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
      </label>
      <input type="search" placeholder="Search commits" aria-label="Search commits" value={search} disabled={disabled} onInput={(e) => setSearch(e.currentTarget.value)} />
      {error && <ErrorMessage error={error} onOptions={() => bridge.openOptions()} onRetry={() => void load(shown, 1)} disabled={loading} />}
      {commits === null && error === null && <p class="muted">Loading…</p>}
      {commits !== null && visible.length === 0 && <p class="muted">No commits</p>}
      <ul class="commits picker-list">
        {visible.map((c) => (
          <li key={c.sha}>
            <label class="check">
              <input type="radio" name="update-target" checked={c.sha === value} disabled={disabled}
                onChange={() => props.onChange(c.sha, labelOf(shown, c.sha), shown === branch && commits?.[0]?.sha === c.sha)} />
              <span>
                <span class="commit-message">{c.message.split("\n")[0]}</span>{" "}
                {tags.filter((t) => t.sha === c.sha).map((t) => <span class="tag" key={t.name}>{t.name}</span>)}
                <span class="commit-meta muted"> <span class="commit-sha">{c.sha.slice(0, 7)}</span> {new Date(c.date).toLocaleString()}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {more && <button type="button" disabled={disabled || loading} onClick={() => void load(shown, page.current + 1)}>Load more</button>}
    </div>
  );
}
