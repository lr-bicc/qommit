import { DEFAULT_OPTIONS, loadOptions, normalizeServer, saveOptions, saveToken } from "../../src/ext/shared/options";
import { installFakeChrome } from "./fake-chrome";

test("normalizeServer keeps only an https origin", () => {
  expect(normalizeServer(" qlik.example.com ")).toBe("https://qlik.example.com");
  expect(normalizeServer("https://qlik.example.com/qs/hub/")).toBe("https://qlik.example.com");
  expect(normalizeServer("https://host:4443/x")).toBe("https://host:4443");
  expect(normalizeServer("http://host")).toBeNull();
  expect(normalizeServer("")).toBeNull();
});

test("options and token live under separate storage keys", async () => {
  const c = installFakeChrome();
  expect(await loadOptions()).toEqual(DEFAULT_OPTIONS);
  await saveOptions({ servers: ["https://a"] });
  await saveToken("tok");
  expect(c.store.options).toEqual({ org: "lr-bicc", repoPrefix: "", servers: ["https://a"] });
  expect(c.store.secret).toEqual({ token: "tok" });
  expect(JSON.stringify(c.store.options)).not.toContain("tok");
});
