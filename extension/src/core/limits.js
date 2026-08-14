/**
 * Boundary limits for untrusted input. The plan file is user-selected and its
 * size decides how much work every later stage does, so it is checked first.
 */
import { LocalizedError } from "./errors.js";

/** Generous for a real plan (tens of KB) while keeping a wrong file from freezing the page. */
export const MAX_PLAN_FILE_BYTES = 8 * 1024 * 1024;

/** A table larger than this stops being readable and starts costing seconds of layout. */
export const MAX_RENDERED_ROWS = 500;

/** Far above any real plan; a larger one is a wrong file, not a plan. */
export const MAX_PLAN_OPERATIONS = 5000;

/** Validation stops collecting past this so a hostile file cannot build a huge report. */
export const MAX_PLAN_ERRORS = 200;

/** One Apply batch re-reads the whole tree per operation, so the batch is capped. */
export const MAX_BATCH_OPERATIONS = 200;

/** A snapshot is a user-selected file, so it is size-checked like a plan. */
export const MAX_SNAPSHOT_FILE_BYTES = 32 * 1024 * 1024;

/** Well past any real profile; a larger one is a wrong file, not a snapshot. */
export const MAX_SNAPSHOT_NODES = 200000;

/** A drift report only has to identify the change, not enumerate the profile. */
export const MAX_DRIFT_ROWS = 50;

/**
 * Recovery metadata outlives the batch that produced it, so the trash ledger
 * needs its own ceiling: MAX_BATCH_OPERATIONS bounds one Apply, not accumulated
 * history. Reaching this refuses new trash operations rather than dropping
 * receipts, so the escape is compaction or an explicit forget.
 */
export const MAX_TRASH_RECEIPTS = 500;

/** Titles and URLs are copied into the receipt, so one pathological node must not eat the budget alone. */
export const MAX_TRASH_FIELD_CHARS = 2048;

/** A failure detail is a short reason, not prose, and the capacity preflight has to reserve it. */
export const MAX_TRASH_DETAIL_CHARS = 200;

/** Well under the 10 MB storage.local quota, leaving headroom for the batch journal and for the write that grows the ledger. */
export const MAX_TRASH_LEDGER_BYTES = 1024 * 1024;

/** Advisory only. Nothing is purged when it elapses; restore is still attempted while the node is present. */
export const DEFAULT_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** A new title is copied into the journal for rollback, so it gets the same ceiling as a receipt field. */
export const MAX_TITLE_CHARS = 2048;

/** Below this profile-wide agreement the snapshot belongs to another profile. */
export const MIN_PROVENANCE_RATE = 0.9;

export function checkPlanFileSize(size, limit = MAX_PLAN_FILE_BYTES) {
  if (typeof size !== "number" || Number.isNaN(size)) return null;
  if (size <= limit) return null;
  return new LocalizedError("error.fileTooLarge", {
    sizeBytes: size,
    limitBytes: limit,
  });
}

export function capRows(rows, limit = MAX_RENDERED_ROWS) {
  return {
    shown: rows.slice(0, limit),
    total: rows.length,
    truncated: rows.length > limit,
  };
}
