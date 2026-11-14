import type { CommandError } from "../shared/commands";

export interface ErrorText { text: string; action?: "options" | "sso" | "retry" }

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
    case "qlik-session":
    case "qlik-read": return { text: "Qlik session lost. Sign in to Qlik again or reload the page.", action: "retry" };
    case "interrupted": return { text: "The page changed while the command was running. Refresh to see the current state." };
    case "no-content": return { text: "Reload the Qlik page and open Qommit again." };
    case "branch-exists": return { text: "Branch already exists." };
    case "invalid-branch-name": return { text: "Invalid branch name." };
    case "branch-not-found": return { text: "Branch not found." };
    case "not-linked": return { text: "This app is not linked to a repository." };
    case "no-app": return { text: "Open an app to use Qommit." };
    case "nothing-to-commit": return { text: "Nothing to save." };
    case "message-required": return { text: "Enter a commit message." };
    case "published": return { text: "Published apps are read only. Duplicate the app to make changes." };
    default: return { text: error.message };
  }
}
