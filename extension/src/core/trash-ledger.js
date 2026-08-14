/**
 * Durable recovery metadata for bookmarks moved into the Trash folder.
 * Pure: nothing here touches `chrome.*`, storage or the DOM.
 *
 * This ledger is the ONLY write-ahead record for trash and restore moves. The
 * apply journal stays bound to plan-driven batches, so no single operation is
 * ever owned by two durable stores at once.
 *
 * Unlike that journal the ledger is long-lived: it survives restarts, upgrades
 * and arbitrary unrelated edits. It is therefore re-validated on every read,
 * and one corrupt receipt is quarantined rather than discarding everybody
 * else's recovery data.
 */
import {
  DEFAULT_TRASH_RETENTION_MS,
  MAX_TRASH_DETAIL_CHARS,
  MAX_TRASH_FIELD_CHARS,
  MAX_TRASH_LEDGER_BYTES,
  MAX_TRASH_RECEIPTS,
} from "./limits.js";

export const TRASH_LEDGER_VERSION = 1;
const LEDGER_KIND = "trash-ledger";

export const RECEIPT_STATE = {
  PENDING: "pending",
  TRASHED: "trashed",
  RESTORING: "restoring",
  RESTORED: "restored",
  DELETING: "deleting",
  DELETED: "deleted",
  ORPHANED: "orphaned",
  FAILED: "failed",
};

/**
 * States that still describe a node the extension expects to find in the Trash
 * folder. Uniqueness and quarantine poisoning are scoped to these: `restored`
 * is history, and treating history as a conflict would poison the legitimate
 * case of trashing the same bookmark again after restoring it.
 */
const ACTIVE_STATES = new Set([
  RECEIPT_STATE.PENDING,
  RECEIPT_STATE.TRASHED,
  RECEIPT_STATE.RESTORING,
  RECEIPT_STATE.DELETING,
]);

/**
 * States that mean the extension is done with this receipt. Anything else —
 * including a value this build does not recognise — is treated as possibly
 * still describing a node in the Trash folder.
 */
const SETTLED_STATES = new Set([
  RECEIPT_STATE.RESTORED,
  RECEIPT_STATE.DELETED,
  RECEIPT_STATE.ORPHANED,
  RECEIPT_STATE.FAILED,
]);

export function isActiveState(state) {
  return ACTIVE_STATES.has(state);
}

/** Verdicts for a receipt persisted before a move that was never confirmed. */
export const INTERRUPTED = {
  DISCARD: "discard",
  TRASHED: "trashed",
  RESTORED: "restored",
  DELETED: "deleted",
  FAILED: "failed",
};

export function createLedger() {
  return { version: TRASH_LEDGER_VERSION, kind: LEDGER_KIND, receipts: [] };
}

/**
 * Order-sensitive fingerprint of a folder's children.
 *
 * Recorded right after an item leaves, and re-derived before a batch restore,
 * this is what tells "the folder is exactly as we left it" apart from "someone
 * edited it since". A plain child count would miss an insertion that is
 * cancelled out by a deletion.
 *
 * Two independently seeded FNV-1a lanes plus the child count, not a
 * cryptographic digest: a single 32-bit lane is narrow enough that a changed
 * folder could collide with the recorded value and be restored as if intact.
 */
