/**
 * Dry Run reconciliation of a plan against a live tree snapshot.
 * Pure: it classifies operations and never performs any bookmark mutation.
 * `detail` is a message key plus params so the UI can render it in any locale.
 */
import {
  boundaryKey,
  indexById,
  isBoundaryIndeterminate,
  isDescendantOf,
  pathsEqual,
  resolveFolderPath,
  topAncestorOf,
} from "./tree-model.js";
import { MAX_TITLE_CHARS } from "./limits.js";

/**
 * Only `movable` is eligible for a future Apply phase. Everything else blocks
 * the operation. The value is historical: it now means "approved to apply",
 * which for a `update` operation is a retitle rather than a move.
 */
export const STATUS = {
  MOVABLE: "movable",
  NO_OP: "no-op",
  DUPLICATE_OP: "duplicate-op",
  UNSUPPORTED_TYPE: "unsupported-op-type",
  ID_NOT_FOUND: "id-not-found",
  PERMANENT_ROOT_SOURCE: "permanent-root-source",
  UNMODIFIABLE_NODE: "unmodifiable-node",
  TITLE_MISMATCH: "title-mismatch",
  URL_MISMATCH: "url-mismatch",
  CURRENT_PATH_MISMATCH: "current-path-mismatch",
  RENAME_NOT_A_BOOKMARK: "rename-not-a-bookmark",
  RENAME_UNCHANGED: "rename-unchanged",
  RENAME_TOO_LONG: "rename-too-long",
  RENAME_TRASH_MANAGED: "rename-trash-managed",
  DESTINATION_NOT_FOUND: "destination-not-found",
  DESTINATION_AMBIGUOUS: "destination-ambiguous",
  DESTINATION_ID_NOT_FOUND: "destination-id-not-found",
  DESTINATION_NOT_FOLDER: "destination-not-folder",
  DESTINATION_CONFLICT: "destination-conflict",
  DESTINATION_UNMODIFIABLE: "destination-unmodifiable",
  DESTINATION_IS_DESCENDANT: "destination-is-descendant",
  BOUNDARY_VIOLATION: "boundary-violation",
  BOUNDARY_INDETERMINATE: "boundary-indeterminate",
  OPERATION_INTERDEPENDENT: "operation-interdependent",
};

function row(op, status, detail, extra = {}) {
  return {
    opId: op?.opId ?? null,
    type: op?.type ?? null,
    bookmarkId: op?.bookmarkId ?? null,
    status,
    detail,
    reason: op?.reason ?? null,
    confidence: typeof op?.confidence === "number" ? op.confidence : null,
    currentPath: null,
    destinationPath: null,
    resolvedDestinationId: null,
    ...extra,
  };
}

/**
 * Single source of truth for whether one operation may run against a tree.
 * Apply re-runs this against a freshly fetched tree instead of reimplementing
 * the preconditions, so Dry Run and Apply can never disagree.
 */
