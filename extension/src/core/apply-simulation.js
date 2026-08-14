/**
 * Deterministic external-change detector for the Apply batch.
 *
 * Bookmark events carry no originator, so the runner cannot prove an event was
 * its own. What it can do is predict the tree it expects after each of its own
 * moves and compare that prediction with the tree it re-reads before the next
 * move. Anything else that touched the profile in between shows up as drift,
 * whatever events did or did not fire.
 *
 * The projection maintains only the fields `canonicalTreeString` consumes, so it
 * is a digest input, not a navigable tree: `path`, `depth` and `topAncestorId`
 * are left at their pre-move values on purpose.
 */
import { MAX_DRIFT_ROWS } from "./limits.js";

const COMPARED_FIELDS = [
  "parentId",
  "index",
  "title",
  "url",
  "syncing",
  "folderType",
  "unmodifiable",
];

export function projectTreeAfterMove(
  entries,
  { bookmarkId, targetParentId, targetIndex },
) {
  const node = entries.find((entry) => entry.id === bookmarkId);
  if (!node) return null;
  const { parentId: oldParentId, index: oldIndex } = node;

  return entries.map((entry) => {
    if (entry.id === bookmarkId) {
      return { ...entry, parentId: targetParentId, index: targetIndex };
    }
    // Remove, then insert: within one parent both shifts apply in that order.
    let index = entry.index;
    if (entry.parentId === oldParentId && index > oldIndex) index -= 1;
    if (entry.parentId === targetParentId && index >= targetIndex) index += 1;
    return index === entry.index ? entry : { ...entry, index };
  });
}

/**
 * The tree after one leaf bookmark is removed: the node goes, and its later
 * siblings close the gap. Deleting is the one operation with nothing to compare
 * against afterwards, so this is what turns "the id is gone" into "nothing else
 * changed either".
 */
export function projectTreeAfterRemove(entries, { bookmarkId }) {
  const node = entries.find((entry) => entry.id === bookmarkId);
  if (!node) return null;

  return entries
    .filter((entry) => entry.id !== bookmarkId)
    .map((entry) =>
      entry.parentId === node.parentId && entry.index > node.index
        ? { ...entry, index: entry.index - 1 }
        : entry,
    );
}

/**
 * The tree after one leaf bookmark is retitled. Only the node's own title moves,
 * which is why renaming is restricted to bookmarks: a folder title is a path
 * segment for everything beneath it, and this projection does not rebuild paths.
 */
export function projectTreeAfterRetitle(entries, { bookmarkId, title }) {
  const node = entries.find((entry) => entry.id === bookmarkId);
  if (!node || node.isFolder) return null;
  return entries.map((entry) =>
    entry.id === bookmarkId
      ? {
          ...entry,
          title,
          path: [...entry.path.slice(0, -1), title],
        }
      : entry,
  );
}

/**
 * Translates a wanted final position into the index the move API is given.
 * Chromium treats `index` as a slot in the parent as it is *before* the node is
 * detached, so a same-parent move to a later position has to aim one slot
 * further. Cross-parent moves are unaffected. The post-move read is what
 * ultimately decides success, so a wrong assumption here fails loudly.
 */
export function apiIndexForMove({ sameParent, oldIndex, targetIndex }) {
  if (!sameParent) return targetIndex;
  return targetIndex > oldIndex ? targetIndex + 1 : targetIndex;
}

/**
 * Explains a digest mismatch so the user can tell a structural change from a
 * `syncing` flip, which the browser can perform on an existing node by itself.
 */
export function describeTreeDrift(expected, actual) {
  const expectedById = new Map(
    expected.filter((entry) => !entry.isRoot).map((entry) => [entry.id, entry]),
  );
  const actualById = new Map(
    actual.filter((entry) => !entry.isRoot).map((entry) => [entry.id, entry]),
  );
  const changes = [];

  for (const [id, before] of expectedById) {
    const after = actualById.get(id);
    if (!after) {
      changes.push({
        id,
        field: "existence",
        expected: before.title,
        actual: null,
      });
      continue;
    }
    for (const field of COMPARED_FIELDS) {
      if (before[field] !== after[field]) {
        changes.push({
          id,
          field,
          expected: before[field],
          actual: after[field],
        });
      }
    }
  }
  for (const [id, after] of actualById) {
    if (!expectedById.has(id)) {
      changes.push({
        id,
        field: "existence",
        expected: null,
        actual: after.title,
      });
    }
  }

  return {
    total: changes.length,
    changes: changes.slice(0, MAX_DRIFT_ROWS),
    truncated: changes.length > MAX_DRIFT_ROWS,
  };
}
