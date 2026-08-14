import assert from "node:assert/strict";
import test from "node:test";

import { validatePlanDocument } from "../extension/src/core/plan-schema.js";
import {
  STATUS,
  dryRun,
  evaluateOperation,
} from "../extension/src/core/validator.js";
import {
  ENTRY_STATE,
  RESUME,
  classifyAttempted,
  createApproval,
  createJournal,
  journalShapeError,
  markApplied,
  markUpdateAttempted,
} from "../extension/src/core/execution-session.js";
import {
  ROLLBACK,
  VERIFY,
  buildRollbackPlan,
  classifyRollback,
  verifyJournal,
} from "../extension/src/core/reconciliation.js";
import { projectTreeAfterRetitle } from "../extension/src/core/apply-simulation.js";
import { flattenTree, indexById } from "../extension/src/core/tree-model.js";

// Hand-written, not produced by the code under test: a fixture generated from
// the tree model would agree with whatever the tree model happens to do.
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
            index: 0,
            title: "Old title",
            url: "https://example.test/a",
            dateAdded: 1,
            syncing: false,
          },
          {
            id: "11",
            parentId: "1",
            index: 1,
            title: "Folder",
            syncing: false,
            children: [],
          },
        ],
      },
    ],
  },
];

const entries = flattenTree(TREE);
const byId = indexById(entries);

const updateOp = (overrides = {}) => ({
  opId: "op-1",
  type: "update",
  bookmarkId: "10",
  expectedTitle: "Old title",
  expectedUrl: "https://example.test/a",
  currentPath: ["Bookmarks bar", "Old title"],
  newTitle: "New title",
  reason: "clearer",
  confidence: 0.9,
  ...overrides,
});

// --- schema ------------------------------------------------------------------

test("an update operation needs version 2", () => {
  const doc = (version) => ({ version, operations: [updateOp()] });
  assert.equal(validatePlanDocument(doc(2)).ok, true);
  const v1 = validatePlanDocument(doc(1));
  assert.equal(v1.ok, false);
  assert.ok(v1.errors.some((error) => error.key === "schema.type"));
});

test("an update operation may not carry a destination", () => {
  for (const [field, value] of [
    ["destinationPath", ["Bookmarks bar", "Folder"]],
    ["destinationFolderId", "11"],
  ]) {
    const result = validatePlanDocument({
      version: 2,
      operations: [updateOp({ [field]: value })],
    });
    assert.equal(result.ok, false, field);
    assert.ok(
      result.errors.some(
        (error) =>
          error.key === "schema.unknownField" && error.params.field === field,
      ),
      field,
    );
  }
});

test("newTitle must be a non-empty string within the cap", () => {
  const cases = [undefined, "", 42, "x".repeat(2049)];
  for (const newTitle of cases) {
    const result = validatePlanDocument({
      version: 2,
      operations: [updateOp({ newTitle })],
    });
    assert.equal(result.ok, false, String(newTitle).slice(0, 12));
    assert.ok(result.errors.some((error) => error.key === "schema.newTitle"));
  }
  assert.equal(
    validatePlanDocument({
      version: 2,
      operations: [updateOp({ newTitle: "x".repeat(2048) })],
    }).ok,
    true,
  );
});

// --- dry run -----------------------------------------------------------------

test("a rename of a live bookmark is approved", () => {
  const verdict = evaluateOperation(updateOp(), entries, byId);
  assert.equal(verdict.status, STATUS.MOVABLE);
  assert.equal(verdict.type, "update");
});

test("a folder cannot be renamed", () => {
  const verdict = evaluateOperation(
    updateOp({
      bookmarkId: "11",
      expectedTitle: "Folder",
      expectedUrl: null,
      currentPath: ["Bookmarks bar", "Folder"],
    }),
    entries,
    byId,
  );
  assert.equal(verdict.status, STATUS.RENAME_NOT_A_BOOKMARK);
});

test("a rename to the title it already has is refused", () => {
  const verdict = evaluateOperation(
    updateOp({ newTitle: "Old title" }),
    entries,
    byId,
  );
  assert.equal(verdict.status, STATUS.RENAME_UNCHANGED);
});

test("a rename over the title cap is refused", () => {
  const verdict = evaluateOperation(
    updateOp({ newTitle: "x".repeat(2049) }),
    entries,
    byId,
  );
  assert.equal(verdict.status, STATUS.RENAME_TOO_LONG);
});

test("a bookmark the Trash ledger still tracks cannot be renamed", () => {
  const verdict = evaluateOperation(
    updateOp(),
    entries,
    byId,
    new Set(),
    new Set(["10"]),
  );
  assert.equal(verdict.status, STATUS.RENAME_TRASH_MANAGED);
});

