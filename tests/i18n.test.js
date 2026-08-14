import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createTranslator,
  formatMessage,
  resolveLocale,
  translateDetail,
} from "../extension/src/core/i18n.js";
import { LocalizedError, describeError } from "../extension/src/core/errors.js";
import {
  DEFAULT_LOCALE,
  MANIFEST_KEYS,
  MESSAGES,
  SUPPORTED_LOCALES,
} from "../extension/src/core/messages.js";
import { STATUS } from "../extension/src/core/validator.js";
import { RECEIPT_STATE } from "../extension/src/core/trash-ledger.js";
import { VERIFY } from "../extension/src/core/reconciliation.js";

const extensionDir = fileURLToPath(new URL("../extension/", import.meta.url));
const readJson = (relative) =>
  JSON.parse(readFileSync(join(extensionDir, relative), "utf8"));

function placeholders(template) {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

function sourceFiles(dir, extensions) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full, extensions);
    return extensions.some((ext) => name.endsWith(ext)) ? [full] : [];
  });
}

test("every supported locale exposes exactly the same keys", () => {
  const reference = Object.keys(MESSAGES[DEFAULT_LOCALE]).sort();
  for (const locale of SUPPORTED_LOCALES) {
    assert.ok(MESSAGES[locale], `catalog missing for ${locale}`);
    assert.deepEqual(Object.keys(MESSAGES[locale]).sort(), reference, locale);
  }
});

test("no message is empty and placeholders agree across locales", () => {
  for (const key of Object.keys(MESSAGES[DEFAULT_LOCALE])) {
    const reference = placeholders(MESSAGES[DEFAULT_LOCALE][key]);
    for (const locale of SUPPORTED_LOCALES) {
      const value = MESSAGES[locale][key];
      assert.ok(value.trim().length > 0, `${locale}.${key} is empty`);
      assert.deepEqual(placeholders(value), reference, `${locale}.${key}`);
    }
  }
});

test("resolveLocale matches on the primary subtag and falls back", () => {
  assert.equal(resolveLocale(["ja-JP"]), "ja");
  assert.equal(resolveLocale(["JA"]), "ja");
  assert.equal(resolveLocale(["en-US"]), "en");
  assert.equal(resolveLocale(["fr-FR", "ja"]), "ja");
  assert.equal(resolveLocale(["fr-FR"]), DEFAULT_LOCALE);
  assert.equal(resolveLocale([undefined, null, ""]), DEFAULT_LOCALE);
  assert.equal(resolveLocale("ja"), "ja");
});

test("formatMessage substitutes known params and leaves unknown ones intact", () => {
  assert.equal(formatMessage("{a} and {b}", { a: 1, b: "x" }), "1 and x");
  assert.equal(formatMessage("{a} and {b}", { a: 1 }), "1 and {b}");
  assert.equal(formatMessage("no params", {}), "no params");
});

test("the translator falls back to the default locale, then to the key", () => {
  const ja = createTranslator("ja");
  assert.equal(ja.locale, "ja");
  assert.equal(ja("status.movable"), MESSAGES.ja["status.movable"]);
  assert.equal(ja("totally.unknown.key"), "totally.unknown.key");

  const unknownLocale = createTranslator("fr");
  assert.equal(unknownLocale.locale, DEFAULT_LOCALE);
  assert.equal(unknownLocale("status.movable"), MESSAGES.en["status.movable"]);
});

test("translateDetail renders the key/params pairs produced by the core", () => {
  const en = createTranslator("en");
  assert.equal(
    translateDetail(en, {
      key: "detail.unsupportedType",
      params: { type: "remove" },
    }),
    'unsupported operation type "remove"',
  );
  assert.equal(translateDetail(en, null), "");
});

test("every dry-run status has a label in every locale", () => {
  for (const status of Object.values(STATUS)) {
    for (const locale of SUPPORTED_LOCALES) {
      assert.ok(
        MESSAGES[locale][`status.${status}`],
        `missing status.${status} in ${locale}`,
      );
    }
  }
});

