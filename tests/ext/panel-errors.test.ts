import { errorText } from "../../src/ext/panel/errors";

const e = (code: string, extra: object = {}) => ({ code, message: "raw message", ...extra });

test.each([
  ["no-token", "No GitHub token configured.", "options"],
  ["unauthorized", "Token invalid or expired.", "options"],
  ["sso-required", "Authorize the token for the organization (SSO).", "sso"],
  ["forbidden", "No permission.", undefined],
  ["not-found", "Repository not found or no access.", undefined],
  ["protected-branch", "The branch is protected. Work on your own branch.", undefined],
  ["network", "Network error.", "retry"],
  ["qlik-session", "Qlik session lost. Sign in to Qlik again or reload the page.", "retry"],
  ["qlik-read", "Qlik session lost. Sign in to Qlik again or reload the page.", "retry"],
  ["interrupted", "The page changed while the command was running. Refresh to see the current state.", undefined],
  ["no-content", "Reload the Qlik page and open Qommit again.", undefined],
  ["branch-exists", "Branch already exists.", undefined],
  ["invalid-branch-name", "Invalid branch name.", undefined],
  ["branch-not-found", "Branch not found.", undefined],
  ["repo-not-found", "Repository not found or no access.", undefined],
  ["not-linked", "This app is not linked to a repository.", undefined],
  ["no-app", "Open an app to use Qommit.", undefined],
  ["nothing-to-commit", "Nothing to save.", undefined],
  ["message-required", "Enter a commit message.", undefined],
  ["published", "Published apps are read only. Duplicate the app to make changes.", undefined],
  ["something-else", "raw message", undefined],
])("%s", (code, text, action) => {
  const result = errorText(e(code));
  expect(result.text).toBe(text);
  expect(result.action).toBe(action);
});

test("rate-limited names the local time of the reset", () => {
  const resetAt = new Date(2026, 10, 14, 14, 5, 30).getTime();
  expect(errorText(e("rate-limited", { resetAt }))).toEqual({ text: "GitHub rate limit reached. Try again at 14:05." });
});

test("rate-limited without a reset time", () => {
  expect(errorText(e("rate-limited")).text).toBe("GitHub rate limit reached. Try again later.");
});
