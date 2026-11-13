import { createGitHubClient } from "../../github/client";
import { GitHubError } from "../../github/errors";
import * as repoApi from "../../github/repo";
import type { FileChange } from "../../github/repo";
import * as snapshotApi from "../../github/snapshot";
import type { Options } from "../shared/options";
import type { GatewayRequest, GatewayResponse, GitHubPort, WireError } from "../shared/github-port";
import { fromWire, type WireContent } from "../shared/wire";

export interface GatewayDeps {
  loadOptions(): Promise<Options>;
  loadToken(): Promise<string>;
  fetch: typeof fetch;
}

type Client = ReturnType<typeof createGitHubClient>;
type Call = (client: Client, org: string, args: unknown[]) => Promise<unknown>;

const isString = (v: unknown): v is string => typeof v === "string";
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isWireContent(v: unknown): v is WireContent {
  return isObject(v) && (isString(v.text) || isString(v.base64));
}

/** Validates and converts the wire form of commitFiles' input; null when malformed. */
function parseCommitInput(v: unknown): { branch: string; parentSha: string; message: string; changes: FileChange[] } | null {
  if (!isObject(v) || !isString(v.branch) || !isString(v.parentSha) || !isString(v.message) || !Array.isArray(v.changes)) return null;
  if (!isValidArg("ref", v.branch) || !isValidArg("sha", v.parentSha)) return null;
  const changes: FileChange[] = [];
  for (const c of v.changes) {
    if (!isObject(c) || !isString(c.path) || !isValidArg("path", c.path)) return null;
    if (c.content === null) changes.push({ path: c.path, content: null });
    else if (isWireContent(c.content)) {
      try {
        changes.push({ path: c.path, content: fromWire(c.content) });
      } catch {
        return null; // invalid base64
      }
    } else return null;
  }
  return { branch: v.branch, parentSha: v.parentSha, message: v.message, changes };
}

interface OpSpec {
  /** Number of leading string arguments (the first is a repo when `repo` is set). */
  strings: number;
  tail?: "number" | "commit"; // one extra trailing argument: a page number, or commitFiles' input object
  repo?: boolean;
  run: Call;
}

const OPS: Record<keyof GitHubPort, OpSpec> = {
  whoAmI: { strings: 0, run: (c) => repoApi.whoAmI(c) },
  listOrgRepos: { strings: 0, run: (c, org) => snapshotApi.listOrgRepos(c, org) },
  findRepoForApp: { strings: 1, run: (c, org, [appId]) => snapshotApi.findRepoForApp(c, org, appId as string) },
  createRepo: { strings: 1, run: (c, org, [name]) => snapshotApi.createRepo(c, org, name as string) },
  getRepo: { strings: 1, repo: true, run: (c, _o, [r]) => repoApi.getRepo(c, r as string) },
  getBranchSha: { strings: 2, repo: true, run: (c, _o, [r, b]) => repoApi.getBranchSha(c, r as string, b as string) },
  listBranches: { strings: 1, repo: true, run: (c, _o, [r]) => repoApi.listBranches(c, r as string) },
  getTree: {
    strings: 2, repo: true,
    run: async (c, _o, [r, sha]) => [...(await repoApi.getTree(c, r as string, sha as string))],
  },
  readTextFile: { strings: 3, repo: true, run: (c, _o, [r, ref, path]) => repoApi.readTextFile(c, r as string, ref as string, path as string) },
  createBranch: {
    strings: 3, repo: true,
    run: async (c, _o, [r, name, sha]) => {
      await repoApi.createBranch(c, r as string, name as string, sha as string);
      return null;
    },
  },
  commitFiles: {
    strings: 1, tail: "commit", repo: true,
    run: (c, _o, [r, input]) => repoApi.commitFiles(c, r as string, input as NonNullable<ReturnType<typeof parseCommitInput>>),
  },
  listCommits: { strings: 2, tail: "number", repo: true, run: (c, _o, [r, b, page]) => repoApi.listCommits(c, r as string, b as string, page as number) },
  compare: { strings: 3, repo: true, run: (c, _o, [r, base, head]) => repoApi.compare(c, r as string, base as string, head as string) },
};

