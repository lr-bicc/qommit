import { GitHubError, toGitHubError } from "./errors";

export interface GitHubClient {
  rest<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>;
  /** Fetches raw bytes; relies on fetch following redirects (e.g. zipball). */
  raw(path: string): Promise<Uint8Array>;
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
}

export function createGitHubClient(opts: { token: string; fetch?: typeof fetch; baseUrl?: string }): GitHubClient {
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const baseUrl = opts.baseUrl ?? "https://api.github.com";

  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await doFetch(baseUrl + path, init);
    } catch {
      // Deliberately drop the original error: it could echo request details.
      throw new GitHubError("network", 0, "Network request to GitHub failed");
    }
    if (res.status >= 400) {
      const text = await res.text().catch(() => "");
      let parsed: unknown = undefined;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      throw toGitHubError(res.status, res.headers, parsed);
    }
    return res;
  }

  async function json<T>(res: Response): Promise<T> {
    const text = res.status === 204 ? "" : await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    async rest<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown) {
      return json<T>(await send(method, path, body));
    },
    async raw(path) {
      return new Uint8Array(await (await send("GET", path)).arrayBuffer());
    },
    async graphql<T>(query: string, variables: Record<string, unknown>) {
      const res = await json<{ data?: T; errors?: { message?: string }[] }>(await send("POST", "/graphql", { query, variables }));
      if (res?.errors?.length) {
        const first = res.errors[0]?.message;
        throw new GitHubError("unknown", 200, first ? `GitHub GraphQL error: ${first}` : "GitHub GraphQL error");
      }
      return res?.data as T;
    },
  };
}
