import { createContentFiles, createContentStore } from "../../src/qlik/content-files";
import { QlikReadError, readApp } from "../../src/qlik/reader";
import { APP_ID, makeSnapshot } from "../fixtures/snapshot";
import { appFromSnapshot, fakeDoc } from "./fake-engine";
import type { FakeApp } from "./fake-engine";

const loc = { origin: "https://host", prefix: "/qs" };
const base = (): FakeApp => appFromSnapshot({ ...makeSnapshot(), staticFiles: new Map() });

describe("ContentFiles.list", () => {
  test("returns the decoded names behind /appcontent/<id>/", async () => {
    const app = { ...base(), libraryFiles: [`/appcontent/${APP_ID}/Stock%20Availability.png`, `/appcontent/${APP_ID}/a.png`] };
    const files = createContentFiles(fakeDoc(app).doc, loc, APP_ID, vi.fn() as unknown as typeof fetch);
    expect(await files.list()).toEqual(["Stock Availability.png", "a.png"]);
  });
  test("keeps slashes of nested paths and decodes non-ASCII names", async () => {
    const app = { ...base(), libraryFiles: [`/appcontent/${APP_ID}/img/K%C3%BCche%20%26%20Bad.png`] };
    const files = createContentFiles(fakeDoc(app).doc, loc, APP_ID, vi.fn() as unknown as typeof fetch);
    expect(await files.list()).toEqual(["img/Küche & Bad.png"]);
  });
  test("returns [] without an app-specific library", async () => {
    const files = createContentFiles(fakeDoc(base()).doc, loc, APP_ID, vi.fn() as unknown as typeof fetch);
    expect(await files.list()).toEqual([]);
  });
  test("rejects a url that is not below /appcontent/<id>/ instead of dropping the file", async () => {
    const app = { ...base(), libraryFiles: ["/somewhere/else.png"] };
    const files = createContentFiles(fakeDoc(app).doc, loc, APP_ID, vi.fn() as unknown as typeof fetch);
    await expect(files.list()).rejects.toBeInstanceOf(QlikReadError);
  });
  test("a name that cannot be decoded is used as it is", async () => {
    const app = { ...base(), libraryFiles: [`/appcontent/${APP_ID}/100%.png`, `/appcontent/${APP_ID}/a%20b.png`] };
    const files = createContentFiles(fakeDoc(app).doc, loc, APP_ID, vi.fn() as unknown as typeof fetch);
    expect(await files.list()).toEqual(["100%.png", "a b.png"]);
  });
  test("an engine failure becomes QlikReadError", async () => {
    const fake = fakeDoc({ ...base(), libraryFiles: [`/appcontent/${APP_ID}/a.png`] });
    fake.failOn("getLibraryContent", "__appcontent");
    await expect(createContentFiles(fake.doc, loc, APP_ID, vi.fn() as unknown as typeof fetch).list()).rejects.toBeInstanceOf(QlikReadError);
  });
});

describe("ContentFiles.list answers", () => {
  const f = vi.fn() as unknown as typeof fetch;
  test("GetContentLibraries without qItems fails", async () => {
    const doc = { ...fakeDoc(base()).doc, getContentLibraries: async () => ({}) };
    await expect(createContentFiles(doc, loc, APP_ID, f).list()).rejects.toThrow(/Could not list static files.*qItems/);
  });
  test("GetLibraryContent without qItems fails instead of listing no files", async () => {
    const doc = { ...fakeDoc({ ...base(), libraryFiles: [`/appcontent/${APP_ID}/a.png`] }).doc, getLibraryContent: async () => ({}) };
    const err = await createContentFiles(doc, loc, APP_ID, f).list().catch((e) => e);
    expect(err).toBeInstanceOf(QlikReadError);
    expect(err.message).toMatch(/qItems/);
  });
});

