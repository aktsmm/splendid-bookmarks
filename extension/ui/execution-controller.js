/**
 * Owns the lifecycle of one write batch: the lock, the expected-event ledger,
 * the write-ahead journal, abort handling and resume. The options page keeps
 * event wiring and rendering; nothing here writes to the DOM.
 *
 * Two independent detectors guard the batch. The ledger correlates bookmark
 * events with the moves this page asked for. The projection chain re-reads the
 * tree before every move and compares it with the tree predicted after the
 * previous one, which catches an outside change even when no event identifies
 * it. Neither can prove who issued an event: the API carries no originator, so
 * the guarantee is detect, abort and stay recoverable, not attribution.
 */
import {
  createFolder,
  getLiveTree,
  getNodes,
  moveBookmark,
  removeBookmark,
  updateBookmark,
  watchExternalChanges,
} from "../src/adapters/bookmarks-api.js";
import { withApplyLock } from "../src/adapters/locks.js";
import {
  clearJournal,
  saveJournal,
  saveTrashLedger,
} from "../src/adapters/journal-store.js";
import {
  apiIndexForMove,
  describeTreeDrift,
  projectTreeAfterMove,
  projectTreeAfterRemove,
  projectTreeAfterRetitle,
} from "../src/core/apply-simulation.js";
import { sha256Hex } from "../src/core/digest.js";
import {
  ROLLBACK,
  buildRollbackPlan,
  classifyRollback,
} from "../src/core/reconciliation.js";
import {
  RESUME,
  abortJournal,
  attemptedEntries,
  classifyAttempted,
  markApplied,
  markAttempted,
  markFailed,
  markRolledBack,
  markUpdateAttempted,
} from "../src/core/execution-session.js";
import {
  canonicalTreeString,
  boundaryKey,
  flattenTree,
  indexById,
  isBoundaryIndeterminate,
  isDescendantOf,
  topAncestorOf,
} from "../src/core/tree-model.js";
import { STATUS, evaluateOperation } from "../src/core/validator.js";
import { authorizeRestoreMove } from "../src/core/snapshot-restore.js";
import {
  CAPACITY,
  INTERRUPTED,
  RECEIPT_STATE,
  appendReceipt,
  capacityVerdict,
  classifyInterrupted,
  createReceipt,
  fingerprintChildIds,
  markFailed as markReceiptFailed,
  markRestored,
  markRestoring,
  markDeleted,
  markDeleting,
  markTrashed,
  removeReceipts,
  withQuarantined,
} from "../src/core/trash-ledger.js";
import {
  RESTORE,
  ancestorIdsOf,
  authorizeBatchRestore,
  authorizeRestore,
  childIdsByParent,
} from "../src/core/restore-authorize.js";

/** How long a confirming onMoved may take before the live read decides instead. */
const EVENT_CONFIRM_MS = 2000;

class AbortSignalled extends Error {
  constructor(detail) {
    super(detail.key);
    this.detail = detail;
  }
}

/**
 * Correlates bookmark events with the moves this page issued. An entry is
 * consumed at most once, so a repeat of an already-matched move — the case an
 * outside actor could produce — aborts on the second event.
 */
function createLedger() {
  const expected = [];
  const waiters = new Set();
  let aborted = null;

  const wake = () => {
    for (const waiter of waiters) waiter();
  };

  const onEvent = (event) => {
    if (aborted) return;
    // A removal this batch asked for is expected exactly once; any other
    // removal is somebody else deleting a bookmark while we work.
    if (event.kind === "removed") {
      const match = expected.find(
        (item) =>
          !item.consumed &&
          item.kind === "removed" &&
          item.bookmarkId === event.id &&
          item.oldParentId === event.info.parentId,
      );
      if (!match) {
        aborted = {
          key: "apply.abort.foreignRemoval",
          params: { id: event.id },
        };
        wake();
        return;
      }
      match.consumed = true;
      wake();
      return;
    }
    // A retitle this batch asked for is expected exactly once, with the exact
    // title it wrote. Anything else changing a node is somebody else editing.
    if (event.kind === "changed") {
      const match = expected.find(
        (item) =>
          !item.consumed &&
          item.kind === "changed" &&
          item.bookmarkId === event.id &&
          item.title === event.info.title,
      );
      if (!match) {
        aborted = {
          key: "apply.abort.externalChange",
          params: { kind: event.kind },
        };
        wake();
        return;
      }
      match.consumed = true;
      wake();
      return;
    }
    if (event.kind !== "moved") {
      aborted = {
        key: "apply.abort.externalChange",
        params: { kind: event.kind },
      };
      wake();
      return;
    }
    const match = expected.find(
      (item) =>
        !item.consumed &&
        item.kind === "moved" &&
        item.bookmarkId === event.id &&
        item.oldParentId === event.info.oldParentId &&
        item.oldIndex === event.info.oldIndex &&
        item.parentId === event.info.parentId,
    );
    if (!match) {
      aborted = { key: "apply.abort.foreignMove", params: { id: event.id } };
      wake();
      return;
    }
    match.consumed = true;
    wake();
  };

  return {
    onEvent,
    get aborted() {
      return aborted;
    },
    /** Registered before the move, and kept for the whole batch so a late own event still matches. */
    expect(intent) {
      const item = { ...intent, consumed: false };
      expected.push(item);
      return item;
    },
    async settle(item) {
      if (item.consumed || aborted) return;
      await new Promise((resolve) => {
        const timer = setTimeout(finish, EVENT_CONFIRM_MS);
        function finish() {
          clearTimeout(timer);
          waiters.delete(check);
          resolve();
        }
        function check() {
          if (item.consumed || aborted) finish();
        }
        waiters.add(check);
      });
    },
  };
}

