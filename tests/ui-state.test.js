import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_IDS,
  MODE,
  SCOPE_WARNING_KEY,
  deriveControlState,
  scopeWarningAction,
} from "../extension/src/core/ui-state.js";

const enabled = (state) =>
  Object.entries(deriveControlState(state))
    .filter(([, disabled]) => !disabled)
    .map(([id]) => id)
    .sort();

test("before any tree is loaded only Load tree is available", () => {
  assert.deepEqual(enabled({}), ["load-tree", "quick-start"]);
});

test("a loaded tree unlocks everything that derives from it", () => {
  assert.deepEqual(enabled({ hasTree: true }), [
    "agent-scope",
    "backup-file",
    "builder-destination",
    "builder-filter",
    "builder-source",
    "export-agent-context",
    "export-tree",
    "find-duplicates",
    "load-tree",
    "plan-file",
    "quick-start",
    "restore-file",
    "trash-folder",
    "trash-parent",
    "trash-title",
  ]);
});

test("sending to Trash needs a selection and a designated folder", () => {
  const base = { hasTree: true };
  const send = (extra) =>
    deriveControlState({ ...base, ...extra })["send-to-trash"];
  assert.equal(send({}), true);
  assert.equal(send({ hasSelection: true }), true);
  assert.equal(send({ hasTrashFolder: true }), true);
  assert.equal(send({ hasSelection: true, hasTrashFolder: true }), false);
});

test("an unreadable ledger locks every write to it", () => {
  // The stored document belongs to a version this build cannot read, so writing
  // would destroy it. Creating the folder is still allowed: it touches no ledger.
  const base = {
    hasTree: true,
    hasSelection: true,
    hasTrashFolder: true,
    hasTrashBatch: true,
    hasReceipts: true,
    hasTrashParent: true,
  };
  const open = deriveControlState(base);
  assert.equal(open["send-to-trash"], false);
  assert.equal(open["trash-restore-batch"], false);
  assert.equal(open["trash-forget"], false);

  const locked = deriveControlState({ ...base, trashLocked: true });
  assert.equal(locked["send-to-trash"], true);
  assert.equal(locked["trash-restore-batch"], true);
  assert.equal(locked["trash-forget"], true);
  assert.equal(locked["create-trash-folder"], false);
});

test("the Trash escape hatches need something to act on", () => {
  const base = { hasTree: true };
  assert.equal(deriveControlState(base)["trash-restore-batch"], true);
  assert.equal(
    deriveControlState({ ...base, hasTrashBatch: true })["trash-restore-batch"],
    false,
  );
  assert.equal(deriveControlState(base)["trash-forget"], true);
  assert.equal(
    deriveControlState({ ...base, hasReceipts: true })["trash-forget"],
    false,
  );
  // Creating the folder needs a place chosen for it.
  assert.equal(deriveControlState(base)["create-trash-folder"], true);
  assert.equal(
    deriveControlState({ ...base, hasTrashParent: true })[
      "create-trash-folder"
    ],
    false,
  );
});

test("sending duplicates needs a report, a keeper and a destination", () => {
  const base = { hasTree: true };
  const send = (extra) =>
    deriveControlState({ ...base, ...extra })["send-duplicates"];
  assert.equal(send({}), true);
  assert.equal(send({ hasDuplicateReport: true }), true);
  assert.equal(send({ hasDuplicateReport: true, hasKeeper: true }), true);
  assert.equal(send({ hasDuplicateReport: true, hasDestination: true }), true);
  assert.equal(
    send({ hasDuplicateReport: true, hasKeeper: true, hasDestination: true }),
    false,
  );
});

test("building a plan needs both a selection and a destination", () => {
  const base = { hasTree: true };
  assert.equal(deriveControlState(base)["build-plan"], true);
  assert.equal(
    deriveControlState({ ...base, hasSelection: true })["build-plan"],
    true,
  );
  assert.equal(
    deriveControlState({ ...base, hasDestination: true })["build-plan"],
    true,
  );
  assert.equal(
    deriveControlState({ ...base, hasSelection: true, hasDestination: true })[
      "build-plan"
    ],
    false,
  );
  // Clearing only needs something to clear.
  assert.equal(deriveControlState(base)["clear-selection"], true);
  assert.equal(
    deriveControlState({ ...base, hasSelection: true })["clear-selection"],
    false,
  );
});

