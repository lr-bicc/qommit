import type { CommandError } from "../shared/commands";

/** `detail`: the raw reason, shown as a second, smaller line where it helps. */
export interface ErrorText { text: string; action?: "options" | "sso" | "retry"; detail?: string }

const two = (n: number): string => String(n).padStart(2, "0");

export function errorText(error: CommandError): ErrorText {
  switch (error.code) {
    case "no-token": return { text: "No GitHub token configured.", action: "options" };
    case "unauthorized": return { text: "Token invalid or expired.", action: "options" };
    case "sso-required": return { text: "Authorize the token for the organization (SSO).", action: "sso" };
    case "rate-limited": {
      if (error.resetAt === undefined) return { text: "GitHub rate limit reached. Try again later." };
      const at = new Date(error.resetAt);
      return { text: `GitHub rate limit reached. Try again at ${two(at.getHours())}:${two(at.getMinutes())}.` };
    }
    case "forbidden": return { text: "No permission." };
    case "not-found":
    case "repo-not-found": return { text: "Repository not found or no access." };
    case "protected-branch": return { text: "The branch is protected. Work on your own branch." };
    case "network": return { text: "Network error.", action: "retry" };
    case "qlik-session": return { text: "Qlik session lost. Sign in to Qlik again or reload the page.", action: "retry" };
    case "qlik-read": return { text: "Could not read the app from Qlik.", action: "retry", detail: error.message };
    case "app-changed": return { text: "This tab now shows a different app. Qommit has refreshed." };
    case "interrupted": return { text: "The command was interrupted. Refresh to see the current state." };
    case "no-content": return { text: "Reload the Qlik page and open Qommit again." };
    case "branch-exists": return { text: "Branch already exists." };
    case "invalid-branch-name": return { text: "Invalid branch name." };
    case "branch-not-found": return { text: "Branch not found." };
    case "not-linked": return { text: "This app is not linked to a repository." };
    case "no-app": return { text: "Open an app to use Qommit." };
    case "nothing-to-commit": return { text: "Nothing to save." };
    case "message-required": return { text: "Enter a commit message." };
    case "published": return { text: "Published apps are read only. Duplicate the app to make changes." };
    case "cannot-write": return { text: "You have no permission to change this app." };
    case "tag-exists": return { text: "Tag already exists." };
    case "invalid-tag-name": return { text: "Invalid tag name." };
    case "import-failed": {
      const appId = (error.detail as { appId?: unknown } | null | undefined)?.appId;
      if (typeof appId === "string") return { text: "The import stopped. The new app was created but is incomplete." };
      return { text: "The app could not be created.", detail: error.message };
    }
    case "invalid-target": return { text: "The selected state contains files that cannot be applied." };
    case "update-failed": return { text: "The update stopped.", detail: error.message };
    default: return { text: error.message };
  }
}
