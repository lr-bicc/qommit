// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { App } from "../../src/ext/panel/App";
import { BridgeError } from "../../src/ext/panel/bridge";
import { installFakeChrome, type FakeChrome } from "./fake-chrome";
import type { FakeBridge } from "./fake-bridge";
import { fakeBridge, LINK, LINKED, view } from "./fake-bridge";
import { APP_ID } from "../fixtures/snapshot";

const OTHER_ID = "33333333-3333-4333-8333-333333333333";
const APP_URL = `https://qlik.example.com/sense/app/${APP_ID}`;

let chrome: FakeChrome;
/** Commands of the Local Changes tab that these tests do not look at. */
const PICKER_AND_CHANGES: string[] = ["localChanges", "listBranches", "tags", "commits"];

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
  expect(bridge.commands[1]).toEqual({ cmd: "createBranch", appId: APP_ID, name: "r.vasilev", fromSource: true });
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

test("a failed refresh shows its message once, not the old view below it", async () => {
  const noToken = new BridgeError({ code: "no-token", message: "x" });
  const published = view({ state: "published", repo: "lr-bicc/sales", branch: "main", syncedSha: "a".repeat(40) });
  const bridge = fakeBridge({
    status: [published, noToken, published],
    localChanges: [{ repo: "lr-bicc/sales", baseSha: "a".repeat(40), items: [], unmaintained: [] }, noToken, { repo: "lr-bicc/sales", baseSha: "a".repeat(40), items: [], unmaintained: [] }],
  });
  render(<App bridge={bridge} />);
  await screen.findByText("Published app – read only. Duplicate the app to make changes.");
  fireEvent.click(screen.getByLabelText("Refresh"));
  await screen.findByText("No GitHub token configured.");
  await waitFor(() => expect(screen.queryByText("Published app – read only. Duplicate the app to make changes.")).toBeNull());
  expect(screen.getAllByText("No GitHub token configured.")).toHaveLength(1);
  fireEvent.click(screen.getByLabelText("Refresh")); // the token is back
  await screen.findByText("Published app – read only. Duplicate the app to make changes.");
  expect(screen.queryByText("No GitHub token configured.")).toBeNull();
});

test("a failed action keeps the view it was started from", async () => {
  const bridge = fakeBridge({ status: [view({ state: "unlinked" })], createRepository: [new BridgeError({ code: "no-token", message: "x" })] });
  render(<App bridge={bridge} />);
  fireEvent.click(await screen.findByText("Create repository"));
  await screen.findByText("No GitHub token configured.");
  expect(screen.getByText("No linked repository")).toBeTruthy();
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
  expect(within(document.querySelector("header") as HTMLElement).getByText("main")).toBeTruthy(); // the branch picker lists it, too
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
  expect(bridge.commands[2]).toEqual({ cmd: "createRepository", appId: APP_ID, name: "lr-sales-1111" });
  expect(bridge.commands[1]).toEqual({ cmd: "createRepository", appId: APP_ID });
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
  expect(bridge.commands.map((c) => c.cmd).filter((c) => !PICKER_AND_CHANGES.includes(c))).toEqual(["status"]);
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("Unlink this app from lr-bicc/sales?")).toBeTruthy();
  fireEvent.click(within(dialog).getByText("Unlink"));
  await screen.findByText("No linked repository");
  expect(bridge.commands.map((c) => c.cmd).filter((c) => !PICKER_AND_CHANGES.includes(c))).toEqual(["status", "unlink", "status"]);
  expect(bridge.commands.find((c) => c.cmd === "unlink")).toEqual({ cmd: "unlink", appId: APP_ID });
});

test("repo-missing in a published app: read only, no unlink or connect", async () => {
  const missing = view({ state: "repo-missing", repo: "lr-bicc/sales-asia" });
  if (missing.page !== "app") throw new Error("app view expected");
  render(<App bridge={fakeBridge({ status: [{ ...missing, app: { ...missing.app, published: true } }] })} />);
  await screen.findByText("Repository not found or no access.");
  expect(screen.getByText("Published app – read only. Duplicate the app to make changes.")).toBeTruthy();
  expect(screen.queryByText("Unlink Repository")).toBeNull();
  expect(screen.queryByText("Connect to existing repository")).toBeNull();
  expect(screen.queryByLabelText("Unlink repository")).toBeNull();
});

