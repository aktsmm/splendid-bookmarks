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
