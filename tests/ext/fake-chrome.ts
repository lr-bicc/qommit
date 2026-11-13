/** Test double for the `chrome` extension APIs used by Qommit. Installed on globalThis by installFakeChrome(). */

type Listener = (...args: any[]) => unknown;

function eventTarget() {
  const listeners = new Set<Listener>();
  return {
    listeners,
    addListener: (fn: Listener) => void listeners.add(fn),
    removeListener: (fn: Listener) => void listeners.delete(fn),
    hasListener: (fn: Listener) => listeners.has(fn),
  };
}

export interface FakeChrome {
  store: Record<string, unknown>; // chrome.storage.local contents
  grantPermissions: boolean; // answer of chrome.permissions.request
  permissionRequests: string[][]; // origins of each request
  removedPermissions: string[][]; // origins of each chrome.permissions.remove call
  sent: unknown[]; // chrome.runtime.sendMessage payloads
  respond: (message: any) => unknown; // answer for runtime.sendMessage / tabs.sendMessage
  tabs: { id?: number; url?: string; active?: boolean }[]; // result of chrome.tabs.query
  tabMessages: { tabId: number; message: unknown }[];
  injected: { tabId: number; files: string[] }[]; // chrome.scripting.executeScript calls
  panelOptions: unknown[]; // chrome.sidePanel.setOptions calls
  panelBehaviors: unknown[]; // chrome.sidePanel.setPanelBehavior calls
  optionsPageOpened: number;
  emitMessage(message: unknown, sender?: unknown): void; // fires runtime.onMessage listeners
  emitInstalled(details?: unknown): void; // fires runtime.onInstalled listeners
  emitTabUpdated(tabId: number, changeInfo: unknown, tab?: unknown): void; // fires tabs.onUpdated listeners
}

export function installFakeChrome(): FakeChrome {
  const onChanged = eventTarget();
  const onMessage = eventTarget();
  const onInstalled = eventTarget();
  const onUpdated = eventTarget();

  const fake: FakeChrome = {
    store: {},
    grantPermissions: true,
    permissionRequests: [],
    removedPermissions: [],
    sent: [],
    respond: () => undefined,
    tabs: [],
    tabMessages: [],
    injected: [],
    panelOptions: [],
    panelBehaviors: [],
    optionsPageOpened: 0,
    emitMessage(message, sender = { id: "qommit-test" }) {
      for (const fn of [...onMessage.listeners]) fn(message, sender, () => {});
    },
    emitInstalled(details = { reason: "install" }) {
      for (const fn of [...onInstalled.listeners]) fn(details);
    },
    emitTabUpdated(tabId, changeInfo, tab = { id: tabId }) {
      for (const fn of [...onUpdated.listeners]) fn(tabId, changeInfo, tab);
    },
  };

  const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

  // `respond` throwing rejects the call; returning undefined means nobody answered.
  const answer = async (message: unknown) => clone(fake.respond(message));

  const storageLocal = {
    async get(keys?: string | string[] | null) {
      const wanted = keys == null ? Object.keys(fake.store) : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of wanted) if (key in fake.store) out[key] = clone(fake.store[key]);
      return out;
    },
    async set(items: Record<string, unknown>) {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: clone(fake.store[key]), newValue: clone(value) };
        fake.store[key] = clone(value);
      }
      for (const fn of [...onChanged.listeners]) fn(changes, "local");
    },
    async remove(keys: string | string[]) {
      const changes: Record<string, { oldValue?: unknown }> = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (!(key in fake.store)) continue;
        changes[key] = { oldValue: clone(fake.store[key]) };
        delete fake.store[key];
      }
      for (const fn of [...onChanged.listeners]) fn(changes, "local");
    },
  };

  (globalThis as any).chrome = {
    storage: { local: storageLocal, onChanged },
    permissions: {
      async request(req: { origins?: string[] }) {
        fake.permissionRequests.push([...(req.origins ?? [])]);
        return fake.grantPermissions;
      },
      async remove(req: { origins?: string[] }) {
        fake.removedPermissions.push([...(req.origins ?? [])]);
        return true;
      },
    },
    runtime: {
      id: "qommit-test",
      async sendMessage(message: unknown) {
        fake.sent.push(clone(message));
        return answer(message);
      },
      async openOptionsPage() {
        fake.optionsPageOpened++;
      },
      onMessage,
      onInstalled,
    },
    tabs: {
      async sendMessage(tabId: number, message: unknown) {
        fake.tabMessages.push({ tabId, message: clone(message) });
        return answer(message);
      },
      async query() {
        return clone(fake.tabs);
      },
      onUpdated,
    },
    scripting: {
      async executeScript(injection: { target: { tabId: number }; files?: string[] }) {
        fake.injected.push({ tabId: injection.target.tabId, files: [...(injection.files ?? [])] });
        return [];
      },
    },
    sidePanel: {
      async setOptions(options: unknown) {
        fake.panelOptions.push(clone(options));
      },
      async setPanelBehavior(behavior: unknown) {
        fake.panelBehaviors.push(clone(behavior));
      },
    },
  };
  return fake;
}
