// @vitest-environment happy-dom
import { waitFor } from "@testing-library/preact";
import type { FileContent } from "../../src/core/types";
import { closeDiffOverlay, showDiffOverlay } from "../../src/ext/content/overlay/show";
import type { DiffEntry, DiffSource } from "../../src/ext/flows/diff";
import { FlowError } from "../../src/ext/flows/ports";

type Contents = { before: FileContent | null; after: FileContent | null };

const entries: DiffEntry[] = [
  { path: "data_load_script/Main.qvs", kind: "changed", group: "script", title: "Main" },
  { path: "objects/sheets/s1.json", kind: "added", group: "sheets", title: "Overview" },
];
const sourceOf = (files: Record<string, Contents | Error>, list: DiffEntry[] = entries): DiffSource => ({
  repo: "lr-bicc/sales",
  entries: list,
  async contents(path) {
    const v = files[path];
    if (v instanceof Error) throw v;
    return v ?? { before: null, after: null };
  },
});
const FILES: Record<string, Contents> = {
  "data_load_script/Main.qvs": { before: "a\nb", after: "a\nc" },
  "objects/sheets/s1.json": { before: null, after: "{}" },
};
const host = (): HTMLElement | null => document.getElementById("qommit-diff");
const root = (): ShadowRoot => host()!.shadowRoot!;
/** A button by its text or, for icon buttons, its aria-label. */
const button = (label: string): HTMLButtonElement | undefined =>
  [...root().querySelectorAll("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label);
const click = (label: string): void => {
  const el = button(label);
  if (!el) throw new Error(`no button ${label}`);
  el.click();
};

afterEach(() => {
  host()?.remove();
  document.body.innerHTML = "";
});

test("the overlay lists entries by group and shows the selected file side by side", async () => {
  showDiffOverlay(sourceOf(FILES), { select: "data_load_script/Main.qvs", title: "Local changes" });
  expect(root().textContent).toContain("Local changes");
  expect(root().textContent).toContain("Changed objects");
  expect(root().textContent).toContain("Added objects");
  await waitFor(() => expect(root().querySelectorAll(".removed").length).toBe(1));
  expect(root().querySelectorAll(".added").length).toBe(1);
  expect(root().textContent).toContain("Before");
  expect(root().textContent).toContain("After");
});

test("without select the first entry is chosen", async () => {
  showDiffOverlay(sourceOf(FILES), { title: "t" });
  // "Added objects" is the first section, so the sheet is selected
  await waitFor(() => expect(root().querySelectorAll(".added").length).toBe(1));
  expect(root().querySelectorAll(".removed").length).toBe(0);
});

test("clicking another entry shows Loading… and then its content", async () => {
  let release: (c: Contents) => void = () => undefined;
  const source = sourceOf(FILES);
  const original = source.contents.bind(source);
  source.contents = (path) => (path === "objects/sheets/s1.json" ? new Promise<Contents>((r) => { release = r; }) : original(path));
  showDiffOverlay(source, { select: "data_load_script/Main.qvs", title: "t" });
  await waitFor(() => expect(root().querySelectorAll(".removed").length).toBe(1));
  click("Overview");
  await waitFor(() => expect(root().textContent).toContain("Loading…"));
  release({ before: null, after: "x\ny" });
  await waitFor(() => expect(root().querySelectorAll(".added").length).toBe(2));
  expect(root().textContent).not.toContain("Loading…");
});

test("a contents error is shown for that entry only and the list stays usable", async () => {
  const source = sourceOf({ ...FILES, "objects/sheets/s1.json": new FlowError("repo-not-found", "x") });
  showDiffOverlay(source, { select: "data_load_script/Main.qvs", title: "t" });
  await waitFor(() => expect(root().querySelectorAll(".removed").length).toBe(1));
  click("Overview");
  await waitFor(() => expect(root().textContent).toContain("Repository not found or no access."));
  click("Main");
  await waitFor(() => expect(root().querySelectorAll(".removed").length).toBe(1));
  expect(root().textContent).not.toContain("Repository not found or no access.");
});

test("Close and Escape remove the overlay", () => {
  showDiffOverlay(sourceOf(FILES), { title: "t" });
  expect(host()).not.toBeNull();
  click("Close");
  expect(host()).toBeNull();

  showDiffOverlay(sourceOf(FILES), { title: "t" });
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(host()).toBeNull();
});

test("closeDiffOverlay closes the open overlay and says whether there was one", () => {
  expect(closeDiffOverlay()).toBe(false);
  showDiffOverlay(sourceOf(FILES), { title: "t" });
  expect(closeDiffOverlay()).toBe(true);
  expect(host()).toBeNull();
  expect(closeDiffOverlay()).toBe(false);
});

test("the Escape listener is removed when the overlay closes", () => {
  const add = vi.spyOn(document, "addEventListener");
  const remove = vi.spyOn(document, "removeEventListener");
  showDiffOverlay(sourceOf(FILES), { title: "t" });
  const added = add.mock.calls.filter(([type]) => type === "keydown");
  expect(added.length).toBe(1);
  click("Close");
  const removed = remove.mock.calls.filter(([type]) => type === "keydown");
  expect(removed.length).toBe(1);
  expect(removed[0]![1]).toBe(added[0]![1]);
  add.mockRestore();
  remove.mockRestore();
});

test("a second call replaces the open overlay", () => {
  showDiffOverlay(sourceOf(FILES), { title: "first" });
  showDiffOverlay(sourceOf(FILES), { title: "second" });
  expect(document.querySelectorAll("#qommit-diff").length).toBe(1);
  expect(root().textContent).toContain("second");
  expect(root().textContent).not.toContain("first");
});

test("a binary file shows its sizes", async () => {
  const path = "appcontent/logo.png";
  const source = sourceOf({ [path]: { before: new Uint8Array(2), after: new Uint8Array(3) } },
    [{ path, kind: "changed", group: "attachedFiles", title: "logo.png" }]);
  showDiffOverlay(source, { title: "t" });
  await waitFor(() => expect(root().textContent).toContain("Binary file"));
  expect(root().textContent).toContain("2 bytes");
  expect(root().textContent).toContain("3 bytes");
});

test("a binary file with an absent side shows a dash for it", async () => {
  const path = "appcontent/logo.png";
  const source = sourceOf({ [path]: { before: null, after: new Uint8Array(3) } },
    [{ path, kind: "added", group: "attachedFiles", title: "logo.png" }]);
  showDiffOverlay(source, { title: "t" });
  await waitFor(() => expect(root().textContent).toContain("3 bytes"));
  expect(root().textContent).toContain("—");
  expect(root().textContent).not.toContain("0 bytes");
});

test("no entries show No differences", () => {
  showDiffOverlay(sourceOf({}, []), { title: "t" });
  expect(root().textContent).toContain("No differences");
});

test("the close button is an X icon labelled Close", () => {
  showDiffOverlay(sourceOf(FILES), { title: "t" });
  const close = button("Close")!;
  expect(close.textContent).toBe("✕");
  expect(close.title).toBe("Close");
});

test("the maximized window has no frame and no gap to the window edges", () => {
  showDiffOverlay(sourceOf(FILES), { title: "t" });
  const style = root().querySelector("style")!.textContent!;
  expect(style).toMatch(/\.overlay\.max \{[^}]*inset: 0;[^}]*border-radius: 0;/);
});

describe("window", () => {
  const overlay = (): HTMLElement => root().querySelector(".overlay") as HTMLElement;
  const original = { request: HTMLElement.prototype.requestFullscreen, exit: document.exitFullscreen };
  let fullscreen: Element | null = null;
  const calls: string[] = [];
  const changed = (): void => { document.dispatchEvent(new Event("fullscreenchange")); };

  beforeEach(() => {
    fullscreen = null;
    calls.length = 0;
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreen });
    HTMLElement.prototype.requestFullscreen = async function (this: HTMLElement) { calls.push("request"); fullscreen = this; changed(); };
    document.exitFullscreen = async () => { calls.push("exit"); fullscreen = null; changed(); };
  });
  afterEach(() => {
    delete (document as { fullscreenElement?: unknown }).fullscreenElement;
    HTMLElement.prototype.requestFullscreen = original.request;
    document.exitFullscreen = original.exit;
    closeDiffOverlay();
  });

  test("Maximize puts the window in full screen; Restore and the browser's Esc end it", async () => {
    showDiffOverlay(sourceOf(FILES), { title: "t" });
    expect(button("Maximize")!.textContent).toBe("□");
    click("Maximize");
    await waitFor(() => expect(button("Restore")!.textContent).toBe("❐"));
    expect(fullscreen).toBe(overlay());

    // In full screen, Esc belongs to the browser: it leaves full screen, the window stays open.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(host()).not.toBeNull();
    fullscreen = null;
    changed();
    await waitFor(() => expect(button("Maximize")).toBeDefined());

    click("Maximize");
    await waitFor(() => expect(button("Restore")).toBeDefined());
    click("Restore");
    await waitFor(() => expect(button("Maximize")).toBeDefined());
    expect(fullscreen).toBeNull();
    expect(calls).toEqual(["request", "request", "exit"]);
  });

  test("where the browser refuses full screen, Maximize fills the page", async () => {
    HTMLElement.prototype.requestFullscreen = async () => { throw new TypeError("not allowed"); };
    showDiffOverlay(sourceOf(FILES), { title: "t" });
    click("Maximize");
    await waitFor(() => expect(overlay().classList.contains("max")).toBe(true));
    click("Restore");
    await waitFor(() => expect(overlay().classList.contains("max")).toBe(false));
    expect(calls).toEqual([]);
  });

  const at = (left: number, top: number, width: number, height: number) => () =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  const pointer = (target: EventTarget, type: string, x: number, y: number): void => {
    target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 }));
  };
  const frame = (): string[] => ["left", "top", "width", "height"].map((k) => overlay().style.getPropertyValue(k));

  test("the title bar moves the window; its buttons do not", () => {
    showDiffOverlay(sourceOf(FILES), { title: "t" });
    overlay().getBoundingClientRect = at(24, 24, 800, 600);
    pointer(button("Close")!, "pointerdown", 900, 30);
    pointer(document, "pointermove", 950, 80);
    pointer(document, "pointerup", 950, 80);
    expect(frame()).toEqual(["", "", "", ""]);

    pointer(root().querySelector("header")!, "pointerdown", 100, 30);
    pointer(document, "pointermove", 150, 80);
    pointer(document, "pointerup", 150, 80);
    expect(frame()).toEqual(["74px", "74px", "800px", "600px"]);
    pointer(document, "pointermove", 500, 500); // after the release nothing moves
    expect(frame()).toEqual(["74px", "74px", "800px", "600px"]);
  });

  test("the whole window stays on the page, also on the side of the side panel", () => {
    showDiffOverlay(sourceOf(FILES), { title: "t" });
    overlay().getBoundingClientRect = at(24, 24, 800, 600);
    pointer(root().querySelector("header")!, "pointerdown", 100, 30);
    pointer(document, "pointermove", -2000, -2000);
    expect(frame()).toEqual(["0px", "0px", "800px", "600px"]);
    pointer(document, "pointermove", 5000, 5000);
    pointer(document, "pointerup", 5000, 5000);
    expect(frame()).toEqual([`${innerWidth - 800}px`, `${innerHeight - 600}px`, "800px", "600px"]);
  });

  test("the corner resizes the window, not below a minimum", () => {
    showDiffOverlay(sourceOf(FILES), { title: "t" });
    overlay().getBoundingClientRect = at(24, 24, 800, 600);
    const grip = root().querySelector(".grip")!;
    pointer(grip, "pointerdown", 824, 624);
    pointer(document, "pointermove", 900, 700);
    expect(frame()).toEqual(["24px", "24px", "876px", "676px"]);
    pointer(document, "pointermove", 5000, 5000);
    expect(frame()).toEqual(["24px", "24px", `${innerWidth - 24}px`, `${innerHeight - 24}px`]);
    pointer(document, "pointermove", 0, 0);
    pointer(document, "pointerup", 0, 0);
    expect(frame()).toEqual(["24px", "24px", "480px", "240px"]);
  });

  test("when the page narrows (side panel opens), the window moves back into view", async () => {
    showDiffOverlay(sourceOf(FILES), { title: "t" });
    overlay().getBoundingClientRect = at(24, 24, 400, 300);
    pointer(root().querySelector("header")!, "pointerdown", 100, 30);
    pointer(document, "pointermove", 5000, 100);
    pointer(document, "pointerup", 5000, 100);
    expect(frame()[0]).toBe(`${innerWidth - 400}px`);
    await new Promise((resolve) => setTimeout(resolve, 50)); // effects run after the first paint
    const wide = innerWidth;
    (window as unknown as { happyDOM: { setInnerWidth(w: number): void } }).happyDOM.setInnerWidth(wide - 300);
    window.dispatchEvent(new Event("resize"));
    try {
      await waitFor(() => expect(frame()[0]).toBe(`${wide - 300 - 400}px`));
    } finally {
      (window as unknown as { happyDOM: { setInnerWidth(w: number): void } }).happyDOM.setInnerWidth(wide);
    }
  });

  test("position and size hold for the next window in the tab", () => {
    showDiffOverlay(sourceOf(FILES), { title: "t" });
    overlay().getBoundingClientRect = at(24, 24, 800, 600);
    pointer(root().querySelector("header")!, "pointerdown", 100, 30);
    pointer(document, "pointermove", 110, 40);
    pointer(document, "pointerup", 110, 40);
    click("Close");
    showDiffOverlay(sourceOf(FILES), { title: "again" });
    expect(frame()).toEqual(["34px", "34px", "800px", "600px"]);
  });
});
