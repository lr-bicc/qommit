import { createJournal } from "../../src/ext/content/journal";
import { installFakeChrome } from "./fake-chrome";

const entry = (appId: string) => ({
  appId, repo: "lr-bicc/sales", branch: "main", target: "abc", backupBranch: null, total: 2, startedAt: "2026-01-01T00:00:00.000Z",
});

test("the journal lives in storage.session per app, under a lower-case key", async () => {
  const fake = installFakeChrome();
  const journal = createJournal(chrome.storage.session);
  expect(await journal.get("AbC")).toBeNull();
  await journal.set(entry("AbC"));
  await journal.set(entry("other"));
  expect(Object.keys(fake.session).sort()).toEqual(["update:abc", "update:other"]);
  expect(fake.store).toEqual({});
  expect(await journal.get("abc")).toEqual(entry("AbC"));
  await journal.clear("ABC");
  expect(await journal.get("AbC")).toBeNull();
  expect(await journal.get("other")).toEqual(entry("other"));
});

test("a damaged journal entry counts as none", async () => {
  const fake = installFakeChrome();
  fake.session["update:abc"] = { appId: "abc" };
  expect(await createJournal(chrome.storage.session).get("abc")).toBeNull();
});
