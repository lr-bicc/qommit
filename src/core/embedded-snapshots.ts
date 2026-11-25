import type { GenericProps, PropertyTree } from "./types";

/**
 * A snapshot embedded in an object of a property tree (a story's slide item), as the engine returns it next to
 * `qProperty`: the snapshot's properties, its content, and the selections (`qBookmark`) of the moment it was taken.
 */
export interface EmbeddedSnapshotRef { qProperties: GenericProps; qBookmark?: unknown }
type Node = PropertyTree & { qEmbeddedSnapshotRef?: EmbeddedSnapshotRef | null };

const isRef = (v: unknown): v is EmbeddedSnapshotRef =>
  typeof v === "object" && v !== null && typeof (v as { qProperties?: unknown }).qProperties === "object" && (v as { qProperties: unknown }).qProperties !== null;

function withoutIdentity(ref: EmbeddedSnapshotRef): EmbeddedSnapshotRef {
  const info = ref.qProperties.qInfo as { qId?: string; qType: string } | undefined;
  if (!("qBookmark" in ref) && Object.keys(ref).length === 1 && (info === undefined || info.qId === undefined)) return ref;
  const qProperties = info === undefined ? ref.qProperties : ({ ...ref.qProperties, qInfo: { qType: info.qType } } as unknown as GenericProps);
  return { qProperties };
}

/**
 * The tree without what the engine cannot restore of an embedded snapshot: its id, which embedding always assigns anew,
 * and the selections it was taken with. The snapshot's content stays. Unchanged subtrees, and a tree without embedded
 * snapshots, are returned as they are; the input is never changed.
 */
export function withoutSnapshotIdentity<T extends PropertyTree>(tree: T): T {
  const node = tree as Node;
  let changed = false;
  const children = (node.qChildren ?? []).map((c) => {
    const next = withoutSnapshotIdentity(c);
    if (next !== c) changed = true;
    return next;
  });
  const ref = node.qEmbeddedSnapshotRef;
  const nextRef = isRef(ref) ? withoutIdentity(ref) : ref;
  if (nextRef !== ref) changed = true;
  if (!changed) return tree;
  const out = { ...node, qChildren: children } as Node;
  if (isRef(ref)) out.qEmbeddedSnapshotRef = nextRef;
  return out as T;
}

/** The objects in the tree that hold an embedded snapshot, in tree order, with the snapshot's properties. */
export function embeddedSnapshots(tree: PropertyTree): { objectId: string; properties: GenericProps }[] {
  const out: { objectId: string; properties: GenericProps }[] = [];
  const walk = (node: Node) => {
    if (isRef(node.qEmbeddedSnapshotRef)) out.push({ objectId: node.qProperty.qInfo.qId, properties: node.qEmbeddedSnapshotRef.qProperties });
    for (const c of node.qChildren ?? []) walk(c);
  };
  walk(tree);
  return out;
}
