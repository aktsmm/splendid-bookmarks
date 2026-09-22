import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { buildAgentTreeRows } from "../extension/src/core/agent-export.js";
import { flattenTree } from "../extension/src/core/tree-model.js";
import {
  paginateEntries,
  validateInvocation,
} from "../extension/src/core/agent-command.js";

const entries = Array.from({ length: 1203 }, (_, index) => ({
  id: String(index),
}));
const scope = { command: "getTree", snapshotId: "page-one:1" };

test("page handlers only build returned rows and resolve roots outside the page", () => {
  const source = readFileSync(
    new URL("../extension/ui/options.js", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const tree = flattenTree([
    {
      id: "0",
      children: [
        {
          id: "1",
          parentId: "0",
          title: "Bar",
          syncing: true,
          children: Array.from({ length: 1200 }, (_, index) => ({
            id: `bookmark-${index}`,
            parentId: "1",
            syncing: true,
            title: index % 200 === 0 ? "Needle" : "Other",
            url: `https://example.com/${index}`,
          })),
        },
      ],
    },
  ]);
  for (const command of ["getTree", "search"]) {
    const handler = new RegExp(
      `${command}: (\\(\\{[^\\n]+\\}\\) => \\{[\\s\\S]*?\\n  \\}),`,
    ).exec(source)?.[1];
    assert.ok(handler, command);
    const projected = [];
    let blocked = false;
    const run = runInNewContext(`(${handler})`, {
      requireTree: () => {
        if (blocked) throw new Error("read locked");
        return tree;
      },
      agentSnapshotId: () => scope.snapshotId,
      paginateEntries,
      buildAgentTreeRows: (allEntries, selected = allEntries) => {
        assert.equal(allEntries, tree);
        projected.push(...selected.map((entry) => entry.id));
        assert.ok(selected.length <= 500);
        return buildAgentTreeRows(allEntries, selected);
      },
    });
    let cursor;
    const collected = [];
    do {
      const page = run({ limit: 500, query: "Needle", cursor });
      assert.equal(page.snapshotId, scope.snapshotId);
      collected.push(...page.shown);
      cursor = page.nextCursor;
    } while (cursor);
    const expected =
      command === "getTree"
        ? tree
        : tree.filter((entry) => entry.title === "Needle");
    assert.deepEqual(
      projected,
      expected.map((entry) => entry.id),
    );
    assert.deepEqual(collected, buildAgentTreeRows(tree, expected));
    assert.ok(
      collected
        .filter((entry) => !entry.isFolder)
        .every((entry) => entry.boundary === "syncing:true"),
    );
    const count = projected.length;
    assert.throws(
      () =>
        run({
          query: "Needle",
          cursor: {
            snapshotId: "old:1",
            offset: 500,
            command,
            query: command === "search" ? "Needle" : "",
          },
        }),
      (error) => error.key === "agent.error.staleCursor",
    );
    blocked = true;
    assert.throws(() => run({ query: "Needle" }), /read locked/);
    assert.equal(projected.length, count);
  }
});

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