async function readTree() {
  const entries = flattenTree(await getLiveTree());
  return {
    entries,
    byId: indexById(entries),
    digest: await sha256Hex(canonicalTreeString(entries)),
  };
}

/** The pair must sit on the same side of the account/local divide, proven, not assumed. */
function boundaryHolds(moved, destination) {
  return (
    typeof moved?.syncing === "boolean" &&
    typeof destination?.syncing === "boolean" &&
    moved.syncing === destination.syncing
  );
}

/**
 * Applies one already-checked move and confirms it from the browser, not from
 * the call's return value. Returns the position the node actually ended up in.
 */
async function performMove(
  ledger,
  { bookmarkId, node, targetParentId, targetIndex },
) {
  const item = ledger.expect({
    kind: "moved",
    bookmarkId,
    oldParentId: node.parentId,
    oldIndex: node.index,
    parentId: targetParentId,
  });

  await moveBookmark(bookmarkId, {
    parentId: targetParentId,
    index: apiIndexForMove({
      sameParent: node.parentId === targetParentId,
      oldIndex: node.index,
      targetIndex,
    }),
  });
  await ledger.settle(item);
  if (ledger.aborted) throw new AbortSignalled(ledger.aborted);

  const [moved, destination] = await getNodes([bookmarkId, targetParentId]);
  if (!moved) {
    throw new AbortSignalled({ key: "apply.abort.movedNodeGone" });
  }
  if (!boundaryHolds(moved, destination)) {
    throw new AbortSignalled({ key: "apply.abort.boundaryLost" });
  }
  if (moved.parentId !== targetParentId || moved.index !== targetIndex) {
    throw new AbortSignalled({
      key: "apply.abort.landedElsewhere",
      params: { index: moved.index },
    });
  }
  return { parentId: moved.parentId, index: moved.index };
}

/**
 * Retitles one already-checked bookmark and confirms it by re-reading the node.
 * The position is read back too: a rename must not have moved anything, and a
 * node that shifted underneath us is drift, not success.
 */
async function performRetitle(ledger, { bookmarkId, node, newTitle }) {
  const item = ledger.expect({
    kind: "changed",
    bookmarkId,
    title: newTitle,
  });

  await updateBookmark(bookmarkId, newTitle);
  await ledger.settle(item);
  if (ledger.aborted) throw new AbortSignalled(ledger.aborted);

  const [retitled] = await getNodes([bookmarkId]);
  if (!retitled) {
    throw new AbortSignalled({ key: "apply.abort.movedNodeGone" });
  }
  if (retitled.title !== newTitle) {
    throw new AbortSignalled({
      key: "apply.abort.titleNotWritten",
      params: { title: retitled.title },
    });
  }
  // The event matcher only proves a title arrived. An outside change that set
  // the same title and a different address would satisfy it, so the address is
  // read back too: this call is never allowed to be the reason a url moved.
  if (retitled.url !== node.url) {
    throw new AbortSignalled({
      key: "apply.abort.externalChange",
      params: { kind: "changed" },
    });
  }
  if (retitled.parentId !== node.parentId || retitled.index !== node.index) {
    throw new AbortSignalled({
      key: "apply.abort.landedElsewhere",
      params: { index: retitled.index },
    });
  }
  return { parentId: retitled.parentId, index: retitled.index };
}

/**
 * Runs one batch under the write lock with the event watcher attached.
 * `step` performs a single move and returns the tree it expects afterwards.
 */
