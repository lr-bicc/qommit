// Throwaway spike: feasibility probes against a Qlik Sense Enterprise on Windows server.
// Runs inside a content script on an app page. Every probe catches its own errors and
// has its own timeout, so the report is always produced.
import enigma from "enigma.js";
import schema from "enigma.js/schemas/12.2027.0.json";
// The project's own code, bundled by esbuild, so P4 reports exactly what the tool would write.
import { serializeApp } from "../../src/core/serializer";
import { gitBlobSha } from "../../src/core/git-hash";
import type { AppSnapshot, GenericProps, PropertyTree } from "../../src/core/types";

// ---------------------------------------------------------------------------
// Types

/** Generated enigma.js API object (Global, Doc, GenericObject, ...). Methods are camelCase. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EngineApi = { id?: string; type?: string; genericType?: string; [method: string]: any };

interface EnigmaSession {
  open(): Promise<EngineApi>;
  close(code?: number, reason?: string): Promise<void>;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

interface EnigmaModule {
  create(config: {
    schema: unknown;
    url: string;
    createSocket: (url: string) => WebSocket;
    suspendOnClose?: boolean;
  }): EnigmaSession;
}

interface NxInfo {
  qId: string;
  qType: string;
}

export interface ProbeResult {
  id: string;
  question: string;
  ok: boolean;
  detail: string;
  evidence: Record<string, unknown>;
  durationMs: number;
}

export interface SpikeReport {
  server: string;
  virtualProxyPrefix: string;
  appId: string;
  includeDoSave: boolean;
  includeNewApp: boolean;
  startedAt: string;
  finishedAt: string;
  probes: ProbeResult[];
}

export interface AppLocation {
  /** e.g. "lr-analytics-test.lrworld.com" */
  host: string;
  /** e.g. "https://lr-analytics-test.lrworld.com" */
  origin: string;
  /** Virtual proxy prefix including leading slash, e.g. "/qs", or "" for the default proxy. */
  prefix: string;
  appId: string;
  wsScheme: "wss" | "ws";
}

/** The app P9 creates; only this app is ever deleted. */
interface NewAppState {
  name: string;
  id: string | null;
  session: EnigmaSession | null;
  deleted: boolean;
  deleteVia: string | null;
  deleteErrors: string[];
  /** Serialises cleanup calls from the probe and from the runner. */
  chain: Promise<void>;
}

interface Context {
  loc: AppLocation;
  csrfToken: string | null;
  /** Whether the session P1 kept was opened with the CSRF token (P9 opens its session the same way). */
  sessionUsesToken: boolean;
  session: EnigmaSession | null;
  global: EngineApi | null;
  doc: EngineApi | null;
  /** Why the engine probes cannot run (set when P1 fails). */
  engineUnavailable: string | null;
  notifications: { method: string; params: unknown }[];
  sessionEvents: string[];
  /** Set by P6: number of stories (null = P6 did not finish) and the id of the first one. */
  storyCount: number | null;
  storyId: string | null;
  newApp: NewAppState | null;
}

type Evidence = Record<string, unknown>;

interface ProbeDef {
  id: string;
  question: string;
  timeoutMs: number;
  needsEngine: boolean;
  run(ctx: Context, ev: Evidence, cancel: CancelToken): Promise<{ ok: boolean; detail: string }>;
  /** Runs after `run` settled or timed out, with its own timeout; for clean-up that must not be skipped. */
  cleanup?(ctx: Context, ev: Evidence): Promise<void>;
}

/** Set by the runner when a probe times out, so the probe stops starting new work. */
interface CancelToken {
  cancelled: boolean;
}

export interface RunOptions {
  /** Run P7 (DoSave). Off by default so a run can check persistence without saving. */
  includeDoSave: boolean;
  /** Run P9 (creates and deletes one app "spike-probe-<timestamp>"). On by default. */
  includeNewApp: boolean;
}

// ---------------------------------------------------------------------------
// Helpers

const APP_PATH = /^(.*?)\/sense\/app\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\/|$)/;

/** Derives host, virtual proxy prefix and app id from a URL. Returns null if it is not an app page. */
export function parseAppLocation(url: { host: string; origin: string; pathname: string; protocol: string }): AppLocation | null {
  const m = APP_PATH.exec(url.pathname);
  if (!m) return null;
  return {
    host: url.host,
    origin: url.origin,
    prefix: m[1],
    appId: m[2],
    wsScheme: url.protocol === "https:" ? "wss" : "ws",
  };
}

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Single engine/HTTP call with its own timeout, so a hanging call cannot stall a whole probe. */
function step<T>(promise: Promise<T>, label: string, ms = 30_000): Promise<T> {
  return withTimeout(promise, ms, label);
}

function describeError(e: unknown): string {
  if (e instanceof Error) {
    const extra = e as Error & { code?: unknown; parameter?: unknown };
    const parts: string[] = [];
    if (extra.code !== undefined) parts.push(`code ${String(extra.code)}`);
    parts.push(e.message || e.name);
    if (extra.parameter) parts.push(`(parameter: ${String(extra.parameter)})`);
    return parts.join(": ");
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function errorCode(e: unknown): unknown {
  return e && typeof e === "object" && "code" in e ? (e as { code: unknown }).code : undefined;
}

/** enigma.js rejects with code -2 (OBJECT_NOT_FOUND) when the engine returns a null handle. */
function isNotFound(e: unknown): boolean {
  return errorCode(e) === -2 || /not found/i.test(describeError(e));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await sleep(50);
  }
  return condition();
}

function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** First path at which two JSON values differ, or null if equal. */
function firstDiffPath(a: unknown, b: unknown, path = "$"): string | null {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return path;
  if (Array.isArray(a) !== Array.isArray(b)) return path;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}.length`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiffPath(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.join("\u0000") !== bk.join("\u0000")) {
    const missing = ak.filter((k) => !(k in bo)).concat(bk.filter((k) => !(k in ao)));
    return missing.length ? `${path}.${missing[0]} (key present on one side only)` : `${path} (key order differs)`;
  }
  for (const k of ak) {
    const d = firstDiffPath(ao[k], bo[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

/** Finds the needles (case-insensitive) in keys and string values; returns property paths. */
function findStrings(value: unknown, needles: string[], path = "$", hits: { needle: string; path: string }[] = [], limit = 50): { needle: string; path: string }[] {
  if (hits.length >= limit) return hits;
  const check = (s: string, at: string) => {
    const lower = s.toLowerCase();
    for (const n of needles) {
      if (hits.length < limit && lower.includes(n.toLowerCase())) hits.push({ needle: n, path: at });
    }
  };
  if (typeof value === "string") {
    check(value, path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => findStrings(v, needles, `${path}[${i}]`, hits, limit));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      check(k, `${path}.${k} (key)`);
      findStrings(v, needles, `${path}.${k}`, hits, limit);
    }
  }
  return hits;
}

/** Number of keys with the given name anywhere in the value (no limit). */
function countKey(value: unknown, key: string): number {
  if (Array.isArray(value)) return value.reduce((n: number, v) => n + countKey(v, key), 0);
  if (value && typeof value === "object") {
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) n += (k === key ? 1 : 0) + countKey(v, key);
    return n;
  }
  return 0;
}

/** Replaces every occurrence of the token in every string of the value (last line of defence for the report). */
function scrubToken<T>(value: T, token: string): T {
  if (typeof value === "string") return value.split(token).join("<redacted>") as T;
  if (Array.isArray(value)) return value.map((v) => scrubToken(v, token)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[scrubToken(k, token)] = scrubToken(v, token);
    return out as T;
  }
  return value;
}

/** Paths of every key with the given name. */
function findKeyPaths(value: unknown, key: string, path = "$", hits: string[] = [], limit = 20): string[] {
  if (hits.length >= limit) return hits;
  if (Array.isArray(value)) {
    value.forEach((v, i) => findKeyPaths(v, key, `${path}[${i}]`, hits, limit));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === key && hits.length < limit) hits.push(`${path}.${k}`);
      findKeyPaths(v, key, `${path}.${k}`, hits, limit);
    }
  }
  return hits;
}

function randomXrfKey(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

interface HttpResult {
  status: number | null;
  ok: boolean;
  bodySnippet?: string;
  error?: string;
}

async function http(url: string, init: RequestInit = {}, label = url): Promise<{ result: HttpResult; response: Response | null; text: string }> {
  try {
    const response = await step(fetch(url, { credentials: "include", cache: "no-store", ...init }), label);
    let text = "";
    try {
      text = await step(response.text(), `${label} body`);
    } catch (e) {
      text = `<body not readable: ${describeError(e)}>`;
    }
    return {
      result: { status: response.status, ok: response.ok, bodySnippet: text.slice(0, 300) },
      response,
      text,
    };
  } catch (e) {
    return { result: { status: null, ok: false, error: describeError(e) }, response: null, text: "" };
  }
}

/** QRS call with xrfkey query parameter and matching X-Qlik-Xrfkey header. */
function qrs(ctx: Context, method: string, pathAndQuery: string, body?: BodyInit, contentType?: string) {
  const key = randomXrfKey();
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  const url = `${ctx.loc.origin}${ctx.loc.prefix}/qrs/${pathAndQuery}${sep}xrfkey=${key}`;
  const headers: Record<string, string> = { "X-Qlik-Xrfkey": key };
  if (contentType) headers["Content-Type"] = contentType;
  return http(url, { method, headers, body }, `QRS ${method} ${pathAndQuery}`);
}

function requireDoc(ctx: Context): EngineApi {
  if (!ctx.doc) throw new Error("no engine document available");
  return ctx.doc;
}

type Notification = { method: string; params: unknown };

function engineUrl(ctx: Context, appId: string, withToken: boolean): { url: string; shown: string } {
  const base = `${ctx.loc.wsScheme}://${ctx.loc.host}${ctx.loc.prefix}/app/${appId}`;
  if (!withToken || !ctx.csrfToken) return { url: base, shown: base };
  return { url: `${base}?qlik-csrf-token=${encodeURIComponent(ctx.csrfToken)}`, shown: `${base}?qlik-csrf-token=<redacted>` };
}

