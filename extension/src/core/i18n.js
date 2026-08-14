/**
 * Locale resolution and message formatting. Pure: no DOM, no `chrome.*`.
 */
import { DEFAULT_LOCALE, MESSAGES, SUPPORTED_LOCALES } from "./messages.js";

/**
 * Picks the first supported locale from the candidates, matching on the primary
 * subtag so `ja-JP` resolves to `ja`.
 */
export function resolveLocale(candidates, supported = SUPPORTED_LOCALES) {
  const list = (Array.isArray(candidates) ? candidates : [candidates]).filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  for (const candidate of list) {
    const primary = candidate.toLowerCase().split("-")[0];
    const match = supported.find((locale) => locale.toLowerCase() === primary);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

export function formatMessage(template, params = {}) {
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}

/** Falls back to the default locale, then to the key itself, so the UI never renders empty. */
export function createTranslator(locale) {
  const active = MESSAGES[locale] ? locale : DEFAULT_LOCALE;
  const numbers = new Intl.NumberFormat(active);

  const translate = (key, params) => {
    const template = MESSAGES[active][key] ?? MESSAGES[DEFAULT_LOCALE][key];
    if (template === undefined) return key;
    // Counts reach four digits on real profiles, so group them for the locale.
    const localized = {};
    for (const [name, value] of Object.entries(params ?? {})) {
      localized[name] =
        typeof value === "number" ? numbers.format(value) : value;
    }
    return formatMessage(template, localized);
  };
  translate.locale = active;
  return translate;
}

/** Translates a `{ key, params }` pair produced by the pure core modules. */
export function translateDetail(translate, detail) {
  if (!detail || typeof detail.key !== "string") return "";
  return translate(detail.key, detail.params);
}
