import { GITOQLOK_META_ID, LINK_ID, readAppInfo, readGitoqlokMeta, readLink, removeLink, writeLink } from "../../src/qlik/link";
import { APP_ID, makeSnapshot } from "../fixtures/snapshot";
import { QlikTimeoutError } from "../../src/qlik/timeout";
import { appFromSnapshot, fakeDoc } from "./fake-engine";

const LINK = { repo: "lr-bicc/app", branch: "dev", appId: APP_ID, syncedSha: "abc" };
test("link object round trip without saving the app", async () => {
  const fake = fakeDoc(appFromSnapshot(makeSnapshot()));
  expect(await readLink(fake.doc)).toBeNull();
  await writeLink(fake.doc, LINK);
  expect(await readLink(fake.doc)).toEqual(LINK);
  await writeLink(fake.doc, { ...LINK, syncedSha: "def" }); // second write updates, does not create again
  expect(fake.calls.filter((c) => c.startsWith("createObject")).length).toBe(1);
  expect((await readLink(fake.doc))!.syncedSha).toBe("def");
  await removeLink(fake.doc);
  await removeLink(fake.doc);
  expect(await readLink(fake.doc)).toBeNull();
  expect(fake.calls.some((c) => c.startsWith("doSave"))).toBe(false);
});
test("the stored object holds exactly qInfo and link", async () => {
  const app = appFromSnapshot(makeSnapshot());
  await writeLink(fakeDoc(app).doc, LINK);
  expect(app.objects.find((o) => o.props.qInfo.qId === LINK_ID)!.props).toEqual({
    qInfo: { qId: "qommit-link", qType: "qommit-link" },
    link: LINK,
  });
});
test("a malformed link object counts as no link", async () => {
  const app = appFromSnapshot(makeSnapshot());
  app.objects.push({ props: { qInfo: { qId: "qommit-link", qType: "qommit-link" }, link: { repo: "lr-bicc/app" } } });
  expect(await readLink(fakeDoc(app).doc)).toBeNull();
  app.objects[app.objects.length - 1]!.props = { qInfo: { qId: "qommit-link", qType: "qommit-link" }, link: { ...LINK, branch: "" } };
  expect(await readLink(fakeDoc(app).doc)).toBeNull();
  app.objects[app.objects.length - 1]!.props = { qInfo: { qId: "qommit-link", qType: "qommit-link" } };
  expect(await readLink(fakeDoc(app).doc)).toBeNull();
});
test("extra keys of the stored link are not returned", async () => {
  const app = appFromSnapshot(makeSnapshot());
  app.objects.push({ props: { qInfo: { qId: "qommit-link", qType: "qommit-link" }, link: { ...LINK, extra: 1 } } });
  expect(await readLink(fakeDoc(app).doc)).toEqual(LINK);
});
test("other engine failures propagate", async () => {
  const fake = fakeDoc(appFromSnapshot(makeSnapshot()));
  fake.failOn("getObject", LINK_ID);
  await expect(readLink(fake.doc)).rejects.toMatchObject({ code: 15 });
  await expect(writeLink(fake.doc, LINK)).rejects.toMatchObject({ code: 15 });
  fake.failOn("destroyObject", LINK_ID);
  await expect(removeLink(fake.doc)).rejects.toMatchObject({ code: 15 });
});
test("reads repository and last commit from gitoqlok's metadata", async () => {
  const meta = (data: unknown) => {
    const app = appFromSnapshot(makeSnapshot());
    app.objects.push({ props: { qInfo: { qId: GITOQLOK_META_ID, qType: "_gitoqlikMetaData" }, _data: data } });
    return readGitoqlokMeta(fakeDoc(app).doc);
  };
  expect(await meta({ infoByServerType: { github: { lastCommitId: "c97", repoData: { full_name: "lr-bicc/scp" } } } }))
    .toEqual({ repo: "lr-bicc/scp", lastCommitId: "c97" });
  expect(await meta({ repoData: { full_name: "lr-bicc/scp" }, infoByServerType: { github: {} } }))
    .toEqual({ repo: "lr-bicc/scp", lastCommitId: null });
  expect(await meta({ infoByServerType: { github: { repoData: { full_name: "no slash" } } } }))
    .toEqual({ repo: null, lastCommitId: null });
  expect(await meta({ a: [{ full_name: "bad name/x" }, { full_name: "o/n" }], b: { full_name: "p/q" } }))
    .toEqual({ repo: "o/n", lastCommitId: null });
  expect(await meta({ infoByServerType: { github: { lastCommitId: "" } } }))
    .toEqual({ repo: null, lastCommitId: null });
  expect(await readGitoqlokMeta(fakeDoc(appFromSnapshot(makeSnapshot())).doc)).toBeNull();
});
test("reads title and published state", async () => {
  expect(await readAppInfo(fakeDoc(appFromSnapshot(makeSnapshot(), { title: "T", published: true })).doc)).toEqual({ title: "T", published: true });
  const fake = fakeDoc(appFromSnapshot(makeSnapshot()));
  expect(await readAppInfo(fake.doc)).toEqual({ title: "Test app", published: false });
});