async function runBatch({
  journal,
  steps,
  expectedDigest,
  step,
  onProgress,
  persist = true,
}) {
  return withApplyLock(async () => {
    const ledger = createLedger();
    const release = watchExternalChanges(ledger.onEvent);
    let current = journal;
    let expected = expectedDigest;
    let expectedEntries = null;
    let drift = null;
    let done = 0;

    // The only way a step advances the journal. Going through here means an
    // exception can never roll the in-memory copy back behind what was already
    // persisted, which is what makes a half-done move recoverable.
    const commit = async (updated) => {
      current = updated;
      if (persist) await saveJournal(updated);
      return updated;
    };

    try {
      for (const item of steps) {
        if (ledger.aborted) throw new AbortSignalled(ledger.aborted);

        const tree = await readTree();
        if (expected !== null && tree.digest !== expected) {
          if (expectedEntries) {
            drift = describeTreeDrift(expectedEntries, tree.entries);
          }
          throw new AbortSignalled({ key: "apply.abort.treeDrift" });
        }
        const result = await step({
          item,
          tree,
          ledger,
          journal: current,
          commit,
        });
        expected = result.expectedDigest;
        expectedEntries = result.expectedEntries ?? tree.entries;
        done += 1;
        onProgress?.({ done, total: steps.length, opId: item.opId });
      }
      // The loop checks the ledger on the way in, so the last step's own commit
      // window has nothing after it. An outside change that arrives there would
      // otherwise be reported as a clean finish.
      if (ledger.aborted) throw new AbortSignalled(ledger.aborted);
      return { journal: current, aborted: null, drift: null };
    } catch (error) {
      const detail =
        error instanceof AbortSignalled
          ? error.detail
          : { key: "apply.abort.failed", params: { message: error.message } };
      current = abortJournal(current, detail);
      if (persist) await saveJournal(current);
      return { journal: current, aborted: detail, drift };
    } finally {
      release();
    }
  });
}

/**
 * Applies the approved operations one at a time. Every operation is re-checked
 * against a freshly read tree by the same evaluator the Dry Run used, so Apply
 * and Dry Run can never disagree about what is allowed.
 */
export async function runApply({
  journal,
  plan,
  treeDigest,
  protectedBookmarkIds,
  onProgress,
}) {
  const opById = new Map(plan.operations.map((op) => [op.opId, op]));
  const steps = journal.entries.map((entry) => ({ opId: entry.opId }));
  const protectedIds = protectedBookmarkIds ?? new Set();

  return runBatch({
    journal,
    steps,
    expectedDigest: treeDigest,
    onProgress,
    step: async ({ item, tree, ledger, journal: current, commit }) => {
      const op = opById.get(item.opId);
      const verdict = evaluateOperation(
        op,
        tree.entries,
        tree.byId,
        new Set(),
        protectedIds,
      );
      if (verdict.status !== STATUS.MOVABLE) {
        const detail = {
          key: "apply.abort.preconditionLost",
          params: { status: verdict.status },
        };
        await commit(markFailed(current, item.opId, detail));
        throw new AbortSignalled(detail);
      }

      const node = tree.byId.get(op.bookmarkId);

      if (op.type === "update") {
        // Persisted before the write, with both titles, so a crash here can be
        // classified from the live title alone.
        const attempted = await commit(
          markUpdateAttempted(current, item.opId, {
            oldTitle: node.title,
            newTitle: op.newTitle,
          }),
        );
        const observed = await performRetitle(ledger, {
          bookmarkId: op.bookmarkId,
          node,
          newTitle: op.newTitle,
        });
        await commit(markApplied(attempted, item.opId, observed));

        const projected = projectTreeAfterRetitle(tree.entries, {
          bookmarkId: op.bookmarkId,
          title: op.newTitle,
        });
        return {
          expectedDigest: await sha256Hex(canonicalTreeString(projected)),
          expectedEntries: projected,
        };
      }

      const targetParentId = verdict.resolvedDestinationId;
      // Append: the destination's current child count is the first free slot.
      const targetIndex = tree.entries.filter(
        (entry) => entry.parentId === targetParentId,
      ).length;

      // Persisted before the write, so a crash here still leaves a rollback trail.
      const attempted = await commit(
        markAttempted(current, item.opId, {
          originalParentId: node.parentId,
          originalIndex: node.index,
          targetParentId,
          targetIndex,
        }),
      );

      const observed = await performMove(ledger, {
        bookmarkId: op.bookmarkId,
        node,
        targetParentId,
        targetIndex,
      });
      await commit(markApplied(attempted, item.opId, observed));

      const projected = projectTreeAfterMove(tree.entries, {
        bookmarkId: op.bookmarkId,
        targetParentId,
        targetIndex,
      });
      return {
        expectedDigest: await sha256Hex(canonicalTreeString(projected)),
        expectedEntries: projected,
      };
    },
  });
}

/**
 * Undoes the applied moves in reverse order at their recorded indices.
 * Nothing is clamped: a position that cannot be restored exactly is reported.
 */
