import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { lineDiff } from "../../../core/diff";
import type { FileContent } from "../../../core/types";
import type { DiffEntry, DiffSource } from "../../flows/diff";
import { sections } from "../../panel/changes-model";
import { errorText } from "../../panel/errors";
import type { CommandError } from "../../shared/commands";
import { toCommandError } from "../router";
import { sideBySide, type SideCell } from "./side-by-side";

type Contents = { before: FileContent | null; after: FileContent | null };
type Loaded = { path: string; contents: Contents } | { path: string; error: CommandError };
/** Where the window stands on the page, in CSS pixels. */
export type Frame = { left: number; top: number; width: number; height: number };

const MIN_WIDTH = 480;
const MIN_HEIGHT = 240;

const within = (value: number, low: number, high: number): number => Math.max(low, Math.min(value, high));
/** The whole window stays on the page: nothing slides under the side panel or off the edges. */
const placed = (f: Frame): Frame => {
  const width = Math.min(f.width, window.innerWidth);
  const height = Math.min(f.height, window.innerHeight);
  return {
    left: within(f.left, 0, window.innerWidth - width),
    top: within(f.top, 0, window.innerHeight - height),
    width, height,
  };
};
const sized = (f: Frame): Frame => ({
  ...f,
  width: Math.max(MIN_WIDTH, Math.min(f.width, window.innerWidth - f.left)),
  height: Math.max(MIN_HEIGHT, Math.min(f.height, window.innerHeight - f.top)),
});
const px = (f: Frame): Record<string, string> => ({
  left: `${f.left}px`, top: `${f.top}px`, width: `${f.width}px`, height: `${f.height}px`, right: "auto", bottom: "auto",
});

const STYLE = `
:host { all: initial; }
.overlay { position: fixed; inset: 24px; z-index: 2147483647; display: flex; flex-direction: column; background: #fff; color: #1f2328;
  border: 1px solid #8c959f; border-radius: 6px; box-shadow: 0 8px 32px rgba(0,0,0,.4); font: 13px/1.4 system-ui, sans-serif; }
header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid #d0d7de;
  cursor: move; user-select: none; touch-action: none; }
.overlay.max header { cursor: default; }
header h1 { margin: 0; font-size: 15px; }
.overlay.max { inset: 0; border: 0; border-radius: 0; box-shadow: none; }
.actions { display: flex; gap: 4px; }
.icon { width: 28px; height: 28px; padding: 0; border: 1px solid transparent; border-radius: 6px; background: none; color: inherit; font: 16px/1 system-ui, sans-serif; cursor: pointer; }
.icon:hover { background: #eaeef2; border-color: #d0d7de; }
.grip { position: absolute; right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize; touch-action: none;
  background: linear-gradient(135deg, transparent 50%, #8c959f 50%, #8c959f 60%, transparent 60%, transparent 75%, #8c959f 75%, #8c959f 85%, transparent 85%); }
button { font: inherit; cursor: pointer; }
.body { display: flex; flex: 1; min-height: 0; }
nav { width: 300px; overflow: auto; border-right: 1px solid #d0d7de; padding: 8px; }
nav h2 { margin: 8px 0 2px; font-size: 13px; }
nav h3 { margin: 6px 0 2px; font-size: 12px; color: #57606a; }
nav button.entry { display: block; width: 100%; text-align: left; border: 0; background: none; padding: 2px 6px; border-radius: 4px; }
nav button.entry.selected { background: #ddf4ff; }
main { flex: 1; overflow: auto; padding: 8px; min-width: 0; }
.columns { display: grid; grid-template-columns: 1fr 1fr; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.columns .head { font-weight: 600; font-family: system-ui, sans-serif; padding: 2px 6px; border-bottom: 1px solid #d0d7de; }
.cell { white-space: pre-wrap; word-break: break-all; padding: 0 6px; min-height: 1.4em; }
.cell.removed { background: #ffebe9; }
.cell.added { background: #dafbe1; }
.cell.empty { background: #f6f8fa; }
.message { padding: 12px; }
.error .detail { color: #57606a; }
`;

const cellOf = (cell: SideCell | null): JSX.Element =>
  <div class={`cell ${cell ? cell.kind : "empty"}`}>{cell ? cell.text : ""}</div>;

const size = (side: FileContent | null): string =>
  side === null ? "—" : typeof side === "string" ? `${new TextEncoder().encode(side).length} bytes` : `${side.length} bytes`;

function Binary(props: { contents: Contents }): JSX.Element {
  return (
    <div class="columns">
      <div class="head">Before</div>
      <div class="head">After</div>
      {[props.contents.before, props.contents.after].map((side, i) => (
        <div class="message" key={i}>{side === null ? "—" : <><div>Binary file</div><div>{size(side)}</div></>}</div>
      ))}
    </div>
  );
}

function SideBySide(props: { contents: Contents }): JSX.Element {
  const { before, after } = props.contents;
  const rows = useMemo(() => sideBySide(lineDiff((before ?? "") as string, (after ?? "") as string)), [before, after]);
  return (
    <div class="columns">
      <div class="head">Before</div>
      <div class="head">After</div>
      {rows.map((row, i) => <>{cellOf(row.left)}{cellOf(row.right)}</>)}
    </div>
  );
}