test("an unlinked published app: read only, no create or connect", async () => {
  const unlinked = view({ state: "unlinked" });
  if (unlinked.page !== "app") throw new Error("app view expected");
  const bridge = fakeBridge({ status: [{ ...unlinked, app: { ...unlinked.app, published: true } }] });
  render(<App bridge={bridge} />);
  await screen.findByText("No linked repository");
  expect(screen.getByText("Published app – read only. Duplicate the app to make changes.")).toBeTruthy();
  expect(screen.queryByText("Create repository")).toBeNull();
  expect(screen.queryByText("Connect to existing repository")).toBeNull();
  expect(bridge.commands.map((c) => c.cmd)).toEqual(["status"]);
});

test("the header Unlink sends only after the confirmation and Cancel does nothing", async () => {
  const bridge = fakeBridge({ status: [view(LINKED), view({ state: "unlinked" })], unlink: [null] });
  render(<App bridge={bridge} />);
  await screen.findByText("lr-bicc/sales");
  fireEvent.click(screen.getByTitle("Unlink repository"));
  fireEvent.click(within(screen.getByRole("dialog")).getByText("Cancel"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(bridge.commands.map((c) => c.cmd).filter((c) => !PICKER_AND_CHANGES.includes(c))).toEqual(["status"]);
  fireEvent.click(screen.getByTitle("Unlink repository"));
  expect(screen.getByText("Unlink this app from lr-bicc/sales?")).toBeTruthy();
  fireEvent.click(within(screen.getByRole("dialog")).getByText("Unlink"));
  await screen.findByText("No linked repository");
  expect(bridge.commands.map((c) => c.cmd).filter((c) => !PICKER_AND_CHANGES.includes(c))).toEqual(["status", "unlink", "status"]);
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
  expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Local Changes", "History", "Tags"]);
  expect(screen.queryByTitle("Unlink repository")).toBeNull();
});

test("a published app names the commit it was published from, with its branch", async () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const published = { state: "published", repo: "lr-bicc/sales", branch: "release/1", syncedSha: sha } as const;
  render(<App bridge={fakeBridge({ status: [view(published)], localChanges: [{ repo: "lr-bicc/sales", baseSha: sha, items: [], unmaintained: [] }] })} />);
  const line = await screen.findByText((_, el) => el?.tagName === "P" && el.textContent?.startsWith("Published from commit 0123456") === true);
  const link = within(line).getByRole("link");
  expect(link.textContent).toBe("0123456");
  expect(link.getAttribute("href")).toBe(`https://github.com/lr-bicc/sales/commit/${sha}`);
  expect(within(line).getByText("release/1").className).toBe("badge");
  await screen.findByText("No local changes");
});

test("a published app without a known commit has no commit line", async () => {
  const published = { state: "published", repo: "lr-bicc/sales", branch: null, syncedSha: null } as const;
  render(<App bridge={fakeBridge({ status: [view(published)] })} />);
  await screen.findByText("Published app – read only. Duplicate the app to make changes.");
  expect(screen.queryByText(/Published from commit/)).toBeNull();
});

test("a qlik-read error shows the reason as a second line", async () => {
  const bridge = fakeBridge({ status: [new BridgeError({ code: "qlik-read", message: "Could not read sheet s1: Qlik did not answer in time." }), view({ state: "unlinked" })] });
  render(<App bridge={bridge} />);
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("Could not read the app from Qlik.")).toBeTruthy();
  expect(within(alert).getByText("Could not read sheet s1: Qlik did not answer in time.").className).toBe("detail");
  fireEvent.click(within(alert).getByText("Retry"));
  await screen.findByText("No linked repository");
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
    listRepos: [[{ repo: "lr-bicc/sales", defaultBranch: "main", marked: true }, { repo: "lr-bicc/finance", defaultBranch: "main", marked: true }]],
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
  expect(bridge.commands[3]).toEqual({ cmd: "connect", appId: APP_ID, repo: "lr-bicc/sales", mode: "existing-branch", branch: "main" });
});

