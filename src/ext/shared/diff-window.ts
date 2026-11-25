import type { DiffEntry } from "../flows/diff";
import type { WireContent } from "./wire";

/**
 * The diff in its own window ("Maximize"). The content script of the Qlik tab keeps the diff; the window, an extension
 * page, asks it for the list and for each file's two sides. The service worker opens the window and tells the tab when
 * it is closed.
 */

/** Content script → service worker: show the diff `id` in the window of the sender's tab. */
export interface OpenDiffWindow { target: "diffWindow"; id: string }

/** Window → content script of its Qlik tab, and service worker → content script ("closed"). */
export type DiffWindowRequest =
  | { kind: "entries"; id: string }
  | { kind: "contents"; id: string; path: string }
  | { kind: "closed" };
export type DiffWindowMessage = { target: "diffWindowContent" } & DiffWindowRequest;

/** Answer to "entries". */
export interface DiffWindowView { title: string; select?: string; repo: string; entries: DiffEntry[] }
/** Answer to "contents"; a side without the file is null. */
export interface DiffWindowContents { before: WireContent | null; after: WireContent | null }

/** Path of the window page for the diff `id` of the Qlik tab `tabId`. */
export const diffWindowPath = (tabId: number, id: string): string =>
  `diff.html?tabId=${tabId}&id=${encodeURIComponent(id)}`;
