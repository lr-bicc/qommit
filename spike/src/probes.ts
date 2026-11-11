// Throwaway spike: feasibility probes against a Qlik Sense Enterprise on Windows server.
// Runs inside a content script on an app page. Every probe catches its own errors and
// has its own timeout, so the report is always produced.
import enigma from "enigma.js";
import schema from "enigma.js/schemas/12.2027.0.json";

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

interface Context {
  loc: AppLocation;
  csrfToken: string | null;
  session: EnigmaSession | null;
  global: EngineApi | null;
  doc: EngineApi | null;
  /** Why the engine probes cannot run (set when P1 fails). */
  engineUnavailable: string | null;
  notifications: { method: string; params: unknown }[];
  sessionEvents: string[];
}

type Evidence = Record<string, unknown>;

interface ProbeDef {
  id: string;
  question: string;
  timeoutMs: number;
  needsEngine: boolean;
  run(ctx: Context, ev: Evidence): Promise<{ ok: boolean; detail: string }>;
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
  link: "spike-git-link",
  variableList: "spike-variable-list",
};

/** Visualization and standard Sense types; everything else counts as "unknown" for P10. */
const KNOWN_TYPES = new Set([
  "sheet", "masterobject", "story", "slide", "slideitem", "dimension", "measure", "bookmark",
  "variable", "LoadModel", "snapshot", "embeddedsnapshot", "barchart", "linechart", "piechart",
  "table", "pivot-table", "kpi", "combochart", "scatterplot", "treemap", "map", "gauge",
  "filterpane", "listbox", "text-image", "histogram", "boxplot", "distributionplot",
  "waterfallchart", "mekkochart", "container", "action-button",
]);

const P11: ProbeDef = {
  id: "P11",
  question: "Does GET /<prefix>/qps/csrftoken return a qlik-csrf-token response header?",
  timeoutMs: 30_000,
  needsEngine: false,
  async run(ctx, ev) {
    const url = `${ctx.loc.origin}${ctx.loc.prefix}/qps/csrftoken`;
    ev.url = url;
    const { result, response } = await http(url, { method: "GET" }, "GET csrftoken");
    ev.status = result.status;
    if (result.error) ev.error = result.error;
    const token = response?.headers.get("qlik-csrf-token") ?? null;
    ev.headerPresent = token !== null && token !== "";
    ev.tokenLength = token ? token.length : 0;
    ev.responseHeaderNames = response ? Array.from(response.headers.keys()) : [];
    ctx.csrfToken = token || null;
    return ev.headerPresent
      ? { ok: true, detail: `status ${result.status}, header qlik-csrf-token present` }
      : { ok: false, detail: `status ${result.status ?? "none"}, header qlik-csrf-token absent; P1 connects without token` };
  },
};

const P1: ProbeDef = {
  id: "P1",
  question: "Can the content script open an enigma.js WebSocket session, open the app and read its properties?",
  timeoutMs: 45_000,
  needsEngine: false,
  async run(ctx, ev) {
    const base = `${ctx.loc.wsScheme}://${ctx.loc.host}${ctx.loc.prefix}/app/${ctx.loc.appId}`;
    const url = ctx.csrfToken ? `${base}?qlik-csrf-token=${encodeURIComponent(ctx.csrfToken)}` : base;
    ev.url = ctx.csrfToken ? `${base}?qlik-csrf-token=<redacted>` : base;
    ev.withCsrfToken = Boolean(ctx.csrfToken);

    const session = (enigma as unknown as EnigmaModule).create({
      schema,
      url,
      createSocket: (u) => new WebSocket(u),
      suspendOnClose: false,
    });
    ctx.session = session;
    session.on("notification:*", (method, params) => {
      ctx.notifications.push({ method: String(method), params });
    });
    session.on("closed", (evt) => {
      const e = evt as { code?: number; reason?: string } | undefined;
      ctx.sessionEvents.push(`closed code=${e?.code ?? "?"} reason=${e?.reason ?? ""}`);
    });

    const global = await step(session.open(), "session.open", 20_000);
    ctx.global = global;
    await waitFor(() => ctx.notifications.some((n) => n.method === "OnConnected"), 3_000);
    const connected = ctx.notifications.find((n) => n.method === "OnConnected");
    ev.qSessionState = (connected?.params as { qSessionState?: string } | undefined)?.qSessionState ?? null;
    ev.notifications = ctx.notifications.map((n) => n.method);
    const auth = ctx.notifications.find((n) => n.method === "OnAuthenticationInformation");
    if (auth) ev.authenticationInformation = auth.params;

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
    return { ok: true, detail: `session ${String(ev.qSessionState)}, doc via ${String(ev.docVia)}, title "${String(ev.appTitle)}"` };
  },
};

