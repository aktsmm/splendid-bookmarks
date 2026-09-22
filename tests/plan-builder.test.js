import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPlanFromProposal,
  buildPlanFromSelection,
  pruneCoveredSelection,
  selectableEntries,
  selectedEntries,
} from "../extension/src/core/plan-builder.js";
import { validatePlanDocument } from "../extension/src/core/plan-schema.js";
import { STATUS, dryRun } from "../extension/src/core/validator.js";
import { flattenTree, indexById } from "../extension/src/core/tree-model.js";
import { sampleTree } from "./fixtures/sample-tree.js";

const entries = flattenTree(sampleTree());
const byId = indexById(entries);
const idsOf = (list) => list.map((entry) => entry.id);

const proposal = (overrides = {}) => ({
  snapshotId: "session:1",
  scopeFolderId: null,
  moves: [
    {
      bookmarkId: "200",
      destinationFolderId: "10",
      reason: "developer resource",
    },
  ],
  ...overrides,
});
const prepare = (input, overrides = {}) =>
  buildPlanFromProposal(input, {
    entries,
    snapshotId: "session:1",
    scopeFolderId: null,
    generatedAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  });

test("compact proposals resolve identities and pass the existing schema and dry run", () => {
  const result = prepare(proposal());
  assert.equal(result.accepted, true);
  assert.equal(validatePlanDocument(result.plan).ok, true);
  assert.equal(result.movableCount, 1);
  assert.equal(result.plan.operations[0].expectedTitle, byId.get("200").title);
  assert.equal(result.plan.operations[0].opId, "agent-0001");
});

test("proposals reject stale snapshots, other sessions and changed or missing scopes", () => {
  for (const snapshotId of ["session:0", "other:1"]) {
    assert.throws(() => prepare(proposal({ snapshotId })), {
      key: "agent.error.staleProposal",
    });
  }
  for (const scopeFolderId of ["1", "gone", "200"]) {
    assert.throws(
      () => prepare(proposal({ scopeFolderId }), { scopeFolderId }),
      { key: "agent.error.proposalScope" },
    );
  }
  assert.throws(() => prepare(proposal(), { scopeFolderId: "2" }), {
    key: "agent.error.proposalScope",
  });
  assert.equal(
    prepare(proposal({ scopeFolderId: "2" }), { scopeFolderId: "2" }).accepted,
    true,
  );
});

test("proposals reject missing identities and unusable destinations without skipping", () => {
  for (const bookmarkId of ["gone", "0", "1"]) {
    assert.throws(
      () =>
        prepare(proposal({ moves: [{ ...proposal().moves[0], bookmarkId }] })),
      { key: "agent.error.proposalSource" },
    );
  }
  for (const destinationFolderId of ["gone", "0", "100"]) {
    assert.throws(
      () =>
        prepare(
          proposal({
            moves: [{ ...proposal().moves[0], destinationFolderId }],
          }),
        ),
      { key: "agent.error.proposalDestination" },
    );
  }
});

test("proposals retain duplicate and covered selections for whole-plan rejection", () => {
  for (const bookmarkIds of [
    ["200", "200"],
    ["10", "100"],
  ]) {
    const result = prepare(
      proposal({
        moves: bookmarkIds.map((bookmarkId) => ({
          bookmarkId,
          destinationFolderId: "11",
          reason: "group",
        })),
      }),
    );
    assert.equal(result.accepted, false);
    assert.equal(result.plan, null);
    assert.equal(result.rows.length, 2);
    assert.ok(result.blockedCount > 0);
  }
});

test("proposals reject cross-boundary, protected, cyclic and no-op moves", () => {
  for (const [bookmarkId, destinationFolderId] of [
    ["200", "300"],
    ["400", "300"],
    ["10", "101"],
    ["100", "10"],
    ["200", "4"],
  ]) {
    const result = prepare(
      proposal({
        moves: [{ bookmarkId, destinationFolderId, reason: "group" }],
      }),
    );
    assert.equal(result.accepted, false);
    assert.equal(result.plan, null);
  }
});

test("unknown synchronization boundaries never match each other", () => {
  const unknown = entries.map((entry) => ({ ...entry, syncing: null }));
  assert.throws(() => prepare(proposal(), { entries: unknown }), {
    key: "agent.error.proposalBoundary",
  });
});

test("scope limits sources, while destinations can be outside it in the same boundary", () => {
  const result = prepare(
    proposal({
      scopeFolderId: "10",
      moves: [
        { bookmarkId: "100", destinationFolderId: "11", reason: "group" },
      ],
    }),
    { scopeFolderId: "10" },
  );
  assert.equal(result.accepted, true);
  assert.equal(result.plan.operations[0].destinationFolderId, "11");
});