describe("ContentFiles.download", () => {
  test("GETs the encoded url with credentials and returns the bytes", async () => {
    const f = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const files = createContentFiles(fakeDoc(base()).doc, loc, APP_ID, f as unknown as typeof fetch);
    expect(await files.download("Stock Availability.png")).toEqual(new Uint8Array([1, 2, 3]));
    expect(f).toHaveBeenCalledWith(`https://host/qs/appcontent/${APP_ID}/Stock%20Availability.png`, expect.objectContaining({ credentials: "include" }));
  });
  test("encodes nested names segment by segment", async () => {
    const f = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    const files = createContentFiles(fakeDoc(base()).doc, loc, APP_ID, f as unknown as typeof fetch);
    await files.download("img/Küche & Bad.png");
    expect(f).toHaveBeenCalledWith(`https://host/qs/appcontent/${APP_ID}/img/K%C3%BCche%20%26%20Bad.png`, expect.anything());
  });
  test("status 404 throws QlikReadError", async () => {
    const f = vi.fn(async () => new Response("nope", { status: 404 }));
    const files = createContentFiles(fakeDoc(base()).doc, loc, APP_ID, f as unknown as typeof fetch);
    await expect(files.download("x.png")).rejects.toBeInstanceOf(QlikReadError);
  });
  test("a redirected answer is a sign-in page, not a file", async () => {
    const res = new Response(new Uint8Array([1]), { status: 200 });
    Object.defineProperty(res, "redirected", { value: true });
    const files = createContentFiles(fakeDoc(base()).doc, loc, APP_ID, (async () => res) as unknown as typeof fetch);
    const err = await files.download("x.png").catch((e) => e);
    expect(err).toBeInstanceOf(QlikReadError);
    expect(err.message).toMatch(/x\.png.*looks like a sign-in page/);
  });
  test("an HTML answer is a sign-in page, not a file", async () => {
    const res = new Response("<html></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    const files = createContentFiles(fakeDoc(base()).doc, loc, APP_ID, (async () => res) as unknown as typeof fetch);
    const err = await files.download("x.png").catch((e) => e);
    expect(err).toBeInstanceOf(QlikReadError);
    expect(err.message).toMatch(/looks like a sign-in page/);
  });
  test("a download that never answers fails after 60 seconds", async () => {
    vi.useFakeTimers();
    try {
      const files = createContentFiles(fakeDoc(base()).doc, loc, APP_ID, (() => new Promise<Response>(() => {})) as unknown as typeof fetch);
      const outcome = files.download("x.png").catch((e) => e);
      let settled = false;
      void outcome.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const err = await outcome;
      expect(err).toBeInstanceOf(QlikReadError);
      expect(err.message).toMatch(/x\.png.*did not answer in time/);
    } finally {
      vi.useRealTimers();
    }
  });
  test("a network failure throws QlikReadError", async () => {
    const f = vi.fn(async () => { throw new TypeError("net"); });
    const files = createContentFiles(fakeDoc(base()).doc, loc, APP_ID, f as unknown as typeof fetch);
    await expect(files.download("x.png")).rejects.toBeInstanceOf(QlikReadError);
  });
});

describe("readApp with files", () => {
  test("puts the downloaded files into staticFiles in list order", async () => {
    const app = { ...base(), libraryFiles: [`/appcontent/${APP_ID}/b%20b.png`, `/appcontent/${APP_ID}/a.png`] };
    const f = vi.fn(async (url: string) => new Response(new Uint8Array([url.endsWith("a.png") ? 1 : 2]), { status: 200 }));
    const files = createContentFiles(fakeDoc(app).doc, loc, APP_ID, f as unknown as typeof fetch);
    const snap = await readApp(fakeDoc(app).doc, APP_ID, { published: false, files });
    expect([...snap.staticFiles]).toEqual([["b b.png", new Uint8Array([2])], ["a.png", new Uint8Array([1])]]);
  });
  test("a failed download fails the whole read", async () => {
    const app = { ...base(), libraryFiles: [`/appcontent/${APP_ID}/a.png`] };
    const f = vi.fn(async () => new Response("", { status: 500 }));
    const files = createContentFiles(fakeDoc(app).doc, loc, APP_ID, f as unknown as typeof fetch);
    await expect(readApp(fakeDoc(app).doc, APP_ID, { published: false, files })).rejects.toBeInstanceOf(QlikReadError);
  });
  test("without files option staticFiles is empty and nothing is listed", async () => {
    const fake = fakeDoc({ ...base(), libraryFiles: [`/appcontent/${APP_ID}/a.png`] });
    expect((await readApp(fake.doc, APP_ID, { published: false })).staticFiles.size).toBe(0);
    expect(fake.calls.some((c) => c.startsWith("getContentLibraries"))).toBe(false);
  });
});

describe("createContentStore", () => {
  interface Seen { line: string; headers: Record<string, string>; body: unknown }
  const recorder = (status: number) => {
    const seen: Seen[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ line: `${init?.method} ${String(url)}`, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
      return new Response(null, { status });
    }) as typeof fetch;
    return { seen, fetchFn };
  };
  const xrfkeyOf = (line: string): string => /xrfkey=([^&]+)/.exec(line)![1]!;

  test("upload and delete go to the QRS with an xrfkey", async () => {
    const { seen, fetchFn } = recorder(201);
    const store = createContentStore(loc, "app1", fetchFn);
    const bytes = new Uint8Array([1]);
    await store.put("Stock Availability.png", bytes);
    await store.remove("Stock Availability.png");
    expect(seen[0]!.line).toMatch(/^POST https:\/\/host\/qs\/qrs\/appcontent\/app1\/uploadfile\?externalpath=Stock%20Availability\.png&overwrite=true&xrfkey=[A-Za-z0-9]{16}$/);
    expect(seen[0]!.headers["X-Qlik-Xrfkey"]).toBe(xrfkeyOf(seen[0]!.line));
    expect(seen[0]!.headers["Content-Type"]).toBe("application/octet-stream");
    expect(seen[0]!.body).toBe(bytes);
    expect(seen[1]!.line).toMatch(/^DELETE https:\/\/host\/qs\/qrs\/appcontent\/app1\/deletecontent\?externalpath=Stock%20Availability\.png&xrfkey=[A-Za-z0-9]{16}$/);
    expect(seen[1]!.headers["X-Qlik-Xrfkey"]).toBe(xrfkeyOf(seen[1]!.line));
    expect(xrfkeyOf(seen[0]!.line)).not.toBe(xrfkeyOf(seen[1]!.line));
  });
  test("a failed upload names the file", async () => {
    const store = createContentStore(loc, "app1", recorder(403).fetchFn);
    await expect(store.put("a.png", new Uint8Array([1]))).rejects.toThrow("Could not upload a.png: HTTP 403");
  });
  test("a failed delete names the file", async () => {
    const store = createContentStore(loc, "app1", recorder(500).fetchFn);
    await expect(store.remove("a.png")).rejects.toThrow("Could not delete a.png: HTTP 500");
  });
  test("a network failure names the file", async () => {
    const store = createContentStore(loc, "app1", (async () => { throw new TypeError("net down"); }) as typeof fetch);
    await expect(store.put("a.png", new Uint8Array([1]))).rejects.toThrow("Could not upload a.png: net down");
  });
  test("a request that never answers is cut off after 60 seconds", async () => {
    vi.useFakeTimers();
    try {
      const store = createContentStore(loc, "app1", (() => new Promise<Response>(() => {})) as unknown as typeof fetch);
      const outcome = store.put("a.png", new Uint8Array([1])).catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(59_999);
      let settled = false;
      void outcome.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(((await outcome) as Error).message).toBe("Could not upload a.png: Qlik did not answer in time.");
    } finally {
      vi.useRealTimers();
    }
  });
});
