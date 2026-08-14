/**
 * Turns a manual selection into the same plan document an agent would produce.
 * Pure: no `chrome.*`, no DOM. The output goes through the identical schema
 * validation and Dry Run path as a plan file, so the manual route adds an input
 * method and no new trust surface.
 */
import { isDescendantOf } from "./tree-model.js";
import { PLAN_VERSION as SCHEMA_PLAN_VERSION } from "./plan-schema.js";

const PLAN_VERSION = SCHEMA_PLAN_VERSION;

function movable(entry) {
  return !entry.isRoot && !entry.isPermanentRoot;
}

/**
 * Rows offered for selection. `scopeFolderId` limits the list to one subtree and
 * `query` matches title or url; both only narrow what is shown, never what is
 * already selected.
 */
export function selectableEntries(
  entries,
  { scopeFolderId, query, byId } = {},
) {
  const needle = (query ?? "").trim().toLowerCase();
  return entries
    .filter(movable)
    .filter((entry) =>
      scopeFolderId ? isDescendantOf(entry.id, scopeFolderId, byId) : true,
    )
    .filter((entry) => {
      if (needle.length === 0) return true;
      return (
        entry.title.toLowerCase().includes(needle) ||
        (entry.url ?? "").toLowerCase().includes(needle)
      );
    })
    .sort(
      (a, b) =>
        a.path.join("\u001f").localeCompare(b.path.join("\u001f")) ||
        a.index - b.index,
    );
}

/**
 * Everything currently selected, resolved against the live tree. The caller
 * renders this regardless of scope and filter: a selection the user cannot see
 * is one they cannot revoke, and it would still move.
 */
export function selectedEntries(selectedIds, byId) {
  const resolved = [];
  const missing = [];
  for (const id of selectedIds) {
    const entry = byId.get(id);
    if (entry && movable(entry)) resolved.push(entry);
    else missing.push(id);
  }
  resolved.sort(
    (a, b) =>
      a.path.join("\u001f").localeCompare(b.path.join("\u001f")) ||
      a.index - b.index,
  );
  return { resolved, missing };
}

/**
 * Drops any selection already covered by a selected ancestor. Moving a folder
 * takes its subtree along, so keeping both would produce operations the Dry Run
 * refuses as `operation-interdependent`.
 */
export function pruneCoveredSelection(selectedIds, byId) {
  const ids = [...selectedIds];
  const kept = [];
  const dropped = [];
  for (const id of ids) {
    const covered = ids.some(
      (other) => other !== id && isDescendantOf(id, other, byId),
    );
    (covered ? dropped : kept).push(id);
  }
  return { kept, dropped };
}

export function buildPlanFromSelection({
  entries,
  byId,
  selectedIds,
  destinationFolderId,
  reason,
  generatedAt,
}) {
  const destination = byId.get(destinationFolderId);
  if (!destination || !destination.isFolder || destination.isRoot) {
    return { plan: null, dropped: [], missing: [] };
  }

  const { resolved, missing } = selectedEntries(selectedIds, byId);
  const { kept, dropped } = pruneCoveredSelection(
    resolved.map((entry) => entry.id),
    byId,
  );
  const keptSet = new Set(kept);

  const operations = resolved
    .filter((entry) => keptSet.has(entry.id))
    .map((entry, i) => ({
      opId: `local-${String(i + 1).padStart(4, "0")}`,
      type: "move",
      bookmarkId: entry.id,
      expectedTitle: entry.title,
      expectedUrl: entry.url,
      currentPath: entry.path,
      destinationPath: destination.path,
      // The exact id is known here, so the destination can never be ambiguous.
      destinationFolderId: destination.id,
      reason,
      confidence: 1,
    }));

  return {
    plan: { version: PLAN_VERSION, generatedAt, operations },
    dropped,
    missing,
  };
}
