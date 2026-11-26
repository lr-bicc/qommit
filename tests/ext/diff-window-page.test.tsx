// @vitest-environment happy-dom
import { render, waitFor } from "@testing-library/preact";
import { DiffWindow } from "../../src/ext/diffwin/DiffWindow";
import { loadDiffWindow, type Ask } from "../../src/ext/diffwin/client";
import type { DiffEntry } from "../../src/ext/flows/diff";
import type { DiffWindowRequest } from "../../src/ext/shared/diff-window";

const entries: DiffEntry[] = [
  { path: "data_load_script/Main.qvs", kind: "changed", group: "script", title: "Main" },
  { path: "media/logo.png", kind: "changed", group: "attachedFiles", title: "logo.png" },
];
const VIEW = { title: "App against dec8fcc", select: "data_load_script/Main.qvs", repo: "lr-bicc/sales", entries };

function askOf(answers: Partial<Record<string, unknown>> = {}): Ask & { asked: DiffWindowRequest[] } {
  const asked: DiffWindowRequest[] = [];
  const ask = (async (req: DiffWindowRequest) => {
    asked.push(req);
    if (req.kind === "entries") return answers.entries ?? { ok: true, value: VIEW };
    if (req.kind === "contents" && req.path === "media/logo.png") return { ok: true, value: { before: null, after: { base64: "AQID" } } };
    return answers.contents ?? { ok: true, value: { before: { text: "a\nb" }, after: { text: "a\nc" } } };
  }) as Ask & { asked: DiffWindowRequest[] };
  ask.asked = asked;
  return ask;
}

test("the window asks its Qlik tab for the diff and for each file's two sides", async () => {
  const ask = askOf();
  const { view, source } = await loadDiffWindow(ask, "d1");
  expect(view).toEqual(VIEW);
  expect(source.entries).toEqual(entries);
  expect(await source.contents("data_load_script/Main.qvs")).toEqual({ before: "a\nb", after: "a\nc" });
  expect(await source.contents("media/logo.png")).toEqual({ before: null, after: new Uint8Array([1, 2, 3]) });
  expect(ask.asked).toEqual([
    { kind: "entries", id: "d1" },
    { kind: "contents", id: "d1", path: "data_load_script/Main.qvs" },
    { kind: "contents", id: "d1", path: "media/logo.png" },
  ]);
});

test("a diff the tab no longer has, or a tab that is gone, is an error with its code", async () => {
  const gone = { ok: false, error: { code: "diff-gone", message: "gone" } };
  await expect(loadDiffWindow(askOf({ entries: gone }), "d1")).rejects.toMatchObject({ code: "diff-gone" });
  const silent: Ask = async () => undefined;
  await expect(loadDiffWindow(silent, "d1")).rejects.toMatchObject({ code: "diff-gone" });
  const closed: Ask = async () => { throw new Error("Could not establish connection. Receiving end does not exist."); };
  await expect(loadDiffWindow(closed, "d1")).rejects.toMatchObject({ code: "diff-gone" });
});

const shadow = (container: Element): ShadowRoot => container.querySelector("div")!.shadowRoot!;

test("the window fills itself, has no Maximize and no grip; X and Esc close it", async () => {
  let closed = 0;
  const { container } = render(<DiffWindow ask={askOf()} id="d1" close={() => { closed++; }} />);
  await waitFor(() => expect(shadow(container).textContent).toContain("App against dec8fcc"));
  await waitFor(() => expect(shadow(container).querySelectorAll(".removed").length).toBe(1));
  const overlay = shadow(container).querySelector(".overlay")!;
  expect(overlay.classList.contains("window")).toBe(true);
  expect(shadow(container).querySelector(".grip")).toBeNull();
  const labels = [...shadow(container).querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
  expect(labels).not.toContain("Maximize");
  expect(document.title).toBe("App against dec8fcc – Qommit");

  (shadow(container).querySelector('button[aria-label="Close"]') as HTMLButtonElement).click();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(closed).toBe(2);
});

test("a gone diff says how to get it back", async () => {
  const gone = { ok: false, error: { code: "diff-gone", message: "gone" } };
  const { container } = render(<DiffWindow ask={askOf({ entries: gone })} id="d1" close={() => {}} />);
  await waitFor(() => expect(shadow(container).textContent).toContain("This diff is no longer available."));
});
