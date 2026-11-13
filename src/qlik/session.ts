import schema from "enigma.js/schemas/12.2027.0.json";
import type { EngineApi } from "./engine-types";
import { engineUrl, type QlikLocation } from "./location";

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
    const res = await fetchFn(`${loc.origin}${loc.prefix}/qps/csrftoken`, { method: "GET", credentials: "include" });
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
  session.on("notification:OnAuthenticationInformation", (info: { userId?: string } | undefined) => {
    if (typeof info?.userId === "string") user = info.userId;
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
  try {
    const global = await session.open();
    let doc: EngineApi;
    try {
      doc = await global.openDoc(loc.appId);
    } catch {
      // The app is already open in this client's session: attach to the active doc instead.
      doc = await global.getActiveDoc();
    }
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
    await close();
    throw new QlikSessionError(messageOf(e));
  }
}
