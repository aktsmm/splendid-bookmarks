/**
 * Presentation helpers for values that are unreadable in their raw form.
 * Pure: the locale is always passed in.
 */

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB"];

/** Counts reach four digits on real profiles, so group them for the locale. */
export function formatCount(value, locale) {
  if (!Number.isFinite(value)) return String(value);
  return new Intl.NumberFormat(locale).format(value);
}

export function formatBytes(value, locale) {
  if (!Number.isFinite(value) || value < 0) return String(value);

  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < BYTE_UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || size >= 10 ? 0 : 1;
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(size);
  return `${formatted} ${BYTE_UNITS[unit]}`;
}

/** A 64-character hash inside a sentence is noise; keep enough to recognise it. */
export const DIGEST_PREVIEW_LENGTH = 12;

export function formatDigest(hex, length = DIGEST_PREVIEW_LENGTH) {
  if (typeof hex !== "string" || hex.length <= length) return String(hex);
  return `${hex.slice(0, length)}…`;
}