test("Apply needs both an approval and a verified backup", () => {
  const base = { hasTree: true, hasPlan: true };
  assert.equal(deriveControlState(base)["apply-moves"], true);
  assert.equal(
    deriveControlState({ ...base, hasApproval: true })["apply-moves"],
    true,
  );
  assert.equal(
    deriveControlState({ ...base, backupVerified: true })["apply-moves"],
    true,
  );
  assert.equal(
    deriveControlState({ ...base, hasApproval: true, backupVerified: true })[
      "apply-moves"
    ],
    false,
  );
});

test("Apply also needs the plan it would read", () => {
  // The approval token and the verified backup can outlive the plan they were
  // taken for. Apply reads the plan, so a lit button without one would fail at
  // the click rather than at the control.
  const ready = {
    hasTree: true,
    hasPlan: true,
    hasApproval: true,
    backupVerified: true,
  };
  assert.equal(deriveControlState(ready)["apply-moves"], false);
  assert.equal(
    deriveControlState({ ...ready, hasPlan: false })["apply-moves"],
    true,
  );
});

test("verify follows the journal and rollback follows applied moves", () => {
  const withJournal = deriveControlState({ hasTree: true, hasJournal: true });
  assert.equal(withJournal["verify-result"], false);
  assert.equal(withJournal["rollback-batch"], true);

  const withApplied = deriveControlState({
    hasTree: true,
    hasJournal: true,
    hasAppliedMoves: true,
  });
  assert.equal(withApplied["rollback-batch"], false);
});

test("restore needs a snapshot that resolved to at least one move", () => {
  assert.equal(deriveControlState({ hasTree: true })["run-restore"], true);
  assert.equal(
    deriveControlState({ hasTree: true, hasRestoreCandidate: true })[
      "run-restore"
    ],
    false,
  );
});

test("every running mode locks the whole page, including Load tree", () => {
  const unlocked = {
    hasTree: true,
    hasPlan: true,
    hasDuplicateReport: true,
    hasKeeper: true,
    hasSelection: true,
    hasDestination: true,
    hasApproval: true,
    backupVerified: true,
    hasJournal: true,
    hasAppliedMoves: true,
    hasRestoreCandidate: true,
  };
  for (const mode of [MODE.APPLYING, MODE.ROLLING_BACK, MODE.RESTORING]) {
    assert.deepEqual(
      Object.entries(deriveControlState({ ...unlocked, mode }))
        .filter(([, disabled]) => !disabled)
        .map(([id]) => id),
      [],
      mode,
    );
  }
});

test("a settled batch leaves the page usable again", () => {
  for (const mode of [MODE.IDLE, MODE.APPROVED, MODE.APPLIED, MODE.ABORTED]) {
    assert.equal(
      deriveControlState({ hasTree: true, mode })["load-tree"],
      false,
    );
  }
});

test("Dry Run needs a plan", () => {
  const withPlan = deriveControlState({ hasTree: true, hasPlan: true });
  assert.equal(withPlan["dry-run"], false);
  assert.equal(deriveControlState({ hasTree: true })["dry-run"], true);
});

test("a reload disables every control, including Load tree itself", () => {
  const during = deriveControlState({
    loading: true,
    hasTree: true,
    hasPlan: true,
    hasDuplicateReport: true,
    hasKeeper: true,
    hasDestination: true,
  });
  assert.deepEqual(
    Object.values(during).filter((disabled) => !disabled),
    [],
  );
});

test("a failed first load leaves the derived controls locked", () => {
  assert.deepEqual(enabled({ loading: false, hasTree: false }), [
    "load-tree",
    "quick-start",
  ]);
});

test("CONTROL_IDS covers every id the state machine decides", () => {
  assert.deepEqual(
    CONTROL_IDS.sort(),
    Object.keys(deriveControlState({ hasTree: true })).sort(),
  );
  assert.ok(CONTROL_IDS.includes("dry-run"));
});

test("no scope warning applies until something has been exported", () => {
  assert.equal(
    scopeWarningAction({ exportedScope: undefined, currentScope: "2" }),
    "keep",
  );
});

test("a scope that moved away from the exported one warns", () => {
  assert.equal(
    scopeWarningAction({ exportedScope: "", currentScope: "2" }),
    "warn",
  );
  assert.equal(
    scopeWarningAction({ exportedScope: "2", currentScope: "" }),
    "warn",
  );
});

test("returning to the exported scope clears only this module's own warning", () => {
  assert.equal(
    scopeWarningAction({
      exportedScope: "2",
      currentScope: "2",
      currentStatusKey: SCOPE_WARNING_KEY,
    }),
    "clear",
  );
  assert.equal(
    scopeWarningAction({
      exportedScope: "2",
      currentScope: "2",
      currentStatusKey: "agent.export.done",
    }),
    "keep",
  );
});
