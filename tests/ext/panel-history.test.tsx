// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { App } from "../../src/ext/panel/App";
import { BridgeError } from "../../src/ext/panel/bridge";
import type { Command, StatusView } from "../../src/ext/shared/commands";
import type { UpdatePreview } from "../../src/ext/flows/update";
import { installFakeChrome } from "./fake-chrome";
import { fakeBridge, LINKED, view, type FakeBridge } from "./fake-bridge";
import { APP_ID } from "../fixtures/snapshot";

beforeEach(() => { installFakeChrome(); });
afterEach(cleanup);

const c1 = { sha: "1".repeat(40), message: "First\nbody", author: "Ann", date: "2026-11-01T10:00:00Z", parents: [] as string[] };
const c2 = { sha: "2".repeat(40), message: "Second", author: "Ann", date: "2026-11-02T10:00:00Z", parents: [c1.sha] };
const TAG_DATE = "2026-11-03T10:00:00Z";
const v1 = { name: "v1.0", sha: c2.sha, date: TAG_DATE, message: "Release\nnotes" };
const noDate = { name: "old", sha: c1.sha, date: null, message: "" };
const preview: UpdatePreview = {
  target: c2.sha,
  items: [{ kind: "change", group: "sheets", id: "s1", title: "Overview" }],
  summary: { create: 0, change: 1, delete: 0 },
  localChanges: 0,
  onBranch: true,
  advances: false,
};
const noChanges = { repo: "lr-bicc/sales", baseSha: "abc", items: [], unmaintained: [] };
const dlg = (): HTMLElement => screen.getByRole("dialog");
const row = (message: string): HTMLElement => screen.getByText(message).closest("li")!;
const fail = (code: string, message: string): BridgeError => new BridgeError({ code, message });

function publishedView(): StatusView {
  return view({ state: "published", repo: "lr-bicc/sales", branch: "main", syncedSha: "abc" });
}

function linked(answers: Partial<Record<Command["cmd"], unknown[]>> = {}, status: StatusView = view(LINKED)): FakeBridge {
  return fakeBridge({
    status: [status], history: [{ commits: [c2, c1], defaultBranch: "main" }], tags: [[v1]],
    localChanges: [noChanges], showDiff: [null], ...answers,
  });
}

async function openTab(bridge: FakeBridge, name: "History" | "Tags"): Promise<void> {
  render(<App bridge={bridge} />);
  await screen.findByText("No local changes");
  fireEvent.click(screen.getByRole("tab", { name }));
}

test("history entries offer diff, tag and update actions", async () => {
  const bridge = linked({ updatePreview: [preview] });
  await openTab(bridge, "History");
  await screen.findByText("Second");
  expect(within(row("Second")).getByText("v1.0").className).toBe("tag"); // the badge of the tagged commit
  expect(within(row("First")).queryByText("v1.0")).toBeNull();

  fireEvent.click(within(row("Second")).getByText("Diff to previous"));
  await waitFor(() => expect(bridge.commands.filter((c) => c.cmd === "showDiff")).toHaveLength(1));
  expect(bridge.commands.filter((c) => c.cmd === "showDiff")[0]).toEqual({
    cmd: "showDiff", repo: "lr-bicc/sales", before: { kind: "commit", sha: c1.sha }, after: { kind: "commit", sha: c2.sha }, title: "2222222 against its parent",
  });

  fireEvent.click(within(row("Second")).getByText("Diff to app"));
  await waitFor(() => expect(bridge.commands.filter((c) => c.cmd === "showDiff")).toHaveLength(2));
  expect(bridge.commands.filter((c) => c.cmd === "showDiff")[1]).toEqual({
    cmd: "showDiff", repo: "lr-bicc/sales", before: { kind: "commit", sha: c2.sha }, after: { kind: "app" }, title: "App against 2222222",
  });

  fireEvent.click(within(row("Second")).getByText("Add tag"));
  expect(within(dlg()).getByText("Add tag to 2222222")).toBeTruthy();
  fireEvent.click(within(dlg()).getByText("Cancel"));
  expect(screen.queryByRole("dialog")).toBeNull();

  fireEvent.click(within(row("Second")).getByText("Update app to this commit"));
  expect(await within(dlg()).findByText("Update Application from the repository?")).toBeTruthy();
  expect(within(dlg()).getByText("2222222", { selector: "a" })).toBeTruthy();
  expect(within(dlg()).getByText("2222222", { selector: "p", exact: false })).toBeTruthy();
  await screen.findByText("0 to create, 1 to change, 0 to delete");
  expect(bridge.commands.find((c) => c.cmd === "updatePreview")).toEqual({
    cmd: "updatePreview", appId: APP_ID, target: c2.sha, parts: ["script", "objects", "files"],
  });
});

test("a failing diff shows its error", async () => {
  const bridge = linked({ showDiff: [fail("network", "x")] });
  await openTab(bridge, "History");
  await screen.findByText("Second");
  fireEvent.click(within(row("Second")).getByText("Diff to app"));
  expect(await screen.findByRole("alert")).toBeTruthy();
});