export async function runRollback({ journal, onProgress }) {
  const steps = buildRollbackPlan(journal);

  const result = await runBatch({
    journal,
    steps,
    expectedDigest: null,
    onProgress,
    step: async ({ item, tree, ledger, journal: current, commit }) => {
      const node = tree.byId.get(item.bookmarkId);
      if (!node) throw new AbortSignalled({ key: "apply.abort.movedNodeGone" });

      if (item.type === "update") {
        // Already back. A crash between the reverse write and its record lands
        // here, so the retry records it instead of refusing it.
        if (node.title === item.targetTitle) {
          await commit(
            markRolledBack(current, item.opId, {
              parentId: node.parentId,
              index: node.index,
            }),
          );
          return { expectedDigest: tree.digest };
        }
        // Undo what this batch wrote, not what somebody wrote afterwards. This
        // is an optimistic check, not an atomic one: it cannot see a change made
        // between this read and the write below, and it cannot tell a title that
        // was changed away and back again from one that was never touched.
        if (node.title !== item.appliedTitle) {
          throw new AbortSignalled({
            key: "apply.abort.changedSinceApply",
            params: { opId: item.opId },
          });
        }
        const observed = await performRetitle(ledger, {
          bookmarkId: item.bookmarkId,
          node,
          newTitle: item.targetTitle,
        });
        const [restored] = await getNodes([item.bookmarkId]);
        if (classifyRollback(item, restored) !== ROLLBACK.OK) {
          throw new AbortSignalled({
            key: "apply.abort.rollbackConflict",
            params: { opId: item.opId },
          });
        }
        await commit(markRolledBack(current, item.opId, observed));

        const projected = projectTreeAfterRetitle(tree.entries, {
          bookmarkId: item.bookmarkId,
          title: item.targetTitle,
        });
        return {
          expectedDigest: await sha256Hex(canonicalTreeString(projected)),
          expectedEntries: projected,
        };
      }

      // Already home. A crash between the reverse move and its record lands
      // here, so the retry records it instead of refusing it.
      if (
        node.parentId === item.targetParentId &&
        node.index === item.targetIndex
      ) {
        await commit(
          markRolledBack(current, item.opId, {
            parentId: node.parentId,
            index: node.index,
          }),
        );
        return { expectedDigest: tree.digest };
      }
      // Undo what this batch did, not what somebody did afterwards: if the node
      // is no longer where Apply left it, put nothing back.
      if (
        node.parentId !== item.appliedParentId ||
        node.index !== item.appliedIndex
      ) {
        throw new AbortSignalled({
          key: "apply.abort.movedSinceApply",
          params: { opId: item.opId },
        });
      }

      const observed = await performMove(ledger, {
        bookmarkId: item.bookmarkId,
        node,
        targetParentId: item.targetParentId,
        targetIndex: item.targetIndex,
      });
      if (classifyRollback(item, observed) !== ROLLBACK.OK) {
        throw new AbortSignalled({
          key: "apply.abort.rollbackConflict",
          params: { opId: item.opId },
        });
      }
      // Recorded per step so a partial rollback can be retried where it stopped.
      await commit(markRolledBack(current, item.opId, observed));

      const projected = projectTreeAfterMove(tree.entries, {
        bookmarkId: item.bookmarkId,
        targetParentId: item.targetParentId,
        targetIndex: item.targetIndex,
      });
      return {
        expectedDigest: await sha256Hex(canonicalTreeString(projected)),
        expectedEntries: projected,
      };
    },
  });

  if (!result.aborted) {
    // Every entry is already recorded as rolled back, so a storage failure here
    // costs a stale record, not the ability to act. It must not surface as a
    // failed rollback.
    try {
      await clearJournal();
    } catch {
      /* the journal holds no applied entries at this point */
    }
  }
  return result;
}

/**
 * Puts nodes back where a snapshot recorded them. The preview is not trusted:
 * every move is authorised again against the freshly read tree immediately
 * before it runs, so a change made after the preview cannot slip past.
 */
export async function runRestore({ journal, snapshot, moves, onProgress }) {
  return runBatch({
    journal,
    steps: moves,
    expectedDigest: null,
    onProgress,
    persist: false,
    step: async ({ item, tree, ledger }) => {
      const refusal = authorizeRestoreMove(
        snapshot,
        tree.byId,
        item.bookmarkId,
      );
      if (refusal) {
        throw new AbortSignalled({
          key: "apply.abort.restoreUnauthorised",
          params: { id: item.bookmarkId },
        });
      }

      const node = tree.byId.get(item.bookmarkId);
      if (
        node.parentId === item.targetParentId &&
        node.index === item.targetIndex
      ) {
        return { expectedDigest: tree.digest };
      }

      await performMove(ledger, {
        bookmarkId: item.bookmarkId,
        node,
        targetParentId: item.targetParentId,
        targetIndex: item.targetIndex,
      });

      const projected = projectTreeAfterMove(tree.entries, item);
      return {
        expectedDigest: await sha256Hex(canonicalTreeString(projected)),
        expectedEntries: projected,
      };
    },
  });
}

/**
 * Settles the entries a crash left in `attempted`, using the live tree as the
 * only evidence. This is what makes a journal from a previous session usable.
 */
