import assert from "node:assert/strict";
import test from "node:test";

import {
  RESTORE_SKIP,
  authorizeRestoreMove,
  buildRestoreMoves,
  buildSnapshotDocument,
  nodeIdentityMatches,
  provenanceReport,
  validateSnapshotDocument,
} from "../extension/src/core/snapshot-restore.js";
import { flattenTree, indexById } from "../extension/src/core/tree-model.js";
import {
  MAX_PLAN_ERRORS,
  MAX_SNAPSHOT_NODES,
} from "../extension/src/core/limits.js";
import { sampleTree, snapshotFrom } from "./fixtures/sample-tree.js";

const entries = flattenTree(sampleTree());
const snapshot = snapshotFrom(entries);
const byId = indexById(entries);

/** Moves "200" out of "その他のブックマーク" into "Dev", as an Apply would have. */
function movedTree() {
  const moved = entries.map((entry) => {
    if (entry.id === "200") return { ...entry, parentId: "10", index: 2 };
    if (entry.id === "201") return { ...entry, index: 0 };
    return entry;
  });
  return indexById(moved);
}

test("what the exporter writes is what the validator accepts", () => {
  // The file the user re-selects has to satisfy the gate that reads it back.
  const written = buildSnapshotDocument(entries, {
    treeDigest: "abc",
    exportedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(validateSnapshotDocument(written).errors, []);
  assert.equal(
    written.nodes.length,
    entries.filter((entry) => !entry.isRoot).length,
    "permanent roots are kept, only the tree root is dropped",
  );
  assert.equal(
    provenanceReport(written, byId).accepted,
    true,
    "a snapshot of this profile must be recognised as this profile's",
  );
});

test("a snapshot larger than one profile could be is refused before the walk", () => {
  const oversized = {
    ...snapshot,
    nodes: { length: MAX_SNAPSHOT_NODES + 1 },
  };
  // A plain object with a length is not an array, so make it one cheaply.
  oversized.nodes = Array.from({ length: MAX_SNAPSHOT_NODES + 1 }, () => ({}));
  const result = validateSnapshotDocument(oversized);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1, "it must not walk the nodes first");
  assert.equal(result.errors[0].key, "snapshot.tooManyNodes");
});

test("a broken snapshot cannot build an unbounded error report", () => {
  const broken = {
    ...snapshot,
    nodes: Array.from({ length: MAX_PLAN_ERRORS * 3 }, () => ({})),
  };
  assert.ok(
    validateSnapshotDocument(broken).errors.length <= MAX_PLAN_ERRORS,
    "the error list is what the UI renders, so it is capped",
  );
});

test("a snapshot from the wrong shape is rejected with paths", () => {
  assert.equal(validateSnapshotDocument(snapshot).ok, true);
  assert.deepEqual(
    validateSnapshotDocument([]).errors[0].key,
    "schema.notObject",
  );

  const wrongKind = validateSnapshotDocument({ ...snapshot, kind: "plan" });
  assert.equal(wrongKind.errors[0].key, "snapshot.kind");

  const badNode = validateSnapshotDocument({
    ...snapshot,
    nodes: [{ id: "", parentId: "1", index: -1, title: 5, url: 7 }],
  });
  assert.deepEqual(
    badNode.errors.map((error) => error.key),
    [
      "snapshot.nodeId",
      "snapshot.nodeIndex",
      "snapshot.nodeTitle",
      "snapshot.nodeUrl",
    ],
  );
});

test("provenance accepts the profile it was taken from", () => {
  const report = provenanceReport(snapshot, byId);
  assert.equal(report.matched, report.total);
  assert.equal(report.accepted, true);
});

test("provenance rejects a snapshot from another profile", () => {
  const foreign = {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => ({
      ...node,
      title: `${node.title} (other)`,
    })),
  };
  const report = provenanceReport(foreign, byId);
  assert.ok(report.rate < 0.9);
  assert.equal(report.accepted, false);
});

test("permanent roots match on identity and kind, not on their localized title", () => {
  const renamedRoot = { ...snapshot.nodes[0], title: "Bookmarks bar" };
  assert.equal(
    nodeIdentityMatches(renamedRoot, byId.get(renamedRoot.id), {
      relaxed: true,
    }),
    true,
  );
  assert.equal(
    nodeIdentityMatches(renamedRoot, byId.get(renamedRoot.id)),
    false,
  );
});

