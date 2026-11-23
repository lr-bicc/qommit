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
  ["qlik-read", "Could not read the app from Qlik.", "retry"],
  ["interrupted", "The command was interrupted. Refresh to see the current state.", undefined],
  ["app-changed", "This tab now shows a different app. Qommit has refreshed.", undefined],
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

test("qlik-read carries the error's message as detail; other codes have none", () => {
  expect(errorText({ code: "qlik-read", message: "Could not read sheet s1: timeout" }))
    .toEqual({ text: "Could not read the app from Qlik.", action: "retry", detail: "Could not read sheet s1: timeout" });
  expect(errorText(e("network")).detail).toBeUndefined();
});

test.each([
  ["cannot-write", "You have no permission to change this app."],
  ["tag-exists", "Tag already exists."],
  ["invalid-tag-name", "Invalid tag name."],
  ["invalid-target", "The selected state contains files that cannot be applied."],
])("%s (plan 3)", (code, text) => {
  const result = errorText(e(code));
  expect(result.text).toBe(text);
  expect(result.action).toBeUndefined();
});

test("import-failed with an app says it is incomplete", () => {
  const result = errorText(e("import-failed", { detail: { appId: "new1", url: "u" } }));
  expect(result.text).toBe("The import stopped. The new app was created but is incomplete.");
});

test("import-failed without an app says it could not be created and shows the engine message", () => {
  expect(errorText(e("import-failed", { message: "no quota", detail: { appId: null, url: null } })))
    .toEqual({ text: "The app could not be created.", detail: "no quota" });
});

test("update-failed shows the message as detail", () => {
  expect(errorText(e("update-failed", { message: "Qlik said no" }))).toEqual({ text: "The update stopped.", detail: "Qlik said no" });
});
