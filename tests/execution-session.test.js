import assert from "node:assert/strict";
import test from "node:test";

import {
  ENTRY_STATE,
  RESUME,
  abortJournal,
  appliedEntries,
  approvalMismatch,
  classifyAttempted,
  createApproval,
  createJournal,
  journalMismatch,
  journalShapeError,
  markApplied,
  markAttempted,
  markFailed,
  nextPendingEntry,
} from "../extension/src/core/execution-session.js";
import { STATUS } from "../extension/src/core/validator.js";

const row = (opId, status, bookmarkId = opId) => ({
  opId,
  bookmarkId,
  status,
});

const ROWS = [
  row("op-1", STATUS.MOVABLE, "100"),
  row("op-2", STATUS.BOUNDARY_VIOLATION, "200"),
  row("op-3", STATUS.MOVABLE, "300"),
];

const approval = () =>
  createApproval({
    planDigest: "plan",
    treeDigest: "tree",
    snapshotDigest: "snap",
    rows: ROWS,
    createdAt: "2026-08-13T00:00:00.000Z",
  });

test("only movable rows are approved, in plan order", () => {
  assert.deepEqual(approval().approvedOpIds, ["op-1", "op-3"]);
});

test("the token holds when the plan, the tree and the classifications agree", () => {
  assert.equal(
    approvalMismatch(approval(), {
      planDigest: "plan",
      treeDigest: "tree",
      rows: ROWS,
    }),
    null,
  );
});

test("a changed plan file, tree or classification invalidates the token", () => {
  const token = approval();
  assert.equal(
    approvalMismatch(token, {
      planDigest: "other",
      treeDigest: "tree",
      rows: ROWS,
    }).key,
    "apply.reject.planChanged",
  );
  assert.equal(
    approvalMismatch(token, {
      planDigest: "plan",
      treeDigest: "other",
      rows: ROWS,
    }).key,
    "apply.reject.treeChanged",
  );

  const demoted = [
    row("op-1", STATUS.MOVABLE, "100"),
    ROWS[1],
    row("op-3", STATUS.ID_NOT_FOUND, "300"),
  ];
  const mismatch = approvalMismatch(token, {
    planDigest: "plan",
    treeDigest: "tree",
    rows: demoted,
  });
  assert.equal(mismatch.key, "apply.reject.opNoLongerMovable");
  assert.equal(mismatch.params.opId, "op-3");
});

test("an unverified backup blocks the token", () => {
  const token = { ...approval(), snapshotDigest: null };
  assert.equal(
    approvalMismatch(token, {
      planDigest: "plan",
      treeDigest: "tree",
      rows: ROWS,
    }).key,
    "apply.reject.noBackup",
  );
});

test("the journal mirrors the approved operations and starts pending", () => {
  const journal = createJournal({
    token: approval(),
    rows: ROWS,
    journalId: "j-1",
    createdAt: "2026-08-13T00:00:01.000Z",
  });
  assert.deepEqual(
    journal.entries.map((entry) => [entry.opId, entry.bookmarkId, entry.state]),
    [
      ["op-1", "100", ENTRY_STATE.PENDING],
      ["op-3", "300", ENTRY_STATE.PENDING],
    ],
  );
  assert.equal(nextPendingEntry(journal).opId, "op-1");
});

test("resume binds on the plan and the backup, never on a tree digest", () => {
  const journal = createJournal({
    token: approval(),
    rows: ROWS,
    journalId: "j-1",
    createdAt: "2026-08-13T00:00:01.000Z",
  });
  assert.equal(
    journalMismatch(journal, { planDigest: "plan", snapshotDigest: "snap" }),
    null,
  );
  assert.equal(
    journalMismatch(journal, { planDigest: "other", snapshotDigest: "snap" })
      .key,
    "apply.reject.journalPlanMismatch",
  );
  assert.equal(
    journalMismatch(journal, { planDigest: "plan", snapshotDigest: "other" })
      .key,
    "apply.reject.journalBackupMismatch",
  );
  assert.ok(!JSON.stringify(journal).includes("treeDigest"));
});

test("the intent is recorded before the move, and confirmation is separate", () => {
  let journal = createJournal({
    token: approval(),
    rows: ROWS,
    journalId: "j-1",
    createdAt: "2026-08-13T00:00:01.000Z",
  });
  journal = markAttempted(journal, "op-1", {
    originalParentId: "2",
    originalIndex: 0,
    targetParentId: "10",
    targetIndex: 2,
  });
  const attempted = journal.entries[0];
  assert.equal(attempted.state, ENTRY_STATE.ATTEMPTED);
  assert.equal(attempted.targetIndex, 2);
  assert.equal(attempted.observedIndex, null);

  journal = markApplied(journal, "op-1", { parentId: "10", index: 2 });
  assert.equal(journal.entries[0].state, ENTRY_STATE.APPLIED);
  assert.deepEqual(
    appliedEntries(journal).map((entry) => entry.opId),
    ["op-1"],
  );
  assert.equal(nextPendingEntry(journal).opId, "op-3");
});

