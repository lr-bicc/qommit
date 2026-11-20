// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { OptionsPage } from "../../src/ext/options/Options";
import { installFakeChrome, type FakeChrome } from "./fake-chrome";

let chrome: FakeChrome;
beforeEach(() => {
  chrome = installFakeChrome();
});
afterEach(cleanup);

test("Check connection reports the login on success", async () => {
  chrome.respond = () => ({ ok: true, value: { login: "octocat" } });
  render(<OptionsPage />);
  fireEvent.click(await screen.findByText("Check connection"));
  expect(await screen.findByText(/Connected as octocat/)).toBeTruthy();
  expect(chrome.sent).toEqual([{ target: "gateway", request: { op: "whoAmI", args: [] } }]);
});

test("Check connection reports an invalid token", async () => {
  chrome.respond = () => ({ ok: false, error: { kind: "unauthorized", message: "x" } });
  render(<OptionsPage />);
  fireEvent.click(await screen.findByText("Check connection"));
  expect(await screen.findByText(/Token invalid or expired/)).toBeTruthy();
});

test("Add server requests the permission and stores the server", async () => {
  render(<OptionsPage />);
  fireEvent.input(await screen.findByPlaceholderText("https://qlik.example.com"), { target: { value: "qlik.example.com" } });
  fireEvent.click(screen.getByText("Add server"));
  await waitFor(() => expect((chrome.store.options as any)?.servers).toEqual(["https://qlik.example.com"]));
  expect(chrome.permissionRequests).toEqual([["https://qlik.example.com/*"]]);
  expect(await screen.findByText("https://qlik.example.com")).toBeTruthy();
});

test("a denied permission leaves the server out", async () => {
  chrome.grantPermissions = false;
  render(<OptionsPage />);
  fireEvent.input(await screen.findByPlaceholderText("https://qlik.example.com"), { target: { value: "qlik.example.com" } });
  fireEvent.click(screen.getByText("Add server"));
  expect(await screen.findByText(/Permission was not granted/)).toBeTruthy();
  expect((chrome.store.options as any)?.servers ?? []).toEqual([]);
});

test("an invalid address is rejected without a permission request", async () => {
  render(<OptionsPage />);
  fireEvent.input(await screen.findByPlaceholderText("https://qlik.example.com"), { target: { value: "http://x" } });
  fireEvent.click(screen.getByText("Add server"));
  expect(await screen.findByText(/Enter an https address/)).toBeTruthy();
  expect(chrome.permissionRequests).toEqual([]);
});

test("Remove drops the server and returns the permission", async () => {
  chrome.store.options = { org: "lr-bicc", repoPrefix: "", servers: ["https://a.example"] };
  render(<OptionsPage />);
  fireEvent.click(await screen.findByText("Remove"));
  await waitFor(() => expect((chrome.store.options as any).servers).toEqual([]));
  expect(chrome.removedPermissions).toEqual([["https://a.example/*"]]);
});

test("the token is saved under the secret key only", async () => {
  render(<OptionsPage />);
  fireEvent.input(await screen.findByLabelText("Personal access token"), { target: { value: "ghp_x" } });
  await waitFor(() => expect(chrome.store.secret).toEqual({ token: "ghp_x" }));
  expect(JSON.stringify(chrome.store.options ?? {})).not.toContain("ghp_x");
});