test("Diff to previous is disabled for the first commit", async () => {
  const bridge = linked();
  await openTab(bridge, "History");
  await screen.findByText("First");
  expect((within(row("First")).getByText("Diff to previous") as HTMLButtonElement).disabled).toBe(true);
  expect((within(row("Second")).getByText("Diff to previous") as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(within(row("First")).getByText("Diff to previous"));
  expect(bridge.commands.some((c) => c.cmd === "showDiff")).toBe(false);
});

test("Add tag sends name and description and reloads the tags", async () => {
  const bridge = linked({ addTag: [null], tags: [[], [], [v1]] });
  await openTab(bridge, "History");
  await screen.findByText("Second");
  expect(screen.queryByText("v1.0")).toBeNull();
  fireEvent.click(within(row("Second")).getByText("Add tag"));
  const addButton = within(dlg()).getByText("Add tag") as HTMLButtonElement; // the dialog's own button
  expect(addButton.disabled).toBe(true); // a name is needed
  fireEvent.input(within(dlg()).getByLabelText("Tag name"), { target: { value: " v1.0 " } });
  fireEvent.input(within(dlg()).getByLabelText("Description (optional)"), { target: { value: "Release" } });
  fireEvent.click(addButton);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(bridge.commands.find((c) => c.cmd === "addTag")).toEqual({ cmd: "addTag", repo: "lr-bicc/sales", sha: c2.sha, name: "v1.0", message: "Release" });
  await waitFor(() => expect(bridge.commands.filter((c) => c.cmd === "tags")).toHaveLength(3));
  expect(bridge.commands.filter((c) => c.cmd === "tags")[2]).toEqual({ cmd: "tags", repo: "lr-bicc/sales" });
  expect((await within(row("Second")).findByText("v1.0")).className).toBe("tag");
});

test("an existing tag name is reported in the dialog", async () => {
  const bridge = linked({ addTag: [fail("tag-exists", "x")] });
  await openTab(bridge, "History");
  await screen.findByText("Second");
  fireEvent.click(within(row("Second")).getByText("Add tag"));
  fireEvent.input(within(dlg()).getByLabelText("Tag name"), { target: { value: "v1.0" } });
  fireEvent.click(within(dlg()).getByText("Add tag"));
  expect(await within(dlg()).findByText("Tag already exists.")).toBeTruthy();
  expect(screen.getByRole("dialog")).toBeTruthy(); // stays open
  expect(bridge.commands.filter((c) => c.cmd === "tags")).toHaveLength(2); // no reload after the failure
});

test("the Tags tab lists tags and updates the app to a tag", async () => {
  const bridge = linked({ tags: [[v1, noDate]], updatePreview: [{ ...preview }] });
  await openTab(bridge, "Tags");
  await screen.findByText("v1.0");
  expect(within(row("v1.0")).getByText(new Date(TAG_DATE).toLocaleString())).toBeTruthy();
  expect(within(row("v1.0")).getByText("2222222").getAttribute("href")).toBe(`https://github.com/lr-bicc/sales/commit/${c2.sha}`);
  expect(within(row("v1.0")).getByText("Release")).toBeTruthy(); // first line only
  expect(screen.queryByText("notes")).toBeNull();
  expect(within(row("old")).getByText("–")).toBeTruthy();

  fireEvent.click(within(row("v1.0")).getByText("Diff to app"));
  await waitFor(() => expect(bridge.commands.some((c) => c.cmd === "showDiff")).toBe(true));
  expect(bridge.commands.find((c) => c.cmd === "showDiff")).toEqual({
    cmd: "showDiff", repo: "lr-bicc/sales", before: { kind: "commit", sha: c2.sha }, after: { kind: "app" }, title: "App against 2222222",
  });

  fireEvent.click(within(row("v1.0")).getByText("Update app to this tag"));
  expect(await within(dlg()).findByText("Update Application from the repository?")).toBeTruthy();
  expect(within(dlg()).getByText(/v1\.0/)).toBeTruthy();
  expect(bridge.commands.find((c) => c.cmd === "updatePreview")).toEqual({
    cmd: "updatePreview", appId: APP_ID, target: c2.sha, parts: ["script", "objects", "files"],
  });
});

test("the Tags tab says so when there are no tags", async () => {
  await openTab(linked({ tags: [[]] }), "Tags");
  expect(await screen.findByText("No tags")).toBeTruthy();
});

test("a published app has no update actions", async () => {
  const bridge = linked({}, publishedView());
  await openTab(bridge, "History");
  await screen.findByText("Second");
  expect(within(row("Second")).getByText("Diff to previous")).toBeTruthy();
  expect(within(row("Second")).getByText("Diff to app")).toBeTruthy();
  expect(within(row("Second")).getByText("Add tag")).toBeTruthy();
  expect(screen.queryByText("Update app to this commit")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Tags" }));
  await screen.findByText("v1.0");
  expect(within(row("v1.0")).getByText("Diff to app")).toBeTruthy();
  expect(screen.queryByText("Update app to this tag")).toBeNull();
});

test("a published app can add a tag from the History tab", async () => {
  const bridge = linked({}, publishedView());
  await openTab(bridge, "History");
  await screen.findByText("Second");
  fireEvent.click(within(row("Second")).getByText("Add tag"));
  expect(await screen.findByRole("dialog")).toBeTruthy();
});

test("a published app without a recorded commit still shows History and Tags", async () => {
  const bridge = linked({}, view({ state: "published", repo: "lr-bicc/sales", branch: null, syncedSha: null }));
  render(<App bridge={bridge} />);
  await screen.findByText("Second");
  expect(screen.queryByRole("tab", { name: "Local Changes" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Tags" }));
  await screen.findByText("v1.0");
});
