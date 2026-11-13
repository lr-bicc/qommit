// Repository naming, README generation and the branch table that maps
// branch names to Qlik apps. The table format is the one written by gitoqlok.

const MAX_SLUG_LENGTH = 80;
const TABLE_HEADER = "Branch Name|Qlik application";
const TABLE_SEPARATOR = "---|---";
const HEADER_RE = /^\s*Branch Name\s*\|\s*Qlik application\s*$/;
const SEPARATOR_RE = /^\s*-+\s*\|\s*-+\s*$/;
const LINK_RE = /^\s*\[[^\]]*\]\(([^)\s]+)\)\s*$/;
const APP_ID_RE = /\/app\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function normalizeSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function repoSlug(appName: string, prefix = ""): string {
  const base = normalizeSlug(appName) || "app";
  return normalizeSlug(prefix + base).slice(0, MAX_SLUG_LENGTH).replace(/-+$/, "");
}

export function repoSlugWithId(appName: string, appId: string, prefix = ""): string {
  return `${repoSlug(appName, prefix)}-${appId.slice(0, 8).toLowerCase()}`;
}

export interface BranchRow { branch: string; appUrl: string; appId: string | null }

interface Line { text: string; eol: string }

function splitLines(text: string): Line[] {
  const parts = text.split(/(\r?\n)/);
  const lines: Line[] = [];
  for (let i = 0; i < parts.length; i += 2) lines.push({ text: parts[i], eol: parts[i + 1] ?? "" });
  return lines;
}

function joinLines(lines: Line[]): string {
  return lines.map(l => l.text + l.eol).join("");
}

/** Index of the header line of the branch table, or -1. */
function findTableStart(lines: Line[]): number {
  for (let i = 0; i + 1 < lines.length; i++) {
    if (HEADER_RE.test(lines[i].text) && SEPARATOR_RE.test(lines[i + 1].text)) return i;
  }
  return -1;
}

/** Parses a table row; null when the second cell is not a markdown link. */
function parseRow(line: string): BranchRow | null {
  const pipe = line.indexOf("|");
  const branch = line.slice(0, pipe).trim();
  const link = LINK_RE.exec(line.slice(pipe + 1));
  if (!branch || !link) return null;
  const appUrl = link[1];
  const id = APP_ID_RE.exec(appUrl);
  return { branch, appUrl, appId: id ? id[1].toLowerCase() : null };
}

/** Index range [from, to) of the data rows following the table header at `start`. */
function rowRange(lines: Line[], start: number): [number, number] {
  const from = start + 2;
  let to = from;
  while (to < lines.length && lines[to].text.includes("|")) to++;
  return [from, to];
}

export function parseBranchTable(readme: string): BranchRow[] {
  const lines = splitLines(readme);
  const start = findTableStart(lines);
  if (start < 0) return [];
  const [from, to] = rowRange(lines, start);
  const byBranch = new Map<string, BranchRow>(); // first position, last content
  for (let i = from; i < to; i++) {
    const row = parseRow(lines[i].text);
    if (row) byBranch.set(row.branch, row);
  }
  return [...byBranch.values()];
}

function formatRow(branch: string, appUrl: string): string {
  return `${branch}|[${appUrl}](${appUrl})`;
}

export function upsertBranchRow(readme: string, row: { branch: string; appUrl: string }): string {
  const lines = splitLines(readme);
  const eol = readme.includes("\r\n") ? "\r\n" : "\n";
  const newText = formatRow(row.branch, row.appUrl);
  const start = findTableStart(lines);

  if (start < 0) {
    if (readme === "") return `${TABLE_HEADER}${eol}${TABLE_SEPARATOR}${eol}${newText}${eol}`;
    const gap = /\n$/.test(readme) ? eol + eol : eol + eol + eol;
    return `${readme}${gap}${TABLE_HEADER}${eol}${TABLE_SEPARATOR}${eol}${newText}${eol}`;
  }

  const [from, to] = rowRange(lines, start);
  const matching: number[] = [];
  for (let i = from; i < to; i++) {
    if (parseRow(lines[i].text)?.branch === row.branch) matching.push(i);
  }

  if (matching.length > 0) {
    const first = matching[0];
    lines[first] = { text: newText, eol: lines[first].eol };
    for (const i of matching.slice(1).reverse()) lines.splice(i, 1);
    return joinLines(lines);
  }

  // Append after the last table row; keep the file's end (with or without final newline).
  const last = to - 1;
  const lastEol = lines[last].eol;
  if (lastEol === "") {
    lines[last] = { text: lines[last].text, eol };
    lines.splice(to, 0, { text: newText, eol: "" });
  } else {
    lines.splice(to, 0, { text: newText, eol: lastEol });
  }
  return joinLines(lines);
}

export function canonicalAppId(rows: BranchRow[], defaultBranch: string): string | null {
  return rows.find(r => r.branch === defaultBranch)?.appId
    ?? rows.find(r => r.appId !== null)?.appId
    ?? null;
}

export function findBranchForApp(rows: BranchRow[], appId: string): string | null {
  const wanted = appId.toLowerCase();
  return rows.find(r => r.appId !== null && r.appId.toLowerCase() === wanted)?.branch ?? null;
}

export function createReadme(input: {
  appTitle: string; creatorLogin: string; createdAt: Date;
  sheets: { title: string; description: string }[]; defaultBranch: string; appUrl: string;
}): string {
  return [
    "# Qlik Application Repository",
    `# ${input.appTitle}`,
    "",
    `Created by ${input.creatorLogin} at ${input.createdAt.toISOString()}`,
    "",
    "Sheet Title | Description",
    "------------ | -------------",
    ...input.sheets.map(s => `${s.title}|${s.description}`),
    "",
    "",
    TABLE_HEADER,
    TABLE_SEPARATOR,
    formatRow(input.defaultBranch, input.appUrl),
    "",
  ].join("\n");
}
