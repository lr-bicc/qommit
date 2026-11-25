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

test("Maximize fills the window, Restore brings back the frame; the choice holds for the next overlay", async () => {
  const overlay = (): HTMLElement => root().querySelector(".overlay") as HTMLElement;
  showDiffOverlay(sourceOf(FILES), { title: "t" });
  expect(overlay().classList.contains("max")).toBe(false);
  expect(button("Restore")).toBeUndefined();
  expect(button("Maximize")!.textContent).toBe("□");

  click("Maximize");
  await waitFor(() => expect(overlay().classList.contains("max")).toBe(true));
  expect(button("Maximize")).toBeUndefined();
  expect(button("Restore")!.textContent).toBe("❐");
  expect(button("Restore")!.title).toBe("Restore");

  click("Close");
  showDiffOverlay(sourceOf(FILES), { title: "again" });
  expect(overlay().classList.contains("max")).toBe(true);

  click("Restore");
  await waitFor(() => expect(overlay().classList.contains("max")).toBe(false));
  click("Close");
  showDiffOverlay(sourceOf(FILES), { title: "third" });
  expect(overlay().classList.contains("max")).toBe(false);
});

test("the maximized window has no frame and no gap to the window edges", () => {
  showDiffOverlay(sourceOf(FILES), { title: "t" });
  const style = root().querySelector("style")!.textContent!;
  expect(style).toMatch(/\.overlay\.max \{[^}]*inset: 0;[^}]*border-radius: 0;/);
});
