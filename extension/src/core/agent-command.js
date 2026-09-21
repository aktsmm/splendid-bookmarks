/**
 * Command contract for an agent driving the options page.
 *
 * Pure: no `chrome.*`, no DOM. This module owns the vocabulary, the input
 * validation and the result shape; the page adapter owns the dispatch and is
 * what makes every command go through the same code the buttons use.
 *
 * What this contract is NOT: a privilege boundary. Anything that can reach this
 * object — the page's own scripts, devtools, a CDP client, an extension holding
 * the `debugger` permission — can already call `chrome.bookmarks` directly on
 * this page and click every control. The API exists so an agent has a stable
 * surface instead of scraping the DOM, not to decide who may act.
 */
import {
  MAX_BATCH_OPERATIONS,
  MAX_PLAN_OPERATIONS,
  MAX_RENDERED_ROWS,
} from "./limits.js";
import { LocalizedError } from "./errors.js";

export const AGENT_API_VERSION = 1;

/**
 * The whole vocabulary, as a literal. Deriving it from the handler map would
 * make `capabilities()` agree with whatever was wired up rather than with a
 * contract, and an accidentally exported handler would join the API in silence.
 *
 * Deliberately absent:
 * - `emptyTrash`: permanently deleting is not offered here. That is a scope
 *   choice, not a safety boundary — the same delete is one click away in the UI
 *   for anything that can drive this page.
 * - `exportSnapshot`: the page can only tell that a download started, never
 *   that a file reached the disk, so a success here would mean less than it
 *   looks like.
 * - `sendToTrash` / `restoreBatch`: both need a Trash folder and a selection
 *   that only exist as page state today.
 */
export const COMMAND_NAMES = [
  "capabilities",
  "getSession",
  "refreshTree",
  "getStats",
  "getTree",
  "search",
  "listTrash",
  "loadPlan",
  "dryRun",
  "apply",
  "verify",
  "rollback",
];

/** Allowed input fields per command. Anything else is refused, not ignored. */
const COMMAND_INPUTS = new Map([
  ["capabilities", []],
  ["getSession", []],
  ["refreshTree", []],
  ["getStats", []],
  ["getTree", ["limit", "cursor"]],
  ["search", ["query", "limit", "cursor"]],
  ["listTrash", []],
  ["loadPlan", ["plan"]],
  ["dryRun", []],
  ["apply", ["planDigest"]],
  ["verify", []],
  ["rollback", []],
]);

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function limitError(command, value) {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > MAX_RENDERED_ROWS) {
    return {
      key: "agent.error.limit",
      params: { command, limit: MAX_RENDERED_ROWS },
    };
  }
  return null;
}

/**
 * @returns {{ok: true}|{ok: false, key: string, params?: object}}
 */
export function validateInvocation(command, input) {
  if (typeof command !== "string" || !COMMAND_NAMES.includes(command)) {
    return { ok: false, key: "agent.error.unknownCommand" };
  }
  if (input !== undefined && !isPlainObject(input)) {
    return {
      ok: false,
      key: "agent.error.inputNotObject",
      params: { command },
    };
  }
  const given = input ?? {};
  const allowed = COMMAND_INPUTS.get(command);
  for (const field of Object.keys(given)) {
    if (!allowed.includes(field)) {
      return {
        ok: false,
        key: "agent.error.unknownField",
        params: { command, field },
      };
    }
  }

  if (
    command === "apply" &&
    given.planDigest !== undefined &&
    (typeof given.planDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(given.planDigest))
  ) {
    return { ok: false, key: "agent.error.planDigest" };
  }
  if (command === "search") {
    if (typeof given.query !== "string" || given.query.length === 0) {
      return { ok: false, key: "agent.error.query" };
    }
  }
  const badLimit = limitError(command, given.limit);
  if (badLimit) return { ok: false, ...badLimit };

  if (given.cursor !== undefined) {
    const cursor = given.cursor;
    const fields = ["snapshotId", "offset", "command", "query"];
    if (
      !isPlainObject(cursor) ||
      Object.keys(cursor).length !== fields.length ||
      fields.some((field) => !Object.hasOwn(cursor, field)) ||
      typeof cursor.snapshotId !== "string" ||
      cursor.snapshotId.length === 0 ||
      cursor.snapshotId.length > 160 ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 1 ||
      typeof cursor.command !== "string" ||
      typeof cursor.query !== "string"
    ) {
      return { ok: false, key: "agent.error.cursor" };
    }
    if (cursor.command !== command || cursor.query !== (given.query ?? "")) {
      return { ok: false, key: "agent.error.cursorMismatch" };
    }
  }

  if (command === "loadPlan") {
    if (!isPlainObject(given.plan)) {
      return { ok: false, key: "agent.error.planNotObject" };
    }
    // The schema validator reports the same cap, but a hostile array would be
    // walked once here before it ever got there.
    if (
      Array.isArray(given.plan.operations) &&
      given.plan.operations.length > MAX_PLAN_OPERATIONS
    ) {
      return {
        ok: false,
        key: "agent.error.tooManyOperations",
        params: {
          count: given.plan.operations.length,
          limit: MAX_PLAN_OPERATIONS,
        },
      };
    }
  }
  return { ok: true };
}

export function paginateEntries(
  entries,
  { command, snapshotId, query, limit, cursor },
) {
  const input = { limit, cursor, ...(command === "search" ? { query } : {}) };
  const check = validateInvocation(command, input);
  if (!check.ok) throw new LocalizedError(check.key, check.params);
  if (cursor && cursor.snapshotId !== snapshotId) {
    throw new LocalizedError("agent.error.staleCursor");
  }
  const offset = cursor?.offset ?? 0;
  if (offset > entries.length) throw new LocalizedError("agent.error.cursor");
  const shown = entries.slice(offset, offset + (limit ?? MAX_RENDERED_ROWS));
  const nextOffset = offset + shown.length;
  const truncated = nextOffset < entries.length;
  return {
    total: entries.length,
    shown,
    snapshotId,
    truncated,
    nextCursor: truncated
      ? { snapshotId, offset: nextOffset, command, query: query ?? "" }
      : null,
  };
}

/** Fixed success shape. `state` is whatever the command reports. */
export function okResult(command, state) {
  return { ok: true, version: AGENT_API_VERSION, command, state, error: null };
}

/**
 * Fixed failure shape. `error.key` is a message catalog key, never free text,
 * so an agent can branch on it and a user can be shown it in their own locale.
 */
export function errorResult(command, key, params) {
  return {
    ok: false,
    version: AGENT_API_VERSION,
    command,
    state: null,
    error: params === undefined ? { key } : { key, params },
  };
}

/** What an agent reads to discover the surface without probing it. */
export function capabilitiesState() {
  return {
    version: AGENT_API_VERSION,
    commands: [...COMMAND_NAMES],
    limits: {
      maxPlanOperations: MAX_PLAN_OPERATIONS,
      maxBatchOperations: MAX_BATCH_OPERATIONS,
      maxRows: MAX_RENDERED_ROWS,
    },
    features: {
      pagination: true,
      sessionInfo: true,
      automaticTreeLoad: true,
      treeMetadata: true,
      structuredResults: true,
      refreshTree: true,
      planBinding: true,
    },
    // Stated in the descriptor because an agent that discovers the API will not
    // have read the docs.
    notes: {
      applyNeedsHumanBackup: true,
      canDelete: false,
      isSecurityBoundary: false,
    },
  };
}
