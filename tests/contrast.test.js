import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  composite,
  contrastRatio,
  readColorSchemes,
} from "./helpers/contrast.js";

const cssPath = fileURLToPath(
  new URL("../extension/ui/styles.css", import.meta.url),
);
const css = readFileSync(cssPath, "utf8").replace(/\r\n/g, "\n");
const schemes = readColorSchemes(css);

const AA_NORMAL_TEXT = 4.5;

/** Every foreground that carries meaning, against every surface it sits on. */
const PAIRS = [
  ["--fg", "--bg"],
  ["--fg", "--panel"],
  ["--muted", "--bg"],
  ["--muted", "--panel"],
  ["--ok", "--bg"],
  ["--ok", "--panel"],
  ["--warn", "--bg"],
  ["--warn", "--panel"],
  ["--error", "--bg"],
  ["--error", "--panel"],
  // The primary button paints accent-fg on accent.
  ["--accent-fg", "--accent"],
];

/** Semi-transparent fills, flattened onto the surface they actually sit on. */
const TRANSLUCENT_PAIRS = [
  {
    label: ".badge-safe",
    foreground: "--ok",
    fill: "rgba(19, 115, 51, 0.12)",
    backdrop: "--bg",
  },
  {
    label: "table th",
    foreground: "--fg",
    fill: "rgba(127, 127, 127, 0.12)",
    backdrop: "--panel",
  },
];

test("the contrast helper matches the published WCAG examples", () => {
  assert.equal(contrastRatio("#ffffff", "#000000").toFixed(0), "21");
  assert.equal(contrastRatio("#ffffff", "#ffffff").toFixed(0), "1");
  assert.ok(contrastRatio("#777777", "#ffffff") > 4.4);
});

test("both colour schemes define every variable the pairs need", () => {
  for (const scheme of ["light", "dark"]) {
    for (const name of new Set(PAIRS.flat())) {
      assert.ok(schemes[scheme][name], `${scheme} scheme is missing ${name}`);
    }
  }
});

for (const scheme of ["light", "dark"]) {
  test(`the ${scheme} scheme meets WCAG AA for normal text`, () => {
    const failures = [];
    for (const [foreground, background] of PAIRS) {
      const ratio = contrastRatio(
        schemes[scheme][foreground],
        schemes[scheme][background],
      );
      if (ratio < AA_NORMAL_TEXT) {
        failures.push(`${foreground} on ${background} = ${ratio.toFixed(2)}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  test(`the ${scheme} scheme meets WCAG AA on translucent fills`, () => {
    const failures = [];
    for (const pair of TRANSLUCENT_PAIRS) {
      const surface = composite(pair.fill, schemes[scheme][pair.backdrop]);
      const ratio = contrastRatio(schemes[scheme][pair.foreground], surface);
      if (ratio < AA_NORMAL_TEXT) {
        failures.push(`${pair.label} = ${ratio.toFixed(2)}`);
      }
    }
    assert.deepEqual(failures, []);
  });
}

test("the declared translucent fills still exist in the stylesheet", () => {
  for (const pair of TRANSLUCENT_PAIRS) {
    const normalized = pair.fill.replace(/\s+/g, "\\s*");
    assert.match(
      css,
      new RegExp(normalized.replace(/[()]/g, "\\$&")),
      `${pair.label}: the tested fill is no longer in styles.css`,
    );
  }
});

test("no rule dims text with opacity, which silently breaks those ratios", () => {
  const dimmed = css
    .split("}")
    .map((block) => block.split("{"))
    .filter(([selector, body]) => {
      if (!body || !/opacity\s*:/.test(body)) return false;
      // Allowed only when every selector in the list is a disabled control.
      return !selector.split(",").every((part) => part.includes(":disabled"));
    })
    .map(([selector]) => selector.trim());
  assert.deepEqual(dimmed, []);
});

test("prose is not broken mid-word", () => {
  // `break-all` splits ordinary words; `overflow-wrap: anywhere` only breaks overflow.
  assert.ok(
    !/word-break:\s*break-all/.test(css),
    "break-all shreds localized sentences",
  );

  // Pin the rules that actually hold prose, not just the property's presence.
  for (const selector of [".status", "h3,\nh4", "th,\ntd"]) {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at > 0, `rule not found: ${selector}`);
    const body = css.slice(at, css.indexOf("}", at));
    assert.match(
      body,
      /overflow-wrap:\s*anywhere/,
      `${selector} must wrap without splitting words`,
    );
  }
});

test("keyboard focus is visible and never removed again", () => {
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*\d/);
  assert.ok(
    !/outline:\s*(none|0)\b/.test(css),
    "a later rule removes the focus outline",
  );
});
