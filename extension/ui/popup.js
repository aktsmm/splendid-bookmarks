import { createTranslator } from "../src/core/i18n.js";
import { detectLocale } from "../src/adapters/locale.js";
import { applyStaticTranslations } from "./dom.js";

const translate = createTranslator(detectLocale());
document.documentElement.lang = translate.locale;
applyStaticTranslations(document, translate);

document.getElementById("open-manager").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
