import { serializeApp } from "../../src/core/serializer";
import { createReadme } from "../../src/core/repo-layout";
import { createRouter } from "../../src/ext/content/router";
import type { Command, ProgressEvent } from "../../src/ext/shared/commands";
import { GatewayError } from "../../src/ext/shared/github-port";
import { suggestBranchName } from "../../src/ext/flows/setup";
import { QlikReadError } from "../../src/qlik/reader";
import { QlikSessionError, type EngineSession } from "../../src/qlik/session";
import { APP_ID, makeSnapshot } from "../fixtures/snapshot";
import { appFromSnapshot, fakeDoc } from "../qlik/fake-engine";
import { fakeCache, fakeGitHub } from "./fake-ports";

const appPage = (id: string) => `https://qlik.example.com/qs/sense/app/${id}/overview`;
const OTHER_ID = "33333333-3333-4333-8333-333333333333";
const REPO = "lr-bicc/sales";

function setup(init: { url?: string; linked?: boolean; linkBranch?: string; published?: boolean; now?: () => Date; emit?: (e: ProgressEvent) => unknown } = {}) {
  let url = init.url ?? appPage(APP_ID);
  const github = fakeGitHub();
  const cache = fakeCache();
  const app = appFromSnapshot(makeSnapshot(), { title: "Sales", published: init.published ?? false });
  if (init.linked) {
    const files = serializeApp(makeSnapshot(), { canonicalAppId: APP_ID });
    files.set("README.md", createReadme({ appTitle: "Sales", creatorLogin: "x", createdAt: new Date(0), sheets: [],
      defaultBranch: "main", appUrl: `https://qlik.example.com/qs/sense/app/${APP_ID}` }));
    const sha = github.seed(REPO, files);
    app.objects.push({ props: { qInfo: { qId: "qommit-link", qType: "qommit-link" }, link: { repo: REPO, branch: init.linkBranch ?? "main", appId: APP_ID, syncedSha: sha } } });
  }
  const sessions = { opened: 0, closed: 0, reads: 0, maxReads: 0, failNext: false, drop: () => {}, openError: null as Error | null };
  const events: ProgressEvent[] = [];
  let clock = 0;
  const router = createRouter({
    currentUrl: () => url,
    async openSession(loc) {
      sessions.opened++;
      if (sessions.openError) throw sessions.openError;
      const fake = fakeDoc(app);
      if (sessions.failNext) { sessions.failNext = false; fake.failOn("getScript", "-"); }
      const doc = {
        ...fake.doc,
        async getAllInfos() {
          sessions.reads++;
          sessions.maxReads = Math.max(sessions.maxReads, sessions.reads);
          try { return await fake.doc.getAllInfos(); } finally { sessions.reads--; }
        },
      };
      let closed = false;
      sessions.drop = () => { closed = true; };
      const session: EngineSession = {
        doc, appId: loc.appId, user: "r.vasilev", isClosed: () => closed,
        close: async () => { closed = true; sessions.closed++; },
      };
      return session;
    },
    github, cache,
    loadOptions: async () => ({ org: "lr-bicc", repoPrefix: "", servers: [] }),
    fetch: (async () => new Response(new Uint8Array([137, 80, 78, 71]))) as typeof fetch,
    now: init.now ?? (() => new Date(clock += 1000)),
    emit: (e) => { events.push(e); return init.emit?.(e) as void; },
  });
  return {
    run: router, sessions, events, github, cache, app,
    setUrl: (u: string) => { url = u; },
    failNextRead: () => { sessions.failNext = true; },
  };
}
const texts = (events: ProgressEvent[]) => events.map((e) => e.text);
const COMMIT: Command = { cmd: "commit", message: "m", paths: [], removeUnmaintained: false, allowBehind: false };

test("hub pages have no app", async () => {
  const { run } = setup({ url: "https://qlik.example.com/qs/hub" });
  expect(await run({ cmd: "status" })).toEqual({ ok: true, value: { page: "hub" } });
  expect(await run({ cmd: "localChanges" })).toMatchObject({ ok: false, error: { code: "no-app" } });
  expect(await run({ cmd: "listRepos" })).toMatchObject({ ok: false, error: { code: "no-app" } });
  expect(await run({ cmd: "ping" })).toEqual({ ok: true, value: "pong" });
});