function FileView(props: { source: DiffSource; path: string }): JSX.Element {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let current = true;
    setLoaded(null);
    props.source.contents(props.path).then(
      (contents) => { if (current) setLoaded({ path: props.path, contents }); },
      (e: unknown) => { if (current) setLoaded({ path: props.path, error: toCommandError(e) }); },
    );
    return () => { current = false; };
  }, [props.source, props.path]);

  if (loaded === null || loaded.path !== props.path) return <div class="message">Loading…</div>;
  if ("error" in loaded) {
    const { text, detail } = errorText(loaded.error);
    return <div class="message error" role="alert"><p>{text}</p>{detail && <p class="detail">{detail}</p>}</div>;
  }
  const { before, after } = loaded.contents;
  const binary = before instanceof Uint8Array || after instanceof Uint8Array;
  return binary ? <Binary contents={loaded.contents} /> : <SideBySide contents={loaded.contents} />;
}

export function DiffOverlay(props: {
  source: DiffSource; select?: string; title: string; onClose(): void;
  /** Where the window opens (null: the default frame), and the callback after each move or resize. */
  frame?: Frame | null; onFrame?(frame: Frame): void;
}): JSX.Element {
  const { source } = props;
  const list = useMemo(() => sections<DiffEntry>(source.entries), [source]);
  const first = list[0]?.groups[0]?.items[0]?.path ?? null;
  const [selected, setSelected] = useState<string | null>(
    props.select !== undefined && source.entries.some((e) => e.path === props.select) ? props.select : first,
  );
  const overlay = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<Frame | null>(props.frame ? placed(props.frame) : null);
  /** In the browser's full screen (the whole monitor). */
  const [full, setFull] = useState(false);
  /** Filling the page, where the browser refuses full screen. */
  const [filled, setFilled] = useState(false);
  const max = full || filled;
  const stopDrag = useRef<(() => void) | null>(null);

  /** Follows the browser: full screen also ends by its Esc or its own controls. */
  const syncFull = (): void => {
    const el = overlay.current;
    const now = document.fullscreenElement ?? null;
    // The page sees the shadow host as the full-screen element.
    setFull(el !== null && now !== null && (now === el || now === (el.getRootNode() as ShadowRoot).host));
  };
  useEffect(() => {
    // The page narrows when the side panel opens or grows: the window moves back into view.
    const onResize = (): void => setFrame((f) => (f === null ? f : placed(f)));
    document.addEventListener("fullscreenchange", syncFull);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("fullscreenchange", syncFull);
      window.removeEventListener("resize", onResize);
      stopDrag.current?.();
    };
  }, []);

  const toggle = (): void => {
    if (full) { void document.exitFullscreen(); return; }
    if (filled) { setFilled(false); return; }
    const el = overlay.current;
    if (el === null || typeof el.requestFullscreen !== "function") { setFilled(true); return; }
    el.requestFullscreen().then(syncFull, (e: unknown) => {
      console.warn("[qommit] Chrome refused full screen; the window fills the page instead.", e);
      setFilled(true);
    });
  };

  /** Moves (title bar) or resizes (corner) the window with the pointer. */
  const drag = (event: PointerEvent, kind: "move" | "resize"): void => {
    const el = overlay.current;
    if (event.button !== 0 || max || el === null) return;
    if (kind === "move" && (event.target as Element).closest("button") !== null) return;
    event.preventDefault();
    stopDrag.current?.();
    const r = el.getBoundingClientRect();
    const begin: Frame = { left: r.left, top: r.top, width: r.width, height: r.height };
    const x = event.clientX;
    const y = event.clientY;
    let current: Frame | null = null;
    const onMove = (e: PointerEvent): void => {
      const dx = e.clientX - x;
      const dy = e.clientY - y;
      current = kind === "move"
        ? placed({ ...begin, left: begin.left + dx, top: begin.top + dy })
        : sized({ ...begin, width: begin.width + dx, height: begin.height + dy });
      Object.assign(el.style, px(current));
    };
    const stop = (): void => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      stopDrag.current = null;
    };
    const onUp = (): void => {
      stop();
      if (current !== null) { setFrame(current); props.onFrame?.(current); }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    stopDrag.current = stop;
  };

  const sizeLabel = max ? "Restore" : "Maximize";
  return (
    <div ref={overlay} class={max ? "overlay max" : "overlay"} role="dialog" aria-label={props.title}
      style={frame !== null && !max ? px(frame) : undefined}>
      <style>{STYLE}</style>
      <header onPointerDown={(e) => drag(e, "move")}>
        <h1>{props.title}</h1>
        <div class="actions">
          <button type="button" class="icon" aria-label={sizeLabel} title={sizeLabel} onClick={toggle}>{max ? "❐" : "□"}</button>
          <button type="button" class="icon" aria-label="Close" title="Close" onClick={props.onClose}>✕</button>
        </div>
      </header>
      {source.entries.length === 0 ? <div class="message">No differences</div> : (
        <div class="body">
          <nav>
            {list.map((section) => (
              <section key={section.key}>
                <h2>{section.label}</h2>
                {section.groups.map((group) => (
                  <div key={group.label}>
                    <h3>{group.label}</h3>
                    {group.items.map((entry) => (
                      <button type="button" key={entry.path} class={`entry${entry.path === selected ? " selected" : ""}`}
                        title={entry.path} onClick={() => setSelected(entry.path)}>{entry.title}</button>
                    ))}
                  </div>
                ))}
              </section>
            ))}
          </nav>
          <main>{selected !== null && <FileView source={source} path={selected} />}</main>
        </div>
      )}
      {!max && <div class="grip" aria-hidden="true" onPointerDown={(e) => drag(e, "resize")} />}
    </div>
  );
}
