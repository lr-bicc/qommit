import type { Command, CommandError, CommandResult, ProgressEvent } from "../shared/commands";

export class BridgeError extends Error {
  constructor(public error: CommandError) {
    super(error.message);
    this.name = "BridgeError";
  }
}

export interface Bridge {
  send<T>(command: Command): Promise<T>; // rejects with BridgeError
  onProgress(listener: (text: string) => void): () => void;
  openOptions(): void;
}

export function createBridge(tabId: number): Bridge {
  type Attempt = { kind: "answer"; result: CommandResult } | { kind: "none" } | { kind: "rejected"; message: string };

  async function attempt(command: Command): Promise<Attempt> {
    try {
      const result = (await chrome.tabs.sendMessage(tabId, { target: "content", command })) as CommandResult | undefined;
      return result === undefined ? { kind: "none" } : { kind: "answer", result };
    } catch (e) {
      return { kind: "rejected", message: e instanceof Error ? e.message : String(e) };
    }
  }

  const noContent = (): BridgeError =>
    new BridgeError({ code: "no-content", message: "The Qlik page does not answer. Reload it and open Qommit again." });

  return {
    async send<T>(command: Command): Promise<T> {
      let first = await attempt(command);
      // Only "no receiver" proves the command was not delivered; any other failure may have run it already.
      if (first.kind === "rejected" && first.message.includes("Receiving end does not exist")) {
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
        } catch {
          throw noContent();
        }
        first = await attempt(command);
        if (first.kind !== "answer") throw noContent();
      } else if (first.kind !== "answer") {
        throw new BridgeError({ code: "interrupted", message: "The command was interrupted." });
      }
      if (!first.result.ok) throw new BridgeError(first.result.error);
      return first.result.value as T;
    },

    onProgress(listener) {
      const handler = (message: unknown, sender: chrome.runtime.MessageSender): undefined => {
        const m = message as { target?: unknown; event?: ProgressEvent } | null;
        if (m?.target !== "panel" || m.event?.event !== "progress") return undefined;
        if (sender.id !== chrome.runtime.id || sender.tab?.id !== tabId) return undefined;
        listener(m.event.text);
        return undefined;
      };
      chrome.runtime.onMessage.addListener(handler);
      return () => chrome.runtime.onMessage.removeListener(handler);
    },

    openOptions() {
      void chrome.runtime.openOptionsPage();
    },
  };
}