test("a page that is not Qlik behaves like the hub", async () => {
  const { run, sessions } = setup({ url: "https://example.com/" });
  expect(await run({ cmd: "status" })).toEqual({ ok: true, value: { page: "hub" } });
  expect(await run(COMMIT)).toMatchObject({ ok: false, error: { code: "no-app" } });
  expect(sessions.opened).toBe(0);
});

test("a command after navigating to another app opens a new session", async () => {
  const { run, sessions, setUrl } = setup({ url: appPage(APP_ID) });
  await run({ cmd: "status" }); await run({ cmd: "status" });
  expect(sessions.opened).toBe(1);
  setUrl(appPage(OTHER_ID));
  const view = (await run({ cmd: "status" })) as any;
  expect(sessions.opened).toBe(2);
  expect(sessions.closed).toBe(1);
  expect(view.value.app.id).toBe(OTHER_ID);
});

test("a session that was closed by the server is replaced", async () => {
  const { run, sessions } = setup();
  await run({ cmd: "status" });
  sessions.drop();
  await run({ cmd: "status" });
  expect(sessions.opened).toBe(2);
});

test("a failed read reports qlik-read and the next command reconnects", async () => {
  const { run, sessions, failNextRead } = setup({ url: appPage(APP_ID), linked: true });
  failNextRead();
  expect(await run({ cmd: "localChanges" })).toMatchObject({ ok: false, error: { code: "qlik-read" } });
  expect(sessions.closed).toBe(1);
  expect(await run({ cmd: "localChanges" })).toMatchObject({ ok: true });
  expect(sessions.opened).toBe(2);
});

test("a session that cannot be opened reports qlik-session and is retried", async () => {
  const { run, sessions } = setup();
  sessions.openError = new QlikSessionError("socket refused");
  expect(await run({ cmd: "status" })).toEqual({ ok: false, error: { code: "qlik-session", message: "socket refused" } });
  sessions.openError = null;
  expect(await run({ cmd: "status" })).toMatchObject({ ok: true });
  expect(sessions.opened).toBe(2);
});

test("unlinked app: create repository, then the status is linked", async () => {
  const { run } = setup({ url: appPage(APP_ID) });
  expect(((await run({ cmd: "status" })) as any).value.status.state).toBe("unlinked");
  expect(await run(COMMIT)).toMatchObject({ ok: false, error: { code: "not-linked" } });
  expect(await run({ cmd: "createRepository" })).toMatchObject({ ok: true });
  expect(((await run({ cmd: "status" })) as any).value.status.state).toBe("linked");
});

test("the status view carries the app and the suggested branch", async () => {
  const { run } = setup();
  const view = (await run({ cmd: "status" })) as any;
  expect(view.value.page).toBe("app");
  expect(view.value.app).toMatchObject({ id: APP_ID, title: "Sales", user: "r.vasilev" });
  expect(view.value.suggestedBranch).toBe(suggestBranchName("r.vasilev"));
});

test("a gateway error keeps its kind, sso url and reset time", async () => {
  const { run, github } = setup({ linked: true });
  github.getRepo = async () => { throw new GatewayError("sso-required", "needs SSO", { ssoUrl: "https://github.com/sso?x" }); };
  expect(await run({ cmd: "status" })).toEqual({
    ok: false, error: { code: "sso-required", message: "needs SSO", ssoUrl: "https://github.com/sso?x" },
  });
  github.getRepo = async () => { throw new GatewayError("rate-limited", "slow down", { resetAt: 123 }); };
  expect(await run({ cmd: "status" })).toMatchObject({ ok: false, error: { code: "rate-limited", resetAt: 123 } });
});