/** Opens an enigma.js session; on failure the half-open session is closed before the error is rethrown. */
async function openEngineSession(url: string, label: string, notifications: Notification[], events: string[]): Promise<{ session: EnigmaSession; global: EngineApi }> {
  const session = (enigma as unknown as EnigmaModule).create({
    schema,
    url,
    createSocket: (u) => new WebSocket(u),
    suspendOnClose: false,
  });
  session.on("notification:*", (method, params) => {
    notifications.push({ method: String(method), params });
  });
  session.on("closed", (evt) => {
    const e = evt as { code?: number; reason?: string } | undefined;
    events.push(`closed code=${e?.code ?? "?"} reason=${e?.reason ?? ""}`);
  });
  try {
    const global = await step(session.open(), label, 20_000);
    return { session, global };
  } catch (e) {
    await closeQuietly(session);
    throw e;
  }
}

async function closeQuietly(session: EnigmaSession | null): Promise<void> {
  if (!session) return;
  try {
    await withTimeout(session.close(), 5_000, "session.close");
  } catch {
    /* best effort */
  }
}

async function sessionStateOf(notifications: Notification[]): Promise<string | null> {
  await waitFor(() => notifications.some((n) => n.method === "OnConnected"), 3_000);
  const connected = notifications.find((n) => n.method === "OnConnected");
  return (connected?.params as { qSessionState?: string } | undefined)?.qSessionState ?? null;
}

async function getAllInfos(doc: EngineApi): Promise<NxInfo[]> {
  const infos = (await step(doc.getAllInfos(), "GetAllInfos")) as NxInfo[] | undefined;
  return Array.isArray(infos) ? infos : [];
}

/** Opens a generic entity by qType and returns its properties. */
async function getPropertiesOf(doc: EngineApi, info: NxInfo): Promise<unknown> {
  let handle: EngineApi;
  if (info.qType === "dimension") handle = await step(doc.getDimension(info.qId), `GetDimension ${info.qId}`);
  else if (info.qType === "measure") handle = await step(doc.getMeasure(info.qId), `GetMeasure ${info.qId}`);
  else if (info.qType === "variable") handle = await step(doc.getVariableById(info.qId), `GetVariableById ${info.qId}`);
  else handle = await step(doc.getObject(info.qId), `GetObject ${info.qId}`);
  return step(handle.getProperties(), `GetProperties ${info.qId}`);
}

// ---------------------------------------------------------------------------
// Probes

const SPIKE_IDS = {
  dimension: "spike-dimension",
  measure: "spike-measure",
  masterobject: "spike-masterobject",
  sheet: "spike-sheet",
  story: "spike-story",
  variable: "spike-variable",
  link: "spike-qommit-link",
  variableList: "spike-variable-list",
  p4VariableList: "spike-p4-variable-list",
};
/** Variable names cannot reasonably contain "-"; this one is only ever created, never cleaned up by name. */
const SPIKE_VARIABLE_NAME = "spike_variable";

/** Visualization and standard Sense types; everything else counts as "unknown" for P10. */
const KNOWN_TYPES = new Set([
  "sheet", "masterobject", "story", "slide", "slideitem", "dimension", "measure", "bookmark",
  "variable", "LoadModel", "snapshot", "embeddedsnapshot", "barchart", "linechart", "piechart",
  "table", "pivot-table", "kpi", "combochart", "scatterplot", "treemap", "map", "gauge",
  "filterpane", "listbox", "text-image", "histogram", "boxplot", "distributionplot",
  "waterfallchart", "mekkochart", "container", "action-button",
]);

/** Looks for a token in a response body; returns presence and length only, never the value. */
function tokenInBody(text: string): { value: string | null; key: string | null } {
  const trimmed = text.trim();
  if (trimmed === "") return { value: null, key: null };
  try {
    const json = JSON.parse(trimmed) as unknown;
    if (typeof json === "string" && json !== "") return { value: json, key: "(JSON string)" };
    if (json && typeof json === "object" && !Array.isArray(json)) {
      for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
        if (/csrf|token/i.test(k) && typeof v === "string" && v !== "") return { value: v, key: k };
      }
    }
    return { value: null, key: null };
  } catch {
    // A bare token as plain text: one word without spaces or markup.
    return /^[A-Za-z0-9._~+/=-]{8,}$/.test(trimmed) ? { value: trimmed, key: "(plain text)" } : { value: null, key: null };
  }
}