test("restore emits the moves in snapshot order so earlier slots exist first", () => {
  const { moves, skipped } = buildRestoreMoves(snapshot, movedTree());
  assert.deepEqual(
    moves.map((move) => [
      move.bookmarkId,
      move.targetParentId,
      move.targetIndex,
    ]),
    [
      ["200", "2", 0],
      ["201", "2", 1],
    ],
  );
  assert.deepEqual(skipped, []);
});

test("restoring the tree it was taken from is a no-op", () => {
  assert.deepEqual(buildRestoreMoves(snapshot, byId).moves, []);
});

test("a node whose identity no longer matches is skipped, never moved", () => {
  const live = movedTree();
  live.set("200", { ...live.get("200"), title: "Renamed by someone else" });
  const { moves, skipped } = buildRestoreMoves(snapshot, live);
  assert.deepEqual(
    moves.map((move) => move.bookmarkId),
    ["201"],
  );
  assert.deepEqual(skipped, [{ id: "200", key: RESTORE_SKIP.NODE_MISMATCH }]);
});

test("a destination folder that no longer matches blocks the move", () => {
  const live = movedTree();
  live.set("2", { ...live.get("2"), isFolder: false });
  const { moves, skipped } = buildRestoreMoves(snapshot, live);
  assert.deepEqual(moves, []);
  assert.deepEqual(
    skipped.map((item) => item.key),
    [RESTORE_SKIP.PARENT_MISSING, RESTORE_SKIP.PARENT_MISSING],
  );
});

test("an ancestor of the destination that does not match blocks the move", () => {
  const live = indexById(
    entries.map((entry) =>
      entry.id === "100" ? { ...entry, parentId: "11", index: 0 } : entry,
    ),
  );
  live.set("10", { ...live.get("10"), title: "Dev (renamed)" });
  const { moves, skipped } = buildRestoreMoves(snapshot, live);
  assert.deepEqual(moves, []);
  assert.ok(skipped.some((item) => item.key === RESTORE_SKIP.PARENT_MISMATCH));
});

test("unmodifiable nodes are never restored", () => {
  const live = indexById(
    entries.map((entry) =>
      entry.id === "400" ? { ...entry, parentId: "2", index: 2 } : entry,
    ),
  );
  const { moves, skipped } = buildRestoreMoves(snapshot, live);
  assert.deepEqual(moves, []);
  assert.deepEqual(skipped, [{ id: "400", key: RESTORE_SKIP.UNMODIFIABLE }]);
});

test("a node that no longer exists is reported instead of recreated", () => {
  const live = new Map(byId);
  live.delete("200");
  const { moves, skipped } = buildRestoreMoves(snapshot, live);
  assert.deepEqual(moves, []);
  assert.deepEqual(skipped, [{ id: "200", key: RESTORE_SKIP.NODE_MISSING }]);
});

test("restoring never crosses the account/local boundary", () => {
  // "300" lived under the local root; something dragged it into a synced root.
  const raw = sampleTree();
  const [root] = raw;
  const local = root.children.find((node) => node.id === "3");
  const other = root.children.find((node) => node.id === "2");
  const [moved] = local.children.splice(0, 1);
  other.children.push({ ...moved, parentId: "2", index: 2, syncing: true });
  const live = indexById(flattenTree(raw));

  const { moves, skipped } = buildRestoreMoves(snapshot, live);
  assert.deepEqual(moves, []);
  assert.deepEqual(skipped, [{ id: "300", key: RESTORE_SKIP.BOUNDARY }]);
});

test("authorization is re-checkable, which is what the runner calls before each move", () => {
  const live = movedTree();
  assert.equal(authorizeRestoreMove(snapshot, live, "200"), null);

  // The same call after the node drifts is what stops a stale preview.
  live.set("200", { ...live.get("200"), url: "https://example.com/changed" });
  assert.equal(
    authorizeRestoreMove(snapshot, live, "200"),
    RESTORE_SKIP.NODE_MISMATCH,
  );
});

test("a destination folder that itself moved is refused, not followed", () => {
  // "Dev" still matches by identity, but it now hangs off another root, so
  // restoring into it would put the node on a path the snapshot never had.
  const raw = sampleTree();
  const [root] = raw;
  const bar = root.children.find((node) => node.id === "1");
  const other = root.children.find((node) => node.id === "2");
  const [dev] = bar.children.splice(0, 1);
  other.children.push({ ...dev, parentId: "2", index: 2 });
  const live = indexById(flattenTree(raw));

  assert.equal(
    authorizeRestoreMove(snapshot, live, "100"),
    RESTORE_SKIP.PARENT_MISMATCH,
  );
});