test("every detail and schema key emitted by the core exists in the catalog", () => {
  const coreFiles = sourceFiles(join(extensionDir, "src", "core"), [".js"]);
  const used = new Set();
  for (const file of coreFiles) {
    if (file.endsWith("messages.js")) continue;
    for (const match of readFileSync(file, "utf8").matchAll(
      /["'`]((?:detail|schema)\.\w+)["'`]/g,
    )) {
      used.add(match[1]);
    }
  }
  assert.ok(used.size > 20, `expected many keys, found ${used.size}`);
  for (const key of used) {
    assert.ok(MESSAGES[DEFAULT_LOCALE][key], `missing catalog entry: ${key}`);
  }
});

test("every execution key emitted anywhere in the build exists in the catalog", () => {
  const files = sourceFiles(extensionDir, [".js"]).filter(
    (file) => !file.endsWith("messages.js"),
  );
  const used = new Set();
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(
      /["'`]((?:apply|restore|snapshot)\.[\w.]+)["'`]/g,
    )) {
      used.add(match[1]);
    }
  }
  assert.ok(used.size > 15, `expected many keys, found ${used.size}`);
  for (const key of used) {
    assert.ok(MESSAGES[DEFAULT_LOCALE][key], `missing catalog entry: ${key}`);
  }
});

test("every data-i18n attribute in the UI resolves to a catalog key", () => {
  const htmlFiles = sourceFiles(join(extensionDir, "ui"), [".html"]);
  const used = new Set();
  for (const file of htmlFiles) {
    for (const match of readFileSync(file, "utf8").matchAll(
      /data-i18n(?:-title)?="([^"]+)"/g,
    )) {
      used.add(match[1]);
    }
  }
  assert.ok(used.size > 10, `expected many keys, found ${used.size}`);
  for (const key of used) {
    assert.ok(MESSAGES[DEFAULT_LOCALE][key], `missing catalog entry: ${key}`);
  }
});

test("no catalog key is dead and every referenced key exists", () => {
  const files = sourceFiles(extensionDir, [".js", ".html"]).filter(
    (file) => !file.endsWith("messages.js"),
  );
  const blob = files.map((file) => readFileSync(file, "utf8")).join("\n");
  // Families the UI composes at runtime; their exact membership is asserted below.
  const dynamicPrefixes = [
    "status.",
    "verify.",
    "browser.",
    "duplicates.mode.",
    "trash.state.",
  ];

  const dead = Object.keys(MESSAGES[DEFAULT_LOCALE]).filter((key) => {
    if (MANIFEST_KEYS.includes(key)) return false;
    if (dynamicPrefixes.some((prefix) => key.startsWith(prefix))) return false;
    return !blob.includes(`"${key}"`) && !blob.includes(`'${key}'`);
  });
  assert.deepEqual(dead, [], "unused catalog keys");
});

test("each runtime-composed key family has exactly the expected members", () => {
  const membersOf = (prefix) =>
    Object.keys(MESSAGES[DEFAULT_LOCALE])
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .sort();

  assert.deepEqual(membersOf("status."), Object.values(STATUS).sort());
  assert.deepEqual(membersOf("verify."), Object.values(VERIFY).sort());
  assert.deepEqual(
    membersOf("trash.state."),
    Object.values(RECEIPT_STATE).sort(),
  );

  const localeAdapter = readFileSync(
    join(extensionDir, "src", "adapters", "locale.js"),
    "utf8",
  );
  // Derive the expected set from detectBrowser so a new branch fails this test.
  const detectBrowserBody = localeAdapter.slice(
    localeAdapter.indexOf("export function detectBrowser"),
  );
  const returned = [
    ...new Set(
      [...detectBrowserBody.matchAll(/return\s+"(\w+)"/g)].map(
        (match) => match[1],
      ),
    ),
  ].sort();
  assert.deepEqual(membersOf("browser."), returned);

  // The duplicate modes are whatever the select in the options page offers.
  const optionValues = [
    ...readFileSync(join(extensionDir, "ui", "options.html"), "utf8").matchAll(
      /<option\b[^>]*>/g,
    ),
  ]
    .filter((match) => match[0].includes("section.duplicates.mode."))
    .map((match) => match[0].match(/value="(\w+)"/)?.[1]);
  assert.ok(optionValues.length > 0, "no duplicate-mode options found");
  assert.deepEqual(membersOf("duplicates.mode."), [...optionValues].sort());
});