function fnv1a(text, seed, prime) {
  let hash = seed;
  for (const chunk of text) {
    hash ^= chunk.codePointAt(0);
    hash = Math.imul(hash, prime) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function fingerprintChildIds(ids) {
  // Length-prefixed, not delimiter-joined: a separator that can occur inside an
  // id makes different folders encode identically, and both lanes then agree.
  const text = ids.map((id) => `${id.length}:${id}`).join("");
  return [
    ids.length.toString(16),
    fnv1a(text, 0x811c9dc5, 0x01000193),
    fnv1a(text, 0x9dc5811c, 0x01000199),
  ].join("-");
}

/**
 * Builds the write-ahead record for one item. Called immediately before that
 * item's own move, so `originalIndex` is the index the node actually had at
 * that moment — the same discipline `markAttempted` uses, and the reason a
 * whole-batch restore in reverse sequence can reproduce the original layout.
 */
export function createReceipt({
  batchId,
  sequence,
  batchSize,
  trashedAt,
  retentionMs = DEFAULT_TRASH_RETENTION_MS,
  trashParentId,
  item,
}) {
  return {
    receiptId: `${batchId}:${sequence}`,
    batchId,
    sequence,
    // Lets a restore tell an intact batch from one whose members were
    // quarantined or forgotten, which otherwise looks identical.
    batchSize,
    bookmarkId: item.bookmarkId,
    title: item.title,
    url: item.url,
    dateAdded: item.dateAdded ?? null,
    originalParentId: item.originalParentId,
    originalAncestorIds: [...item.originalAncestorIds],
    // Display only. Duplicate-named paths can coexist, so the id chain above is
    // what proves the destination folder has not been moved elsewhere.
    originalParentPath: [...item.originalParentPath],
    originalIndex: item.originalIndex,
    originalParentFingerprintAfter: null,
    boundaryKey: item.boundaryKey ?? null,
    trashParentId,
    observedTrashParentId: null,
    observedTrashIndex: null,
    restoreTargetParentId: null,
    restoreTargetIndex: null,
    deleteSnapshotDigest: null,
    trashedAt,
    retentionUntil: trashedAt + retentionMs,
    state: RECEIPT_STATE.PENDING,
    detail: null,
  };
}

export function appendReceipt(ledger, receipt) {
  return { ...ledger, receipts: [...ledger.receipts, receipt] };
}

/** Kept short so the capacity preflight can reserve a fixed amount for it. */
function boundDetail(detail) {
  if (typeof detail !== "string") return null;
  return detail.slice(0, MAX_TRASH_DETAIL_CHARS);
}

// Not exported: every state change goes through a `mark*` function, which is
// what keeps `detail` bounded. A general-purpose patch would reopen that.
function patchReceipt(ledger, receiptId, patch) {
  return {
    ...ledger,
    receipts: ledger.receipts.map((receipt) =>
      receipt.receiptId === receiptId ? { ...receipt, ...patch } : receipt,
    ),
  };
}

export function markTrashed(ledger, receiptId, observed, context = {}) {
  return patchReceipt(ledger, receiptId, {
    state: RECEIPT_STATE.TRASHED,
    observedTrashParentId: observed.parentId,
    observedTrashIndex: observed.index,
    originalParentFingerprintAfter: context.originalParentFingerprint ?? null,
    restoreTargetParentId: null,
    restoreTargetIndex: null,
    detail: null,
  });
}

/**
 * Recorded before the restore move, so an interrupted restore stays
 * classifiable. The observed trash position is refreshed at the same time:
 * anything may have reordered the Trash folder since the item landed there, and
 * a stale index would make an untouched node look like a failed restore.
 */
export function markRestoring(ledger, receiptId, { observed, target }) {
  return patchReceipt(ledger, receiptId, {
    state: RECEIPT_STATE.RESTORING,
    observedTrashParentId: observed.parentId,
    observedTrashIndex: observed.index,
    restoreTargetParentId: target.parentId,
    restoreTargetIndex: target.index,
    detail: null,
  });
}

export function markRestored(ledger, receiptId) {
  return patchReceipt(ledger, receiptId, {
    state: RECEIPT_STATE.RESTORED,
    detail: null,
  });
}

/**
 * Recorded before the only irreversible call in the build, together with the
 * snapshot the user had to verify to get here. If the page dies between the
 * call and its confirmation, this is the whole record of what was attempted.
 */
export function markDeleting(ledger, receiptId, snapshotDigest) {
  return patchReceipt(ledger, receiptId, {
    state: RECEIPT_STATE.DELETING,
    deleteSnapshotDigest: snapshotDigest,
    detail: null,
  });
}

export function markDeleted(ledger, receiptId) {
  return patchReceipt(ledger, receiptId, {
    state: RECEIPT_STATE.DELETED,
    detail: null,
  });
}

export function markOrphaned(ledger, receiptId, detail = null) {
  return patchReceipt(ledger, receiptId, {
    state: RECEIPT_STATE.ORPHANED,
    detail: boundDetail(detail),
  });
}

export function markFailed(ledger, receiptId, detail) {
  return patchReceipt(ledger, receiptId, {
    state: RECEIPT_STATE.FAILED,
    detail: boundDetail(detail),
  });
}

export function removeReceipts(ledger, receiptIds) {
  const drop = new Set(receiptIds);
  return {
    ...ledger,
    receipts: ledger.receipts.filter((receipt) => !drop.has(receipt.receiptId)),
  };
}

/**
 * Re-attaches the receipts `readLedger` quarantined.
 *
 * The working ledger holds only usable receipts, but the stored document must
 * keep the damaged ones: they are the evidence that poisons a bookmark id, and
 * writing without them would silently declare a node restorable again.
 */
export function withQuarantined(ledger, quarantined = []) {
  if (quarantined.length === 0) return ledger;
  return {
    ...ledger,
    receipts: [
      ...ledger.receipts,
      ...quarantined.map((entry) => entry.receipt),
    ],
  };
}

export function receiptsOfBatch(ledger, batchId) {
  return ledger.receipts
    .filter((receipt) => receipt.batchId === batchId)
    .slice()
    .sort((a, b) => a.sequence - b.sequence);
}

/**
 * Which receipts compaction may drop. Retention expiry is deliberately not a
 * reason: an expired receipt whose node is still in the Trash folder is still
 * restorable, and dropping it would destroy that possibility. The escape from
 * a full ledger is `removeReceipts` driven by an explicit user action, not a
 * broader compaction rule.
 */
export function compactableReceiptIds(ledger, byId) {
  return ledger.receipts
    .filter((receipt) => {
      if (receipt.state === RECEIPT_STATE.RESTORED) return true;
      // A deletion is only history once the node is really gone.
      if (receipt.state === RECEIPT_STATE.DELETED) {
        return !byId.has(receipt.bookmarkId);
      }
      return (
        receipt.state === RECEIPT_STATE.ORPHANED &&
        !byId.has(receipt.bookmarkId)
      );
    })
    .map((receipt) => receipt.receiptId);
}

/**
 * Classifies a receipt that was persisted before a move that was never
 * confirmed, which is exactly what a crash or a closed tab leaves behind.
 */
export function classifyInterrupted(receipt, liveNode) {
  if (receipt.state === RECEIPT_STATE.PENDING) {
    if (!liveNode) return INTERRUPTED.FAILED;
    if (
      liveNode.parentId === receipt.originalParentId &&
      liveNode.index === receipt.originalIndex
    ) {
      return INTERRUPTED.DISCARD;
    }
    if (liveNode.parentId === receipt.trashParentId) return INTERRUPTED.TRASHED;
    return INTERRUPTED.FAILED;
  }
  if (receipt.state === RECEIPT_STATE.RESTORING) {
    if (!liveNode) return INTERRUPTED.FAILED;
    if (
      liveNode.parentId === receipt.restoreTargetParentId &&
      liveNode.index === receipt.restoreTargetIndex
    ) {
      return INTERRUPTED.RESTORED;
    }
    if (
      liveNode.parentId === receipt.observedTrashParentId &&
      liveNode.index === receipt.observedTrashIndex
    ) {
      return INTERRUPTED.TRASHED;
    }
    return INTERRUPTED.FAILED;
  }
  if (receipt.state === RECEIPT_STATE.DELETING) {
    // Absence is the confirmation here: the call either took effect or it did
    // not, and there is nothing in between to reconcile.
    if (!liveNode) return INTERRUPTED.DELETED;
    if (liveNode.parentId === receipt.observedTrashParentId) {
      return INTERRUPTED.TRASHED;
    }
    return INTERRUPTED.FAILED;
  }
  return null;
}

/** Advisory label only; nothing acts on it. */
export function isExpired(receipt, now) {
  return now >= receipt.retentionUntil;
}

function isId(value) {
  return typeof value === "string" && value.length > 0;
}

function isIndex(value) {
  return Number.isInteger(value) && value >= 0;
}

function isBoundedText(value) {
  return typeof value === "string" && value.length <= MAX_TRASH_FIELD_CHARS;
}

function isIdList(value) {
  return Array.isArray(value) && value.every(isId);
}

/**
 * Why a receipt read back from storage cannot be trusted to drive a move.
 * The journal gets a lighter check because it is internally generated,
 * batch-bounded and short-lived; none of that holds here.
 *
 * @returns {null|string} null when the shape is usable, otherwise the reason.
 */
export function receiptShapeError(receipt) {
  if (receipt === null || typeof receipt !== "object") return "not-an-object";
  if (!isId(receipt.receiptId)) return "receiptId";
  if (!isId(receipt.batchId)) return "batchId";
  if (!isIndex(receipt.sequence)) return "sequence";
  if (!isIndex(receipt.batchSize) || receipt.batchSize < 1) return "batchSize";
  if (receipt.sequence >= receipt.batchSize) return "sequence-out-of-batch";
  if (!isId(receipt.bookmarkId)) return "bookmarkId";
  if (!isBoundedText(receipt.title)) return "title";
  // v1 trashes bookmarks only. A folder receipt would authorise moving a whole
  // subtree whose descendants this record never captured.
  if (!isId(receipt.url) || !isBoundedText(receipt.url)) return "url";
  if (receipt.dateAdded !== null && !Number.isFinite(receipt.dateAdded)) {
    return "dateAdded";
  }
  // Restore moves the node here, so junk in any of these would reach the API.
  if (!isId(receipt.originalParentId)) return "originalParentId";
  if (!isIdList(receipt.originalAncestorIds)) return "originalAncestorIds";
  if (
    !Array.isArray(receipt.originalParentPath) ||
    !receipt.originalParentPath.every(isBoundedText)
  ) {
    return "originalParentPath";
  }
  if (!isIndex(receipt.originalIndex)) return "originalIndex";
  if (
    receipt.originalParentFingerprintAfter !== null &&
    !isBoundedText(receipt.originalParentFingerprintAfter)
  ) {
    return "originalParentFingerprintAfter";
  }
  if (!isId(receipt.trashParentId)) return "trashParentId";
  // Trashing into the folder the item already sits in is the no-op the dry run
  // refuses, and it would make every interrupted move indistinguishable.
  if (receipt.trashParentId === receipt.originalParentId) {
    return "trash-parent-is-origin";
  }
  if (receipt.boundaryKey !== null && typeof receipt.boundaryKey !== "string") {
    return "boundaryKey";
  }
  if (!Number.isFinite(receipt.trashedAt) || receipt.trashedAt < 0) {
    return "trashedAt";
  }
  if (
    !Number.isFinite(receipt.retentionUntil) ||
    receipt.retentionUntil < receipt.trashedAt
  ) {
    return "retentionUntil";
  }
  if (!Object.values(RECEIPT_STATE).includes(receipt.state)) return "state";

  // A node that has left the pending window must carry where it was observed,
  // because that is what proves it is still where this extension put it.
  const observedRequired =
    receipt.state === RECEIPT_STATE.TRASHED ||
    receipt.state === RECEIPT_STATE.RESTORING ||
    receipt.state === RECEIPT_STATE.DELETING;
  if (observedRequired) {
    if (!isId(receipt.observedTrashParentId)) return "observedTrashParentId";
    if (!isIndex(receipt.observedTrashIndex)) return "observedTrashIndex";
  }
  if (receipt.state === RECEIPT_STATE.RESTORING) {
    if (!isId(receipt.restoreTargetParentId)) return "restoreTargetParentId";
    if (!isIndex(receipt.restoreTargetIndex)) return "restoreTargetIndex";
    // Otherwise an interrupted restore reads as finished while the node has not
    // moved at all, and the receipt becomes compactable history.
    if (
      receipt.restoreTargetParentId === receipt.observedTrashParentId &&
      receipt.restoreTargetIndex === receipt.observedTrashIndex
    ) {
      return "restore-target-is-trash-position";
    }
  }
  if (
    receipt.deleteSnapshotDigest !== null &&
    !isBoundedText(receipt.deleteSnapshotDigest)
  ) {
    return "deleteSnapshotDigest";
  }
  // The only irreversible state, so the backup it was authorised against has to
  // be part of the record rather than something the UI remembered.
  const deleteState =
    receipt.state === RECEIPT_STATE.DELETING ||
    receipt.state === RECEIPT_STATE.DELETED;
  if (deleteState && !isId(receipt.deleteSnapshotDigest)) {
    return "deleteSnapshotDigest";
  }
  if (
    receipt.detail !== null &&
    (typeof receipt.detail !== "string" ||
      receipt.detail.length > MAX_TRASH_DETAIL_CHARS)
  ) {
    return "detail";
  }
  return null;
}

/**
 * Validates a ledger read back from storage.
 *
 * A wrong `kind` or an unknown `version` rejects the whole document without
 * rewriting it, so a newer build's data is preserved for migration rather than
 * overwritten. Individual bad receipts are quarantined instead.
 *
 * Quarantine poisons a bookmark id: while a receipt for that node cannot be
 * read, a surviving one must not be allowed to move the node to some older
 * origin. Poisoning is scoped to active receipts and is clearable by forgetting
 * the receipts, so a visible bookmark never becomes permanently unrecoverable.
 */
export function readLedger(raw) {
  const empty = {
    ledger: createLedger(),
    quarantined: [],
    poisonedBookmarkIds: new Set(),
    rejected: null,
  };
  if (raw === null || raw === undefined) return empty;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ...empty, rejected: "not-an-object" };
  }
  if (raw.kind !== LEDGER_KIND) return { ...empty, rejected: "kind" };
  if (raw.version !== TRASH_LEDGER_VERSION) {
    return { ...empty, rejected: "version" };
  }
  if (!Array.isArray(raw.receipts)) return { ...empty, rejected: "receipts" };
  if (raw.receipts.length > MAX_TRASH_RECEIPTS) {
    return { ...empty, rejected: "too-many-receipts" };
  }

  const healthy = [];
  const quarantined = [];
  const poisonedBookmarkIds = new Set();
  const seenReceiptIds = new Set();

  for (const receipt of raw.receipts) {
    const reason = receiptShapeError(receipt);
    const duplicate =
      reason === null && seenReceiptIds.has(receipt.receiptId)
        ? "duplicate-receiptId"
        : null;
    if (reason !== null || duplicate !== null) {
      quarantined.push({ reason: reason ?? duplicate, receipt });
      // Protect the node unless the unreadable receipt is explicitly finished
      // business. A state this build does not recognise cannot be ruled out as
      // still describing something in the Trash folder.
      const state = receipt?.state;
      const couldBeActive =
        typeof state !== "string" || !SETTLED_STATES.has(state);
      if (isId(receipt?.bookmarkId) && couldBeActive) {
        poisonedBookmarkIds.add(receipt.bookmarkId);
      }
      continue;
    }
    seenReceiptIds.add(receipt.receiptId);
    healthy.push(receipt);
  }

  const activeCounts = new Map();
  for (const receipt of healthy) {
    if (!isActiveState(receipt.state)) continue;
    activeCounts.set(
      receipt.bookmarkId,
      (activeCounts.get(receipt.bookmarkId) ?? 0) + 1,
    );
  }
  for (const [bookmarkId, count] of activeCounts) {
    if (count > 1) poisonedBookmarkIds.add(bookmarkId);
  }

  return {
    ledger: {
      version: TRASH_LEDGER_VERSION,
      kind: LEDGER_KIND,
      receipts: healthy,
    },
    quarantined,
    poisonedBookmarkIds,
    rejected: null,
  };
}

