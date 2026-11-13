import { createContentFiles } from "../../src/qlik/content-files";
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