test("no message shows the user our internal roadmap vocabulary", () => {
  // "Phase 2" is a milestone in docs/design.md, not something a user can act on.
  const internal = /phase\s*\d|フェーズ/i;
  for (const locale of SUPPORTED_LOCALES) {
    for (const [key, value] of Object.entries(MESSAGES[locale])) {
      assert.ok(
        !internal.test(value),
        `${locale}.${key} leaks roadmap wording: ${value}`,
      );
    }
  }
});

test("every step a message points at is a section that exists", () => {
  for (const locale of SUPPORTED_LOCALES) {
    const catalog = MESSAGES[locale];
    const numbered = new Set(
      Object.entries(catalog)
        .filter(([key]) => /^section\.[\w.]+\.title$/.test(key))
        .map(([, title]) => /^(\d+)\./.exec(title)?.[1])
        .filter(Boolean),
    );
    assert.ok(numbered.size > 0, `${locale} numbers no sections`);
    for (const [key, value] of Object.entries(catalog)) {
      for (const [, en, ja] of value.matchAll(
        /\bsteps?\s+(\d+)|(?:手順|ステップ)\s*(\d+)/gi,
      )) {
        const step = en ?? ja;
        assert.ok(
          numbered.has(step),
          `${locale}.${key} points at step ${step}, which no section title uses`,
        );
      }
    }
  }
});

test("describeError localizes our own errors and passes platform ones through", () => {
  const ja = createTranslator("ja");
  assert.equal(
    describeError(ja, new LocalizedError("error.bookmarksUnavailable")),
    MESSAGES.ja["error.bookmarksUnavailable"],
  );
  assert.equal(
    describeError(
      ja,
      new LocalizedError("detail.unsupportedType", { type: "x" }),
    ),
    MESSAGES.ja["detail.unsupportedType"].replace("{type}", "x"),
  );
  assert.equal(
    describeError(ja, new SyntaxError("Unexpected token")),
    "Unexpected token",
  );
  assert.equal(describeError(ja, "boom"), "boom");
});

test("_locales files match the catalog and cover the manifest placeholders", () => {
  const manifest = readJson("manifest.json");
  assert.equal(manifest.default_locale, DEFAULT_LOCALE);

  const referenced = [
    ...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g),
  ].map((match) => match[1]);
  assert.deepEqual([...new Set(referenced)].sort(), [...MANIFEST_KEYS].sort());

  for (const locale of SUPPORTED_LOCALES) {
    const file = readJson(join("_locales", locale, "messages.json"));
    assert.deepEqual(
      Object.keys(file).sort(),
      [...MANIFEST_KEYS].sort(),
      locale,
    );
    for (const key of MANIFEST_KEYS) {
      assert.equal(
        file[key].message,
        MESSAGES[locale][key],
        `${locale}.${key}`,
      );
    }
  }
});

test("the manifest stays portable to Microsoft Edge", () => {
  const manifest = readJson("manifest.json");
  // Edge's porting guidance: drop update_url and keep "Chrome" out of the listing text.
  assert.equal(manifest.update_url, undefined);
  for (const locale of SUPPORTED_LOCALES) {
    const file = readJson(join("_locales", locale, "messages.json"));
    assert.doesNotMatch(file.extensionName.message, /chrome/i, locale);
    assert.doesNotMatch(file.extensionDescription.message, /chrome/i, locale);
  }
});
