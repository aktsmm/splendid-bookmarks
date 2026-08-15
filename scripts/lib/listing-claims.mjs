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
