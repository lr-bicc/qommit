import type { Bridge } from "../../src/ext/panel/bridge";
import { BridgeError } from "../../src/ext/panel/bridge";
import type { Command, StatusView } from "../../src/ext/shared/commands";
import type { AppStatus } from "../../src/ext/flows/status";
import { APP_ID } from "../fixtures/snapshot";

export interface FakeBridge extends Bridge {
  commands: Command[];
  optionsOpened: number;
  /** Delivers a progress text to the listeners. */
  progress(text: string): void;
  /** Delivers a new URL of the panel's tab to the listeners. */
  tabUrl(url: string): void;
}

/** Answers per `cmd` in order; the last one stays valid. A BridgeError in the list rejects. */
export function fakeBridge(answers: Partial<Record<Command["cmd"], unknown[]>>): FakeBridge {
  const used: Record<string, number> = {};
  const listeners = new Set<(text: string) => void>();
  const urlListeners = new Set<(url: string) => void>();
  const bridge: FakeBridge = {
    commands: [],
    optionsOpened: 0,
    async send<T>(command: Command): Promise<T> {
      bridge.commands.push(command);
      const list = answers[command.cmd] ?? [];
      const i = Math.min(used[command.cmd] ?? 0, list.length - 1);
      used[command.cmd] = (used[command.cmd] ?? 0) + 1;
      if (i < 0) return undefined as T;
      const answer = list[i];
      if (answer instanceof BridgeError) throw answer;
      return answer as T;
    },
    onProgress(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    onTabUrl(listener) {
      urlListeners.add(listener);
      return () => void urlListeners.delete(listener);
    },
    openOptions() {
      bridge.optionsOpened++;
    },
    progress(text) {
      for (const l of [...listeners]) l(text);
    },
    tabUrl(url) {
      for (const l of [...urlListeners]) l(url);
    },
  };
  return bridge;
}

export const LINK = { repo: "lr-bicc/sales", branch: "main", appId: APP_ID, syncedSha: "abc" };
export const LINKED: AppStatus = { state: "linked", link: LINK, defaultBranch: "main", headSha: "abc", behindBy: 0, stored: "app" };

export function view(status: AppStatus): StatusView {
  return {
    page: "app",
    app: { id: APP_ID, title: "Sales", published: status.state === "published", url: `https://qlik.example.com/sense/app/${APP_ID}`, user: "r.vasilev", canWrite: true },
    status,
    suggestedBranch: "r.vasilev",
  };
}
