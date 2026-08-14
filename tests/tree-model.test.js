import assert from "node:assert/strict";
import test from "node:test";

import {
  boundaryKey,
  canonicalTreeString,
  countUrls,
  flattenTree,
  foldersByPermanentRoot,
  indexById,
  isBoundaryIndeterminate,
  isDescendantOf,
  resolveFolderPath,
  topAncestorOf,
} from "../extension/src/core/tree-model.js";
import { sampleTree } from "./fixtures/sample-tree.js";

const entries = flattenTree(sampleTree());
const byId = indexById(entries);

test("flattenTree marks the tree root and the permanent roots", () => {
  const root = byId.get("0");
  assert.equal(root.isRoot, true);
  assert.equal(root.isPermanentRoot, false);
  assert.equal(byId.get("1").isPermanentRoot, true);
  assert.equal(byId.get("10").isPermanentRoot, false);
});

test("paths exclude the tree root and keep segment order", () => {
  assert.deepEqual(byId.get("100").path, [
    "ブックマーク バー",
    "Dev",
    "Chrome API",
  ]);
  assert.equal(byId.get("100").depth, 3);
});

test("topAncestorOf resolves to the permanent root", () => {
  assert.equal(topAncestorOf(byId.get("100"), byId).id, "1");
  assert.equal(topAncestorOf(byId.get("300"), byId).id, "3");
  assert.equal(topAncestorOf(byId.get("0"), byId), null);
});

test("boundaryKey separates the account tree from the local tree", () => {
  const accountBar = boundaryKey(topAncestorOf(byId.get("100"), byId));
  const accountOther = boundaryKey(topAncestorOf(byId.get("200"), byId));
  const localBar = boundaryKey(topAncestorOf(byId.get("300"), byId));
  assert.equal(accountBar, "syncing:true");
  assert.equal(
    accountOther,
    accountBar,
    "bar and other in the same store share a boundary",
  );
  assert.notEqual(accountBar, localBar);
  assert.equal(boundaryKey(null), null);
});

test("boundary is indeterminate when syncing is absent", () => {
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
            {
              id: "10",
              parentId: "1",
              index: 0,
              title: "Item",
              url: "https://example.com/",
            },
          ],
        },
      ],
    },
  ]);
  const legacyById = indexById(legacy);
  assert.equal(isBoundaryIndeterminate(legacyById.get("10"), legacyById), true);
  assert.equal(isBoundaryIndeterminate(byId.get("100"), byId), false);
});

test("isDescendantOf walks up the parent chain", () => {
  assert.equal(isDescendantOf("101", "10", byId), true);
  assert.equal(isDescendantOf("101", "1", byId), true);
  assert.equal(isDescendantOf("10", "101", byId), false);
});

test("resolveFolderPath reports ambiguity instead of guessing", () => {
  assert.equal(
    resolveFolderPath(["ブックマーク バー", "Dev"], entries).length,
    1,
  );
  assert.equal(
    resolveFolderPath(["ブックマーク バー", "Nope"], entries).length,
    0,
  );
  assert.equal(resolveFolderPath([], entries).length, 0);

  const ambiguous = flattenTree([
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
  assert.equal(resolveFolderPath(["Bar", "Dup"], ambiguous).length, 2);
});

test("foldersByPermanentRoot groups every folder under its own root", () => {
  const groups = foldersByPermanentRoot(entries);
  const titles = groups.map((group) => group.root.title);
  assert.deepEqual(titles, [
    "ブックマーク バー",
    "その他のブックマーク",
    "ローカル ブックマーク バー",
    "管理対象",
  ]);

  const bar = groups.find((group) => group.root.id === "1");
  assert.deepEqual(bar.folders.map((folder) => folder.id).sort(), [
    "1",
    "10",
    "101",
    "11",
  ]);

  // Every folder appears exactly once across all groups.
  const all = groups.flatMap((group) => group.folders.map((f) => f.id));
  assert.equal(new Set(all).size, all.length);
  assert.equal(
    all.length,
    entries.filter((entry) => entry.isFolder && !entry.isRoot).length,
  );
});

test("picker labels drop the root, but keep it when that would collide", () => {
  const groups = foldersByPermanentRoot(entries);
  const labelOf = (id) =>
    groups.flatMap((group) => group.folders).find((f) => f.id === id).label;

  // Unique below its root, so the group label carries the context.
  assert.equal(labelOf("10"), "Dev");
  // The permanent root itself has nothing left after stripping.
  assert.equal(labelOf("1"), "ブックマーク バー");
  // "Shared" exists under two roots, so both keep the full path.
  assert.equal(labelOf("11"), "ブックマーク バー / Shared");
  assert.equal(labelOf("201"), "その他のブックマーク / Shared");

  const labels = groups.flatMap((group) =>
    group.folders.map((folder) => folder.label),
  );
  assert.equal(new Set(labels).size, labels.length, "labels must be unique");
});

test("countUrls ignores folders and the tree root", () => {
  assert.equal(countUrls(entries), 4);
});

test("canonicalTreeString is deterministic and order-independent", () => {
  const a = canonicalTreeString(entries);
  const b = canonicalTreeString([...entries].reverse());
  assert.equal(a, b);
  assert.equal(a.split("\u001e").length, entries.length - 1);
});

test("canonicalTreeString changes when a node moves", () => {
  const moved = sampleTree();
  moved[0].children[1].children[0].parentId = "10";
  assert.notEqual(
    canonicalTreeString(entries),
    canonicalTreeString(flattenTree(moved)),
  );
});
