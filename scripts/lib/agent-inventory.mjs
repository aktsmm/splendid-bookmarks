import { MAX_SNAPSHOT_NODES } from "../../extension/src/core/limits.js";

function requireResult(result, command) {
  if (
    result?.ok !== true ||
    result.version !== 1 ||
    result.command !== command ||
    !result.state
  ) {
    throw new Error(result?.error?.key ?? `Invalid ${command} response`);
  }
  return result.state;
}

export async function inspectSession(call) {
  const capabilities = requireResult(
    await call("capabilities"),
    "capabilities",
  );
  if (
    !capabilities.features?.pagination ||
    !capabilities.features?.sessionInfo
  ) {
    throw new Error(
      "This extension build does not support full inventory; use the updated development build",
    );
  }
  const session = requireResult(await call("getSession"), "getSession");
  if (typeof session.sessionId !== "string" || !session.sessionId) {
    throw new Error("Missing session identity");
  }
  const stats = session.ready
    ? requireResult(await call("getStats"), "getStats")
    : null;
  return { capabilities, session, stats };
}

export async function collectInventory(call, { sessionId }) {
  const { capabilities, session, stats } = await inspectSession(call);
  if (!session.ready || session.loading)
    throw new Error("Tree not ready; use --list to inspect loading, mode and tree status before retrying");
  if (session.sessionId !== sessionId)
    throw new Error("Session mismatch; select the intended tab again");
  if (
    typeof session.snapshotId !== "string" ||
    !session.snapshotId ||
    stats.snapshotId !== session.snapshotId ||
    stats.sessionId !== sessionId
  ) {
    throw new Error("Snapshot changed before collection");
  }
  const limit = capabilities.limits?.maxRows;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error("Invalid page limit");
  const entries = [];
  const ids = new Set();
  let total;
  let cursor;
  do {
    const page = requireResult(
      await call("getTree", { limit, ...(cursor ? { cursor } : {}) }),
      "getTree",
    );
    if (page.snapshotId !== session.snapshotId)
      throw new Error("Snapshot changed during collection");
    if (
      !Number.isSafeInteger(page.total) ||
      page.total < 0 ||
      page.total > MAX_SNAPSHOT_NODES ||
      (total !== undefined && page.total !== total)
    )
      throw new Error("Invalid or changing total");
    total = page.total;
    if (
      !Array.isArray(page.shown) ||
      page.shown.length > limit ||
      (page.shown.length === 0 && entries.length !== total)
    )
      throw new Error("Invalid or empty page");
    for (const entry of page.shown) {
      if (
        !entry ||
        typeof entry.id !== "string" ||
        !entry.id ||
        ids.has(entry.id) ||
        typeof entry.title !== "string" ||
        (entry.url !== null && typeof entry.url !== "string") ||
        !Array.isArray(entry.path) ||
        entry.path.some((part) => typeof part !== "string")
      ) {
        throw new Error("Invalid or duplicate bookmark row");
      }
      ids.add(entry.id);
      entries.push(entry);
    }
    if (entries.length > total || page.truncated !== entries.length < total) {
      throw new Error("Page completeness mismatch");
    }
    if (page.truncated) {
      const next = page.nextCursor;
      if (
        !next ||
        next.snapshotId !== session.snapshotId ||
        next.offset !== entries.length ||
        next.command !== "getTree" ||
        next.query !== ""
      )
        throw new Error("Invalid continuation cursor");
      cursor = next;
    } else {
      if (page.nextCursor !== null) throw new Error("Unexpected final cursor");
      cursor = null;
    }
  } while (cursor);
  const final = requireResult(await call("getSession"), "getSession");
  if (
    !final.ready ||
    final.loading ||
    final.sessionId !== sessionId ||
    final.snapshotId !== session.snapshotId ||
    final.treeDigest !== session.treeDigest
  ) {
    throw new Error("Session or snapshot changed after collection");
  }
  const bookmarks = entries.filter((entry) => entry.url !== null).length;
  const folders = entries.length - bookmarks;
  if (
    stats.bookmarks !== bookmarks ||
    stats.folders !== folders ||
    stats.treeDigest !== session.treeDigest
  ) {
    throw new Error("Stats do not match the complete inventory");
  }
  return { session, stats, total, entries };
}
