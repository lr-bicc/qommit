import { installFakeChrome } from "./fake-chrome";

test("runtime.sendMessage serialises payload and response as JSON", async () => {
  const c = installFakeChrome();
  let seen: unknown;
  c.respond = (m) => {
    seen = m;
    return { map: new Map([[1, 2]]), bytes: new Uint8Array([1, 2]) };
  };
  const answer = await chrome.runtime.sendMessage({ map: new Map([[1, 2]]), bytes: new Uint8Array([1, 2]), n: 1 });
  expect(seen).toEqual({ map: {}, bytes: { 0: 1, 1: 2 }, n: 1 });
  expect(c.sent).toEqual([seen]);
  expect(answer).toEqual({ map: {}, bytes: { 0: 1, 1: 2 } });
});

test("tabs.sendMessage serialises payload and response as JSON", async () => {
  const c = installFakeChrome();
  let seen: unknown;
  c.respond = (m) => {
    seen = m;
    return new Map([[1, 2]]);
  };
  const answer = await chrome.tabs.sendMessage(7, { map: new Map([[1, 2]]), bytes: new Uint8Array([3]) });
  expect(seen).toEqual({ map: {}, bytes: { 0: 3 } });
  expect(c.tabMessages).toEqual([{ tabId: 7, message: seen }]);
  expect(answer).toEqual({});
});

test("emitMessage delivers a JSON copy to listeners", () => {
  const c = installFakeChrome();
  const got: unknown[] = [];
  chrome.runtime.onMessage.addListener((m: unknown) => void got.push(m));
  c.emitMessage({ map: new Map([[1, 2]]) });
  expect(got).toEqual([{ map: {} }]);
});

test("storage serialises values as JSON", async () => {
  const c = installFakeChrome();
  await chrome.storage.local.set({ k: new Map([[1, 2]]), plain: { a: [1] } });
  expect(c.store.k).toEqual({});
  expect(await chrome.storage.local.get("k")).toEqual({ k: {} });
  expect(await chrome.storage.local.get(["plain"])).toEqual({ plain: { a: [1] } });
});
