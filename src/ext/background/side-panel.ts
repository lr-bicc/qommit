/**
 * Every tab gets its own panel that knows its tab. Whether the tab shows a configured Qlik server is decided by the
 * panel itself (panel/tab-server.ts): Chrome does not reload an open panel when its path changes, so a panel opened
 * while the tab was on another page (such as the sign-in redirect) must notice when the tab reaches the server.
 */
export function panelOptionsFor(tabId: number): { tabId: number; path: string; enabled: true } {
  return { tabId, path: `panel.html?tabId=${tabId}`, enabled: true };
}

/** Sets the panel options of every open tab; a tab without an id is skipped. */
async function applyToAllTabs(): Promise<void> {
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id === undefined) continue;
    await chrome.sidePanel.setOptions(panelOptionsFor(tab.id));
  }
}

const openOnActionClick = (): Promise<void> => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

export function wireSidePanel(): void {
  // The worker also starts after a browser start or a reload of the extension, without onInstalled:
  // tabs that were open before get their panel now. Failures here must not stop the worker.
  void openOnActionClick().catch(() => {});
  void applyToAllTabs().catch(() => {});

  chrome.runtime.onInstalled.addListener(() => {
    void openOnActionClick().catch(() => {});
  });

  chrome.tabs.onUpdated.addListener((tabId) => {
    void chrome.sidePanel.setOptions(panelOptionsFor(tabId)).catch(() => {});
  });
}