export async function settleAttempted(journal) {
  let current = journal;
  for (const entry of attemptedEntries(journal)) {
    const [node] = await getNodes([entry.bookmarkId]);
    const verdict = classifyAttempted(entry, node);
    current =
      verdict === RESUME.APPLIED
        ? markApplied(current, entry.opId, {
            parentId: node.parentId,
            index: node.index,
          })
        : markFailed(current, entry.opId, {
            key:
              verdict === RESUME.NOT_APPLIED
                ? "apply.resume.notApplied"
                : "apply.resume.conflict",
          });
  }
  if (current !== journal) await saveJournal(current);
  return current;
}

/* ------------------------------------------------------------------------- *
 * Trash and restore
 *
 * These paths never touch the apply journal. The trash ledger is their only
 * write-ahead record, so no operation is ever owned by two durable stores at
 * once. They still run inside the same envelope as Apply: one lock, the event
 * ledger, a pre-move re-check against a freshly read tree, the projection chain
 * between moves, and a post-move read-back.
 * ------------------------------------------------------------------------- */

/** The trash ledger is authoritative here, so a batch that aborts still reports what was persisted. */
function trashOutcome(persisted, result) {
  return { ledger: persisted, aborted: result.aborted, drift: result.drift };
}

/**
 * Writes the working ledger back with the quarantined receipts re-attached, and
 * carries the compare-and-set baseline forward. `expect` must be the document
 * that was actually read from storage, which is not the same object as the
 * working ledger whenever anything was quarantined.
 */
function ledgerWriter({ quarantined = [], expect }) {
  let lastWritten = expect;
  return async (updated) => {
    const document = withQuarantined(updated, quarantined);
    await saveTrashLedger(document, { expect: lastWritten });
    lastWritten = document;
  };
}

function sameBoundary(byId, node, destination) {
  if (isBoundaryIndeterminate(node, byId)) return false;
  if (isBoundaryIndeterminate(destination, byId)) return false;
  return (
    boundaryKey(topAncestorOf(node, byId)) ===
    boundaryKey(topAncestorOf(destination, byId))
  );
}

/**
 * Creates the Trash folder in the place the user picked. Runs under the batch
 * lock so it cannot race a move, and acts on the browser's read-back rather
 * than on what the call returned.
 *
 * The store has to be provable here: a Trash folder whose account/local side is
 * unknown would accept items it can never hand back, because the restore move
 * across that divide is refused.
 */
export async function createTrashFolder({ parentId, title }) {
  return withApplyLock(async () => {
    const tree = await readTree();
    const parent = tree.byId.get(parentId);
    if (!parent || !parent.isFolder || parent.isRoot || parent.unmodifiable) {
      return { folder: null, error: { key: "trash.create.invalidParent" } };
    }
    if (isBoundaryIndeterminate(parent, tree.byId)) {
      return { folder: null, error: { key: "trash.create.boundaryUnknown" } };
    }
    const approvedAncestors = ancestorIdsOf(parent, tree.byId);

    const created = await createFolder({ parentId, title });
    // The lock keeps other tabs of this extension out, not the browser UI or
    // another device, so the place that was approved is checked again here.
    const after = await readTree();
    const node = after.byId.get(created?.id);
    const settledParent = after.byId.get(parentId);
    const settledAncestors = settledParent
      ? ancestorIdsOf(settledParent, after.byId)
      : null;
    const misplaced =
      !node ||
      node.isFolder !== true ||
      node.parentId !== parentId ||
      !settledAncestors ||
      settledAncestors.length !== approvedAncestors.length ||
      settledAncestors.some((id, i) => id !== approvedAncestors[i]);
    if (misplaced) {
      // Nothing can be undone here: this build has no delete. Naming the folder
      // is the only honest option, so the user can remove it themselves.
      return {
        folder: null,
        error: {
          key: "trash.create.unverified",
          params: { id: created?.id ?? "" },
        },
      };
    }
    return {
      folder: { id: node.id, parentId: node.parentId, title: node.title },
      error: null,
    };
  });
}

/**
 * Everything a receipt records about where the node came from, read from the
 * tree immediately before its own move.
 */
function receiptFor(
  tree,
  {
    bookmarkId,
    batchId,
    sequence,
    batchSize,
    trashParentId,
    trashedAt,
    retentionMs,
  },
) {
  const node = tree.byId.get(bookmarkId);
  const originalParent = tree.byId.get(node.parentId);
  return createReceipt({
    batchId,
    sequence,
    batchSize,
    trashedAt,
    retentionMs,
    trashParentId,
    item: {
      bookmarkId,
      title: node.title,
      url: node.url,
      dateAdded: node.dateAdded,
      originalParentId: node.parentId,
      originalAncestorIds: ancestorIdsOf(originalParent, tree.byId),
      originalParentPath: originalParent.path,
      originalIndex: node.index,
      boundaryKey: boundaryKey(topAncestorOf(node, tree.byId)),
    },
  });
}

