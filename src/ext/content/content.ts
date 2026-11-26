// Qommit content script: runs the commands of the side panel against the Qlik app of this tab.
import enigma from "enigma.js";
import { openGlobal, openSession, type EnigmaCreate } from "../../qlik/session";
import type { LinkData } from "../../qlik/link";
import type { LinkCache } from "../flows/ports";
import type { Command, CommandResult, ProgressEvent } from "../shared/commands";
import type { DiffWindowMessage, OpenDiffWindow } from "../shared/diff-window";
import { createGitHubPort, type GatewayRequest, type GatewayResponse } from "../shared/github-port";
import { loadOptions } from "../shared/options";
import { closeDiffOverlay, handleDiffWindowRequest, setDiffWindowOpener, showDiffOverlay } from "./overlay/show";
import { createJournal } from "./journal";
import { createRouter } from "./router";
import { createServerPort } from "./server-port";

const guard = globalThis as { __qommitContent?: boolean };

const isLink = (v: unknown): v is LinkData => {
  if (typeof v !== "object" || v === null) return false;
  const l = v as Record<string, unknown>;
  return ["repo", "branch", "appId", "syncedSha"].every((k) => typeof l[k] === "string" && l[k] !== "");
};

const storageKey = (key: string): string => `link:${key}`;

const unlinkedKey = (key: string): string => `unlinked:${key}`;

const cache: LinkCache = {
  async get(key) {
    const stored = (await chrome.storage.local.get(storageKey(key)))[storageKey(key)];
    return isLink(stored) ? stored : null;
  },
  async set(key, link) {
    await chrome.storage.local.set({ [storageKey(key)]: link });
  },
  async remove(key) {
    await chrome.storage.local.remove(storageKey(key));
  },
  async isUnlinked(key) {
    return (await chrome.storage.local.get(unlinkedKey(key)))[unlinkedKey(key)] === true;
  },
  async setUnlinked(key, value) {
    if (value) await chrome.storage.local.set({ [unlinkedKey(key)]: true });
    else await chrome.storage.local.remove(unlinkedKey(key));
  },
};

function start(): void {
  const qlik = { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init), create: enigma.create as unknown as EnigmaCreate };
  const github = createGitHubPort((request: GatewayRequest) =>
    chrome.runtime.sendMessage({ target: "gateway", request }) as Promise<GatewayResponse>);

  const router = createRouter({
    currentUrl: () => location.href,
    openSession: (loc) => openSession(loc, qlik),
    github,
    cache,
    loadOptions,
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
    journal: createJournal(chrome.storage.session),
    server: (loc) => createServerPort(loc, {
      openGlobal: (l) => openGlobal(l, qlik),
      openSession: (l) => openSession(l, qlik),
      fetch: (input, init) => fetch(input, init),
    }),
    showDiff: showDiffOverlay,
    closeDiff: closeDiffOverlay,
    emit: (event: ProgressEvent) => {
      // rejects when no panel is open
      chrome.runtime.sendMessage({ target: "panel", event }).catch(() => {});
    },
  });

  // "Maximize" shows the diff in its own window; the service worker opens it.
  setDiffWindowOpener(async (id) => {
    const s = screen as Screen & { availLeft?: number; availTop?: number };
    const area = { left: s.availLeft ?? 0, top: s.availTop ?? 0, width: s.availWidth, height: s.availHeight };
    const open: OpenDiffWindow = { target: "diffWindow", id, area };
    const result = (await chrome.runtime.sendMessage(open)) as CommandResult | undefined;
    if (!result?.ok) throw new Error(result && !result.ok ? result.error.message : "No answer from the service worker");
  });

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const m = message as Partial<DiffWindowMessage> | null;
    if (m?.target !== "diffWindowContent" || sender.id !== chrome.runtime.id) return undefined;
    void handleDiffWindowRequest(m as DiffWindowMessage).then(sendResponse);
    return true;
  });

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const m = message as { target?: unknown; command?: Command } | null;
    if (m?.target !== "content" || sender.id !== chrome.runtime.id) return undefined;
    void router(m.command as Command).then(sendResponse);
    return true;
  });
}

if (!guard.__qommitContent) {
  guard.__qommitContent = true;
  start();
}
