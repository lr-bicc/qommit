// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { partOf, type ChangeKind, type ObjectGroup } from "../../src/core/diff";
import type { ChangeItem, LocalChanges } from "../../src/ext/flows/local-changes";
import type { UpdatePreview } from "../../src/ext/flows/update";
import { App } from "../../src/ext/panel/App";
import { BridgeError } from "../../src/ext/panel/bridge";
import type { Command, StatusView } from "../../src/ext/shared/commands";
import { installFakeChrome } from "./fake-chrome";
import { fakeBridge, LINKED, view, type FakeBridge } from "./fake-bridge";
import { APP_ID } from "../fixtures/snapshot";

beforeEach(() => { installFakeChrome(); });
afterEach(cleanup);

const c1 = { sha: "1".repeat(40), message: "First\nbody", author: "Ann", date: "2026-11-01T10:00:00Z", parents: [] };
const c2 = { sha: "2".repeat(40), message: "Second", author: "Ann", date: "2026-11-02T10:00:00Z", parents: [c1.sha] };
const item = (path: string, kind: ChangeKind, group: ObjectGroup, title: string): ChangeItem => ({ path, kind, group, part: partOf(group), title });
const changes = (items: ChangeItem[]): LocalChanges => ({ repo: "lr-bicc/sales", baseSha: "abc", items, unmaintained: [] });
const noChanges = changes([]);
const preview = (over: Partial<UpdatePreview> = {}): UpdatePreview => ({
  target: c2.sha,
  items: [{ kind: "change", group: "sheets", id: "s1", title: "Overview" }],
  summary: { create: 0, change: 1, delete: 0 },
  localChanges: 0,
  onBranch: true,
  advances: false,
  ...over,
});
const linkedView = (over: { behindBy?: number; headSha?: string }): StatusView => view({ ...LINKED, ...over } as typeof LINKED);
const PLAN = "0 to create, 1 to change, 0 to delete";
const dlg = (): HTMLElement => screen.getByRole("dialog");
const fail = (code: string, message: string, detail?: unknown): BridgeError => new BridgeError({ code, message, detail });
const radioOf = (text: string): HTMLInputElement => screen.getByText(text).closest("label")!.querySelector("input")!;

function linked(answers: Partial<Record<Command["cmd"], unknown[]>>, status: StatusView = linkedView({ behindBy: 2 })): FakeBridge {
  return fakeBridge({
    status: [status], commits: [[c2, c1]], tags: [[]], localChanges: [noChanges, noChanges],
    listBranches: [{ defaultBranch: "main", branches: ["main", "backup/main-20261101-1000"] }],
    ...answers,
  });
}

async function openDialog(bridge: FakeBridge, button = "Update (2)"): Promise<void> {
  render(<App bridge={bridge} />);
  fireEvent.click(await screen.findByText(button));
  await screen.findByRole("dialog");
}

test("Update shows the preview and runs the update with the chosen parts", async () => {
  const bridge = linked({ updatePreview: [preview()], update: [{ syncedSha: c2.sha, backupBranch: null, applied: 1 }] });
  const original = bridge.send.bind(bridge);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  bridge.send = (async (command: Command) => { if (command.cmd === "updatePreview") await gate; return original(command); }) as FakeBridge["send"];
  await openDialog(bridge);
  expect(within(dlg()).getByText("Update Application from the repository?")).toBeTruthy();
  expect(within(dlg()).getByText("Preparing…")).toBeTruthy();
  release();
  expect(await screen.findByText(PLAN)).toBeTruthy();
  expect(within(dlg()).getByRole("link", { name: "2222222" }).getAttribute("href")).toBe(`https://github.com/lr-bicc/sales/commit/${c2.sha}`);
  fireEvent.click(within(dlg()).getByText("Show details"));
  expect(within(dlg()).getByText("change: Overview")).toBeTruthy();
  expect(within(dlg()).queryByText("Your local changes will be saved to a backup branch first.")).toBeNull();
  fireEvent.click(within(dlg()).getByText("Update"));
  expect(await screen.findByText("Success")).toBeTruthy();
  expect(bridge.commands.find((c) => c.cmd === "update")).toEqual({ cmd: "update", appId: APP_ID, target: c2.sha, parts: ["script", "objects", "files"] });
  expect(bridge.commands.find((c) => c.cmd === "updatePreview")).toEqual({ cmd: "updatePreview", appId: APP_ID, target: c2.sha, parts: ["script", "objects", "files"] });
  expect(screen.queryByText(/Backup:/)).toBeNull();
  const statuses = bridge.commands.filter((c) => c.cmd === "status").length;
  fireEvent.click(within(dlg()).getByText("Close"));
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(bridge.commands.filter((c) => c.cmd === "status").length).toBe(statuses + 1));
  await waitFor(() => expect(bridge.commands.filter((c) => c.cmd === "localChanges").length).toBe(2));
});

