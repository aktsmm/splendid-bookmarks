/**
 * Approval token and write-ahead journal for the Apply phase.
 * Pure: nothing here touches `chrome.*`, storage or the DOM.
 *
 * The token binds an approved Dry Run to the exact plan bytes, the exact tree
 * it was computed against and the backup that was verified. The journal is the
 * crash-recovery record: every operation is persisted as an intent *before* the
 * move is attempted, so a page that dies mid-batch can still be classified.
 */
import { STATUS } from "./validator.js";

export const SESSION_VERSION = 1;

/**
 * What one approved operation does. An entry written by an older build carries
 * no `type` and is read as a move.
 *
 * The other direction is not compatible, and is made to fail loudly rather than
 * quietly: an update entry leaves its position fields null, which an older
 * `journalShapeError` rejects as a malformed applied entry. Filling them with
 * the unchanged position instead would let that build read the entry as "already
 * home", record it as rolled back and clear the journal — discarding the only
 * record of the old title while the new one stayed on the bookmark.
 */
export const ENTRY_TYPE = {
  MOVE: "move",
  UPDATE: "update",
};

export const entryType = (entry) => entry.type ?? ENTRY_TYPE.MOVE;

export const ENTRY_STATE = {
  PENDING: "pending",
  ATTEMPTED: "attempted",
  APPLIED: "applied",
  FAILED: "failed",
  ROLLED_BACK: "rolled-back",
};

/** Resume verdicts for an entry that was already attempted. */
export const RESUME = {
  APPLIED: "applied",
  NOT_APPLIED: "not-applied",
  CONFLICT: "conflict",
};

/**
 * Builds the approval token from a Dry Run result. Only `movable` rows are
 * approved, and their plan order is preserved: the batch runner applies them in
 * this order and the journal is keyed by it.
 */
export function createApproval({
  planDigest,
  treeDigest,
  snapshotDigest,
  rows,
  createdAt,
}) {
  return {
    version: SESSION_VERSION,
    kind: "approval-token",
    createdAt,
    planDigest,
    treeDigest,
    snapshotDigest,
    approvedOpIds: rows
      .filter((row) => row.status === STATUS.MOVABLE)
      .map((row) => row.opId),
  };
}

/**
 * Re-checks a token against a freshly read plan and tree.
 * @returns {{key: string, params?: object}|null} a message key, or null when the token still holds.
 */
export function approvalMismatch(token, { planDigest, treeDigest, rows }) {
  if (!token || token.kind !== "approval-token") {
    return { key: "apply.reject.noApproval" };
  }
  if (token.planDigest !== planDigest) {
    return { key: "apply.reject.planChanged" };
  }
  if (token.treeDigest !== treeDigest) {
    return { key: "apply.reject.treeChanged" };
  }
  if (!token.snapshotDigest) {
    return { key: "apply.reject.noBackup" };
  }
  const movable = new Set(
    rows.filter((row) => row.status === STATUS.MOVABLE).map((row) => row.opId),
  );
  const lost = token.approvedOpIds.filter((opId) => !movable.has(opId));
  if (lost.length > 0) {
    return { key: "apply.reject.opNoLongerMovable", params: { opId: lost[0] } };
  }
  return null;
}

export function createJournal({ token, rows, journalId, createdAt }) {
  const byOpId = new Map(rows.map((row) => [row.opId, row]));
  return {
    version: SESSION_VERSION,
    kind: "apply-journal",
    journalId,
    createdAt,
    planDigest: token.planDigest,
    snapshotDigest: token.snapshotDigest,
    aborted: null,
    entries: token.approvedOpIds.map((opId) => ({
      opId,
      type: byOpId.get(opId)?.type ?? ENTRY_TYPE.MOVE,
      bookmarkId: byOpId.get(opId)?.bookmarkId ?? null,
      state: ENTRY_STATE.PENDING,
      originalParentId: null,
      originalIndex: null,
      targetParentId: null,
      targetIndex: null,
      observedParentId: null,
      observedIndex: null,
      oldTitle: null,
      newTitle: null,
      detail: null,
    })),
  };
}

