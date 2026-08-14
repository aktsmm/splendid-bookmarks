import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPACITY,
  capacityVerdict,
  createLedger,
  createReceipt,
} from "../extension/src/core/trash-ledger.js";
import {
  MAX_BATCH_OPERATIONS,
  MAX_TRASH_DETAIL_CHARS,
  MAX_TRASH_FIELD_CHARS,
  MAX_TRASH_LEDGER_BYTES,
  MAX_TRASH_RECEIPTS,
} from "../extension/src/core/limits.js";

/**
 * The limits are pinned as literals, not as `MAX_* ± 1`. A test that only reads
 * the constant back moves with it, so raising the cap silently would still pass.
 */
test("the ledger caps are the numbers the docs and privacy policy promise", () => {
  assert.equal(MAX_TRASH_RECEIPTS, 500);
  assert.equal(MAX_TRASH_LEDGER_BYTES, 1048576);
  assert.equal(MAX_TRASH_FIELD_CHARS, 2048);
  assert.equal(MAX_TRASH_DETAIL_CHARS, 200);
  // run-scale.mjs sends a batch of 200 and calls it "a batch at the cap".
  assert.equal(MAX_BATCH_OPERATIONS, 200);
});

const receiptAt = (sequence, { title = "t", url = "https://e.test/" } = {}) =>
  createReceipt({
    batchId: "batch",
    sequence,
    batchSize: 1,
    trashedAt: 1_700_000_000_000,
    retentionMs: 86_400_000,
    trashParentId: "trash",
    item: {
      bookmarkId: `b${sequence}`,
      title,
      url,
      dateAdded: 1_600_000_000_000,
      originalParentId: "home",
      originalAncestorIds: ["0", "home"],
      originalParentPath: ["Home"],
      originalIndex: sequence,
      boundaryKey: "local",
    },
  });

const ledgerWith = (count, options) => ({
  ...createLedger(),
  receipts: Array.from({ length: count }, (_, index) =>
    receiptAt(index, options),
  ),
});

/**
 * The real condition is `existing + additions > MAX`, so a fixture that only
 * varies the stored count cannot tell an off-by-one in the sum from one in the
 * comparison. Each row states both halves.
 */
const COUNT_CASES = [
  { existing: 498, additions: 1, refused: false },
  { existing: 499, additions: 1, refused: false },
  { existing: 500, additions: 1, refused: true, count: 501 },
  { existing: 499, additions: 2, refused: true, count: 501 },
  { existing: 0, additions: 501, refused: true, count: 501 },
  { existing: 0, additions: 500, refused: false },
];

test("the receipt count gate refuses exactly the batches that overrun 500", () => {
  for (const row of COUNT_CASES) {
    const ledger = ledgerWith(row.existing);
    const additions = Array.from({ length: row.additions }, (_, index) =>
      receiptAt(row.existing + index),
    );
    const verdict = capacityVerdict(ledger, additions);
    if (row.refused) {
      assert.deepEqual(
        verdict,
        { verdict: CAPACITY.TOO_MANY_RECEIPTS, limit: 500, count: row.count },
        JSON.stringify(row),
      );
    } else {
      assert.equal(verdict.verdict, CAPACITY.OK, JSON.stringify(row));
    }
  }
});

test("a refused batch leaves the ledger and the additions untouched", () => {
  const ledger = ledgerWith(500);
  const additions = [receiptAt(500)];
  const ledgerBefore = structuredClone(ledger);
  const additionsBefore = structuredClone(additions);

  const verdict = capacityVerdict(ledger, additions);

  assert.equal(verdict.verdict, CAPACITY.TOO_MANY_RECEIPTS);
  assert.deepEqual(ledger, ledgerBefore);
  assert.deepEqual(additions, additionsBefore);
});

/**
 * Independent oracle for the projected ledger. It restates the settled shape as
 * literals instead of calling the production helper, so measuring the ledger
 * with `serializedBytes` on both sides cannot make the assertion circular.
 */
function projectedBytes(ledger, additions) {
  const settled = additions.map((receipt) => ({
    ...receipt,
    state: "restoring",
    observedTrashParentId: receipt.trashParentId,
    observedTrashIndex: 9007199254740991,
    originalParentFingerprintAfter: "f".repeat(32),
    restoreTargetParentId: receipt.originalParentId,
    restoreTargetIndex: 9007199254740991,
    deleteSnapshotDigest: "f".repeat(64),
    detail: "\u3042".repeat(200),
  }));
  const projected = { ...ledger, receipts: [...ledger.receipts, ...settled] };
  return Buffer.byteLength(JSON.stringify(projected), "utf8");
}

test("the byte budget measures the settled ledger, not the pending one", () => {
  const ledger = ledgerWith(1);
  const additions = [receiptAt(1)];

  const verdict = capacityVerdict(ledger, additions);
  const oracle = projectedBytes(ledger, additions);

  assert.equal(verdict.verdict, CAPACITY.OK);
  assert.equal(verdict.sizeBytes, oracle);
  // A pending receipt has empty slots, so the settled projection has to be
  // larger; equality here would mean the reservation was dropped.
  assert.ok(
    oracle >
      Buffer.byteLength(
        JSON.stringify({
          ...ledger,
          receipts: [...ledger.receipts, ...additions],
        }),
        "utf8",
      ),
  );
});

test("a batch whose settled ledger would exceed 1 MiB is refused", () => {
  const wide = {
    title: "t".repeat(MAX_TRASH_FIELD_CHARS),
    url: `https://e.test/${"u".repeat(MAX_TRASH_FIELD_CHARS - 16)}`,
  };
  const ledger = createLedger();
  const additions = Array.from({ length: 250 }, (_, index) =>
    receiptAt(index, wide),
  );

  const oracle = projectedBytes(ledger, additions);
  assert.ok(oracle > 1048576, `oracle measured ${oracle} bytes`);
  assert.ok(additions.length < 500, "the count gate must not be what refuses");

  assert.deepEqual(capacityVerdict(ledger, additions), {
    verdict: CAPACITY.TOO_LARGE,
    limitBytes: 1048576,
    sizeBytes: oracle,
  });
});

test("a batch that fits under 1 MiB is allowed at the same receipt width", () => {
  const wide = {
    title: "t".repeat(MAX_TRASH_FIELD_CHARS),
    url: `https://e.test/${"u".repeat(MAX_TRASH_FIELD_CHARS - 16)}`,
  };
  const ledger = createLedger();
  const additions = Array.from({ length: 100 }, (_, index) =>
    receiptAt(index, wide),
  );

  const oracle = projectedBytes(ledger, additions);
  assert.ok(oracle <= 1048576, `oracle measured ${oracle} bytes`);
  assert.deepEqual(capacityVerdict(ledger, additions), {
    verdict: CAPACITY.OK,
    sizeBytes: oracle,
  });
});
