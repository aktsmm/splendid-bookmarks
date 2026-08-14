/**
 * Snapshot-driven restore. This is the recovery path that still works after the
 * extension has been uninstalled and the journal is gone: the exported snapshot
 * file is the only input.
 *
 * Provenance is checked twice and for different reasons. The profile-wide
 * agreement rate rejects a snapshot taken from another profile or another era.
 * The per-node identity check is what actually authorises a move: an aggregate
 * rate says nothing about the specific node that is about to be relocated.
 */
import {
  MAX_PLAN_ERRORS,
  MAX_SNAPSHOT_NODES,
  MIN_PROVENANCE_RATE,
} from "./limits.js";
import {
  boundaryKey,
  isBoundaryIndeterminate,
  topAncestorOf,
} from "./tree-model.js";

export const SNAPSHOT_KIND = "bookmark-tree-snapshot";
const SNAPSHOT_VERSION = 1;

/**
 * The one place that decides what a snapshot file contains. The exporter used
 * to build this inline, which left the written format and the validator free to
 * drift apart with nothing to notice.
 */
export function buildSnapshotDocument(entries, { treeDigest, exportedAt }) {
  return {
    version: SNAPSHOT_VERSION,
    kind: SNAPSHOT_KIND,
    exportedAt,
    treeDigest,
    nodes: entries
      .filter((entry) => !entry.isRoot)
      .map((entry) => ({
        id: entry.id,
        parentId: entry.parentId,
        index: entry.index,
        title: entry.title,
        url: entry.url,
        dateAdded: entry.dateAdded,
        syncing: entry.syncing,
        folderType: entry.folderType,
        unmodifiable: entry.unmodifiable,
        path: entry.path,
      })),
  };
}

export const RESTORE_SKIP = {
  NODE_MISSING: "restore.skip.nodeMissing",
  NODE_MISMATCH: "restore.skip.nodeMismatch",
  PARENT_MISSING: "restore.skip.parentMissing",
  PARENT_MISMATCH: "restore.skip.parentMismatch",
  ANCESTOR_MISMATCH: "restore.skip.ancestorMismatch",
  UNMODIFIABLE: "restore.skip.unmodifiable",
  BOUNDARY: "restore.skip.boundary",
};

export function validateSnapshotDocument(doc) {
  const errors = [];
  // Same ceilings as the plan file: a broken 32 MiB JSON would otherwise build
  // one error object per malformed node before anything could reject it.
  const fail = (path, key, params) => {
    if (errors.length < MAX_PLAN_ERRORS) errors.push({ path, key, params });
  };

  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { ok: false, errors: [{ path: "$", key: "schema.notObject" }] };
  }
  if (doc.kind !== SNAPSHOT_KIND) {
    fail("$.kind", "snapshot.kind", { expected: SNAPSHOT_KIND });
  }
  if (doc.version !== SNAPSHOT_VERSION) {
    fail("$.version", "snapshot.version", { expected: SNAPSHOT_VERSION });
  }
  if (typeof doc.treeDigest !== "string" || doc.treeDigest.length === 0) {
    fail("$.treeDigest", "snapshot.treeDigest");
  }
  if (!Array.isArray(doc.nodes)) {
    fail("$.nodes", "snapshot.nodes");
    return { ok: false, errors };
  }
  if (doc.nodes.length > MAX_SNAPSHOT_NODES) {
    fail("$.nodes", "snapshot.tooManyNodes", {
      count: doc.nodes.length,
      limit: MAX_SNAPSHOT_NODES,
    });
    return { ok: false, errors };
  }
  doc.nodes.forEach((node, i) => {
    const at = `$.nodes[${i}]`;
    if (typeof node !== "object" || node === null) {
      fail(at, "snapshot.nodeNotObject");
      return;
    }
    if (typeof node.id !== "string" || node.id.length === 0) {
      fail(`${at}.id`, "snapshot.nodeId");
    }
    if (typeof node.parentId !== "string" || node.parentId.length === 0) {
      fail(`${at}.parentId`, "snapshot.nodeParentId");
    }
    if (!Number.isInteger(node.index) || node.index < 0) {
      fail(`${at}.index`, "snapshot.nodeIndex");
    }
    if (typeof node.title !== "string") {
      fail(`${at}.title`, "snapshot.nodeTitle");
    }
    if (node.url !== null && typeof node.url !== "string") {
      fail(`${at}.url`, "snapshot.nodeUrl");
    }
  });
  return { ok: errors.length === 0, errors };
}

const isFolder = (node) => node.url === null || node.url === undefined;

/**
 * Permanent roots are identified structurally: their parent is the tree root,
 * which the snapshot does not contain. Their titles are localized and their
 * `dateAdded` is browser-owned, so they are matched on identity and kind only.
 */
function permanentRootIds(nodes) {
  const ids = new Set(nodes.map((node) => node.id));
  return new Set(
    nodes.filter((node) => !ids.has(node.parentId)).map((node) => node.id),
  );
}

