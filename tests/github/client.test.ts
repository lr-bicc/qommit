import { createGitHubClient } from "../../src/github/client";
import { GitHubError } from "../../src/github/errors";
import { mockFetch } from "./mock-fetch";

const kindOf = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as GitHubError).kind);
const errOf = async (p: Promise<unknown>) => p.then(() => { throw new Error("expected rejection"); }, (e) => e as GitHubError);

test("sends auth headers and parses json", async () => {
  const m = mockFetch({ "GET /user": () => ({ body: { login: "me" } }) });
  const c = createGitHubClient({ token: "T0KEN", fetch: m.fetch });
  expect(await c.rest("GET", "/user")).toEqual({ login: "me" });
  expect(m.calls[0].url).toBe("https://api.github.com/user");
});

test("sends required headers", async () => {
  let seen: Headers | undefined;
  const f = (async (_u: unknown, init?: RequestInit) => {
    seen = new Headers(init?.headers);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  await createGitHubClient({ token: "T0KEN", fetch: f }).rest("GET", "/user");
  expect(seen?.get("authorization")).toBe("Bearer T0KEN");
  expect(seen?.get("accept")).toBe("application/vnd.github+json");
  expect(seen?.get("x-github-api-version")).toBe("2022-11-28");
});

test("maps errors", async () => {
  const m = mockFetch({
    "GET /a": () => ({ status: 401, body: { message: "Bad credentials" } }),
    "GET /b": () => ({ status: 403, body: { message: "SAML" }, headers: { "x-github-sso": "required; url=https://github.com/orgs/x/sso?y=1" } }),
    "GET /c": () => ({ status: 403, body: { message: "rate limit" }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" } }),
    "GET /d": () => ({ status: 403, body: { message: "Must have admin rights" } }),
    "PATCH /e": () => ({ status: 422, body: { message: "Update is not a fast forward" } }),
    "POST /f": () => ({ status: 422, body: { message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] } }),
    "PATCH /g": () => ({ status: 409, body: { message: "Cannot update this protected branch" } }),
    "GET /h": () => ({ status: 500, body: { message: "boom" } }),
  });
  const c = createGitHubClient({ token: "T0KEN", fetch: m.fetch });
  expect(await kindOf(c.rest("GET", "/a"))).toBe("unauthorized");
  const sso = await errOf(c.rest("GET", "/b"));
  expect([sso.kind, sso.extra.ssoUrl]).toEqual(["sso-required", "https://github.com/orgs/x/sso?y=1"]);
  const rl = await errOf(c.rest("GET", "/c"));
  expect([rl.kind, rl.extra.resetAt?.getTime()]).toEqual(["rate-limited", 1800000000000]);
  expect(await kindOf(c.rest("GET", "/d"))).toBe("forbidden");
  expect(await kindOf(c.rest("PATCH", "/e", {}))).toBe("not-fast-forward");
  expect(await kindOf(c.rest("POST", "/f", {}))).toBe("name-exists");
  expect(await kindOf(c.rest("PATCH", "/g", {}))).toBe("protected-branch");
  expect(await kindOf(c.rest("GET", "/h"))).toBe("unknown");
  expect(await kindOf(c.rest("GET", "/missing"))).toBe("not-found");
});

test("retry-after yields rate-limited with resetAt", async () => {
  const m = mockFetch({
    "GET /r": () => ({ status: 429, body: { message: "slow down" }, headers: { "Retry-After": "60" } }),
  });
  const c = createGitHubClient({ token: "T0KEN", fetch: m.fetch });
  const before = Date.now();
  const e = await errOf(c.rest("GET", "/r"));
  expect(e.kind).toBe("rate-limited");
  const t = e.extra.resetAt!.getTime();
  expect(t).toBeGreaterThanOrEqual(before + 60_000);
  expect(t).toBeLessThanOrEqual(Date.now() + 60_000);
});

test("rest returns undefined for 204 and sends json body", async () => {
  const m = mockFetch({ "DELETE /x": () => ({ status: 204 }), "POST /y": () => ({ body: { ok: true } }) });
  const c = createGitHubClient({ token: "T0KEN", fetch: m.fetch });
  expect(await c.rest("DELETE", "/x")).toBeUndefined();
  await c.rest("POST", "/y", { a: 1 });
  expect(m.calls[1].body).toEqual({ a: 1 });
  expect(m.calls[0].body).toBeUndefined();
});

test("graphql posts query and returns data; errors throw unknown", async () => {
  const m = mockFetch({
    "POST /graphql": (req) =>
      (req.body as { query: string }).query === "bad"
        ? { body: { errors: [{ message: "nope" }] } }
        : { body: { data: { viewer: { login: "me" } } } },
  });
  const c = createGitHubClient({ token: "T0KEN", fetch: m.fetch });
  expect(await c.graphql("q", { v: 1 })).toEqual({ viewer: { login: "me" } });
  expect(m.calls[0].body).toEqual({ query: "q", variables: { v: 1 } });
  const e = await errOf(c.graphql("bad", {}));
  expect(e.kind).toBe("unknown");
});

test("raw returns bytes and maps errors", async () => {
  const f = (async (u: unknown) =>
    String(u).endsWith("/zip") ? new Response(new Uint8Array([1, 2, 3]), { status: 200 }) : new Response('{"message":"Not Found"}', { status: 404 })) as typeof fetch;
  const c = createGitHubClient({ token: "T0KEN", fetch: f });
  expect(Array.from(await c.raw("/zip"))).toEqual([1, 2, 3]);
  expect(await kindOf(c.raw("/nope"))).toBe("not-found");
});

test("network failures and token hygiene", async () => {
  const c = createGitHubClient({ token: "T0KEN", fetch: (async () => { throw new TypeError("fetch failed T0KEN"); }) as typeof fetch });
  const e = await errOf(c.rest("GET", "/user"));
  expect(e.kind).toBe("network");
  expect(e.status).toBe(0);
  expect(e.message).not.toContain("T0KEN");
});

test("retry-after wins over x-ratelimit-reset; the reset time counts only when nothing remains", async () => {
  const reset = "1800000000";
  const m = mockFetch({
    "GET /a": () => ({ status: 403, body: { message: "secondary" }, headers: { "retry-after": "60", "x-ratelimit-remaining": "4999", "x-ratelimit-reset": reset } }),
    "GET /b": () => ({ status: 429, body: { message: "slow" }, headers: { "retry-after": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } }),
    "GET /c": () => ({ status: 403, body: { message: "You have exceeded a secondary rate limit" }, headers: { "x-ratelimit-remaining": "12", "x-ratelimit-reset": reset } }),
  });
  const c = createGitHubClient({ token: "T0KEN", fetch: m.fetch });
  for (const path of ["/a", "/b"]) {
    const before = Date.now();
    const e = await errOf(c.rest("GET", path));
    expect(e.kind).toBe("rate-limited");
    expect(e.extra.resetAt!.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(e.extra.resetAt!.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
  }
  const e = await errOf(c.rest("GET", "/c"));
  expect(e.kind).toBe("rate-limited");
  expect(e.extra.resetAt).toBeUndefined();
});

test("a secondary rate limit without retry-after is rate-limited, not forbidden", async () => {
  const m = mockFetch({
    "GET /s": () => ({ status: 403, body: { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." } }),
  });
  const e = await errOf(createGitHubClient({ token: "T0KEN", fetch: m.fetch }).rest("GET", "/s"));
  expect(e.kind).toBe("rate-limited");
});

test("a ref update refused by a repository ruleset is protected-branch", async () => {
  const m = mockFetch({
    "PATCH /r": () => ({ status: 422, body: { message: "Repository rule violations found\n\nChanges must be made through a pull request.\n\n" } }),
  });
  expect(await kindOf(createGitHubClient({ token: "T0KEN", fetch: m.fetch }).rest("PATCH", "/r", {}))).toBe("protected-branch");
});

test("a 2xx body that is not JSON or cannot be read becomes a GitHubError without the body text", async () => {
  const proxyPage = "<html>Proxy login SECRET-PAGE</html>";
  const html = (async () => new Response(proxyPage, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
  const viaHtml = createGitHubClient({ token: "T0KEN", fetch: html });
  for (const call of [() => viaHtml.rest("GET", "/user"), () => viaHtml.graphql("q", {})]) {
    const e = await errOf(call());
    expect(e).toBeInstanceOf(GitHubError);
    expect([e.kind, e.status]).toEqual(["unknown", 200]);
    expect(e.message).not.toContain("SECRET-PAGE");
    expect(e.message).not.toContain("T0KEN");
  }
  const broken = (async () => new Response(new ReadableStream({ start(ctl) { ctl.error(new Error("reset T0KEN")); } }),
    { status: 200 })) as typeof fetch;
  const viaBroken = createGitHubClient({ token: "T0KEN", fetch: broken });
  for (const call of [() => viaBroken.rest("GET", "/user"), () => viaBroken.raw("/zip")]) {
    const e = await errOf(call());
    expect(e).toBeInstanceOf(GitHubError);
    expect(e.kind).toBe("unknown");
    expect(e.message).not.toContain("T0KEN");
  }
});