const P11: ProbeDef = {
  id: "P11",
  question: "Does GET /<prefix>/qps/csrftoken return a CSRF token, and where (response header or body)?",
  timeoutMs: 30_000,
  needsEngine: false,
  async run(ctx, ev) {
    const url = `${ctx.loc.origin}${ctx.loc.prefix}/qps/csrftoken`;
    ev.url = url;
    // The body is never copied into the report: it may be the token itself.
    const { result, response, text } = await http(url, { method: "GET" }, "GET csrftoken");
    ev.status = result.status;
    if (result.error) ev.error = result.error;
    const headerNames = response ? Array.from(response.headers.keys()) : [];
    ev.responseHeaderNames = headerNames;
    const tokenHeader = headerNames.find((h) => /csrf/i.test(h) && (response?.headers.get(h) ?? "") !== "") ?? null;
    const headerToken = tokenHeader ? response!.headers.get(tokenHeader) : null;
    ev.tokenHeaderName = tokenHeader;
    ev.headerPresent = headerToken !== null;
    ev.headerTokenLength = headerToken ? headerToken.length : 0;
    ev.contentType = response?.headers.get("content-type") ?? null;
    ev.bodyLength = text.length;
    const body = response ? tokenInBody(text) : { value: null, key: null };
    ev.bodyHasToken = body.value !== null;
    ev.bodyTokenLength = body.value ? body.value.length : 0;
    ev.bodyTokenKey = body.key;
    ev.bodyTokenEqualsHeaderToken = headerToken !== null && body.value !== null ? headerToken === body.value : null;
    ctx.csrfToken = headerToken ?? body.value ?? null;
    ev.tokenSource = headerToken ? `header ${tokenHeader}` : body.value ? "body" : null;
    return ctx.csrfToken
      ? { ok: true, detail: `status ${result.status}, token found in ${String(ev.tokenSource)} (length ${ctx.csrfToken.length})` }
      : { ok: false, detail: `status ${result.status ?? "none"}, no token in headers or body; P1 connects without token` };
  },
};

type SessionAttempt = { ok: boolean; sessionState?: string | null; error?: string; notifications?: string[] };

const P1: ProbeDef = {
  id: "P1",
  question: "Can the content script open an enigma.js WebSocket session (without and with the CSRF token), open the app and read its properties?",
  timeoutMs: 120_000,
  needsEngine: false,
  async run(ctx, ev) {
    // 1. Without the token: does the virtual proxy require it at all? This session is closed again.
    const plain = engineUrl(ctx, ctx.loc.appId, false);
    const trialNotes: Notification[] = [];
    const trialEvents: string[] = [];
    let withoutToken: SessionAttempt;
    try {
      const { session } = await openEngineSession(plain.url, "session.open without token", trialNotes, trialEvents);
      withoutToken = { ok: true, sessionState: await sessionStateOf(trialNotes) };
      await closeQuietly(session);
    } catch (e) {
      withoutToken = { ok: false, error: describeError(e) };
    }
    withoutToken.notifications = trialNotes.map((n) => n.method);
    ev.withoutToken = { ...withoutToken, sessionEvents: trialEvents };

    // 2. With the token, as the real tool would do it. This session is kept when it works.
    let kept: { session: EnigmaSession; global: EngineApi; viaToken: boolean } | null = null;
    if (ctx.csrfToken) {
      const tokenUrl = engineUrl(ctx, ctx.loc.appId, true);
      ev.url = tokenUrl.shown;
      try {
        const opened = await openEngineSession(tokenUrl.url, "session.open with token", ctx.notifications, ctx.sessionEvents);
        kept = { ...opened, viaToken: true };
        ev.withToken = { ok: true, sessionState: await sessionStateOf(ctx.notifications) } satisfies SessionAttempt;
      } catch (e) {
        ev.withToken = { ok: false, error: describeError(e) } satisfies SessionAttempt;
        ctx.notifications.length = 0;
      }
    } else {
      ev.withToken = { ok: false, error: "not attempted: P11 found no token" } satisfies SessionAttempt;
    }

    // 3. Fall back to a fresh session without the token if only that variant worked.
    if (!kept && withoutToken.ok) {
      ev.url = plain.shown;
      const opened = await openEngineSession(plain.url, "session.open without token (kept)", ctx.notifications, ctx.sessionEvents);
      kept = { ...opened, viaToken: false };
    }
    if (!kept) throw new Error("no session could be opened, neither without nor with the CSRF token (see withoutToken / withToken)");
    ctx.session = kept.session;
    ctx.global = kept.global;
    ctx.sessionUsesToken = kept.viaToken;
    ev.sessionUsed = kept.viaToken ? "withToken" : "withoutToken";
    ev.qSessionState = await sessionStateOf(ctx.notifications);
    ev.notifications = ctx.notifications.map((n) => n.method);
    const auth = ctx.notifications.find((n) => n.method === "OnAuthenticationInformation");
    if (auth) ev.authenticationInformation = auth.params;
    const global = kept.global;

    // In an attached session the client already has the app open; OpenDoc then fails
    // (typically LOCERR_APP_ALREADY_OPEN, 1002) and GetActiveDoc returns the open app.
    let doc: EngineApi | null = null;
    try {
      doc = await step(global.openDoc(ctx.loc.appId), "OpenDoc");
      ev.docVia = "OpenDoc";
    } catch (e) {
      ev.openDocError = describeError(e);
      doc = await step(global.getActiveDoc(), "GetActiveDoc");
      ev.docVia = "GetActiveDoc";
    }
    if (!doc) throw new Error("no document handle");
    ctx.doc = doc;

    const props = (await step(doc.getAppProperties(), "GetAppProperties")) as { qTitle?: string } | undefined;
    ev.appTitle = props?.qTitle ?? null;
    try {
      const layout = (await step(doc.getAppLayout(), "GetAppLayout")) as { qFileName?: string; qTitle?: string } | undefined;
      ev.layoutFileName = layout?.qFileName ?? null;
      ev.layoutTitle = layout?.qTitle ?? null;
    } catch (e) {
      ev.appLayoutError = describeError(e);
    }
    return {
      ok: true,
      detail: `without token ${withoutToken.ok ? "ok" : "failed"}, with token ${(ev.withToken as SessionAttempt).ok ? "ok" : "failed/not attempted"}; ` +
        `using ${String(ev.sessionUsed)}, session ${String(ev.qSessionState)}, doc via ${String(ev.docVia)}, title "${String(ev.appTitle)}"`,
    };
  },
};

const SAMPLE_GROUPS = ["variables", "dimensions", "measures", "masterobjects", "sheets", "stories", "bookmarks"];

interface VariableListItem { qName: string; qInfo: NxInfo; qIsScriptCreated?: boolean; qIsReserved?: boolean; qIsConfig?: boolean }

/** Reads every variable with a list (qShowReserved/qShowConfig) so the flags can be compared with GetProperties. */
async function readVariableList(doc: EngineApi): Promise<VariableListItem[]> {
  const id = SPIKE_IDS.p4VariableList;
  try {
    await step(doc.destroySessionObject(id), "DestroySessionObject (stale)");
  } catch {
    /* not present */
  }
  try {
    const list: EngineApi = await step(
      doc.createSessionObject({
        qInfo: { qId: id, qType: "VariableList" },
        qVariableListDef: { qType: "variable", qShowReserved: true, qShowConfig: true, qData: {} },
      }),
      "CreateSessionObject VariableList",
    );
    const layout = (await step(list.getLayout(), "VariableList GetLayout")) as { qVariableList?: { qItems?: VariableListItem[] } };
    return layout.qVariableList?.qItems ?? [];
  } finally {
    try {
      await step(doc.destroySessionObject(id), "DestroySessionObject VariableList");
    } catch {
      /* ignore */
    }
  }
}

const hasFlags = (v: object | undefined): boolean => !!v && ("qIsScriptCreated" in v || "qIsReserved" in v);

/**
 * Builds the repository file map of the open app with the project's serializer and reports
 * per path the git blob SHA and byte length (no appcontent), plus one sample per group.
 */