type ArgKind = "sha" | "ref" | "path" | "name";

// Argument kinds by position; unlisted string arguments are not interpolated into URL paths.
const ARG_KINDS: Partial<Record<keyof GitHubPort, Record<number, ArgKind>>> = {
  createRepo: { 0: "name" },
  getBranchSha: { 1: "ref" },
  getTree: { 1: "sha" },
  readTextFile: { 1: "ref", 2: "path" },
  createBranch: { 1: "ref", 2: "sha" },
  listCommits: { 1: "ref" },
  compare: { 1: "ref", 2: "ref" },
};

/** Rejects values that could climb out of the repository path or alter the URL. */
function isSafeSegments(value: string): boolean {
  if (value === "" || value.startsWith("/")) return false;
  if (/[?#\\%\u0000-\u001f\u007f]/.test(value)) return false;
  return value.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

function isValidArg(kind: ArgKind, value: string): boolean {
  if (kind === "sha") return /^[0-9a-f]{4,40}$/i.test(value);
  if (kind === "name") return isValidName(value);
  return isSafeSegments(value);
}

const isValidName = (name: string): boolean => /^[A-Za-z0-9._-]+$/.test(name) && !/^\.+$/.test(name);

const notAllowed = (message: string): GatewayResponse => ({ ok: false, error: { kind: "not-allowed", message } });

function isRepoOf(repo: string, org: string): boolean {
  const m = /^([^/]+)\/([A-Za-z0-9._-]+)$/.exec(repo);
  return m !== null && m[1].toLowerCase() === org.toLowerCase() && isValidName(m[2]);
}

function toWireError(e: unknown): WireError {
  if (e instanceof GitHubError) {
    const error: WireError = { kind: e.kind, message: e.message };
    if (e.extra.ssoUrl !== undefined) error.ssoUrl = e.extra.ssoUrl;
    if (e.extra.resetAt !== undefined) error.resetAt = e.extra.resetAt.getTime();
    return error;
  }
  return { kind: "internal", message: e instanceof Error && e.message ? e.message : "Internal error" };
}

export async function handleGateway(request: GatewayRequest, deps: GatewayDeps): Promise<GatewayResponse> {
  const op = isObject(request) && isString(request.op) && Object.hasOwn(OPS, request.op) ? (request.op as keyof GitHubPort) : null;
  if (op === null) return notAllowed("Unknown operation");
  const spec = OPS[op];

  let token = "";
  try {
    token = await deps.loadToken();
    if (!token) return { ok: false, error: { kind: "no-token", message: "No GitHub token configured" } };
    const options = await deps.loadOptions();

    const args = Array.isArray(request.args) ? [...request.args] : [];
    if (args.length !== spec.strings + (spec.tail ? 1 : 0)) return notAllowed("Wrong number of arguments");
    for (let i = 0; i < spec.strings; i++) if (!isString(args[i])) return notAllowed("Wrong argument type");
    const kinds = ARG_KINDS[op] ?? {};
    for (const [i, kind] of Object.entries(kinds)) {
      if (!isValidArg(kind, args[Number(i)] as string)) return notAllowed("Invalid argument value");
    }
    if (spec.tail === "number") {
      const page = args[spec.strings];
      if (typeof page !== "number" || !Number.isInteger(page) || page < 1) return notAllowed("Wrong argument type");
    }
    if (spec.tail === "commit") {
      const input = parseCommitInput(args[spec.strings]);
      if (input === null) return notAllowed("Malformed commit input");
      args[spec.strings] = input;
    }
    if (spec.repo && !isRepoOf(args[0] as string, options.org)) return notAllowed("Repository is outside the configured organisation");

    const client = createGitHubClient({ token, fetch: deps.fetch });
    return { ok: true, value: (await spec.run(client, options.org, args)) ?? null };
  } catch (e) {
    const error = toWireError(e);
    if (token) error.message = error.message.split(token).join("***");
    return { ok: false, error };
  }
}
