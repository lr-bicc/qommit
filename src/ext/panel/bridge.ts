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
  /** The answer of the content script of the tab, or undefined when nobody answered. */
  async function attempt(command: Command): Promise<CommandResult | undefined> {
    try {
      return (await chrome.tabs.sendMessage(tabId, { target: "content", command })) as CommandResult | undefined;
    } catch {
      return undefined; // no receiver: the content script is not loaded in this tab
    }
  }

  return {
    async send<T>(command: Command): Promise<T> {
      let result = await attempt(command);
      if (result === undefined) {
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
        } catch {
          // the retry below reports the failure
        }
        result = await attempt(command);
      }
      if (result === undefined) {
        throw new BridgeError({ code: "no-content", message: "The Qlik page does not answer. Reload it and open Qommit again." });
      }
      if (!result.ok) throw new BridgeError(result.error);
      return result.value as T;
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
