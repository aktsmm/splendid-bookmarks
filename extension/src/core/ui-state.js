/**
 * Page state machine. Pure so the rules that decide what the user can click,
 * and when a stale-export warning applies, are testable without a DOM.
 */

export const SCOPE_WARNING_KEY = "agent.scope.changed";

/**
 * The single execution state. Everything that can only be true while a batch is
 * or is not running is derived from it, so no two flags can disagree.
 */
export const MODE = {
  IDLE: "idle",
  APPROVED: "approved",
  APPLYING: "applying",
  APPLIED: "applied",
  ABORTED: "aborted",
  ROLLING_BACK: "rollingBack",
  RESTORING: "restoring",
};

const RUNNING = new Set([MODE.APPLYING, MODE.ROLLING_BACK, MODE.RESTORING]);

/**
 * Maps every control id to its `disabled` value.
 * Everything below the tree is unavailable while the tree is being replaced,
 * and every control is unavailable while a batch holds the write lock.
 */
export function deriveControlState({
  loading = false,
  hasTree = false,
  hasPlan = false,
  mode = MODE.IDLE,
  backupVerified = false,
  hasApproval = false,
  hasJournal = false,
  hasAppliedMoves = false,
  hasRestoreCandidate = false,
  hasSelection = false,
  hasDestination = false,
  hasDuplicateReport = false,
  hasKeeper = false,
  hasTrashParent = false,
  hasTrashFolder = false,
  hasTrashBatch = false,
  hasReceipts = false,
  hasDeletable = false,
  deleteConfirmed = false,
  trashLocked = false,
} = {}) {
  const busy = loading || RUNNING.has(mode);
  const treeDependent = busy || !hasTree;
  return {
    "quick-start": busy,
    "load-tree": busy,
    "export-tree": treeDependent,
    "find-duplicates": treeDependent,
    // Quarantine needs the destination up front so off-boundary copies are
    // reported here instead of blocking the whole Dry Run later.
    "send-duplicates":
      treeDependent || !hasDuplicateReport || !hasKeeper || !hasDestination,
    "agent-scope": treeDependent,
    "export-agent-context": treeDependent,
    "builder-source": treeDependent,
    "builder-filter": treeDependent,
    "builder-destination": treeDependent,
    "build-plan": treeDependent || !hasSelection || !hasDestination,
    "clear-selection": treeDependent || !hasSelection,
    "plan-file": treeDependent,
    "dry-run": treeDependent || !hasPlan,
    "backup-file": treeDependent,
    // Reloading the tree discards the plan but keeps the approval token and the
    // verified backup, so `hasPlan` has to be part of this: without it the
    // button stays lit for a batch that no longer has anything to apply.
    // The approval token and the verified backup can outlive the plan they were
    // taken for, so `hasPlan` belongs here: Apply reads the plan, and a lit
    // button with nothing to read fails at the click instead of at the control.
    "apply-moves": treeDependent || !hasPlan || !hasApproval || !backupVerified,
    "verify-result": treeDependent || !hasJournal,
    "rollback-batch": treeDependent || !hasAppliedMoves,
    "restore-file": treeDependent,
    "run-restore": treeDependent || !hasRestoreCandidate,
    "trash-parent": treeDependent,
    "trash-title": treeDependent,
    "create-trash-folder": treeDependent || !hasTrashParent,
    "trash-folder": treeDependent,
    // Sending needs a designated folder up front, so an item is never moved
    // somewhere the ledger cannot describe. `trashLocked` covers the case where
    // the stored records cannot be read: writing then would overwrite them.
    "send-to-trash":
      treeDependent || trashLocked || !hasSelection || !hasTrashFolder,
    "trash-restore-batch": treeDependent || trashLocked || !hasTrashBatch,
    "trash-forget": treeDependent || trashLocked || !hasReceipts,
    "empty-trash-confirm": treeDependent || trashLocked || !hasDeletable,
    // The one irreversible control: it needs items, a verified backup and a
    // deliberate confirmation, and it is never reachable from a plan file.
    "empty-trash":
      treeDependent ||
      trashLocked ||
      !hasDeletable ||
      !backupVerified ||
      !deleteConfirmed,
  };
}

export const CONTROL_IDS = Object.keys(deriveControlState());

/**
 * `keep` leaves the current status alone; `clear` only ever removes the
 * warning this module owns, never someone else's message.
 * @returns {"warn"|"clear"|"keep"}
 */
export function scopeWarningAction({
  exportedScope,
  currentScope,
  currentStatusKey,
} = {}) {
  if (exportedScope === undefined) return "keep";
  if (exportedScope !== currentScope) return "warn";
  return currentStatusKey === SCOPE_WARNING_KEY ? "clear" : "keep";
}