async function comparableOutput(ctx: Context, doc: EngineApi, infos: NxInfo[], ev: Evidence): Promise<string> {
  const errors: string[] = [];
  const note = (what: string, e: unknown) => {
    if (errors.length < 30) errors.push(`${what}: ${describeError(e)}`);
  };
  const ofType = (t: string) => infos.filter((i) => i.qType === t);
  const trees = async (type: string): Promise<PropertyTree[]> => {
    const out: PropertyTree[] = [];
    for (const info of ofType(type)) {
      try {
        const obj: EngineApi = await step(doc.getObject(info.qId), `GetObject ${info.qId}`);
        out.push((await step(obj.getFullPropertyTree(), `GetFullPropertyTree ${info.qId}`, 60_000)) as PropertyTree);
      } catch (e) {
        note(`${type} ${info.qId}`, e);
      }
    }
    return out;
  };
  const generics = async (type: string, open: (id: string) => Promise<EngineApi>, ids = ofType(type).map((i) => i.qId)): Promise<GenericProps[]> => {
    const out: GenericProps[] = [];
    for (const id of ids) {
      try {
        const handle = await step(open(id), `open ${type} ${id}`);
        out.push((await step(handle.getProperties(), `GetProperties ${id}`)) as GenericProps);
      } catch (e) {
        note(`${type} ${id}`, e);
      }
    }
    return out;
  };

  // Variables: GetAllInfos and the variable list together; flags from whichever source carries them.
  let listItems: VariableListItem[] = [];
  try {
    listItems = await readVariableList(doc);
  } catch (e) {
    note("variable list", e);
  }
  const listById = new Map(listItems.map((i) => [i.qInfo.qId, i]));
  const variableIds = Array.from(new Set([...ofType("variable").map((i) => i.qId), ...listById.keys()]));
  const variableProps = await generics("variable", (id) => doc.getVariableById(id), variableIds);
  const withPropFlags = variableProps.filter((v) => hasFlags(v)).length;
  const withListFlags = listItems.filter((i) => hasFlags(i)).length;
  const sourcesUsed = new Set<string>();
  const variables = variableProps.filter((v) => {
    const listItem = listById.get(v.qInfo?.qId);
    const source = hasFlags(v) ? "GetProperties" : hasFlags(listItem) ? "VariableList" : null;
    const flags = (source === "GetProperties" ? v : source === "VariableList" ? listItem : undefined) as
      { qIsScriptCreated?: unknown; qIsReserved?: unknown } | undefined;
    if (source) sourcesUsed.add(source);
    return !(flags?.qIsScriptCreated === true || flags?.qIsReserved === true);
  });
  ev.variableFlags = {
    variablesRead: variableProps.length,
    variablesInList: listItems.length,
    getPropertiesCarriesFlags: withPropFlags,
    variableListCarriesFlags: withListFlags,
    sourceUsed: sourcesUsed.size === 0 ? "none" : Array.from(sourcesUsed).sort().join("+"),
    leftOutAsScriptCreatedOrReserved: variableProps.length - variables.length,
  };

  let appPropertiesText: string | null = null;
  try {
    appPropertiesText = JSON.stringify(await step(doc.getAppProperties(), "GetAppProperties"), null, 2);
  } catch (e) {
    note("GetAppProperties", e);
  }
  let script = "";
  try {
    script = (await step(doc.getScript(), "GetScript", 45_000)) as string;
  } catch (e) {
    note("GetScript", e);
  }

  const snapshot: AppSnapshot = {
    appId: ctx.loc.appId,
    script: typeof script === "string" ? script : "",
    appProps: await trees("appprops"),
    variables,
    dimensions: await generics("dimension", (id) => doc.getDimension(id)),
    measures: await generics("measure", (id) => doc.getMeasure(id)),
    masterObjects: await trees("masterobject"),
    sheets: await trees("sheet"),
    stories: await trees("story"),
    bookmarks: await generics("bookmark", (id) => doc.getBookmark(id)),
    staticFiles: new Map(), // appcontent is not part of the comparison
  };
  ev.snapshotReadErrors = errors;
  ev.getAppPropertiesSample = appPropertiesText;

  let files: Map<string, string | Uint8Array>;
  try {
    files = serializeApp(snapshot, { canonicalAppId: ctx.loc.appId });
  } catch (e) {
    throw new Error(`serializeApp failed: ${describeError(e)}`); // e.g. an id the repository cannot store
  }
  const paths = [...files.keys()].sort();
  const entries: { path: string; sha: string; bytes: number }[] = [];
  for (const path of paths) {
    const content = files.get(path)!;
    const bytes = typeof content === "string" ? new TextEncoder().encode(content).length : content.length;
    entries.push({ path, sha: await gitBlobSha(content), bytes });
  }
  ev.fileHashes = entries;
  const samples: Record<string, string> = {};
  for (const group of SAMPLE_GROUPS) {
    const first = paths.find((p) => p.startsWith(`objects/${group}/`));
    if (first) samples[first] = files.get(first) as string;
  }
  if (files.has("objects/appprops.json")) samples["objects/appprops.json"] = files.get("objects/appprops.json") as string;
  ev.samples = samples;
  return `${entries.length} files hashed, ${errors.length} read errors`;
}

const P4: ProbeDef = {
  id: "P4",
  question: "Is reading stable (two reads of sheets and measures identical), and which files with which blob SHAs would the tool write for this app?",
  timeoutMs: 480_000,
  needsEngine: true,
  async run(ctx, ev) {
    const doc = requireDoc(ctx);
    const infos = await getAllInfos(doc);
    const sheets = infos.filter((i) => i.qType === "sheet");
    const measures = infos.filter((i) => i.qType === "measure");
    ev.sheetCount = sheets.length;
    ev.measureCount = measures.length;

    const readSheet = async (id: string) => {
      const obj: EngineApi = await step(doc.getObject(id), `GetObject ${id}`);
      return step(obj.getFullPropertyTree(), `GetFullPropertyTree ${id}`);
    };
    const readMeasure = async (id: string) => {
      const m: EngineApi = await step(doc.getMeasure(id), `GetMeasure ${id}`);
      return step(m.getProperties(), `GetProperties ${id}`);
    };

    let deviations = 0;
    let compared = 0;
    let firstDiff: string | null = null;
    const errors: string[] = [];
    const targets = [
      ...sheets.map((s) => ({ info: s, read: readSheet })),
      ...measures.map((m) => ({ info: m, read: readMeasure })),
    ];
    for (const { info, read } of targets) {
      try {
        const first = await read(info.qId);
        const second = await read(info.qId);
        compared++;
        if (JSON.stringify(first, null, 2) !== JSON.stringify(second, null, 2)) {
          deviations++;
          if (!firstDiff) firstDiff = `${info.qType} ${info.qId}: ${firstDiffPath(first, second) ?? "(string differs, no structural diff)"}`;
        }
      } catch (e) {
        if (errors.length < 20) errors.push(`${info.qType} ${info.qId}: ${describeError(e)}`);
      }
    }
    ev.objectsCompared = compared;
    ev.deviations = deviations;
    ev.firstDifferingPath = firstDiff;
    ev.errors = errors;
    const stable = `${compared} objects compared, ${deviations} deviations, ${errors.length} read errors`;

    let comparable: string;
    let comparableOk = false;
    try {
      comparable = await comparableOutput(ctx, doc, infos, ev);
      comparableOk = (ev.snapshotReadErrors as string[]).length === 0;
    } catch (e) {
      comparable = describeError(e);
      ev.comparableOutputError = comparable;
    }
    return {
      ok: deviations === 0 && errors.length === 0 && comparableOk,
      detail: `${stable}; ${comparable}`,
    };
  },
};

