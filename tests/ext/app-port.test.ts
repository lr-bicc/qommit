import { createAppPort } from "../../src/ext/content/app-port";
import type { EngineSession } from "../../src/qlik/session";
import { APP_ID, makeSnapshot } from "../fixtures/snapshot";
import { appFromSnapshot, fakeDoc } from "../qlik/fake-engine";

const LOC = { origin: "https://qlik.example.com", prefix: "/qs", appId: APP_ID };

function setup(published = false) {
  const fake = fakeDoc(appFromSnapshot(makeSnapshot(), { title: "Sales", published }));
  const session: EngineSession = { doc: fake.doc, appId: APP_ID, user: "r.vasilev", isClosed: () => false, close: async () => {} };
  const fetched: string[] = [];
  const fetchFn = (async (url: string | URL | Request) => {
    fetched.push(String(url));
    return new Response(new Uint8Array([137, 80, 78, 71]));
  }) as typeof fetch;
  return { fake, port: createAppPort(session, LOC, fetchFn), fetched };
}

test("info holds the app's title, state, url and the session user", async () => {
  const { port } = setup();
  expect(await port.info()).toEqual({
    id: APP_ID, title: "Sales", published: false, url: `https://qlik.example.com/qs/sense/app/${APP_ID}`, user: "r.vasilev",
  });
});

test("read without files does not touch the content library", async () => {
  const { port, fake, fetched } = setup();
  const snap = await port.read({ includeFiles: false });
  expect(snap.appId).toBe(APP_ID);
  expect(snap.staticFiles.size).toBe(0);
  expect(fake.calls.some((c) => c.startsWith("getContentLibraries") || c.startsWith("getLibraryContent"))).toBe(false);
  expect(fetched).toEqual([]);
});

test("read with files downloads the static files and reports progress", async () => {
  const { port, fetched } = setup();
  const seen: [number, number][] = [];
  const snap = await port.read({ includeFiles: true, onProgress: (d, t) => seen.push([d, t]) });
  expect([...snap.staticFiles.keys()]).toEqual(["logo.png"]);
  expect(fetched).toHaveLength(1);
  expect(seen.length).toBeGreaterThan(0);
  const [done, total] = seen[seen.length - 1]!;
  expect(done).toBe(total);
});

test("the link and the gitoqlok metadata go through the app object", async () => {
  const { port } = setup();
  expect(await port.readLink()).toBeNull();
  const link = { repo: "lr-bicc/sales", branch: "main", appId: APP_ID, syncedSha: "abc" };
  await port.writeLink(link);
  expect(await port.readLink()).toEqual(link);
  await port.removeLink();
  expect(await port.readLink()).toBeNull();
  expect(await port.readGitoqlokMeta()).toBeNull();
});
