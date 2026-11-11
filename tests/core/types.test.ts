import { makeSnapshot, APP_ID } from "../fixtures/snapshot";
test("fixture is a fresh object each call", () => {
  const a = makeSnapshot(); a.variables.pop();
  expect(makeSnapshot().variables).toHaveLength(2);
  expect(makeSnapshot().appId).toBe(APP_ID);
});
