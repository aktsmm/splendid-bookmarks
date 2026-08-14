/**
 * The only module allowed to touch the browser bookmarks API.
 * Four mutating primitives exist here — `moveBookmark`, `createFolder`,
 * `removeBookmark` and `updateBookmark` — and tests/no-write-api.test.js
 * enforces mechanically that no other file, and no other bookmark method, can
 * write.
 *
 * `createFolder` is deliberately not a general create: it passes no address, so
 * the build cannot add a bookmark, only an empty folder. `removeBookmark` takes
 * a single id and is never the recursive variant. `updateBookmark` writes a
 * title and nothing else. The gate fixes all of them by scanning the function
 * bodies, not by trusting this comment.
 */
import { LocalizedError } from "../core/errors.js";

export function bookmarksApiAvailable() {
  return typeof chrome !== "undefined" && Boolean(chrome?.bookmarks?.getTree);
}

export async function getLiveTree() {
  if (!bookmarksApiAvailable()) {
    throw new LocalizedError("error.bookmarksUnavailable");
  }
  return chrome.bookmarks.getTree();
}

/**
 * Reads specific nodes without walking the tree. Chrome rejects the call when
 * an id is gone, which the caller must be able to tell apart from a hard
 * failure, so a missing node comes back as `null` in place.
 */
export async function getNodes(ids) {
  if (!bookmarksApiAvailable()) {
    throw new LocalizedError("error.bookmarksUnavailable");
  }
  return Promise.all(
    ids.map(async (id) => {
      try {
        const [node] = await chrome.bookmarks.get(id);
        return node ?? null;
      } catch {
        return null;
      }
    }),
  );
}

/** One of the four audited write primitives. Nothing else in the build may mutate a bookmark. */
export async function moveBookmark(id, destination) {
  if (!bookmarksApiAvailable()) {
    throw new LocalizedError("error.bookmarksUnavailable");
  }
  return chrome.bookmarks.move(id, destination);
}

/**
 * Creates one empty folder, for the Trash location the user picked.
 * The call carries only a parent and a title, which is what makes "this build
 * cannot add a bookmark" checkable rather than merely intended.
 */
export async function createFolder({ parentId, title }) {
  if (!bookmarksApiAvailable()) {
    throw new LocalizedError("error.bookmarksUnavailable");
  }
  return chrome.bookmarks.create({ parentId, title });
}

/**
 * Deletes one bookmark. The only irreversible call in the build. A plan cannot
 * express a deletion, so this is reached from the page's own controls only —
 * which is not the same as "a person did it": anything driving the page,
 * including an agent with browser control, uses the same controls.
 *
 * `removeTree` stays out of the build entirely, so a folder can never take its
 * descendants with it.
 */
export async function removeBookmark(id) {
  if (!bookmarksApiAvailable()) {
    throw new LocalizedError("error.bookmarksUnavailable");
  }
  return chrome.bookmarks.remove(id);
}

/**
 * Retitles one bookmark. The second argument is a fixed literal so the static
 * gate can prove no other field of a node can ever be written from here.
 */
export async function updateBookmark(id, title) {
  if (!bookmarksApiAvailable()) {
    throw new LocalizedError("error.bookmarksUnavailable");
  }
  return chrome.bookmarks.update(id, { title });
}

/**
 * Subscribes for the duration of one batch. `onChildrenReordered` is documented
 * as not firing for move(), so anything it reports is external by definition.
 * Returns the unsubscribe function; the caller must always call it.
 */
export function watchExternalChanges(onEvent) {
  const bind = (event, kind) => {
    const listener = (id, info) => onEvent({ kind, id, info });
    event.addListener(listener);
    return () => event.removeListener(listener);
  };
  const releases = [
    bind(chrome.bookmarks.onMoved, "moved"),
    bind(chrome.bookmarks.onCreated, "created"),
    bind(chrome.bookmarks.onRemoved, "removed"),
    bind(chrome.bookmarks.onChanged, "changed"),
    bind(chrome.bookmarks.onChildrenReordered, "reordered"),
    bind(chrome.bookmarks.onImportBegan, "import"),
  ];
  return () => {
    for (const release of releases) release();
  };
}

/**
 * Reports whether the runtime exposes the Chrome 134+ `syncing` flag on real
 * nodes. Without it the account/local boundary cannot be proven, so the write
 * phase refuses to run.
 */
export function boundarySignalAvailable(entries) {
  return entries.some(
    (entry) => entry.isPermanentRoot && entry.syncing !== null,
  );
}
