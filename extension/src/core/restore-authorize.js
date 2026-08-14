/**
 * Authorization for moving a trashed bookmark back where it came from.
 * Pure: nothing here touches `chrome.*`, storage or the DOM.
 *
 * This deliberately does NOT reuse `buildRollbackPlan` / `runRollback`. Those
 * bind every step to the position the node held immediately after Apply and
 * abort otherwise, which is correct for undoing a batch that just ran and wrong
 * for a restore that happens days later after unrelated edits.
 *
 * Order is restored only for a whole intact batch, in reverse sequence, at each
 * receipt's recorded index — the one arrangement that is provably faithful, and
 * only while the folders involved are still shaped the way the batch left them.
 * A single item is appended and reported as approximate; it is never silently
 * dropped at a stale numeric index.
 */
import { RECEIPT_STATE, fingerprintChildIds } from "./trash-ledger.js";
import {
  boundaryKey,
  isBoundaryIndeterminate,
  isDescendantOf,
  topAncestorOf,
} from "./tree-model.js";

export const RESTORE = {
  EXACT: "exact",
  APPROXIMATE: "approximate",
  NOT_RESTORABLE: "not-restorable",
  POISONED: "poisoned",
  NODE_MISSING: "node-missing",
  NODE_NOT_BOOKMARK: "node-not-bookmark",
  IDENTITY_MISMATCH: "identity-mismatch",
  MOVED_SINCE_TRASH: "moved-since-trash",
  DESTINATION_NOT_FOUND: "destination-not-found",
  DESTINATION_NOT_FOLDER: "destination-not-folder",
  DESTINATION_UNMODIFIABLE: "destination-unmodifiable",
  DESTINATION_MOVED: "destination-moved",
  DESTINATION_CHANGED: "destination-changed",
  BATCH_INCOMPLETE: "batch-incomplete",
  BOUNDARY_VIOLATION: "boundary-violation",
  BOUNDARY_INDETERMINATE: "boundary-indeterminate",
};

/** Outermost permanent root first, ending at the node's direct parent. */
export function ancestorIdsOf(entry, byId) {
  const ids = [];
  let current = byId.get(entry?.parentId);
  while (current && !current.isRoot) {
    ids.push(current.id);
    current = byId.get(current.parentId);
  }
  return ids.reverse();
}

/** Ordered child ids per folder: the append slot and the folder fingerprint both come from this. */
export function childIdsByParent(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (entry.parentId === null) continue;
    const siblings = groups.get(entry.parentId);
    if (siblings) siblings.push(entry);
    else groups.set(entry.parentId, [entry]);
  }
  const ordered = new Map();
  for (const [parentId, siblings] of groups) {
    ordered.set(
      parentId,
      siblings
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((entry) => entry.id),
    );
  }
  return ordered;
}

// Defaulting this to empty would quietly place every restore at index 0 instead
// of appending, so a caller that supplies neither is a programming error.
function resolveChildren(context) {
  if (context.childIdsByParent) return context.childIdsByParent;
  if (context.entries) return childIdsByParent(context.entries);
  throw new TypeError(
    "restore authorization needs entries or childIdsByParent",
  );
}

function sameIds(a, b) {
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((id, i) => id === b[i])
  );
}

/**
 * Evaluates one receipt against the live tree.
 * A pass returns `approximate`: appending is the only placement a single
 * restore can honestly claim. `exact` is reserved for `authorizeBatchRestore`.
 */
