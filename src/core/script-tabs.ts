import type { FileContent } from "./types";

export const TAB_ORDER_PATH = "data_load_script/tab_order.txt";
export const TAB_DIVIDER = "%tab_file_order_divider%";
const TAB_DIR = "data_load_script/";
const MARKER = "///$tab ";

export interface ScriptTab { name: string; content: string } // content starts with the line "///$tab <name>"

/** Splits a load script at every line that starts with "///$tab ". The line break before a marker belongs to no tab. */
export function splitScript(script: string): ScriptTab[] {
  const markers: number[] = [];
  const re = /^\/\/\/\$tab /gm;
  for (let m = re.exec(script); m; m = re.exec(script)) markers.push(m.index);
  if (markers.length === 0) return script === "" ? [] : [{ name: "Main", content: script }];

  const breakBefore = (i: number) => (i === 0 ? 0 : script[i - 2] === "\r" ? 2 : 1);
  const tabs: ScriptTab[] = [];
  if (markers[0] > 0) tabs.push({ name: "Main", content: script.slice(0, markers[0] - breakBefore(markers[0])) });
  markers.forEach((start, k) => {
    const end = k + 1 < markers.length ? markers[k + 1] - breakBefore(markers[k + 1]) : script.length;
    const content = script.slice(start, end);
    const name = /^[^\r\n]*/.exec(content.slice(MARKER.length))![0];
    tabs.push({ name, content });
  });
  return tabs;
}

export function joinScript(tabs: ScriptTab[], eol: "\r\n" | "\n"): string {
  return tabs.map((t) => t.content).join(eol);
}

function tabFileBase(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, " ");
}

export function scriptToFiles(script: string): Map<string, string> {
  const files = new Map<string, string>();
  const used = new Set<string>();
  const names: string[] = [];
  for (const tab of splitScript(script)) {
    const base = tabFileBase(tab.name);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
    used.add(name.toLowerCase());
    names.push(name);
    files.set(`${TAB_DIR}${name}.qvs`, tab.content);
  }
  files.set(TAB_ORDER_PATH, names.join(TAB_DIVIDER));
  return files;
}

function asText(content: FileContent): string {
  return typeof content === "string" ? content : new TextDecoder("utf-8").decode(content);
}

export function filesToScript(files: Map<string, FileContent>): string {
  const order = files.get(TAB_ORDER_PATH);
  if (order === undefined) return "";
  const orderText = asText(order);
  if (orderText === "") return "";
  const contents = orderText.split(TAB_DIVIDER).map((name) => {
    const path = `${TAB_DIR}${name}.qvs`;
    const file = files.get(path);
    if (file === undefined) throw new Error(`Missing tab file: ${path}`);
    return asText(file);
  });
  // Use the line ending of the first tab file that has a line break; default CRLF.
  const firstWithBreak = contents.find((c) => c.includes("\n"));
  const eol = firstWithBreak === undefined || firstWithBreak.includes("\r\n") ? "\r\n" : "\n";
  return contents.join(eol);
}
