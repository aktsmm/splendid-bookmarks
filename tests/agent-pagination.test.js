import assert from "node:assert/strict";
import test from "node:test";
import {
  paginateEntries,
  validateInvocation,
} from "../extension/src/core/agent-command.js";

const entries = Array.from({ length: 1203 }, (_, index) => ({
  id: String(index),
}));
const scope = { command: "getTree", snapshotId: "page-one:1" };

test("all pages preserve order and contain every node exactly once", () => {
  const collected = [];
  let cursor;
  do {
    const page = paginateEntries(entries, { ...scope, cursor });
    assert.equal(page.total, entries.length);
    assert.ok(page.shown.length <= 500);
    assert.equal(page.truncated, page.nextCursor !== null);
    collected.push(...page.shown);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(collected, entries);
  assert.equal(
    new Set(collected.map((entry) => entry.id)).size,
    entries.length,
  );
});

test("empty and exact-boundary pages finish without a cursor", () => {
  for (const count of [0, 1, 500]) {
    const page = paginateEntries(entries.slice(0, count), scope);
    assert.equal(page.total, count);
    assert.equal(page.shown.length, count);
    assert.equal(page.truncated, false);
    assert.equal(page.nextCursor, null);
  }
});

test("search pagination is bound to the exact query and command", () => {
  const search = {
    command: "search",
    query: "Startup",
    snapshotId: "page-one:1",
    limit: 2,
  };
  const first = paginateEntries(entries.slice(0, 3), search);
  const second = paginateEntries(entries.slice(0, 3), {
    ...search,
    cursor: first.nextCursor,
  });
  assert.deepEqual(second.shown, entries.slice(2, 3));
  for (const changed of [{ ...scope }, { ...search, query: "Other" }]) {
    assert.throws(
      () => paginateEntries(entries, { ...changed, cursor: first.nextCursor }),
      (error) => error.key === "agent.error.cursorMismatch",
    );
  }
});

test("reloaded trees and different pages reject a stale cursor", () => {
  const { nextCursor } = paginateEntries(entries, scope);
  for (const snapshotId of ["page-one:2", "page-two:1"]) {
    assert.throws(
      () =>
        paginateEntries(entries, { ...scope, snapshotId, cursor: nextCursor }),
      (error) => error.key === "agent.error.staleCursor",
    );
  }
});

test("malformed cursor inputs are refused before dispatch", () => {
  const { nextCursor } = paginateEntries(entries, scope);
  for (const cursor of [
    null,
    [],
    "cursor",
    {},
    { ...nextCursor, extra: true },
    { ...nextCursor, offset: -1 },
    { ...nextCursor, offset: 0 },
    { ...nextCursor, offset: 1.5 },
    { ...nextCursor, offset: Number.MAX_SAFE_INTEGER + 1 },
    { ...nextCursor, snapshotId: "" },
    { ...nextCursor, snapshotId: "x".repeat(161) },
    { ...nextCursor, command: null },
    { ...nextCursor, query: null },
  ]) {
    const check = validateInvocation("getTree", { cursor });
    assert.equal(check.ok, false);
    assert.equal(check.key, "agent.error.cursor");
  }
});

test("out-of-range offsets and oversized limits cannot bypass the page cap", () => {
  const { nextCursor } = paginateEntries(entries, scope);
  assert.throws(
    () =>
      paginateEntries(entries, {
        ...scope,
        cursor: { ...nextCursor, offset: entries.length + 1 },
      }),
    (error) => error.key === "agent.error.cursor",
  );
  assert.throws(
    () => paginateEntries(entries, { ...scope, limit: 501 }),
    (error) => error.key === "agent.error.limit",
  );
});
