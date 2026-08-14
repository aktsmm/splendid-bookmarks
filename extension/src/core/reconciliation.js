/**
 * Post-batch reconciliation: Verify and strict Rollback.
 * Pure; the caller supplies a freshly flattened tree.
 *
 * Rollback never clamps. If the exact original index cannot be restored the
 * operation is reported as `rollback-conflict` instead of being approximated,
 * because a silently shifted bookmark is worse than a reported failure.
 */
import {
  ENTRY_STATE,
  ENTRY_TYPE,
  appliedEntries,
  entryType,
} from "./execution-session.js";

export const VERIFY = {
  OK: "verified",
  MISSING: "missing",
  POSITION_MISMATCH: "position-mismatch",
  TITLE_MISMATCH: "title-mismatch",
  NOT_APPLIED: "not-applied",
};

export const ROLLBACK = {
  OK: "rolled-back",
  CONFLICT: "rollback-conflict",
};

export function verifyJournal(journal, entriesById) {
  const rows = journal.entries.map((entry) => {
    if (entry.state !== ENTRY_STATE.APPLIED) {
      return {
        opId: entry.opId,
        bookmarkId: entry.bookmarkId,
        status: VERIFY.NOT_APPLIED,
        expected: null,
        actual: null,
        state: entry.state,
      };
    }
    const live = entriesById.get(entry.bookmarkId);
    const expected = {
      parentId: entry.targetParentId,
      index: entry.targetIndex,
    };
    if (!live) {
      return {
        opId: entry.opId,
        bookmarkId: entry.bookmarkId,
        status: VERIFY.MISSING,
        expected,
        actual: null,
        state: entry.state,
      };
    }
    const actual = { parentId: live.parentId, index: live.index };
    // A rename never moves the node, so its evidence is the title. Checking the
    // position for an update would report OK on a write that never landed.
    if (entryType(entry) === ENTRY_TYPE.UPDATE) {
      return {
        opId: entry.opId,
        bookmarkId: entry.bookmarkId,
        status:
          live.title === entry.newTitle ? VERIFY.OK : VERIFY.TITLE_MISMATCH,
        expected: { title: entry.newTitle },
        actual: { title: live.title },
        state: entry.state,
      };
    }
    const matches =
      actual.parentId === expected.parentId && actual.index === expected.index;
    return {
      opId: entry.opId,
      bookmarkId: entry.bookmarkId,
      status: matches ? VERIFY.OK : VERIFY.POSITION_MISMATCH,
      expected,
      actual,
      state: entry.state,
    };
  });

  const summary = {};
  for (const row of rows) summary[row.status] = (summary[row.status] ?? 0) + 1;
  return {
    rows,
    summary,
    ok: rows.every(
      (row) =>
        row.status !== VERIFY.POSITION_MISMATCH &&
        row.status !== VERIFY.TITLE_MISMATCH &&
        row.status !== VERIFY.MISSING,
    ),
  };
}

/**
 * Reverse application order with the index each node actually had immediately
 * before its own move. Undoing in reverse with those recorded indices restores
 * the original layout even when several nodes left the same folder.
 * `appliedParentId` / `appliedIndex` let the runner refuse to undo a node that
 * something else moved after Apply.
 */
export function buildRollbackPlan(journal) {
  return appliedEntries(journal)
    .slice()
    .reverse()
    .map((entry) => ({
      opId: entry.opId,
      type: entryType(entry),
      bookmarkId: entry.bookmarkId,
      appliedParentId: entry.observedParentId,
      appliedIndex: entry.observedIndex,
      targetParentId: entry.originalParentId,
      targetIndex: entry.originalIndex,
      appliedTitle: entry.newTitle,
      targetTitle: entry.oldTitle,
    }));
}

export function classifyRollback(step, liveNode) {
  if (!liveNode) return ROLLBACK.CONFLICT;
  if (step.type === ENTRY_TYPE.UPDATE) {
    return liveNode.title === step.targetTitle
      ? ROLLBACK.OK
      : ROLLBACK.CONFLICT;
  }
  return liveNode.parentId === step.targetParentId &&
    liveNode.index === step.targetIndex
    ? ROLLBACK.OK
    : ROLLBACK.CONFLICT;
}
