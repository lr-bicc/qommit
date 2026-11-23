// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { partOf, type ChangeKind, type ObjectGroup } from "../../src/core/diff";
import type { ChangeItem, LocalChanges } from "../../src/ext/flows/local-changes";
import { App } from "../../src/ext/panel/App";
import { BridgeError, type Bridge } from "../../src/ext/panel/bridge";
import { HistoryTab } from "../../src/ext/panel/HistoryTab";
import { LocalChangesTab } from "../../src/ext/panel/LocalChangesTab";
import type { Command } from "../../src/ext/shared/commands";
import { installFakeChrome } from "./fake-chrome";
import { fakeBridge, LINKED, view, type FakeBridge } from "./fake-bridge";
import { APP_ID } from "../fixtures/snapshot";

beforeEach(() => {
  installFakeChrome();
});
afterEach(cleanup);

const item = (path: string, kind: ChangeKind, group: ObjectGroup, title: string): ChangeItem => ({ path, kind, group, part: partOf(group), title });
const changes = (items: ChangeItem[], unmaintained: string[] = []): LocalChanges => ({ repo: "lr-bicc/sales", baseSha: "abc", items, unmaintained });
const TWO = [item("objects/sheets/s1.json", "changed", "sheets", "Overview"), item("objects/sheets/s2.json", "changed", "sheets", "Details")];
const theirs = { sha: "f".repeat(40), message: "theirs", author: "Ann", date: "2026-11-01T10:00:00Z" };
const check = (label: string | RegExp): HTMLInputElement => screen.getByLabelText(label) as HTMLInputElement;
const flush = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** Holds the nth call of a command until `release` is called. The held call is not recorded by the fake bridge. */
function hold(bridge: FakeBridge, cmd: Command["cmd"], nth = 1) {
  const original = bridge.send.bind(bridge);
  const held: Command[] = [];
  let seen = 0;
  let release: (value: unknown) => void = () => undefined;
  bridge.send = (async (command: Command) => {
    if (command.cmd === cmd && ++seen === nth) {
      held.push(command);
      return new Promise<unknown>((resolve) => { release = resolve; });
    }
    return original(command);
  }) as Bridge["send"];
  return { held, release: (value: unknown) => release(value) };
}

async function openCommit(bridge: FakeBridge): Promise<void> {
  render(<App bridge={bridge} />);
  fireEvent.click(await screen.findByText("Save changes"));
  await screen.findByText("Choose what to save");
}

const linkedBridge = (answers: Partial<Record<Command["cmd"], unknown[]>>): FakeBridge =>
  fakeBridge({ status: [view(LINKED)], ...answers });

const panelOf = (bridge: FakeBridge) => ({ run: <T,>(command: Command): Promise<T> => bridge.send<T>(command), isBusy: () => false, busy: false });

test("saves the selected paths, shows Success and loads status and changes again", async () => {
  const bridge = linkedBridge({ localChanges: [changes(TWO, ["loadScript.qvs"]), changes([])], commit: [{ sha: "n".repeat(40) }] });
  const second = hold(bridge, "localChanges", 2);
  await openCommit(bridge);
  fireEvent.click(check("Overview"));
  fireEvent.input(screen.getByPlaceholderText("Commit message"), { target: { value: "Fix" } });
  fireEvent.click(screen.getByText("Save"));
  await screen.findByText("Success");
  expect(bridge.commands.find((c) => c.cmd === "commit")).toEqual({
    cmd: "commit", appId: APP_ID, message: "Fix", paths: ["objects/sheets/s2.json"], removeUnmaintained: true, allowBehind: false,
  });
  await waitFor(() => expect(second.held).toHaveLength(1));
  await waitFor(() => expect(bridge.commands.filter((c) => c.cmd === "status")).toHaveLength(2));
  second.release(changes([]));
  await screen.findByText("No local changes");
  expect(screen.queryByText("Choose what to save")).toBeNull();
  expect(bridge.commands.filter((c) => c.cmd === "status")).toHaveLength(2);
});

test("Save is locked without a message and without a selection", async () => {
  const bridge = linkedBridge({ localChanges: [changes(TWO)] });
  await openCommit(bridge);
  const save = screen.getByText("Save") as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.input(screen.getByPlaceholderText("Commit message"), { target: { value: "  " } });
  expect(save.disabled).toBe(true);
  fireEvent.input(screen.getByPlaceholderText("Commit message"), { target: { value: "Fix" } });
  expect(save.disabled).toBe(false);
  fireEvent.click(check("Overview"));
  fireEvent.click(check("Details"));
  expect(save.disabled).toBe(true);
});

