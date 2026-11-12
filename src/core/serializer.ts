import type { AppSnapshot, FileMap } from "./types";
import { scriptToFiles } from "./script-tabs";

export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function normalizeAppId(text: string, appId: string, canonicalAppId: string): string {
  return text.split(`/appcontent/${appId}/`).join(`/appcontent/${canonicalAppId}/`);
}

// An empty id or one with "/" yields a path the reader skips, so the object would be lost on the next update.
function checkId(label: string, id: string): string {
  if (typeof id !== "string" || id === "" || id.includes("/")) {
    throw new Error(`Cannot store ${label} with id ${JSON.stringify(id)}: ids must be non-empty and must not contain "/"`);
  }
  return id;
}

/** Turns a snapshot into the repository layout (repository path -> content). Throws on ids that cannot be stored. */
export function serializeApp(snap: AppSnapshot, opts: { canonicalAppId: string }): FileMap {
  const files: FileMap = new Map();
  const json = (value: unknown) => normalizeAppId(toJson(value), snap.appId, opts.canonicalAppId);

  for (const [path, content] of scriptToFiles(snap.script)) files.set(path, content);
  files.set("objects/appprops.json", json(snap.appProps));

  const addGeneric = (dir: string, label: string, items: { qInfo: { qId: string } }[]) => {
    for (const item of items) files.set(`objects/${dir}/${checkId(label, item.qInfo.qId)}.json`, json(item));
  };
  const addTree = (dir: string, label: string, trees: { qProperty: { qInfo: { qId: string } } }[]) => {
    for (const tree of trees) files.set(`objects/${dir}/${checkId(label, tree.qProperty.qInfo.qId)}.json`, json(tree));
  };

  addGeneric("variables", "variable", snap.variables.filter((v) => v.qIsScriptCreated !== true && v.qIsReserved !== true));
  addGeneric("dimensions", "dimension", snap.dimensions);
  addGeneric("measures", "measure", snap.measures);
  addTree("masterobjects", "master object", snap.masterObjects);
  addTree("sheets", "sheet", snap.sheets);
  addTree("stories", "story", snap.stories);
  addGeneric("bookmarks", "bookmark", snap.bookmarks);

  for (const [name, bytes] of snap.staticFiles) files.set(`appcontent/${name}`, bytes);
  return files;
}
