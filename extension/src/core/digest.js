/**
 * SHA-256 helpers used to bind an approved Dry Run to the exact plan bytes and
 * the exact tree it was computed against. Runs on Web Crypto, which is present
 * in both extension pages and Node.
 */

const encoder = new TextEncoder();

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(input) {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return toHex(digest);
}
