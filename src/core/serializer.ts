import type { AppSnapshot, FileMap } from "./types";
import { scriptToFiles } from "./script-tabs";

export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function normalizeAppId(text: string, appId: string, canonicalAppId: string): string {
  return text.split(`/appcontent/${appId}/`).join(`/appcontent/${canonicalAppId}/`);
}

/** Turns a snapshot into the repository layout (repository path -> content). */
export function serializeApp(snap: AppSnapshot, opts: { canonicalAppId: string }): FileMap {
  const files: FileMap = new Map();
  const json = (value: unknown) => normalizeAppId(toJson(value), snap.appId, opts.canonicalAppId);

  for (const [path, content] of scriptToFiles(snap.script)) files.set(path, content);
  files.set("objects/appprops.json", json(snap.appProps));

  const addGeneric = (dir: string, items: { qInfo: { qId: string } }[]) => {
    for (const item of items) files.set(`objects/${dir}/${item.qInfo.qId}.json`, json(item));
  };
  const addTree = (dir: string, trees: { qProperty: { qInfo: { qId: string } } }[]) => {
    for (const tree of trees) files.set(`objects/${dir}/${tree.qProperty.qInfo.qId}.json`, json(tree));
  };

  addGeneric("variables", snap.variables.filter((v) => v.qIsScriptCreated !== true && v.qIsReserved !== true));
  addGeneric("dimensions", snap.dimensions);
  addGeneric("measures", snap.measures);
  addTree("masterobjects", snap.masterObjects);
  addTree("sheets", snap.sheets);
  addTree("stories", snap.stories);
  addGeneric("bookmarks", snap.bookmarks);

  for (const [name, bytes] of snap.staticFiles) files.set(`appcontent/${name}`, bytes);
  return files;
}
