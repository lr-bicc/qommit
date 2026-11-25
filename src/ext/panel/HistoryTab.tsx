import type { JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { CommitInfo, TagInfo } from "../../github/repo";
import type { CommandError } from "../shared/commands";
import type { Bridge } from "./bridge";
import { pullRequestUrl } from "./changes-model";
import { toCommandError } from "./CreateBranchDialog";
import { ErrorMessage } from "./ErrorMessage";

const PAGE_SIZE = 30;

export function HistoryTab(props: {
  bridge: Bridge; repo: string; branch: string | null; defaultBranch: string | null; reloadToken?: number;
  canUpdate: boolean; onAddTag(sha: string): void; onUpdate(target: { sha: string; label: string }): void;
}): JSX.Element {
  const { bridge, repo, branch, defaultBranch, reloadToken, canUpdate, onAddTag, onUpdate } = props;
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [actionError, setActionError] = useState<CommandError | null>(null);
  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<CommandError | null>(null);
  const [loading, setLoading] = useState(false);
  const page = useRef(0); // last page that was loaded
  const failedPage = useRef(1);
  const request = useRef(0); // answers of older requests are dropped
  const pending = useRef(false);
  const alive = useRef(true);

  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async (next: number): Promise<void> => {
    const mine = ++request.current;
    pending.current = true;
    setLoading(true);
    setError(null);
    try {
      const result = await bridge.send<{ commits: CommitInfo[] }>({ cmd: "history", page: next });
      if (!alive.current || mine !== request.current) return;
      page.current = next;
      setCommits((old) => (next === 1 ? result.commits : [...(old ?? []), ...result.commits]));
      setMore(result.commits.length === PAGE_SIZE);
    } catch (e) {
      if (!alive.current || mine !== request.current) return;
      failedPage.current = next;
      setError(toCommandError(e));
    } finally {
      if (alive.current && mine === request.current) {
        pending.current = false;
        setLoading(false);
      }
    }
  }, [bridge]);

  useEffect(() => { void load(1); }, [load, repo, branch, reloadToken]);

  // The tags only decorate the list: a failure to load them is not shown.
  useEffect(() => {
    let current = true;
    bridge.send<TagInfo[]>({ cmd: "tags", repo }).then(
      (result) => { if (current && alive.current) setTags(result ?? []); },
      () => undefined,
    );
    return () => { current = false; };
  }, [bridge, repo, reloadToken]);

  const diff = async (before: { kind: "commit"; sha: string }, after: { kind: "commit"; sha: string } | { kind: "app" }, title: string): Promise<void> => {
    setActionError(null);
    try {
      await bridge.send({ cmd: "showDiff", repo, before, after, title });
    } catch (e) {
      if (alive.current) setActionError(toCommandError(e));
    }
  };

  const loadMore =(): void => {
    if (pending.current) return;
    void load(page.current + 1);
  };

  return (
    <section class="history">
      {branch !== null && defaultBranch !== null && branch !== defaultBranch && (
        <p><a href={pullRequestUrl(repo, defaultBranch, branch)} target="_blank" rel="noreferrer">Open pull request on GitHub</a></p>
      )}
      {error && <ErrorMessage error={error} onOptions={() => bridge.openOptions()} onRetry={() => { if (!pending.current) void load(failedPage.current); }} disabled={loading} />}
      {actionError && <ErrorMessage error={actionError} onOptions={() => bridge.openOptions()} onRetry={() => setActionError(null)} />}
      {commits === null && error === null && <p class="muted">Loading…</p>}
      {commits !== null && commits.length === 0 && <p class="muted">No commits</p>}
      {commits !== null && commits.length > 0 && (
        <ul class="commits">
          {commits.map((c) => (
            <li key={c.sha}>
              <div class="commit-message">{c.message.split("\n")[0]}</div>
              {tags.some((t) => t.sha === c.sha) && (
                <div>{tags.filter((t) => t.sha === c.sha).map((t) => <span class="tag" key={t.name}>{t.name}</span>)}</div>
              )}
              <div class="commit-meta muted">
                <span>{c.author}</span> <span>{new Date(c.date).toLocaleString()}</span>{" "}
                <a href={`https://github.com/${repo}/commit/${c.sha}`} target="_blank" rel="noreferrer">{c.sha.slice(0, 7)}</a>
              </div>
              <div class="commit-actions">
                <button type="button" disabled={c.parents.length === 0} onClick={() => void diff({ kind: "commit", sha: c.parents[0]! }, { kind: "commit", sha: c.sha }, `${c.sha.slice(0, 7)} against its parent`)}>Diff to previous</button>
                <button type="button" onClick={() => void diff({ kind: "commit", sha: c.sha }, { kind: "app" }, `App against ${c.sha.slice(0, 7)}`)}>Diff to app</button>
                <button type="button" onClick={() => onAddTag(c.sha)}>Add tag</button>
                {canUpdate && <button type="button" onClick={() => onUpdate({ sha: c.sha, label: c.sha.slice(0, 7) })}>Update app to this commit</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {more && <button type="button" disabled={loading} onClick={loadMore}>Load more</button>}
    </section>
  );
}
