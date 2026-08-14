/** WCAG 2.1 relative luminance and contrast, for asserting the real stylesheet. */

function channel(value) {
  const srgb = value / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) =>
    channel(Number.parseInt(match[1].slice(i, i + 2), 16)),
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a, b) {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const light = Math.max(first, second);
  const dark = Math.min(first, second);
  return (light + 0.05) / (dark + 0.05);
}

/** Merges every `:root` block in source order, so a later override wins like the cascade. */
export function readRootVariables(source) {
  const variables = {};
  for (const match of source.matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const [, name, value] of match[1].matchAll(
      /(--[\w-]+)\s*:\s*([^;]+);/g,
    )) {
      variables[name] = value.trim();
    }
  }
  return variables;
}

/** Light comes from every `:root` outside the dark blocks, dark adds the ones inside them. */
export function readColorSchemes(css) {
  const darkBlocks = [
    ...css.matchAll(/@media \(prefers-color-scheme: dark\)\s*\{/g),
  ].map((match) => {
    const open = match.index + match[0].length - 1;
    return { start: match.index, open, end: matchingBrace(css, open) };
  });
  if (darkBlocks.length === 0) throw new Error("no dark scheme block found");

  let light = "";
  let cursor = 0;
  let dark = "";
  for (const block of darkBlocks) {
    light += css.slice(cursor, block.start);
    dark += css.slice(block.open + 1, block.end);
    cursor = block.end + 1;
  }
  light += css.slice(cursor);

  const lightVariables = readRootVariables(light);
  return {
    light: lightVariables,
    dark: { ...lightVariables, ...readRootVariables(dark) },
  };
}

function matchingBrace(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced braces");
}

/** Flattens `rgba(r, g, b, a)` onto an opaque backdrop so it can be compared. */
export function composite(rgba, backdropHex) {
  const match =
    /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/i.exec(
      rgba,
    );
  if (!match) throw new Error(`not an rgb(a) colour: ${rgba}`);
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  const base = /^#([0-9a-f]{6})$/i.exec(backdropHex.trim());
  if (!base) throw new Error(`backdrop must be 6-digit hex: ${backdropHex}`);

  const blended = [0, 2, 4].map((offset, i) => {
    const top = Number(match[i + 1]);
    const bottom = Number.parseInt(base[1].slice(offset, offset + 2), 16);
    return Math.round(alpha * top + (1 - alpha) * bottom);
  });
  return `#${blended.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
