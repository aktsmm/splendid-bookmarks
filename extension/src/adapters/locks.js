/**
 * Cross-tab exclusion for the Apply batch.
 *
 * Two options pages can each pass every check and then start writing, so the
 * batch runs inside a Web Lock. `ifAvailable` means a second tab is refused
 * immediately instead of queueing behind a batch whose approval it does not
 * share. No permission is required for this API.
 */
import { LocalizedError } from "../core/errors.js";

// Deliberately not renamed with the product: a page running the previous build
// still holds this key, and changing it would let both take the lock at once.
export const APPLY_LOCK = "ai-agent-bookmark-manager/apply";

export async function withApplyLock(run) {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) throw new LocalizedError("error.locksUnavailable");

  let taken = false;
  const result = await locks.request(
    APPLY_LOCK,
    { ifAvailable: true },
    async (lock) => {
      if (!lock) return undefined;
      taken = true;
      return run();
    },
  );
  if (!taken) throw new LocalizedError("error.applyLockBusy");
  return result;
}
