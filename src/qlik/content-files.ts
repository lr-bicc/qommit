import type { EngineApi } from "./engine-types";
import { QlikReadError } from "./reader";
import { engineCall as call, withTimeout } from "./timeout";

const DOWNLOAD_TIMEOUT_MS = 60_000;

/** A name that is not valid percent-encoding is a name of its own, not a reason to fail the listing. */
const decodeName = (name: string): string => {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
};

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
        const libs = (await call(doc.getContentLibraries())) as { qItems?: { qName: string; qAppSpecific?: boolean }[] } | undefined;
        if (!Array.isArray(libs?.qItems)) throw new Error("GetContentLibraries answered without qItems");
        const lib = libs.qItems.find((l) => l.qAppSpecific);
        if (!lib) return [];
        const content = (await call(doc.getLibraryContent(lib.qName))) as { qItems?: { qUrl: string }[] } | undefined;
        if (!Array.isArray(content?.qItems)) throw new Error(`GetLibraryContent answered without qItems for ${lib.qName}`);
        return content.qItems.map(({ qUrl }) => {
          const m = URL_NAME.exec(qUrl);
          if (!m) throw new Error(`unexpected content url ${qUrl}`); // never drop a file silently: it would look deleted
          return decodeName(m[1]!);
        });
      } catch (e) {
        throw new QlikReadError(`Could not list static files: ${describe(e)}`, { cause: e });
      }
    },
    async download(name) {
      const url = `${loc.origin}${loc.prefix}/appcontent/${appId}/${name.split("/").map(encodeURIComponent).join("/")}`;
      try {
        return await withTimeout((async () => {
          const res = await fetchFn(url, { method: "GET", credentials: "include" });
          if (res.status < 200 || res.status > 299) throw new Error(`HTTP ${res.status}`);
          // Qlik answers an expired session with its sign-in page (a redirect, or HTML with status 200).
          if (res.redirected || (res.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html")) {
            throw new Error("the answer looks like a sign-in page");
          }
          return new Uint8Array(await res.arrayBuffer());
        })(), DOWNLOAD_TIMEOUT_MS, "Qlik did not answer in time.");
      } catch (e) {
        throw new QlikReadError(`Could not read static file ${name}: ${describe(e)}`, { cause: e });
      }
    },
  };
}
