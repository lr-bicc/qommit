import type { JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { CommitInfo } from "../../github/repo";
import type { CommandError } from "../shared/commands";
import type { Bridge } from "./bridge";
import { pullRequestUrl } from "./changes-model";
import { toCommandError } from "./CreateBranchDialog";
import { ErrorMessage } from "./ErrorMessage";

const PAGE_SIZE = 30;

export function HistoryTab(props: { bridge: Bridge; repo: string; branch: string; defaultBranch: string; reloadToken?: number }): JSX.Element {
  const { bridge, repo, branch, defaultBranch, reloadToken } = props;
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

  const loadMore = (): void => {
    if (pending.current) return;
    void load(page.current + 1);
  };

  return (
    <section class="history">
      {branch !== defaultBranch && (
        <p><a href={pullRequestUrl(repo, defaultBranch, branch)} target="_blank" rel="noreferrer">Open pull request on GitHub</a></p>
      )}
      {error && <ErrorMessage error={error} onOptions={() => bridge.openOptions()} onRetry={() => { if (!pending.current) void load(failedPage.current); }} disabled={loading} />}
      {commits === null && error === null && <p class="muted">Loading…</p>}
      {commits !== null && commits.length === 0 && <p class="muted">No commits</p>}
      {commits !== null && commits.length > 0 && (
        <ul class="commits">
          {commits.map((c) => (
            <li key={c.sha}>
              <div class="commit-message">{c.message.split("\n")[0]}</div>
              <div class="commit-meta muted">
                <span>{c.author}</span> <span>{new Date(c.date).toLocaleString()}</span>{" "}
                <a href={`https://github.com/${repo}/commit/${c.sha}`} target="_blank" rel="noreferrer">{c.sha.slice(0, 7)}</a>
              </div>
            </li>
          ))}
        </ul>
      )}
      {more && <button type="button" disabled={loading} onClick={loadMore}>Load more</button>}
    </section>
  );
}