test("the connect dialog defaults to a new branch with the suggested name", async () => {
  const bridge = fakeBridge({
    status: [view({ state: "unlinked" }), view(LINKED)],
    listRepos: [[{ repo: "lr-bicc/sales", defaultBranch: "main", marked: true }]],
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
  expect(bridge.commands[3]).toEqual({ cmd: "connect", appId: APP_ID, repo: "lr-bicc/sales", mode: "new-branch", branch: "r.vasilev" });
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
    listRepos: [net(), [{ repo: "lr-bicc/sales", defaultBranch: "main", marked: true }]],
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
    listRepos: [[{ repo: "lr-bicc/sales", defaultBranch: "main", marked: true }]],
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
    listRepos: [[{ repo: "lr-bicc/sales", defaultBranch: "main", marked: true }]],
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
    listRepos: [[{ repo: "lr-bicc/sales", defaultBranch: "main", marked: true }]],
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
  expect(bridge.commands.map((c) => c.cmd).filter((c) => !PICKER_AND_CHANGES.includes(c))).toEqual(["status", "unlink", "unlink", "status"]);
});

describe("the panel follows its tab", () => {
  test("a tab update to another app reloads the status; a sheet change within the same app does not", async () => {
    const linked = view(LINKED);
    const other = linked.page === "app" ? { ...linked, app: { ...linked.app, id: OTHER_ID } } : linked;
    const bridge = fakeBridge({ status: [linked, other, { page: "hub" }] });
    render(<App bridge={bridge} />);
    await screen.findByText("lr-bicc/sales");
    const statuses = () => bridge.commands.filter((c) => c.cmd === "status").length;
    expect(statuses()).toBe(1);
    bridge.tabUrl(`${APP_URL}/sheet/abc/state/analysis`);
    bridge.tabUrl(`${APP_URL}/sheet/def/state/edit`);
    await new Promise((r) => setTimeout(r, 0));
    expect(statuses()).toBe(1);
    bridge.tabUrl(`https://qlik.example.com/sense/app/${OTHER_ID}/overview`);
    await waitFor(() => expect(statuses()).toBe(2));
    bridge.tabUrl(`https://qlik.example.com/sense/app/${OTHER_ID}/sheet/x`);
    await new Promise((r) => setTimeout(r, 0));
    expect(statuses()).toBe(2);
    bridge.tabUrl("https://qlik.example.com/hub/my/work");
    await waitFor(() => expect(statuses()).toBe(3));
  });

  test("an app-changed error reloads the status and says so", async () => {
    const bridge = fakeBridge({
      status: [view({ state: "unlinked" }), view({ state: "unlinked" })],
      createRepository: [new BridgeError({ code: "app-changed", message: "x" })],
    });
    render(<App bridge={bridge} />);
    fireEvent.click(await screen.findByText("Create repository"));
    await screen.findByText("This tab now shows a different app. Qommit has refreshed.");
    expect(bridge.commands.map((c) => c.cmd)).toEqual(["status", "createRepository", "status"]);
    const alert = screen.getByRole("alert");
    expect(within(alert).queryByRole("button")).toBeNull();
  });

  test("the hub view has a Refresh button that sends status", async () => {
    const bridge = fakeBridge({ status: [{ page: "hub" }] });
    render(<App bridge={bridge} />);
    await screen.findByText("Open an app to use Qommit.");
    fireEvent.click(screen.getByText("Refresh"));
    await waitFor(() => expect(bridge.commands.filter((c) => c.cmd === "status")).toHaveLength(2));
  });
});

test("the connect dialog lists only Qommit repositories until Show all repositories is ticked", async () => {
  const bridge = fakeBridge({
    status: [view({ state: "unlinked" })],
    listRepos: [[
      { repo: "lr-bicc/sales", defaultBranch: "main", marked: true },
      { repo: "lr-bicc/pyrunner", defaultBranch: "main", marked: false },
    ]],
  });
  render(<App bridge={bridge} />);
  fireEvent.click(await screen.findByText("Connect to existing repository"));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("lr-bicc/sales");
  expect(within(dialog).queryByText("lr-bicc/pyrunner")).toBeNull();
  const showAll = within(dialog).getByLabelText("Show all repositories") as HTMLInputElement;
  expect(showAll.checked).toBe(false);
  fireEvent.click(showAll);
  await within(dialog).findByText("lr-bicc/pyrunner");
  expect(within(dialog).getByText("lr-bicc/sales")).toBeTruthy();
  expect(bridge.commands.filter((c) => c.cmd === "listRepos")).toHaveLength(1); // ticking filters, it does not reload
});
