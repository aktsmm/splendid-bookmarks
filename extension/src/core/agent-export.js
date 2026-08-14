/**
 * Builds the hand-off bundle an AI agent needs to produce a valid plan:
 * stable ids, full paths, boundary groups, and the folder paths that cannot be
 * addressed by name alone. Pure and read-only.
 */
import {
  boundaryKey,
  formatPath,
  indexById,
  isDescendantOf,
  topAncestorOf,
} from "./tree-model.js";
import { PLAN_VERSION as SCHEMA_PLAN_VERSION } from "./plan-schema.js";

export const AGENT_CONTEXT_VERSION = 1;
/** Re-exported so the context, the builder and the validator cannot drift apart. */
export const PLAN_SCHEMA_VERSION = SCHEMA_PLAN_VERSION;

/** Folder paths shared by more than one folder; those need destinationFolderId. */
export function findAmbiguousFolderPaths(entries) {
  const buckets = new Map();
  for (const entry of entries) {
    if (!entry.isFolder || entry.isRoot) continue;
    const key = formatPath(entry.path);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry.id);
  }
  return [...buckets.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([path, ids]) => ({ path, ids }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

export function buildAgentContext(entries, options = {}) {
  const byId = indexById(entries);
  const boundaryOf = (entry) => boundaryKey(topAncestorOf(entry, byId));
  const childCounts = new Map();
  for (const entry of entries) {
    if (entry.parentId === null) continue;
    childCounts.set(entry.parentId, (childCounts.get(entry.parentId) ?? 0) + 1);
  }

  // Destinations always cover the whole tree; only the work list gets scoped.
  const folders = entries
    .filter((entry) => entry.isFolder && !entry.isRoot)
    .map((entry) => ({
      id: entry.id,
      path: entry.path,
      boundary: boundaryOf(entry),
      isPermanentRoot: entry.isPermanentRoot,
      unmodifiable: entry.unmodifiable ?? null,
      childCount: childCounts.get(entry.id) ?? 0,
    }));

  const scopeFolder = options.scopeFolderId
    ? (byId.get(options.scopeFolderId) ?? null)
    : null;
  const inScope = (entry) =>
    scopeFolder === null || isDescendantOf(entry.id, scopeFolder.id, byId);

  const allBookmarks = entries.filter(
    (entry) => !entry.isFolder && !entry.isRoot,
  );
  const bookmarks = allBookmarks.filter(inScope).map((entry) => ({
    id: entry.id,
    title: entry.title,
    url: entry.url,
    path: entry.path,
    parentPath: entry.path.slice(0, -1),
    boundary: boundaryOf(entry),
    unmodifiable: entry.unmodifiable ?? null,
  }));

  const ambiguousFolderPaths = findAmbiguousFolderPaths(entries);
  const boundaries = [
    ...new Set(folders.map((folder) => folder.boundary)),
  ].sort();

  return {
    version: AGENT_CONTEXT_VERSION,
    kind: "agent-context",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    treeDigest: options.treeDigest ?? null,
    planSchemaVersion: PLAN_SCHEMA_VERSION,
    scope:
      scopeFolder === null
        ? null
        : { id: scopeFolder.id, path: scopeFolder.path },
    stats: {
      bookmarks: bookmarks.length,
      totalBookmarks: allBookmarks.length,
      folders: folders.length,
      boundaries: boundaries.length,
      ambiguousFolderPaths: ambiguousFolderPaths.length,
    },
    boundaries,
    ambiguousFolderPaths,
    folders,
    bookmarks,
  };
}

/** Subtree bookmark count per permanent root, i.e. the number the user wants to reach zero. */
export function subtreeBookmarkCounts(entries) {
  const byId = indexById(entries);
  return entries
    .filter((entry) => entry.isPermanentRoot)
    .map((root) => ({
      id: root.id,
      title: root.title,
      bookmarks: entries.filter(
        (entry) =>
          !entry.isFolder &&
          !entry.isRoot &&
          isDescendantOf(entry.id, root.id, byId),
      ).length,
    }));
}
