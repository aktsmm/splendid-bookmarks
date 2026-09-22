import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MESSAGES } from "../extension/src/core/messages.js";

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

function listingBlocks() {
  const source = readFileSync(join(root, "docs", "cws-listing.md"), "utf8");
  const blocks = [...source.matchAll(/```text\r?\n([\s\S]*?)\r?\n```/g)].map(
    (match) => match[1].replace(/\s+/g, " ").trim(),
  );
  assert.equal(
    blocks.length,
    4,
    "expected a summary and description for both locales",
  );
  assert.ok(blocks.every((block) => block.length > 0));
  return blocks;
}

test("listing leads with coding-agent operation instead of optional AI", () => {
  const [enSummary, enDescription, jaSummary, jaDescription] = listingBlocks();
  assert.match(enSummary, /^Let coding agents/);
  assert.match(jaSummary, /^コーディングエージェント/);
  assert.match(
    enDescription,
    /^Splendid Bookmarks for AI Agents is built for coding agents/,
  );
  assert.match(
    jaDescription,
    /^Splendid Bookmarks for AI Agents は、コーディングエージェント/,
  );
  for (const summary of [enSummary, jaSummary])
    assert.ok(summary.length <= 132);
  for (const description of [enDescription, jaDescription]) {
    assert.match(description, /window\.splendidBookmarks\.run/);
    for (const command of [
      "capabilities",
      "getStats",
      "getTree",
      "search",
      "listTrash",
      "preparePlan",
      "loadPlan",
      "dryRun",
      "apply",
      "verify",
      "rollback",
    ]) {
      assert.ok(
        description.includes(command),
        `published command missing: ${command}`,
      );
    }
    assert.doesNotMatch(
      description,
      /OPTIONAL: AI AGENTS|任意: AI エージェント/,
    );
    assert.equal(claimsReadOnly(description), false);
    assert.equal(claimsCannotDelete(description), false);
  }
});

test("release copy includes connection, backup, pagination and data-sharing caveats", () => {
  const [, enDescription, , jaDescription] = listingBlocks();
  assert.match(enDescription, /browser automation access/);
  assert.match(enDescription, /does not connect your agent automatically/);
  assert.match(enDescription, /re-select the backup file/);
  assert.match(enDescription, /deletion cannot be undone/);
  assert.match(enDescription, /external agent.*browser access.*privacy policy/);
  assert.match(jaDescription, /自動接続/);
  assert.match(jaDescription, /バックアップファイルを再選択/);
  assert.match(jaDescription, /永続削除した項目.*元に戻せません/);
  assert.match(jaDescription, /外部エージェント.*プライバシーポリシー/);
  for (const description of [enDescription, jaDescription]) {
    assert.match(description, /500/);
    assert.match(description, /\bgetSession\b/);
    assert.match(description, /\bnextCursor\b/);
    assert.doesNotMatch(description, /version 0\.4\.0|公開版0\.4\.0/);
  }
  assert.match(enDescription, /automatically loads/);
  assert.match(jaDescription, /ツリーを自動/);
  assert.match(enDescription, /CLI is not installed/);
  assert.match(jaDescription, /CLIは拡張機能のインストールには含まれません/);
});

test("store summaries agree with manifest locales, catalog and submission draft", () => {
  const blocks = listingBlocks();
  for (const [locale, index] of [
    ["en", 0],
    ["ja", 2],
  ]) {
    const manifestLocale = JSON.parse(
      readFileSync(join(localesDir, locale, "messages.json"), "utf8"),
    );
    assert.equal(manifestLocale.extensionDescription.message, blocks[index]);
    assert.equal(MESSAGES[locale].extensionDescription, blocks[index]);
  }
  const draft = readFileSync(join(root, "docs", "cws-submit-draft.md"), "utf8");
  const summary = /```text\r?\n([\s\S]*?)\r?\n```/
    .exec(draft)?.[1]
    .replace(/\s+/g, " ")
    .trim();
  assert.equal(summary, blocks[0]);
});

test("the product purpose and first-screen copy stay agent-first", () => {
  for (const file of ["README.md", "docs/design.md"]) {
    const source = readFileSync(join(root, file), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    const introduction = source.split("\n\n")[1];
    assert.match(introduction, /^コーディングエージェントから/);
    assert.doesNotMatch(introduction, /単体で使えることを主線|任意の入力手段/);
  }
  for (const locale of ["en", "ja"]) {
    assert.doesNotMatch(
      MESSAGES[locale]["section.agent.title"],
      /optional|任意/,
    );
    assert.match(MESSAGES[locale]["section.agent.note"], /approval|承認/);
    assert.match(
      MESSAGES[locale]["section.agent.copy"],
      /Copy agent|エージェント/,
    );
  }
  const markup = readFileSync(
    join(root, "extension", "ui", "options.html"),
    "utf8",
  );
  assert.ok(
    markup.indexOf('id="copy-agent-prompt"') <
      markup.indexOf('id="quick-start"'),
  );
});

test("submission copy tracks the package version and discloses explicit clipboard writes", () => {
  const version = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ).version;
  const listing = readFileSync(join(root, "docs", "cws-listing.md"), "utf8");
  const draft = readFileSync(join(root, "docs", "cws-submit-draft.md"), "utf8");
  assert.ok(listing.includes(`This copy targets release ${version}.`));
  assert.ok(draft.includes(`Splendid Bookmarks for AI Agents ${version}`));
  assert.ok(draft.includes(`splendid-bookmarks-v${version}.zip`));
  const [, en, , ja] = listingBlocks();
  assert.match(en, /clipboard only when clicked/);
  assert.match(en, /never reads the clipboard/);
  assert.match(ja, /ボタンを押したときだけ/);
  assert.match(ja, /クリップボードは読み取りません/);
});

test("privacy copy covers browser-agent sharing and versioned startup reads", () => {
  const policy = readFileSync(
    join(root, "docs", "privacy-policy.md"),
    "utf8",
  ).replace(/\s+/g, " ");
  assert.match(policy, /external coding agent browser automation access/);
  assert.match(policy, /外部のコーディングエージェント.*ブラウザー操作/);
  assert.match(policy, /version 0\.5\.0 starts the first read automatically/);
  assert.match(policy, /0\.5\.0は画面を開くと初回読込を自動/);
  assert.doesNotMatch(
    policy,
    /only after you click a button|ページを開いてボタンを押したときだけ/,
  );
});
