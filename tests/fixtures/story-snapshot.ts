import type { PropertyTree } from "../../src/core/types";

export const SNAPSHOT_CONTENT = { qHyperCube: { qSize: { qcx: 2, qcy: 1 } }, title: "PartnerNr" };
/** A story with one slide holding a text item and a snapshot item, as the engine returns it. */
export function storyWithSnapshot(snapshotId = "7683145f", bookmark: unknown = { qStateData: [{ qStateName: "$", qFieldItems: [{ qDef: { qName: "Year" } }] }] }): PropertyTree {
  return {
    qProperty: { qInfo: { qId: "story-1", qType: "story" }, qMetaDef: { title: "Story" } },
    qChildren: [{
      qProperty: { qInfo: { qId: "slide-1", qType: "slide" } },
      qChildren: [
        { qProperty: { qInfo: { qId: "item-text", qType: "slideitem" }, visualization: "text", qEmbeddedSnapshotDef: {} }, qChildren: [] },
        {
          qProperty: { qInfo: { qId: "item-snap", qType: "slideitem" }, visualization: "snapshot", qEmbeddedSnapshotDef: {} },
          qChildren: [],
          qEmbeddedSnapshotRef: { qProperties: { qInfo: { qId: snapshotId, qType: "embeddedsnapshot" }, ...SNAPSHOT_CONTENT }, qBookmark: bookmark },
        } as PropertyTree,
      ],
    }],
  };
}