const P6: ProbeDef = {
  id: "P6",
  question: "How many stories exist, how large is a story's full property tree, and does it contain qEmbeddedSnapshotDef?",
  timeoutMs: 90_000,
  needsEngine: true,
  async run(ctx, ev) {
    const doc = requireDoc(ctx);
    const stories = (await getAllInfos(doc)).filter((i) => i.qType === "story");
    ev.storyCount = stories.length;
    ctx.storyCount = stories.length;
    if (stories.length === 0) return { ok: true, detail: "no stories in this app" };
    const first = stories[0];
    ev.firstStoryId = first.qId;
    ctx.storyId = first.qId;
    const obj: EngineApi = await step(doc.getObject(first.qId), `GetObject ${first.qId}`);
    const tree = await step(obj.getFullPropertyTree(), `GetFullPropertyTree ${first.qId}`, 60_000);
    ev.sizeBytes = byteSize(tree);
    ev.prettySizeBytes = new TextEncoder().encode(JSON.stringify(tree, null, 2)).length;
    const paths = findKeyPaths(tree, "qEmbeddedSnapshotDef");
    ev.qEmbeddedSnapshotDefFound = paths.length > 0;
    ev.qEmbeddedSnapshotDefPaths = paths;
    return { ok: true, detail: `${stories.length} stories; first is ${ev.sizeBytes} bytes, qEmbeddedSnapshotDef ${paths.length ? "found" : "not found"}` };
  },
};

const P10: ProbeDef = {
  id: "P10",
  question: "Does the app carry gitoqlok metadata (gitoqlik, lastCommitId, branchNamesTable) and where?",
  timeoutMs: 240_000,
  needsEngine: true,
  async run(ctx, ev) {
    const doc = requireDoc(ctx);
    const needles = ["gitoqlik", "lastCommitId", "branchNamesTable"];
    const infos = await getAllInfos(doc);
    const typeCounts: Record<string, number> = {};
    for (const i of infos) typeCounts[i.qType] = (typeCounts[i.qType] ?? 0) + 1;
    ev.qTypeCounts = typeCounts;

    const found: { objectType: string; id: string; path: string; needle: string }[] = [];
    const errors: string[] = [];
    const record = (objectType: string, id: string, value: unknown) => {
      for (const h of findStrings(value, needles)) {
        if (found.length < 100) found.push({ objectType, id, path: h.path, needle: h.needle });
      }
    };

    // The info list itself (catches qIds/qTypes containing the needles).
    record("GetAllInfos", "-", infos);

    // App properties.
    try {
      record("appProperties", "GetAppProperties", await step(doc.getAppProperties(), "GetAppProperties"));
    } catch (e) {
      errors.push(`GetAppProperties: ${describeError(e)}`);
    }

    // Variables (via a session variable list; GetAllInfos may not list them).
    const variableIds = new Set<string>();
    try {
      try {
        await step(doc.destroySessionObject(SPIKE_IDS.variableList), "DestroySessionObject (stale)");
      } catch {
        /* not present */
      }
      const list: EngineApi = await step(
        doc.createSessionObject({
          qInfo: { qId: SPIKE_IDS.variableList, qType: "VariableList" },
          qVariableListDef: { qType: "variable", qShowReserved: true, qShowConfig: true, qShowSession: true, qData: {} },
        }),
        "CreateSessionObject VariableList",
      );
      const layout = (await step(list.getLayout(), "VariableList GetLayout")) as {
        qVariableList?: { qItems?: { qName: string; qInfo: NxInfo }[] };
      };
      const items = layout.qVariableList?.qItems ?? [];
      ev.variableCount = items.length;
      for (const item of items.slice(0, 1000)) {
        variableIds.add(item.qInfo.qId);
        try {
          record("variable", `${item.qName} (${item.qInfo.qId})`, await getPropertiesOf(doc, { qId: item.qInfo.qId, qType: "variable" }));
        } catch (e) {
          record("variable", `${item.qName} (${item.qInfo.qId})`, item);
          if (errors.length < 20) errors.push(`variable ${item.qName}: ${describeError(e)}`);
        }
      }
    } catch (e) {
      errors.push(`variable list: ${describeError(e)}`);
    } finally {
      try {
        await step(doc.destroySessionObject(SPIKE_IDS.variableList), "DestroySessionObject VariableList");
      } catch {
        /* ignore */
      }
    }

    // appprops objects and every object of an unknown type.
    const toSearch = infos.filter((i) => i.qType === "appprops" || (!KNOWN_TYPES.has(i.qType) && !variableIds.has(i.qId)));
    const capped = toSearch.slice(0, 300);
    ev.searchedObjectTypes = Array.from(new Set(capped.map((i) => i.qType)));
    ev.searchedObjectCount = capped.length;
    ev.skippedObjectCount = toSearch.length - capped.length;
    for (const info of capped) {
      try {
        record(info.qType, info.qId, await getPropertiesOf(doc, info));
      } catch (e) {
        if (errors.length < 20) errors.push(`${info.qType} ${info.qId}: ${describeError(e)}`);
      }
    }

    ev.found = found.length ? found : "not found";
    ev.errors = errors;
    return {
      ok: true,
      detail: found.length ? `${found.length} occurrences found (first: ${found[0].objectType} ${found[0].id} ${found[0].path})` : "not found",
    };
  },
};

const P8: ProbeDef = {
  id: "P8",
  question: "Can the load script of a published app be read with GetScript?",
  timeoutMs: 60_000,
  needsEngine: true,
  async run(ctx, ev) {
    const doc = requireDoc(ctx);
    let published: boolean | null = null;
    try {
      const layout = (await step(doc.getAppLayout(), "GetAppLayout")) as { published?: boolean; stream?: unknown };
      ev.layoutPublished = layout.published ?? null;
      ev.layoutStream = layout.stream ?? null;
      if (typeof layout.published === "boolean") published = layout.published;
    } catch (e) {
      ev.appLayoutError = describeError(e);
    }
    const app = await qrs(ctx, "GET", `app/${ctx.loc.appId}`);
    ev.qrsAppStatus = app.result.status;
    if (app.result.ok) {
      try {
        const json = JSON.parse(app.text) as { published?: boolean; stream?: { name?: string } | null };
        ev.qrsPublished = json.published ?? null;
        ev.qrsStream = json.stream?.name ?? null;
        if (published === null && typeof json.published === "boolean") published = json.published;
      } catch (e) {
        ev.qrsParseError = describeError(e);
      }
    } else {
      ev.qrsAppError = app.result.error ?? app.result.bodySnippet;
    }
    ev.published = published;
    if (published !== true) return { ok: true, detail: `app not published (published=${String(published)}); GetScript not attempted` };
    try {
      const script = (await step(doc.getScript(), "GetScript", 45_000)) as string;
      ev.scriptLength = typeof script === "string" ? script.length : null;
      return { ok: typeof script === "string" && script.length > 0, detail: `published app, GetScript returned ${ev.scriptLength} characters` };
    } catch (e) {
      ev.getScriptError = describeError(e);
      return { ok: false, detail: `published app, GetScript failed: ${ev.getScriptError}` };
    }
  },
};

type SpikeKind = "dimension" | "measure" | "masterobject" | "sheet" | "story" | "variable";
interface SpikeObjectSpec {
  kind: SpikeKind;
  id: string;
  create: () => Promise<EngineApi>;
  get: () => Promise<EngineApi>;
  destroy: () => Promise<unknown>;
}

