import assert from "node:assert/strict";
import test from "node:test";

import {
  RESTORE,
  ancestorIdsOf,
  authorizeBatchRestore,
  authorizeRestore,
} from "../extension/src/core/restore-authorize.js";
import {
  RECEIPT_STATE,
  createLedger,
  fingerprintChildIds,
} from "../extension/src/core/trash-ledger.js";
import { flattenTree, indexById } from "../extension/src/core/tree-model.js";
import { buildTree, sampleReceipt } from "./fixtures/trash-tree.js";

function context(options) {
  const entries = flattenTree(buildTree(options));
  return {
    entries,
    byId: indexById(entries),
    poisonedBookmarkIds: new Set(),
  };
}

/** Alpha sits in Trash; Bravo and Charlie are still in Work. */
const trashedAlpha = () => context({ work: ["101", "102"], trash: ["100"] });

test("a trashed node is authorized back into its original folder, appended", () => {
  const row = authorizeRestore(sampleReceipt(), trashedAlpha());
  assert.equal(row.verdict, RESTORE.APPROXIMATE);
  assert.equal(row.targetParentId, "10");
  // Work holds Bravo and Charlie, so the free slot is 2. The recorded index 0
  // is deliberately not reused: siblings changed and order is not reproducible.
  assert.equal(row.targetIndex, 2);
});

test("a node whose identity drifted is refused", () => {
  const ctx = trashedAlpha();
  assert.equal(
    authorizeRestore(sampleReceipt({ title: "Renamed" }), ctx).verdict,
    RESTORE.IDENTITY_MISMATCH,
  );
  assert.equal(
    authorizeRestore(sampleReceipt({ dateAdded: 1 }), ctx).verdict,
    RESTORE.IDENTITY_MISMATCH,
  );
  assert.equal(
    authorizeRestore(sampleReceipt({ url: "https://example.com/edited" }), ctx)
      .verdict,
    RESTORE.IDENTITY_MISMATCH,
  );
});

test("a folder is out of scope for v1 even if a receipt names one", () => {
  const ctx = trashedAlpha();
  const row = authorizeRestore(
    sampleReceipt({
      bookmarkId: "30",
      title: "Nest",
      url: "https://example.com/a",
      dateAdded: null,
    }),
    ctx,
  );
  assert.equal(row.verdict, RESTORE.NODE_NOT_BOOKMARK);
});

test("a node that left the Trash folder is refused instead of moved again", () => {
  // Back in Work: something else already decided where it belongs.
  assert.equal(
    authorizeRestore(
      sampleReceipt(),
      context({ work: ["100", "101", "102"], trash: [] }),
    ).verdict,
    RESTORE.MOVED_SINCE_TRASH,
  );
  // Somewhere else entirely, which a check against the origin alone would miss.
  assert.equal(
    authorizeRestore(
      sampleReceipt(),
      context({ work: ["101", "102"], trash: [], nest: ["100"] }),
    ).verdict,
    RESTORE.MOVED_SINCE_TRASH,
  );
});

test("a node that no longer exists is reported, never re-created", () => {
  const ctx = trashedAlpha();
  assert.equal(
    authorizeRestore(sampleReceipt({ bookmarkId: "999" }), ctx).verdict,
    RESTORE.NODE_MISSING,
  );
});

test("a destination folder that moved is refused on the id chain, not the title path", () => {
  // Work now lives inside Nest. Its id and its title path segments still look
  // familiar; only the ancestor chain shows it is somewhere else.
  const ctx = context({ workIn: "30", work: ["101", "102"], trash: ["100"] });
  assert.deepEqual(ancestorIdsOf(ctx.byId.get("10"), ctx.byId), ["1", "30"]);
  assert.equal(
    authorizeRestore(sampleReceipt(), ctx).verdict,
    RESTORE.DESTINATION_MOVED,
  );
});

test("a missing destination folder is refused", () => {
  const ctx = trashedAlpha();
  assert.equal(
    authorizeRestore(sampleReceipt({ originalParentId: "404" }), ctx).verdict,
    RESTORE.DESTINATION_NOT_FOUND,
  );
});

test("restoring across the account and local boundary is refused", () => {
  const ctx = trashedAlpha();
  const row = authorizeRestore(
    sampleReceipt({ originalParentId: "300", originalAncestorIds: ["3"] }),
    ctx,
  );
  assert.equal(row.verdict, RESTORE.BOUNDARY_VIOLATION);
});