test("the preview announces the backup and the result links to it", async () => {
  const bridge = linked({ updatePreview: [preview({ localChanges: 3 })], update: [{ syncedSha: c2.sha, backupBranch: "backup/main-20261120-1200", applied: 1 }] });
  await openDialog(bridge);
  expect(await screen.findByText("Your local changes will be saved to a backup branch first.")).toBeTruthy();
  fireEvent.click(within(dlg()).getByText("Update"));
  await screen.findByText("Success");
  expect(within(dlg()).getByText("backup/main-20261120-1200").getAttribute("href")).toBe("https://github.com/lr-bicc/sales/tree/backup/main-20261120-1200");
  expect(within(dlg()).getByText(/Backup:/)).toBeTruthy();
});

test("Cancel closes the dialog without updating", async () => {
  const bridge = linked({ updatePreview: [preview()] });
  await openDialog(bridge);
  await screen.findByText(PLAN);
  fireEvent.click(within(dlg()).getByText("Cancel"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(bridge.commands.some((c) => c.cmd === "update")).toBe(false);
});

test("without actions the dialog says so and only offers Close", async () => {
  const bridge = linked({ updatePreview: [preview({ items: [], summary: { create: 0, change: 0, delete: 0 } })] });
  await openDialog(bridge);
  expect(await screen.findByText("The app already matches this state.")).toBeTruthy();
  expect(within(dlg()).queryByText("Update")).toBeNull();
  fireEvent.click(within(dlg()).getByText("Close"));
  expect(screen.queryByRole("dialog")).toBeNull();
});

const NO_ITEMS = { items: [], summary: { create: 0, change: 0, delete: 0 } };

test("an empty plan that advances the link offers Update and Cancel", async () => {
  const bridge = linked({ updatePreview: [preview({ ...NO_ITEMS, advances: true })], update: [{ syncedSha: c2.sha, backupBranch: null, applied: 0 }] });
  await openDialog(bridge);
  expect(await screen.findByText("The app already matches this state.")).toBeTruthy();
  expect(within(dlg()).queryByText("Close")).toBeNull();
  expect(within(dlg()).getByText("Cancel")).toBeTruthy();
  fireEvent.click(within(dlg()).getByText("Update"));
  expect(await screen.findByText("Success")).toBeTruthy();
  expect(bridge.commands.find((c) => c.cmd === "update")).toEqual({ cmd: "update", appId: APP_ID, target: c2.sha, parts: ["script", "objects", "files"] });
});

test("an empty plan with an interrupted update offers Update, too", async () => {
  const entry = { appId: APP_ID, repo: "lr-bicc/sales", branch: "main", target: c2.sha, backupBranch: null, total: 2, startedAt: "2026-11-20T10:00:00.000Z" };
  const status = { ...(linkedView({ behindBy: 2 }) as Extract<StatusView, { page: "app" }>), interruptedUpdate: entry };
  const bridge = linked({ updatePreview: [preview(NO_ITEMS)], update: [{ syncedSha: c2.sha, backupBranch: null, applied: 0 }] }, status);
  await openDialog(bridge);
  expect(await screen.findByText("The app already matches this state.")).toBeTruthy();
  expect(within(dlg()).getByText("Cancel")).toBeTruthy();
  fireEvent.click(within(dlg()).getByText("Update"));
  expect(await screen.findByText("Success")).toBeTruthy();
});

test("an update started from Local Changes locks the panel while it runs", async () => {
  const bridge = linked({ updatePreview: [preview()], update: [{ syncedSha: c2.sha, backupBranch: null, applied: 1 }] });
  const original = bridge.send.bind(bridge);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  bridge.send = (async (command: Command) => { if (command.cmd === "update") await gate; return original(command); }) as FakeBridge["send"];
  await openDialog(bridge);
  await screen.findByText(PLAN);
  fireEvent.click(within(dlg()).getByText("Update"));
  await waitFor(() => expect((screen.getByLabelText("Refresh") as HTMLButtonElement).disabled).toBe(true));
  release();
  await screen.findByText("Success");
  await waitFor(() => expect((screen.getByLabelText("Refresh") as HTMLButtonElement).disabled).toBe(false));
});

test("unticking App Objects sends only script and files", async () => {
  const bridge = linked({ updatePreview: [preview()], update: [{ syncedSha: c2.sha, backupBranch: null, applied: 1 }] });
  render(<App bridge={bridge} />);
  await screen.findByText("Update (2)");
  fireEvent.click(screen.getByLabelText("Choose what to update"));
  expect((screen.getByLabelText("Load script") as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText("Attached files") as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByLabelText("App Objects"));
  fireEvent.click(screen.getByText("Update (2)"));
  await screen.findByText(PLAN);
  fireEvent.click(within(dlg()).getByText("Update"));
  await screen.findByText("Success");
  expect(bridge.commands.find((c) => c.cmd === "update")).toMatchObject({ parts: ["script", "files"] });
});

test("Update is locked without any part ticked", async () => {
  const bridge = linked({});
  render(<App bridge={bridge} />);
  await screen.findByText("Update (2)");
  fireEvent.click(screen.getByLabelText("Choose what to update"));
  for (const l of ["Load script", "App Objects", "Attached files"]) fireEvent.click(screen.getByLabelText(l));
  expect((screen.getByText("Update (2)") as HTMLButtonElement).disabled).toBe(true);
});

test("a failed update lists done and remaining work and the backup", async () => {
  const a = (title: string) => ({ kind: "change" as const, group: "sheets" as const, id: title, title });
  const bridge = linked({
    updatePreview: [preview()],
    update: [fail("update-failed", "Qlik said no", { done: [a("One")], failed: a("Two"), remaining: [a("Three")], backupBranch: "backup/main-20261120-1200" })],
  });
  await openDialog(bridge);
  await screen.findByText(PLAN);
  fireEvent.click(within(dlg()).getByText("Update"));
  expect(await screen.findByText("The update stopped: Qlik said no")).toBeTruthy();
  expect(within(dlg()).getByText("Done: 1")).toBeTruthy();
  expect(within(dlg()).getByText("Not done: 2")).toBeTruthy();
  expect(within(dlg()).queryByText("change: Three")).toBeNull();
  fireEvent.click(within(dlg()).getByText("Not done: 2"));
  expect(within(dlg()).getByText("change: Two")).toBeTruthy();
  expect(within(dlg()).getByText("change: Three")).toBeTruthy();
  expect(within(dlg()).getByText("backup/main-20261120-1200").getAttribute("href")).toBe("https://github.com/lr-bicc/sales/tree/backup/main-20261120-1200");
  expect(within(dlg()).queryByText("Success")).toBeNull();
});

test("a failed update without backup shows no backup line", async () => {
  const a = { kind: "create" as const, group: "files" as const, id: "f", title: "f.png" };
  const bridge = linked({ updatePreview: [preview()], update: [fail("update-failed", "boom", { done: [], failed: a, remaining: [], backupBranch: null })] });
  await openDialog(bridge);
  await screen.findByText(PLAN);
  fireEvent.click(within(dlg()).getByText("Update"));
  await screen.findByText("The update stopped: boom");
  expect(within(dlg()).getByText("Done: 0")).toBeTruthy();
  expect(within(dlg()).queryByText(/Backup:/)).toBeNull();
});

test("invalid files are listed as links to the target's blobs", async () => {
  const bridge = linked({ updatePreview: [fail("invalid-target", "x", [{ path: "objects/sheets/s1.json", reason: "invalid-json" }])] });
  await openDialog(bridge);
  expect(await screen.findByText("The selected state contains files that cannot be applied:")).toBeTruthy();
  expect(within(dlg()).getByText("objects/sheets/s1.json (invalid-json)").getAttribute("href")).toBe(`https://github.com/lr-bicc/sales/blob/${c2.sha}/objects/sheets/s1.json`);
  expect(within(dlg()).queryByText("Update")).toBeNull();
});

test("a failed preview shows the error", async () => {
  const bridge = linked({ updatePreview: [fail("cannot-write", "x")] });
  await openDialog(bridge);
  expect(await screen.findByText("You have no permission to change this app.")).toBeTruthy();
});

const TWO_CHANGES = changes([item("objects/sheets/s1.json", "changed", "sheets", "Overview"), item("objects/sheets/s2.json", "added", "sheets", "Details")]);

async function openBehindQuestion(bridge: FakeBridge): Promise<HTMLElement> {
  render(<App bridge={bridge} />);
  fireEvent.click(await screen.findByText("Save changes"));
  fireEvent.input(await screen.findByPlaceholderText("Commit message"), { target: { value: "Fix" } });
  fireEvent.click(screen.getByText("Save"));
  return screen.findByRole("dialog");
}

test("the behind question offers Update first", async () => {
  const head = "9".repeat(40);
  const bridge = linked({
    localChanges: [TWO_CHANGES, TWO_CHANGES], commit: [{ behind: [c2] }],
    updatePreview: [preview({ target: head, localChanges: 2 })], update: [{ syncedSha: head, backupBranch: "backup/main-20261120-1200", applied: 1 }],
  }, linkedView({ headSha: head, behindBy: 1 }));
  const question = await openBehindQuestion(bridge);
  expect(within(question).getByText("Commit anyway")).toBeTruthy();
  expect(within(question).getByText("Cancel")).toBeTruthy();
  fireEvent.click(within(question).getByText("Update first"));
  await screen.findByText("Update Application from the repository?");
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  await screen.findByText(PLAN);
  expect(bridge.commands.find((c) => c.cmd === "updatePreview")).toEqual({ cmd: "updatePreview", appId: APP_ID, target: head, parts: ["script", "objects", "files"] });
  fireEvent.click(within(dlg()).getByText("Update"));
  await screen.findByText("Success");
  fireEvent.click(within(dlg()).getByText("Close"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("Choose what to save")).toBeNull();
});

test("cancelling the update opened from the behind question returns to it", async () => {
  const bridge = linked({ localChanges: [TWO_CHANGES], commit: [{ behind: [c2] }], updatePreview: [preview()] }, linkedView({ behindBy: 1 }));
  fireEvent.click(within(await openBehindQuestion(bridge)).getByText("Update first"));
  await screen.findByText(PLAN);
  fireEvent.click(within(dlg()).getByText("Cancel"));
  expect(within(dlg()).getByText("Update first")).toBeTruthy();
});

test("details opens the diff overlay for that object", async () => {
  const bridge = linked({ localChanges: [TWO_CHANGES] });
  render(<App bridge={bridge} />);
  const row = (await screen.findByText("Details")).closest("li") as HTMLElement;
  fireEvent.click(within(row).getByText("details"));
  await waitFor(() => expect(bridge.commands.find((c) => c.cmd === "showDiff")).toEqual({
    cmd: "showDiff", repo: "lr-bicc/sales", before: { kind: "commit", sha: "abc" }, after: { kind: "app" }, select: "objects/sheets/s2.json", title: "Local changes",
  }));
});

const interrupted = (backupBranch: string | null): StatusView => {
  const v = view(LINKED);
  if (v.page !== "app") throw new Error("app view expected");
  return { ...v, interruptedUpdate: { appId: APP_ID, repo: "lr-bicc/sales", branch: "main", target: c2.sha, backupBranch, total: 7, startedAt: "2026-11-20T10:00:00Z" } };
};

test("an interrupted update is reported under the header, with the backup branch", async () => {
  render(<App bridge={linked({}, interrupted("backup/main-20261120-1200"))} />);
  expect(await screen.findByText("The last update did not finish (7 changes planned). Update again, or restore your work from backup/main-20261120-1200.")).toBeTruthy();
});

test("an interrupted update without a backup ends after Update again", async () => {
  render(<App bridge={linked({}, interrupted(null))} />);
  expect(await screen.findByText("The last update did not finish (7 changes planned). Update again.")).toBeTruthy();
});

test("published apps and apps without write permission show no Update", async () => {
  const noWrite = view(LINKED);
  if (noWrite.page !== "app") throw new Error("app view expected");
  const bridge = linked({}, { ...noWrite, app: { ...noWrite.app, canWrite: false } });
  render(<App bridge={bridge} />);
  await screen.findByText("No local changes");
  expect(screen.queryByText("Update")).toBeNull();
  expect(screen.queryByLabelText("Choose what to update")).toBeNull();
  expect(bridge.commands.some((c) => c.cmd === "commits")).toBe(false);
  cleanup();
  const pub = fakeBridge({ status: [view({ state: "published", repo: "lr-bicc/sales", branch: "main", syncedSha: "abc" } as never)], localChanges: [noChanges] });
  render(<App bridge={pub} />);
  await screen.findByText("No local changes");
  expect(screen.queryByText("Update")).toBeNull();
  expect(screen.queryByLabelText("Choose what to update")).toBeNull();
});

test("the picker preselects the head, shows tags and filters by message and sha", async () => {
  const bridge = linked({ tags: [[{ name: "v1.0", sha: c1.sha, date: null, message: "" }]] }, linkedView({ behindBy: 0 }));
  render(<App bridge={bridge} />);
  expect(await screen.findByText("Second")).toBeTruthy();
  expect(screen.getByText("v1.0")).toBeTruthy();
  expect(radioOf("Second").checked).toBe(true);
  expect(screen.getByText("First")).toBeTruthy(); // first line only
  expect(screen.getByText(new Date(c2.date).toLocaleString(), { exact: false })).toBeTruthy();
  expect(screen.getByText("Update")).toBeTruthy(); // no count without commits behind
  fireEvent.input(screen.getByPlaceholderText("Search commits"), { target: { value: "sec" } });
  expect(screen.queryByText("First")).toBeNull();
  fireEvent.input(screen.getByPlaceholderText("Search commits"), { target: { value: "1111" } });
  expect(screen.queryByText("Second")).toBeNull();
  expect(screen.getByText("First")).toBeTruthy();
});

test("each commit in the picker shows its short sha, so commits with equal messages stay apart", async () => {
  const twin = { ...c1, message: c2.message };
  render(<App bridge={linked({ commits: [[c2, twin]] }, linkedView({ behindBy: 0 }))} />);
  await screen.findAllByText("Second");
  const rows = Array.from(document.querySelectorAll(".picker-list li"));
  expect(rows.map((r) => r.querySelector(".commit-sha")?.textContent)).toEqual([c2.sha.slice(0, 7), twin.sha.slice(0, 7)]);
});

test("choosing an older commit updates to that commit and drops the count", async () => {
  const bridge = linked({ updatePreview: [preview({ target: c1.sha })] });
  render(<App bridge={bridge} />);
  await screen.findByText("Update (2)");
  fireEvent.click(radioOf("First"));
  fireEvent.click(await screen.findByText("Update"));
  await screen.findByText("Update Application from the repository?");
  expect(bridge.commands.find((c) => c.cmd === "updatePreview")).toMatchObject({ target: c1.sha });
});

test("a backup branch can be chosen; its commits get the branch@sha label", async () => {
  const b1 = { ...c1, sha: "b".repeat(40), message: "Saved work" };
  const bridge = linked({ commits: [[c2, c1], [b1]], updatePreview: [preview({ target: b1.sha })] });
  render(<App bridge={bridge} />);
  await screen.findByText("Second");
  fireEvent.change(screen.getByLabelText("Branch"), { target: { value: "backup/main-20261101-1000" } });
  await screen.findByText("Saved work");
  expect(bridge.commands).toContainEqual({ cmd: "commits", repo: "lr-bicc/sales", branch: "backup/main-20261101-1000", page: 1 });
  fireEvent.click(radioOf("Saved work"));
  fireEvent.click(screen.getByText("Update"));
  await screen.findByText(PLAN);
  expect(within(dlg()).getByText("backup/main-20261101-1000@bbbbbbb", { exact: false })).toBeTruthy();
  expect(bridge.commands.find((c) => c.cmd === "updatePreview")).toMatchObject({ target: b1.sha });
});

test("Load more asks for the next page of the shown branch", async () => {
  const page = Array.from({ length: 30 }, (_, i) => ({ ...c1, sha: String(i).padStart(2, "0").repeat(20), message: `Commit ${i}` }));
  const bridge = linked({ commits: [page, [c1]] });
  render(<App bridge={bridge} />);
  fireEvent.click(await screen.findByText("Load more"));
  await waitFor(() => expect(bridge.commands).toContainEqual({ cmd: "commits", repo: "lr-bicc/sales", branch: "main", page: 2 }));
});