/** The objects P2 creates in the open app and P9 creates in the new app, all with fixed "spike-" ids. */
function spikeObjectSpecs(doc: EngineApi): SpikeObjectSpec[] {
  return [
    {
      kind: "dimension",
      id: SPIKE_IDS.dimension,
      create: () =>
        doc.createDimension({
          qInfo: { qId: SPIKE_IDS.dimension, qType: "dimension" },
          qDim: { qGrouping: "N", qFieldDefs: ["=1"], qFieldLabels: ["spike"], qLabelExpression: "" },
          qMetaDef: { title: "spike-dimension" },
        }),
      get: () => doc.getDimension(SPIKE_IDS.dimension),
      destroy: () => doc.destroyDimension(SPIKE_IDS.dimension),
    },
    {
      kind: "measure",
      id: SPIKE_IDS.measure,
      create: () =>
        doc.createMeasure({
          qInfo: { qId: SPIKE_IDS.measure, qType: "measure" },
          qMeasure: { qLabel: "spike", qDef: "=1", qGrouping: "N", qExpressions: [], qActiveExpression: 0, qLabelExpression: "" },
          qMetaDef: { title: "spike-measure" },
        }),
      get: () => doc.getMeasure(SPIKE_IDS.measure),
      destroy: () => doc.destroyMeasure(SPIKE_IDS.measure),
    },
    {
      kind: "masterobject",
      id: SPIKE_IDS.masterobject,
      create: () =>
        doc.createObject({
          qInfo: { qId: SPIKE_IDS.masterobject, qType: "masterobject" },
          qMetaDef: { title: "spike-masterobject" },
          visualization: "text-image",
          markdown: "spike",
        }),
      get: () => doc.getObject(SPIKE_IDS.masterobject),
      destroy: () => doc.destroyObject(SPIKE_IDS.masterobject),
    },
    {
      kind: "sheet",
      id: SPIKE_IDS.sheet,
      create: () =>
        doc.createObject({
          qInfo: { qId: SPIKE_IDS.sheet, qType: "sheet" },
          qMetaDef: { title: "spike-sheet", description: "" },
          rank: 9999,
          columns: 24,
          rows: 12,
          cells: [],
          qChildListDef: { qData: { title: "/title" } },
        }),
      get: () => doc.getObject(SPIKE_IDS.sheet),
      destroy: () => doc.destroyObject(SPIKE_IDS.sheet),
    },
    {
      kind: "story",
      id: SPIKE_IDS.story,
      create: () =>
        doc.createObject({
          qInfo: { qId: SPIKE_IDS.story, qType: "story" },
          qMetaDef: { title: "spike-story", description: "" },
          rank: 9999,
          qChildListDef: { qData: { title: "/title", rank: "/rank" } },
        }),
      get: () => doc.getObject(SPIKE_IDS.story),
      destroy: () => doc.destroyObject(SPIKE_IDS.story),
    },
    {
      kind: "variable",
      id: SPIKE_IDS.variable,
      create: () =>
        doc.createVariableEx({
          qInfo: { qId: SPIKE_IDS.variable, qType: "variable" },
          qName: SPIKE_VARIABLE_NAME,
          qDefinition: "1",
          qComment: "spike",
        }),
      get: () => doc.getVariableById(SPIKE_IDS.variable),
      destroy: () => doc.destroyVariableById(SPIKE_IDS.variable),
    },
  ];
}

/** Creates one spike object and reads its id back; records into `r`. Returns whether the id was kept. */
async function createAndReadBack(s: SpikeObjectSpec, r: Record<string, unknown>): Promise<boolean> {
  try {
    const obj = await step(s.create(), `Create ${s.kind}`);
    r.createdHandleId = obj?.id ?? null;
    const back = await step(s.get(), `read back ${s.kind}`);
    const info = (await step(back.getInfo(), `GetInfo ${s.kind}`)) as NxInfo;
    r.readBackId = info?.qId ?? null;
    r.readBackType = info?.qType ?? null;
    r.idKept = info?.qId === s.id;
    return r.idKept === true;
  } catch (e) {
    r.error = describeError(e);
    return false;
  }
}

/** Closes P9's session and deletes the app P9 created; safe to call more than once. */
function cleanupNewApp(ctx: Context, ev: Evidence): Promise<void> {
  const st = ctx.newApp;
  if (!st) return Promise.resolve();
  st.chain = st.chain.then(async () => {
    const session = st.session;
    st.session = null;
    await closeQuietly(session);
    // Only the app this run created, and never the app the probes run in.
    if (st.id && !st.deleted && st.id !== ctx.loc.appId) {
      if (ctx.global) {
        try {
          const res = (await step(ctx.global.deleteApp(st.id), `DeleteApp ${st.id}`)) as unknown;
          const success = res === true || (res as { qSuccess?: boolean } | null)?.qSuccess === true;
          if (success) {
            st.deleted = true;
            st.deleteVia = "engine DeleteApp";
          } else {
            st.deleteErrors.push(`engine DeleteApp returned ${JSON.stringify(res)}`);
          }
        } catch (e) {
          st.deleteErrors.push(`engine DeleteApp: ${describeError(e)}`);
        }
      }
      if (!st.deleted) {
        const del = await qrs(ctx, "DELETE", `app/${st.id}`);
        if (del.result.ok) {
          st.deleted = true;
          st.deleteVia = "QRS DELETE app";
        } else {
          st.deleteErrors.push(`QRS DELETE app: ${del.result.status ?? del.result.error} ${del.result.bodySnippet ?? ""}`.trim());
        }
      }
    }
    ev.newApp = { name: st.name, id: st.id, deleted: st.deleted, deleteVia: st.deleteVia, deleteErrors: st.deleteErrors };
  });
  return st.chain;
}

const P9: ProbeDef = {
  id: "P9",
  question: "In a new app: are given qIds kept for all object types, and does a story survive GetFullPropertyTree -> SetFullPropertyTree?",
  timeoutMs: 240_000,
  needsEngine: true,
  async run(ctx, ev, cancel) {
    const global = ctx.global;
    if (!global) throw new Error("no engine global available");
    const st: NewAppState = {
      name: `spike-probe-${new Date().toISOString().replace(/[:.]/g, "-")}`,
      id: null,
      session: null,
      deleted: false,
      deleteVia: null,
      deleteErrors: [],
      chain: Promise.resolve(),
    };
    ctx.newApp = st;
    ev.newApp = { name: st.name, id: null, deleted: false };
    let result: { ok: boolean; detail: string };
    try {
      result = await runNewAppSteps(ctx, ev, cancel, global, st);
    } finally {
      // 4. Always close and delete, also after an error; the runner calls this again after a timeout.
      await cleanupNewApp(ctx, ev);
    }
    const leftover = st.id ? `app NOT deleted, remove by hand: "${st.name}" (${st.id})` : `if an app "${st.name}" exists, remove it by hand`;
    return { ok: result.ok && st.deleted, detail: `${result.detail}; ${st.deleted ? "app deleted" : leftover}` };
  },
  async cleanup(ctx, ev) {
    await cleanupNewApp(ctx, ev);
  },
};

