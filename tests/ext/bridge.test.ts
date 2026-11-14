import { BridgeError, createBridge } from "../../src/ext/panel/bridge";
import { installFakeChrome, type FakeChrome } from "./fake-chrome";

let chrome: FakeChrome;
beforeEach(() => {
  chrome = installFakeChrome();
});

test("injects content.js once when nobody answers, then retries", async () => {
  let calls = 0;
  chrome.respond = () => (++calls === 1 ? undefined : { ok: true, value: "pong" });
  const bridge = createBridge(5);
  await expect(bridge.send({ cmd: "ping" })).resolves.toBe("pong");
  expect(chrome.injected).toEqual([{ tabId: 5, files: ["content.js"] }]);
  expect(chrome.tabMessages.map((m) => m.message)).toEqual([
    { target: "content", command: { cmd: "ping" } },
    { target: "content", command: { cmd: "ping" } },
  ]);
});

test("a rejected first attempt also triggers the injection", async () => {
  let calls = 0;
  chrome.respond = () => {
    if (++calls === 1) throw new Error("Could not establish connection");
    return { ok: true, value: 1 };
  };
  await expect(createBridge(5).send({ cmd: "status" })).resolves.toBe(1);
  expect(chrome.injected).toHaveLength(1);
});

test("no answer after the injection is a no-content error", async () => {
  chrome.respond = () => undefined;
  await expect(createBridge(5).send({ cmd: "ping" })).rejects.toMatchObject({ error: { code: "no-content" } });
  expect(chrome.injected).toHaveLength(1);
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