test("a poisoned bookmark is not restorable until the receipts are resolved", () => {
  const ctx = { ...trashedAlpha(), poisonedBookmarkIds: new Set(["100"]) };
  assert.equal(
    authorizeRestore(sampleReceipt(), ctx).verdict,
    RESTORE.POISONED,
  );
});

test("only a trashed receipt is a restore candidate", () => {
  const ctx = trashedAlpha();
  for (const state of [
    RECEIPT_STATE.PENDING,
    RECEIPT_STATE.RESTORING,
    RECEIPT_STATE.RESTORED,
    RECEIPT_STATE.ORPHANED,
    RECEIPT_STATE.FAILED,
  ]) {
    assert.equal(
      authorizeRestore(sampleReceipt({ state }), ctx).verdict,
      RESTORE.NOT_RESTORABLE,
      state,
    );
  }
});

/**
 * Alpha and Bravo were trashed in that order, so each receipt recorded the
 * index its own node held at the moment it moved: both 0, because removing
 * Alpha shifted Bravo up. Work was left holding Charlie alone.
 */
function trashedPair(options = {}) {
  const ctx = context({ work: ["102"], trash: ["100", "101"], ...options });
  const ledger = {
    ...createLedger(),
    receipts: [
      sampleReceipt({
        receiptId: "batch-1:0",
        sequence: 0,
        batchSize: 2,
        bookmarkId: "100",
        title: "Alpha",
        url: "https://example.com/a",
        dateAdded: 1000,
        originalIndex: 0,
        observedTrashIndex: 0,
        originalParentFingerprintAfter: fingerprintChildIds(["101", "102"]),
      }),
      sampleReceipt({
        receiptId: "batch-1:1",
        sequence: 1,
        batchSize: 2,
        bookmarkId: "101",
        title: "Bravo",
        url: "https://example.com/b",
        dateAdded: 2000,
        originalIndex: 0,
        observedTrashIndex: 1,
        // What Work looked like once this batch was done with it.
        originalParentFingerprintAfter: fingerprintChildIds(["102"]),
      }),
    ],
  };
  return { ledger, ctx };
}

test("an intact batch restores in reverse sequence at the recorded indices", () => {
  const { ledger, ctx } = trashedPair();
  const plan = authorizeBatchRestore(ledger, "batch-1", ctx);

  assert.equal(plan.verdict, RESTORE.EXACT);
  assert.deepEqual(plan.steps, [
    {
      receiptId: "batch-1:1",
      bookmarkId: "101",
      targetParentId: "10",
      targetIndex: 0,
    },
    {
      receiptId: "batch-1:0",
      bookmarkId: "100",
      targetParentId: "10",
      targetIndex: 0,
    },
  ]);
});

test("a batch with any blocked member is not offered as exact", () => {
  const { ledger, ctx } = trashedPair();
  const mixed = {
    ...ledger,
    receipts: [
      ledger.receipts[0],
      { ...ledger.receipts[1], state: RECEIPT_STATE.RESTORED },
    ],
  };
  const plan = authorizeBatchRestore(mixed, "batch-1", ctx);

  assert.equal(plan.verdict, RESTORE.NOT_RESTORABLE);
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(
    plan.blocked.map((row) => row.verdict),
    [RESTORE.NOT_RESTORABLE],
  );
});

test("a batch missing a member is not offered as exact", () => {
  const { ledger, ctx } = trashedPair();
  // Quarantine or an explicit forget can leave a partial set that would
  // otherwise authorize cleanly.
  const partial = { ...ledger, receipts: [ledger.receipts[1]] };
  assert.equal(
    authorizeBatchRestore(partial, "batch-1", ctx).verdict,
    RESTORE.BATCH_INCOMPLETE,
  );
});

test("a destination folder edited since the batch is not offered as exact", () => {
  // Every member is still authorized; only the folder's own shape changed, so
  // the recorded indices would no longer reconstruct the original order.
  const { ledger, ctx } = trashedPair();
  const changed = {
    ...ledger,
    receipts: [
      ledger.receipts[0],
      {
        ...ledger.receipts[1],
        originalParentFingerprintAfter: fingerprintChildIds(["102", "999"]),
      },
    ],
  };
  assert.equal(
    authorizeBatchRestore(changed, "batch-1", ctx).verdict,
    RESTORE.DESTINATION_CHANGED,
  );
});

test("an unknown batch yields no steps", () => {
  const { ledger, ctx } = trashedPair();
  assert.equal(
    authorizeBatchRestore(ledger, "batch-none", ctx).verdict,
    RESTORE.NOT_RESTORABLE,
  );
});
