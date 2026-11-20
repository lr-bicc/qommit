import { loadOptions } from "../shared/options";

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Calls `listener` with whether the tab shows one of the configured Qlik servers: once at the start, again whenever
 * the tab navigates to a URL the extension may see, and whenever the options change. Returns the unsubscribe function.
 */
export function watchTabServer(tabId: number, listener: (onServer: boolean) => void): () => void {
  let stopped = false;
  let latest = 0;
  const check = async (knownUrl?: string): Promise<void> => {
    const run = ++latest;
    let onServer = false;
    try {
      const [{ servers }, url] = await Promise.all([
        loadOptions(),
        knownUrl ?? chrome.tabs.get(tabId).then((tab) => tab.url),
      ]);
      const origin = originOf(url);
      onServer = origin !== null && servers.includes(origin);
    } catch {
      onServer = false; // tab gone or unreadable
    }
    if (!stopped && run === latest) listener(onServer);
  };
  const onUpdated = (id: number, changeInfo: { url?: string }): void => {
    if (id === tabId && typeof changeInfo.url === "string") void check(changeInfo.url);
  };
  const onChanged = (changes: Record<string, unknown>, area: string): void => {
    if (area === "local" && "options" in changes) void check();
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.storage.onChanged.addListener(onChanged);
  void check();
  return () => {
    stopped = true;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.storage.onChanged.removeListener(onChanged);
  };
}
