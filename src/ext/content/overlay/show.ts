import { h, render } from "preact";
import type { DiffSource } from "../../flows/diff";
import { DiffOverlay } from "./DiffOverlay";

let closeCurrent: (() => void) | null = null;

/** Shows the differences full screen over the Qlik page; a second call replaces the overlay that is open. */
export function showDiffOverlay(source: DiffSource, opts: { select?: string; title: string }): void {
  closeCurrent?.();
  const host = document.createElement("div");
  host.id = "qommit-diff";
  const shadow = host.attachShadow({ mode: "open" });
  document.body.appendChild(host);

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };
  const close = (): void => {
    document.removeEventListener("keydown", onKey, true);
    render(null, shadow);
    host.remove();
    if (closeCurrent === close) closeCurrent = null;
  };
  closeCurrent = close;
  document.addEventListener("keydown", onKey, true);
  render(h(DiffOverlay, { source, select: opts.select, title: opts.title, onClose: close }), shadow);
}