test("other errors are internal and carry only the message", async () => {
  const { run, github } = setup({ linked: true });
  github.getRepo = async () => { throw Object.assign(new Error("boom"), { secret: "token" }); };
  expect(await run({ cmd: "status" })).toEqual({ ok: false, error: { code: "internal", message: "boom" } });
  expect(await run({ cmd: "nope" } as unknown as Command)).toMatchObject({ ok: false, error: { code: "internal" } });
});

test("a read error from the flows maps to qlik-read with the message", async () => {
  const { run, github } = setup({ linked: true });
  github.getRepo = async () => { throw new QlikReadError("Could not read script"); };
  expect(await run({ cmd: "status" })).toEqual({ ok: false, error: { code: "qlik-read", message: "Could not read script" } });
});

test("commands run one after another", async () => {
  const { run, sessions } = setup({ linked: true });
  const results = await Promise.all([run({ cmd: "localChanges" }), run({ cmd: "localChanges" }), run({ cmd: "localChanges" })]);
  expect(results.every((r) => r.ok)).toBe(true);
  expect(sessions.maxReads).toBe(1);
  expect(sessions.opened).toBe(1);
});

test("a failed command does not block the queue behind it", async () => {
  const { run } = setup({ url: "https://qlik.example.com/qs/hub" });
  const [a, b] = await Promise.all([run({ cmd: "localChanges" }), run({ cmd: "ping" })]);
  expect(a.ok).toBe(false);
  expect(b).toEqual({ ok: true, value: "pong" });
});

test("every command ends with Ready, also after an error", async () => {
  const { run, events } = setup();
  await run({ cmd: "localChanges" });
  expect(texts(events).at(-1)).toBe("Ready");
  events.length = 0;
  await run({ cmd: "ping" });
  expect(texts(events)).toEqual(["Ready"]);
});

test("a throwing or rejecting emit does not fail the command", async () => {
  const thrower = setup({ emit: () => { throw new Error("no listener"); } });
  expect(await thrower.run({ cmd: "status" })).toMatchObject({ ok: true });
  const rejecter = setup({ linked: true, emit: () => Promise.reject(new Error("no receiver")) });
  expect(await rejecter.run({ cmd: "localChanges" })).toMatchObject({ ok: true });
});

test("progress is throttled to one event per 250 ms, the last one always passes", async () => {
  const slow = setup({ linked: true, now: () => new Date(0) });
  await slow.run({ cmd: "localChanges" });
  const progress = texts(slow.events).filter((t) => t !== "Ready");
  const last = /^Loading application data… (\d+)\/(\d+)$/.exec(progress.at(-1)!)!;
  expect(last[1]).toBe(last[2]);
  expect(progress).toEqual([`Loading application data… 0/${last[2]}`, progress.at(-1)]);

  let t = 0;
  const fast = setup({ linked: true, now: () => new Date((t += 300)) });
  await fast.run({ cmd: "localChanges" });
  const all = texts(fast.events).filter((x) => x !== "Ready");
  expect(all).toHaveLength(Number(last[2]) + 1); // 0/N .. N/N
});

test("history lists the commits of the linked branch", async () => {
  const { run } = setup({ linked: true });
  const res = (await run({ cmd: "history", page: 1 })) as any;
  expect(res.value.defaultBranch).toBe("main");
  expect(res.value.commits.map((c: any) => c.message)).toEqual(["Initial commit"]);
});

test("history needs a linked app", async () => {
  const { run } = setup();
  expect(await run({ cmd: "history", page: 1 })).toMatchObject({ ok: false, error: { code: "not-linked" } });
});

test("listRepos and listBranches", async () => {
  const { run, github } = setup();
  github.seed("lr-bicc/a", new Map([["README.md", "x"]]));
  expect(await run({ cmd: "listRepos" })).toEqual({ ok: true, value: [{ repo: "lr-bicc/a", defaultBranch: "main" }] });
  expect(await run({ cmd: "listBranches", repo: "lr-bicc/a" })).toEqual({ ok: true, value: { defaultBranch: "main", branches: ["main"] } });
  expect(await run({ cmd: "listBranches", repo: "lr-bicc/nope" })).toMatchObject({ ok: false, error: { code: "repo-not-found" } });
});

