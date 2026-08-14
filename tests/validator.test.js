import assert from "node:assert/strict";
import test from "node:test";

import { flattenTree } from "../extension/src/core/tree-model.js";
import { STATUS, dryRun } from "../extension/src/core/validator.js";
import { moveOperation, planWith, sampleTree } from "./fixtures/sample-tree.js";

const entries = flattenTree(sampleTree());

function statusOf(op) {
  return dryRun(planWith(op), entries).rows[0].status;
}

test("a well-formed operation is movable", () => {
  const result = dryRun(planWith(moveOperation()), entries);
  assert.equal(result.rows[0].status, STATUS.MOVABLE);
  assert.equal(result.rows[0].resolvedDestinationId, "10");
  assert.equal(result.movableCount, 1);
  assert.equal(result.blockedCount, 0);
});

test("an operation already at its destination is a no-op", () => {
  assert.equal(
    statusOf(
      moveOperation({
        bookmarkId: "100",
        expectedTitle: "Chrome API",
        expectedUrl:
          "https://developer.chrome.com/docs/extensions/reference/api/bookmarks",
        currentPath: ["ブックマーク バー", "Dev", "Chrome API"],
        destinationPath: ["ブックマーク バー", "Dev"],
      }),
    ),
    STATUS.NO_OP,
  );
});

test("precondition mismatches are reported individually", () => {
  assert.equal(
    statusOf(moveOperation({ bookmarkId: "missing" })),
    STATUS.ID_NOT_FOUND,
  );
  assert.equal(
    statusOf(moveOperation({ expectedTitle: "Renamed" })),
    STATUS.TITLE_MISMATCH,
  );
  assert.equal(
    statusOf(moveOperation({ expectedUrl: "https://example.com/other" })),
    STATUS.URL_MISMATCH,
  );
  assert.equal(
    statusOf(moveOperation({ currentPath: ["ブックマーク バー"] })),
    STATUS.CURRENT_PATH_MISMATCH,
  );
});

test("permanent roots and managed nodes are refused", () => {
  assert.equal(
    statusOf(
      moveOperation({
        bookmarkId: "2",
        expectedTitle: "その他のブックマーク",
        expectedUrl: null,
        currentPath: ["その他のブックマーク"],
      }),
    ),
    STATUS.PERMANENT_ROOT_SOURCE,
  );
  assert.equal(
    statusOf(
      moveOperation({
        bookmarkId: "400",
        expectedTitle: "Policy",
        expectedUrl: "https://example.org/policy",
        currentPath: ["管理対象", "Policy"],
      }),
    ),
    STATUS.UNMODIFIABLE_NODE,
  );
});

test("destination resolution reports missing, ambiguous and conflicting targets", () => {
  assert.equal(
    statusOf(moveOperation({ destinationPath: ["ブックマーク バー", "Nope"] })),
    STATUS.DESTINATION_NOT_FOUND,
  );
  assert.equal(
    statusOf(moveOperation({ destinationFolderId: "nope" })),
    STATUS.DESTINATION_ID_NOT_FOUND,
  );
  assert.equal(
    statusOf(moveOperation({ destinationFolderId: "100" })),
    STATUS.DESTINATION_NOT_FOLDER,
  );
  assert.equal(
    statusOf(moveOperation({ destinationFolderId: "11" })),
    STATUS.DESTINATION_CONFLICT,
  );
  assert.equal(
    statusOf(moveOperation({ destinationFolderId: "10" })),
    STATUS.MOVABLE,
  );

  const ambiguous = dryRun(
    planWith(
      moveOperation({
        bookmarkId: "11",
        currentPath: ["Bar", "Loose"],
        destinationPath: ["Bar", "Dup"],
      }),
    ),
    flattenTree([
      {
        id: "0",
        title: "",
        children: [
          {
            id: "1",
            parentId: "0",
            index: 0,
            title: "Bar",
            folderType: "bookmarks-bar",
            syncing: true,
            children: [
              {
                id: "10",
                parentId: "1",
                index: 0,
                title: "Dup",
                syncing: true,
                children: [],
              },
              {
                id: "11",
                parentId: "1",
                index: 1,
                title: "Loose",
                url: "https://example.com/a/",
                syncing: true,
              },
            ],
          },
          {
            id: "2",
            parentId: "0",
            index: 1,
            title: "Bar",
            folderType: "other",
            syncing: true,
            children: [
              {
                id: "20",
                parentId: "2",
                index: 0,
                title: "Dup",
                syncing: true,
                children: [],
              },
            ],
          },
        ],
      },
    ]),
  );
  assert.equal(ambiguous.rows[0].status, STATUS.DESTINATION_AMBIGUOUS);
});

