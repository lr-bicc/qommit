import { appUrl, engineUrl, parseQlikUrl } from "../../src/qlik/location";

test("parses app and hub urls with and without a virtual proxy", () => {
  const id = "0a15fa01-ba63-45e6-aa3d-e060205e8344";
  expect(parseQlikUrl(`https://qlik.example.com/qs/sense/app/${id}/sheet/abc/state/analysis`))
    .toEqual({ origin: "https://qlik.example.com", prefix: "/qs", appId: id });
  expect(parseQlikUrl(`https://host/sense/app/${id}`)).toEqual({ origin: "https://host", prefix: "", appId: id });
  expect(parseQlikUrl("https://host/qs/hub/stream/x")).toEqual({ origin: "https://host", prefix: "/qs", appId: null });
  expect(parseQlikUrl("https://host/qs/qmc/apps")).toBeNull();
  expect(parseQlikUrl("not a url")).toBeNull();
});

test("handles root hub, url-encoded ids, non-https and look-alike paths", () => {
  expect(parseQlikUrl("https://host/hub")).toEqual({ origin: "https://host", prefix: "", appId: null });
  expect(parseQlikUrl("https://host/hub/")).toEqual({ origin: "https://host", prefix: "", appId: null });
  expect(parseQlikUrl("https://host/qs/sense/app/my%20app%2F1?x=1#y"))
    .toEqual({ origin: "https://host", prefix: "/qs", appId: "my app/1" });
  expect(parseQlikUrl("http://host/qs/hub")).toBeNull();
  expect(parseQlikUrl("https://host/qs/hubx")).toBeNull();
  expect(parseQlikUrl("https://host/qs/sense/app/")).toBeNull();
  expect(parseQlikUrl("https://host:4242/a/b/hub")).toEqual({ origin: "https://host:4242", prefix: "/a/b", appId: null });
});

test("builds engine and app urls", () => {
  const loc = { origin: "https://host", prefix: "/qs" };
  expect(engineUrl(loc, "A", "t/1")).toBe("wss://host/qs/app/A?qlik-csrf-token=t%2F1");
  expect(engineUrl(loc, "A", null)).toBe("wss://host/qs/app/A");
  expect(appUrl(loc, "A")).toBe("https://host/qs/sense/app/A");
});
