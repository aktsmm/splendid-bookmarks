import assert from "node:assert/strict";
import test from "node:test";

import { LocalizedError } from "../extension/src/core/errors.js";
import {
  MAX_PLAN_ERRORS,
  MAX_PLAN_FILE_BYTES,
  MAX_PLAN_OPERATIONS,
  MAX_RENDERED_ROWS,
  capRows,
  checkPlanFileSize,
} from "../extension/src/core/limits.js";
import { validatePlanDocument } from "../extension/src/core/plan-schema.js";

test("a plan file at or under the limit is accepted", () => {
  assert.equal(checkPlanFileSize(0), null);
  assert.equal(checkPlanFileSize(1024), null);
  assert.equal(checkPlanFileSize(MAX_PLAN_FILE_BYTES), null);
});

test("an oversized plan file is rejected with a localizable error", () => {
  const failure = checkPlanFileSize(MAX_PLAN_FILE_BYTES + 1);
  assert.ok(failure instanceof LocalizedError);
  assert.equal(failure.key, "error.fileTooLarge");
  assert.equal(failure.params.limitBytes, MAX_PLAN_FILE_BYTES);
  assert.equal(failure.params.sizeBytes, MAX_PLAN_FILE_BYTES + 1);
});

test("a missing or unusable size is not treated as a failure", () => {
  assert.equal(checkPlanFileSize(undefined), null);
  assert.equal(checkPlanFileSize(Number.NaN), null);
});

test("the limit is large enough for a realistic plan", () => {
  // ~26 operations of roughly 400 bytes each is the target workload.
  assert.ok(MAX_PLAN_FILE_BYTES > 26 * 400 * 100);
});

test("capRows reports the full total while limiting what gets rendered", () => {
  const rows = Array.from({ length: MAX_RENDERED_ROWS + 10 }, (_, i) => i);

  const capped = capRows(rows);
  assert.equal(capped.shown.length, MAX_RENDERED_ROWS);
  assert.equal(capped.total, rows.length);
  assert.equal(capped.truncated, true);

  const small = capRows([1, 2, 3]);
  assert.deepEqual(small.shown, [1, 2, 3]);
  assert.equal(small.total, 3);
  assert.equal(small.truncated, false);
});

test("capRows does not mutate its input", () => {
  const rows = [1, 2, 3];
  capRows(rows, 1);
  assert.deepEqual(rows, [1, 2, 3]);
});

test("a plan with too many operations is rejected without scanning them", () => {
  const doc = {
    version: 1,
    operations: Array.from({ length: MAX_PLAN_OPERATIONS + 1 }, () => null),
  };
  const result = validatePlanDocument(doc);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].key, "schema.tooManyOperations");
  assert.equal(result.errors[0].params.limit, MAX_PLAN_OPERATIONS);
});

test("error collection stops at the cap so a hostile file cannot build a huge report", () => {
  const doc = {
    version: 1,
    operations: Array.from({ length: MAX_PLAN_OPERATIONS }, () => null),
  };
  const result = validatePlanDocument(doc);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, MAX_PLAN_ERRORS);
});