test("the identity checks apply to a rename exactly as they do to a move", () => {
  const cases = [
    [updateOp({ expectedTitle: "stale" }), STATUS.TITLE_MISMATCH],
    [updateOp({ expectedUrl: "https://elsewhere.test/" }), STATUS.URL_MISMATCH],
    [
      updateOp({ currentPath: ["Somewhere else"] }),
      STATUS.CURRENT_PATH_MISMATCH,
    ],
    [updateOp({ bookmarkId: "999" }), STATUS.ID_NOT_FOUND],
  ];
  for (const [op, expected] of cases) {
    assert.equal(evaluateOperation(op, entries, byId).status, expected);
  }
});

test("a rename does not interfere with a move, so neither is refused", () => {
  const result = dryRun(
    {
      operations: [
        updateOp(),
        {
          opId: "op-2",
          type: "move",
          bookmarkId: "10",
          expectedTitle: "Old title",
          expectedUrl: "https://example.test/a",
          currentPath: ["Bookmarks bar", "Old title"],
          destinationPath: ["Bookmarks bar", "Folder"],
          reason: "tidy",
          confidence: 0.9,
        },
      ],
    },
    entries,
  );
  // The second operation is refused as a duplicate id, not as interference.
  assert.deepEqual(
    result.rows.map((row) => row.status),
    [STATUS.MOVABLE, STATUS.DUPLICATE_OP],
  );
});

test("renaming a bookmark whose folder another operation moves is refused", () => {
  // Moving "Folder" changes the path of everything inside it, so the rename
  // would stop matching halfway through a batch the Dry Run had approved.
  const nested = flattenTree([
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
              id: "11",
              parentId: "1",
              index: 0,
              title: "Folder",
              syncing: false,
              children: [
                {
                  id: "20",
                  parentId: "11",
                  index: 0,
                  title: "Inner",
                  url: "https://example.test/inner",
                  dateAdded: 1,
                  syncing: false,
                },
              ],
            },
            {
              id: "12",
              parentId: "1",
              index: 1,
              title: "Elsewhere",
              syncing: false,
              children: [],
            },
          ],
        },
      ],
    },
  ]);

  const result = dryRun(
    {
      operations: [
        {
          opId: "op-move",
          type: "move",
          bookmarkId: "11",
          expectedTitle: "Folder",
          expectedUrl: null,
          currentPath: ["Bookmarks bar", "Folder"],
          destinationPath: ["Bookmarks bar", "Elsewhere"],
          reason: "regroup",
          confidence: 0.9,
        },
        {
          opId: "op-rename",
          type: "update",
          bookmarkId: "20",
          expectedTitle: "Inner",
          expectedUrl: "https://example.test/inner",
          currentPath: ["Bookmarks bar", "Folder", "Inner"],
          newTitle: "Inner renamed",
          reason: "clearer",
          confidence: 0.9,
        },
      ],
    },
    nested,
  );

  assert.deepEqual(
    result.rows.map((row) => row.status),
    [STATUS.OPERATION_INTERDEPENDENT, STATUS.OPERATION_INTERDEPENDENT],
  );
});

test("a rename beside an unrelated move is left alone", () => {
  const nested = flattenTree([
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
              id: "20",
              parentId: "1",
              index: 0,
              title: "Inner",
              url: "https://example.test/inner",
              dateAdded: 1,
              syncing: false,
            },
            {
              id: "21",
              parentId: "1",
              index: 1,
              title: "Other",
              url: "https://example.test/other",
              dateAdded: 2,
              syncing: false,
            },
            {
              id: "12",
              parentId: "1",
              index: 2,
              title: "Elsewhere",
              syncing: false,
              children: [],
            },
          ],
        },
      ],
    },
  ]);

  const result = dryRun(
    {
      operations: [
        {
          opId: "op-move",
          type: "move",
          bookmarkId: "21",
          expectedTitle: "Other",
          expectedUrl: "https://example.test/other",
          currentPath: ["Bookmarks bar", "Other"],
          destinationPath: ["Bookmarks bar", "Elsewhere"],
          reason: "regroup",
          confidence: 0.9,
        },
        {
          opId: "op-rename",
          type: "update",
          bookmarkId: "20",
          expectedTitle: "Inner",
          expectedUrl: "https://example.test/inner",
          currentPath: ["Bookmarks bar", "Inner"],
          newTitle: "Inner renamed",
          reason: "clearer",
          confidence: 0.9,
        },
      ],
    },
    nested,
  );

  assert.deepEqual(
    result.rows.map((row) => row.status),
    [STATUS.MOVABLE, STATUS.MOVABLE],
  );
});

// --- journal, verify, rollback ------------------------------------------------

const journalFor = (op) =>
  createJournal({
    token: createApproval({
      planDigest: "p",
      treeDigest: "t",
      snapshotDigest: "s",
      rows: [
        { opId: op.opId, status: STATUS.MOVABLE, bookmarkId: op.bookmarkId },
      ],
      createdAt: "now",
    }),
    rows: [op],
    journalId: "j",
    createdAt: "now",
  });

