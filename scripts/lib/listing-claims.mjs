/**
 * Predicates for store listing text, kept out of the report script so they can
 * be pinned by tests instead of only being exercised by a one-off manual run.
 *
 * These are supplementary gates. A regex only catches the phrasings written
 * here; it cannot prove the listing text as a whole is truthful, so a passing
 * result is not evidence that the copy matches the build.
 */

const READ_ONLY_CLAIMS =
  /read-only|read only|never writes?|does ?n[o']t write|書き換えません|書き換えない|変更しません/i;

const CANNOT_DELETE_CLAIMS =
  /never deletes?|does ?n[o']t delete|cannot delete|can ?not delete|no deletion|削除しません|削除はしません|削除できません|削除を行いません|削除は行いません/i;

/** True when the text tells a reviewer the build never writes. It does write. */
export function claimsReadOnly(text) {
  return READ_ONLY_CLAIMS.test(text);
}

/**
 * True when the text tells a reviewer the build cannot delete. It can delete a
 * confirmed item out of the Trash folder, and that delete is irreversible.
 */
export function claimsCannotDelete(text) {
  return CANNOT_DELETE_CLAIMS.test(text);
}

export function normalizeListingText(text) {
  if (typeof text !== "string")
    throw new TypeError("Listing text must be a string");
  return text.replace(/\r\n?/g, "\n");
}

function textBlocks(markdown) {
  return [
    ...normalizeListingText(markdown).matchAll(
      /^```text[ \t]*\n([\s\S]*?)\n```[ \t]*(?:\n|$)/gm,
    ),
  ].map((match) => match[1]);
}

export function extractStoreListings(markdown) {
  const normalized = normalizeListingText(markdown);
  const sections = normalized.split(/^##[ \t]+/m).slice(1);
  const formats = [
    ["en", "English", "Summary", "Detailed description"],
    ["ja", "日本語", "概要", "詳細な説明"],
  ];
  const listings = {};
  for (const [locale, heading, summaryHeading, descriptionHeading] of formats) {
    const matches = sections.filter(
      (section) => section.split("\n")[0].trim() === heading,
    );
    if (matches.length !== 1)
      throw new Error(`Expected one ${locale} listing section`);
    const fields = matches[0].split(/^###[ \t]+/m).slice(1);
    listings[locale] = {};
    for (const [field, title] of [
      ["summary", summaryHeading],
      ["description", descriptionHeading],
    ]) {
      const candidates = fields.filter(
        (section) => section.split("\n")[0].trim() === title,
      );
      if (candidates.length !== 1)
        throw new Error(`Expected one ${locale}.${field} heading`);
      const blocks = textBlocks(candidates[0]);
      if (blocks.length !== 1 || blocks[0].trim().length === 0) {
        throw new Error(`Expected one nonempty ${locale}.${field} text block`);
      }
      listings[locale][field] = blocks[0];
    }
  }
  if (textBlocks(normalized).length !== formats.length * 2) {
    throw new Error("Unexpected store listing text blocks");
  }
  return listings;
}

export function listingCopyMatches(expected, actual) {
  const source = normalizeListingText(expected);
  const saved = normalizeListingText(actual);
  return (
    source.trim().length > 0 && saved.trim().length > 0 && source === saved
  );
}

/**
 * The listing draft holds both the copy that gets pasted into the dashboard and
 * the guidance about what that copy must not claim. Only the fenced `text`
 * blocks are pasted, so the predicates above have to run on those alone or the
 * guidance fails the check it exists to describe.
 *
 * Returned as a single line: the copy is hard-wrapped, and a phrase that
 * straddles a line break otherwise reads to a regex as if it were absent.
 */
export function pastedListingCopy(markdown) {
  return [...markdown.matchAll(/```text\r?\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}
