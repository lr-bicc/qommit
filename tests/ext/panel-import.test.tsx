// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { App } from "../../src/ext/panel/App";
import { BridgeError } from "../../src/ext/panel/bridge";
import type { Command } from "../../src/ext/shared/commands";
import { installFakeChrome } from "./fake-chrome";
import { fakeBridge, LINKED, view, type FakeBridge } from "./fake-bridge";

beforeEach(() => { installFakeChrome(); });
afterEach(cleanup);

const c1 = { sha: "1".repeat(40), message: "First", author: "Ann", date: "2026-11-01T10:00:00Z", parents: [] };
const c2 = { sha: "2".repeat(40), message: "Second", author: "Ann", date: "2026-11-02T10:00:00Z", parents: [c1.sha] };
const tag = { name: "v1.0", sha: c1.sha, message: "", date: null };
const REPO = "lr-bicc/sales";
const NEW_URL = "https://qlik.example.com/sense/app/new1";
const imported = { appId: "new1", name: "Sales (main)", url: NEW_URL };
const NOTE = "The new app is not linked. Open it to connect it or create a branch.";

function hub(answers: Partial<Record<Command["cmd"], unknown[]>> = {}): FakeBridge {
  return fakeBridge({
    status: [{ page: "hub" }],
    listRepos: [[{ repo: REPO, defaultBranch: "main", marked: true }, { repo: "lr-bicc/other", defaultBranch: "main", marked: true }]],
    listBranches: [{ defaultBranch: "main", branches: ["main", "dev"] }],
    commits: [[c2, c1]],
    tags: [[tag]],
    importApp: [imported],
    ...answers,
  });
}

const importButton = (): HTMLButtonElement => screen.getByRole("button", { name: "Import" }) as HTMLButtonElement;
const radioOf = (text: string): HTMLInputElement => screen.getByText(text).closest("label")!.querySelector("input")!;

async function chooseRepo(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: REPO }));
  await waitFor(() => expect((screen.getByLabelText("Branch") as HTMLSelectElement).value).toBe("main"));
  await waitFor(() => expect(importButton().disabled).toBe(false));
}

test("the hub shows the import", async () => {
  render(<App bridge={hub()} />);
  expect(await screen.findByText("Open an app to use Qommit.")).toBeTruthy();
  expect(screen.getByText("Repository")).toBeTruthy();
  expect(importButton().disabled).toBe(true);
});

test("import from the latest commit of a branch", async () => {
  const bridge = hub();
  render(<App bridge={bridge} />);
  await chooseRepo();
  fireEvent.click(importButton());
  expect(await screen.findByText("Created Sales (main)")).toBeTruthy();
  expect(bridge.commands.find((c) => c.cmd === "importApp")).toEqual({ cmd: "importApp", repo: REPO, sha: c2.sha, label: "main" });
  expect(bridge.commands.find((c) => c.cmd === "commits")).toEqual({ cmd: "commits", repo: REPO, branch: "main", page: 1 });
  const link = screen.getByRole("link", { name: "Open app" });
  expect(link.getAttribute("href")).toBe(NEW_URL);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noreferrer");
  expect(screen.getByText(NOTE)).toBeTruthy();
});

test("import from another branch uses that branch name and its head", async () => {
  const bridge = hub({ commits: [[c2, c1], [c1]] });
  render(<App bridge={bridge} />);
  await chooseRepo();
  fireEvent.change(screen.getByLabelText("Branch"), { target: { value: "dev" } });
  await waitFor(() => expect(bridge.commands.filter((c) => c.cmd === "commits").map((c) => (c as { branch: string }).branch)).toEqual(["main", "dev"]));
  await waitFor(() => expect(importButton().disabled).toBe(false));
  fireEvent.click(importButton());
  await screen.findByText("Created Sales (main)");
  expect(bridge.commands.find((c) => c.cmd === "importApp")).toEqual({ cmd: "importApp", repo: REPO, sha: c1.sha, label: "dev" });
});

test("import from a commit uses the short sha as label", async () => {
  const bridge = hub();
  render(<App bridge={bridge} />);
  await chooseRepo();
  fireEvent.click(radioOf("Commit"));
  expect(importButton().disabled).toBe(true);
  fireEvent.change(await screen.findByLabelText("Choose commit"), { target: { value: c1.sha } });
  expect(importButton().disabled).toBe(false);
  fireEvent.click(importButton());
  await screen.findByText("Created Sales (main)");
  expect(bridge.commands.find((c) => c.cmd === "importApp")).toEqual({ cmd: "importApp", repo: REPO, sha: c1.sha, label: "1111111" });
});

