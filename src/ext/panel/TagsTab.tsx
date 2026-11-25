import type { JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { TagInfo } from "../../github/repo";
import type { CommandError } from "../shared/commands";
import type { Bridge } from "./bridge";
import { toCommandError } from "./CreateBranchDialog";
import { ErrorMessage } from "./ErrorMessage";

export function TagsTab(props: { bridge: Bridge; repo: string; canUpdate: boolean; onUpdate(target: { sha: string; label: string }): void; reloadToken?: number }): JSX.Element {
  const { bridge, repo, canUpdate, onUpdate, reloadToken } = props;
  const [tags, setTags] = useState<TagInfo[] | null>(null);
  const [error, setError] = useState<CommandError | null>(null);
  const request = useRef(0); // answers of older requests are dropped
  const alive = useRef(true);

  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async (): Promise<void> => {
    const mine = ++request.current;
    setError(null);
    try {
      const result = await bridge.send<TagInfo[]>({ cmd: "tags", repo });
      if (alive.current && mine === request.current) setTags(result);
    } catch (e) {
      if (alive.current && mine === request.current) setError(toCommandError(e));
    }
  }, [bridge, repo]);

  useEffect(() => { void load(); }, [load, reloadToken]);

  const diffToApp = async (tag: TagInfo): Promise<void> => {
    setError(null);
    try {
      await bridge.send({ cmd: "showDiff", repo, before: { kind: "commit", sha: tag.sha }, after: { kind: "app" }, title: `App against ${tag.sha.slice(0, 7)}` });
    } catch (e) {
      if (alive.current) setError(toCommandError(e));
    }
  };

  return (
    <section class="tags">
      {error && <ErrorMessage error={error} onOptions={() => bridge.openOptions()} onRetry={() => void load()} />}
      {tags === null && error === null && <p class="muted">Loading…</p>}
      {tags !== null && tags.length === 0 && <p class="muted">No tags</p>}
      {tags !== null && tags.length > 0 && (
        <ul class="commits">
          {tags.map((t) => (
            <li key={t.name}>
              <div class="commit-message">{t.name}</div>
              <div class="commit-meta muted">
                <span>{t.date === null ? "–" : new Date(t.date).toLocaleString()}</span>{" "}
                <a href={`https://github.com/${repo}/commit/${t.sha}`} target="_blank" rel="noreferrer">{t.sha.slice(0, 7)}</a>
              </div>
              {t.message.split("\n")[0] !== "" && <div class="commit-meta">{t.message.split("\n")[0]}</div>}
              <div class="commit-actions">
                <button type="button" onClick={() => void diffToApp(t)}>Diff to app</button>
                {canUpdate && <button type="button" onClick={() => onUpdate({ sha: t.sha, label: t.name })}>Update app to this tag</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