describe("missing object detection", () => {
  const notFoundErrors: [string, () => unknown][] = [
    ["enigma Error with code -2", () => Object.assign(new Error("Object not found"), { code: -2 })],
    ["plain code 2 object", () => ({ code: 2, message: "Object not found" })],
  ];
  const withGetObject = (reject: unknown, app = appFromSnapshot(makeSnapshot())) => {
    const fake = fakeDoc(app);
    const orig = fake.doc.getObject!;
    fake.doc.getObject = async (id: string) => {
      await orig(id).catch(() => undefined);
      throw reject;
    };
    return { fake, app };
  };
  test.each(notFoundErrors)("%s counts as missing", async (_n, make) => {
    expect(await readLink(withGetObject(make()).fake.doc)).toBeNull();
    expect(await readGitoqlokMeta(withGetObject(make()).fake.doc)).toBeNull();
    const { fake, app } = withGetObject(make());
    await writeLink(fake.doc, LINK);
    expect(app.objects.some((o) => o.props.qInfo.qId === LINK_ID)).toBe(true);
    await expect(removeLink(withGetObject(make()).fake.doc)).resolves.toBeUndefined();
  });
  test("access denied still propagates", async () => {
    const denied = { code: 5, message: "Access denied" };
    await expect(readLink(withGetObject(denied).fake.doc)).rejects.toBe(denied);
    await expect(readGitoqlokMeta(withGetObject(denied).fake.doc)).rejects.toBe(denied);
    await expect(writeLink(withGetObject(denied).fake.doc, LINK)).rejects.toBe(denied);
  });
});

describe("timeouts", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  test.each([
    ["readLink", "getObject", LINK_ID, (doc: Parameters<typeof readLink>[0]) => readLink(doc)],
    ["writeLink", "getObject", LINK_ID, (doc: Parameters<typeof readLink>[0]) => writeLink(doc, LINK)],
    ["removeLink", "destroyObject", LINK_ID, (doc: Parameters<typeof readLink>[0]) => removeLink(doc)],
    ["readAppInfo", "getAppLayout", "-", (doc: Parameters<typeof readLink>[0]) => readAppInfo(doc)],
    ["readGitoqlokMeta", "getObject", GITOQLOK_META_ID, (doc: Parameters<typeof readLink>[0]) => readGitoqlokMeta(doc)],
  ])("%s: an engine call that never answers rejects with QlikTimeoutError after 30 seconds", async (_name, method, id, run) => {
    const fake = fakeDoc(appFromSnapshot(makeSnapshot()));
    fake.hangOn(method, id);
    const outcome = (run(fake.doc) as Promise<unknown>).catch((e) => e);
    await vi.advanceTimersByTimeAsync(29_999);
    let settled = false;
    void outcome.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBeInstanceOf(QlikTimeoutError);
  });
});
