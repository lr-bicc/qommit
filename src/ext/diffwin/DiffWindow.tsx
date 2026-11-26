import { render, type JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { DiffOverlay } from "../content/overlay/DiffOverlay";
import { toCommandError } from "../content/router";
import type { DiffSource } from "../flows/diff";
import { errorText } from "../panel/errors";
import type { CommandError } from "../shared/commands";
import type { DiffWindowView } from "../shared/diff-window";
import { loadDiffWindow, type Ask } from "./client";

type State = { view: DiffWindowView; source: DiffSource } | { error: CommandError } | null;

const MESSAGE_STYLE = "font: 13px/1.4 system-ui, sans-serif; color: #1f2328; padding: 12px;";

/** The diff in its own window: the same view as the overlay in the Qlik page, filling the window. */
export function DiffWindow(props: { ask: Ask; id: string; close(): void }): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>(null);

  useEffect(() => {
    let current = true;
    loadDiffWindow(props.ask, props.id).then(
      (loaded) => { if (current) setState(loaded); },
      (e: unknown) => { if (current) setState({ error: toCommandError(e) }); },
    );
    return () => { current = false; };
  }, [props.ask, props.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props.close]);

  useEffect(() => {
    if (state !== null && "view" in state) document.title = `${state.view.title} – Qommit`;
  }, [state]);

  // Rendered into a shadow root, as in the Qlik page, so the overlay's own styles apply unchanged.
  useEffect(() => {
    const el = host.current;
    if (el === null) return;
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    const content = state === null
      ? <div style={MESSAGE_STYLE}>Loading…</div>
      : "error" in state
        ? <div style={MESSAGE_STYLE} role="alert">{errorText(state.error).text}</div>
        : <DiffOverlay source={state.source} select={state.view.select} title={state.view.title} onClose={props.close} mode="window" />;
    render(content, shadow);
  }, [state, props.close]);

  useEffect(() => () => {
    const shadow = host.current?.shadowRoot;
    if (shadow) render(null, shadow);
  }, []);

  return <div ref={host} />;
}