export function evaluateOperation(
  op,
  entries,
  byId = indexById(entries),
  seenBookmarkIds = new Set(),
  protectedBookmarkIds = new Set(),
) {
  if (op.type !== "move" && op.type !== "update") {
    return row(op, STATUS.UNSUPPORTED_TYPE, {
      key: "detail.unsupportedType",
      params: { type: String(op.type) },
    });
  }
  if (seenBookmarkIds.has(op.bookmarkId)) {
    return row(op, STATUS.DUPLICATE_OP, { key: "detail.duplicateOp" });
  }
  seenBookmarkIds.add(op.bookmarkId);

  const node = byId.get(op.bookmarkId);
  if (!node) {
    return row(op, STATUS.ID_NOT_FOUND, { key: "detail.idNotFound" });
  }

  const livePath = node.path;
  const base = { currentPath: livePath };

  if (node.isRoot || node.isPermanentRoot) {
    return row(
      op,
      STATUS.PERMANENT_ROOT_SOURCE,
      { key: "detail.permanentRootSource" },
      base,
    );
  }
  if (node.unmodifiable) {
    return row(
      op,
      STATUS.UNMODIFIABLE_NODE,
      { key: "detail.unmodifiableNode", params: { reason: node.unmodifiable } },
      base,
    );
  }
  if (op.expectedTitle !== node.title) {
    return row(
      op,
      STATUS.TITLE_MISMATCH,
      { key: "detail.titleMismatch", params: { liveTitle: node.title } },
      base,
    );
  }
  const expectedUrl = op.expectedUrl ?? null;
  if (expectedUrl !== node.url) {
    return row(
      op,
      STATUS.URL_MISMATCH,
      node.url === null
        ? { key: "detail.urlMismatchFolder" }
        : { key: "detail.urlMismatch", params: { liveUrl: node.url } },
      base,
    );
  }
  if (!pathsEqual(op.currentPath, livePath)) {
    return row(
      op,
      STATUS.CURRENT_PATH_MISMATCH,
      { key: "detail.currentPathMismatch" },
      base,
    );
  }

  if (op.type === "update") {
    // v1 renames bookmarks only. A folder title is a path segment for every
    // node beneath it, so renaming one would invalidate the recorded paths the
    // Trash ledger, the snapshot and the other operations all match against.
    if (node.isFolder) {
      return row(
        op,
        STATUS.RENAME_NOT_A_BOOKMARK,
        { key: "detail.renameNotABookmark" },
        base,
      );
    }
    // The title is part of the identity the Trash ledger matches on, so an item
    // with a live receipt cannot be renamed without breaking its own restore.
    if (protectedBookmarkIds.has(op.bookmarkId)) {
      return row(
        op,
        STATUS.RENAME_TRASH_MANAGED,
        { key: "detail.renameTrashManaged" },
        base,
      );
    }
    if (op.newTitle === node.title) {
      return row(
        op,
        STATUS.RENAME_UNCHANGED,
        { key: "detail.renameUnchanged" },
        base,
      );
    }
    if (op.newTitle.length > MAX_TITLE_CHARS) {
      return row(
        op,
        STATUS.RENAME_TOO_LONG,
        {
          key: "detail.renameTooLong",
          params: { count: op.newTitle.length, limit: MAX_TITLE_CHARS },
        },
        base,
      );
    }
    return row(op, STATUS.MOVABLE, { key: "detail.movable" }, base);
  }

  // `destinationFolderId` disambiguates a shared path, but it can never point
  // somewhere other than the destinationPath the user reviewed.
  let destination;
  if (op.destinationFolderId !== undefined) {
    const target = byId.get(op.destinationFolderId);
    if (!target) {
      return row(
        op,
        STATUS.DESTINATION_ID_NOT_FOUND,
        { key: "detail.destinationIdNotFound" },
        base,
      );
    }
    if (!target.isFolder || target.isRoot) {
      return row(
        op,
        STATUS.DESTINATION_NOT_FOLDER,
        { key: "detail.destinationNotFolder" },
        base,
      );
    }
    if (!pathsEqual(target.path, op.destinationPath)) {
      return row(
        op,
        STATUS.DESTINATION_CONFLICT,
        { key: "detail.destinationConflict" },
        {
          ...base,
          destinationPath: target.path,
          resolvedDestinationId: target.id,
        },
      );
    }
    destination = target;
  } else {
    const matches = resolveFolderPath(op.destinationPath, entries);
    if (matches.length === 0) {
      return row(
        op,
        STATUS.DESTINATION_NOT_FOUND,
        { key: "detail.destinationNotFound" },
        base,
      );
    }
    if (matches.length > 1) {
      return row(
        op,
        STATUS.DESTINATION_AMBIGUOUS,
        {
          key: "detail.destinationAmbiguous",
          params: { count: matches.length },
        },
        base,
      );
    }
    destination = matches[0];
  }

  const resolved = {
    ...base,
    destinationPath: destination.path,
    resolvedDestinationId: destination.id,
  };

  if (destination.unmodifiable) {
    return row(
      op,
      STATUS.DESTINATION_UNMODIFIABLE,
      {
        key: "detail.destinationUnmodifiable",
        params: { reason: destination.unmodifiable },
      },
      resolved,
    );
  }
  if (node.parentId === destination.id) {
    return row(op, STATUS.NO_OP, { key: "detail.noOp" }, resolved);
  }
  if (
    node.isFolder &&
    (destination.id === node.id ||
      isDescendantOf(destination.id, node.id, byId))
  ) {
    return row(
      op,
      STATUS.DESTINATION_IS_DESCENDANT,
      { key: "detail.destinationIsDescendant" },
      resolved,
    );
  }
  if (
    isBoundaryIndeterminate(node, byId) ||
    isBoundaryIndeterminate(destination, byId)
  ) {
    return row(
      op,
      STATUS.BOUNDARY_INDETERMINATE,
      { key: "detail.boundaryIndeterminate" },
      resolved,
    );
  }
  const sourceKey = boundaryKey(topAncestorOf(node, byId));
  const destinationKey = boundaryKey(topAncestorOf(destination, byId));
  if (sourceKey !== destinationKey) {
    return row(
      op,
      STATUS.BOUNDARY_VIOLATION,
      {
        key: "detail.boundaryViolation",
        params: { from: sourceKey, to: destinationKey },
      },
      resolved,
    );
  }

  return row(op, STATUS.MOVABLE, { key: "detail.movable" }, resolved);
}

