/**
 * Calls `listener` with the active tab of the window this page belongs to (null: none, or unreadable): once at the
 * start and again whenever another tab of that window becomes active. Returns the unsubscribe function.
 *
 * For the general panel, which Chrome shows on a tab that has no panel of its own yet (such as an app the hub just
 * opened in a new tab): it has no tab in its path and follows the tab it is shown beside.
 */
export function watchActiveTab(listener: (tabId: number | null) => void): () => void {
  let stopped = false;
  let windowId: number | undefined;
  let switched = false; // a tab was activated before the first answer: that answer is out of date
  const report = (tabId: number | null): void => {
    if (!stopped) listener(tabId);
  };
  const onActivated = (info: { tabId: number; windowId: number }): void => {
    if (windowId === undefined || info.windowId !== windowId) return;
    switched = true;
    report(info.tabId);
  };
  chrome.tabs.onActivated.addListener(onActivated);
  void (async () => {
    let tabId: number | null = null;
    try {
      windowId = (await chrome.windows.getCurrent()).id;
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      tabId = tab?.id ?? null;
    } catch {
      tabId = null; // window or tab unreadable
    }
    if (!switched) report(tabId);
  })();
  return () => {
    stopped = true;
    chrome.tabs.onActivated.removeListener(onActivated);
  };
}
