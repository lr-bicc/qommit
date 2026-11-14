// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { App } from "../../src/ext/panel/App";
import { BridgeError } from "../../src/ext/panel/bridge";
import { installFakeChrome, type FakeChrome } from "./fake-chrome";
import type { FakeBridge } from "./fake-bridge";
import { fakeBridge, LINK, LINKED, view } from "./fake-bridge";

let chrome: FakeChrome;
beforeEach(() => {
  chrome = installFakeChrome();
});
afterEach(cleanup);

test("unlinked app offers both ways and creates a repository", async () => {
  const bridge = fakeBridge({ status: [view({ state: "unlinked" }), view(LINKED)], createRepository: [LINK] });
  render(<App bridge={bridge} />);
  await screen.findByText("No linked repository");
  fireEvent.click(screen.getByText("Create repository"));
  await screen.findByText("lr-bicc/sales");
  expect(bridge.commands.map((c) => c.cmd)).toEqual(["status", "createRepository", "status"]);
});

test("a copy creates a branch with the suggested name", async () => {
  const bridge = fakeBridge({ status: [view({ state: "duplicated", source: { repo: "lr-bicc/sales", branch: "dev", syncedSha: "a" }, defaultBranch: "main" }), view(LINKED)], createBranch: [LINK] });
  render(<App bridge={bridge} />);
  fireEvent.click(await screen.findByText("Create Branch"));
  expect((screen.getByLabelText("Branch Name") as HTMLInputElement).value).toBe("r.vasilev");
  fireEvent.click(screen.getByLabelText(/Branch off from the branch/));
  fireEvent.click(screen.getAllByText("Create Branch").at(-1)!);
  await screen.findByText("lr-bicc/sales");
  expect(bridge.commands[1]).toEqual({ cmd: "createBranch", name: "r.vasilev", fromSource: true });
});

test("an existing branch name keeps the dialog open with the message", async () => {
  const bridge = fakeBridge({ status: [view({ state: "duplicated", source: { repo: "lr-bicc/sales", branch: null, syncedSha: null }, defaultBranch: "main" })],
    createBranch: [new BridgeError({ code: "branch-exists", message: "x" })] });
  render(<App bridge={bridge} />);
  fireEvent.click(await screen.findByText("Create Branch"));
  expect(screen.queryByLabelText(/Branch off from the branch/)).toBeNull();
  fireEvent.click(screen.getAllByText("Create Branch").at(-1)!);
  await screen.findByText("Branch already exists.");
  expect(screen.getByLabelText("Branch Name")).toBeTruthy();
});