/**
 * Moves the selected bookmarks into the designated Trash folder, one at a time,
 * recording each receipt before its own move. Refuses up front when the ledger
 * has no room, because compacting to make room would trade recovery data for a
 * move that has not happened yet.
 */
export async function runTrash({
  ledger,
  quarantined,
  expect,
  bookmarkIds,
  trashFolderId,
  batchId,
  trashedAt,
  retentionMs,
  onProgress,
}) {
  const preTree = await readTree();
  const missing = bookmarkIds.find((id) => !preTree.byId.get(id));
  if (missing) {
    return {
      ledger,
      aborted: { key: "trash.abort.nodeGone", params: { id: missing } },
      drift: null,
    };
  }

  const prospective = bookmarkIds.map((bookmarkId, sequence) =>
    receiptFor(preTree, {
      bookmarkId,
      batchId,
      sequence,
      batchSize: bookmarkIds.length,
      trashParentId: trashFolderId,
      trashedAt,
      retentionMs,
    }),
  );
  const capacity = capacityVerdict(ledger, prospective);
  if (capacity.verdict !== CAPACITY.OK) {
    return {
      ledger,
      aborted: { key: "trash.abort.capacity", params: { ...capacity } },
      drift: null,
    };
  }

  let persisted = ledger;
  const write = ledgerWriter({ quarantined, expect });
  const steps = bookmarkIds.map((bookmarkId, sequence) => ({
    opId: `${batchId}:${sequence}`,
    bookmarkId,
    sequence,
  }));

  const result = await runBatch({
    journal: ledger,
    steps,
    expectedDigest: null,
    onProgress,
    persist: false,
    step: async ({ item, tree, ledger: events, journal: current, commit }) => {
      const node = tree.byId.get(item.bookmarkId);
      if (!node) {
        throw new AbortSignalled({
          key: "trash.abort.nodeGone",
          params: { id: item.bookmarkId },
        });
      }
      // v1 trashes bookmarks only: a folder would take descendants no receipt
      // describes.
      if (node.isFolder || node.unmodifiable) {
        throw new AbortSignalled({
          key: "trash.abort.notBookmark",
          params: { id: item.bookmarkId },
        });
      }
      const destination = tree.byId.get(trashFolderId);
      if (
        !destination ||
        !destination.isFolder ||
        destination.isRoot ||
        destination.unmodifiable
      ) {
        throw new AbortSignalled({ key: "trash.abort.destinationInvalid" });
      }
      if (node.parentId === trashFolderId) {
        throw new AbortSignalled({
          key: "trash.abort.alreadyInTrash",
          params: { id: item.bookmarkId },
        });
      }
      if (!sameBoundary(tree.byId, node, destination)) {
        throw new AbortSignalled({ key: "trash.abort.boundary" });
      }

      const receipt = receiptFor(tree, {
        bookmarkId: item.bookmarkId,
        batchId,
        sequence: item.sequence,
        batchSize: steps.length,
        trashParentId: trashFolderId,
        trashedAt,
        retentionMs,
      });
      const pending = appendReceipt(current, receipt);
      await write(pending);
      persisted = pending;
      await commit(pending);

      const targetIndex = tree.entries.filter(
        (entry) => entry.parentId === trashFolderId,
      ).length;
      const observed = await performMove(events, {
        bookmarkId: item.bookmarkId,
        node,
        targetParentId: trashFolderId,
        targetIndex,
      });

      const projected = projectTreeAfterMove(tree.entries, {
        bookmarkId: item.bookmarkId,
        targetParentId: trashFolderId,
        targetIndex,
      });
      // The shape the origin folder is left in, which is what a later batch
      // restore has to find again before it can claim an exact placement.
      const settled = markTrashed(pending, receipt.receiptId, observed, {
        originalParentFingerprint: fingerprintChildIds(
          childIdsByParent(projected).get(receipt.originalParentId) ?? [],
        ),
      });
      await write(settled);
      persisted = settled;
      await commit(settled);

      return {
        expectedDigest: await sha256Hex(canonicalTreeString(projected)),
        expectedEntries: projected,
      };
    },
  });

  return trashOutcome(persisted, result);
}

