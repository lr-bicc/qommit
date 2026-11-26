import type { DiffSource } from "../flows/diff";
import { FlowError, type FlowErrorCode } from "../flows/ports";
import type { CommandResult } from "../shared/commands";
import type { DiffWindowContents, DiffWindowRequest, DiffWindowView } from "../shared/diff-window";
import { fromWire } from "../shared/wire";

/** Sends a request to the content script of the Qlik tab; undefined when nobody answered. */
export type Ask = (request: DiffWindowRequest) => Promise<CommandResult | undefined>;

const gone = (): FlowError => new FlowError("diff-gone", "The Qlik tab no longer has this diff.");

async function call(ask: Ask, request: DiffWindowRequest): Promise<unknown> {
  let result: CommandResult | undefined;
  try {
    result = await ask(request);
  } catch {
    throw gone(); // the tab was closed or reloaded
  }
  if (result === undefined || result === null) throw gone();
  if (!result.ok) throw new FlowError(result.error.code as FlowErrorCode, result.error.message, result.error.detail);
  return result.value;
}

/** Loads the diff `id` from the Qlik tab: the list now, each file's two sides when it is shown. */
export async function loadDiffWindow(ask: Ask, id: string): Promise<{ view: DiffWindowView; source: DiffSource }> {
  const view = (await call(ask, { kind: "entries", id })) as DiffWindowView;
  const source: DiffSource = {
    repo: view.repo,
    entries: view.entries,
    async contents(path) {
      const sides = (await call(ask, { kind: "contents", id, path })) as DiffWindowContents;
      return {
        before: sides.before === null ? null : fromWire(sides.before),
        after: sides.after === null ? null : fromWire(sides.after),
      };
    },
  };
  return { view, source };
}
