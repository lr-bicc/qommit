import { panelOptionsFor, wireSidePanel } from "../../src/ext/background/side-panel";
import { installFakeChrome } from "./fake-chrome";

test("every tab gets its own panel, which knows its tab", () => {
  expect(panelOptionsFor(7)).toEqual({ tabId: 7, path: "panel.html?tabId=7", enabled: true });
});

const flush = () => new Promise((r) => setTimeout(r, 0));

test("wireSidePanel: action click opens the panel, tab updates set the tab's panel", async () => {
  const fake = installFakeChrome();
  wireSidePanel();

  await flush();
  fake.panelBehaviors.length = 0;
  fake.emitInstalled();
  await flush();
  expect(fake.panelBehaviors).toEqual([{ openPanelOnActionClick: true }]);

  // the panel decides itself whether its tab shows a Qlik server: a tab on the sign-in page gets the same panel
  fake.emitTabUpdated(3, {}, { id: 3, url: "https://login.microsoftonline.com/x" });
  await flush();
  expect(fake.panelOptions).toEqual([{ tabId: 3, path: "panel.html?tabId=3", enabled: true }]);
});

test("wireSidePanel: a new tab gets its own panel as soon as it is created, before it loads", async () => {
  const fake = installFakeChrome();
  wireSidePanel();
  await flush();
  fake.panelOptions.length = 0;
  fake.emitTabCreated({ id: 4, windowId: 1 });
  fake.emitTabCreated({ windowId: 1 }); // no id: skipped
  await flush();
  expect(fake.panelOptions).toEqual([{ tabId: 4, path: "panel.html?tabId=4", enabled: true }]);
});

test("wireSidePanel at start: the action opens the panel and tabs that are already open get their panel", async () => {
  const fake = installFakeChrome();
  fake.tabs = [{ id: 1, url: "https://qlik.example.com/qs/sense/app/a" }, { id: 2, url: "https://x.example.com/" }, { url: "https://noid.example.com/" }];
  wireSidePanel();
  await flush();
  expect(fake.panelBehaviors).toEqual([{ openPanelOnActionClick: true }]);
  expect(fake.panelOptions).toEqual([
    { tabId: 1, path: "panel.html?tabId=1", enabled: true },
    { tabId: 2, path: "panel.html?tabId=2", enabled: true },
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
