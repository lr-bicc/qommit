import { QlikTimeoutError, withTimeout } from "../../src/qlik/timeout";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

test("a promise that settles in time passes through and clears its timer", async () => {
  await expect(withTimeout(Promise.resolve(42), 1000, "late")).resolves.toBe(42);
  await expect(withTimeout(Promise.reject(new Error("boom")), 1000, "late")).rejects.toThrow("boom");
  expect(vi.getTimerCount()).toBe(0);
});

test("a promise that never settles rejects with QlikTimeoutError after the given time", async () => {
  const p = withTimeout(new Promise<never>(() => {}), 1000, "Qlik did not answer in time.");
  const outcome = p.catch((e) => e);
  await vi.advanceTimersByTimeAsync(999);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  const err = await outcome;
  expect(err).toBeInstanceOf(QlikTimeoutError);
  expect(err.message).toBe("Qlik did not answer in time.");
});