test("destinationFolderId resolves an ambiguous path when the path still matches", () => {
  const ambiguousTree = flattenTree([
    {
      id: "0",
      title: "",
      children: [
        {
          id: "1",
          parentId: "0",
          index: 0,
          title: "Bar",
          folderType: "bookmarks-bar",
          syncing: true,
          children: [
            {
              id: "10",
              parentId: "1",
              index: 0,
              title: "Dup",
              syncing: true,
              children: [],
            },
            {
              id: "11",
              parentId: "1",
              index: 1,
              title: "Loose",
              url: "https://example.com/a/",
              syncing: true,
            },
          ],
        },
        {
          id: "2",
          parentId: "0",
          index: 1,
          title: "Bar",
          folderType: "other",
          syncing: true,
          children: [
            {
              id: "20",
              parentId: "2",
              index: 0,
              title: "Dup",
              syncing: true,
              children: [],
            },
          ],
        },
      ],
    },
  ]);
  const base = {
    bookmarkId: "11",
    currentPath: ["Bar", "Loose"],
    destinationPath: ["Bar", "Dup"],
  };

  const withId = dryRun(
    planWith(moveOperation({ ...base, destinationFolderId: "20" })),
    ambiguousTree,
  ).rows[0];
  assert.equal(withId.status, STATUS.MOVABLE);
  assert.equal(withId.resolvedDestinationId, "20");

  const withoutId = dryRun(planWith(moveOperation(base)), ambiguousTree)
    .rows[0];
  assert.equal(withoutId.status, STATUS.DESTINATION_AMBIGUOUS);
});

test("moves across the account/local boundary are refused", () => {
  assert.equal(
    statusOf(
      moveOperation({
        destinationPath: ["ローカル ブックマーク バー", "Local only"],
      }),
    ),
    STATUS.BOUNDARY_VIOLATION,
  );
});

test("the boundary check fails closed when syncing is not reported", () => {
  const legacy = flattenTree([
    {
      id: "0",
      title: "",
      children: [
        {
          id: "1",
          parentId: "0",
          index: 0,
          title: "Bar",
          children: [
            { id: "10", parentId: "1", index: 0, title: "Dev", children: [] },
          ],
        },
        {
          id: "2",
          parentId: "0",
          index: 1,
          title: "Other",
          children: [
            {
              id: "20",
              parentId: "2",
              index: 0,
              title: "Loose",
              url: "https://example.com/a/",
            },
          ],
        },
      ],
    },
  ]);
  const result = dryRun(
    planWith(
      moveOperation({
        bookmarkId: "20",
        currentPath: ["Other", "Loose"],
        destinationPath: ["Bar", "Dev"],
      }),
    ),
    legacy,
  );
  assert.equal(result.rows[0].status, STATUS.BOUNDARY_INDETERMINATE);
});

test("a folder cannot be moved into itself or a descendant", () => {
  assert.equal(
    statusOf(
      moveOperation({
        bookmarkId: "10",
        expectedTitle: "Dev",
        expectedUrl: null,
        currentPath: ["ブックマーク バー", "Dev"],
        destinationPath: ["ブックマーク バー", "Dev", "Nested"],
      }),
    ),
    STATUS.DESTINATION_IS_DESCENDANT,
  );
});

test("the same bookmark cannot appear in two operations", () => {
  const result = dryRun(
    planWith(moveOperation(), moveOperation({ opId: "op-2" })),
    entries,
  );
  assert.equal(result.rows[0].status, STATUS.MOVABLE);
  assert.equal(result.rows[1].status, STATUS.DUPLICATE_OP);
});

