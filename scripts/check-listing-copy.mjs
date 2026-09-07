import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  extractStoreListings,
  listingCopyMatches,
  normalizeListingText,
} from "./lib/listing-claims.mjs";

const help = `Validate CWS listing fields without opening a browser or writing files.
  node scripts/check-listing-copy.mjs
  node scripts/check-listing-copy.mjs --locale ja --field description --actual tmp/saved-description.txt
  node scripts/check-listing-copy.mjs --self-test

--actual must contain the saved textarea value read back from the same locale after
navigating away and back. Supply only that field, not a page dump or tool envelope.
Only line endings are normalized: changed words, spaces and blank lines still fail.
Output is limited to field names, character counts and hashes; no copied text is printed.
Summary matching verifies the source, not a live store update. CWS summaries come from
the package manifest. Upload, saved draft, review submission and public availability
must each be verified independently; this command performs none of those actions.`;

function selfTest() {
  const fixture = [
    "## English", "### Summary", "```text", "Summary", "```",
    "### Detailed description", "```text", "First line", "", "Second line", "```",
    "## 日本語", "### 概要", "```text", "Japanese summary", "```",
    "### 詳細な説明", "```text", "Japanese description", "```",
  ].join("\n");
  const expected = extractStoreListings(fixture);
  for (const newline of ["\n", "\r\n", "\r"]) {
    assert.deepEqual(extractStoreListings(fixture.replaceAll("\n", newline)), expected);
  }
  const sections = fixture.split("## 日本語");
  const reordered = `## 日本語${sections[1]}\n${sections[0]}`;
  assert.deepEqual(extractStoreListings(reordered), expected);
  for (const invalid of [
    "", "guidance only", fixture.replace("## English", "## Other"),
    fixture.replace("### Detailed description", "### Other"),
    fixture.replace("```text\nSummary\n```", "```text\n \n```"),
    fixture.replace("### Summary", "### Summary\n### Summary"),
    fixture + "\n## English\n", fixture + "\n```text\nExtra block\n```",
    fixture.slice(0, -3),
  ]) assert.throws(() => extractStoreListings(invalid));
  assert.equal(listingCopyMatches("first\r\n\r\nsecond", "first\n\nsecond"), true);
  for (const actual of ["", "First\n\nsecond", "first \n\nsecond", "first\nsecond", "first\n\nsecond\n"]) {
    assert.equal(listingCopyMatches("first\n\nsecond", actual), false);
  }
  assert.equal(listingCopyMatches("", ""), false);
  assert.equal(listingCopyMatches(" ", " "), false);
  assert.throws(() => listingCopyMatches("source", undefined), TypeError);
  console.log("SELF-TEST PASS: field identity, malformed input, newline equivalence and content mismatches");
}

try {
  const { values } = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      locale: { type: "string" },
      field: { type: "string" },
      actual: { type: "string" },
      "self-test": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(help);
  } else if (values["self-test"]) {
    if (values.locale || values.field || values.actual) throw new Error("--self-test cannot include comparison options");
    selfTest();
  } else {
    if (values.locale !== undefined && !["en", "ja"].includes(values.locale)) throw new Error("Locale must be en or ja");
    if (values.field !== undefined && !["summary", "description"].includes(values.field)) throw new Error("Field must be summary or description");
    if (values.actual !== undefined && (!values.actual.trim() || !values.locale || !values.field)) {
      throw new Error("--actual requires a nonempty path and explicit --locale and --field");
    }
    const listings = extractStoreListings(readFileSync(new URL("../docs/cws-listing.md", import.meta.url), "utf8"));
    const fields = [];
    for (const [locale, content] of Object.entries(listings)) {
      for (const [field, text] of Object.entries(content)) {
        if (values.locale && locale !== values.locale) continue;
        if (values.field && field !== values.field) continue;
        fields.push({ locale, field, characters: text.length,
          sha256: createHash("sha256").update(text, "utf8").digest("hex") });
      }
    }
    if (values.actual === undefined) {
      console.log(JSON.stringify({ status: "SOURCE_VALID", fields }, null, 2));
    } else {
      const actual = normalizeListingText(readFileSync(values.actual, "utf8"));
      const matches = listingCopyMatches(listings[values.locale][values.field], actual);
      console.log(JSON.stringify({ status: matches ? "MATCH" : "MISMATCH", expected: fields[0],
        actual: { characters: actual.length, sha256: createHash("sha256").update(actual, "utf8").digest("hex") } }, null, 2));
      if (!matches) process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(`LISTING COPY CHECK FAILED: ${error.message}`);
  process.exitCode = 1;
}