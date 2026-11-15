import { gitBlobSha } from "../../src/core/git-hash";
import { createRouter } from "../../src/ext/content/router";
import { handleGateway } from "../../src/ext/background/gateway";
import type { Command, CommandResult, ProgressEvent } from "../../src/ext/shared/commands";
import { createGitHubPort, type GatewayRequest, type GatewayResponse } from "../../src/ext/shared/github-port";
import type { EngineSession } from "../../src/qlik/session";
import { APP_ID, makeSnapshot } from "../fixtures/snapshot";
import { fakeCache } from "../ext/fake-ports";
import { appFromSnapshot, fakeDoc } from "../qlik/fake-engine";

const TOKEN = "ghp_integrationSecret42";
const ORG = "lr-bicc";
const API = "https://api.github.com";
const QLIK_ORIGIN = "https://qlik.example.com";
const PAGE = `${QLIK_ORIGIN}/qs/sense/app/${APP_ID}/overview`;
// Not valid UTF-8: a lossy text round trip anywhere on the way would change these bytes.
const BINARY = new Uint8Array([0xff, 0xfe, 0x00, 0x89, 0x50, 0xc3, 0x28, 0x80]);

interface Commit { sha: string; parents: string[]; message: string; tree: string }

/** A small GitHub in memory: only the endpoints that src/github calls. State lives across requests. */
function memoryGitHub() {
  const blobs = new Map<string, Uint8Array>();
  const trees = new Map<string, Map<string, string>>(); // tree sha -> path -> blob sha
  const repos = new Map<string, { defaultBranch: string; commits: Map<string, Commit>; branches: Map<string, string> }>();
  const requests: { method: string; path: string; headers: Record<string, string> }[] = [];
  let counter = 0;
  const hex = (): string => (++counter).toString(16).padStart(40, "c");

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const notFound = (): Response => json({ message: "Not Found" }, 404);

  async function storeTree(files: Map<string, Uint8Array | string>): Promise<string> {
    const map = new Map<string, string>();
    for (const [path, content] of files) {
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      const sha = await gitBlobSha(bytes);
      blobs.set(sha, bytes);
      map.set(path, sha);
    }
    const sha = hex();
    trees.set(sha, map);
    return sha;
  }
  async function createRepo(name: string, readme: string): Promise<void> {
    const tree = await storeTree(new Map([["README.md", readme]]));
    const sha = hex();
    repos.set(name, {
      defaultBranch: "main", branches: new Map([["main", sha]]),
      commits: new Map([[sha, { sha, parents: [], message: "Initial commit", tree }]]),
    });
  }
  const ancestors = (r: { commits: Map<string, Commit> }, sha: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length > 0) {
      const s = stack.pop()!;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...(r.commits.get(s)?.parents ?? []));
    }
    return seen;
  };
  const rawCommit = (c: Commit) => ({ sha: c.sha, commit: { message: c.message, author: { name: "octocat", date: "2026-01-02T03:04:05Z" } } });
  const bytesToBase64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));

  async function handle(method: string, path: string, body: any): Promise<Response> {
    const [pathname, query = ""] = path.split("?");
    const params = new URLSearchParams(query);
    const decode = (s: string): string => s.split("/").map(decodeURIComponent).join("/");

    if (method === "GET" && pathname === "/user") return json({ login: "octocat" });
    if (method === "POST" && pathname === "/graphql") {
      const nodes = [...repos].map(([name, r]) => {
        const head = r.commits.get(r.branches.get(r.defaultBranch)!)!;
        const blob = blobs.get(trees.get(head.tree)!.get("README.md") ?? "");
        return {
          nameWithOwner: name, defaultBranchRef: { name: r.defaultBranch },
          object: blob ? { text: new TextDecoder().decode(blob) } : null,
        };
      });
      return json({ data: { organization: { repositories: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } });
    }
    if (method === "POST" && pathname === `/orgs/${ORG}/repos`) {
      if (repos.has(`${ORG}/${body.name}`)) return json({ message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] }, 422);
      await createRepo(`${ORG}/${body.name}`, `# ${body.name}\n`);
      return json({ full_name: `${ORG}/${body.name}`, default_branch: "main" }, 201);
    }

    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(pathname);
    const r = m ? repos.get(m[1]!) : undefined;
    if (!m || !r) return notFound();
    const rest = m[2] ?? "";
    const resolve = (ref: string): string | undefined => r.branches.get(ref) ?? (r.commits.has(ref) ? ref : undefined);

    if (method === "GET" && rest === "") return json({ full_name: m[1], default_branch: r.defaultBranch });
    let g: RegExpExecArray | null;
    if (method === "GET" && (g = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      const sha = r.branches.get(decode(g[1]!));
      return sha ? json({ object: { sha } }) : notFound();
    }
    if (method === "GET" && rest === "/branches") return json([...r.branches].map(([name, sha]) => ({ name, commit: { sha } })));
    if (method === "GET" && (g = /^\/git\/trees\/([0-9a-f]+)$/.exec(rest))) {
      const commit = r.commits.get(g[1]!);
      const tree = commit ? trees.get(commit.tree) : undefined;
      if (!tree) return notFound();
      return json({ truncated: false, tree: [...tree].map(([p, sha]) => ({ path: p, type: "blob", sha })) });
    }
    if (method === "GET" && (g = /^\/contents\/(.+)$/.exec(rest))) {
      const sha = resolve(params.get("ref") ?? "");
      const blob = sha ? blobs.get(trees.get(r.commits.get(sha)!.tree)!.get(decode(g[1]!)) ?? "") : undefined;
      return blob ? json({ content: bytesToBase64(blob), encoding: "base64" }) : notFound();
    }
    if (method === "POST" && rest === "/git/refs") {
      const name = String(body.ref).replace(/^refs\/heads\//, "");
      if (r.branches.has(name)) return json({ message: "Reference already exists" }, 422);
      if (!r.commits.has(body.sha)) return json({ message: "Object does not exist" }, 422);
      r.branches.set(name, body.sha);
      return json({ ref: body.ref, object: { sha: body.sha } }, 201);
    }
    if (method === "GET" && (g = /^\/git\/commits\/([0-9a-f]+)$/.exec(rest))) {
      const c = r.commits.get(g[1]!);
      return c ? json({ sha: c.sha, tree: { sha: c.tree } }) : notFound();
    }
    if (method === "POST" && rest === "/git/blobs") {
      const bytes = body.encoding === "base64"
        ? Uint8Array.from(atob(body.content), (ch) => ch.charCodeAt(0))
        : new TextEncoder().encode(body.content);
      const sha = await gitBlobSha(bytes);
      blobs.set(sha, bytes);
      return json({ sha }, 201);
    }
    if (method === "POST" && rest === "/git/trees") {
      const map = new Map(trees.get(body.base_tree));
      for (const e of body.tree as { path: string; sha?: string | null; content?: string }[]) {
        if (typeof e.content === "string") {
          // An inline entry is stored under the real git blob SHA of its content.
          const bytes = new TextEncoder().encode(e.content);
          const sha = await gitBlobSha(bytes);
          blobs.set(sha, bytes);
          map.set(e.path, sha);
        } else if (e.sha === null || e.sha === undefined) map.delete(e.path);
        else map.set(e.path, e.sha);
      }
      const sha = hex();
      trees.set(sha, map);
      return json({ sha }, 201);
    }
    if (method === "POST" && rest === "/git/commits") {
      const sha = hex();
      r.commits.set(sha, { sha, parents: body.parents, message: body.message, tree: body.tree });
      return json({ sha }, 201);
    }
    if (method === "PATCH" && (g = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
      const name = decode(g[1]!);
      const current = r.branches.get(name);
      if (!current) return notFound();
      if (!ancestors(r, body.sha).has(current)) return json({ message: "Update is not a fast forward" }, 422);
      r.branches.set(name, body.sha);
      return json({ ref: `refs/heads/${name}`, object: { sha: body.sha } });
    }
    if (method === "GET" && rest === "/commits") {
      const start = resolve(params.get("sha") ?? "");
      if (!start) return notFound();
      const list = [...ancestors(r, start)].map((s) => r.commits.get(s)!).reverse();
      return json(list.map(rawCommit));
    }
    if (method === "GET" && (g = /^\/compare\/(.+)\.\.\.(.+)$/.exec(rest))) {
      const base = resolve(decode(g[1]!));
      const head = resolve(decode(g[2]!));
      if (!base || !head) return notFound();
      const fromBase = ancestors(r, base);
      const fromHead = ancestors(r, head);
      const ahead = [...fromHead].filter((s) => !fromBase.has(s));
      const behind = [...fromBase].filter((s) => !fromHead.has(s));
      const status = ahead.length > 0 && behind.length > 0 ? "diverged" : ahead.length > 0 ? "ahead" : behind.length > 0 ? "behind" : "identical";
      return json({ status, ahead_by: ahead.length, behind_by: behind.length, commits: ahead.map((s) => rawCommit(r.commits.get(s)!)) });
    }
    return notFound();
  }

  const fetchDouble = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(API)) throw new Error(`unexpected request to ${url}`);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.slice(API.length);
    requests.push({ method, path, headers: { ...(init?.headers as Record<string, string> | undefined) } });
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    return handle(method, path, body);
  }) as typeof fetch;

  const fileAt = (repo: string, ref: string, path: string): Uint8Array | undefined => {
    const r = repos.get(repo)!;
    const sha = r.branches.get(ref) ?? ref;
    return blobs.get(trees.get(r.commits.get(sha)!.tree)!.get(path) ?? "");
  };
  const pathsAt = (repo: string, ref: string): string[] => {
    const r = repos.get(repo)!;
    return [...trees.get(r.commits.get(r.branches.get(ref) ?? ref)!.tree)!.keys()];
  };
  return {
    fetch: fetchDouble, requests, createRepo, fileAt, pathsAt,
    has: (repo: string) => repos.has(repo),
    head: (repo: string, branch: string) => repos.get(repo)!.branches.get(branch)!,
    message: (repo: string, sha: string) => repos.get(repo)!.commits.get(sha)!.message,
  };
}