test("unsupported operation types are refused", () => {
  assert.equal(
    statusOf(moveOperation({ type: "remove" })),
    STATUS.UNSUPPORTED_TYPE,
  );
});

const moveFolder = (overrides) =>
  moveOperation({
    bookmarkId: "10",
    expectedTitle: "Dev",
    expectedUrl: null,
    currentPath: ["ブックマーク バー", "Dev"],
    destinationPath: ["ブックマーク バー", "Shared"],
    ...overrides,
  });

const statusesOf = (...operations) =>
  dryRun(planWith(...operations), entries).rows.map((row) => row.status);

test("operations that do not touch each other stay movable", () => {
  assert.deepEqual(
    statusesOf(
      moveOperation(),
      moveOperation({
        opId: "op-2",
        bookmarkId: "110",
        expectedTitle: "Docs",
        expectedUrl: "https://example.com/a?utm_source=x",
        currentPath: ["ブックマーク バー", "Docs"],
        destinationPath: ["ブックマーク バー", "Shared"],
      }),
    ),
    [STATUS.MOVABLE, STATUS.MOVABLE],
  );
});

test("moving a folder and something inside it refuses both", () => {
  assert.deepEqual(
    statusesOf(
      moveFolder({ opId: "op-1" }),
      moveOperation({
        opId: "op-2",
        bookmarkId: "100",
        expectedTitle: "Chrome API",
        expectedUrl:
          "https://developer.chrome.com/docs/extensions/reference/api/bookmarks",
        currentPath: ["ブックマーク バー", "Dev", "Chrome API"],
        destinationPath: ["ブックマーク バー", "Shared"],
      }),
    ),
    [STATUS.OPERATION_INTERDEPENDENT, STATUS.OPERATION_INTERDEPENDENT],
  );
});

test("moving a folder that another operation aims into refuses both", () => {
  assert.deepEqual(
    statusesOf(
      moveFolder({ opId: "op-1" }),
      moveOperation({
        opId: "op-2",
        destinationPath: ["ブックマーク バー", "Dev", "Nested"],
      }),
    ),
    [STATUS.OPERATION_INTERDEPENDENT, STATUS.OPERATION_INTERDEPENDENT],
  );
});

test("landing in a folder another operation empties refuses both", () => {
  // op-1 appends into "その他のブックマーク"; op-2 leaves it, shifting op-1's index.
  assert.deepEqual(
    statusesOf(
      moveOperation({
        opId: "op-1",
        bookmarkId: "110",
        expectedTitle: "Docs",
        expectedUrl: "https://example.com/a?utm_source=x",
        currentPath: ["ブックマーク バー", "Docs"],
        destinationPath: ["その他のブックマーク"],
      }),
      moveOperation({ opId: "op-2" }),
    ),
    [STATUS.OPERATION_INTERDEPENDENT, STATUS.OPERATION_INTERDEPENDENT],
  );
});

test("an interfering pair does not drag unrelated operations down with it", () => {
  const statuses = statusesOf(
    moveFolder({ opId: "op-1" }),
    moveOperation({
      opId: "op-2",
      bookmarkId: "100",
      expectedTitle: "Chrome API",
      expectedUrl:
        "https://developer.chrome.com/docs/extensions/reference/api/bookmarks",
      currentPath: ["ブックマーク バー", "Dev", "Chrome API"],
      destinationPath: ["ブックマーク バー", "Shared"],
    }),
    moveOperation({
      opId: "op-3",
      bookmarkId: "110",
      expectedTitle: "Docs",
      expectedUrl: "https://example.com/a?utm_source=x",
      currentPath: ["ブックマーク バー", "Docs"],
      destinationPath: ["その他のブックマーク"],
    }),
  );
  assert.deepEqual(statuses, [
    STATUS.OPERATION_INTERDEPENDENT,
    STATUS.OPERATION_INTERDEPENDENT,
    STATUS.MOVABLE,
  ]);
});
