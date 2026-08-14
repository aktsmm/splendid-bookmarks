import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_TRASH_RECEIPTS,
  MAX_TRASH_DETAIL_CHARS,
  DEFAULT_TRASH_RETENTION_MS,
} from "../extension/src/core/limits.js";
import {
  CAPACITY,
  INTERRUPTED,
  RECEIPT_STATE,
  TRASH_LEDGER_VERSION,
  appendReceipt,
  capacityVerdict,
  classifyInterrupted,
  compactableReceiptIds,
  createLedger,
  createReceipt,
  fingerprintChildIds,
  isExpired,
  markRestored,
  markRestoring,
  markFailed,
  markTrashed,
  readLedger,
  receiptShapeError,
  removeReceipts,
  serializedBytes,
  withQuarantined,
} from "../extension/src/core/trash-ledger.js";
import { sampleReceipt } from "./fixtures/trash-tree.js";

const TRASHED_AT = 1_700_000_000_000;

const newReceipt = (overrides = {}) =>
  createReceipt({
    batchId: "batch-1",
    sequence: 0,
    batchSize: 1,
    trashedAt: TRASHED_AT,
    trashParentId: "20",
    item: {
      bookmarkId: "100",
      title: "Alpha",
      url: "https://example.com/a",
      dateAdded: 1000,
      originalParentId: "10",
      originalAncestorIds: ["1"],
      originalParentPath: ["Bar", "Work"],
      originalIndex: 0,
      boundaryKey: "syncing:true",
    },
    ...overrides,
  });

test("a new receipt is pending and carries an advisory retention", () => {
  const receipt = newReceipt();
  assert.equal(receipt.state, RECEIPT_STATE.PENDING);
  assert.equal(receipt.retentionUntil, TRASHED_AT + DEFAULT_TRASH_RETENTION_MS);
  assert.equal(receipt.observedTrashParentId, null);
});