const build = (selectedIds, destinationFolderId) =>
  buildPlanFromSelection({
    entries,
    byId,
    selectedIds,
    destinationFolderId,
    reason: "picked by hand",
    generatedAt: "2026-08-13T00:00:00.000Z",
  });

test("roots and permanent roots are never selectable", () => {
  const offered = idsOf(selectableEntries(entries, { byId }));
  for (const rootId of ["0", "1", "2", "3", "4"]) {
    assert.ok(!offered.includes(rootId), `${rootId} must not be selectable`);
  }
  assert.ok(offered.includes("200"));
});

test("the scope narrows the list to one subtree", () => {
  const offered = idsOf(
    selectableEntries(entries, { scopeFolderId: "1", byId }),
  );
  assert.deepEqual(offered.sort(), ["10", "100", "101", "11", "110"].sort());
});

test("the filter matches title and url, case-insensitively", () => {
  assert.deepEqual(
    idsOf(selectableEntries(entries, { query: "nested", byId })),
    ["101"],
  );
  assert.deepEqual(
    idsOf(selectableEntries(entries, { query: "UTM_SOURCE", byId })),
    ["110"],
  );
  // A url match counts even when the title says nothing about it.
  assert.deepEqual(
    idsOf(selectableEntries(entries, { query: "developer.chrome.com", byId })),
    ["100"],
  );
});

test("the selection resolves against the live tree and reports what is gone", () => {
  const { resolved, missing } = selectedEntries(
    new Set(["200", "gone", "1"]),
    byId,
  );
  assert.deepEqual(idsOf(resolved), ["200"]);
  // A permanent root can never be a selection, so it is reported, not silently kept.
  assert.deepEqual(missing.sort(), ["1", "gone"]);
});

test("a selection covered by a selected folder is dropped", () => {
  const { kept, dropped } = pruneCoveredSelection(["10", "100", "200"], byId);
  assert.deepEqual(kept.sort(), ["10", "200"]);
  assert.deepEqual(dropped, ["100"]);
});

test("the built plan passes the same schema an agent plan does", () => {
  const { plan } = build(new Set(["200"]), "10");
  assert.equal(validatePlanDocument(plan).ok, true);
  // Pinned as a literal: the builder, the agent context and the validator must
  // agree on one number, and reading the constant back would hide a drift.
  assert.equal(plan.version, 2);
  assert.deepEqual(plan.operations[0], {
    opId: "local-0001",
    type: "move",
    bookmarkId: "200",
    expectedTitle: "Loose",
    expectedUrl: "https://example.com/a/",
    currentPath: ["その他のブックマーク", "Loose"],
    destinationPath: ["ブックマーク バー", "Dev"],
    destinationFolderId: "10",
    reason: "picked by hand",
    confidence: 1,
  });
});

test("the built plan is movable against the tree it was built from", () => {
  const { plan } = build(new Set(["200", "201"]), "11");
  const result = dryRun(plan, entries);
  assert.deepEqual(
    result.rows.map((row) => row.status),
    [STATUS.MOVABLE, STATUS.MOVABLE],
  );
  assert.equal(result.blockedCount, 0);
});

test("dropping covered selections is what keeps the plan applicable", () => {
  const { plan, dropped } = build(new Set(["10", "100"]), "11");
  assert.deepEqual(dropped, ["100"]);
  assert.deepEqual(
    dryRun(plan, entries).rows.map((row) => row.status),
    [STATUS.MOVABLE],
  );

  // Without the pruning the same selection is refused outright.
  const unpruned = {
    version: 1,
    operations: ["10", "100"].map((id, i) => ({
      ...plan.operations[0],
      opId: `x-${i}`,
      bookmarkId: id,
      expectedTitle: byId.get(id).title,
      expectedUrl: byId.get(id).url,
      currentPath: byId.get(id).path,
    })),
  };
  assert.deepEqual(
    dryRun(unpruned, entries).rows.map((row) => row.status),
    [STATUS.OPERATION_INTERDEPENDENT, STATUS.OPERATION_INTERDEPENDENT],
  );
});

test("a missing or unusable destination yields no plan at all", () => {
  assert.equal(build(new Set(["200"]), "").plan, null);
  assert.equal(build(new Set(["200"]), "nope").plan, null);
  // A bookmark is not a folder, and the tree root is not a destination.
  assert.equal(build(new Set(["200"]), "110").plan, null);
  assert.equal(build(new Set(["200"]), "0").plan, null);
});

test("selecting something already in the destination is a no-op, not a refusal", () => {
  const { plan } = build(new Set(["100"]), "10");
  assert.deepEqual(
    dryRun(plan, entries).rows.map((row) => row.status),
    [STATUS.NO_OP],
  );
});
