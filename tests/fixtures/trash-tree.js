/** Fixture for trash and restore tests: a Work folder, a Trash folder, and a second store. */
const ITEM = {
  100: { title: "Alpha", url: "https://example.com/a", dateAdded: 1000 },
  101: { title: "Bravo", url: "https://example.com/b", dateAdded: 2000 },
  102: { title: "Charlie", url: "https://example.com/c", dateAdded: 3000 },
};

/**
 * `workIn` places the Work folder directly on the bar ("1") or inside Nest
 * ("30"), which is how a test makes the recorded ancestor chain stale.
 * `nest` puts items in a third folder, for the case where something else moved
 * a trashed node somewhere that is neither Trash nor its origin.
 */
export function buildTree({
  workIn = "1",
  work = ["100", "101", "102"],
  trash = [],
  nest: nestItems = [],
} = {}) {
  const items = (ids, parentId) =>
    ids.map((id, index) => ({
      id,
      parentId,
      index,
      syncing: true,
      ...ITEM[id],
    }));

  const workFolder = {
    id: "10",
    parentId: workIn,
    index: 0,
    title: "Work",
    syncing: true,
    children: items(work, "10"),
  };
  const trashFolder = {
    id: "20",
    parentId: "1",
    index: 0,
    title: "Trash",
    syncing: true,
    children: items(trash, "20"),
  };
  const nest = {
    id: "30",
    parentId: "1",
    index: 0,
    title: "Nest",
    syncing: true,
    children: workIn === "30" ? [workFolder] : items(nestItems, "30"),
  };

  const barChildren =
    workIn === "1" ? [workFolder, trashFolder, nest] : [trashFolder, nest];
  barChildren.forEach((child, index) => {
    child.parentId = "1";
    child.index = index;
  });
  if (workIn === "30") {
    workFolder.parentId = "30";
    workFolder.index = 0;
  }

  return [
    {
      id: "0",
      title: "",
      children: [
        {
          id: "1",
          parentId: "0",
          index: 0,
          title: "Bar",
          folderType: "bookmarks-bar",
          syncing: true,
          children: barChildren,
        },
        {
          id: "3",
          parentId: "0",
          index: 1,
          title: "Local",
          folderType: "other",
          syncing: false,
          children: [
            {
              id: "300",
              parentId: "3",
              index: 0,
              title: "Local Folder",
              syncing: false,
              children: [],
            },
          ],
        },
      ],
    },
  ];
}

/** A `trashed` receipt for Alpha, taken from Work at index 0. */
export function sampleReceipt(overrides = {}) {
  return {
    receiptId: "batch-1:0",
    batchId: "batch-1",
    sequence: 0,
    batchSize: 1,
    bookmarkId: "100",
    title: "Alpha",
    url: "https://example.com/a",
    dateAdded: 1000,
    originalParentId: "10",
    originalAncestorIds: ["1"],
    originalParentPath: ["Bar", "Work"],
    originalIndex: 0,
    originalParentFingerprintAfter: null,
    boundaryKey: "syncing:true",
    trashParentId: "20",
    observedTrashParentId: "20",
    observedTrashIndex: 0,
    restoreTargetParentId: null,
    restoreTargetIndex: null,
    deleteSnapshotDigest: null,
    trashedAt: 1_700_000_000_000,
    retentionUntil: 1_700_000_000_000 + 1000,
    state: "trashed",
    detail: null,
    ...overrides,
  };
}
