import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex } from "../extension/src/core/digest.js";

test("sha256Hex matches the published SHA-256 test vector", async () => {
  assert.equal(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("sha256Hex accepts bytes and agrees with the string form", async () => {
  const bytes = new TextEncoder().encode("abc");
  assert.equal(await sha256Hex(bytes), await sha256Hex("abc"));
});

test("a single-character difference changes the digest", async () => {
  assert.notEqual(await sha256Hex("abc"), await sha256Hex("abd"));
});