test("import from a tag uses the tag name as label", async () => {
  const bridge = hub({ importApp: [{ appId: "new1", name: "Sales (v1.0)", url: NEW_URL }] });
  render(<App bridge={bridge} />);
  await chooseRepo();
  fireEvent.click(radioOf("Tag"));
  expect(importButton().disabled).toBe(true);
  fireEvent.change(await screen.findByLabelText("Choose tag"), { target: { value: "v1.0" } });
  fireEvent.click(importButton());
  expect(await screen.findByText("Created Sales (v1.0)")).toBeTruthy();
  expect(bridge.commands.find((c) => c.cmd === "importApp")).toEqual({ cmd: "importApp", repo: REPO, sha: c1.sha, label: "v1.0" });
  expect(bridge.commands.find((c) => c.cmd === "tags")).toEqual({ cmd: "tags", repo: REPO });
});

test("changing the repository resets the choices", async () => {
  const bridge = hub();
  render(<App bridge={bridge} />);
  await chooseRepo();
  fireEvent.click(radioOf("Tag"));
  fireEvent.change(await screen.findByLabelText("Choose tag"), { target: { value: "v1.0" } });
  expect(importButton().disabled).toBe(false);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = bridge.send.bind(bridge);
  bridge.send = (async (command: Command) => { if (command.cmd === "listBranches") await gate; return original(command); }) as FakeBridge["send"];
  fireEvent.click(screen.getByRole("button", { name: "lr-bicc/other" }));
  expect(importButton().disabled).toBe(true);
  expect(screen.queryByLabelText("Choose tag")).toBeNull();
  expect(radioOf("Latest commit").checked).toBe(true);
  release();
  await waitFor(() => expect(importButton().disabled).toBe(false));
});

test("Import stays disabled while the import runs", async () => {
  const bridge = hub();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = bridge.send.bind(bridge);
  bridge.send = (async (command: Command) => { if (command.cmd === "importApp") await gate; return original(command); }) as FakeBridge["send"];
  render(<App bridge={bridge} />);
  await chooseRepo();
  fireEvent.click(importButton());
  await waitFor(() => expect(importButton().disabled).toBe(true));
  fireEvent.click(importButton());
  release();
  await screen.findByText("Created Sales (main)");
  expect(bridge.commands.filter((c) => c.cmd === "importApp").length).toBe(1);
});

test("an incomplete import links the app", async () => {
  const failure = new BridgeError({ code: "import-failed", message: "boom", detail: { appId: "new1", url: NEW_URL } });
  render(<App bridge={hub({ importApp: [failure] })} />);
  await chooseRepo();
  fireEvent.click(importButton());
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("The import stopped. The new app was created but is incomplete.")).toBeTruthy();
  const link = within(alert).getByRole("link", { name: "Open the incomplete app" });
  expect(link.getAttribute("href")).toBe(NEW_URL);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noreferrer");
  expect(screen.queryByText(NOTE)).toBeNull();
});

test("a failed import without an app has no link", async () => {
  const failure = new BridgeError({ code: "import-failed", message: "boom", detail: { appId: null, url: null } });
  render(<App bridge={hub({ importApp: [failure] })} />);
  await chooseRepo();
  fireEvent.click(importButton());
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("The import stopped. The new app was created but is incomplete.")).toBeTruthy();
  expect(within(alert).queryByRole("link")).toBeNull();
});

test("other errors show their text", async () => {
  const failure = new BridgeError({ code: "invalid-target", message: "bad" });
  render(<App bridge={hub({ importApp: [failure] })} />);
  await chooseRepo();
  fireEvent.click(importButton());
  expect(await screen.findByText("The selected state contains files that cannot be applied.")).toBeTruthy();
});

test("inside an app the import is the last tab", async () => {
  const bridge = fakeBridge({
    status: [view(LINKED)], localChanges: [{ repo: REPO, baseSha: "abc", items: [], unmaintained: [] }],
    listRepos: [[{ repo: REPO, defaultBranch: "main", marked: true }]],
  });
  render(<App bridge={bridge} />);
  const tabs = within(await screen.findByRole("tablist")).getAllByRole("tab").map((t) => t.textContent);
  expect(tabs).toEqual(["Local Changes", "History", "Tags", "Import"]);
  fireEvent.click(screen.getByRole("tab", { name: "Import" }));
  expect(await screen.findByText("Repository")).toBeTruthy();
  expect(await screen.findByRole("button", { name: REPO })).toBeTruthy();
});
