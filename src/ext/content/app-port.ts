import { createContentFiles } from "../../qlik/content-files";
import { readAppInfo, readGitoqlokMeta, readLink, removeLink, writeLink } from "../../qlik/link";
import { appUrl, type QlikLocation } from "../../qlik/location";
import { readApp } from "../../qlik/reader";
import type { EngineSession } from "../../qlik/session";
import type { AppInfo, AppPort } from "../flows/ports";

/** The flows' view of one open Qlik app, backed by an engine session. */
export function createAppPort(session: EngineSession, loc: QlikLocation & { appId: string }, fetchFn: typeof fetch): AppPort {
  const { doc } = session;
  const info = async (): Promise<AppInfo> => {
    const { title, published } = await readAppInfo(doc);
    return { id: loc.appId, title, published, url: appUrl(loc, loc.appId), user: session.user };
  };
  return {
    info,
    async read({ includeFiles, onProgress }) {
      const { published } = await info();
      const files = includeFiles ? createContentFiles(doc, loc, loc.appId, fetchFn) : undefined;
      return readApp(doc, loc.appId, { published, files, onProgress });
    },
    readLink: () => readLink(doc),
    writeLink: (link) => writeLink(doc, link),
    removeLink: () => removeLink(doc),
    readGitoqlokMeta: () => readGitoqlokMeta(doc),
  };
}
