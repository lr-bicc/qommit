import { panelOptionsFor, wireSidePanel } from "../../src/ext/background/side-panel";
import { installFakeChrome } from "./fake-chrome";

test("tabs on configured servers get their own panel", () => {
  const servers = ["https://qlik.example.com"];
  expect(panelOptionsFor(7, "https://qlik.example.com/qs/sense/app/x", servers)).toEqual({ tabId: 7, path: "panel.html?tabId=7", enabled: true });
  expect(panelOptionsFor(7, "https://other.example.com/", servers)).toEqual({ tabId: 7, path: "panel.html", enabled: true });
  expect(panelOptionsFor(7, undefined, servers)).toEqual({ tabId: 7, path: "panel.html", enabled: true });
  expect(panelOptionsFor(7, "not a url", servers)).toEqual({ tabId: 7, path: "panel.html", enabled: true });
});

const flush = () => new Promise((r) => setTimeout(r, 0));

test("wireSidePanel: action click opens panel, tab updates and option changes set panel options", async () => {
  const fake = installFakeChrome();
  fake.store.options = { org: "o", repoPrefix: "", servers: ["https://qlik.example.com"] };
  wireSidePanel();

  await flush();
  fake.panelBehaviors.length = 0;
  fake.emitInstalled();
  await flush();
  expect(fake.panelBehaviors).toEqual([{ openPanelOnActionClick: true }]);

  fake.emitTabUpdated(3, {}, { id: 3, url: "https://qlik.example.com/x" });
  await flush();
  expect(fake.panelOptions).toEqual([{ tabId: 3, path: "panel.html?tabId=3", enabled: true }]);

  fake.panelOptions.length = 0;
  fake.tabs = [{ id: 1, url: "https://qlik.example.com/a" }, { id: 2, url: "https://x.example.com/" }, { url: "https://qlik.example.com/noid" }];
  await chrome.storage.local.set({ secret: { token: "t" } }); // other key: ignored
  await flush();
  expect(fake.panelOptions).toEqual([]);
  await chrome.storage.local.set({ options: { org: "o", repoPrefix: "", servers: ["https://x.example.com"] } });
  await flush();
  expect(fake.panelOptions).toEqual([
    { tabId: 1, path: "panel.html", enabled: true },
    { tabId: 2, path: "panel.html?tabId=2", enabled: true },
  ]);
});

test("wireSidePanel at start: the action opens the panel and tabs that are already open get their panel", async () => {
  const fake = installFakeChrome();
  fake.store.options = { org: "o", repoPrefix: "", servers: ["https://qlik.example.com"] };
  fake.tabs = [{ id: 1, url: "https://qlik.example.com/qs/sense/app/a" }, { id: 2, url: "https://x.example.com/" }];
  wireSidePanel();
  await flush();
  expect(fake.panelBehaviors).toEqual([{ openPanelOnActionClick: true }]);
  expect(fake.panelOptions).toEqual([
    { tabId: 1, path: "panel.html?tabId=1", enabled: true },
    { tabId: 2, path: "panel.html", enabled: true },
  ]);
});

test("wireSidePanel at start swallows failing calls", async () => {
  installFakeChrome();
  const api = chrome as any;
  api.sidePanel.setPanelBehavior = () => Promise.reject(new Error("no side panel"));
  api.tabs.query = () => Promise.reject(new Error("no tabs"));
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    expect(() => wireSidePanel()).not.toThrow();
    await flush();
    await flush();
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
