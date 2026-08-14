/**
 * Structural validation of an agent-produced plan document.
 * Mirrors schemas/bookmark-plan.schema.json. Pure, dependency-free.
 * Errors carry message keys so the UI can render them in any locale.
 */
import {
  MAX_PLAN_ERRORS,
  MAX_PLAN_OPERATIONS,
  MAX_TITLE_CHARS,
} from "./limits.js";

export const PLAN_VERSION = 2;

/**
 * A version 1 document is still accepted, and still means move-only: `update`
 * arrived with version 2, so an older plan cannot smuggle one in.
 */
const SUPPORTED_PLAN_VERSIONS = new Set([1, 2]);
const TYPES_BY_VERSION = new Map([
  [1, new Set(["move"])],
  [2, new Set(["move", "update"])],
]);

// The published schema declares `additionalProperties: false` at both levels, so
// an unknown key is a contract violation here too. A typo in a field name would
// otherwise be dropped in silence while the plan reported success.
const PLAN_FIELDS = new Set([
  "version",
  "generatedAt",
  "generatedBy",
  "notes",
  "operations",
]);
const MOVE_FIELDS = new Set([
  "opId",
  "type",
  "bookmarkId",
  "expectedTitle",
  "expectedUrl",
  "currentPath",
  "destinationPath",
  "destinationFolderId",
  "reason",
  "confidence",
]);
// A rename has no destination, so those keys are not merely unused here: they
// would describe a move the operation is not going to perform.
const UPDATE_FIELDS = new Set([
  "opId",
  "type",
  "bookmarkId",
  "expectedTitle",
  "expectedUrl",
  "currentPath",
  "newTitle",
  "reason",
  "confidence",
]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value) {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

export function validatePlanDocument(doc) {
  const errors = [];
  // Stop collecting once the report is already unreadable; a hostile file can
  // otherwise turn one operation per five bytes into a million-row table.
  const fail = (path, key, params) => {
    if (errors.length < MAX_PLAN_ERRORS) errors.push({ path, key, params });
  };

  if (!isPlainObject(doc)) {
    return { ok: false, errors: [{ path: "$", key: "schema.notObject" }] };
  }
  if (!SUPPORTED_PLAN_VERSIONS.has(doc.version)) {
    fail("$.version", "schema.version", { expected: PLAN_VERSION });
  }
  if (doc.generatedAt !== undefined && typeof doc.generatedAt !== "string") {
    fail("$.generatedAt", "schema.generatedAt");
  }
  // Declared in schemas/bookmark-plan.schema.json, so it is enforced here too.
  if (doc.generatedBy !== undefined && typeof doc.generatedBy !== "string") {
    fail("$.generatedBy", "schema.generatedBy");
  }
  if (doc.notes !== undefined && typeof doc.notes !== "string") {
    fail("$.notes", "schema.notes");
  }
  for (const field of Object.keys(doc)) {
    if (!PLAN_FIELDS.has(field)) {
      fail(`$.${field}`, "schema.unknownField", { field });
    }
  }
  if (!Array.isArray(doc.operations)) {
    fail("$.operations", "schema.operations");
    return { ok: false, errors };
  }
  if (doc.operations.length > MAX_PLAN_OPERATIONS) {
    fail("$.operations", "schema.tooManyOperations", {
      count: doc.operations.length,
      limit: MAX_PLAN_OPERATIONS,
    });
    return { ok: false, errors };
  }

  const seenOpIds = new Set();
  const allowedTypes = TYPES_BY_VERSION.get(doc.version) ?? new Set(["move"]);
  doc.operations.forEach((op, i) => {
    const at = `$.operations[${i}]`;
    if (!isPlainObject(op)) {
      fail(at, "schema.operationNotObject");
      return;
    }
    if (typeof op.opId !== "string" || op.opId.length === 0) {
      fail(`${at}.opId`, "schema.opId");
    } else if (seenOpIds.has(op.opId)) {
      fail(`${at}.opId`, "schema.opIdDuplicate", { opId: op.opId });
    } else {
      seenOpIds.add(op.opId);
    }
    const isUpdate = op.type === "update";
    if (!allowedTypes.has(op.type)) {
      fail(`${at}.type`, "schema.type");
    }
    if (typeof op.bookmarkId !== "string" || op.bookmarkId.length === 0) {
      fail(`${at}.bookmarkId`, "schema.bookmarkId");
    }
    if (typeof op.expectedTitle !== "string") {
      fail(`${at}.expectedTitle`, "schema.expectedTitle");
    }
    if (op.expectedUrl !== null && typeof op.expectedUrl !== "string") {
      fail(`${at}.expectedUrl`, "schema.expectedUrl");
    }
    if (!isStringArray(op.currentPath)) {
      fail(`${at}.currentPath`, "schema.currentPath");
    }
    if (isUpdate) {
      if (
        typeof op.newTitle !== "string" ||
        op.newTitle.length === 0 ||
        op.newTitle.length > MAX_TITLE_CHARS
      ) {
        fail(`${at}.newTitle`, "schema.newTitle", { limit: MAX_TITLE_CHARS });
      }
    } else {
      if (
        !isStringArray(op.destinationPath) ||
        op.destinationPath.length === 0
      ) {
        fail(`${at}.destinationPath`, "schema.destinationPath");
      }
      if (
        op.destinationFolderId !== undefined &&
        typeof op.destinationFolderId !== "string"
      ) {
        fail(`${at}.destinationFolderId`, "schema.destinationFolderId");
      }
    }
    if (typeof op.reason !== "string" || op.reason.length === 0) {
      fail(`${at}.reason`, "schema.reason");
    }
    if (
      typeof op.confidence !== "number" ||
      op.confidence < 0 ||
      op.confidence > 1
    ) {
      fail(`${at}.confidence`, "schema.confidence");
    }
    const allowedFields = isUpdate ? UPDATE_FIELDS : MOVE_FIELDS;
    for (const field of Object.keys(op)) {
      if (!allowedFields.has(field)) {
        fail(`${at}.${field}`, "schema.unknownField", { field });
      }
    }
  });

  return { ok: errors.length === 0, errors };
}
