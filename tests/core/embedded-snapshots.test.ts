import { embeddedSnapshots, withoutSnapshotIdentity } from "../../src/core/embedded-snapshots";
import { deserializeApp } from "../../src/core/deserializer";
import { serializeApp } from "../../src/core/serializer";
import type { PropertyTree } from "../../src/core/types";
import { SNAPSHOT_CONTENT as content, storyWithSnapshot } from "../fixtures/story-snapshot";
import { APP_ID, CANON_ID, makeSnapshot } from "../fixtures/snapshot";

test("drops what embedding cannot restore: the snapshot's id and the selections it was taken with", () => {
  const tree = withoutSnapshotIdentity(storyWithSnapshot());
  const item = tree.qChildren[0]!.qChildren[1] as PropertyTree & { qEmbeddedSnapshotRef: unknown };
  expect(item.qEmbeddedSnapshotRef).toEqual({ qProperties: { qInfo: { qType: "embeddedsnapshot" }, ...content } });
  // Key order stays, so the file text is stable.
  expect(Object.keys((item.qEmbeddedSnapshotRef as { qProperties: object }).qProperties)).toEqual(["qInfo", "qHyperCube", "title"]);
});

test("two embeddings of the same snapshot are equal once id and selections are dropped", () => {
  const a = withoutSnapshotIdentity(storyWithSnapshot("id-a"));
  const b = withoutSnapshotIdentity(storyWithSnapshot("id-b", { qStateData: [] }));
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});

test("a tree without embedded snapshots is returned as it is; the input is never changed", () => {
  const plain = makeSnapshot().sheets[0]!;
  expect(withoutSnapshotIdentity(plain)).toBe(plain);
  const story = storyWithSnapshot();
  const before = JSON.stringify(story);
  withoutSnapshotIdentity(story);
  expect(JSON.stringify(story)).toBe(before);
  const once = withoutSnapshotIdentity(story);
  expect(withoutSnapshotIdentity(once)).toBe(once);
});

test("embeddedSnapshots lists the objects that hold one, with the snapshot's content", () => {
  expect(embeddedSnapshots(storyWithSnapshot())).toEqual([
    { objectId: "item-snap", properties: { qInfo: { qId: "7683145f", qType: "embeddedsnapshot" }, ...content } },
  ]);
  expect(embeddedSnapshots(makeSnapshot().sheets[0]!)).toEqual([]);
});

test("files written by gitoqlok (with id and selections) and by the tool read back alike", () => {
  const snap = makeSnapshot();
  snap.stories = [storyWithSnapshot()];
  const files = serializeApp(snap, { canonicalAppId: CANON_ID });
  const read = deserializeApp(files, { targetAppId: APP_ID });
  expect(read.stories).toEqual([withoutSnapshotIdentity(storyWithSnapshot())]);
});