async function runNewAppSteps(ctx: Context, ev: Evidence, cancel: CancelToken, global: EngineApi, st: NewAppState): Promise<{ ok: boolean; detail: string }> {
  // 1. Create the app through the engine global (lands in the user's work area).
  const created = (await step(global.createApp(st.name), "CreateApp")) as unknown;
  const appId = typeof created === "string" ? created : (created as { qAppId?: string } | null)?.qAppId;
  ev.createAppSuccess = (created as { qSuccess?: boolean } | null)?.qSuccess ?? null;
  if (typeof appId !== "string" || appId === "") throw new Error(`CreateApp returned no app id: ${JSON.stringify(created)}`);
  st.id = appId;
  ev.newApp = { name: st.name, id: st.id, deleted: false };
  if (cancel.cancelled) return { ok: false, detail: "cancelled after CreateApp" };

  // 2. Open it in its own session, the same way P1 opened the current app.
  const url = engineUrl(ctx, appId, ctx.sessionUsesToken);
  ev.url = url.shown;
  const opened = await openEngineSession(url.url, "session.open new app", [], []);
  st.session = opened.session;
  let newDoc: EngineApi | null = null;
  const openErrors: string[] = [];
  for (let attempt = 1; attempt <= 3 && !newDoc && !cancel.cancelled; attempt++) {
    try {
      newDoc = await step(opened.global.openDoc(appId), `OpenDoc new app (attempt ${attempt})`);
    } catch (e) {
      openErrors.push(describeError(e));
      await sleep(2_000); // a freshly created app may need a moment before it can be opened
    }
  }
  ev.openDocErrors = openErrors;
  if (!newDoc) throw new Error(`new app could not be opened: ${openErrors.join(" | ")}`);

  const perType: Record<string, unknown> = {};
  let allKept = true;
  for (const spec of spikeObjectSpecs(newDoc)) {
    if (cancel.cancelled) break;
    const r: Record<string, unknown> = { requestedId: spec.id };
    perType[spec.kind] = r;
    if (!(await createAndReadBack(spec, r))) allKept = false;
  }
  ev.perType = perType;

  // 3. Copy the first story of the current app (with its snapshots) into the new app.
  let storyOk = true;
  if (!ctx.storyId) {
    ev.story = ctx.storyCount === 0 ? "skipped: no story in this app" : "skipped: no story in this app (P6 did not finish)";
  } else if (!cancel.cancelled) {
    const story: Record<string, unknown> = { id: ctx.storyId };
    ev.story = story;
    try {
      const doc = requireDoc(ctx);
      const source: EngineApi = await step(doc.getObject(ctx.storyId), `GetObject ${ctx.storyId}`);
      const tree = await step(source.getFullPropertyTree(), "GetFullPropertyTree (source)", 60_000);
      const target: EngineApi = await step(newDoc.createObject({ qInfo: { qId: ctx.storyId, qType: "story" } }), "CreateObject story (copy)");
      await step(target.setFullPropertyTree(tree), "SetFullPropertyTree", 60_000);
      const back = await step(target.getFullPropertyTree(), "GetFullPropertyTree (copy)", 60_000);
      story.equal = JSON.stringify(tree, null, 2) === JSON.stringify(back, null, 2);
      story.firstDifferingPath = story.equal ? null : firstDiffPath(tree, back) ?? "(string differs, no structural diff)";
      story.embeddedSnapshotDefsSource = countKey(tree, "qEmbeddedSnapshotDef");
      story.embeddedSnapshotDefsCopy = countKey(back, "qEmbeddedSnapshotDef");
      story.sizeBytesSource = byteSize(tree);
      story.sizeBytesCopy = byteSize(back);
      storyOk = story.equal === true;
    } catch (e) {
      story.error = describeError(e);
      storyOk = false;
    }
  }
  return {
    ok: allKept && storyOk,
    detail: `${allKept ? "all types kept the given qId" : "at least one type did not keep the qId (see evidence)"}; story ${
      typeof ev.story === "string" ? ev.story : storyOk ? "copied unchanged" : "differs or failed (see evidence)"}`,
  };
}

const P2: ProbeDef = {
  id: "P2",
  question: "Does the engine keep a given qInfo.qId on CreateDimension, CreateMeasure, CreateVariableEx and CreateObject (masterobject, sheet, story)?",
  timeoutMs: 180_000,
  needsEngine: true,
  async run(ctx, ev, cancel) {
    const doc = requireDoc(ctx);
    const specs = spikeObjectSpecs(doc);
    const perType: Record<string, unknown> = {};
    let allKept = true;
    const cleanupFailures: string[] = [];
    for (const s of specs) {
      if (cancel.cancelled) break; // probe timed out: do not create anything further
      const r: Record<string, unknown> = { requestedId: s.id };
      perType[s.kind] = r;
      // Remove leftovers of an earlier, interrupted run.
      try {
        await step(s.destroy(), `pre-cleanup ${s.id}`);
      } catch {
        /* not present */
      }
      try {
        if (!(await createAndReadBack(s, r))) allKept = false;
      } finally {
        // Always attempt cleanup, also when create/read-back failed or timed out midway.
        try {
          r.destroyed = await step(s.destroy(), `Destroy ${s.kind}`);
          if (r.destroyed !== true) cleanupFailures.push(`${s.id} (qSuccess=${String(r.destroyed)})`);
        } catch (e) {
          r.destroyError = describeError(e);
          cleanupFailures.push(`${s.id} (${r.destroyError})`);
        }
      }
    }
    ev.perType = perType;
    ev.cleanupFailures = cleanupFailures;
    const parts = [allKept ? `all ${specs.length} types kept the given qId` : "at least one type did not keep the qId or failed (see evidence)"];
    if (cleanupFailures.length) parts.push(`cleanup FAILED for ${cleanupFailures.join(", ")}`);
    return { ok: allKept && cleanupFailures.length === 0, detail: parts.join("; ") };
  },
};

const P5: ProbeDef = {
  id: "P5",
  question: "Can app content files be listed, downloaded, uploaded and deleted (QRS appcontent)?",
  timeoutMs: 120_000,
  needsEngine: false,
  async run(ctx, ev) {
    const { origin, prefix, appId } = ctx.loc;
    // Listing needs the engine; upload/delete are HTTP-only and run regardless.
    if (ctx.doc) {
      try {
        const libs = (await step(ctx.doc.getContentLibraries(), "GetContentLibraries")) as {
          qItems?: { qName: string; qAppSpecific?: boolean }[];
        };
        const items = libs?.qItems ?? [];
        ev.libraries = items.map((l) => ({ name: l.qName, appSpecific: Boolean(l.qAppSpecific) }));
        const appLib = items.find((l) => l.qAppSpecific);
        if (!appLib) {
          ev.fileCount = 0;
          ev.listingNote = "no app-specific content library";
        } else {
          const content = (await step(ctx.doc.getLibraryContent(appLib.qName), "GetLibraryContent")) as {
            qItems?: { qUrl: string; qUrlDef?: string }[];
          };
          const files = content?.qItems ?? [];
          ev.fileCount = files.length;
          ev.fileUrls = files.slice(0, 10).map((f) => f.qUrl);
          if (files.length > 0) {
            const rawName = files[0].qUrl.split("/").pop() ?? "";
            let name = rawName;
            try {
              name = decodeURIComponent(rawName);
            } catch {
              /* keep raw */
            }
            const url = `${origin}${prefix}/appcontent/${appId}/${encodeURIComponent(name)}`;
            const dl = await http(url, { method: "GET" }, "GET appcontent file");
            ev.download = { url, status: dl.result.status, bytes: dl.text.length, error: dl.result.error };
          }
        }
      } catch (e) {
        ev.listingError = describeError(e);
      }
    } else {
      ev.listingSkipped = `no engine document: ${ctx.engineUnavailable ?? "unknown"}`;
    }

    const uploadPath = `appcontent/${appId}/uploadfile?externalpath=spike-probe.txt&overwrite=true`;
    const body = () => new Blob([`spike probe ${new Date().toISOString()}\n`], { type: "text/plain" });
    let upload = await qrs(ctx, "POST", uploadPath, body(), "application/octet-stream");
    ev.upload = { contentType: "application/octet-stream", ...upload.result };
    if (upload.result.status === 400 || upload.result.status === 415) {
      // Some QRS versions are picky about the content type; retry once with text/plain.
      upload = await qrs(ctx, "POST", uploadPath, body(), "text/plain");
      ev.uploadRetry = { contentType: "text/plain", ...upload.result };
    }
    const check = await http(`${origin}${prefix}/appcontent/${appId}/spike-probe.txt`, { method: "GET" }, "GET uploaded file");
    ev.downloadUploaded = { status: check.result.status, body: check.result.bodySnippet, error: check.result.error };
    const del = await qrs(ctx, "DELETE", `appcontent/${appId}/deletecontent?externalpath=spike-probe.txt`);
    ev.delete = del.result;

    const ok = upload.result.ok && del.result.ok && !ev.listingError;
    return {
      ok,
      detail: `files ${ev.fileCount ?? "n/a"}, upload ${upload.result.status ?? upload.result.error}, delete ${del.result.status ?? del.result.error}`,
    };
  },
};