test("router, gateway and GitHub work together: connect, read, change, save", async () => {
  const gh = memoryGitHub();
  await gh.createRepo(`${ORG}/other`, "# other\n"); // an unrelated repository the app must not be matched with

  const snapshot = makeSnapshot();
  snapshot.staticFiles = new Map([["logo.png", BINARY]]);
  const app = appFromSnapshot(snapshot, { title: "Sales Planning" });

  // chrome.runtime messaging: request and response are JSON copies, so Uint8Array and Map must have been converted.
  const viaMessage = async (request: GatewayRequest): Promise<GatewayResponse> => {
    const response = await handleGateway(JSON.parse(JSON.stringify(request)), {
      loadOptions: async () => ({ org: ORG, repoPrefix: "", servers: [] }),
      loadToken: async () => TOKEN,
      fetch: gh.fetch,
    });
    return JSON.parse(JSON.stringify(response));
  };

  const events: ProgressEvent[] = [];
  const results: CommandResult[] = [];
  let clock = 0;
  const router = createRouter({
    currentUrl: () => PAGE,
    async openSession(loc): Promise<EngineSession> {
      let closed = false;
      return { doc: fakeDoc(app).doc, appId: loc.appId, user: "r.vasilev", isClosed: () => closed, close: async () => { closed = true; } };
    },
    github: createGitHubPort(viaMessage),
    cache: fakeCache(),
    loadOptions: async () => ({ org: ORG, repoPrefix: "", servers: [] }),
    // Qlik's static file comes from the app content, everything else is not expected here.
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${QLIK_ORIGIN}/qs/appcontent/${APP_ID}/logo.png`) return new Response(BINARY.slice());
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
    now: () => new Date((clock += 1000)),
    emit: (e) => { events.push(e); },
  });
  const run = async (command: Command): Promise<CommandResult> => {
    const result = await router(command);
    results.push(result);
    return result;
  };
  const value = <T>(result: CommandResult): T => {
    if (!result.ok) throw new Error(`command failed: ${JSON.stringify(result.error)}`);
    return result.value as T;
  };

  // 1. nothing linked yet
  const first = value<{ page: string; status: { state: string } }>(await run({ cmd: "status" }));
  expect(first).toMatchObject({ page: "app", status: { state: "unlinked" } });

  // 2. create the repository from the app
  const link = value<{ repo: string; branch: string; syncedSha: string }>(await run({ cmd: "createRepository" }));
  expect(link.repo).toMatch(new RegExp(`^${ORG}/`));
  expect(gh.has(link.repo)).toBe(true);
  expect(link.syncedSha).toBe(gh.head(link.repo, link.branch));
  expect(gh.message(link.repo, link.syncedSha)).toBe("Initial commit");
  const paths = gh.pathsAt(link.repo, link.branch);
  expect(paths).toContain("README.md");
  expect(paths).toContain("appcontent/logo.png");
  expect(paths.some((p) => p.startsWith("objects/sheets/"))).toBe(true);
  expect(gh.fileAt(link.repo, link.branch, "appcontent/logo.png")).toEqual(BINARY);
  expect(new TextDecoder().decode(gh.fileAt(link.repo, link.branch, "README.md")!)).toContain("Sales Planning");

  // 3. linked, in sync, nothing changed
  const linked = value<{ status: { state: string; behindBy: number; link: { repo: string } } }>(await run({ cmd: "status" }));
  expect(linked.status).toMatchObject({ state: "linked", behindBy: 0, link: { repo: link.repo } });
  const clean = value<{ items: unknown[] }>(await run({ cmd: "localChanges" }));
  expect(clean.items).toEqual([]);

  // 4. the app changes: a sheet title and a new variable
  app.objects.find((o) => o.props.qInfo.qId === "sh-1")!.props.qMetaDef = { title: "Overview renamed" };
  app.variables.push({ props: { qInfo: { qId: "var-3", qType: "variable" }, qName: "vNew", qDefinition: "2" } });
  const changed = value<{ items: { path: string; kind: string; group: string; title: string }[] }>(await run({ cmd: "localChanges" }));
  expect(changed.items).toHaveLength(2);
  const sheet = changed.items.find((i) => i.group === "sheets")!;
  const variable = changed.items.find((i) => i.group === "variables")!;
  expect(sheet).toMatchObject({ kind: "changed", title: "Overview renamed" });
  expect(variable).toMatchObject({ kind: "added" });

  // 5. save only the sheet
  const saved = value<{ sha: string }>(await run({
    cmd: "commit", message: "Rename sheet", paths: [sheet.path], removeUnmaintained: false, allowBehind: false,
  }));
  expect(saved.sha).toMatch(/^[0-9a-f]{40}$/);
  expect(gh.head(link.repo, link.branch)).toBe(saved.sha);
  expect(gh.message(link.repo, saved.sha)).toBe("Rename sheet");
  expect(new TextDecoder().decode(gh.fileAt(link.repo, link.branch, sheet.path)!)).toContain("Overview renamed");
  expect(gh.pathsAt(link.repo, link.branch)).not.toContain(variable.path);
  const rest = value<{ items: { path: string }[] }>(await run({ cmd: "localChanges" }));
  expect(rest.items.map((i) => i.path)).toEqual([variable.path]);
  const after = value<{ status: { state: string; behindBy: number } }>(await run({ cmd: "status" }));
  expect(after.status).toMatchObject({ state: "linked", behindBy: 0 });

  // 6. the token reaches GitHub on every request and nothing the panel sees
  expect(gh.requests.length).toBeGreaterThan(10);
  for (const request of gh.requests) expect(request.headers.Authorization, `${request.method} ${request.path}`).toBe(`Bearer ${TOKEN}`);
  for (const result of results) expect(JSON.stringify(result)).not.toContain(TOKEN);
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) expect(JSON.stringify(event)).not.toContain(TOKEN);
});
