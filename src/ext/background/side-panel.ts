import { loadOptions } from "../shared/options";

export function panelOptionsFor(tabId: number, url: string | undefined, servers: string[]): { tabId: number; path: string; enabled: true } {
  let origin: string | null = null;
  if (url) {
    try {
      origin = new URL(url).origin;
    } catch {
      origin = null;
    }
  }
  const own = origin !== null && servers.includes(origin);
  return { tabId, path: own ? `panel.html?tabId=${tabId}` : "panel.html", enabled: true };
}

export function wireSidePanel(): void {
  chrome.runtime.onInstalled.addListener(() => {
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  });

  chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
    void (async () => {
      const { servers } = await loadOptions();
      await chrome.sidePanel.setOptions(panelOptionsFor(tabId, tab.url, servers));
    })();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !("options" in changes)) return;
    void (async () => {
      const { servers } = await loadOptions();
      for (const tab of await chrome.tabs.query({})) {
        if (tab.id === undefined) continue;
        await chrome.sidePanel.setOptions(panelOptionsFor(tab.id, tab.url, servers));
      }
    })();
  });
}
