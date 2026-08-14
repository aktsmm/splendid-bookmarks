/**
 * Runtime locale and browser detection. The only module allowed to read
 * `localStorage`, and it stores nothing but the UI language preference.
 */
import { resolveLocale } from "../core/i18n.js";
import { SUPPORTED_LOCALES } from "../core/messages.js";

const LOCALE_KEY = "agbm.ui-locale";

export function readStoredLocale() {
  try {
    const stored = globalThis.localStorage?.getItem(LOCALE_KEY);
    return SUPPORTED_LOCALES.includes(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function storeLocale(locale) {
  if (!SUPPORTED_LOCALES.includes(locale)) return;
  try {
    globalThis.localStorage?.setItem(LOCALE_KEY, locale);
  } catch {
    // Private modes can reject writes; the selection still applies to this page.
  }
}

export function detectLocale() {
  const stored = readStoredLocale();
  if (stored) return stored;
  const uiLanguage = globalThis.chrome?.i18n?.getUILanguage?.();
  return resolveLocale([
    uiLanguage,
    ...(navigator.languages ?? []),
    navigator.language,
  ]);
}

/** Chromium-family identification, used only to label the environment in the UI. */
export function detectBrowser() {
  const brands = navigator.userAgentData?.brands ?? [];
  if (brands.some((brand) => brand.brand === "Microsoft Edge")) return "edge";
  if (brands.some((brand) => brand.brand === "Google Chrome")) return "chrome";
  const agent = navigator.userAgent ?? "";
  if (/\bEdg\//.test(agent)) return "edge";
  if (/\bChrome\//.test(agent)) return "chrome";
  return "other";
}
