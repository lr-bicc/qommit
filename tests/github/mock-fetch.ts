export interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

interface Reply { status?: number; body?: unknown; headers?: Record<string, string> }
type Handler = (req: Recorded) => Reply | Promise<Reply>;

const BASE = "https://api.github.com";

export function mockFetch(routes: Record<string, Handler>): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const mocked = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" && init.body !== "" ? JSON.parse(init.body) : undefined;
    const rec: Recorded = { method, url, body };
    calls.push(rec);
    const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
    const handler = routes[`${method} ${path}`];
    const res = handler ? await handler(rec) : { status: 404, body: { message: "Not Found" } };
    const status = res.status ?? 200;
    const headers = new Headers(res.headers ?? {});
    const noBody = status === 204 || res.body === undefined;
    if (res.body instanceof Uint8Array) return new Response(res.body as Uint8Array<ArrayBuffer>, { status, headers }); // raw bytes, e.g. a zipball
    if (!noBody && !headers.has("content-type")) headers.set("content-type", "application/json");
    return new Response(noBody ? null : JSON.stringify(res.body), { status, headers });
  }) as typeof fetch;
  return { fetch: mocked, calls };
}
