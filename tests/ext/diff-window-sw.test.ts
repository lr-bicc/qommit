import { openDiffWindow, wireDiffWindow } from "../../src/ext/background/diff-window";
import { installFakeChrome } from "./fake-chrome";

const flush = () => new Promise((r) => setTimeout(r, 0));
const urlOf = (tabId: number, id: string): string => `chrome-extension://qommit-test/diff.html?tabId=${tabId}&id=${id}`;

test("the first diff of a Qlik tab opens a maximized pop-up window", async () => {
  const fake = installFakeChrome();
  await openDiffWindow(7, "a");
  expect(fake.windows).toEqual([{ id: 1, url: urlOf(7, "a"), type: "popup", state: "maximized", focused: true }]);
  expect(fake.session["diffWindow:7"]).toBe(1);
});

test("with the screen of the Qlik tab, a new window gets 80 % of it as its normal size and is maximized after", async () => {
  const fake = installFakeChrome();
  await openDiffWindow(7, "a", { left: -1920, top: 0, width: 1920, height: 1040 });
  expect(fake.windows).toEqual([{
    id: 1, url: urlOf(7, "a"), type: "popup", state: "maximized", focused: true,
    left: -1920 + 192, top: 104, width: 1536, height: 832,
  }]);
});

test("further diffs of the tab reuse its window, where the user put it", async () => {
  const fake = installFakeChrome();
  await openDiffWindow(7, "a");
  fake.windows[0]!.focused = false;
  await openDiffWindow(7, "b");
  expect(fake.windows).toEqual([{ id: 1, url: urlOf(7, "b"), type: "popup", state: "maximized", focused: true }]);
});

test("each Qlik tab has its own window", async () => {
  const fake = installFakeChrome();
  await openDiffWindow(7, "a");
  await openDiffWindow(8, "b");
  expect(fake.windows.map((w) => w.url)).toEqual([urlOf(7, "a"), urlOf(8, "b")]);
});

test("closing the window tells the Qlik tab; the next diff opens a new window", async () => {
  const fake = installFakeChrome();
  wireDiffWindow();
  await openDiffWindow(7, "a");
  await chrome.windows.remove(1);
  await flush();
  await flush();
  expect(fake.tabMessages).toEqual([{ tabId: 7, message: { target: "diffWindowContent", kind: "closed" } }]);
  expect(fake.session["diffWindow:7"]).toBeUndefined();
  await openDiffWindow(7, "b");
  expect(fake.windows.map((w) => w.id)).toEqual([2]);
});

test("a window that is gone without notice is replaced", async () => {
  const fake = installFakeChrome();
  await openDiffWindow(7, "a");
  fake.windows = [];
  fake.tabs = [];
  await openDiffWindow(7, "b");
  expect(fake.windows).toEqual([{ id: 2, url: urlOf(7, "b"), type: "popup", state: "maximized", focused: true }]);
});

test("closing the Qlik tab closes its diff window", async () => {
  const fake = installFakeChrome();
  wireDiffWindow();
  await openDiffWindow(7, "a");
  fake.emitTabRemoved(7);
  await flush();
  await flush();
  expect(fake.windows).toEqual([]);
  expect(fake.session["diffWindow:7"]).toBeUndefined();
});

test("only Qommit's own content scripts can open a window", async () => {
  const fake = installFakeChrome();
  wireDiffWindow();
  const answers: unknown[] = [];
  fake.emitMessage({ target: "diffWindow", id: "a" }, { id: "other-extension", tab: { id: 7 } }, (r) => answers.push(r));
  fake.emitMessage({ target: "diffWindow", id: "a" }, { id: "qommit-test" }, (r) => answers.push(r));
  fake.emitMessage({ target: "diffWindow", id: "a", area: { left: 0, top: 0, width: 1000, height: 500 } }, { id: "qommit-test", tab: { id: 7 } }, (r) => answers.push(r));
  await flush();
  await flush();
  await flush();
  expect(answers).toEqual([
    { ok: false, error: expect.objectContaining({ code: "not-allowed" }) },
    { ok: false, error: expect.objectContaining({ code: "not-allowed" }) },
    { ok: true, value: null },
  ]);
  expect(fake.windows).toEqual([{
    id: 1, url: urlOf(7, "a"), type: "popup", state: "maximized", focused: true, left: 100, top: 50, width: 800, height: 400,
  }]);
});
