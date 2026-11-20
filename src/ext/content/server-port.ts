import type { EngineApi } from "../../qlik/engine-types";
import type { QlikLocation } from "../../qlik/location";
import { createApp, type EngineSession } from "../../qlik/session";
import type { ServerPort } from "../flows/ports";
import { createAppPort } from "./app-port";

export interface ServerPortDeps {
  openGlobal(loc: QlikLocation): Promise<{ global: EngineApi; close(): Promise<void> }>;
  openSession(loc: QlikLocation & { appId: string }): Promise<EngineSession>;
  fetch: typeof fetch;
}

/** Creates apps on the server: the global session makes the app, an app session then opens it. */
export function createServerPort(loc: QlikLocation, deps: ServerPortDeps): ServerPort {
  return {
    async createApp(name) {
      const g = await deps.openGlobal(loc);
      let appId: string;
      try {
        appId = await createApp(g.global, name);
      } finally {
        await g.close();
      }
      const appLoc = { ...loc, appId };
      const session = await deps.openSession(appLoc);
      return { app: createAppPort(session, appLoc, deps.fetch), close: () => session.close() };
    },
  };
}
