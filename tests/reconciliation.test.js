import assert from "node:assert/strict";
import test from "node:test";

import { ENTRY_STATE } from "../extension/src/core/execution-session.js";
import {
  ROLLBACK,
  VERIFY,
  buildRollbackPlan,
  classifyRollback,
  verifyJournal,
} from "../extension/src/core/reconciliation.js";

function journalWith(...entries) {
  return {
    version: 1,
    kind: "apply-journal",
    journalId: "j-1",
    planDigest: "plan",
    snapshotDigest: "snap",
    aborted: null,
    entries,
  };
}

const applied = (opId, bookmarkId, original, target) => ({
  opId,
  bookmarkId,
  state: ENTRY_STATE.APPLIED,
  originalParentId: original[0],
  originalIndex: original[1],
  targetParentId: target[0],
  targetIndex: target[1],
  observedParentId: target[0],
  observedIndex: target[1],
  detail: null,
});

const liveIndex = (...pairs) =>
  new Map(pairs.map(([id, parentId, index]) => [id, { id, parentId, index }]));

test("verify passes only when every applied node is exactly where it was put", () => {
  const journal = journalWith(applied("op-1", "200", ["2", 0], ["10", 2]));
  const result = verifyJournal(journal, liveIndex(["200", "10", 2]));
  assert.equal(result.rows[0].status, VERIFY.OK);
  assert.equal(result.ok, true);
});

test("a shifted or vanished node fails verification", () => {
  const journal = journalWith(applied("op-1", "200", ["2", 0], ["10", 2]));
  const shifted = verifyJournal(journal, liveIndex(["200", "10", 1]));
  assert.equal(shifted.rows[0].status, VERIFY.POSITION_MISMATCH);
  assert.deepEqual(shifted.rows[0].actual, { parentId: "10", index: 1 });
  assert.equal(shifted.ok, false);

  const gone = verifyJournal(journal, new Map());
  assert.equal(gone.rows[0].status, VERIFY.MISSING);
  assert.equal(gone.ok, false);
});

test("entries that were never applied are reported, not counted as failures", () => {
  const journal = journalWith({
    opId: "op-2",
    bookmarkId: "300",
    state: ENTRY_STATE.PENDING,
    originalParentId: null,
    originalIndex: null,
    targetParentId: null,
    targetIndex: null,
  });
  const result = verifyJournal(journal, new Map());
  assert.equal(result.rows[0].status, VERIFY.NOT_APPLIED);
  assert.equal(result.ok, true);
});

test("rollback undoes applied moves in reverse order at their recorded indices", () => {
  const journal = journalWith(
    applied("op-1", "200", ["2", 0], ["10", 2]),
    applied("op-2", "201", ["2", 0], ["11", 0]),
    { opId: "op-3", bookmarkId: "400", state: ENTRY_STATE.PENDING },
  );
  assert.deepEqual(buildRollbackPlan(journal), [
    {
      opId: "op-2",
      type: "move",
      bookmarkId: "201",
      appliedParentId: "11",
      appliedIndex: 0,
      targetParentId: "2",
      targetIndex: 0,
      appliedTitle: undefined,
      targetTitle: undefined,
    },
    {
      opId: "op-1",
      type: "move",
      bookmarkId: "200",
      appliedParentId: "10",
      appliedIndex: 2,
      targetParentId: "2",
      targetIndex: 0,
      appliedTitle: undefined,
      targetTitle: undefined,
    },
  ]);
});

test("the rollback step carries where Apply left the node, so a later move can be refused", () => {
  const journal = journalWith(applied("op-1", "200", ["2", 0], ["10", 2]));
  const [step] = buildRollbackPlan(journal);
  assert.deepEqual(
    { parentId: step.appliedParentId, index: step.appliedIndex },
    { parentId: "10", index: 2 },
  );
});

test("rollback never clamps: an inexact restore is a conflict", () => {
  const step = { targetParentId: "2", targetIndex: 0 };
  assert.equal(
    classifyRollback(step, { parentId: "2", index: 0 }),
    ROLLBACK.OK,
  );
  assert.equal(
    classifyRollback(step, { parentId: "2", index: 1 }),
    ROLLBACK.CONFLICT,
  );
  assert.equal(
    classifyRollback(step, { parentId: "10", index: 0 }),
    ROLLBACK.CONFLICT,
  );
  assert.equal(classifyRollback(step, null), ROLLBACK.CONFLICT);
});
