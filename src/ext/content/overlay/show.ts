import { h, render } from "preact";
import type { DiffSource } from "../../flows/diff";
import { DiffOverlay, type Frame } from "./DiffOverlay";

let closeCurrent: (() => void) | null = null;
/** Where the user moved the window to: it holds for the overlays this page opens later, until the page is loaded again. */
let frame: Frame | null = null;

/** Closes the open overlay, as "Close" does; true when one was open. */
export function closeDiffOverlay(): boolean {
  if (closeCurrent === null) return false;
  closeCurrent();
  return true;
}

/** Shows the differences full screen over the Qlik page; a second call replaces the overlay that is open. */
export function showDiffOverlay(source: DiffSource, opts: { select?: string; title: string }): void {
  closeCurrent?.();
  const host = document.createElement("div");
  host.id = "qommit-diff";
  const shadow = host.attachShadow({ mode: "open" });
  document.body.appendChild(host);

  const onKey = (event: KeyboardEvent): void => {
    // In full screen, Esc is the browser's: it ends full screen, the window stays.
    if (event.key === "Escape" && !document.fullscreenElement) close();
  };
  const close = (): void => {
    document.removeEventListener("keydown", onKey, true);
    render(null, shadow);
    host.remove();
    if (closeCurrent === close) closeCurrent = null;
  };
  closeCurrent = close;
  document.addEventListener("keydown", onKey, true);
  render(h(DiffOverlay, {
    source, select: opts.select, title: opts.title, onClose: close,
    frame, onFrame: (value: Frame) => { frame = value; },
  }), shadow);
}
