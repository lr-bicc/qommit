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
