// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { PanelRoot } from "../../src/ext/panel/App";
import { installFakeChrome, type FakeChrome } from "./fake-chrome";
import { fakeBridge } from "./fake-bridge";

const HINT = "Qommit works on Qlik Sense servers that are listed in the options.";
let chrome: FakeChrome;
beforeEach(() => {
  chrome = installFakeChrome();
  chrome.store.options = { org: "o", repoPrefix: "", servers: ["https://qlik.example.com"] };
});
afterEach(cleanup);

test("a tab on a configured server gets the panel", async () => {
  chrome.tabs = [{ id: 5, url: "https://qlik.example.com/hub" }];
  render(<PanelRoot tabId={5} createBridge={() => fakeBridge({ status: [{ page: "hub" }] })} />);
  await screen.findByText("Open an app to use Qommit.");
});

test("a panel opened during the sign-in redirect switches to Qommit once the tab is back on the server", async () => {
  chrome.tabs = [{ id: 5, url: "https://login.microsoftonline.com/x" }];
  const made: number[] = [];
  render(<PanelRoot tabId={5} createBridge={(id) => (made.push(id), fakeBridge({ status: [{ page: "hub" }] }))} />);
  await screen.findByText(HINT);
  chrome.emitTabUpdated(5, { status: "loading" }); // no url: nothing to decide
  chrome.emitTabUpdated(6, { url: "https://qlik.example.com/hub" }); // another tab
  await screen.findByText(HINT);
  chrome.emitTabUpdated(5, { url: "https://qlik.example.com/hub" });
  await screen.findByText("Open an app to use Qommit.");
  expect(made).toEqual([5]);
});

test("adding the server in the options switches the open panel", async () => {
  chrome.tabs = [{ id: 5, url: "https://other.example.com/hub" }];
  render(<PanelRoot tabId={5} createBridge={() => fakeBridge({ status: [{ page: "hub" }] })} />);
  await screen.findByText(HINT);
  await globalThis.chrome.storage.local.set({ options: { org: "o", repoPrefix: "", servers: ["https://other.example.com"] } });
  await screen.findByText("Open an app to use Qommit.");
});

test("without a tab, or when the tab cannot be read, the panel shows the hint", async () => {
  render(<PanelRoot tabId={null} createBridge={() => fakeBridge({})} />);
  await screen.findByText(HINT);
  cleanup();
  render(<PanelRoot tabId={9} createBridge={() => fakeBridge({})} />); // tab 9 does not exist
  await waitFor(() => expect(screen.getByText(HINT)).toBeTruthy());
});

test("Escape in the panel closes the diff overlay in the page, which never gets the key while the panel has the focus", async () => {
  chrome.tabs = [{ id: 5, url: "https://qlik.example.com/hub" }];
  const bridge = fakeBridge({ status: [{ page: "hub" }] });
  render(<PanelRoot tabId={5} createBridge={() => bridge} />);
  await screen.findByText("Open an app to use Qommit.");
  fireEvent.keyDown(document, { key: "Enter" });
  expect(bridge.commands.some((c) => c.cmd === "closeDiff")).toBe(false);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(bridge.commands.filter((c) => c.cmd === "closeDiff")).toHaveLength(1);
});