test("the branch checkbox names the source branch", async () => {
  const bridge = fakeBridge({ status: [view({ state: "duplicated", source: { repo: "lr-bicc/sales", branch: "dev", syncedSha: "a" }, defaultBranch: "main" })] });
  render(<App bridge={bridge} />);
  fireEvent.click(await screen.findByText("Create Branch"));
  expect(screen.getByLabelText(/Branch off from the branch/).closest("label")!.textContent).toContain("dev");
  fireEvent.click(screen.getByText("Cancel"));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("without a bridge the panel points to the options", () => {
  render(<App bridge={null} />);
  expect(screen.getByText("Qommit works on Qlik Sense servers that are listed in the options.")).toBeTruthy();
  fireEvent.click(screen.getByText("Open options"));
  expect(chrome.optionsPageOpened).toBe(1);
});

test("Open options with a bridge calls openOptions", async () => {
  const bridge = fakeBridge({ status: [new BridgeError({ code: "no-token", message: "x" })] });
  render(<App bridge={bridge} />);
  await screen.findByText("No GitHub token configured.");
  fireEvent.click(screen.getByText("Open options"));
  expect(bridge.optionsOpened).toBe(1);
});

test("the hub page asks to open an app", async () => {
  render(<App bridge={fakeBridge({ status: [{ page: "hub" }] })} />);
  await screen.findByText("Open an app to use Qommit.");
});

test("the header shows title, repo link, branch and the commits behind", async () => {
  const behind = { ...LINKED, behindBy: 2 } as typeof LINKED;
  render(<App bridge={fakeBridge({ status: [view(behind)] })} />);
  await screen.findByText("Repository has 2 new commits");
  expect(screen.getByText("Sales")).toBeTruthy();
  expect(screen.getByText("lr-bicc/sales").getAttribute("href")).toBe("https://github.com/lr-bicc/sales");
  expect(screen.getByText("main")).toBeTruthy();
});

test("one commit behind uses the singular", async () => {
  const behind = { ...LINKED, behindBy: 1 } as typeof LINKED;
  render(<App bridge={fakeBridge({ status: [view(behind)] })} />);
  await screen.findByText("Repository has 1 new commit");
});

test("a failed status shows the message and Retry loads it again", async () => {
  const bridge = fakeBridge({ status: [new BridgeError({ code: "network", message: "x" }), view({ state: "unlinked" })] });
  render(<App bridge={bridge} />);
  await screen.findByText("Network error.");
  fireEvent.click(screen.getByText("Retry"));
  await screen.findByText("No linked repository");
  expect(bridge.commands.map((c) => c.cmd)).toEqual(["status", "status"]);
});

test("sso errors offer an Authorize link in a new tab", async () => {
  const bridge = fakeBridge({ status: [new BridgeError({ code: "sso-required", message: "x", ssoUrl: "https://github.com/sso" })] });
  render(<App bridge={bridge} />);
  const link = await screen.findByText("Authorize");
  expect(link.getAttribute("href")).toBe("https://github.com/sso");
  expect(link.getAttribute("target")).toBe("_blank");
});

test("the footer shows the last progress text and Ready otherwise", async () => {
  const bridge = fakeBridge({ status: [view({ state: "unlinked" })] });
  render(<App bridge={bridge} />);
  await screen.findByText("No linked repository");
  expect(screen.getByText("Ready")).toBeTruthy();
  bridge.progress("Loading application data… 3/9");
  await screen.findByText("Loading application data… 3/9");
});

test("Refresh loads the status again", async () => {
  const bridge = fakeBridge({ status: [view({ state: "unlinked" })] });
  render(<App bridge={bridge} />);
  await screen.findByText("No linked repository");
  fireEvent.click(screen.getByTitle("Refresh"));
  await waitFor(() => expect(bridge.commands).toHaveLength(2));
});

test("a taken repository name offers connecting or the suggestion", async () => {
  const taken = new BridgeError({ code: "repo-exists", message: "x", detail: { name: "lr-sales", suggestion: "lr-sales-1111" } });
  const bridge = fakeBridge({ status: [view({ state: "unlinked" }), view(LINKED)], createRepository: [taken, LINK] });
  render(<App bridge={bridge} />);
  fireEvent.click(await screen.findByText("Create repository"));
  await screen.findByText("A repository named lr-sales already exists.");
  fireEvent.click(screen.getByText("Create as lr-sales-1111"));
  await screen.findByText("lr-bicc/sales");
  expect(bridge.commands[2]).toEqual({ cmd: "createRepository", name: "lr-sales-1111" });
  expect(bridge.commands[1]).toEqual({ cmd: "createRepository" });
});

test("branch-missing offers Create Branch and Connect", async () => {
  render(<App bridge={fakeBridge({ status: [view({ state: "branch-missing", link: LINK, defaultBranch: "main" })] })} />);
  await screen.findByText("Branch main no longer exists on GitHub.");
  expect(screen.getByText("Create Branch")).toBeTruthy();
  expect(screen.getByText("Connect to existing repository")).toBeTruthy();
  expect(screen.getByTitle("Unlink repository")).toBeTruthy();
});

test("repo-missing: Unlink Repository asks first, then unlinks and reloads", async () => {
  const bridge = fakeBridge({ status: [view({ state: "repo-missing", repo: "lr-bicc/sales" }), view({ state: "unlinked" })], unlink: [null] });
  render(<App bridge={bridge} />);
  await screen.findByText("Repository not found or no access.");
  fireEvent.click(screen.getAllByText("Unlink Repository")[0]);
  expect(bridge.commands.map((c) => c.cmd)).toEqual(["status"]);
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("Unlink this app from lr-bicc/sales?")).toBeTruthy();
  fireEvent.click(within(dialog).getByText("Unlink"));
  await screen.findByText("No linked repository");
  expect(bridge.commands.map((c) => c.cmd)).toEqual(["status", "unlink", "status"]);
});

test("the header Unlink sends only after the confirmation and Cancel does nothing", async () => {
  const bridge = fakeBridge({ status: [view(LINKED), view({ state: "unlinked" })], unlink: [null] });
  render(<App bridge={bridge} />);
  await screen.findByText("lr-bicc/sales");
  fireEvent.click(screen.getByTitle("Unlink repository"));
  fireEvent.click(within(screen.getByRole("dialog")).getByText("Cancel"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(bridge.commands.map((c) => c.cmd)).toEqual(["status"]);
  fireEvent.click(screen.getByTitle("Unlink repository"));
  expect(screen.getByText("Unlink this app from lr-bicc/sales?")).toBeTruthy();
  fireEvent.click(within(screen.getByRole("dialog")).getByText("Unlink"));
  await screen.findByText("No linked repository");
  expect(bridge.commands.map((c) => c.cmd)).toEqual(["status", "unlink", "status"]);
});

test("a linked app shows the two tabs", async () => {
  render(<App bridge={fakeBridge({ status: [view(LINKED)] })} />);
  await screen.findByRole("tab", { name: "Local Changes" });
  fireEvent.click(screen.getByRole("tab", { name: "History" }));
  expect(screen.getByRole("tab", { name: "History" }).getAttribute("aria-selected")).toBe("true");
});

test("a published app is read only", async () => {
  const published = { state: "published", repo: "lr-bicc/sales", branch: "main", syncedSha: "abc" } as const;
  render(<App bridge={fakeBridge({ status: [view(published)] })} />);
  await screen.findByText("Published app – read only. Duplicate the app to make changes.");
  expect(screen.queryByRole("tab")).toBeNull();
  expect(screen.queryByTitle("Unlink repository")).toBeNull();
});

test("duplicated explains the situation", async () => {
  render(<App bridge={fakeBridge({ status: [view({ state: "duplicated", source: { repo: "lr-bicc/sales", branch: null, syncedSha: null }, defaultBranch: "main" })] })} />);
  await screen.findByText("We found a repository for the master Qlik application, from which current application was duplicated");
  expect(screen.getByText("Unlink Repository")).toBeTruthy();
  expect(screen.getByText("Connect to existing repository")).toBeTruthy();
});

test("the connect dialog filters repositories and connects to an existing branch", async () => {
  const bridge = fakeBridge({
    status: [view({ state: "unlinked" }), view(LINKED)],
    listRepos: [[{ repo: "lr-bicc/sales", defaultBranch: "main" }, { repo: "lr-bicc/finance", defaultBranch: "main" }]],
    listBranches: [{ defaultBranch: "main", branches: ["main", "dev"] }],
    connect: [LINK],
  });
  render(<App bridge={bridge} />);
  fireEvent.click(await screen.findByText("Connect to existing repository"));
  const dialog = await screen.findByRole("dialog", { name: "Connect to existing repository" });
  await within(dialog).findByText("lr-bicc/finance");
  fireEvent.input(within(dialog).getByPlaceholderText("Search repositories"), { target: { value: "SAL" } });
  expect(within(dialog).queryByText("lr-bicc/finance")).toBeNull();
  fireEvent.click(within(dialog).getByText("lr-bicc/sales"));
  await within(dialog).findByLabelText("To existing branch");
  fireEvent.click(within(dialog).getByLabelText("To existing branch"));
  expect((within(dialog).getByLabelText("Branch") as HTMLSelectElement).value).toBe("main");
  fireEvent.click(within(dialog).getByText("Connect"));
  await screen.findByText("Local Changes");
  expect(bridge.commands.map((c) => c.cmd)).toEqual(["status", "listRepos", "listBranches", "connect", "status"]);
  expect(bridge.commands[3]).toEqual({ cmd: "connect", repo: "lr-bicc/sales", mode: "existing-branch", branch: "main" });
});

test("the connect dialog defaults to a new branch with the suggested name", async () => {
  const bridge = fakeBridge({
    status: [view({ state: "unlinked" }), view(LINKED)],
    listRepos: [[{ repo: "lr-bicc/sales", defaultBranch: "main" }]],
    listBranches: [{ defaultBranch: "main", branches: ["main"] }],
    connect: [new BridgeError({ code: "branch-exists", message: "x" })],
  });
  render(<App bridge={bridge} />);
  fireEvent.click(await screen.findByText("Connect to existing repository"));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(await within(dialog).findByText("lr-bicc/sales"));
  const input = (await within(dialog).findByLabelText("Branch name")) as HTMLInputElement;
  expect(input.value).toBe("r.vasilev");
  fireEvent.click(within(dialog).getByText("Connect"));
  await within(dialog).findByText("Branch already exists.");
  expect(bridge.commands[3]).toEqual({ cmd: "connect", repo: "lr-bicc/sales", mode: "new-branch", branch: "r.vasilev" });
});

const net = () => new BridgeError({ code: "network", message: "x" });

/** Makes the next `cmd` answers stay pending until `release()` is called. */
function holdCommand(bridge: FakeBridge, cmd: string): { release(): void } {
  const inner = bridge.send.bind(bridge);
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  bridge.send = (async (command) => {
    const answer = inner(command); // records the command right away
    if (command.cmd === cmd) await gate;
    return answer;
  }) as FakeBridge["send"];
  return { release };
}

test("Retry in the connect dialog loads the repository list again", async () => {
  const bridge = fakeBridge({
    status: [view({ state: "unlinked" })],
    listRepos: [net(), [{ repo: "lr-bicc/sales", defaultBranch: "main" }]],
  });
  render(<App bridge={bridge} />);
  fireEvent.click(await screen.findByText("Connect to existing repository"));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("Network error.");
  fireEvent.click(within(dialog).getByText("Retry"));
  await within(dialog).findByText("lr-bicc/sales");
  expect(bridge.commands.filter((c) => c.cmd === "listRepos")).toHaveLength(2);
});

test("Retry in the connect dialog loads the branches of the chosen repository again", async () => {
  const bridge = fakeBridge({
    status: [view({ state: "unlinked" })],
    listRepos: [[{ repo: "lr-bicc/sales", defaultBranch: "main" }]],
    listBranches: [net(), { defaultBranch: "main", branches: ["main"] }],
  });
  render(<App bridge={bridge} />);
  fireEvent.click(await screen.findByText("Connect to existing repository"));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(await within(dialog).findByText("lr-bicc/sales"));
  await within(dialog).findByText("Network error.");
  fireEvent.click(within(dialog).getByText("Retry"));
  await within(dialog).findByLabelText("Branch name");
  expect(bridge.commands.filter((c) => c.cmd === "listBranches")).toEqual([
    { cmd: "listBranches", repo: "lr-bicc/sales" }, { cmd: "listBranches", repo: "lr-bicc/sales" },
  ]);
});

test("Retry after a failed connect submits again", async () => {
  const bridge = fakeBridge({
    status: [view({ state: "unlinked" }), view(LINKED)],
    listRepos: [[{ repo: "lr-bicc/sales", defaultBranch: "main" }]],
    listBranches: [{ defaultBranch: "main", branches: ["main"] }],
    connect: [net(), LINK],
  });
  render(<App bridge={bridge} />);
  fireEvent.click(await screen.findByText("Connect to existing repository"));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(await within(dialog).findByText("lr-bicc/sales"));
  await within(dialog).findByLabelText("Branch name");
  fireEvent.click(within(dialog).getByText("Connect"));
  await within(dialog).findByText("Network error.");
  fireEvent.click(within(dialog).getByText("Retry"));
  await screen.findByText("Local Changes");
  expect(bridge.commands.filter((c) => c.cmd === "connect")).toHaveLength(2);
});

test("Retry after a failed createBranch submits again", async () => {
  const bridge = fakeBridge({
    status: [view({ state: "duplicated", source: { repo: "lr-bicc/sales", branch: null, syncedSha: null }, defaultBranch: "main" }), view(LINKED)],
    createBranch: [net(), LINK],
  });
  render(<App bridge={bridge} />);
  fireEvent.click(await screen.findByText("Create Branch"));
  fireEvent.click(screen.getAllByText("Create Branch").at(-1)!);
  await screen.findByText("Network error.");
  fireEvent.click(screen.getByText("Retry"));
  await screen.findByText("Local Changes");
  expect(bridge.commands.filter((c) => c.cmd === "createBranch")).toHaveLength(2);
});

test("two immediate clicks on Create repository send one command and lock the buttons", async () => {
  const bridge = fakeBridge({ status: [view({ state: "unlinked" }), view(LINKED)], createRepository: [LINK] });
  const gate = holdCommand(bridge, "createRepository");
  render(<App bridge={bridge} />);
  const create = await screen.findByText("Create repository");
  create.click(); // native clicks: no render happens in between, as with two fast real clicks
  create.click();
  expect(bridge.commands.filter((c) => c.cmd === "createRepository")).toHaveLength(1);
  await waitFor(() => expect((screen.getByText("Connect to existing repository") as HTMLButtonElement).disabled).toBe(true));
  expect((create as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByTitle("Refresh") as HTMLButtonElement).disabled).toBe(true);
  gate.release();
  await screen.findByText("lr-bicc/sales");
});

test("the header buttons are locked while a command is pending", async () => {
  const bridge = fakeBridge({ status: [view(LINKED)] });
  render(<App bridge={bridge} />);
  await screen.findByText("lr-bicc/sales");
  const gate = holdCommand(bridge, "status");
  fireEvent.click(screen.getByTitle("Refresh"));
  await waitFor(() => expect((screen.getByTitle("Unlink repository") as HTMLButtonElement).disabled).toBe(true));
  expect((screen.getByTitle("Refresh") as HTMLButtonElement).disabled).toBe(true);
  gate.release();
  await waitFor(() => expect((screen.getByTitle("Refresh") as HTMLButtonElement).disabled).toBe(false));
});

test("two immediate clicks on the dialog's Create Branch send one command", async () => {
  const bridge = fakeBridge({
    status: [view({ state: "duplicated", source: { repo: "lr-bicc/sales", branch: null, syncedSha: null }, defaultBranch: "main" }), view(LINKED)],
    createBranch: [LINK],
  });
  const gate = holdCommand(bridge, "createBranch");
  render(<App bridge={bridge} />);
  fireEvent.click(await screen.findByText("Create Branch"));
  const submit = screen.getAllByText("Create Branch").at(-1)!;
  submit.click();
  submit.click();
  expect(bridge.commands.filter((c) => c.cmd === "createBranch")).toHaveLength(1);
  gate.release();
  await screen.findByText("Local Changes");
});

test("two immediate clicks on Connect send one command", async () => {
  const bridge = fakeBridge({
    status: [view({ state: "unlinked" }), view(LINKED)],
    listRepos: [[{ repo: "lr-bicc/sales", defaultBranch: "main" }]],
    listBranches: [{ defaultBranch: "main", branches: ["main"] }],
    connect: [LINK],
  });
  const gate = holdCommand(bridge, "connect");
  render(<App bridge={bridge} />);
  fireEvent.click(await screen.findByText("Connect to existing repository"));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(await within(dialog).findByText("lr-bicc/sales"));
  await within(dialog).findByLabelText("Branch name");
  const connect = within(dialog).getByText("Connect");
  connect.click();
  connect.click();
  expect(bridge.commands.filter((c) => c.cmd === "connect")).toHaveLength(1);
  gate.release();
  await screen.findByText("Local Changes");
});

test("a failed unlink keeps the confirmation open with the error and can be repeated", async () => {
  const bridge = fakeBridge({ status: [view(LINKED), view({ state: "unlinked" })], unlink: [net(), null] });
  render(<App bridge={bridge} />);
  await screen.findByText("lr-bicc/sales");
  fireEvent.click(screen.getByTitle("Unlink repository"));
  fireEvent.click(within(screen.getByRole("dialog")).getByText("Unlink"));
  await within(screen.getByRole("dialog")).findByText("Network error.");
  fireEvent.click(within(screen.getByRole("dialog")).getByText("Unlink"));
  await screen.findByText("No linked repository");
  expect(bridge.commands.map((c) => c.cmd)).toEqual(["status", "unlink", "unlink", "status"]);
});
