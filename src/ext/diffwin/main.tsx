// Qommit diff window: shows a diff of a Qlik tab in its own browser window ("Maximize" in the overlay).
import { render } from "preact";
import type { CommandResult } from "../shared/commands";
import type { DiffWindowMessage, DiffWindowRequest } from "../shared/diff-window";
import type { Ask } from "./client";
import { DiffWindow } from "./DiffWindow";

const params = new URLSearchParams(location.search);
const tabId = Number(params.get("tabId"));
const id = params.get("id") ?? "";

const ask: Ask = (request: DiffWindowRequest) => {
  const message: DiffWindowMessage = { target: "diffWindowContent", ...request };
  return chrome.tabs.sendMessage(tabId, message) as Promise<CommandResult | undefined>;
};

render(<DiffWindow ask={ask} id={id} close={() => window.close()} />, document.getElementById("root")!);
