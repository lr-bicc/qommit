// Qommit service worker: the only place that knows the GitHub token.
import type { GatewayRequest, GatewayResponse } from "../shared/github-port";
import { loadOptions, loadToken } from "../shared/options";
import { handleGateway } from "./gateway";
import { wireSidePanel } from "./side-panel";

wireSidePanel();

// Content scripts keep the update journal in storage.session; it is closed to them by default.
void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const m = message as { target?: unknown; request?: GatewayRequest } | null;
  if (m?.target !== "gateway") return undefined;
  if (sender.id !== chrome.runtime.id) {
    const denied: GatewayResponse = { ok: false, error: { kind: "not-allowed", message: "Sender is not allowed" } };
    sendResponse(denied);
    return undefined;
  }
  void handleGateway(m.request as GatewayRequest, { loadOptions, loadToken, fetch: (input, init) => fetch(input, init) }).then(sendResponse);
  return true;
});
