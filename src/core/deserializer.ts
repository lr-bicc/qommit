import type { AppSnapshot, FileContent, FileMap, GenericProps, PropertyTree } from "./types";
import { filesToScript } from "./script-tabs";
import { replaceAppContentIds } from "./app-content-ids";
import { withoutSnapshotIdentity } from "./embedded-snapshots";

function asText(content: FileContent): string {
  return typeof content === "string" ? content : new TextDecoder("utf-8").decode(content);
}

function asBytes(content: FileContent): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

/** gitoqlok kept the engine's `qMeta` in the value colours of a dimension; the app never writes it, so it is dropped. */
function withoutColorMapStamp(dim: GenericProps): GenericProps {
  const colors = (dim as { _ColorMapModel?: unknown })._ColorMapModel;
  if (!colors || typeof colors !== "object" || !("qMeta" in colors)) return dim;
  const { qMeta: _stamp, ...rest } = colors as Record<string, unknown>;
  return { ...dim, _ColorMapModel: rest } as GenericProps;
}

/** Rebuilds a snapshot from repository files. Does not validate; unreadable JSON throws the native error. */
export function deserializeApp(files: FileMap, opts: { targetAppId: string }): AppSnapshot {
  const parse = <T>(content: FileContent): T => JSON.parse(replaceAppContentIds(asText(content), opts.targetAppId)) as T;

  const sortedPaths = [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const inDir = (dir: string) => sortedPaths.filter((p) => p.startsWith(`objects/${dir}/`) && p.endsWith(".json") && !p.slice(dir.length + 9).includes("/"));
  const list = <T>(dir: string): T[] => inDir(dir).map((p) => parse<T>(files.get(p)!));

  const staticFiles = new Map<string, Uint8Array>();
  for (const p of sortedPaths) {
    if (p.startsWith("appcontent/") && p.length > "appcontent/".length) staticFiles.set(p.slice("appcontent/".length), asBytes(files.get(p)!));
  }

  const appProps = files.get("objects/appprops.json");
  return {
    appId: opts.targetAppId,
    script: filesToScript(files),
    appProps: appProps === undefined ? [] : parse<PropertyTree[]>(appProps).map(withoutSnapshotIdentity),
    variables: list<GenericProps>("variables"),
    dimensions: list<GenericProps>("dimensions").map(withoutColorMapStamp),
    measures: list<GenericProps>("measures"),
    masterObjects: list<PropertyTree>("masterobjects").map(withoutSnapshotIdentity),
    sheets: list<PropertyTree>("sheets").map(withoutSnapshotIdentity),
    stories: list<PropertyTree>("stories").map(withoutSnapshotIdentity),
    bookmarks: list<GenericProps>("bookmarks"),
    staticFiles,
  };
}