/** A parent id and index pair the bookmarks API could actually be called with. */
function badPosition(parentId, index) {
  if (typeof parentId !== "string" || parentId.length === 0) return true;
  return !Number.isInteger(index) || index < 0;
}

/**
 * Why a journal read back from storage cannot be trusted to drive a rollback.
 * The plan file and the snapshot file are both validated before they are acted
 * on; the journal survives crashes and extension upgrades, so it gets the same
 * treatment rather than being believed because we wrote it.
 *
 * @returns {null|string} null when the shape is usable, otherwise the reason.
 */
export function journalShapeError(journal) {
  if (journal === null || typeof journal !== "object") return "not-an-object";
  if (journal.kind !== "apply-journal") return "kind";
  if (journal.version !== SESSION_VERSION) return "version";
  if (!Array.isArray(journal.entries)) return "entries";
  const states = new Set(Object.values(ENTRY_STATE));
  const types = new Set(Object.values(ENTRY_TYPE));
  for (const entry of journal.entries) {
    if (entry === null || typeof entry !== "object") return "entry";
    if (typeof entry.opId !== "string" || entry.opId.length === 0) {
      return "entry-opId";
    }
    if (entry.type !== undefined && !types.has(entry.type)) {
      return "entry-type";
    }
    if (!states.has(entry.state)) return "entry-state";
    // Rollback moves by this id, so a non-string here would reach the API.
    if (entry.bookmarkId !== null && typeof entry.bookmarkId !== "string") {
      return "entry-bookmarkId";
    }
    // A rollback of an update writes `oldTitle` back, so junk there would put a
    // fabricated title on a real bookmark.
    if (
      entryType(entry) === ENTRY_TYPE.UPDATE &&
      (entry.state === ENTRY_STATE.ATTEMPTED ||
        entry.state === ENTRY_STATE.APPLIED ||
        entry.state === ENTRY_STATE.ROLLED_BACK)
    ) {
      if (typeof entry.oldTitle !== "string") return "entry-oldTitle";
      if (typeof entry.newTitle !== "string") return "entry-newTitle";
    }
    // A rename never moves anything, so it has no position to record and the
    // checks below do not apply to it.
    if (entryType(entry) === ENTRY_TYPE.MOVE) {
      // `buildRollbackPlan` reads `observed*` to confirm where the node is now and
      // `original*` as the destination, so an applied entry that carries junk
      // there would move a real bookmark to wherever the junk points.
      if (
        entry.state === ENTRY_STATE.APPLIED ||
        entry.state === ENTRY_STATE.ROLLED_BACK
      ) {
        if (badPosition(entry.originalParentId, entry.originalIndex)) {
          return "entry-original-position";
        }
        if (badPosition(entry.observedParentId, entry.observedIndex)) {
          return "entry-observed-position";
        }
      }
      // `classifyAttempted` compares the live node against both of these.
      if (entry.state === ENTRY_STATE.ATTEMPTED) {
        if (badPosition(entry.originalParentId, entry.originalIndex)) {
          return "entry-original-position";
        }
        if (badPosition(entry.targetParentId, entry.targetIndex)) {
          return "entry-target-position";
        }
      }
    }
  }
  return null;
}

/**
 * Resume binds on the plan and the backup, never on a tree digest: a partial
 * apply always changes the tree, so the tree digest cannot prove anything here.
 */
export function journalMismatch(journal, { planDigest, snapshotDigest }) {
  if (!journal || journal.kind !== "apply-journal") {
    return { key: "apply.reject.noJournal" };
  }
  if (journal.planDigest !== planDigest) {
    return { key: "apply.reject.journalPlanMismatch" };
  }
  if (journal.snapshotDigest !== snapshotDigest) {
    return { key: "apply.reject.journalBackupMismatch" };
  }
  return null;
}

