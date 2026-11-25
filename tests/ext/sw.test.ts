import { installFakeChrome } from "./fake-chrome";

test("service worker answers gateway messages only from its own extension", async () => {
  const fake = installFakeChrome();
  fake.store.secret = { token: "" };
  vi.resetModules();
  await import("../../src/ext/background/sw");
  const listener = [...(chrome.runtime.onMessage as any).listeners][0] as (m: unknown, s: unknown, r: (x: unknown) => void) => unknown;

  const answers: unknown[] = [];
  const done = new Promise((r) => setTimeout(r, 20));
  const request = { target: "gateway", request: { op: "whoAmI", args: [] } };
  expect(listener(request, { id: "qommit-test" }, (x) => answers.push(x))).toBe(true);
  expect(listener(request, { id: "evil" }, (x) => answers.push(x))).toBeUndefined();
  expect(listener({ target: "content" }, { id: "qommit-test" }, (x) => answers.push(x))).toBeUndefined();
  await done;
  expect(answers).toContainEqual({ ok: false, error: { kind: "not-allowed", message: "Sender is not allowed" } });
  expect(answers).toContainEqual({ ok: false, error: { kind: "no-token", message: "No GitHub token configured" } });
  expect(answers.length).toBe(2);
});

test("the service worker lets content scripts use storage.session", async () => {
  const fake = installFakeChrome();
  vi.resetModules();
  await import("../../src/ext/background/sw");
  expect(fake.sessionAccessLevels).toEqual([{ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" }]);
});

test("a failing setAccessLevel is reported without the token and does not throw", async () => {
  const fake = installFakeChrome();
  fake.store.secret = { token: "ghp_secret" };
  (chrome.storage.session as any).setAccessLevel = async () => { throw new Error("not supported"); };
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.resetModules();
  await import("../../src/ext/background/sw");
  await new Promise((r) => setTimeout(r, 0));
  expect(warn).toHaveBeenCalled();
  expect(JSON.stringify(warn.mock.calls)).not.toContain("ghp_secret");
  warn.mockRestore();
});
