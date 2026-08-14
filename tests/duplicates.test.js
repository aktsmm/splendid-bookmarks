import assert from "node:assert/strict";
import test from "node:test";

import {
  SKIP,
  findDuplicateGroups,
  normalizeUrl,
  quarantineSelection,
  unparsableUrls,
} from "../extension/src/core/duplicates.js";
import { flattenTree } from "../extension/src/core/tree-model.js";
import { sampleTree } from "./fixtures/sample-tree.js";

const entries = flattenTree(sampleTree());

test("normalizeUrl strips fragments, tracking params, www and a trailing slash", () => {
  assert.equal(
    normalizeUrl("https://www.example.com/a/?utm_source=x#frag"),
    "https://example.com/a",
  );
  assert.equal(normalizeUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(normalizeUrl("HTTPS://Example.COM/a/"), "https://example.com/a");
});

test("normalizeUrl keeps meaningful query parameters and sorts them", () => {
  assert.equal(
    normalizeUrl("https://example.com/s?b=2&a=1"),
    "https://example.com/s?a=1&b=2",
  );
  assert.notEqual(
    normalizeUrl("https://example.com/a"),
    normalizeUrl("https://example.com/b"),
  );
});

test("normalizeUrl returns null for values it cannot parse", () => {
  assert.equal(normalizeUrl("not a url"), null);
  assert.equal(normalizeUrl(""), null);
  assert.equal(normalizeUrl(undefined), null);
});

test("normalized mode finds near-duplicates that exact mode misses", () => {
  assert.equal(findDuplicateGroups(entries, "exact").length, 0);

  const normalized = findDuplicateGroups(entries, "normalized");
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].key, "https://example.com/a");
  assert.deepEqual(normalized[0].members.map((member) => member.id).sort(), [
    "110",
    "200",
  ]);
});

test("folders never enter a duplicate group", () => {
  const ids = findDuplicateGroups(entries, "normalized").flatMap((group) =>
    group.members.map((m) => m.id),
  );
  assert.equal(
    ids.some((id) => id === "11" || id === "201"),
    false,
  );
});

test("unparsable URLs are reported instead of silently dropped", () => {
  const broken = flattenTree([
    {
      id: "0",
      title: "",
      children: [
        {
          id: "1",
          parentId: "0",
          index: 0,
          title: "Bar",
          syncing: true,
          children: [
            {
              id: "10",
              parentId: "1",
              index: 0,
              title: "Broken",
              url: "javascript",
              syncing: true,
            },
          ],
        },
      ],
    },
  ]);
  assert.deepEqual(
    unparsableUrls(broken).map((entry) => entry.id),
    ["10"],
  );
});

const QUARANTINE = "quarantine";

const group = (key, ids, extra = {}) => ({
  key,
  members: ids.map((id) => ({ id })),
  ...extra,
});

function quarantine(groups, keep, overrides = {}) {
  return quarantineSelection({
    groups,
    keepByKey: new Map(Object.entries(keep)),
    destinationFolderId: QUARANTINE,
    destinationBoundary: "syncing:false",
    boundaryOf: () => "syncing:false",
    parentOf: () => "elsewhere",
    alreadySelected: new Set(),
    remainingCapacity: 200,
    ...overrides,
  });
}

const reasons = (result) => result.skipped.map((item) => item.reason);

test("quarantine keeps the chosen member and offers every other copy", () => {
  const result = quarantine([group("k", ["a", "b", "c"])], { k: "a" });
  assert.deepEqual(result.addIds, ["b", "c"]);
  assert.deepEqual(result.keptIds, ["a"]);
  assert.deepEqual(result.skipped, []);
});

test("quarantine never picks a keeper on the user's behalf", () => {
  const result = quarantine(
    [group("k1", ["a", "b"]), group("k2", ["c", "d"])],
    {},
  );
  assert.deepEqual(result.addIds, []);
  assert.deepEqual(reasons(result), [SKIP.NO_KEEPER, SKIP.NO_KEEPER]);
});

test("quarantine refuses a keeper that is not in the group", () => {
  const result = quarantine([group("k", ["a", "b"])], { k: "gone" });
  assert.deepEqual(result.addIds, []);
  assert.deepEqual(reasons(result), [SKIP.STALE_KEEPER]);
});

test("quarantine refuses a group whose member list was cut for display", () => {
  const result = quarantine([group("k", ["a", "b"], { truncated: true })], {
    k: "a",
  });
  assert.deepEqual(result.addIds, []);
  assert.deepEqual(reasons(result), [SKIP.TRUNCATED]);
});

test("quarantine skips copies that already sit in the destination", () => {
  const result = quarantine(
    [group("k", ["a", "b", "c"])],
    { k: "a" },
    {
      parentOf: (id) => (id === "b" ? QUARANTINE : "elsewhere"),
    },
  );
  assert.deepEqual(result.addIds, ["c"]);
  assert.deepEqual(result.skipped, [
    { key: "k", reason: SKIP.ALREADY_THERE, count: 1 },
  ]);
});

test("quarantine skips copies whose sync boundary differs or cannot be proven", () => {
  const result = quarantine(
    [group("k", ["a", "b", "c", "d"])],
    { k: "a" },
    {
      boundaryOf: (id) => {
        if (id === "b") return "syncing:true";
        if (id === "c") return null;
        return "syncing:false";
      },
    },
  );
  assert.deepEqual(result.addIds, ["d"]);
  assert.deepEqual(result.skipped, [
    { key: "k", reason: SKIP.BOUNDARY, count: 2 },
  ]);
});

test("quarantine reports what did not fit in the remaining capacity", () => {
  const result = quarantine(
    [group("k", ["a", "b", "c", "d"])],
    { k: "a" },
    {
      remainingCapacity: 1,
    },
  );
  assert.deepEqual(result.addIds, ["b"]);
  assert.deepEqual(result.skipped, [
    { key: "k", reason: SKIP.LIMIT, count: 2 },
  ]);
});

test("a second send picks up where the first stopped instead of repeating it", () => {
  const groups = [group("k", ["a", "b", "c", "d", "e"])];
  const first = quarantine(groups, { k: "a" }, { remainingCapacity: 2 });
  assert.deepEqual(first.addIds, ["b", "c"]);

  const second = quarantine(
    groups,
    { k: "a" },
    {
      alreadySelected: new Set(first.addIds),
      remainingCapacity: 2,
    },
  );
  assert.deepEqual(second.addIds, ["d", "e"]);
});

test("capacity is shared across groups in report order", () => {
  const result = quarantine(
    [group("k1", ["a", "b", "c"]), group("k2", ["d", "e"])],
    { k1: "a", k2: "d" },
    { remainingCapacity: 2 },
  );
  assert.deepEqual(result.addIds, ["b", "c"]);
  assert.deepEqual(result.skipped, [
    { key: "k2", reason: SKIP.LIMIT, count: 1 },
  ]);
});