test("without unmaintained files there is no removal option and the command says so", async () => {
  const bridge = linkedBridge({ localChanges: [changes(TWO)], commit: [{ sha: "n" }] });
  await openCommit(bridge);
  expect(screen.queryByLabelText(/Remove files no longer maintained/)).toBeNull();
  fireEvent.input(screen.getByPlaceholderText("Commit message"), { target: { value: "Fix" } });
  fireEvent.click(screen.getByText("Save"));
  await screen.findByText("Success");
  expect(bridge.commands.find((c) => c.cmd === "commit")).toMatchObject({ removeUnmaintained: false, paths: ["objects/sheets/s1.json", "objects/sheets/s2.json"] });
});

test("the removal option shows the count and can be switched off", async () => {
  const bridge = linkedBridge({ localChanges: [changes(TWO, ["loadScript.qvs", "builds/a.json"])], commit: [{ sha: "n" }] });
  await openCommit(bridge);
  expect(check("Remove files no longer maintained (2)").checked).toBe(true);
  fireEvent.click(check("Remove files no longer maintained (2)"));
  fireEvent.input(screen.getByPlaceholderText("Commit message"), { target: { value: "Fix" } });
  fireEvent.click(screen.getByText("Save"));
  await screen.findByText("Success");
  expect(bridge.commands.find((c) => c.cmd === "commit")).toMatchObject({ removeUnmaintained: false });
});

test("only unmaintained files can be removed on their own", async () => {
  const bridge = linkedBridge({ localChanges: [changes([], ["loadScript.qvs"])], commit: [{ sha: "n" }] });
  await openCommit(bridge);
  fireEvent.input(screen.getByPlaceholderText("Commit message"), { target: { value: "Clean up" } });
  expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(check(/Remove files no longer maintained/));
  expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(true);
});

test("Save changes is locked without entries and without unmaintained files", async () => {
  render(<App bridge={linkedBridge({ localChanges: [changes([])] })} />);
  await screen.findByText("No local changes");
  expect((screen.getByText("Save changes") as HTMLButtonElement).disabled).toBe(true);
});

test("checkboxes of parts and groups follow their entries", async () => {
  const items = [
    item("data_load_script/Main.qvs", "changed", "script", "Main"),
    item("objects/sheets/s1.json", "changed", "sheets", "Overview"),
    item("objects/sheets/s2.json", "changed", "sheets", "Details"),
    item("objects/measures/m1.json", "added", "measures", "Sales"),
  ];
  await openCommit(linkedBridge({ localChanges: [changes(items)] }));
  expect(screen.queryByLabelText("Bookmarks")).toBeNull();
  expect(screen.queryByLabelText("Attached files")).toBeNull();
  expect(check("Load script").checked).toBe(true);
  expect(check("App Objects").checked).toBe(true);

  fireEvent.click(check("Overview"));
  expect(check("App Objects").indeterminate).toBe(true);
  expect(check("App Objects").checked).toBe(false);
  expect(check("Select all Sheets").indeterminate).toBe(true);
  expect(check("Select all Master Items").checked).toBe(true);

  fireEvent.click(check("App Objects")); // indeterminate: selects everything
  expect(check("App Objects").checked).toBe(true);
  expect(check("App Objects").indeterminate).toBe(false);
  expect(check("Overview").checked).toBe(true);

  fireEvent.click(check("Select all Sheets")); // all selected: clears the group
  expect(check("Overview").checked).toBe(false);
  expect(check("Details").checked).toBe(false);
  expect(check("Sales").checked).toBe(true);
  expect(check("App Objects").indeterminate).toBe(true);

  fireEvent.click(check("Load script"));
  expect(check("Main").checked).toBe(false);
  expect(check("Load script").checked).toBe(false);
  expect(check("Load script").indeterminate).toBe(false);
});

test("a second Save click before the answer sends nothing", async () => {
  const bridge = linkedBridge({ localChanges: [changes(TWO)] });
  const commit = hold(bridge, "commit");
  await openCommit(bridge);
  fireEvent.input(screen.getByPlaceholderText("Commit message"), { target: { value: "Fix" } });
  const save = screen.getByText("Save") as HTMLButtonElement;
  save.click();
  save.click();
  expect(commit.held).toHaveLength(1);
  await act(async () => { commit.release({ sha: "n" }); });
  await screen.findByText("Success");
  expect(commit.held).toHaveLength(1);
});