export function serializedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export const CAPACITY = {
  OK: "ok",
  TOO_MANY_RECEIPTS: "too-many-receipts",
  TOO_LARGE: "too-large",
};

/**
 * A receipt still carries empty slots when capacity is checked, because the
 * check runs before the move that fills them. Measuring the pending shape would
 * understate the ledger the caller is about to end up with, so this fills every
 * slot with the largest value it can legally reach — including a detail of
 * multi-byte characters, which serialize to more than the ASCII of the same
 * length.
 */
function settledSize(receipt) {
  return {
    ...receipt,
    state: RECEIPT_STATE.RESTORING,
    observedTrashParentId: receipt.trashParentId,
    observedTrashIndex: Number.MAX_SAFE_INTEGER,
    originalParentFingerprintAfter: "f".repeat(32),
    restoreTargetParentId: receipt.originalParentId,
    restoreTargetIndex: Number.MAX_SAFE_INTEGER,
    deleteSnapshotDigest: "f".repeat(64),
    detail: "\u3042".repeat(MAX_TRASH_DETAIL_CHARS),
  };
}

/**
 * Runs before the move, and only ever refuses. Compacting here instead would
 * mean a failed trash operation had already destroyed existing recovery data.
 */
export function capacityVerdict(ledger, additions = []) {
  if (ledger.receipts.length + additions.length > MAX_TRASH_RECEIPTS) {
    return {
      verdict: CAPACITY.TOO_MANY_RECEIPTS,
      limit: MAX_TRASH_RECEIPTS,
      count: ledger.receipts.length + additions.length,
    };
  }
  const projected = {
    ...ledger,
    receipts: [...ledger.receipts, ...additions.map(settledSize)],
  };
  const bytes = serializedBytes(projected);
  if (bytes > MAX_TRASH_LEDGER_BYTES) {
    return {
      verdict: CAPACITY.TOO_LARGE,
      limitBytes: MAX_TRASH_LEDGER_BYTES,
      sizeBytes: bytes,
    };
  }
  return { verdict: CAPACITY.OK, sizeBytes: bytes };
}
