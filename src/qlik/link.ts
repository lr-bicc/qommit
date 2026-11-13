import type { EngineApi } from "./engine-types";

export interface LinkData { repo: string; branch: string; appId: string; syncedSha: string }
export const LINK_ID = "qommit-link"; // qId and qType
export const GITOQLOK_META_ID = "_gitoqlikMetaData";

/**
 * "The object does not exist": engine code 2, enigma.js' own OBJECT_NOT_FOUND (-2, raised for a null handle)
 * or a "not found" message. Anything else (access denied, closed session) is a real failure.
 */
const isNotFound = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false;
  const { code, message } = e as { code?: unknown; message?: unknown };
  return code === 2 || code === -2 || (typeof message === "string" && /not found/i.test(message));
};

async function openOrNull(doc: EngineApi, id: string): Promise<EngineApi | null> {
  try {
    return await doc.getObject(id);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

const isNonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export async function readLink(doc: EngineApi): Promise<LinkData | null> {
  const handle = await openOrNull(doc, LINK_ID);
  if (!handle) return null;
  const props = await handle.getProperties();
  const l = props?.link;
  if (typeof l !== "object" || l === null) return null;
  const { repo, branch, appId, syncedSha } = l as Record<string, unknown>;
  if (!isNonEmpty(repo) || !isNonEmpty(branch) || !isNonEmpty(appId) || !isNonEmpty(syncedSha)) return null;
  return { repo, branch, appId, syncedSha };
}

/** Never saves the app. Engine errors propagate; the caller falls back to local storage. */
export async function writeLink(doc: EngineApi, link: LinkData): Promise<void> {
  const props = {
    qInfo: { qId: LINK_ID, qType: LINK_ID },
    link: { repo: link.repo, branch: link.branch, appId: link.appId, syncedSha: link.syncedSha },
  };
  const existing = await openOrNull(doc, LINK_ID);
  if (existing) await existing.setProperties(props);
  else await doc.createObject(props);
}

export async function removeLink(doc: EngineApi): Promise<void> {
  try {
    await doc.destroyObject(LINK_ID); // resolves false on the real engine when nothing was destroyed
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
}

const REPO_PATTERN = /^[^\s/]+\/[^\s/]+$/;

function findRepo(node: unknown): string | null {
  if (typeof node !== "object" || node === null) return null;
  for (const [key, value] of Object.entries(node)) {
    if (key === "full_name" && typeof value === "string" && REPO_PATTERN.test(value)) return value;
    const found = findRepo(value);
    if (found !== null) return found;
  }
  return null;
}

export async function readGitoqlokMeta(doc: EngineApi): Promise<{ repo: string | null; lastCommitId: string | null } | null> {
  const handle = await openOrNull(doc, GITOQLOK_META_ID);
  if (!handle) return null;
  const props = await handle.getProperties();
  const data: unknown = props?._data;
  const last: unknown = (data as { infoByServerType?: { github?: { lastCommitId?: unknown } } } | undefined)
    ?.infoByServerType?.github?.lastCommitId;
  return { repo: findRepo(data), lastCommitId: isNonEmpty(last) ? last : null };
}

export async function readAppInfo(doc: EngineApi): Promise<{ title: string; published: boolean }> {
  const layout = await doc.getAppLayout();
  return { title: String(layout?.qTitle ?? ""), published: layout?.published === true };
}
