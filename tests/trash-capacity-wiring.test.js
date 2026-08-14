import assert from "node:assert/strict";
import test from "node:test";

import { runTrash } from "../extension/ui/execution-controller.js";
import {
  createLedger,
  createReceipt,
} from "../extension/src/core/trash-ledger.js";

/**
 * `capacityVerdict` is pure, so its unit tests only prove the arithmetic. This
 * file covers the other half of the contract: that `runTrash` consults it
 * *before* it writes, and that a refused batch touches neither the bookmarks
 * API nor extension storage. Every mutating entry point throws here, so any
 * write at all fails the test rather than being asserted after the fact.
 */
function installBrowser(tree) {
  const calls = [];
  const forbid = (name) =>
    function forbidden(...args) {
      calls.push({ name, args });
      throw new Error(`${name} must not run when capacity refuses the batch`);
    };

  globalThis.chrome = {
    bookmarks: {
      async getTree() {
        return structuredClone(tree);
      },
      async get(id) {
        return [{ id }];
      },
      move: forbid("bookmarks.move"),
      create: forbid("bookmarks.create"),
      remove: forbid("bookmarks.remove"),
      onMoved: { addListener() {}, removeListener() {} },
      onCreated: { addListener() {}, removeListener() {} },
      onRemoved: { addListener() {}, removeListener() {} },
      onChanged: { addListener() {}, removeListener() {} },
      onChildrenReordered: { addListener() {}, removeListener() {} },
      onImportBegan: { addListener() {}, removeListener() {} },
    },
    storage: {
      local: {
        async get() {
          return {};
        },
        set: forbid("storage.local.set"),
        remove: forbid("storage.local.remove"),
      },
    },
  };
  return calls;
}

const TREE = [
  {
    id: "0",
    title: "",
    children: [
      {
        id: "1",
        parentId: "0",
        index: 0,
        title: "Bookmarks bar",
        syncing: false,
        children: [
          {
            id: "10",
            parentId: "1",
            title: "Keep me",
            url: "https://example.test/keep",
            dateAdded: 1_600_000_000_000,
            index: 0,
            syncing: false,
          },
          {
            id: "11",
            parentId: "1",
            title: "Trash",
            syncing: false,
            index: 1,
            children: [],
          },
        ],
      },
    ],
  },
];

const fullLedger = () => ({
  ...createLedger(),
  receipts: Array.from({ length: 500 }, (_, sequence) =>
    createReceipt({
      batchId: "old",
      sequence,
      batchSize: 500,
      trashedAt: 1_700_000_000_000,
      retentionMs: 86_400_000,
      trashParentId: "11",
      item: {
        bookmarkId: `old-${sequence}`,
        title: "t",
        url: "https://example.test/old",
        dateAdded: 1_600_000_000_000,
        originalParentId: "1",
        originalAncestorIds: ["0", "1"],
        originalParentPath: ["Bookmarks bar"],
        originalIndex: sequence,
        boundaryKey: "local",
      },
    }),
  ),
});

test("runTrash refuses a full ledger without writing anything", async (t) => {
  const previousChrome = globalThis.chrome;
  const calls = installBrowser(TREE);
  t.after(() => {
    globalThis.chrome = previousChrome;
  });

  const ledger = fullLedger();
  const before = structuredClone(ledger);

  const result = await runTrash({
    ledger,
    quarantined: [],
    expect: undefined,
    bookmarkIds: ["10"],
    trashFolderId: "11",
    batchId: "new",
    trashedAt: 1_700_000_100_000,
    retentionMs: 86_400_000,
    onProgress: () => {},
  });

  assert.equal(result.aborted?.key, "trash.abort.capacity");
  assert.equal(result.aborted?.params?.verdict, "too-many-receipts");
  assert.equal(result.aborted?.params?.count, 501);
  assert.equal(result.aborted?.params?.limit, 500);
  assert.deepEqual(calls, [], "no browser write was attempted");
  assert.deepEqual(structuredClone(result.ledger), before);
});

test("runTrash stops on a missing node before it looks at capacity", async (t) => {
  const previousChrome = globalThis.chrome;
  const calls = installBrowser(TREE);
  t.after(() => {
    globalThis.chrome = previousChrome;
  });

  const result = await runTrash({
    ledger: createLedger(),
    quarantined: [],
    expect: undefined,
    bookmarkIds: ["does-not-exist"],
    trashFolderId: "11",
    batchId: "new",
    trashedAt: 1_700_000_100_000,
    retentionMs: 86_400_000,
    onProgress: () => {},
  });

  assert.equal(result.aborted?.key, "trash.abort.nodeGone");
  assert.deepEqual(calls, []);
});
