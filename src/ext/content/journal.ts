import type { JournalEntry, UpdateJournal } from "../flows/ports";

const keyOf = (appId: string): string => `update:${appId.toLowerCase()}`;

const isEntry = (v: unknown): v is JournalEntry => {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return ["appId", "repo", "branch", "target", "startedAt"].every((k) => typeof e[k] === "string")
    && (e.backupBranch === null || typeof e.backupBranch === "string") && typeof e.total === "number";
};

/** Keeps the update journal per app in a storage area (chrome.storage.session: gone when the browser closes). */
export function createJournal(area: chrome.storage.StorageArea): UpdateJournal {
  return {
    async get(appId) {
      const stored = (await area.get(keyOf(appId)))[keyOf(appId)];
      return isEntry(stored) ? stored : null;
    },
    async set(entry) {
      await area.set({ [keyOf(entry.appId)]: entry });
    },
    async clear(appId) {
      await area.remove(keyOf(appId));
    },
  };
}
