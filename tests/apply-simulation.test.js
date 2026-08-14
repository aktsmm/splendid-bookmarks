import assert from "node:assert/strict";
import test from "node:test";

import {
  describeTreeDrift,
  projectTreeAfterMove,
} from "../extension/src/core/apply-simulation.js";
import {
  canonicalTreeString,
  flattenTree,
} from "../extension/src/core/tree-model.js";
import { sampleTree } from "./fixtures/sample-tree.js";

const entries = flattenTree(sampleTree());
const positionOf = (list, id) => {
  const entry = list.find((item) => item.id === id);
  return [entry.parentId, entry.index];
};

test("a cross-parent move reindexes both the old and the new parent", () => {
  // "200" is index 0 of "2"; "201" follows it. The destination "10" has 2 children.
  const after = projectTreeAfterMove(entries, {
    bookmarkId: "200",
    targetParentId: "10",
    targetIndex: 2,
  });
  assert.deepEqual(positionOf(after, "200"), ["10", 2]);
  assert.deepEqual(positionOf(after, "201"), ["2", 0]);
  assert.deepEqual(positionOf(after, "100"), ["10", 0]);
  assert.deepEqual(positionOf(after, "101"), ["10", 1]);
});

test("inserting ahead of existing children pushes them down", () => {
  const after = projectTreeAfterMove(entries, {
    bookmarkId: "200",
    targetParentId: "10",
    targetIndex: 0,
  });
  assert.deepEqual(positionOf(after, "200"), ["10", 0]);
  assert.deepEqual(positionOf(after, "100"), ["10", 1]);
  assert.deepEqual(positionOf(after, "101"), ["10", 2]);
});

test("a same-parent move is remove-then-insert, so siblings settle once", () => {
  // "110" is index 2 of "1"; moving it to index 0 shifts "10" and "11" down.
  const after = projectTreeAfterMove(entries, {
    bookmarkId: "110",
    targetParentId: "1",
    targetIndex: 0,
  });
  assert.deepEqual(positionOf(after, "110"), ["1", 0]);
  assert.deepEqual(positionOf(after, "10"), ["1", 1]);
  assert.deepEqual(positionOf(after, "11"), ["1", 2]);
});

test("an unknown bookmark id cannot be projected", () => {
  assert.equal(
    projectTreeAfterMove(entries, {
      bookmarkId: "nope",
      targetParentId: "10",
      targetIndex: 0,
    }),
    null,
  );
});

test("the projection is the digest input the runner compares against", () => {
  const move = { bookmarkId: "200", targetParentId: "10", targetIndex: 2 };
  const expected = canonicalTreeString(projectTreeAfterMove(entries, move));
  assert.notEqual(expected, canonicalTreeString(entries));

  // Applying the same move to the real tree must reproduce it byte for byte.
  const real = flattenTree(sampleTree()).map((entry) => ({ ...entry }));
  const node = real.find((entry) => entry.id === "200");
  for (const entry of real) {
    if (entry.parentId === node.parentId && entry.index > node.index) {
      entry.index -= 1;
    }
  }
  for (const entry of real) {
    if (entry.parentId === "10" && entry.index >= 2) entry.index += 1;
  }
  node.parentId = "10";
  node.index = 2;
  assert.equal(canonicalTreeString(real), expected);
});

test("drift names the node and the field that moved", () => {
  const actual = flattenTree(sampleTree()).map((entry) =>
    entry.id === "110" ? { ...entry, title: "Renamed" } : entry,
  );
  const drift = describeTreeDrift(entries, actual);
  assert.equal(drift.total, 1);
  assert.deepEqual(drift.changes[0], {
    id: "110",
    field: "title",
    expected: "Docs",
    actual: "Renamed",
  });
});

test("a syncing flip is reported as such, not as a structural change", () => {
  const actual = flattenTree(sampleTree()).map((entry) =>
    entry.id === "300" ? { ...entry, syncing: true } : entry,
  );
  const drift = describeTreeDrift(entries, actual);
  assert.deepEqual(
    drift.changes.map((change) => change.field),
    ["syncing"],
  );
});

test("appearing and disappearing nodes are both reported", () => {
  const removed = entries.filter((entry) => entry.id !== "201");
  assert.equal(
    describeTreeDrift(entries, removed).changes[0].field,
    "existence",
  );
  assert.equal(
    describeTreeDrift(removed, entries).changes[0].field,
    "existence",
  );
});
