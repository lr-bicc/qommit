import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { CommitInfo, TagInfo } from "../../github/repo";
import type { ImportResult } from "../flows/import";
import type { CommandError } from "../shared/commands";
import type { Bridge } from "./bridge";
import { toCommandError } from "./CreateBranchDialog";
import { ErrorMessage } from "./ErrorMessage";
import { RepoList } from "./RepoList";

const PAGE_SIZE = 30;

type Mode = "latest" | "commit" | "tag";
interface Failure { error: CommandError; retry(): void }

/** The URL of the incomplete app an `import-failed` error names, if it names one. */
function incompleteUrl(error: CommandError): string | null {
  const url = (error.detail as { url?: unknown } | null | undefined)?.url;
  return typeof url === "string" ? url : null;
}

/** Creates a new Qlik app from a repository state: repository, branch, then the latest commit, a commit or a tag. */
export function ImportTab(props: { bridge: Bridge }): JSX.Element {
  const { bridge } = props;
  const [repo, setRepo] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [branch, setBranch] = useState("");
  const [mode, setMode] = useState<Mode>("latest");
  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  const [more, setMore] = useState(false);
  const [tags, setTags] = useState<TagInfo[] | null>(null);
  const [commitSha, setCommitSha] = useState("");
  const [tagName, setTagName] = useState("");
  const [attempt, setAttempt] = useState(0); // a new value loads the branches, tags and commits again
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const page = useRef(0);
  const request = useRef(0); // answers of older commit requests are dropped
  const alive = useRef(true);

  useEffect(() => () => { alive.current = false; }, []);

  function chooseRepo(name: string): void {
    if (name === repo) return; // the same repository again: keep what is loaded and chosen
    setRepo(name);
    setBranches(null);
    setBranch("");
    setMode("latest");
    setCommits(null);
    setMore(false);
    setTags(null);
    setCommitSha("");
    setTagName("");
    setResult(null);
    setFailure(null);
  }

  // The branches (preselecting the default branch) and the tags of the chosen repository.
  useEffect(() => {
    if (repo === null) return undefined;
    let stale = false;
    const fail = (e: unknown): void => { if (!stale) setFailure({ error: toCommandError(e), retry: () => setAttempt((n) => n + 1) }); };
    bridge.send<{ defaultBranch: string; branches: string[] }>({ cmd: "listBranches", repo }).then(
      (r) => { if (!stale) { setBranches(r.branches); setBranch(r.branches.includes(r.defaultBranch) ? r.defaultBranch : (r.branches[0] ?? "")); } },
      fail,
    );
    bridge.send<TagInfo[]>({ cmd: "tags", repo }).then((r) => { if (!stale) setTags(r ?? []); }, fail);
    return () => { stale = true; };
  }, [bridge, repo, attempt]);

  async function loadCommits(next: number): Promise<void> {
    if (repo === null || branch === "") return;
    const mine = ++request.current;
    try {
      const found = (await bridge.send<CommitInfo[]>({ cmd: "commits", repo, branch, page: next })) ?? [];
      if (!alive.current || mine !== request.current) return;
      page.current = next;
      setCommits((old) => (next === 1 ? found : [...(old ?? []), ...found]));
      setMore(found.length === PAGE_SIZE);
    } catch (e) {
      if (alive.current && mine === request.current) setFailure({ error: toCommandError(e), retry: () => void loadCommits(next) });
    }
  }

  // The commits of the chosen branch: the first one is its head, "Latest commit" imports that.
  useEffect(() => {
    setCommits(null);
    setMore(false);
    setCommitSha("");
    if (repo !== null && branch !== "") void loadCommits(1);
    else request.current++;
  }, [bridge, repo, branch, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const tag = tags?.find((t) => t.name === tagName);
  const choice: { sha: string; label: string } | null =
    mode === "latest" ? (commits !== null && commits.length > 0 ? { sha: commits[0].sha, label: branch } : null)
      : mode === "commit" ? (commitSha !== "" ? { sha: commitSha, label: commitSha.slice(0, 7) } : null)
        : (tag !== undefined ? { sha: tag.sha, label: tag.name } : null);
  const ready = repo !== null && branch !== "" && choice !== null && !running;

  async function submit(e?: Event): Promise<void> {
    e?.preventDefault();
    if (!ready || repo === null || choice === null) return;
    setRunning(true);
    setResult(null);
    setFailure(null);
    try {
      const created = await bridge.send<ImportResult>({ cmd: "importApp", repo, sha: choice.sha, label: choice.label });
      if (alive.current) setResult(created);
    } catch (err) {
      if (alive.current) setFailure({ error: toCommandError(err), retry: () => void submit() });
    } finally {
      if (alive.current) setRunning(false);
    }
  }

  const incomplete = failure !== null && failure.error.code === "import-failed" ? incompleteUrl(failure.error) : null;

  return (
    <form class="import" onSubmit={submit}>
      {failure && (
        <ErrorMessage error={failure.error} onOptions={() => bridge.openOptions()} onRetry={failure.retry} disabled={running}
          extra={incomplete !== null ? <a class="button" href={incomplete} target="_blank" rel="noreferrer">Open the incomplete app</a> : undefined} />
      )}
      <h3>Repository</h3>
      <RepoList bridge={bridge} value={repo} onChange={chooseRepo} onError={(error, retry) => setFailure(error && retry ? { error, retry } : null)} disabled={running} />
      {repo !== null && (
        <>
          <label class="field">
            <span>Branch</span>
            <select value={branch} disabled={running || branches === null} onChange={(e) => setBranch(e.currentTarget.value)}>
              {(branches ?? []).map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
          <fieldset>
            <legend>State</legend>
            <label class="check">
              <input type="radio" name="import-state" checked={mode === "latest"} disabled={running} onChange={() => setMode("latest")} />
              <span>Latest commit</span>
            </label>
            <label class="check">
              <input type="radio" name="import-state" checked={mode === "commit"} disabled={running} onChange={() => setMode("commit")} />
              <span>Commit</span>
            </label>
            {mode === "commit" && (
              <>
                <select aria-label="Choose commit" value={commitSha} disabled={running || commits === null} onChange={(e) => setCommitSha(e.currentTarget.value)}>
                  <option value="">{commits === null ? "Loading…" : "Select a commit"}</option>
                  {(commits ?? []).map((c) => <option key={c.sha} value={c.sha}>{`${c.sha.slice(0, 7)} ${c.message.split("\n")[0]}`}</option>)}
                </select>
                {more && <button type="button" disabled={running} onClick={() => void loadCommits(page.current + 1)}>Load more</button>}
              </>
            )}
            <label class="check">
              <input type="radio" name="import-state" checked={mode === "tag"} disabled={running} onChange={() => setMode("tag")} />
              <span>Tag</span>
            </label>
            {mode === "tag" && (
              <select aria-label="Choose tag" value={tagName} disabled={running || tags === null} onChange={(e) => setTagName(e.currentTarget.value)}>
                <option value="">{tags === null ? "Loading…" : tags.length === 0 ? "No tags" : "Select a tag"}</option>
                {(tags ?? []).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
              </select>
            )}
          </fieldset>
        </>
      )}
      <div class="buttons">
        <button type="submit" class="primary" disabled={!ready}>Import</button>
      </div>
      {result && (
        <div class="notice">
          <p>{`Created ${result.name}`}</p>
          <a class="button" href={result.url} target="_blank" rel="noreferrer">Open app</a>
          <p class="muted">The new app is not linked. Open it to connect it or create a branch.</p>
        </div>
      )}
    </form>
  );
}
