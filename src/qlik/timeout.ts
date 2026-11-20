export class QlikTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QlikTimeoutError";
  }
}

/** Every engine call in the reader and the link object helpers. */
export const ENGINE_CALL_TIMEOUT_MS = 30_000;
export const ENGINE_TIMEOUT_MESSAGE = "Qlik did not answer in time.";

/** Rejects with QlikTimeoutError when `promise` has not settled after `ms`; the timer is cleared once it settles. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new QlikTimeoutError(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** One engine call with the engine call timeout. */
export const engineCall = <T>(promise: Promise<T>): Promise<T> => withTimeout(promise, ENGINE_CALL_TIMEOUT_MS, ENGINE_TIMEOUT_MESSAGE);