/** Shared move-and-record body for both restore paths. */
function restoreStep({ getTarget, poisonedBookmarkIds, track }) {
  return async ({ item, tree, ledger: events, journal: current, commit }) => {
    const receipt = current.receipts.find(
      (candidate) => candidate.receiptId === item.receiptId,
    );
    if (!receipt) {
      throw new AbortSignalled({
        key: "restore.abort.receiptGone",
        params: { id: item.receiptId },
      });
    }
    // Re-authorised against this tree, not against the preview: anything may
    // have moved the node or its origin folder since the plan was built.
    const row = authorizeRestore(receipt, {
      byId: tree.byId,
      entries: tree.entries,
      poisonedBookmarkIds,
    });
    if (row.verdict !== RESTORE.APPROXIMATE) {
      throw new AbortSignalled({
        key: "restore.abort.preconditionLost",
        params: { verdict: row.verdict },
      });
    }

    const node = tree.byId.get(receipt.bookmarkId);
    const target = getTarget(item, row);
    const restoring = markRestoring(current, receipt.receiptId, {
      observed: { parentId: node.parentId, index: node.index },
      target,
    });
    await track(restoring);
    await commit(restoring);

    const observed = await performMove(events, {
      bookmarkId: receipt.bookmarkId,
      node,
      targetParentId: target.parentId,
      targetIndex: target.index,
    });

    const done = markRestored(restoring, receipt.receiptId);
    await track(done);
    await commit(done);

    const projected = projectTreeAfterMove(tree.entries, {
      bookmarkId: receipt.bookmarkId,
      targetParentId: observed.parentId,
      targetIndex: observed.index,
    });
    return {
      expectedDigest: await sha256Hex(canonicalTreeString(projected)),
      expectedEntries: projected,
    };
  };
}

/**
 * Restores a whole trash batch in reverse sequence at the recorded indices.
 * This is the only path that reproduces the original order, and it runs only
 * while the batch is intact and its origin folders are unchanged.
 */
export async function runRestoreBatch({
  ledger,
  quarantined,
  expect,
  batchId,
  poisonedBookmarkIds,
  onProgress,
}) {
  const preTree = await readTree();
  const plan = authorizeBatchRestore(ledger, batchId, {
    byId: preTree.byId,
    entries: preTree.entries,
    poisonedBookmarkIds,
  });
  if (plan.verdict !== RESTORE.EXACT) {
    return {
      ledger,
      aborted: {
        key: "restore.abort.notExact",
        params: { verdict: plan.verdict },
      },
      drift: null,
    };
  }

  let persisted = ledger;
  const write = ledgerWriter({ quarantined, expect });
  const track = async (updated) => {
    await write(updated);
    persisted = updated;
  };

  const result = await runBatch({
    journal: ledger,
    steps: plan.steps.map((step) => ({ ...step, opId: step.receiptId })),
    expectedDigest: null,
    onProgress,
    persist: false,
    step: restoreStep({
      getTarget: (item) => ({
        parentId: item.targetParentId,
        index: item.targetIndex,
      }),
      poisonedBookmarkIds,
      track,
    }),
  });

  return trashOutcome(persisted, result);
}

/**
 * Restores one item on its own. The original order is not reproducible from a
 * single receipt, so the node is appended and the caller must present this as
 * an approximate placement.
 */
export async function runRestoreOne({
  ledger,
  quarantined,
  expect,
  receiptId,
  poisonedBookmarkIds,
  onProgress,
}) {
  let persisted = ledger;
  const write = ledgerWriter({ quarantined, expect });
  const track = async (updated) => {
    await write(updated);
    persisted = updated;
  };

  const result = await runBatch({
    journal: ledger,
    steps: [{ opId: receiptId, receiptId }],
    expectedDigest: null,
    onProgress,
    persist: false,
    step: restoreStep({
      getTarget: (_item, row) => ({
        parentId: row.targetParentId,
        index: row.targetIndex,
      }),
      poisonedBookmarkIds,
      track,
    }),
  });

  return trashOutcome(persisted, result);
}

/**
 * Permanently deletes the trashed items the caller names. This is the only
 * irreversible path in the build, so every guard is re-evaluated per item
 * against a freshly read tree, and the first anomaly stops the rest.
 *
 * It is deliberately unreachable from a plan file: deletion is not expressible
 * in the plan schema, so an agent can propose a move to Trash and nothing more.
 */
