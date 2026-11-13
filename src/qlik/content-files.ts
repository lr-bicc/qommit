import type { EngineApi } from "./engine-types";
import { QlikReadError } from "./reader";

export interface ContentFiles { list(): Promise<string[]>; download(name: string): Promise<Uint8Array> }

const describe = (e: unknown): string => {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
};

const URL_NAME = /\/appcontent\/[^/]+\/(.+)$/;

/** Lists and downloads the static files (app content) of one app. Every failure is a QlikReadError. */
export function createContentFiles(doc: EngineApi, loc: { origin: string; prefix: string }, appId: string, fetchFn: typeof fetch): ContentFiles {
  return {
    async list() {
      try {
        const libs = (await doc.getContentLibraries()) as { qItems?: { qName: string; qAppSpecific?: boolean }[] } | undefined;
        if (!Array.isArray(libs?.qItems)) throw new Error("GetContentLibraries answered without qItems");
        const lib = libs.qItems.find((l) => l.qAppSpecific);
        if (!lib) return [];
        const content = (await doc.getLibraryContent(lib.qName)) as { qItems?: { qUrl: string }[] } | undefined;
        if (!Array.isArray(content?.qItems)) throw new Error(`GetLibraryContent answered without qItems for ${lib.qName}`);
        return content.qItems.map(({ qUrl }) => {
          const m = URL_NAME.exec(qUrl);
          if (!m) throw new Error(`unexpected content url ${qUrl}`); // never drop a file silently: it would look deleted
          return decodeURIComponent(m[1]!);
        });
      } catch (e) {
        throw new QlikReadError(`Could not list static files: ${describe(e)}`, { cause: e });
      }
    },
    async download(name) {
      const url = `${loc.origin}${loc.prefix}/appcontent/${appId}/${name.split("/").map(encodeURIComponent).join("/")}`;
      try {
        const res = await fetchFn(url, { method: "GET", credentials: "include" });
        if (res.status < 200 || res.status > 299) throw new Error(`HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        throw new QlikReadError(`Could not read static file ${name}: ${describe(e)}`, { cause: e });
      }
    },
  };
}