test("a rename entry records both titles before the write", () => {
  const journal = journalFor(updateOp());
  assert.equal(journal.entries[0].type, "update");

  const attempted = markUpdateAttempted(journal, "op-1", {
    oldTitle: "Old title",
    newTitle: "New title",
  });
  const entry = attempted.entries[0];
  assert.equal(entry.state, ENTRY_STATE.ATTEMPTED);
  assert.equal(entry.oldTitle, "Old title");
  assert.equal(entry.newTitle, "New title");
  // A rename has no position to restore, and leaving the move fields empty is
  // what makes an older build refuse the whole journal instead of reading this
  // entry as "already home", recording it as rolled back and clearing it.
  assert.deepEqual(
    {
      originalParentId: entry.originalParentId,
      originalIndex: entry.originalIndex,
      targetParentId: entry.targetParentId,
      targetIndex: entry.targetIndex,
    },
    {
      originalParentId: null,
      originalIndex: null,
      targetParentId: null,
      targetIndex: null,
    },
  );
  assert.equal(journalShapeError(attempted), null);
});

test("an older build refuses a journal that holds an applied rename", () => {
  // Reproduces the pre-update shape check: it does not know about `type`, so it
  // measures every applied entry as a move.
  const legacyShapeError = (entry) =>
    typeof entry.originalParentId !== "string" ||
    !Number.isInteger(entry.originalIndex)
      ? "entry-original-position"
      : null;

  const journal = appliedRename();
  assert.equal(legacyShapeError(journal.entries[0]), "entry-original-position");
});

test("an update entry missing its titles is refused as a shape error", () => {
  const journal = journalFor(updateOp());
  const broken = {
    ...journal,
    entries: [
      { ...journal.entries[0], state: ENTRY_STATE.APPLIED, oldTitle: null },
    ],
  };
  assert.equal(journalShapeError(broken), "entry-oldTitle");
});

test("a resumed rename is classified from the live title alone", () => {
  const at = (title) => ({ parentId: "1", index: 0, title });
  const entry = {
    type: "update",
    oldTitle: "Old title",
    newTitle: "New title",
    originalParentId: "1",
    originalIndex: 0,
    targetParentId: "1",
    targetIndex: 0,
  };
  assert.equal(classifyAttempted(entry, at("New title")), RESUME.APPLIED);
  assert.equal(classifyAttempted(entry, at("Old title")), RESUME.NOT_APPLIED);
  assert.equal(classifyAttempted(entry, at("Something else")), RESUME.CONFLICT);
  assert.equal(classifyAttempted(entry, null), RESUME.CONFLICT);
});

const appliedRename = () => {
  const journal = journalFor(updateOp());
  const attempted = markUpdateAttempted(journal, "op-1", {
    oldTitle: "Old title",
    newTitle: "New title",
  });
  return markApplied(attempted, "op-1", { parentId: "1", index: 0 });
};

test("verify checks the title of a rename, not its position", () => {
  const journal = appliedRename();
  const live = (title) =>
    new Map([["10", { id: "10", parentId: "1", index: 0, title }]]);

  assert.equal(
    verifyJournal(journal, live("New title")).rows[0].status,
    VERIFY.OK,
  );

  const drifted = verifyJournal(journal, live("Old title"));
  assert.equal(drifted.rows[0].status, VERIFY.TITLE_MISMATCH);
  assert.equal(drifted.ok, false);

  // The node never moved, so a position-only check would have said OK here.
  assert.deepEqual(drifted.rows[0].expected, { title: "New title" });
  assert.deepEqual(drifted.rows[0].actual, { title: "Old title" });
});

test("the rollback step for a rename carries both titles", () => {
  const [step] = buildRollbackPlan(appliedRename());
  assert.equal(step.type, "update");
  assert.equal(step.appliedTitle, "New title");
  assert.equal(step.targetTitle, "Old title");
});

test("a rename rollback is judged on the title it was asked to restore", () => {
  const [step] = buildRollbackPlan(appliedRename());
  const node = (title) => ({ parentId: "1", index: 0, title });
  assert.equal(classifyRollback(step, node("Old title")), ROLLBACK.OK);
  assert.equal(classifyRollback(step, node("New title")), ROLLBACK.CONFLICT);
  assert.equal(classifyRollback(step, null), ROLLBACK.CONFLICT);
});

// --- projection ---------------------------------------------------------------

test("the projection retitles the node and its own path segment only", () => {
  const projected = projectTreeAfterRetitle(entries, {
    bookmarkId: "10",
    title: "New title",
  });
  const renamed = projected.find((entry) => entry.id === "10");
  assert.equal(renamed.title, "New title");
  assert.deepEqual(renamed.path, ["Bookmarks bar", "New title"]);
  // Everything else is untouched, including the folder that shares the parent.
  assert.deepEqual(
    projected.filter((entry) => entry.id !== "10"),
    entries.filter((entry) => entry.id !== "10"),
  );
});

test("the projection refuses a folder, which is why folders cannot be renamed", () => {
  assert.equal(
    projectTreeAfterRetitle(entries, { bookmarkId: "11", title: "x" }),
    null,
  );
  assert.equal(
    projectTreeAfterRetitle(entries, { bookmarkId: "nope", title: "x" }),
    null,
  );
});
