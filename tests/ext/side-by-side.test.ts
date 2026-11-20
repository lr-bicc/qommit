import type { LineChange } from "../../src/core/diff";
import { sideBySide, type SideCell } from "../../src/ext/content/overlay/side-by-side";

const line = (kind: LineChange["kind"], text: string): LineChange => ({ kind, text });
const cell = (kind: SideCell["kind"], text: string): SideCell => ({ kind, text });
const same = (t: string) => line("same", t);
const removed = (t: string) => line("removed", t);
const added = (t: string) => line("added", t);
const s = (t: string) => cell("same", t);
const r = (t: string) => cell("removed", t);
const ad = (t: string) => cell("added", t);

test("removed and added blocks are paired line by line", () => {
  expect(sideBySide([same("a"), removed("b"), removed("c"), added("B"), same("d")])).toEqual([
    { left: s("a"), right: s("a") }, { left: r("b"), right: ad("B") }, { left: r("c"), right: null }, { left: s("d"), right: s("d") },
  ]);
});

test("added lines beyond the removed block fill the left side with null", () => {
  expect(sideBySide([removed("a"), added("A"), added("B")])).toEqual([
    { left: r("a"), right: ad("A") }, { left: null, right: ad("B") },
  ]);
});

test("a lone added or removed block has an empty opposite side", () => {
  expect(sideBySide([added("x"), same("y"), removed("z")])).toEqual([
    { left: null, right: ad("x") }, { left: s("y"), right: s("y") }, { left: r("z"), right: null },
  ]);
});

test("no lines give no rows", () => {
  expect(sideBySide([])).toEqual([]);
});
