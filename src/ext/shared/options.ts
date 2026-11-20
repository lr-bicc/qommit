export interface Options {
  org: string;
  repoPrefix: string;
  /** Qlik Sense server origins, e.g. "https://qlik.example.com". */
  servers: string[];
}

export const DEFAULT_OPTIONS: Options = { org: "lr-bicc", repoPrefix: "", servers: [] };

/** Accepts a bare host or a URL; returns "https://host[:port]" or null. */
export function normalizeServer(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || !url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function loadOptions(): Promise<Options> {
  const { options } = await chrome.storage.local.get("options");
  return { ...DEFAULT_OPTIONS, ...(options as Partial<Options> | undefined) };
}

export async function saveOptions(patch: Partial<Options>): Promise<Options> {
  const merged = { ...(await loadOptions()), ...patch };
  await chrome.storage.local.set({ options: merged });
  return merged;
}

export async function loadToken(): Promise<string> {
  const { secret } = await chrome.storage.local.get("secret");
  return (secret as { token?: string } | undefined)?.token ?? "";
}

export async function saveToken(token: string): Promise<void> {
  await chrome.storage.local.set({ secret: { token } });
}