test("local changes of a published app need a synced commit", async () => {
  const { run } = setup({ published: true });
  expect(await run({ cmd: "localChanges" })).toMatchObject({ ok: false, error: { code: "not-linked" } });
});

test("local changes of a linked app are computed against the synced commit", async () => {
  const { run } = setup({ linked: true });
  const res = (await run({ cmd: "localChanges" })) as any;
  expect(res.value).toMatchObject({ repo: REPO });
  expect(Array.isArray(res.value.items)).toBe(true);
});

test("a successful commit drops the remembered status", async () => {
  const { run, app, github } = setup({ linked: true });
  const before = ((await run({ cmd: "status" })) as any).value.status;
  expect(before.state).toBe("linked");
  app.dimensions.push({ qInfo: { qId: "d-new", qType: "dimension" }, qMetaDef: { title: "Region" } });
  const changes = (await run({ cmd: "localChanges" })) as any;
  const paths = changes.value.items.map((i: any) => i.path);
  expect(paths).toContain("objects/dimensions/d-new.json");
  const res = (await run({ ...COMMIT, paths })) as any;
  expect(res.ok).toBe(true);
  expect(res.value.sha).toBe(github.head(REPO, "main"));
  const after = ((await run({ cmd: "status" })) as any).value.status;
  expect(after.link.syncedSha).toBe(res.value.sha);
});

test("create branch for a duplicated app", async () => {
  const { run, app } = setup({ linked: true });
  // the same object, but the app is a copy: the link names another app id
  const link = app.objects.find((o) => o.props.qInfo.qId === "qommit-link")!.props as any;
  link.link.appId = OTHER_ID;
  const view = (await run({ cmd: "status" })) as any;
  expect(view.value.status.state).toBe("duplicated");
  const res = (await run({ cmd: "createBranch", name: "copy", fromSource: true })) as any;
  expect(res).toMatchObject({ ok: true, value: { repo: REPO, branch: "copy", appId: APP_ID } });
  expect(((await run({ cmd: "status" })) as any).value.status.state).toBe("linked");
});

test("create branch needs a copy or a missing branch", async () => {
  const { run } = setup({ linked: true });
  expect(await run({ cmd: "createBranch", name: "x", fromSource: false })).toMatchObject({ ok: false, error: { code: "not-linked" } });
});

test("create branch after the linked branch disappeared", async () => {
  const { run, github } = setup({ linked: true, linkBranch: "dev" });
  expect(((await run({ cmd: "status" })) as any).value.status.state).toBe("branch-missing");
  const res = await run({ cmd: "createBranch", name: "dev2", fromSource: false });
  expect(res).toMatchObject({ ok: true, value: { repo: REPO, branch: "dev2", appId: APP_ID } });
  expect(await github.getBranchSha(REPO, "dev2")).not.toBeNull();
  expect(((await run({ cmd: "status" })) as any).value.status.state).toBe("linked");
});

test("connect and unlink", async () => {
  const { run, github, app } = setup();
  github.seed("lr-bicc/shared", new Map([["README.md", "# shared\n"]]));
  const linked = await run({ cmd: "connect", repo: "lr-bicc/shared", mode: "new-branch", branch: "r.vasilev" });
  expect(linked).toMatchObject({ ok: true, value: { repo: "lr-bicc/shared", branch: "r.vasilev", appId: APP_ID } });
  expect(((await run({ cmd: "status" })) as any).value.status.state).toBe("linked");
  expect(await run({ cmd: "unlink" })).toEqual({ ok: true, value: null });
  expect(app.objects.some((o) => o.props.qInfo.qId === "qommit-link")).toBe(false);
  expect(((await run({ cmd: "status" })) as any).value.status.state).toBe("unlinked");
});

test("the router never puts the options or raw error objects into a result", async () => {
  const { run, github } = setup({ linked: true });
  github.getRepo = async () => { throw Object.assign(new Error("boom"), { deps: { token: "ghp_x" } }); };
  expect(JSON.stringify(await run({ cmd: "status" }))).not.toContain("ghp_x");
});
