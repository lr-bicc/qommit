import { BridgeError, createBridge } from "../../src/ext/panel/bridge";
import { installFakeChrome, type FakeChrome } from "./fake-chrome";

let chrome: FakeChrome;
beforeEach(() => {
  chrome = installFakeChrome();
});

const NO_RECEIVER = "Could not establish connection. Receiving end does not exist.";

test("injects content.js and resends when the tab has no content script", async () => {
  let calls = 0;
  chrome.respond = () => {
    if (++calls === 1) throw new Error(NO_RECEIVER);
    return { ok: true, value: "pong" };
  };
  await expect(createBridge(5).send({ cmd: "ping" })).resolves.toBe("pong");
  expect(chrome.injected).toEqual([{ tabId: 5, files: ["content.js"] }]);
  expect(chrome.tabMessages).toHaveLength(2);
});

test("any other rejection is interrupted: no injection, no second send", async () => {
  chrome.respond = () => {
    throw new Error("The message port closed before a response was received.");
  };
  await expect(createBridge(5).send({ cmd: "createRepository" })).rejects.toMatchObject({ error: { code: "interrupted" } });
  expect(chrome.injected).toEqual([]);
  expect(chrome.tabMessages).toHaveLength(1);
});

test("an undefined answer is interrupted: no injection, no second send", async () => {
  chrome.respond = () => undefined;
  await expect(createBridge(5).send({ cmd: "commit", message: "m", paths: [], removeUnmaintained: false, allowBehind: false })).rejects.toMatchObject({ error: { code: "interrupted" } });
  expect(chrome.injected).toEqual([]);
  expect(chrome.tabMessages).toHaveLength(1);
});

test("a failing retry after the injection is a no-content error", async () => {
  chrome.respond = () => {
    throw new Error(NO_RECEIVER);
  };
  await expect(createBridge(5).send({ cmd: "ping" })).rejects.toMatchObject({ error: { code: "no-content" } });
  expect(chrome.injected).toHaveLength(1);
  expect(chrome.tabMessages).toHaveLength(2);
});

test("a failed result rejects with a BridgeError carrying the error", async () => {
  const error = { code: "no-token", message: "x" };
  chrome.respond = () => ({ ok: false, error });
  const failure = await createBridge(5).send({ cmd: "status" }).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(BridgeError);
  expect((failure as BridgeError).error).toEqual(error);
  expect(chrome.injected).toEqual([]);
});

test("progress events of other tabs do not reach the listener", () => {
  const texts: string[] = [];
  const stop = createBridge(5).onProgress((t) => texts.push(t));
  const event = { target: "panel", event: { event: "progress", text: "Loading" } };
  chrome.emitMessage(event, { id: "qommit-test", tab: { id: 6 } });
  expect(texts).toEqual([]);
  chrome.emitMessage(event, { id: "qommit-test", tab: { id: 5 } });
  expect(texts).toEqual(["Loading"]);
  stop();
  chrome.emitMessage(event, { id: "qommit-test", tab: { id: 5 } });
  expect(texts).toEqual(["Loading"]);
});

test("openOptions opens the options page", () => {
  createBridge(5).openOptions();
  expect(chrome.optionsPageOpened).toBe(1);
});
