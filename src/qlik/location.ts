export interface QlikLocation { origin: string; prefix: string; appId: string | null } // prefix: "" or "/qs"

const APP_PATH = /^(.*?)\/sense\/app\/([^/]+)(?:\/|$)/;
const HUB_PATH = /^(.*?)\/hub(?:\/|$)/;

function cleanPrefix(prefix: string): string {
  return prefix.replace(/\/+$/, "");
}

/** Derives origin, virtual-proxy prefix and app id from a tab URL; null if it is not a Qlik hub or app page. */
export function parseQlikUrl(url: string): QlikLocation | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const app = APP_PATH.exec(u.pathname);
  if (app) {
    try {
      return { origin: u.origin, prefix: cleanPrefix(app[1]), appId: decodeURIComponent(app[2]) };
    } catch {
      return null;
    }
  }
  const hub = HUB_PATH.exec(u.pathname);
  if (hub) return { origin: u.origin, prefix: cleanPrefix(hub[1]), appId: null };
  return null;
}

export function appUrl(loc: { origin: string; prefix: string }, appId: string): string {
  return `${loc.origin}${loc.prefix}/sense/app/${appId}`;
}

export function engineUrl(loc: { origin: string; prefix: string }, appId: string, csrfToken: string | null): string {
  const base = `wss://${new URL(loc.origin).host}${loc.prefix}/app/${appId}`;
  return csrfToken ? `${base}?qlik-csrf-token=${encodeURIComponent(csrfToken)}` : base;
}