export function patchEntry(journal, opId, patch) {
  return {
    ...journal,
    entries: journal.entries.map((entry) =>
      entry.opId === opId ? { ...entry, ...patch } : entry,
    ),
  };
}

/** Records the intent before the move is attempted. */
export function markAttempted(journal, opId, intent) {
  return patchEntry(journal, opId, {
    state: ENTRY_STATE.ATTEMPTED,
    originalParentId: intent.originalParentId,
    originalIndex: intent.originalIndex,
    targetParentId: intent.targetParentId,
    targetIndex: intent.targetIndex,
    observedParentId: null,
    observedIndex: null,
    detail: null,
  });
}

/**
 * Records a retitle intent before the write. The position fields stay null: a
 * rename has no position to restore, and leaving them empty is what makes an
 * older build refuse the whole journal instead of misreading this entry.
 */
export function markUpdateAttempted(journal, opId, intent) {
  return patchEntry(journal, opId, {
    state: ENTRY_STATE.ATTEMPTED,
    originalParentId: null,
    originalIndex: null,
    targetParentId: null,
    targetIndex: null,
    observedParentId: null,
    observedIndex: null,
    oldTitle: intent.oldTitle,
    newTitle: intent.newTitle,
    detail: null,
  });
}

export function markApplied(journal, opId, observed) {
  return patchEntry(journal, opId, {
    state: ENTRY_STATE.APPLIED,
    observedParentId: observed.parentId,
    observedIndex: observed.index,
  });
}

export function markFailed(journal, opId, detail) {
  return patchEntry(journal, opId, { state: ENTRY_STATE.FAILED, detail });
}

export function markRolledBack(journal, opId, observed) {
  return patchEntry(journal, opId, {
    state: ENTRY_STATE.ROLLED_BACK,
    observedParentId: observed.parentId,
    observedIndex: observed.index,
  });
}

export function abortJournal(journal, detail) {
  return { ...journal, aborted: detail };
}

export function nextPendingEntry(journal) {
  return (
    journal.entries.find((entry) => entry.state === ENTRY_STATE.PENDING) ?? null
  );
}

export function attemptedEntries(journal) {
  return journal.entries.filter(
    (entry) => entry.state === ENTRY_STATE.ATTEMPTED,
  );
}

export function appliedEntries(journal) {
  return journal.entries.filter((entry) => entry.state === ENTRY_STATE.APPLIED);
}

/**
 * Classifies an entry that was persisted as `attempted` but never confirmed,
 * which is exactly the window a crash or a closed tab leaves behind.
 * A node that no longer exists is a conflict, not a retry.
 */
export function classifyAttempted(entry, liveNode) {
  if (!liveNode) return RESUME.CONFLICT;
  if (entryType(entry) === ENTRY_TYPE.UPDATE) {
    // A rename leaves the position alone, so the title is the only evidence of
    // whether the write landed.
    if (liveNode.title === entry.newTitle) return RESUME.APPLIED;
    if (liveNode.title === entry.oldTitle) return RESUME.NOT_APPLIED;
    return RESUME.CONFLICT;
  }
  if (
    liveNode.parentId === entry.targetParentId &&
    liveNode.index === entry.targetIndex
  ) {
    return RESUME.APPLIED;
  }
  if (
    liveNode.parentId === entry.originalParentId &&
    liveNode.index === entry.originalIndex
  ) {
    return RESUME.NOT_APPLIED;
  }
  return RESUME.CONFLICT;
}

export function journalSummary(journal) {
  const counts = {};
  for (const entry of journal.entries) {
    counts[entry.state] = (counts[entry.state] ?? 0) + 1;
  }
  return {
    total: journal.entries.length,
    counts,
    aborted: journal.aborted,
  };
}