test("behind: the dialog lists the commits, Cancel keeps message and selection", async () => {
  const bridge = linkedBridge({ localChanges: [changes(TWO)], commit: [{ behind: [theirs] }] });
  await openCommit(bridge);
  fireEvent.click(check("Overview"));
  fireEvent.input(screen.getByPlaceholderText("Commit message"), { target: { value: "Fix" } });
  fireEvent.click(screen.getByText("Save"));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("The branch has 1 new commit that this save would overwrite:")).toBeTruthy();
  expect(within(dialog).getByText("theirs")).toBeTruthy();
  expect(within(dialog).getByText("Update first")).toBeTruthy();
  fireEvent.click(within(dialog).getByText("Cancel"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect((screen.getByPlaceholderText("Commit message") as HTMLTextAreaElement).value).toBe("Fix");
  expect(check("Overview").checked).toBe(false);
  expect(check("Details").checked).toBe(true);
});

test("Commit anyway sends the same command with allowBehind once", async () => {
  const bridge = linkedBridge({ localChanges: [changes(TWO)], commit: [{ behind: [theirs, { ...theirs, message: "more" }] }, { sha: "n" }] });
  await openCommit(bridge);
  fireEvent.input(screen.getByPlaceholderText("Commit message"), { target: { value: "Fix" } });
  fireEvent.click(screen.getByText("Save"));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("The branch has 2 new commits that this save would overwrite:")).toBeTruthy();
  const anyway = within(dialog).getByText("Commit anyway") as HTMLButtonElement;
  anyway.click();
  anyway.click();
  await screen.findByText("Success");
  const commits = bridge.commands.filter((c) => c.cmd === "commit");
  expect(commits).toHaveLength(2);
  expect(commits[1]).toEqual({ ...commits[0], allowBehind: true });
  expect(commits[0]).toMatchObject({ allowBehind: false });
});

test("a second behind answer updates the dialog and waits for another click", async () => {
  const bridge = linkedBridge({ localChanges: [changes(TWO)], commit: [{ behind: [theirs] }, { behind: [theirs, { ...theirs, message: "newest" }] }, { sha: "n" }] });
  await openCommit(bridge);
  fireEvent.input(screen.getByPlaceholderText("Commit message"), { target: { value: "Fix" } });
  fireEvent.click(screen.getByText("Save"));
  fireEvent.click(await screen.findByText("Commit anyway"));
  await screen.findByText("The branch has 2 new commits that this save would overwrite:");
  expect(screen.getByText("newest")).toBeTruthy();
  await flush();
  expect(bridge.commands.filter((c) => c.cmd === "commit")).toHaveLength(2);
  fireEvent.click(screen.getByText("Commit anyway"));
  await screen.findByText("Success");
  expect(bridge.commands.filter((c) => c.cmd === "commit")).toHaveLength(3);
});

test("a failed commit shows the error and Retry sends the same command again", async () => {
  const bridge = linkedBridge({
    localChanges: [changes(TWO)],
    commit: [new BridgeError({ code: "network", message: "x" }), { sha: "n" }],
  });
  await openCommit(bridge);
  fireEvent.input(screen.getByPlaceholderText("Commit message"), { target: { value: "Fix" } });
  fireEvent.click(screen.getByText("Save"));
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("Network error.")).toBeTruthy();
  expect(screen.getByText("Choose what to save")).toBeTruthy();
  fireEvent.click(within(alert).getByText("Retry"));
  await screen.findByText("Success");
  const commits = bridge.commands.filter((c) => c.cmd === "commit");
  expect(commits).toHaveLength(2);
  expect(commits[1]).toEqual(commits[0]);
});