const P4: ProbeDef = {
  id: "P4",
  question: "Is reading stable: do two consecutive reads of sheets (GetFullPropertyTree) and measures (GetProperties) produce identical JSON?",
  timeoutMs: 240_000,
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
    return {
      ok: deviations === 0 && errors.length === 0,
      detail: `${compared} objects compared, ${deviations} deviations, ${errors.length} read errors`,
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
    if (stories.length === 0) return { ok: true, detail: "no stories in this app" };
    const first = stories[0];
    ev.firstStoryId = first.qId;
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

const P2: ProbeDef = {
  id: "P2",
  question: "Does the engine keep a given qInfo.qId on CreateDimension, CreateMeasure and CreateObject (masterobject, sheet)?",
  timeoutMs: 120_000,
  needsEngine: true,
  async run(ctx, ev) {
    const doc = requireDoc(ctx);
    type Kind = "dimension" | "measure" | "masterobject" | "sheet";
    const specs: { kind: Kind; id: string; create: () => Promise<EngineApi>; get: () => Promise<EngineApi>; destroy: () => Promise<unknown> }[] = [
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
    ];

    const perType: Record<string, unknown> = {};
    let allKept = true;
    for (const s of specs) {
      const r: Record<string, unknown> = { requestedId: s.id };
      perType[s.kind] = r;
      // Remove leftovers of an earlier, interrupted run.
      try {
        await step(s.destroy(), `pre-cleanup ${s.id}`);
      } catch {
        /* not present */
      }
      try {
        const obj = await step(s.create(), `Create ${s.kind}`);
        r.createdHandleId = obj?.id ?? null;
        const back = await step(s.get(), `read back ${s.kind}`);
        const info = (await step(back.getInfo(), `GetInfo ${s.kind}`)) as NxInfo;
        r.readBackId = info?.qId ?? null;
        r.readBackType = info?.qType ?? null;
        r.idKept = info?.qId === s.id;
        if (!r.idKept) allKept = false;
      } catch (e) {
        r.error = describeError(e);
        allKept = false;
      } finally {
        // Always attempt cleanup, also when create/read-back failed or timed out midway.
        try {
          r.destroyed = await step(s.destroy(), `Destroy ${s.kind}`);
        } catch (e) {
          r.destroyError = describeError(e);
        }
      }
    }
    ev.perType = perType;
    return { ok: allKept, detail: allKept ? "all four types kept the given qId" : "at least one type did not keep the qId or failed (see evidence)" };
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
  question: "Does a persistent link object (qId spike-git-link, qType git-link) survive and is it listed by GetAllInfos?",
  timeoutMs: 60_000,
  needsEngine: true,
  async run(ctx, ev) {
    const doc = requireDoc(ctx);
    const before = await getAllInfos(doc);
    ev.inAllInfosBefore = before.some((i) => i.qId === SPIKE_IDS.link);

    let existing: EngineApi | null = null;
    try {
      existing = await step(doc.getObject(SPIKE_IDS.link), "GetObject spike-git-link");
    } catch (e) {
      if (!isNotFound(e)) ev.lookupError = describeError(e);
    }
    ev.existedBefore = existing !== null || ev.inAllInfosBefore === true;
    if (existing) {
      try {
        ev.existingProperties = await step(existing.getProperties(), "GetProperties spike-git-link");
      } catch (e) {
        ev.existingPropertiesError = describeError(e);
      }
    } else {
      // Not deleted and no DoSave here: P7 runs last and saves.
      const created: EngineApi = await step(
        doc.createObject({ qInfo: { qId: SPIKE_IDS.link, qType: "git-link" }, link: { probe: true } }),
        "CreateObject spike-git-link",
      );
      const info = (await step(created.getInfo(), "GetInfo spike-git-link")) as NxInfo;
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
    const ok = ev.doSave === "ok" && before.rows === after.rows;
    return { ok, detail: `DoSave ${String(ev.doSave)}; rows before ${before.rows}, after ${after.rows}` };
  },
};

/** Execution order as decided for the spike. */
const PROBES: ProbeDef[] = [P11, P1, P4, P6, P10, P8, P2, P5, P3, P7];

// ---------------------------------------------------------------------------
// Runner

export async function runProbes(loc: AppLocation, onProgress: (text: string) => void): Promise<SpikeReport> {
  const report: SpikeReport = {
    server: loc.host,
    virtualProxyPrefix: loc.prefix,
    appId: loc.appId,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    probes: [],
  };
  const ctx: Context = {
    loc,
    csrfToken: null,
    session: null,
    global: null,
    doc: null,
    engineUnavailable: null,
    notifications: [],
    sessionEvents: [],
  };

  for (const [index, probe] of PROBES.entries()) {
    onProgress(`Running ${probe.id} (${index + 1}/${PROBES.length})…`);
    const ev: Evidence = {};
    const started = Date.now();
    let ok = false;
    let detail = "";
    if (probe.needsEngine && ctx.engineUnavailable) {
      detail = `skipped: ${ctx.engineUnavailable}`;
    } else {
      try {
        const r = await withTimeout(probe.run(ctx, ev), probe.timeoutMs, probe.id);
        ok = r.ok;
        detail = r.detail;
      } catch (e) {
        detail = `${e instanceof TimeoutError ? "timeout" : "error"}: ${describeError(e)}`;
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
  return report;
}
