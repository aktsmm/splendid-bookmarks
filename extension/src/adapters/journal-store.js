/**
 * Journal and trash ledger persistence. The only module allowed to touch
 * `chrome.storage`.
 *
 * Two records live here with deliberately different lifetimes. The apply
 * journal is the crash-recovery record for one plan-driven batch and is
 * removed once that batch is settled. The trash ledger is the write-ahead
 * record for trash and restore moves and must outlive them, because the whole
 * point is restoring something days later.
 */
import { LocalizedError } from "../core/errors.js";

const JOURNAL_KEY = "apply-journal";
const TRASH_LEDGER_KEY = "trash-ledger";

function area() {
  const storage = globalThis.chrome?.storage?.local;
  if (!storage) throw new LocalizedError("error.storageUnavailable");
  return storage;
}

export async function loadJournal() {
  const bag = await area().get(JOURNAL_KEY);
  return bag?.[JOURNAL_KEY] ?? null;
}

export async function saveJournal(journal) {
  await area().set({ [JOURNAL_KEY]: journal });
}

export async function clearJournal() {
  await area().remove(JOURNAL_KEY);
}

/** Returned unvalidated on purpose: `readLedger` decides what is usable. */
export async function loadTrashLedgerRecord() {
  const bag = await area().get(TRASH_LEDGER_KEY);
  return bag?.[TRASH_LEDGER_KEY] ?? null;
}

/**
 * Key order is not preserved through extension storage: what comes back is
 * sorted, so a plain `JSON.stringify` comparison reports a conflict on every
 * write after the first. Compare a canonical form instead.
 */
function canonical(value) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

/**
 * Refuses to write when the stored value is not the one the caller started
 * from. `chrome.storage` has no atomic compare-and-swap, so two tabs that read
 * the same value simultaneously can still both pass this check: exclusion is
 * the Web Lock's job, and this is the detector for the case where a write
 * happened outside it.
 */
export async function saveTrashLedger(ledger, { expect } = {}) {
  if (expect !== undefined) {
    const current = await loadTrashLedgerRecord();
    if (canonical(current) !== canonical(expect)) {
      throw new LocalizedError("error.trashLedgerConflict");
    }
  }
  await area().set({ [TRASH_LEDGER_KEY]: ledger });
}

export async function clearTrashLedger() {
  await area().remove(TRASH_LEDGER_KEY);
}
