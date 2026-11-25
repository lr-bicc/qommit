import { h, render } from "preact";
import type { DiffSource } from "../../flows/diff";
import type { CommandResult } from "../../shared/commands";
import type { DiffWindowContents, DiffWindowRequest, DiffWindowView } from "../../shared/diff-window";
import { toWire } from "../../shared/wire";
import { toCommandError } from "../router";
import { DiffOverlay, type Frame } from "./DiffOverlay";

let closeCurrent: (() => void) | null = null;
/** Where the user moved the window to: it holds for the overlays this page opens later, until the page is loaded again. */
let frame: Frame | null = null;

/** Asks the service worker to show the diff `id` in this tab's own window; rejects when no window opens. */
type Opener = (id: string) => Promise<void>;
let opener: Opener | null = null;
/** The diff the own window shows; it asks for it by id. Only the latest is kept. */
let windowDiff: { id: string; source: DiffSource; view: DiffWindowView } | null = null;
/** While the own window is open, further diffs go there instead of into the page. */
let windowOpen = false;

/** Wires "Maximize" to the own window; null: "Maximize" fills the page. */
export function setDiffWindowOpener(open: Opener | null): void {
  opener = open;
}

async function showInWindow(source: DiffSource, opts: { select?: string; title: string }): Promise<void> {
  if (opener === null) throw new Error("No diff window");
  const id = crypto.randomUUID();
  const view: DiffWindowView = { title: opts.title, repo: source.repo, entries: source.entries };
  if (opts.select !== undefined) view.select = opts.select;
  windowDiff = { id, source, view };
  windowOpen = true;
  try {
    await opener(id);
  } catch (e) {
    if (windowDiff?.id === id) windowDiff = null;
    windowOpen = false;
    throw e;
  }
}

const gone: CommandResult = {
  ok: false, error: { code: "diff-gone", message: "This tab no longer has the diff." },
};

/** Answers the own window, and the service worker when the window was closed. */
export async function handleDiffWindowRequest(request: DiffWindowRequest): Promise<CommandResult> {
  if (request.kind === "closed") {
    windowOpen = false;
    windowDiff = null;
    return { ok: true, value: null };
  }
  const diff = windowDiff;
  if (diff === null || diff.id !== request.id) return gone;
  if (request.kind === "entries") return { ok: true, value: diff.view };
  try {
    const { before, after } = await diff.source.contents(request.path);
    const value: DiffWindowContents = {
      before: before === null ? null : toWire(before),
      after: after === null ? null : toWire(after),
    };
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: toCommandError(e) };
  }
}

/** Closes the open overlay, as "Close" does; true when one was open. */
export function closeDiffOverlay(): boolean {
  if (closeCurrent === null) return false;
  closeCurrent();
  return true;
}

/**
 * Shows the differences over the Qlik page; a second call replaces the overlay that is open. While the own window of
 * this tab is open, the differences go there instead.
 */
export function showDiffOverlay(source: DiffSource, opts: { select?: string; title: string }): void {
  closeCurrent?.();
  if (windowOpen && opener !== null) {
    showInWindow(source, opts).catch((e: unknown) => {
      console.warn("[qommit] the diff window did not open; the diff shows in the page.", e);
      showDiffOverlay(source, opts);
    });
    return;
  }
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
  const maximize = opener === null ? undefined : async (select: string | null): Promise<void> => {
    await showInWindow(source, select === null ? { title: opts.title } : { title: opts.title, select });
    close();
  };
  render(h(DiffOverlay, {
    source, select: opts.select, title: opts.title, onClose: close,
    frame, onFrame: (value: Frame) => { frame = value; },
    onMaximize: maximize,
  }), shadow);
}
