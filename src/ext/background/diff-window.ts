import type { CommandResult } from "../shared/commands";
import { diffWindowPath, type DiffWindowMessage, type OpenDiffWindow, type ScreenArea } from "../shared/diff-window";

/** The diff window of each Qlik tab, in storage.session: the worker may be stopped between two diffs. */
const PREFIX = "diffWindow:";
const keyOf = (tabId: number): string => `${PREFIX}${tabId}`;

async function storedWindow(tabId: number): Promise<number | null> {
  const value = (await chrome.storage.session.get(keyOf(tabId)))[keyOf(tabId)];
  return typeof value === "number" ? value : null;
}

/** The normal size of a new window: 80 % of the screen, centred. */
export function normalBounds(area: ScreenArea): ScreenArea {
  const width = Math.round(area.width * 0.8);
  const height = Math.round(area.height * 0.8);
  return {
    left: area.left + Math.round((area.width - width) / 2),
    top: area.top + Math.round((area.height - height) / 2),
    width, height,
  };
}

/**
 * Shows the diff `id` of the Qlik tab `tabId` in its own window: a maximized pop-up without tabs, address bar or side
 * panel. A window this tab already has is reused where the user put it, and brought to the front.
 *
 * A new window opens at its normal size first and is maximized after: Windows takes that size when the window is
 * restored or dragged off its maximized state. Created maximized, its normal size is the whole screen and it can
 * hardly be moved.
 */
export async function openDiffWindow(tabId: number, id: string, area?: ScreenArea): Promise<void> {
  const url = chrome.runtime.getURL(diffWindowPath(tabId, id));
  const windowId = await storedWindow(tabId);
  if (windowId !== null) {
    try {
      const [tab] = await chrome.tabs.query({ windowId });
      if (tab?.id !== undefined) {
        await chrome.tabs.update(tab.id, { url });
        await chrome.windows.update(windowId, { focused: true });
        return;
      }
    } catch {
      // closed without notice: a new window follows
    }
  }
  const created = area === undefined
    ? await chrome.windows.create({ url, type: "popup", state: "maximized" })
    : await chrome.windows.create({ url, type: "popup", ...normalBounds(area) });
  if (created?.id === undefined) return;
  await chrome.storage.session.set({ [keyOf(tabId)]: created.id });
  if (area !== undefined) await chrome.windows.update(created.id, { state: "maximized" });
}

/** A diff window was closed: its Qlik tab shows the next diffs in the page again. */
async function windowClosed(windowId: number): Promise<void> {
  const all = await chrome.storage.session.get(null);
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(PREFIX) || value !== windowId) continue;
    await chrome.storage.session.remove(key);
    const closed: DiffWindowMessage = { target: "diffWindowContent", kind: "closed" };
    // rejects when the tab has no content script (any more)
    await chrome.tabs.sendMessage(Number(key.slice(PREFIX.length)), closed).catch(() => {});
  }
}

/** The Qlik tab is closed: its diff window has nothing left to show. */
async function tabClosed(tabId: number): Promise<void> {
  const windowId = await storedWindow(tabId);
  if (windowId === null) return;
  await chrome.storage.session.remove(keyOf(tabId));
  await chrome.windows.remove(windowId).catch(() => {});
}

const validArea = (area: unknown): ScreenArea | undefined => {
  if (typeof area !== "object" || area === null) return undefined;
  const a = area as Record<string, unknown>;
  const ok = ["left", "top", "width", "height"].every((k) => typeof a[k] === "number" && Number.isFinite(a[k]))
    && (a.width as number) > 0 && (a.height as number) > 0;
  return ok ? { left: a.left as number, top: a.top as number, width: a.width as number, height: a.height as number } : undefined;
};

export function wireDiffWindow(): void {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const m = message as Partial<OpenDiffWindow> | null;
    if (m?.target !== "diffWindow") return undefined;
    const tabId = sender.tab?.id;
    if (sender.id !== chrome.runtime.id || tabId === undefined || typeof m.id !== "string") {
      const denied: CommandResult = { ok: false, error: { code: "not-allowed", message: "Sender is not allowed" } };
      sendResponse(denied);
      return undefined;
    }
    openDiffWindow(tabId, m.id, validArea(m.area)).then(
      () => sendResponse({ ok: true, value: null } satisfies CommandResult),
      (e: unknown) => sendResponse({ ok: false, error: { code: "internal", message: e instanceof Error ? e.message : String(e) } } satisfies CommandResult),
    );
    return true;
  });
  chrome.windows.onRemoved.addListener((windowId) => { void windowClosed(windowId).catch(() => {}); });
  chrome.tabs.onRemoved.addListener((tabId) => { void tabClosed(tabId).catch(() => {}); });
}