test("the default retention is 30 days", () => {
  assert.equal(DEFAULT_TRASH_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
});

test("the observed trash position is recorded only after the move", () => {
  const before = newReceipt();
  const ledger = markTrashed(
    appendReceipt(createLedger(), before),
    before.receiptId,
    {
      parentId: "20",
      index: 3,
    },
    { originalParentFingerprint: "abc12345" },
  );
  const [after] = ledger.receipts;
  assert.equal(after.state, RECEIPT_STATE.TRASHED);
  assert.equal(after.observedTrashParentId, "20");
  assert.equal(after.observedTrashIndex, 3);
  assert.equal(after.originalParentFingerprintAfter, "abc12345");
});

test("the folder fingerprint reacts to order, insertion and removal", () => {
  const base = fingerprintChildIds(["a", "b", "c"]);
  assert.notEqual(base, fingerprintChildIds(["a", "c", "b"]));
  assert.notEqual(base, fingerprintChildIds(["a", "b", "c", "d"]));
  assert.notEqual(base, fingerprintChildIds(["a", "b"]));
  assert.equal(base, fingerprintChildIds(["a", "b", "c"]));
  assert.equal(fingerprintChildIds([]), fingerprintChildIds([]));
});

test("the fingerprint encoding cannot be confused by ids containing separators", () => {
  // A delimiter-joined encoding maps both of these to the same string.
  assert.notEqual(
    fingerprintChildIds(["a\u0000", "b"]),
    fingerprintChildIds(["a", "\u0000b"]),
  );
  assert.notEqual(
    fingerprintChildIds(["1:2", "3"]),
    fingerprintChildIds(["1", "2:3"]),
  );
});

test("an interrupted trash move is classified from the live node alone", () => {
  const receipt = newReceipt();
  assert.equal(
    classifyInterrupted(receipt, { parentId: "10", index: 0 }),
    INTERRUPTED.DISCARD,
  );
  assert.equal(
    classifyInterrupted(receipt, { parentId: "20", index: 5 }),
    INTERRUPTED.TRASHED,
  );
  assert.equal(classifyInterrupted(receipt, null), INTERRUPTED.FAILED);
  assert.equal(
    classifyInterrupted(receipt, { parentId: "99", index: 0 }),
    INTERRUPTED.FAILED,
  );
});

test("an interrupted restore is classified against both recorded positions", () => {
  const base = sampleReceipt({
    observedTrashParentId: "20",
    observedTrashIndex: 9,
  });
  const ledger = markRestoring(
    appendReceipt(createLedger(), base),
    base.receiptId,
    {
      // Refreshed at authorization time: the Trash folder may have been
      // reordered since the item landed there.
      observed: { parentId: "20", index: 2 },
      target: { parentId: "10", index: 1 },
    },
  );
  const [receipt] = ledger.receipts;
  assert.equal(receipt.observedTrashIndex, 2);

  assert.equal(
    classifyInterrupted(receipt, { parentId: "10", index: 1 }),
    INTERRUPTED.RESTORED,
  );
  assert.equal(
    classifyInterrupted(receipt, { parentId: "20", index: 2 }),
    INTERRUPTED.TRASHED,
  );
  assert.equal(
    classifyInterrupted(receipt, { parentId: "10", index: 7 }),
    INTERRUPTED.FAILED,
  );
  // A node that vanished mid-restore is a failure, not a silent success.
  assert.equal(classifyInterrupted(receipt, null), INTERRUPTED.FAILED);
});

test("a settled receipt is not treated as interrupted", () => {
  assert.equal(
    classifyInterrupted(sampleReceipt(), { parentId: "20", index: 0 }),
    null,
  );
});

test("a trashed receipt must carry where it was observed", () => {
  assert.equal(receiptShapeError(sampleReceipt()), null);
  assert.equal(
    receiptShapeError(sampleReceipt({ observedTrashParentId: null })),
    "observedTrashParentId",
  );
  assert.equal(
    receiptShapeError(sampleReceipt({ state: RECEIPT_STATE.RESTORING })),
    "restoreTargetParentId",
  );
  assert.equal(
    receiptShapeError(sampleReceipt({ retentionUntil: TRASHED_AT - 1 })),
    "retentionUntil",
  );
  assert.equal(
    receiptShapeError(sampleReceipt({ originalIndex: -1 })),
    "originalIndex",
  );
  assert.equal(
    receiptShapeError(sampleReceipt({ originalAncestorIds: ["1", 2] })),
    "originalAncestorIds",
  );
});

test("a receipt without a URL is not a bookmark receipt", () => {
  assert.equal(receiptShapeError(sampleReceipt({ url: null })), "url");
});

test("a receipt must place itself inside a known batch", () => {
  assert.equal(receiptShapeError(sampleReceipt({ batchSize: 0 })), "batchSize");
  assert.equal(
    receiptShapeError(sampleReceipt({ sequence: 3, batchSize: 2 })),
    "sequence-out-of-batch",
  );
});

test("a receipt whose trash folder is its own origin is rejected", () => {
  // Such a move is the no-op the dry run refuses, and it would make every
  // interrupted move impossible to classify.
  assert.equal(
    receiptShapeError(sampleReceipt({ trashParentId: "10" })),
    "trash-parent-is-origin",
  );
});

test("a restoring receipt aimed at its own trash position is rejected", () => {
  // Otherwise an untouched node reads as restored, and the receipt becomes
  // compactable history while the recovery information is still needed.
  assert.equal(
    receiptShapeError(
      sampleReceipt({
        state: RECEIPT_STATE.RESTORING,
        observedTrashParentId: "20",
        observedTrashIndex: 4,
        restoreTargetParentId: "20",
        restoreTargetIndex: 4,
      }),
    ),
    "restore-target-is-trash-position",
  );
});

test("the failure detail is bounded so capacity can reserve it", () => {
  assert.equal(
    receiptShapeError(sampleReceipt({ detail: "x".repeat(5000) })),
    "detail",
  );
  const ledger = markFailed(
    appendReceipt(createLedger(), sampleReceipt()),
    "batch-1:0",
    "y".repeat(5000),
  );
  const [receipt] = ledger.receipts;
  assert.equal(receipt.detail.length, MAX_TRASH_DETAIL_CHARS);
  assert.equal(receiptShapeError(receipt), null);
});

test("an absent ledger reads as empty rather than as damage", () => {
  const result = readLedger(null);
  assert.equal(result.rejected, null);
  assert.deepEqual(result.ledger.receipts, []);
});

test("a foreign or newer document is rejected without being adopted", () => {
  assert.equal(readLedger({ kind: "apply-journal" }).rejected, "kind");
  const newer = readLedger({
    kind: "trash-ledger",
    version: TRASH_LEDGER_VERSION + 1,
    receipts: [sampleReceipt()],
  });
  assert.equal(newer.rejected, "version");
  assert.deepEqual(newer.ledger.receipts, []);
});

test("one damaged receipt is quarantined and the rest stay restorable", () => {
  const healthy = sampleReceipt({ receiptId: "b:1", bookmarkId: "101" });
  const damaged = sampleReceipt({
    receiptId: "b:2",
    bookmarkId: "102",
    originalIndex: -5,
  });
  const result = readLedger({
    kind: "trash-ledger",
    version: TRASH_LEDGER_VERSION,
    receipts: [healthy, damaged],
  });

  assert.equal(result.rejected, null);
  assert.deepEqual(
    result.ledger.receipts.map((receipt) => receipt.receiptId),
    ["b:1"],
  );
  assert.equal(result.quarantined.length, 1);
  assert.equal(result.quarantined[0].reason, "originalIndex");
  // The damaged receipt names a node, so that node is protected until resolved.
  assert.ok(result.poisonedBookmarkIds.has("102"));
  assert.ok(!result.poisonedBookmarkIds.has("101"));
});

test("a duplicate receipt id is quarantined rather than silently kept twice", () => {
  const result = readLedger({
    kind: "trash-ledger",
    version: TRASH_LEDGER_VERSION,
    receipts: [sampleReceipt(), sampleReceipt()],
  });
  assert.equal(result.ledger.receipts.length, 1);
  assert.equal(result.quarantined[0].reason, "duplicate-receiptId");
});

test("two active receipts for one bookmark poison it", () => {
  const result = readLedger({
    kind: "trash-ledger",
    version: TRASH_LEDGER_VERSION,
    receipts: [
      sampleReceipt({ receiptId: "b:1" }),
      sampleReceipt({ receiptId: "b:2" }),
    ],
  });
  assert.ok(result.poisonedBookmarkIds.has("100"));
});

test("trashing a bookmark again after restoring it is not a conflict", () => {
  const history = sampleReceipt({
    receiptId: "b:0",
    state: RECEIPT_STATE.RESTORED,
  });
  const current = sampleReceipt({ receiptId: "b:1" });
  const result = readLedger({
    kind: "trash-ledger",
    version: TRASH_LEDGER_VERSION,
    receipts: [history, current],
  });

  assert.equal(result.quarantined.length, 0);
  assert.equal(result.poisonedBookmarkIds.size, 0);
});

test("damaged history does not block the current receipt for the same node", () => {
  const damagedHistory = sampleReceipt({
    receiptId: "b:0",
    state: RECEIPT_STATE.RESTORED,
    originalIndex: -5,
  });
  const current = sampleReceipt({ receiptId: "b:1" });
  const result = readLedger({
    kind: "trash-ledger",
    version: TRASH_LEDGER_VERSION,
    receipts: [damagedHistory, current],
  });

  assert.equal(result.quarantined.length, 1);
  assert.equal(result.poisonedBookmarkIds.size, 0);
});

test("a damaged receipt that could still be describing the Trash folder poisons its node", () => {
  const damagedActive = sampleReceipt({ receiptId: "b:0", originalIndex: -5 });
  const unreadableState = sampleReceipt({
    receiptId: "b:1",
    bookmarkId: "101",
    state: 42,
  });
  const result = readLedger({
    kind: "trash-ledger",
    version: TRASH_LEDGER_VERSION,
    receipts: [damagedActive, unreadableState],
  });

  assert.ok(result.poisonedBookmarkIds.has("100"));
  // An unreadable state cannot be ruled out as active.
  assert.ok(result.poisonedBookmarkIds.has("101"));
});

test("a state this build does not recognise still protects its node", () => {
  const result = readLedger({
    kind: "trash-ledger",
    version: TRASH_LEDGER_VERSION,
    receipts: [sampleReceipt({ state: "trashed-by-a-later-build" })],
  });
  assert.equal(result.quarantined.length, 1);
  assert.ok(result.poisonedBookmarkIds.has("100"));
});

test("compaction never drops a receipt whose node can still be restored", () => {
  const expiredButPresent = sampleReceipt({ receiptId: "b:0" });
  const restoredHistory = sampleReceipt({
    receiptId: "b:1",
    state: RECEIPT_STATE.RESTORED,
  });
  const orphanPresent = sampleReceipt({
    receiptId: "b:2",
    bookmarkId: "101",
    state: RECEIPT_STATE.ORPHANED,
  });
  const orphanGone = sampleReceipt({
    receiptId: "b:3",
    bookmarkId: "999",
    state: RECEIPT_STATE.ORPHANED,
  });
  const ledger = {
    ...createLedger(),
    receipts: [expiredButPresent, restoredHistory, orphanPresent, orphanGone],
  };
  const byId = new Map([
    ["100", {}],
    ["101", {}],
  ]);

  // Past its retention, yet still compaction-exempt: the node is in the Trash folder.
  assert.equal(
    isExpired(expiredButPresent, expiredButPresent.retentionUntil + 1),
    true,
  );
  assert.deepEqual(compactableReceiptIds(ledger, byId), ["b:1", "b:3"]);
});

test("writing back keeps the quarantined receipts that poison a node", () => {
  const stored = {
    kind: "trash-ledger",
    version: TRASH_LEDGER_VERSION,
    receipts: [
      sampleReceipt({ receiptId: "b:0", bookmarkId: "101" }),
      sampleReceipt({ receiptId: "b:1", originalIndex: -5 }),
    ],
  };
  const first = readLedger(stored);
  assert.ok(first.poisonedBookmarkIds.has("100"));

  // Persisting only the working ledger would drop the damaged receipt, and the
  // next read would declare the node restorable again.
  const rewritten = withQuarantined(first.ledger, first.quarantined);
  const second = readLedger(rewritten);
  assert.ok(second.poisonedBookmarkIds.has("100"));
  assert.equal(second.quarantined.length, 1);
  assert.deepEqual(
    readLedger(withQuarantined(first.ledger, [])).poisonedBookmarkIds.size,
    0,
  );
});

test("forgetting a receipt is the escape hatch and ignores state", () => {
  const ledger = {
    ...createLedger(),
    receipts: [
      sampleReceipt({ receiptId: "b:0", state: RECEIPT_STATE.TRASHED }),
      sampleReceipt({ receiptId: "b:1", state: RECEIPT_STATE.PENDING }),
      sampleReceipt({ receiptId: "b:2", state: RECEIPT_STATE.FAILED }),
      sampleReceipt({ receiptId: "b:3", state: RECEIPT_STATE.ORPHANED }),
    ],
  };
  // Compaction cannot free any of these, so this is the only way out of a full
  // ledger. It drops recovery metadata; the bookmarks stay in the Trash folder.
  assert.deepEqual(compactableReceiptIds(ledger, new Map([["100", {}]])), []);
  assert.deepEqual(
    removeReceipts(ledger, ["b:0", "b:1", "b:2", "b:3"]).receipts,
    [],
  );
});

test("capacity refuses a new batch instead of dropping recovery data", () => {
  const full = {
    ...createLedger(),
    receipts: Array.from({ length: MAX_TRASH_RECEIPTS }, (_, i) =>
      sampleReceipt({ receiptId: `b:${i}` }),
    ),
  };
  assert.equal(
    capacityVerdict(full, [newReceipt()]).verdict,
    CAPACITY.TOO_MANY_RECEIPTS,
  );
  assert.equal(
    capacityVerdict(createLedger(), [newReceipt()]).verdict,
    CAPACITY.OK,
  );
});

test("capacity measures what the receipt becomes, not the empty pending shape", () => {
  const addition = newReceipt();
  const reserved = capacityVerdict(createLedger(), [addition]).sizeBytes;

  // Every slot the move and a later failure can fill must already be paid for.
  const settled = markFailed(
    markTrashed(
      appendReceipt(createLedger(), addition),
      addition.receiptId,
      { parentId: "20", index: Number.MAX_SAFE_INTEGER },
      { originalParentFingerprint: fingerprintChildIds(["1", "2", "3"]) },
    ),
    addition.receiptId,
    "\u3042".repeat(MAX_TRASH_DETAIL_CHARS),
  );
  assert.ok(
    reserved >= serializedBytes(settled),
    `preflight reserved ${reserved} but the settled ledger is ${serializedBytes(settled)}`,
  );
});

test("capacity also refuses a ledger that would outgrow its byte budget", () => {
  const fat = {
    ...createLedger(),
    receipts: Array.from({ length: 400 }, (_, i) =>
      sampleReceipt({ receiptId: `b:${i}`, title: "x".repeat(3000) }),
    ),
  };
  assert.equal(capacityVerdict(fat).verdict, CAPACITY.TOO_LARGE);
});

test("marking restored leaves the receipt as history, not as active", () => {
  const base = sampleReceipt();
  const ledger = markRestored(
    appendReceipt(createLedger(), base),
    base.receiptId,
  );
  assert.equal(ledger.receipts[0].state, RECEIPT_STATE.RESTORED);
});