export function authorizeRestore(receipt, context) {
  const { byId, poisonedBookmarkIds = new Set() } = context;
  const children = resolveChildren(context);
  const deny = (verdict) => ({
    receiptId: receipt.receiptId,
    bookmarkId: receipt.bookmarkId,
    verdict,
    targetParentId: null,
    targetIndex: null,
  });

  if (receipt.state !== RECEIPT_STATE.TRASHED) {
    return deny(RESTORE.NOT_RESTORABLE);
  }
  if (poisonedBookmarkIds.has(receipt.bookmarkId)) {
    return deny(RESTORE.POISONED);
  }

  const node = byId.get(receipt.bookmarkId);
  if (!node) return deny(RESTORE.NODE_MISSING);
  // v1 trashes bookmarks only, and a folder would drag descendants this receipt
  // never described.
  if (node.isFolder) return deny(RESTORE.NODE_NOT_BOOKMARK);
  if (
    node.dateAdded !== receipt.dateAdded ||
    node.title !== receipt.title ||
    node.url !== receipt.url
  ) {
    return deny(RESTORE.IDENTITY_MISMATCH);
  }

  // Somebody else may have taken the node out of the Trash folder, including
  // another device. Put nothing back in that case, and never re-create.
  const stillInTrash =
    node.parentId === receipt.observedTrashParentId ||
    isDescendantOf(node.id, receipt.observedTrashParentId, byId);
  if (!stillInTrash) return deny(RESTORE.MOVED_SINCE_TRASH);

  const destination = byId.get(receipt.originalParentId);
  if (!destination) return deny(RESTORE.DESTINATION_NOT_FOUND);
  if (!destination.isFolder || destination.isRoot) {
    return deny(RESTORE.DESTINATION_NOT_FOLDER);
  }
  if (destination.unmodifiable) return deny(RESTORE.DESTINATION_UNMODIFIABLE);
  // Same-named paths can coexist, so only the id chain proves this is still the
  // folder the item was taken from rather than a different folder of that name.
  if (!sameIds(ancestorIdsOf(destination, byId), receipt.originalAncestorIds)) {
    return deny(RESTORE.DESTINATION_MOVED);
  }

  if (
    isBoundaryIndeterminate(node, byId) ||
    isBoundaryIndeterminate(destination, byId)
  ) {
    return deny(RESTORE.BOUNDARY_INDETERMINATE);
  }
  if (
    boundaryKey(topAncestorOf(node, byId)) !==
    boundaryKey(topAncestorOf(destination, byId))
  ) {
    return deny(RESTORE.BOUNDARY_VIOLATION);
  }

  return {
    receiptId: receipt.receiptId,
    bookmarkId: receipt.bookmarkId,
    verdict: RESTORE.APPROXIMATE,
    targetParentId: destination.id,
    targetIndex: (children.get(destination.id) ?? []).length,
  };
}

/**
 * The only path that can claim `exact`. Every condition below is load-bearing:
 *
 * - the batch is complete, so a quarantined or forgotten member cannot make a
 *   partial set look intact;
 * - every member is still `trashed` and individually authorized;
 * - each original folder is still shaped the way this batch left it, checked by
 *   fingerprint, because the recorded indices only reconstruct the layout when
 *   nothing else edited that folder in the meantime.
 */
export function authorizeBatchRestore(ledger, batchId, context) {
  const children = resolveChildren(context);
  const receipts = ledger.receipts
    .filter((receipt) => receipt.batchId === batchId)
    .slice()
    .sort((a, b) => a.sequence - b.sequence);

  const refuse = (verdict, blocked = []) => ({ verdict, steps: [], blocked });

  if (receipts.length === 0) return refuse(RESTORE.NOT_RESTORABLE);

  const batchSize = receipts[0].batchSize;
  const complete =
    receipts.every((receipt) => receipt.batchSize === batchSize) &&
    receipts.length === batchSize &&
    receipts.every((receipt, i) => receipt.sequence === i);
  if (!complete) return refuse(RESTORE.BATCH_INCOMPLETE);

  const rows = receipts.map((receipt) =>
    authorizeRestore(receipt, { ...context, childIdsByParent: children }),
  );
  const blocked = rows.filter((row) => row.verdict !== RESTORE.APPROXIMATE);
  if (blocked.length > 0) return refuse(RESTORE.NOT_RESTORABLE, blocked);

  // One check per original folder, against the member that left it last: that is
  // the state a reverse-order restore starts from.
  const lastPerParent = new Map();
  for (const receipt of receipts) {
    lastPerParent.set(receipt.originalParentId, receipt);
  }
  for (const [parentId, receipt] of lastPerParent) {
    const recorded = receipt.originalParentFingerprintAfter;
    if (recorded === null) return refuse(RESTORE.DESTINATION_CHANGED);
    if (fingerprintChildIds(children.get(parentId) ?? []) !== recorded) {
      return refuse(RESTORE.DESTINATION_CHANGED);
    }
  }

  return {
    verdict: RESTORE.EXACT,
    blocked: [],
    steps: receipts
      .slice()
      .reverse()
      .map((receipt) => ({
        receiptId: receipt.receiptId,
        bookmarkId: receipt.bookmarkId,
        targetParentId: receipt.originalParentId,
        targetIndex: receipt.originalIndex,
      })),
  };
}