const P3: ProbeDef = {
  id: "P3",
  question: "Does a persistent link object (qId spike-qommit-link, qType qommit-link) survive and is it listed by GetAllInfos?",
  timeoutMs: 60_000,
  needsEngine: true,
  async run(ctx, ev) {
    const doc = requireDoc(ctx);
    const before = await getAllInfos(doc);
    ev.inAllInfosBefore = before.some((i) => i.qId === SPIKE_IDS.link);

    let existing: EngineApi | null = null;
    try {
      existing = await step(doc.getObject(SPIKE_IDS.link), "GetObject spike-qommit-link");
    } catch (e) {
      if (!isNotFound(e)) ev.lookupError = describeError(e);
    }
    ev.existedBefore = existing !== null || ev.inAllInfosBefore === true;
    if (existing) {
      try {
        ev.existingProperties = await step(existing.getProperties(), "GetProperties spike-qommit-link");
      } catch (e) {
        ev.existingPropertiesError = describeError(e);
      }
    } else {
      // Not deleted and no DoSave here: P7 runs last and saves.
      const created: EngineApi = await step(
        doc.createObject({ qInfo: { qId: SPIKE_IDS.link, qType: "qommit-link" }, link: { probe: true } }),
        "CreateObject spike-qommit-link",
      );
      const info = (await step(created.getInfo(), "GetInfo spike-qommit-link")) as NxInfo;
      ev.createdId = info?.qId ?? null;
    }
    const after = await getAllInfos(doc);
    const entry = after.find((i) => i.qId === SPIKE_IDS.link);
    ev.inAllInfos = Boolean(entry);
    ev.allInfosEntry = entry ?? null;
    return { ok: Boolean(entry), detail: `existedBefore=${String(ev.existedBefore)}, in GetAllInfos=${String(ev.inAllInfos)}` };
  },
};

const P7: ProbeDef = {
  id: "P7",
  question: "Does DoSave keep the data (sum of qNoOfRows from GetTablesAndKeys before and after)?",
  timeoutMs: 240_000,
  needsEngine: true,
  async run(ctx, ev) {
    const doc = requireDoc(ctx);
    const rows = async (label: string) => {
      const res = (await step(
        doc.getTablesAndKeys({ qcx: 0, qcy: 0 }, { qcx: 0, qcy: 0 }, 0, false, false),
        `GetTablesAndKeys ${label}`,
        60_000,
      )) as { qtr?: { qName: string; qNoOfRows: number }[] };
      const tables = res?.qtr ?? [];
      return { tables: tables.length, rows: tables.reduce((sum, t) => sum + (t.qNoOfRows ?? 0), 0) };
    };
    const before = await rows("before");
    ev.tablesBefore = before.tables;
    ev.rowsBefore = before.rows;
    try {
      await step(doc.doSave(), "DoSave", 150_000);
      ev.doSave = "ok";
    } catch (e) {
      ev.doSave = `error: ${describeError(e)}`;
    }
    const after = await rows("after");
    ev.tablesAfter = after.tables;
    ev.rowsAfter = after.rows;
    const ok = ev.doSave === "ok" && before.tables > 0 && before.rows === after.rows;
    return {
      ok,
      detail: `DoSave ${String(ev.doSave)}; tables before ${before.tables}, after ${after.tables}; rows before ${before.rows}, after ${after.rows}${before.tables === 0 ? " (no tables: data question not answerable)" : ""}`,
    };
  },
};

/** Execution order as decided for the spike. */
const PROBES: ProbeDef[] = [P11, P1, P4, P6, P9, P10, P8, P2, P5, P3, P7];

// ---------------------------------------------------------------------------
// Runner

export async function runProbes(loc: AppLocation, onProgress: (text: string) => void, options: RunOptions): Promise<SpikeReport> {
  const report: SpikeReport = {
    server: loc.host,
    virtualProxyPrefix: loc.prefix,
    appId: loc.appId,
    includeDoSave: options.includeDoSave,
    includeNewApp: options.includeNewApp,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    probes: [],
  };
  const ctx: Context = {
    loc,
    csrfToken: null,
    sessionUsesToken: false,
    session: null,
    global: null,
    doc: null,
    engineUnavailable: null,
    notifications: [],
    sessionEvents: [],
    storyCount: null,
    storyId: null,
    newApp: null,
  };

  for (const [index, probe] of PROBES.entries()) {
    onProgress(`Running ${probe.id} (${index + 1}/${PROBES.length})…`);
    const ev: Evidence = {};
    const started = Date.now();
    let ok = false;
    let detail = "";
    if (probe.id === "P7" && !options.includeDoSave) {
      detail = "skipped: DoSave probe not selected";
    } else if (probe.id === "P9" && !options.includeNewApp) {
      detail = "skipped: new-app probe not selected";
    } else if (probe.needsEngine && ctx.engineUnavailable) {
      detail = `skipped: ${ctx.engineUnavailable}`;
    } else {
      const cancel: CancelToken = { cancelled: false };
      try {
        const r = await withTimeout(probe.run(ctx, ev, cancel), probe.timeoutMs, probe.id);
        ok = r.ok;
        detail = r.detail;
      } catch (e) {
        cancel.cancelled = true;
        detail = `${e instanceof TimeoutError ? "timeout" : "error"}: ${describeError(e)}`;
      }
      if (probe.cleanup) {
        try {
          await withTimeout(probe.cleanup(ctx, ev), 90_000, `${probe.id} cleanup`);
        } catch (e) {
          ev.cleanupError = describeError(e);
        }
      }
    }
    if (probe.id === "P1" && !ctx.doc) {
      ctx.engineUnavailable = `P1 failed (${detail})`;
    }
    report.probes.push({ id: probe.id, question: probe.question, ok, detail, evidence: ev, durationMs: Date.now() - started });
  }

  onProgress("Closing session…");
  if (ctx.session) {
    try {
      await withTimeout(ctx.session.close(), 5_000, "session.close");
    } catch {
      /* best effort */
    }
  }
  const p1 = report.probes.find((p) => p.id === "P1");
  if (p1) p1.evidence.sessionEvents = ctx.sessionEvents;
  report.finishedAt = new Date().toISOString();
  // The token value must never reach the report, whatever an error message may have echoed.
  return ctx.csrfToken ? scrubToken(report, ctx.csrfToken) : report;
}