export function nodeIdentityMatches(snapshotNode, liveEntry, { relaxed } = {}) {
  if (!liveEntry) return false;
  if (isFolder(snapshotNode) !== liveEntry.isFolder) return false;
  if (relaxed) return true;
  return (
    snapshotNode.title === liveEntry.title &&
    (snapshotNode.url ?? null) === (liveEntry.url ?? null) &&
    (snapshotNode.dateAdded ?? null) === (liveEntry.dateAdded ?? null)
  );
}

/**
 * Profile-wide agreement rate. Diagnostic only: it decides whether the file
 * belongs to this profile at all, never whether one node may move.
 */
export function provenanceReport(doc, entriesById) {
  const roots = permanentRootIds(doc.nodes);
  let matched = 0;
  for (const node of doc.nodes) {
    if (
      nodeIdentityMatches(node, entriesById.get(node.id), {
        relaxed: roots.has(node.id),
      })
    ) {
      matched += 1;
    }
  }
  const total = doc.nodes.length;
  const rate = total === 0 ? 0 : matched / total;
  return { total, matched, rate, accepted: rate >= MIN_PROVENANCE_RATE };
}

function ancestorChain(node, byId) {
  const chain = [];
  let current = byId.get(node.parentId);
  while (current) {
    chain.push(current);
    current = byId.get(current.parentId);
  }
  return chain;
}

/**
 * Decides whether one node may be put back. Every condition is checked against
 * the live tree, so the runner can call this again immediately before the move
 * instead of trusting a preview that may have gone stale.
 * @returns {string|null} a skip reason key, or null when the move is authorised.
 */
export function authorizeRestoreMove(doc, entriesById, bookmarkId) {
  const snapshotById = new Map(doc.nodes.map((item) => [item.id, item]));
  const roots = permanentRootIds(doc.nodes);
  const node = snapshotById.get(bookmarkId);
  if (!node || roots.has(bookmarkId)) return RESTORE_SKIP.NODE_MISSING;

  const live = entriesById.get(node.id);
  if (!live) return RESTORE_SKIP.NODE_MISSING;
  if (!nodeIdentityMatches(node, live)) return RESTORE_SKIP.NODE_MISMATCH;
  if (live.unmodifiable) return RESTORE_SKIP.UNMODIFIABLE;

  const snapshotParent = snapshotById.get(node.parentId);
  const liveParent = entriesById.get(node.parentId);
  if (!snapshotParent || !liveParent || !liveParent.isFolder) {
    return RESTORE_SKIP.PARENT_MISSING;
  }
  // Identity is not enough: a folder that matches but has itself been moved
  // would put this node on a different path than the snapshot recorded.
  if (
    !nodeIdentityMatches(snapshotParent, liveParent, {
      relaxed: roots.has(snapshotParent.id),
    }) ||
    liveParent.parentId !== snapshotParent.parentId ||
    liveParent.unmodifiable
  ) {
    return RESTORE_SKIP.PARENT_MISMATCH;
  }

  const ancestorsOk = ancestorChain(snapshotParent, snapshotById).every(
    (ancestor) => {
      const live = entriesById.get(ancestor.id);
      return (
        nodeIdentityMatches(ancestor, live, {
          relaxed: roots.has(ancestor.id),
        }) && live.parentId === ancestor.parentId
      );
    },
  );
  if (!ancestorsOk) return RESTORE_SKIP.ANCESTOR_MISMATCH;

  // A restore is still a move, so it obeys the same account/local rule.
  if (
    isBoundaryIndeterminate(live, entriesById) ||
    isBoundaryIndeterminate(liveParent, entriesById) ||
    boundaryKey(topAncestorOf(live, entriesById)) !==
      boundaryKey(topAncestorOf(liveParent, entriesById))
  ) {
    return RESTORE_SKIP.BOUNDARY;
  }
  return null;
}

/**
 * Derives the moves that put every node back where the snapshot recorded it.
 * Parents are restored before their children, and within one parent in index
 * order, so an earlier slot exists by the time a later one is filled.
 */
export function buildRestoreMoves(doc, entriesById) {
  const snapshotById = new Map(doc.nodes.map((node) => [node.id, node]));
  const roots = permanentRootIds(doc.nodes);
  const moves = [];
  const skipped = [];

  const ordered = doc.nodes
    .filter((node) => !roots.has(node.id))
    .slice()
    .sort(
      (a, b) =>
        ancestorChain(a, snapshotById).length -
          ancestorChain(b, snapshotById).length || a.index - b.index,
    );

  for (const node of ordered) {
    const live = entriesById.get(node.id);
    if (live && live.parentId === node.parentId && live.index === node.index) {
      continue;
    }
    const refusal = authorizeRestoreMove(doc, entriesById, node.id);
    if (refusal) {
      skipped.push({ id: node.id, key: refusal });
      continue;
    }

    moves.push({
      opId: `restore:${node.id}`,
      bookmarkId: node.id,
      targetParentId: node.parentId,
      targetIndex: node.index,
      currentParentId: live.parentId,
      currentIndex: live.index,
    });
  }

  return { moves, skipped };
}
