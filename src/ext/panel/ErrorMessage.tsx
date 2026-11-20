import type { JSX } from "preact";
import type { CommandError } from "../shared/commands";
import { errorText } from "./errors";

/** An error with the action that fits it: open the options, authorize the token or retry. */
export function ErrorMessage(props: { error: CommandError; onOptions(): void; onRetry(): void; disabled?: boolean }): JSX.Element {
  const { error } = props;
  const { text, action, detail } = errorText(error);
  return (
    <div class="error" role="alert">
      <p>{text}</p>
      {detail !== undefined && detail !== "" && <p class="detail">{detail}</p>}
      {action === "options" && <button type="button" disabled={props.disabled} onClick={props.onOptions}>Open options</button>}
      {action === "sso" && error.ssoUrl !== undefined && <a class="button" href={error.ssoUrl} target="_blank" rel="noreferrer">Authorize</a>}
      {action === "retry" && <button type="button" disabled={props.disabled} onClick={props.onRetry}>Retry</button>}
    </div>
  );
}
