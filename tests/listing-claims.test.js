import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  claimsCannotDelete,
  claimsReadOnly,
  pastedListingCopy,
} from "../scripts/lib/listing-claims.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const localesDir = join(root, "extension", "_locales");

// Written out as literals rather than derived from the predicate, so a widened
// regex cannot quietly agree with its own test.
const READ_ONLY_VIOLATIONS = [
  "A read-only view of your bookmarks",
  "This is a read only build",
  "It never writes to your bookmarks",
  "It doesn't write anything",
  "ブックマークを書き換えません",
  "ブックマークを変更しません",
];

const CANNOT_DELETE_VIOLATIONS = [
  "It never deletes a bookmark",
  "It never delete anything",
  "This build doesn't delete bookmarks",
  "The extension cannot delete anything",
  "There is no deletion path",
  "削除しません",
  "削除はしません",
  "このビルドは削除できません",
  "削除を行いません",
];

// Listing copy is a standalone sentence with no surrounding context, so these
// predicates deliberately flag the blanket phrasings outright. In-page strings
// can scope the same words to one action ("この操作では削除しません"), which is
// true; they are not listing text and are not run through these predicates.
const ACCEPTABLE = [
  "Tidy bookmarks safely: dry run, verified backup, rollback, a reversible Trash folder, and a confirmed two-step delete.",
  "Dry Run とバックアップ検証のうえで移動を適用します。Trash へ送った項目はバッチ単位で元の並び順のまま戻せます。永続削除は確認付きの別ステップです。",
  "Move bookmarks, quarantine duplicates, and delete from the Trash once you confirm.",
  "移動、重複の隔離、Trash からの確認付き永続削除。",
];

test("the read-only predicate catches every phrasing we have shipped", () => {
  for (const text of READ_ONLY_VIOLATIONS) {
    assert.equal(claimsReadOnly(text), true, text);
  }
});

test("the cannot-delete predicate catches every phrasing we have shipped", () => {
  for (const text of CANNOT_DELETE_VIOLATIONS) {
    assert.equal(claimsCannotDelete(text), true, text);
  }
});

test("truthful copy is not rejected by either predicate", () => {
  for (const text of ACCEPTABLE) {
    assert.equal(claimsReadOnly(text), false, `read-only: ${text}`);
    assert.equal(claimsCannotDelete(text), false, `cannot-delete: ${text}`);
  }
});

test("the shipped listing text makes neither claim", () => {
  for (const locale of readdirSync(localesDir)) {
    const messages = JSON.parse(
      readFileSync(join(localesDir, locale, "messages.json"), "utf8"),
    );
    const text = `${messages.extensionName?.message ?? ""} ${
      messages.extensionDescription?.message ?? ""
    }`;
    assert.equal(claimsReadOnly(text), false, `${locale} claims read-only`);
    assert.equal(
      claimsCannotDelete(text),
      false,
      `${locale} claims it cannot delete`,
    );
  }
});

test("only the pasted blocks are extracted, and CRLF fences still match", () => {
  const markdown = [
    "Guidance: this copy must not claim the extension is read-only.",
    "",
    "```text",
    "Tidy your bookmarks.",
    "```",
    "",
    "More guidance: it must not say it cannot delete bookmarks.",
    "",
    "```text",
    "Deleting for good cannot be",
    "undone.",
    "```",
  ].join("\r\n");

  const flat = pastedListingCopy(markdown);

  // The guidance names both forbidden claims; only the fenced copy is checked.
  assert.equal(claimsReadOnly(flat), false);
  assert.equal(claimsCannotDelete(flat), false);
  // A phrase broken across a hard wrap has to survive the extraction.
  assert.match(flat, /cannot be undone/);
});

test("a violation inside a pasted block is still caught", () => {
  const markdown = "```text\r\nThis extension cannot delete anything.\r\n```";
  assert.equal(claimsCannotDelete(pastedListingCopy(markdown)), true);
});

test("a draft with no pasted block yields nothing rather than a silent pass", () => {
  assert.equal(pastedListingCopy("no fenced blocks here"), "");
});
