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
  session: Record<string, unknown>; // chrome.storage.session contents
  sessionAccessLevels: unknown[]; // chrome.storage.session.setAccessLevel arguments
  grantPermissions: boolean; // answer of chrome.permissions.request
  permissionRequests: string[][]; // origins of each request
  removedPermissions: string[][]; // origins of each chrome.permissions.remove call
  sent: unknown[]; // chrome.runtime.sendMessage payloads
  respond: (message: any) => unknown; // answer for runtime.sendMessage / tabs.sendMessage
  tabs: { id?: number; url?: string; active?: boolean; windowId?: number }[]; // result of chrome.tabs.query
  windows: { id: number; url: string; type?: string; state?: string; focused?: boolean }[]; // open windows (chrome.windows.create)
  tabMessages: { tabId: number; message: unknown }[];
  injected: { tabId: number; files: string[] }[]; // chrome.scripting.executeScript calls
  panelOptions: unknown[]; // chrome.sidePanel.setOptions calls
  panelBehaviors: unknown[]; // chrome.sidePanel.setPanelBehavior calls
  optionsPageOpened: number;
  emitMessage(message: unknown, sender?: unknown, sendResponse?: (response: unknown) => void): void; // fires runtime.onMessage listeners
  emitWindowRemoved(windowId: number): void; // fires windows.onRemoved listeners
  emitTabRemoved(tabId: number): void; // fires tabs.onRemoved listeners
  emitInstalled(details?: unknown): void; // fires runtime.onInstalled listeners
  emitTabUpdated(tabId: number, changeInfo: unknown, tab?: unknown): void; // fires tabs.onUpdated listeners
}

export function installFakeChrome(): FakeChrome {
  const onChanged = eventTarget();
  const onMessage = eventTarget();
  const onInstalled = eventTarget();
  const onUpdated = eventTarget();
  const onWindowRemoved = eventTarget();
  const onTabRemoved = eventTarget();
  let nextWindowId = 1;

  const fake: FakeChrome = {
    store: {},
    session: {},
    sessionAccessLevels: [],
    grantPermissions: true,
    permissionRequests: [],
    removedPermissions: [],
    sent: [],
    respond: () => undefined,
    tabs: [],
    windows: [],
    tabMessages: [],
    injected: [],
    panelOptions: [],
    panelBehaviors: [],
    optionsPageOpened: 0,
    emitMessage(message, sender = { id: "qommit-test" }, sendResponse = () => {}) {
      const delivered = clone(message);
      for (const fn of [...onMessage.listeners]) fn(delivered, sender, sendResponse);
    },
    emitWindowRemoved(windowId) {
      for (const fn of [...onWindowRemoved.listeners]) fn(windowId);
    },
    emitTabRemoved(tabId) {
      for (const fn of [...onTabRemoved.listeners]) fn(tabId, { windowId: 0, isWindowClosing: false });
    },
    emitInstalled(details = { reason: "install" }) {
      for (const fn of [...onInstalled.listeners]) fn(details);
    },
    emitTabUpdated(tabId, changeInfo, tab = { id: tabId }) {
      for (const fn of [...onUpdated.listeners]) fn(tabId, changeInfo, tab);
    },
  };

  // Chrome serialises messages and storage values as JSON: Map, Uint8Array etc. do not survive.
  const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

  // `respond` throwing rejects the call; returning undefined means nobody answered.
  const answer = async (message: unknown) => clone(fake.respond(message));

  const storageArea = (name: string, contents: () => Record<string, unknown>) => ({
    async get(keys?: string | string[] | null) {
      const data = contents();
      const wanted = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of wanted) if (key in data) out[key] = clone(data[key]);
      return out;
    },
    async set(items: Record<string, unknown>) {
      const data = contents();
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: clone(data[key]), newValue: clone(value) };
        data[key] = clone(value);
      }
      for (const fn of [...onChanged.listeners]) fn(changes, name);
    },
    async remove(keys: string | string[]) {
      const data = contents();
      const changes: Record<string, { oldValue?: unknown }> = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (!(key in data)) continue;
        changes[key] = { oldValue: clone(data[key]) };
        delete data[key];
      }
      for (const fn of [...onChanged.listeners]) fn(changes, name);
    },
  });
  const storageLocal = storageArea("local", () => fake.store);
  const storageSession = {
    ...storageArea("session", () => fake.session),
    async setAccessLevel(options: unknown) {
      fake.sessionAccessLevels.push(clone(options));
    },
  };

  (globalThis as any).chrome = {
    storage: { local: storageLocal, session: storageSession, onChanged },
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
      getURL: (path: string) => `chrome-extension://qommit-test/${path}`,
      async sendMessage(message: unknown) {
        const sent = clone(message);
        fake.sent.push(sent);
        return answer(sent);
      },
      async openOptionsPage() {
        fake.optionsPageOpened++;
      },
      onMessage,
      onInstalled,
    },
    tabs: {
      async sendMessage(tabId: number, message: unknown) {
        const sent = clone(message);
        fake.tabMessages.push({ tabId, message: sent });
        return answer(sent);
      },
      async query(info: { windowId?: number } = {}) {
        return clone(fake.tabs.filter((t) => info.windowId === undefined || t.windowId === info.windowId));
      },
      async update(tabId: number, props: { url?: string }) {
        const tab = fake.tabs.find((t) => t.id === tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        if (props.url !== undefined) {
          tab.url = props.url;
          const win = fake.windows.find((w) => w.id === tab.windowId);
          if (win) win.url = props.url;
        }
        return clone(tab);
      },
      onRemoved: onTabRemoved,
      async get(tabId: number) {
        const tab = fake.tabs.find((t) => t.id === tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        return clone(tab);
      },
      onUpdated,
    },
    scripting: {
      async executeScript(injection: { target: { tabId: number }; files?: string[] }) {
        fake.injected.push({ tabId: injection.target.tabId, files: [...(injection.files ?? [])] });
        return [];
      },
    },
    windows: {
      async create(data: { url: string; type?: string; state?: string }) {
        const id = nextWindowId++;
        fake.windows.push({ id, url: data.url, type: data.type, state: data.state, focused: true });
        fake.tabs.push({ id: 1000 + id, url: data.url, windowId: id });
        return { id };
      },
      async update(windowId: number, info: { focused?: boolean }) {
        const win = fake.windows.find((w) => w.id === windowId);
        if (!win) throw new Error(`No window with id: ${windowId}.`);
        if (info.focused !== undefined) win.focused = info.focused;
        return clone(win);
      },
      async remove(windowId: number) {
        const at = fake.windows.findIndex((w) => w.id === windowId);
        if (at < 0) throw new Error(`No window with id: ${windowId}.`);
        fake.windows.splice(at, 1);
        fake.tabs = fake.tabs.filter((t) => t.windowId !== windowId);
        fake.emitWindowRemoved(windowId);
      },
      onRemoved: onWindowRemoved,
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
