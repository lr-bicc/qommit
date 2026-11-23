import { createReadme } from "../../src/core/repo-layout";
import { serializeApp } from "../../src/core/serializer";
import type { FileMap } from "../../src/core/types";
import { importApp } from "../../src/ext/flows/import";
import { FlowError } from "../../src/ext/flows/ports";
import { CANON_ID, makeSnapshot } from "../fixtures/snapshot";
import { fakeGitHub, fakeServer } from "./fake-ports";

const repo = "lr-bicc/sales";
const NEW_ID = "00000000-0000-4000-8000-000000000001";
const input = (sha: string) => ({ repo, sha, label: "main" });

function readme(title: string): string {
  return createReadme({ appTitle: title, creatorLogin: "x", createdAt: new Date(0), sheets: [], defaultBranch: "main",
    appUrl: `https://qlik.example.com/qs/sense/app/${CANON_ID}` });
}

/** The maintained files of a repository state: no README, no bookmarks (they are never written). */
function maintainedFiles(): FileMap {
  const snap = makeSnapshot();
  snap.bookmarks = [];
  return serializeApp(snap, { canonicalAppId: CANON_ID });
}

function setup(title = "Sales 📈") {
  const github = fakeGitHub();
  const files = maintainedFiles();
  const sha = github.seed(repo, new Map(files).set("README.md", readme(title)));
  return { github, server: fakeServer(), sha, files };
}

test("import creates a named app, fills it from the repository and saves it", async () => {
  const { github, server, sha, files } = setup();
  const r = await importApp({ github, server }, input(sha));
  expect(r.name).toBe("Sales 📈 (main)");
  expect(r.appId).toBe(NEW_ID);
  expect(r.url).toBe(server.appUrl(NEW_ID));
  expect(server.created.map((c) => c.name)).toEqual(["Sales 📈 (main)"]);
  const app = server.created[0]!.app;
  expect(app.saves).toBe(1);
  expect(serializeApp(app.snapshot, { canonicalAppId: CANON_ID })).toEqual(files);
  expect(app.snapshot.bookmarks).toEqual([]);
});

test("the name falls back to the repository name without the organisation", async () => {
  const github = fakeGitHub();
  const sha = github.seed(repo, maintainedFiles());
  const server = fakeServer();
  expect((await importApp({ github, server }, input(sha))).name).toBe("sales (main)");
});

test("import reports its progress in order", async () => {
  const { github, server, sha } = setup();
  const texts: string[] = [];
  await importApp({ github, server }, input(sha), (t) => texts.push(t));
  for (const t of texts) {
    expect(t).toMatch(/^(Loading repository files… \d+\/\d+|Creating app…|Writing app… \d+\/\d+|Saving app…)$/);
  }
  const stages = texts.map((t) => t.split("…")[0]).filter((k, i, all) => k !== all[i - 1]);
  expect(stages).toEqual(["Loading repository files", "Creating app", "Writing app", "Saving app"]);
  const [done, total] = texts.filter((t) => t.startsWith("Writing app…")).at(-1)!.split("… ")[1]!.split("/");
  expect(done).toBe(total);
  expect(texts.at(-1)).toBe("Saving app…");
});

test("a broken target creates no app", async () => {
  const { server } = setup();
  const github = fakeGitHub();
  const broken = new Map(maintainedFiles());
  broken.set("objects/sheets/bad.json", "{ not json");
  const sha = github.seed(repo, broken);
  const err = await importApp({ github, server }, input(sha)).catch((e) => e);
  expect(err).toBeInstanceOf(FlowError);
  expect(err.code).toBe("invalid-target");
  expect(server.created).toEqual([]);
});

test("a failure while writing reports the incomplete app and still closes the session", async () => {
  const { github, server, sha } = setup();
  server.failNextApplyAt(1, "engine said no");
  const close = vi.fn(async () => {});
  const create = server.createApp.bind(server);
  server.createApp = async (name) => ({ ...(await create(name)), close });
  const err = await importApp({ github, server }, input(sha)).catch((e) => e);
  expect(err).toBeInstanceOf(FlowError);
  expect(err.code).toBe("import-failed");
  expect(err.message).toBe("engine said no");
  expect(err.detail).toEqual({ appId: NEW_ID, url: server.appUrl(NEW_ID) });
  expect(close).toHaveBeenCalledTimes(1);
  expect(server.created).toHaveLength(1);
  expect(server.created[0]!.app.saves).toBe(0);
});

test("a failure to open the created app reports its id and url", async () => {
  const { github, server, sha } = setup();
  server.failAfterCreate("open failed");
  const err = await importApp({ github, server }, input(sha)).catch((e) => e);
  expect(err).toBeInstanceOf(FlowError);
  expect(err.code).toBe("import-failed");
  expect(err.message).toBe("open failed");
  expect(err.detail).toEqual({ appId: NEW_ID, url: server.appUrl(NEW_ID) });
});

test("a creation failure without an app id reports no app", async () => {
  const { github, sha } = setup();
  const server = fakeServer();
  server.createApp = async () => { throw new Error("no quota"); };
  const err = await importApp({ github, server }, input(sha)).catch((e) => e);
  expect(err.code).toBe("import-failed");
  expect(err.detail).toEqual({ appId: null, url: null });
});

test("a close that never settles does not block the result", async () => {
  const { github, server, sha } = setup();
  const create = server.createApp.bind(server);
  server.createApp = async (name) => ({ ...(await create(name)), close: () => new Promise<void>(() => {}) });
  const result = await importApp({ github, server }, input(sha));
  expect(result.appId).toBe(NEW_ID);
});

test("a close that never settles does not block a failure", async () => {
  const { github, server, sha } = setup();
  server.failNextApplyAt(1, "engine said no");
  const create = server.createApp.bind(server);
  server.createApp = async (name) => ({ ...(await create(name)), close: () => new Promise<void>(() => {}) });
  const err = await importApp({ github, server }, input(sha)).catch((e) => e);
  expect(err.code).toBe("import-failed");
  expect(err.message).toBe("engine said no");
});
