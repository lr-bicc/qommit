import schema from "enigma.js/schemas/12.2027.0.json";
import type { EngineApi } from "./engine-types";
import { engineUrl, type QlikLocation } from "./location";
import { engineCall, QlikTimeoutError, withTimeout } from "./timeout";

/** Opening the socket and the document together. */
const OPEN_TIMEOUT_MS = 20_000;
const CSRF_TIMEOUT_MS = 10_000;

export interface EnigmaSession {
  open(): Promise<EngineApi>;
  close(): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (...args: any[]) => void): void;
}
export type EnigmaCreate = (config: { schema: unknown; url: string; createSocket: (url: string) => WebSocket }) => EnigmaSession;

export interface EngineSession {
  doc: EngineApi;
  appId: string;
  user: string;
  isClosed(): boolean;
  close(): Promise<void>;
}

export class QlikSessionError extends Error {}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

/** GET <origin><prefix>/qps/csrftoken; the token is in the `qlik-csrf-token` response header. Null on any failure. */
export async function fetchCsrfToken(loc: { origin: string; prefix: string }, fetchFn: typeof fetch): Promise<string | null> {
  try {
    const res = await withTimeout(fetchFn(`${loc.origin}${loc.prefix}/qps/csrftoken`, { method: "GET", credentials: "include" }),
      CSRF_TIMEOUT_MS, "The CSRF token did not arrive in time.");
    return res.headers.get("qlik-csrf-token") || null;
  } catch {
    return null;
  }
}

export async function openSession(
  loc: QlikLocation & { appId: string },
  deps: { fetch: typeof fetch; create: EnigmaCreate },
): Promise<EngineSession> {
  const token = await fetchCsrfToken(loc, deps.fetch);
  const session = deps.create({
    schema,
    url: engineUrl(loc, loc.appId, token),
    createSocket: (url) => new WebSocket(url),
  });
  let user = "";
  let closed = false;
  let rejectSignIn: (e: Error) => void = () => {};
  const signInRequired = new Promise<never>((_resolve, reject) => { rejectSignIn = reject; });
  signInRequired.catch(() => {}); // only observed while opening
  session.on("notification:OnAuthenticationInformation", (info: { userId?: string; mustAuthenticate?: boolean } | undefined) => {
    if (typeof info?.userId === "string") user = info.userId;
    if (info?.mustAuthenticate === true) rejectSignIn(new QlikSessionError("Not signed in to Qlik."));
  });
  session.on("closed", () => {
    closed = true;
  });
  const close = async (): Promise<void> => {
    if (closed) return;
    try {
      await session.close();
    } catch {
      // already closed or never fully opened
    } finally {
      closed = true;
    }
  };
  const openDoc = async (): Promise<EngineApi> => {
    const global = await session.open();
    try {
      return await global.openDoc(loc.appId);
    } catch {
      // The app is already open in this client's session: attach to the active doc instead.
      return await global.getActiveDoc();
    }
  };
  try {
    const doc = await withTimeout(Promise.race([openDoc(), signInRequired]), OPEN_TIMEOUT_MS, "Qlik did not answer in time.");
    return {
      doc,
      appId: loc.appId,
      get user() {
        return user;
      },
      isClosed: () => closed,
      close,
    };
  } catch (e) {
    void close(); // closing a socket that never answered may not settle either
    if (e instanceof QlikSessionError) throw e;
    if (e instanceof QlikTimeoutError) throw new QlikSessionError(e.message);
    throw new QlikSessionError(messageOf(e));
  }
}

/** Opens the global engine session (no app), e.g. to create an app. */
export async function openGlobal(
  loc: { origin: string; prefix: string },
  deps: { fetch: typeof fetch; create: EnigmaCreate },
): Promise<{ global: EngineApi; close(): Promise<void> }> {
  const token = await fetchCsrfToken(loc, deps.fetch);
  const base = `wss://${new URL(loc.origin).host}${loc.prefix}/app/engineData`;
  const session = deps.create({
    schema,
    url: token ? `${base}?qlik-csrf-token=${encodeURIComponent(token)}` : base,
    createSocket: (url) => new WebSocket(url),
  });
  const close = async (): Promise<void> => {
    try {
      await session.close();
    } catch {
      // already closed or never fully opened
    }
  };
  try {
    const global = await withTimeout(session.open(), OPEN_TIMEOUT_MS, "Qlik did not answer in time.");
    return { global, close };
  } catch (e) {
    void close(); // closing a socket that never answered may not settle either
    if (e instanceof QlikTimeoutError) throw new QlikSessionError(e.message);
    throw new QlikSessionError(messageOf(e));
  }
}

/** Creates an empty app on the server and returns its id. */
export async function createApp(global: EngineApi, name: string): Promise<string> {
  let res: { qSuccess?: boolean; qAppId?: string } | undefined;
  try {
    res = await engineCall(global.createApp(name));
  } catch (e) {
    if (e instanceof QlikTimeoutError) throw new QlikSessionError(e.message);
    throw e;
  }
  if (res?.qSuccess !== true || typeof res.qAppId !== "string" || res.qAppId === "") throw new QlikSessionError("Could not create the app");
  return res.qAppId;
}
