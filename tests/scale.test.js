import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentContext } from "../extension/src/core/agent-export.js";
import { findDuplicateGroups } from "../extension/src/core/duplicates.js";
import {
  canonicalTreeString,
  countUrls,
  flattenTree,
} from "../extension/src/core/tree-model.js";

const FOLDERS = 100;
const PER_FOLDER = 50;

/** A tree roughly nine times the size of the real profile this tool targets. */
function wideTree() {
  const bar = {
    id: "1",
    parentId: "0",
    index: 0,
    title: "Bar",
    folderType: "bookmarks-bar",
    syncing: true,
    children: [],
  };
  for (let f = 0; f < FOLDERS; f += 1) {
    const folder = {
      id: `f${f}`,
      parentId: "1",
      index: f,
      title: `F${f}`,
      syncing: true,
      children: [],
    };
    for (let i = 0; i < PER_FOLDER; i += 1) {
      folder.children.push({
        id: `b${f}_${i}`,
        parentId: folder.id,
        index: i,
        title: `B${i}`,
        url: `https://example.com/${f}/${i}`,
        syncing: true,
      });
    }
    bar.children.push(folder);
  }
  return [{ id: "0", title: "", children: [bar] }];
}

function deepTree(depth) {
  const root = {
    id: "d0",
    parentId: "1",
    index: 0,
    title: "d0",
    syncing: true,
    children: [],
  };
  let current = root;
  for (let i = 1; i < depth; i += 1) {
    const child = {
      id: `d${i}`,
      parentId: `d${i - 1}`,
      index: 0,
      title: `d${i}`,
      syncing: true,
      children: [],
    };
    current.children.push(child);
    current = child;
  }
  return [{ id: "0", title: "", children: [root] }];
}

const entries = flattenTree(wideTree());

test("the core stays correct on a tree far larger than the target profile", () => {
  assert.equal(entries.length, 1 + 1 + FOLDERS + FOLDERS * PER_FOLDER);
  assert.equal(countUrls(entries), FOLDERS * PER_FOLDER);
  assert.equal(
    canonicalTreeString(entries).split("\u001e").length,
    entries.length - 1,
  );
});

test("the agent context stays internally consistent at scale", () => {
  const context = buildAgentContext(entries, { treeDigest: "x" });
  assert.equal(context.stats.bookmarks, FOLDERS * PER_FOLDER);
  assert.equal(context.stats.folders, 1 + FOLDERS);
  assert.equal(context.stats.ambiguousFolderPaths, 0);
  assert.deepEqual(context.boundaries, ["syncing:true"]);
  assert.equal(
    context.folders.find((folder) => folder.id === "f0").childCount,
    PER_FOLDER,
  );
});

test("duplicate detection scales without collapsing distinct URLs", () => {
  assert.deepEqual(findDuplicateGroups(entries, "normalized"), []);

  const withDuplicates = flattenTree(wideTree());
  withDuplicates.find((entry) => entry.id === "b1_1").url =
    "https://example.com/0/0";
  const groups = findDuplicateGroups(withDuplicates, "normalized");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].members.length, 2);
});

test("deeply nested folders do not overflow the recursive walk", () => {
  const deep = flattenTree(deepTree(2000));
  assert.equal(deep.length, 2001);
  assert.equal(Math.max(...deep.map((entry) => entry.depth)), 2000);
});