/**
 * Two movable operations interfere when applying one changes what the other
 * resolves to, or where it lands. The batch runner relies on each approved
 * operation being independent, so the whole pair is refused rather than ordered.
 */
function interferes(a, b, byId) {
  // A rename writes one bookmark's own title, so it cannot relocate anything.
  // It is still not independent: moving a folder that contains the renamed
  // bookmark changes that bookmark's `currentPath`, and the rename would then
  // stop matching mid-batch and abort a batch the Dry Run had approved.
  if (a.type === "update" || b.type === "update") {
    if (a.type === "update" && b.type === "update") return false;
    const rename = a.type === "update" ? a : b;
    const move = a.type === "update" ? b : a;
    return isDescendantOf(rename.bookmarkId, move.bookmarkId, byId);
  }
  const sourceA = a.bookmarkId;
  const sourceB = b.bookmarkId;
  const destB = b.resolvedDestinationId;
  const parentB = byId.get(sourceB)?.parentId ?? null;

  // Moving A relocates B, or relocates the folder B is aiming at.
  if (isDescendantOf(sourceB, sourceA, byId)) return true;
  if (destB === sourceA || isDescendantOf(destB, sourceA, byId)) return true;
  // A appends into the folder B is about to leave, so B shifts A's index.
  if (a.resolvedDestinationId === parentB) return true;
  return false;
}

function flagInterdependentOps(rows, byId) {
  const movable = rows.filter((item) => item.status === STATUS.MOVABLE);
  const conflicted = new Set();
  for (const a of movable) {
    for (const b of movable) {
      if (a === b) continue;
      if (interferes(a, b, byId)) {
        conflicted.add(a);
        conflicted.add(b);
      }
    }
  }
  if (conflicted.size === 0) return rows;
  return rows.map((item) =>
    conflicted.has(item)
      ? {
          ...item,
          status: STATUS.OPERATION_INTERDEPENDENT,
          detail: { key: "detail.operationInterdependent" },
        }
      : item,
  );
}

export function dryRun(plan, entries, { protectedBookmarkIds } = {}) {
  const byId = indexById(entries);
  const seenBookmarkIds = new Set();
  const protectedIds = protectedBookmarkIds ?? new Set();
  const rows = flagInterdependentOps(
    plan.operations.map((op) =>
      evaluateOperation(op, entries, byId, seenBookmarkIds, protectedIds),
    ),
    byId,
  );

  const summary = {};
  for (const item of rows) {
    summary[item.status] = (summary[item.status] ?? 0) + 1;
  }
  return {
    rows,
    summary,
    movableCount: summary[STATUS.MOVABLE] ?? 0,
    blockedCount:
      rows.length -
      (summary[STATUS.MOVABLE] ?? 0) -
      (summary[STATUS.NO_OP] ?? 0),
  };
}
