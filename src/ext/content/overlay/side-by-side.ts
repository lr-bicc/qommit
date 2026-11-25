import type { LineChange } from "../../../core/diff";

export interface SideCell { text: string; kind: "same" | "added" | "removed" }
export interface SideRow { left: SideCell | null; right: SideCell | null }

/** Lays a line diff out in two columns: a block of removed lines and the added block right after it are paired line by line. */
export function sideBySide(lines: LineChange[]): SideRow[] {
  const rows: SideRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.kind === "same") {
      rows.push({ left: { text: line.text, kind: "same" }, right: { text: line.text, kind: "same" } });
      i++;
      continue;
    }
    const removed: SideCell[] = [];
    const added: SideCell[] = [];
    while (i < lines.length && lines[i]!.kind === "removed") removed.push({ text: lines[i++]!.text, kind: "removed" });
    while (i < lines.length && lines[i]!.kind === "added") added.push({ text: lines[i++]!.text, kind: "added" });
    for (let n = 0; n < Math.max(removed.length, added.length); n++) {
      rows.push({ left: removed[n] ?? null, right: added[n] ?? null });
    }
  }
  return rows;
}
