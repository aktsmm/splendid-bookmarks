/**
 * Pure tree model helpers. No `chrome.*` access, no I/O.
 * Input is the array returned by the bookmarks getTree call.
 */

/**
 * Flattens a bookmark tree into entries carrying resolved path, depth and
 * account/local boundary attributes.
 */
export function flattenTree(rootNodes) {
  const entries = [];

  const visit = (node, parent, fallbackIndex) => {
    const isRoot = parent === null;
    const isPermanentRoot = !isRoot && parent.isRoot;
    const entry = {
      id: node.id,
      parentId: node.parentId ?? null,
      index: typeof node.index === "number" ? node.index : fallbackIndex,
      title: node.title ?? "",
      url: node.url ?? null,
      isFolder: node.url === undefined || node.url === null,
      dateAdded: node.dateAdded ?? null,
      // `syncing` and `folderType` require Chrome 134+; null means "not reported".
      syncing: typeof node.syncing === "boolean" ? node.syncing : null,
      folderType: node.folderType ?? null,
      unmodifiable: node.unmodifiable ?? null,
      isRoot,
      isPermanentRoot,
      topAncestorId: isRoot
        ? null
        : isPermanentRoot
          ? node.id
          : parent.topAncestorId,
      path: isRoot ? [] : [...parent.path, node.title ?? ""],
    };
    entry.depth = entry.path.length;
    entries.push(entry);

    const children = node.children ?? [];
    for (let i = 0; i < children.length; i += 1) {
      visit(children[i], entry, i);
    }
  };

  for (let i = 0; i < rootNodes.length; i += 1) {
    visit(rootNodes[i], null, i);
  }
  return entries;
}

export function indexById(entries) {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

export function topAncestorOf(entry, byId) {
  if (entry.isRoot) return null;
  if (entry.isPermanentRoot) return entry;
  return byId.get(entry.topAncestorId) ?? null;
}

/**
 * Boundary key for the account/local separation. Per the Bookmarks API, `syncing`
 * is what distinguishes the account and local versions of the same FolderType, so
 * it is the whole key. `folderType` must NOT be part of it: moving between the
 * bookmarks bar and other bookmarks inside the same store is legitimate.
 */
export function boundaryKey(topAncestor) {
  if (!topAncestor) return null;
  if (topAncestor.syncing === null) return null;
  return `syncing:${String(topAncestor.syncing)}`;
}

/**
 * True when the boundary of `entry` cannot be proven: either the runtime does
 * not report `syncing`, or the node disagrees with its permanent root.
 */
export function isBoundaryIndeterminate(entry, byId) {
  const top = topAncestorOf(entry, byId);
  if (!top) return true;
  if (top.syncing === null) return true;
  if (entry.syncing !== null && entry.syncing !== top.syncing) return true;
  return false;
}

export function isDescendantOf(candidateId, ancestorId, byId) {
  let current = byId.get(candidateId);
  while (current && current.parentId !== null) {
    if (current.parentId === ancestorId) return true;
    current = byId.get(current.parentId);
  }
  return false;
}

export function pathsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
    return false;
  return a.every((segment, i) => segment === b[i]);
}

export function formatPath(path) {
  return path.join(" / ");
}

/** Returns every folder whose path equals `segments`. More than one means ambiguous. */
export function resolveFolderPath(segments, entries) {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  return entries.filter(
    (entry) =>
      entry.isFolder && !entry.isRoot && pathsEqual(entry.path, segments),
  );
}

export function countUrls(entries) {
  return entries.filter((entry) => !entry.isFolder && !entry.isRoot).length;
}

/**
 * Returns every folder grouped under the permanent root it belongs to, for a picker.
 * `label` drops the root segment because the group already names it, but keeps the
 * full path whenever dropping it would collide with a folder under another root.
 */
export function foldersByPermanentRoot(entries) {
  const byId = indexById(entries);
  const groups = new Map();

  for (const entry of entries) {
    if (!entry.isFolder || entry.isRoot) continue;
    const top = topAncestorOf(entry, byId);
    if (!top) continue;
    if (!groups.has(top.id)) {
      groups.set(top.id, {
        root: { id: top.id, title: top.title },
        folders: [],
      });
    }
    groups.get(top.id).folders.push({ id: entry.id, path: entry.path });
  }

  const counts = new Map();
  for (const group of groups.values()) {
    for (const folder of group.folders) {
      const stripped = formatPath(folder.path.slice(1));
      counts.set(stripped, (counts.get(stripped) ?? 0) + 1);
    }
  }
  for (const group of groups.values()) {
    for (const folder of group.folders) {
      const stripped = formatPath(folder.path.slice(1));
      folder.label =
        stripped.length > 0 && counts.get(stripped) === 1
          ? stripped
          : formatPath(folder.path);
    }
  }
  return [...groups.values()];
}

/**
 * Deterministic projection used as the digest input that binds a Dry Run to the
 * exact tree it was computed against.
 */
export function canonicalTreeString(entries) {
  return entries
    .filter((entry) => !entry.isRoot)
    .map((entry) =>
      [
        entry.id,
        entry.parentId ?? "",
        String(entry.index),
        entry.title,
        entry.url ?? "",
        String(entry.syncing),
        String(entry.folderType),
        String(entry.unmodifiable),
      ].join("\u001f"),
    )
    .sort()
    .join("\u001e");
}
