export type GitHubErrorKind =
  | "unauthorized"
  | "sso-required"
  | "rate-limited"
  | "forbidden"
  | "not-found"
  | "name-exists"
  | "not-fast-forward"
  | "protected-branch"
  | "network"
  | "unknown";

export class GitHubError extends Error {
  constructor(
    public kind: GitHubErrorKind,
    public status: number,
    message: string,
    public extra: { ssoUrl?: string; resetAt?: Date } = {},
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

function messageOf(body: unknown): string {
  const m = (body as { message?: unknown } | null | undefined)?.message;
  return typeof m === "string" ? m : "";
}

function errorMessagesOf(body: unknown): string[] {
  const errors = (body as { errors?: unknown } | null | undefined)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.map((e) => (typeof (e as { message?: unknown })?.message === "string" ? (e as { message: string }).message : ""));
}

function numberHeader(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  return value !== null && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : undefined;
}

// retry-after (secondary limits) wins; the primary reset time only applies once the quota is used up.
function resetAtOf(headers: Headers): Date | undefined {
  const retry = numberHeader(headers, "retry-after");
  if (retry !== undefined) return new Date(Date.now() + retry * 1000);
  const reset = numberHeader(headers, "x-ratelimit-reset");
  if (reset !== undefined && headers.get("x-ratelimit-remaining") === "0") return new Date(reset * 1000);
  return undefined;
}

/** Maps a failed GitHub HTTP response to a typed error; the first matching rule wins. */
export function toGitHubError(status: number, headers: Headers, body: unknown): GitHubError {
  const message = messageOf(body);
  const lower = message.toLowerCase();
  const text = message ? `GitHub API error ${status}: ${message}` : `GitHub API error ${status}`;

  if (status === 401) return new GitHubError("unauthorized", status, text);

  const sso = headers.get("x-github-sso");
  if (status === 403 && sso !== null) {
    const ssoUrl = /url=([^\s;,]+)/.exec(sso)?.[1];
    return new GitHubError("sso-required", status, text, ssoUrl ? { ssoUrl } : {});
  }

  if (
    (status === 403 || status === 429) &&
    (headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after") || lower.includes("secondary rate limit"))
  ) {
    const resetAt = resetAtOf(headers);
    return new GitHubError("rate-limited", status, text, resetAt ? { resetAt } : {});
  }

  // Classic branch protection and repository rulesets ("Changes must be made through a pull request.").
  if (lower.includes("protected branch") || lower.includes("changes must be made through a pull request")) {
    return new GitHubError("protected-branch", status, text);
  }

  if (status === 422) {
    if (lower.includes("not a fast forward")) return new GitHubError("not-fast-forward", status, text);
    if (lower.includes("already exists") || errorMessagesOf(body).some((m) => m.toLowerCase().includes("already exists"))) {
      return new GitHubError("name-exists", status, text);
    }
  }

  if (status === 403) return new GitHubError("forbidden", status, text);
  if (status === 404) return new GitHubError("not-found", status, text);
  return new GitHubError("unknown", status, text);
}
