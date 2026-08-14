import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { validatePlanDocument } from "../extension/src/core/plan-schema.js";
import { moveOperation, planWith } from "./fixtures/sample-tree.js";

const readJson = (relative) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url))));

const SCHEMA = readJson("../extension/schemas/bookmark-plan.schema.json");
const OPERATION_SCHEMA = SCHEMA.$defs.moveOperation;

/** A value the declared type must reject, so one bad value proves enforcement. */
function offendingValue(spec) {
  if (spec.const !== undefined) {
    return typeof spec.const === "number" ? spec.const + 1 : "not-the-const";
  }
  const types = [].concat(spec.type ?? []);
  if (types.includes("array")) return "not-an-array";
  if (types.includes("number")) return "not-a-number";
  // Everything else here is a string or a string/null union.
  return 12345;
}

/**
 * The plan file is the one input an AI agent controls, and deletion is the one
 * operation that cannot be undone. Keeping `delete` unrepresentable here is what
 * makes "an agent can propose a move to Trash and nothing more" a property of
 * the contract rather than of the UI.
 */
test("a plan cannot express deletion under any of the obvious spellings", () => {
  for (const type of ["delete", "remove", "removeTree", "trash", "empty"]) {
    const doc = planWith({ ...moveOperation(), type });
    const result = validatePlanDocument(doc);
    assert.equal(result.ok, false, `type ${type} must be rejected`);
    assert.ok(
      result.errors.some((error) => error.key === "schema.type"),
      `type ${type} must be rejected as a type error`,
    );
  }
});

test("the published example plan is one this build accepts", () => {
  // The example is what an agent is pointed at, so it cannot drift from the code.
  const result = validatePlanDocument(
    readJson("../docs/examples/bookmark-plan.example.json"),
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("every field the published schema requires is enforced here", () => {
  for (const field of SCHEMA.required) {
    const doc = planWith(moveOperation());
    delete doc[field];
    assert.equal(
      validatePlanDocument(doc).ok,
      false,
      `a plan without ${field} must be rejected`,
    );
  }
  for (const field of OPERATION_SCHEMA.required) {
    const op = moveOperation();
    delete op[field];
    assert.equal(
      validatePlanDocument(planWith(op)).ok,
      false,
      `an operation without ${field} must be rejected`,
    );
  }
});

test("every type the published schema declares is enforced here", () => {
  for (const [field, spec] of Object.entries(SCHEMA.properties)) {
    if (field === "operations") continue; // Covered by the operation cases below.
    const doc = planWith(moveOperation());
    doc[field] = offendingValue(spec);
    assert.equal(
      validatePlanDocument(doc).ok,
      false,
      `${field} accepted ${JSON.stringify(doc[field])}, which the schema forbids`,
    );
  }
  for (const [field, spec] of Object.entries(OPERATION_SCHEMA.properties)) {
    const op = moveOperation();
    op[field] = offendingValue(spec);
    assert.equal(
      validatePlanDocument(planWith(op)).ok,
      false,
      `${field} accepted ${JSON.stringify(op[field])}, which the schema forbids`,
    );
  }
});

test("a plan using every declared field, with valid values, is accepted", () => {
  // The other direction: the runtime must not be stricter than what is published.
  const doc = planWith({
    ...moveOperation(),
    destinationFolderId: "9",
  });
  doc.generatedAt = "2026-01-01T00:00:00.000Z";
  doc.generatedBy = "some agent";
  doc.notes = "nothing else to move";
  assert.deepEqual(
    Object.keys(doc).sort(),
    Object.keys(SCHEMA.properties).sort(),
  );
  assert.deepEqual(
    Object.keys(doc.operations[0]).sort(),
    Object.keys(OPERATION_SCHEMA.properties).sort(),
  );
  assert.deepEqual(validatePlanDocument(doc).errors, []);
});

test("the schema forbids extra properties, so the gate refuses them too", () => {
  // A mistyped field name would otherwise be dropped in silence.
  assert.equal(SCHEMA.additionalProperties, false);
  assert.equal(OPERATION_SCHEMA.additionalProperties, false);

  const extraTopLevel = planWith(moveOperation());
  extraTopLevel.nope = 1;
  assert.equal(validatePlanDocument(extraTopLevel).ok, false);

  const typo = moveOperation();
  typo.destinationFolderID = "9";
  const result = validatePlanDocument(planWith(typo));
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].key, "schema.unknownField");
  assert.equal(result.errors[0].params.field, "destinationFolderID");
});

test("a well-formed plan validates", () => {
  const result = validatePlanDocument(planWith(moveOperation()));
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("non-objects and unsupported versions are rejected", () => {
  assert.equal(validatePlanDocument(null).ok, false);
  assert.equal(validatePlanDocument([]).ok, false);
  assert.equal(
    validatePlanDocument({ version: 3, operations: [moveOperation()] }).ok,
    false,
  );
  assert.equal(
    validatePlanDocument({ version: "2", operations: [moveOperation()] }).ok,
    false,
  );
  // Both supported versions still accept a move; only `update` is gated.
  for (const version of [1, 2]) {
    assert.equal(
      validatePlanDocument({ version, operations: [moveOperation()] }).ok,
      true,
      `version ${version}`,
    );
  }
});

test("a missing or non-array operations field is rejected", () => {
  assert.equal(validatePlanDocument({ version: 1 }).ok, false);
  assert.equal(validatePlanDocument({ version: 1, operations: {} }).ok, false);
});

test("an empty operations array is valid, since the agent may place nothing", () => {
  const result = validatePlanDocument({
    version: 1,
    notes: "nothing needed moving",
    operations: [],
  });
  assert.deepEqual(result.errors, []);
});

test("required operation fields are checked individually", () => {
  const cases = [
    ["opId", { opId: "" }],
    ["type", { type: "remove" }],
    ["bookmarkId", { bookmarkId: 42 }],
    ["expectedTitle", { expectedTitle: undefined }],
    ["expectedUrl", { expectedUrl: 7 }],
    ["currentPath", { currentPath: "Bar/Dev" }],
    ["destinationPath", { destinationPath: [] }],
    ["destinationFolderId", { destinationFolderId: 3 }],
    ["reason", { reason: "" }],
    ["confidence", { confidence: 1.5 }],
  ];
  for (const [field, override] of cases) {
    const result = validatePlanDocument(planWith(moveOperation(override)));
    assert.equal(result.ok, false, `${field} should have failed validation`);
    assert.ok(
      result.errors.some((error) => error.path.endsWith(`.${field}`)),
      `${field} error not reported, got ${JSON.stringify(result.errors)}`,
    );
  }
});

test("every error carries a message key instead of a hardcoded sentence", () => {
  const result = validatePlanDocument({ version: 9, operations: [{}] });
  assert.equal(result.ok, false);
  for (const error of result.errors) {
    assert.equal(typeof error.key, "string");
    assert.ok(error.key.startsWith("schema."));
    assert.equal(error.message, undefined);
  }
});

test("expectedUrl may be null for folders", () => {
  assert.equal(
    validatePlanDocument(planWith(moveOperation({ expectedUrl: null }))).ok,
    true,
  );
});

test("duplicate opIds are rejected", () => {
  const result = validatePlanDocument(
    planWith(moveOperation(), moveOperation({ bookmarkId: "110" })),
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (error) =>
        error.key === "schema.opIdDuplicate" && error.params?.opId === "op-1",
    ),
  );
});
