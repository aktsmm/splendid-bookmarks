import assert from "node:assert/strict";
import test from "node:test";

import { LocalizedError, describeError } from "../extension/src/core/errors.js";
import {
  DIGEST_PREVIEW_LENGTH,
  formatBytes,
  formatCount,
  formatDigest,
} from "../extension/src/core/format.js";
import { createTranslator } from "../extension/src/core/i18n.js";
import { MAX_PLAN_FILE_BYTES } from "../extension/src/core/limits.js";

test("byte sizes render in the largest sensible unit", () => {
  assert.equal(formatBytes(0, "en"), "0 B");
  assert.equal(formatBytes(512, "en"), "512 B");
  assert.equal(formatBytes(1024, "en"), "1.0 KiB");
  assert.equal(formatBytes(1536, "en"), "1.5 KiB");
  assert.equal(formatBytes(MAX_PLAN_FILE_BYTES, "en"), "8.0 MiB");
  assert.equal(formatBytes(15 * 1024 * 1024, "en"), "15 MiB");
});

test("byte sizes degrade safely on unusable input", () => {
  assert.equal(formatBytes(Number.NaN, "en"), "NaN");
  assert.equal(formatBytes(-1, "en"), "-1");
});

test("digests are shortened to a recognisable prefix", () => {
  const digest =
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  const short = formatDigest(digest);
  assert.equal(short.length, DIGEST_PREVIEW_LENGTH + 1);
  assert.ok(digest.startsWith(short.slice(0, -1)));
  assert.ok(short.endsWith("…"));
  assert.equal(formatDigest("abc"), "abc");
});

test("the translator groups numeric params for the locale", () => {
  const en = createTranslator("en");
  assert.match(en("tree.status.loaded", { count: 5102 }), /5,102/);
  assert.match(en("tree.status.loaded", { count: 12 }), /12/);
});

test("strings passed as params are left untouched", () => {
  const en = createTranslator("en");
  const rendered = en("agent.export.done", {
    filename: "agent-context.json",
    bytes: "8.0 MiB",
    digest: "ba7816bf8f01…",
  });
  assert.match(rendered, /agent-context\.json/);
  assert.match(rendered, /8\.0 MiB/);
  assert.match(rendered, /ba7816bf8f01…/);
});

test("byte-valued error params render as sizes, not bare numbers", () => {
  const en = createTranslator("en");
  const failure = new LocalizedError("error.fileTooLarge", {
    sizeBytes: 12 * 1024 * 1024,
    limitBytes: MAX_PLAN_FILE_BYTES,
  });
  const rendered = describeError(en, failure);
  assert.match(rendered, /12 MiB/);
  assert.match(rendered, /8\.0 MiB/);
  assert.ok(!rendered.includes("12582912"));
});

test("a plain limit stays a number, so only byte-named params get units", () => {
  const en = createTranslator("en");
  const failure = new LocalizedError("schema.tooManyOperations", {
    count: 6000,
    limit: 5000,
  });
  const rendered = describeError(en, failure);
  assert.match(rendered, /6,000/);
  assert.match(rendered, /5,000/);
  assert.ok(!rendered.includes("KiB"));
});

test("counts are grouped for the locale", () => {
  assert.equal(formatCount(5102, "en"), "5,102");
  assert.equal(formatCount(0, "en"), "0");
  assert.equal(formatCount(Number.NaN, "en"), "NaN");
});

test("non-byte error params keep their normal formatting", () => {
  const en = createTranslator("en");
  const failure = new LocalizedError("detail.unsupportedType", {
    type: "remove",
  });
  assert.match(describeError(en, failure), /"remove"/);
});