export async function runEmptyTrash({
  ledger,
  quarantined,
  expect,
  receiptIds,
  snapshotDigest,
  onProgress,
}) {
  if (!snapshotDigest) {
    return {
      ledger,
      aborted: { key: "delete.abort.noSnapshot" },
      drift: null,
    };
  }

  let persisted = ledger;
  const write = ledgerWriter({ quarantined, expect });

  const result = await runBatch({
    journal: ledger,
    steps: receiptIds.map((receiptId) => ({ opId: receiptId, receiptId })),
    expectedDigest: null,
    onProgress,
    persist: false,
    step: async ({ item, tree, ledger: events, journal: current, commit }) => {
      const receipt = current.receipts.find(
        (candidate) => candidate.receiptId === item.receiptId,
      );
      if (!receipt || receipt.state !== RECEIPT_STATE.TRASHED) {
        throw new AbortSignalled({
          key: "delete.abort.notTrashed",
          params: { id: item.receiptId },
        });
      }

      const node = tree.byId.get(receipt.bookmarkId);
      if (!node) {
        throw new AbortSignalled({
          key: "delete.abort.gone",
          params: { id: receipt.bookmarkId },
        });
      }
      if (node.isFolder || node.unmodifiable) {
        throw new AbortSignalled({
          key: "delete.abort.notBookmark",
          params: { id: receipt.bookmarkId },
        });
      }
      // Deleting the wrong node cannot be undone, so identity is proven, not
      // assumed: an item edited inside the Trash folder is refused rather than
      // removed on the strength of a stale record.
      if (
        node.dateAdded !== receipt.dateAdded ||
        node.title !== receipt.title ||
        node.url !== receipt.url
      ) {
        throw new AbortSignalled({
          key: "delete.abort.identityMismatch",
          params: { id: receipt.bookmarkId },
        });
      }
      if (
        node.parentId !== receipt.observedTrashParentId &&
        !isDescendantOf(node.id, receipt.observedTrashParentId, tree.byId)
      ) {
        throw new AbortSignalled({
          key: "delete.abort.leftTrash",
          params: { id: receipt.bookmarkId },
        });
      }
      if (isBoundaryIndeterminate(node, tree.byId)) {
        throw new AbortSignalled({ key: "delete.abort.boundary" });
      }

      const deleting = markDeleting(current, receipt.receiptId, snapshotDigest);
      await write(deleting);
      persisted = deleting;
      await commit(deleting);

      const watched = events.expect({
        kind: "removed",
        bookmarkId: receipt.bookmarkId,
        oldParentId: node.parentId,
      });
      // Last gate before the one call that cannot be undone: anything the
      // watcher saw while the intent was being written means the tree is no
      // longer the one that was checked.
      if (events.aborted) throw new AbortSignalled(events.aborted);
      await removeBookmark(receipt.bookmarkId);
      await events.settle(watched);
      if (events.aborted) throw new AbortSignalled(events.aborted);

      const [survivor] = await getNodes([receipt.bookmarkId]);
      if (survivor) {
        throw new AbortSignalled({
          key: "delete.abort.stillPresent",
          params: { id: receipt.bookmarkId },
        });
      }
      if (events.aborted) throw new AbortSignalled(events.aborted);

      const done = markDeleted(deleting, receipt.receiptId);
      await write(done);
      persisted = done;
      await commit(done);

      const projected = projectTreeAfterRemove(tree.entries, {
        bookmarkId: receipt.bookmarkId,
      });
      return {
        expectedDigest: await sha256Hex(canonicalTreeString(projected)),
        expectedEntries: projected,
      };
    },
  });

  // The runner compares the projection before each step, so the last deletion
  // would otherwise never be checked against the real tree.
  if (!result.aborted) {
    const after = await readTree();
    const survivors = persisted.receipts
      .filter(
        (receipt) =>
          receipt.state === RECEIPT_STATE.DELETED &&
          receiptIds.includes(receipt.receiptId) &&
          after.byId.has(receipt.bookmarkId),
      )
      .map((receipt) => receipt.bookmarkId);
    if (survivors.length > 0) {
      return {
        ledger: persisted,
        aborted: {
          key: "delete.abort.stillPresent",
          params: { id: survivors[0] },
        },
        drift: null,
      };
    }
  }

  return trashOutcome(persisted, result);
}

/**
 * Settles receipts a crash left mid-move, using the live tree as the only
 * evidence. A pending receipt whose node never left is dropped outright: it
 * describes a move that did not happen, so keeping it would claim recoverability
 * for a bookmark that was never touched.
 */
export async function settleTrashLedger(ledger, { quarantined, expect } = {}) {
  const unsettled = ledger.receipts.filter(
    (receipt) =>
      receipt.state === RECEIPT_STATE.PENDING ||
      receipt.state === RECEIPT_STATE.RESTORING ||
      receipt.state === RECEIPT_STATE.DELETING,
  );
  if (unsettled.length === 0) return ledger;

  let current = ledger;
  const discard = [];
  for (const receipt of unsettled) {
    const [node] = await getNodes([receipt.bookmarkId]);
    switch (classifyInterrupted(receipt, node)) {
      case INTERRUPTED.DISCARD:
        discard.push(receipt.receiptId);
        break;
      case INTERRUPTED.TRASHED:
        current = markTrashed(
          current,
          receipt.receiptId,
          { parentId: node.parentId, index: node.index },
          {
            originalParentFingerprint:
              receipt.originalParentFingerprintAfter ?? null,
          },
        );
        break;
      case INTERRUPTED.RESTORED:
        current = markRestored(current, receipt.receiptId);
        break;
      case INTERRUPTED.DELETED:
        current = markDeleted(current, receipt.receiptId);
        break;
      default:
        current = markReceiptFailed(current, receipt.receiptId, "interrupted");
    }
  }
  if (discard.length > 0) current = removeReceipts(current, discard);
  await ledgerWriter({ quarantined, expect })(current);
  return current;
}
