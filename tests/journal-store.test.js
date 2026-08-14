import assert from "node:assert/strict";
import test from "node:test";

import {
  clearTrashLedger,
  loadTrashLedgerRecord,
  saveTrashLedger,
} from "../extension/src/adapters/journal-store.js";

/**
 * Extension storage does not hand back the object that was written: what comes
 * out has its keys sorted. A pilot run caught a compare-and-set that compared
 * raw JSON and therefore refused every write after the first, so the fake below
 * reproduces that reordering rather than acting as a transparent map.
 */
const sortKeys = (value) =>
  JSON.parse(
    JSON.stringify(value, (_key, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
    ),
  );

function installFakeStorage() {
  const bag = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          return key in bag ? { [key]: bag[key] } : {};
        },
        async set(entry) {
          for (const [key, value] of Object.entries(entry)) {
            bag[key] = sortKeys(value);
          }
        },
        async remove(key) {
          delete bag[key];
        },
      },
    },
  };
  return bag;
}

const ledger = (receipts) => ({
  version: 1,
  kind: "trash-ledger",
  receipts,
});

// Insertion order here is deliberately not alphabetical.
const receipt = (state) => ({
  receiptId: "b:0",
  batchId: "b",
  sequence: 0,
  batchSize: 1,
  bookmarkId: "100",
  state,
});

test("an absent ledger reads as null so a first write can bind to it", async () => {
  installFakeStorage();
  assert.equal(await loadTrashLedgerRecord(), null);
  await saveTrashLedger(ledger([]), { expect: null });
  assert.deepEqual((await loadTrashLedgerRecord()).receipts, []);
});

test("a write is not refused because storage reordered the keys", async () => {
  installFakeStorage();
  const first = ledger([receipt("pending")]);
  await saveTrashLedger(first, { expect: null });

  // The caller still holds its own insertion-ordered copy; storage holds the
  // sorted one. Comparing them literally is what broke the second write.
  const second = ledger([receipt("trashed")]);
  await saveTrashLedger(second, { expect: first });
  assert.equal((await loadTrashLedgerRecord()).receipts[0].state, "trashed");
});

test("a write is refused when the stored ledger moved on", async () => {
  installFakeStorage();
  const first = ledger([receipt("pending")]);
  await saveTrashLedger(first, { expect: null });
  await saveTrashLedger(ledger([receipt("trashed")]), { expect: first });

  await assert.rejects(
    () => saveTrashLedger(ledger([]), { expect: first }),
    (error) => error.key === "error.trashLedgerConflict",
  );
});

test("a write without a baseline is unconditional", async () => {
  installFakeStorage();
  await saveTrashLedger(ledger([receipt("pending")]), { expect: null });
  await saveTrashLedger(ledger([]));
  assert.deepEqual((await loadTrashLedgerRecord()).receipts, []);
});

test("clearing removes the document rather than storing an empty one", async () => {
  installFakeStorage();
  await saveTrashLedger(ledger([]), { expect: null });
  await clearTrashLedger();
  assert.equal(await loadTrashLedgerRecord(), null);
});
