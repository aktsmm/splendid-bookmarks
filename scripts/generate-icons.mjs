#!/usr/bin/env node
/**
 * Generates the extension icon set. Placeholder artwork: a bookmark ribbon on
 * the UI accent colour, drawn with 4x4 supersampling so the 16px size stays
 * legible. Dependency-free so the repository keeps its zero-install rule.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = fileURLToPath(new URL("../extension/icons/", import.meta.url));
const SIZES = [16, 32, 48, 128];
const ACCENT = [26, 115, 232];
const RIBBON = [255, 255, 255];
const SAMPLES = 4;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Rounded square badge; returns true when the point is inside. */
function inBadge(u, v, radius) {
  const dx = Math.max(radius - u, 0, u - (1 - radius));
  const dy = Math.max(radius - v, 0, v - (1 - radius));
  return dx * dx + dy * dy <= radius * radius;
}

/** Bookmark ribbon with a V notch cut out of its bottom edge. */
function inRibbon(u, v) {
  const left = 0.33;
  const right = 0.67;
  const top = 0.2;
  const bottom = 0.8;
  const notchTop = 0.6;
  if (u < left || u > right || v < top || v > bottom) return false;
  if (v < notchTop) return true;
  const halfWidth =
    ((right - left) / 2) * ((v - notchTop) / (bottom - notchTop));
  return Math.abs(u - (left + right) / 2) > halfWidth;
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = 0.22;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let badge = 0;
      let ribbon = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const u = (x + (sx + 0.5) / SAMPLES) / size;
          const v = (y + (sy + 0.5) / SAMPLES) / size;
          if (!inBadge(u, v, radius)) continue;
          badge += 1;
          if (inRibbon(u, v)) ribbon += 1;
        }
      }
      const total = SAMPLES * SAMPLES;
      const alpha = badge / total;
      const mix = badge === 0 ? 0 : ribbon / badge;
      const offset = (y * size + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        rgba[offset + c] = Math.round(ACCENT[c] * (1 - mix) + RIBBON[c] * mix);
      }
      rgba[offset + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, renderIcon(size));
  console.log(`wrote icon-${size}.png`);
}

// Edge Add-ons asks for a 300x300 store logo. It is listing art, not part of the
// package, so it is written outside extension/ where check:store would flag it
// as a file the manifest never references.
const STORE_LOGO_DIR = fileURLToPath(new URL("../store-assets/", import.meta.url));
const STORE_LOGO_SIZE = 300;
mkdirSync(STORE_LOGO_DIR, { recursive: true });
const logo = join(STORE_LOGO_DIR, `store-logo-${STORE_LOGO_SIZE}.png`);
writeFileSync(logo, renderIcon(STORE_LOGO_SIZE));
console.log(`wrote store-logo-${STORE_LOGO_SIZE}.png`);
