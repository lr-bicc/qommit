import { createServerPort } from "../../src/ext/content/server-port";
import type { EngineApi } from "../../src/qlik/engine-types";
import type { EngineSession } from "../../src/qlik/session";
import { QlikSessionError } from "../../src/qlik/session";
import { makeSnapshot } from "../fixtures/snapshot";
import { appFromSnapshot, fakeDoc } from "../qlik/fake-engine";

const LOC = { origin: "https://qlik.example.com", prefix: "/qs", appId: null };

function setup(createAppResult: unknown = { qSuccess: true, qAppId: "new-app" }) {
  const order: string[] = [];
  const globalApi = { createApp: vi.fn(async () => { order.push("createApp"); return createAppResult; }) } as unknown as EngineApi;
  const fake = fakeDoc(appFromSnapshot(makeSnapshot(), { title: "Sales" }));
  const sessionClose = vi.fn(async () => { order.push("session.close"); });
  const deps = {
    openGlobal: vi.fn(async () => ({ global: globalApi, close: async () => { order.push("global.close"); } })),
    openSession: vi.fn(async (l: { appId: string }): Promise<EngineSession> => {
      order.push(`openSession ${l.appId}`);
      return { doc: fake.doc, appId: l.appId, user: "u", isClosed: () => false, close: sessionClose };
    }),
    fetch: (async () => new Response(null, { status: 201 })) as typeof fetch,
  };
  return { deps, order, port: createServerPort(LOC, deps), sessionClose };
}

test("createApp creates the app, closes the global session, then opens the new app", async () => {
  const { port, order, deps, sessionClose } = setup();
  const { app, close } = await port.createApp("Sales (main)");
  expect(order).toEqual(["createApp", "global.close", "openSession new-app"]);
  expect(deps.openSession).toHaveBeenCalledWith({ ...LOC, appId: "new-app" });
  expect((await app.info()).id).toBe("new-app");
  await close();
  expect(sessionClose).toHaveBeenCalled();
});

test("a failed creation closes the global session and opens no app session", async () => {
  const { port, order, deps } = setup({ qSuccess: false });
  await expect(port.createApp("x")).rejects.toBeInstanceOf(QlikSessionError);
  expect(order).toEqual(["createApp", "global.close"]);
  expect(deps.openSession).not.toHaveBeenCalled();
});