test("an attempted entry is classified from the live node alone", () => {
  const entry = {
    originalParentId: "2",
    originalIndex: 0,
    targetParentId: "10",
    targetIndex: 2,
  };
  assert.equal(
    classifyAttempted(entry, { parentId: "10", index: 2 }),
    RESUME.APPLIED,
  );
  assert.equal(
    classifyAttempted(entry, { parentId: "2", index: 0 }),
    RESUME.NOT_APPLIED,
  );
  assert.equal(
    classifyAttempted(entry, { parentId: "10", index: 5 }),
    RESUME.CONFLICT,
  );
  // An externally deleted node is a conflict, not a retry.
  assert.equal(classifyAttempted(entry, null), RESUME.CONFLICT);
});

test("failure and abort keep the journal readable", () => {
  let journal = createJournal({
    token: approval(),
    rows: ROWS,
    journalId: "j-1",
    createdAt: "2026-08-13T00:00:01.000Z",
  });
  journal = markFailed(journal, "op-1", { key: "apply.reject.treeChanged" });
  journal = abortJournal(journal, { key: "apply.abort.externalChange" });
  assert.equal(journal.entries[0].state, ENTRY_STATE.FAILED);
  assert.equal(journal.aborted.key, "apply.abort.externalChange");
  assert.equal(nextPendingEntry(journal).opId, "op-3");
});

test("a journal this build produced is accepted by the shape check", () => {
  const journal = createJournal({
    token: createApproval({
      planDigest: "p",
      treeDigest: "t",
      snapshotDigest: "s",
      rows: [{ opId: "op-1", bookmarkId: "10", status: STATUS.MOVABLE }],
      createdAt: "now",
    }),
    rows: [{ opId: "op-1", bookmarkId: "10", status: STATUS.MOVABLE }],
    journalId: "j",
    createdAt: "now",
  });
  assert.equal(journalShapeError(journal), null);
});

test("a stored journal that cannot drive a rollback is named, not believed", () => {
  const applied = {
    opId: "op-1",
    bookmarkId: "10",
    state: ENTRY_STATE.APPLIED,
    originalParentId: "7",
    originalIndex: 0,
    targetParentId: "9",
    targetIndex: 1,
    observedParentId: "9",
    observedIndex: 1,
  };
  const good = { version: 1, kind: "apply-journal", entries: [applied] };
  const withEntry = (patch) => ({
    ...good,
    entries: [{ ...applied, ...patch }],
  });

  assert.equal(journalShapeError(good), null);
  // A pending entry legitimately carries no position and no resolved id yet.
  assert.equal(
    journalShapeError(
      withEntry({
        state: ENTRY_STATE.PENDING,
        bookmarkId: null,
        originalParentId: null,
        originalIndex: null,
        observedParentId: null,
        observedIndex: null,
      }),
    ),
    null,
  );

  assert.equal(journalShapeError(null), "not-an-object");
  assert.equal(journalShapeError("{}"), "not-an-object");
  assert.equal(journalShapeError({ ...good, kind: "something-else" }), "kind");
  assert.equal(journalShapeError({ ...good, version: 2 }), "version");
  assert.equal(journalShapeError({ ...good, entries: null }), "entries");
  assert.equal(journalShapeError({ ...good, entries: [null] }), "entry");
  assert.equal(journalShapeError(withEntry({ opId: "" })), "entry-opId");
  assert.equal(journalShapeError(withEntry({ state: "?" })), "entry-state");
  // Rollback hands this straight to the bookmarks API.
  assert.equal(
    journalShapeError(withEntry({ bookmarkId: { toString: () => "10" } })),
    "entry-bookmarkId",
  );

  // `buildRollbackPlan` turns these into the destination and the precondition.
  assert.equal(
    journalShapeError(withEntry({ originalParentId: "" })),
    "entry-original-position",
  );
  assert.equal(
    journalShapeError(withEntry({ originalIndex: -1 })),
    "entry-original-position",
  );
  assert.equal(
    journalShapeError(withEntry({ originalIndex: 1.5 })),
    "entry-original-position",
  );
  assert.equal(
    journalShapeError(withEntry({ observedParentId: null })),
    "entry-observed-position",
  );
  // `classifyAttempted` compares the live node against both pairs.
  assert.equal(
    journalShapeError(
      withEntry({ state: ENTRY_STATE.ATTEMPTED, targetParentId: null }),
    ),
    "entry-target-position",
  );
});
