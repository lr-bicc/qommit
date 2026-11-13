import { fetchCsrfToken, openSession, QlikSessionError } from "../../src/qlik/session";
import type { EnigmaCreate, EnigmaSession } from "../../src/qlik/session";
import type { EngineApi } from "../../src/qlik/engine-types";

const loc = { origin: "https://host", prefix: "/qs", appId: "APP" };

function fakeFetch(res: Response | Error) {
  return vi.fn(async () => {
    if (res instanceof Error) throw res;
    return res;
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("fetchCsrfToken", () => {
  test("returns the header value and calls the token endpoint with credentials", async () => {
    const f = fakeFetch(new Response(null, { status: 204, headers: { "qlik-csrf-token": "tok" } }));
    expect(await fetchCsrfToken(loc, f)).toBe("tok");
    expect(f).toHaveBeenCalledWith("https://host/qs/qps/csrftoken", expect.objectContaining({ credentials: "include" }));
  });
  test("returns null without header", async () => {
    expect(await fetchCsrfToken(loc, fakeFetch(new Response(null, { status: 204 })))).toBeNull();
  });
  test("returns null when fetch rejects", async () => {
    expect(await fetchCsrfToken(loc, fakeFetch(new TypeError("net")))).toBeNull();
  });
});

interface FakeOpts {
  openDoc?: () => Promise<EngineApi>;
  open?: () => Promise<EngineApi>;
  auth?: unknown;
}
function makeCreate(opts: FakeOpts = {}) {
  const handlers = new Map<string, (...a: unknown[]) => void>();
  const doc: EngineApi = { id: "doc" } as unknown as EngineApi;
  const activeDoc: EngineApi = { id: "active" } as unknown as EngineApi;
  const close = vi.fn(async () => {});
  const global = {
    openDoc: vi.fn(opts.openDoc ?? (async () => doc)),
    getActiveDoc: vi.fn(async () => activeDoc),
  } as unknown as EngineApi;
  const session: EnigmaSession = {
    open: opts.open ?? (async () => {
      if (opts.auth) handlers.get("notification:OnAuthenticationInformation")?.(opts.auth);
      return global;
    }),
    close,
    on: (e, h) => void handlers.set(e, h),
  };
  const create = vi.fn(((_cfg) => session) as EnigmaCreate);
  return { create, handlers, doc, activeDoc, close, global };
}

describe("openSession", () => {
  test("passes the url with token and opens the doc", async () => {
    const f = fakeFetch(new Response(null, { status: 204, headers: { "qlik-csrf-token": "t/1" } }));
    const m = makeCreate();
    const s = await openSession(loc, { fetch: f, create: m.create });
    const cfg = m.create.mock.calls[0][0];
    expect(cfg.url).toBe("wss://host/qs/app/APP?qlik-csrf-token=t%2F1");
    expect(cfg.schema).toBeTruthy();
    expect(m.global.openDoc).toHaveBeenCalledWith("APP");
    expect(s.doc).toBe(m.doc);
    expect(s.appId).toBe("APP");
    expect(s.user).toBe("");
    expect(s.isClosed()).toBe(false);
  });

  test("falls back to getActiveDoc when openDoc fails", async () => {
    const m = makeCreate({ openDoc: async () => { throw new Error("already open"); } });
    const s = await openSession(loc, { fetch: fakeFetch(new TypeError("x")), create: m.create });
    expect(s.doc).toBe(m.activeDoc);
    expect(m.create.mock.calls[0][0].url).toBe("wss://host/qs/app/APP");
  });

  test("closes the session and throws when both doc calls fail", async () => {
    const m = makeCreate({ openDoc: async () => { throw new Error("nope"); } });
    (m.global.getActiveDoc as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no active doc"));
    const p = openSession(loc, { fetch: fakeFetch(new TypeError("x")), create: m.create });
    await expect(p).rejects.toBeInstanceOf(QlikSessionError);
    await expect(p).rejects.toThrow("no active doc");
    expect(m.close).toHaveBeenCalled();
  });

  test("takes the user from OnAuthenticationInformation", async () => {
    const m = makeCreate({ auth: { userId: "r.vasilev", userDirectory: "LR" } });
    const s = await openSession(loc, { fetch: fakeFetch(new TypeError("x")), create: m.create });
    expect(s.user).toBe("r.vasilev");
  });

  test("isClosed turns true after the closed event; close() never throws", async () => {
    const m = makeCreate();
    const s = await openSession(loc, { fetch: fakeFetch(new TypeError("x")), create: m.create });
    m.handlers.get("closed")!({ code: 1006 });
    expect(s.isClosed()).toBe(true);
    m.close.mockRejectedValue(new Error("already closed"));
    await expect(s.close()).resolves.toBeUndefined();
  });

  test("throws QlikSessionError when open() fails", async () => {
    const m = makeCreate({ open: async () => { throw new Error("socket refused"); } });
    const p = openSession(loc, { fetch: fakeFetch(new TypeError("x")), create: m.create });
    await expect(p).rejects.toBeInstanceOf(QlikSessionError);
    await expect(p).rejects.toThrow("socket refused");
  });
});
