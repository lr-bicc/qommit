import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { Command, CommandError } from "../shared/commands";
import type { AppStatus } from "../flows/status";
import { errorText } from "./errors";

export interface SetupViewsProps {
  status: AppStatus & { state: "unlinked" | "duplicated" | "branch-missing" | "repo-missing" | "published" };
  appId: string; // the app the panel shows
  published: boolean; // the app is published: read only, nothing to unlink or connect
  busy: boolean;
  /** Runs a command and reloads the status; `onError` returns true when it handled the failure itself. */
  mutate(command: Command, onError?: (error: CommandError) => boolean): Promise<void>;
  onConnect(): void;
  onCreateBranch(): void;
  onUnlink(): void;
}

interface NameTaken { name: string; suggestion: string }

const nameTaken = (error: CommandError): NameTaken | null => {
  if (error.code !== "repo-exists" || typeof error.detail !== "object" || error.detail === null) return null;
  const { name, suggestion } = error.detail as Record<string, unknown>;
  return typeof name === "string" && typeof suggestion === "string" ? { name, suggestion } : null;
};

export function SetupViews(props: SetupViewsProps): JSX.Element | null {
  const { status, busy } = props;
  const [taken, setTaken] = useState<NameTaken | null>(null);

  const connect = <button type="button" disabled={busy} onClick={props.onConnect}>Connect to existing repository</button>;

  switch (status.state) {
    case "unlinked": {
      if (props.published) {
        return (
          <section class="view">
            <p>Published app – read only. Duplicate the app to make changes.</p>
            <p>No linked repository</p>
          </section>
        );
      }
      const create = (name?: string): void => {
        setTaken(null);
        const command: Command = name === undefined
          ? { cmd: "createRepository", appId: props.appId }
          : { cmd: "createRepository", appId: props.appId, name };
        void props.mutate(command, (error) => {
          const found = nameTaken(error);
          if (found) setTaken(found);
          return found !== null;
        });
      };
      return (
        <section class="view">
          <p>No linked repository</p>
          {taken && <p class="error" role="alert">{`A repository named ${taken.name} already exists.`}</p>}
          <div class="buttons">
            {taken ? (
              <>
                {connect}
                <button type="button" class="primary" disabled={busy} onClick={() => create(taken.suggestion)}>{`Create as ${taken.suggestion}`}</button>
              </>
            ) : (
              <>
                <button type="button" class="primary" disabled={busy} onClick={() => create()}>Create repository</button>
                {connect}
              </>
            )}
          </div>
        </section>
      );
    }
    case "duplicated":
      return (
        <section class="view">
          <p>We found a repository for the master Qlik application, from which current application was duplicated</p>
          <div class="buttons">
            <button type="button" class="primary" disabled={busy} onClick={props.onCreateBranch}>Create Branch</button>
            <button type="button" disabled={busy} onClick={props.onUnlink}>Unlink Repository</button>
            {connect}
          </div>
        </section>
      );
    case "branch-missing":
      return (
        <section class="view">
          <p>{`Branch ${status.link.branch} no longer exists on GitHub.`}</p>
          <div class="buttons">
            <button type="button" class="primary" disabled={busy} onClick={props.onCreateBranch}>Create Branch</button>
            {connect}
          </div>
        </section>
      );
    case "repo-missing":
      if (props.published) {
        return (
          <section class="view">
            <p>Published app – read only. Duplicate the app to make changes.</p>
            <p>{errorText({ code: "repo-not-found", message: "" }).text}</p>
          </section>
        );
      }
      return (
        <section class="view">
          <p>{errorText({ code: "repo-not-found", message: "" }).text}</p>
          <div class="buttons">
            <button type="button" class="primary" disabled={busy} onClick={props.onUnlink}>Unlink Repository</button>
            {connect}
          </div>
        </section>
      );
    case "published":
      return (
        <section class="view">
          <p>Published app – read only. Duplicate the app to make changes.</p>
          {status.syncedSha !== null && status.syncedSha !== "" && (
            <p>
              {"Published from commit "}
              <a href={`https://github.com/${status.repo}/commit/${status.syncedSha}`} target="_blank" rel="noreferrer">{status.syncedSha.slice(0, 7)}</a>
              {status.branch && <>{" "}<span class="badge">{status.branch}</span></>}
            </p>
          )}
        </section>
      );
  }
}