test("a failed load shows the error and Retry loads again", async () => {
  const bridge = linkedBridge({ localChanges: [new BridgeError({ code: "qlik-read", message: "x" }), changes(TWO)] });
  render(<App bridge={bridge} />);
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("Could not read the app from Qlik.")).toBeTruthy();
  fireEvent.click(within(alert).getByText("Retry"));
  await screen.findByText("Overview");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("Back leaves the commit mode", async () => {
  await openCommit(linkedBridge({ localChanges: [changes(TWO)] }));
  fireEvent.click(screen.getByText("Back"));
  expect(screen.queryByText("Choose what to save")).toBeNull();
  expect(screen.getByText("Save changes")).toBeTruthy();
});

test("without changes the list says so", async () => {
  render(<App bridge={linkedBridge({ localChanges: [changes([])] })} />);
  await screen.findByText("No local changes");
});

test("sections and groups show their counts", async () => {
  const items = [...TWO, item("objects/variables/v.json", "added", "variables", "vX")];
  render(<App bridge={linkedBridge({ localChanges: [changes(items)] })} />);
  await screen.findByText("Sheets (2)");
  expect(screen.getByText("Added objects")).toBeTruthy();
  expect(screen.getByText("Changed objects")).toBeTruthy();
  expect(screen.getByText("Variables (1)")).toBeTruthy();
  expect(screen.getByText("Overview")).toBeTruthy();
});

test("a group with 25 entries starts collapsed and can be expanded", async () => {
  const items = Array.from({ length: 25 }, (_, i) => item(`objects/variables/v${i}.json`, "changed", "variables", `var${String(i).padStart(2, "0")}`));
  render(<App bridge={linkedBridge({ localChanges: [changes(items)], commit: [{ sha: "n" }] })} />);
  const header = (await screen.findByText("Variables (25)")).closest("button")!;
  expect(header.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("var00")).toBeNull();
  fireEvent.click(header);
  expect(header.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("var00")).toBeTruthy();
});

test("collapsed groups still count towards the selection", async () => {
  const items = Array.from({ length: 25 }, (_, i) => item(`objects/variables/v${i}.json`, "changed", "variables", `var${i}`));
  const bridge = linkedBridge({ localChanges: [changes(items)], commit: [{ sha: "n" }] });
  await openCommit(bridge);
  expect(screen.queryByText("var0")).toBeNull();
  expect(check("Select all Variables").checked).toBe(true);
  fireEvent.input(screen.getByPlaceholderText("Commit message"), { target: { value: "Fix" } });
  fireEvent.click(screen.getByText("Save"));
  await screen.findByText("Success");
  expect((bridge.commands.find((c) => c.cmd === "commit") as { paths: string[] }).paths).toHaveLength(25);
});

test("a published app shows the list only", async () => {
  const bridge = fakeBridge({ localChanges: [changes(TWO)] });
  render(<LocalChangesTab bridge={bridge} panel={panelOf(bridge)} appId={APP_ID} readOnly={true} onSaved={() => undefined} />);
  await screen.findByText("Overview");
  expect(screen.queryByText("Save changes")).toBeNull();
});

test("Refresh in the header loads the local changes again", async () => {
  const bridge = linkedBridge({ localChanges: [changes(TWO), changes([])] });
  render(<App bridge={bridge} />);
  await screen.findByText("Overview");
  fireEvent.click(screen.getByLabelText("Refresh"));
  await screen.findByText("No local changes");
  expect(bridge.commands.map((c) => c.cmd).filter((c) => !["listBranches", "tags", "commits"].includes(c))).toEqual(["status", "localChanges", "status", "localChanges"]);
});

test("a changed reload token loads the changes again", async () => {
  const bridge = fakeBridge({ localChanges: [changes(TWO), changes([])] });
  const { rerender } = render(<LocalChangesTab bridge={bridge} panel={panelOf(bridge)} appId={APP_ID} readOnly={false} onSaved={() => undefined} reloadToken={0} />);
  await screen.findByText("Overview");
  rerender(<LocalChangesTab bridge={bridge} panel={panelOf(bridge)} appId={APP_ID} readOnly={false} onSaved={() => undefined} reloadToken={1} />);
  await screen.findByText("No local changes");
});

test("onSaved is called after a successful save", async () => {
  const bridge = fakeBridge({ localChanges: [changes(TWO), changes([])], commit: [{ sha: "n" }] });
  const onSaved = vi.fn();
  render(<LocalChangesTab bridge={bridge} panel={panelOf(bridge)} appId={APP_ID} readOnly={false} onSaved={onSaved} />);
  fireEvent.click(await screen.findByText("Save changes"));
  fireEvent.input(screen.getByPlaceholderText("Commit message"), { target: { value: "Fix" } });
  fireEvent.click(screen.getByText("Save"));
  await screen.findByText("No local changes");
  expect(onSaved).toHaveBeenCalledTimes(1);
});

const commitsOf = (n: number, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({ sha: `${String(i + offset).padStart(2, "0")}abcdef0123456789`, message: `msg ${i + offset}\nbody`, author: "Ann", date: "2026-11-01T10:00:00Z", parents: [] }));

test("history lists the commits and links the short sha", async () => {
  const bridge = fakeBridge({ history: [{ commits: commitsOf(2), defaultBranch: "main" }] });
  render(<HistoryTab bridge={bridge} repo="lr-bicc/sales" branch="main" defaultBranch="main" canUpdate={false} onAddTag={() => undefined} onUpdate={() => undefined} />);
  await screen.findByText("msg 0");
  expect(screen.getByText("msg 1")).toBeTruthy();
  expect(screen.queryByText(/body/)).toBeNull();
  expect(screen.getAllByText("Ann")).toHaveLength(2);
  expect(screen.getAllByText(new Date("2026-11-01T10:00:00Z").toLocaleString())).toHaveLength(2);
  const link = screen.getByText("00abcde") as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe("https://github.com/lr-bicc/sales/commit/00abcdef0123456789");
  expect(screen.queryByText("Open pull request on GitHub")).toBeNull();
  expect(screen.queryByText("Load more")).toBeNull();
  expect(bridge.commands.filter((c) => c.cmd === "history")).toEqual([{ cmd: "history", page: 1 }]);
});

test("history of a side branch links to the pull request", async () => {
  const bridge = fakeBridge({ history: [{ commits: commitsOf(1), defaultBranch: "main" }] });
  render(<HistoryTab bridge={bridge} repo="lr-bicc/sales" branch="dev/x" defaultBranch="main" canUpdate={false} onAddTag={() => undefined} onUpdate={() => undefined} />);
  const link = (await screen.findByText("Open pull request on GitHub")) as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe("https://github.com/lr-bicc/sales/compare/main...dev/x");
  expect(link.getAttribute("target")).toBe("_blank");
});

test("Load more appears after a full page and appends the next one", async () => {
  const bridge = fakeBridge({ history: [{ commits: commitsOf(30), defaultBranch: "main" }, { commits: commitsOf(2, 30), defaultBranch: "main" }] });
  render(<HistoryTab bridge={bridge} repo="lr-bicc/sales" branch="main" defaultBranch="main" canUpdate={false} onAddTag={() => undefined} onUpdate={() => undefined} />);
  fireEvent.click(await screen.findByText("Load more"));
  await screen.findByText("msg 31");
  expect(screen.getByText("msg 0")).toBeTruthy();
  expect(screen.queryByText("Load more")).toBeNull();
  expect(bridge.commands.filter((c) => c.cmd === "history")).toEqual([{ cmd: "history", page: 1 }, { cmd: "history", page: 2 }]);
});

test("history without commits says so", async () => {
  render(<HistoryTab bridge={fakeBridge({ history: [{ commits: [], defaultBranch: "main" }] })} repo="lr-bicc/sales" branch="main" defaultBranch="main" canUpdate={false} onAddTag={() => undefined} onUpdate={() => undefined} />);
  await screen.findByText("No commits");
});

test("a failed history load shows the error and Retry loads again", async () => {
  const bridge = fakeBridge({ history: [new BridgeError({ code: "network", message: "x" }), { commits: commitsOf(1), defaultBranch: "main" }] });
  render(<HistoryTab bridge={bridge} repo="lr-bicc/sales" branch="main" defaultBranch="main" canUpdate={false} onAddTag={() => undefined} onUpdate={() => undefined} />);
  fireEvent.click(within(await screen.findByRole("alert")).getByText("Retry"));
  await screen.findByText("msg 0");
});

test("the History tab opens from the app", async () => {
  const bridge = linkedBridge({ localChanges: [changes([])], history: [{ commits: commitsOf(1), defaultBranch: "main" }] });
  render(<App bridge={bridge} />);
  await screen.findByText("No local changes");
  fireEvent.click(screen.getByRole("tab", { name: "History" }));
  await screen.findByText("msg 0");
});

test("Retry after a failed commit sends what the form shows now, with the behind check on", async () => {
  const bridge = linkedBridge({
    localChanges: [changes(TWO)],
    commit: [new BridgeError({ code: "network", message: "x" }), { sha: "n" }],
  });
  await openCommit(bridge);
  fireEvent.input(screen.getByPlaceholderText("Commit message"), { target: { value: "Fix" } });
  fireEvent.click(screen.getByText("Save"));
  const alert = await screen.findByRole("alert");
  fireEvent.click(check("Overview"));
  fireEvent.input(screen.getByPlaceholderText("Commit message"), { target: { value: "Better" } });
  fireEvent.click(within(alert).getByText("Retry"));
  await screen.findByText("Success");
  const commits = bridge.commands.filter((c) => c.cmd === "commit");
  expect(commits[1]).toEqual({ cmd: "commit", appId: APP_ID, message: "Better", paths: ["objects/sheets/s2.json"], removeUnmaintained: false, allowBehind: false });
});

test("a failed Commit anyway stays in the dialog and sends allowBehind only per click", async () => {
  const bridge = linkedBridge({
    localChanges: [changes(TWO)],
    commit: [{ behind: [theirs] }, new BridgeError({ code: "network", message: "x" }), new BridgeError({ code: "network", message: "x" })],
  });
  await openCommit(bridge);
  fireEvent.input(screen.getByPlaceholderText("Commit message"), { target: { value: "Fix" } });
  fireEvent.click(screen.getByText("Save"));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByText("Commit anyway"));
  await within(await screen.findByRole("dialog")).findByText("Network error.");
  expect(within(dialog).queryByText("Retry")).toBeNull();
  const sent = (): number => bridge.commands.filter((c) => c.cmd === "commit" && c.allowBehind).length;
  await flush();
  expect(sent()).toBe(1);
  fireEvent.click(within(dialog).getByText("Commit anyway"));
  await waitFor(() => expect(sent()).toBe(2));
  fireEvent.click(within(dialog).getByText("Cancel"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect((screen.getByPlaceholderText("Commit message") as HTMLTextAreaElement).value).toBe("Fix");
});

test("a failed reload after a save shows the error with Retry", async () => {
  const bridge = linkedBridge({
    localChanges: [changes(TWO), new BridgeError({ code: "network", message: "x" }), changes([])],
    commit: [{ sha: "n" }],
  });
  await openCommit(bridge);
  fireEvent.input(screen.getByPlaceholderText("Commit message"), { target: { value: "Fix" } });
  fireEvent.click(screen.getByText("Save"));
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("Network error.")).toBeTruthy();
  await flush();
  expect(screen.queryByText("Choose what to save")).toBeNull();
  expect(screen.queryByText("Loading…")).toBeNull();
  fireEvent.click(within(screen.getByRole("alert")).getByText("Retry"));
  await screen.findByText("No local changes");
});

test("the commit message is sent trimmed", async () => {
  const bridge = linkedBridge({ localChanges: [changes(TWO)], commit: [{ sha: "n" }] });
  await openCommit(bridge);
  fireEvent.input(screen.getByPlaceholderText("Commit message"), { target: { value: "  Fix  " } });
  fireEvent.click(screen.getByText("Save"));
  await screen.findByText("Success");
  expect(bridge.commands.find((c) => c.cmd === "commit")).toMatchObject({ message: "Fix" });
});

test("script entries are ticked and unticked together, with a hint under the group", async () => {
  const items = [
    item("data_load_script/Main.qvs", "changed", "script", "Main"),
    item("data_load_script/tab_order.txt", "changed", "script", "tab_order.txt"),
    item("data_load_script/New.qvs", "added", "script", "New"),
    item("objects/sheets/s1.json", "changed", "sheets", "Overview"),
  ];
  await openCommit(linkedBridge({ localChanges: [changes(items)] }));
  expect(screen.getAllByText("The load script is saved as a whole.")).toHaveLength(2); // one per Script group
  fireEvent.click(check("Main"));
  for (const label of ["Main", "tab_order.txt", "New"]) expect(check(label).checked).toBe(false);
  expect(check("Overview").checked).toBe(true);
  fireEvent.click(check("New"));
  for (const label of ["Main", "tab_order.txt", "New"]) expect(check(label).checked).toBe(true);
});

test("the hint is not shown outside commit mode", async () => {
  render(<App bridge={linkedBridge({ localChanges: [changes([item("data_load_script/Main.qvs", "changed", "script", "Main")])] })} />);
  await screen.findByText("Script (1)");
  expect(screen.queryByText("The load script is saved as a whole.")).toBeNull();
});
