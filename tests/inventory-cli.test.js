import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inventoryOptions,
  saveInventory,
  validateTarget,
} from "../scripts/bookmark-inventory.mjs";

const endpoint = "http://127.0.0.1:9223";
const extensionId = "ehmdjfhakpifieboiogjemfdbgaemmaj";
const targetId = "1234567890ABCDEF1234567890ABCDEF";
const target = {
  id: targetId,
  type: "page",
  url: `chrome-extension://${extensionId}/ui/options.html`,
  webSocketDebuggerUrl: `ws://127.0.0.1:9223/devtools/page/${targetId}`,
};

test("CLI requires explicit target, session and label and never defaults to a profile", () => {
  assert.equal(inventoryOptions(["--help"]).help, true);
  assert.equal(inventoryOptions(["--cdp-url", endpoint, "--list"]).list, true);
  const args = [
    "--cdp-url",
    endpoint,
    "--target-id",
    targetId,
    "--session-id",
    "session",
    "--label",
    "work",
  ];
  assert.equal(inventoryOptions(args).label, "work");
  for (const name of ["--target-id", "--session-id", "--label"]) {
    const missing = args.filter(
      (value, index) => value !== name && args[index - 1] !== name,
    );
    assert.throws(() => inventoryOptions(missing));
  }
  assert.throws(() => inventoryOptions([...args, "--list"]));
  assert.throws(() => inventoryOptions([...args, "--apply"]));
});

test("CLI rejects remote endpoints, credentials and ambiguous URLs", () => {
  for (const url of [
    "https://127.0.0.1:9223",
    "http://example.com:9223",
    "http://localhost:9223",
    "http://user:secret@127.0.0.1:9223",
    `${endpoint}/json`,
    `${endpoint}?redirect=1`,
    `${endpoint}#fragment`,
  ]) {
    assert.throws(() => inventoryOptions(["--cdp-url", url, "--list"]));
  }
});

test("a CDP target must match both extension URL and WebSocket endpoint", () => {
  assert.equal(validateTarget(target, endpoint, extensionId), target.url);
  for (const changed of [
    { ...target, type: "service_worker" },
    { ...target, url: "https://example.com/" },
    {
      ...target,
      webSocketDebuggerUrl: "ws://example.com/devtools/page/" + targetId,
    },
    {
      ...target,
      webSocketDebuggerUrl: target.webSocketDebuggerUrl.replace(
        ":9223",
        ":9222",
      ),
    },
    {
      ...target,
      webSocketDebuggerUrl: target.webSocketDebuggerUrl + "?other=1",
    },
    {
      ...target,
      webSocketDebuggerUrl: target.webSocketDebuggerUrl.replace(
        targetId,
        "OTHER",
      ),
    },
  ])
    assert.throws(() => validateTarget(changed, endpoint, extensionId));
});

test("inventory export cannot overwrite an existing file", () => {
  const folder = mkdtempSync(join(tmpdir(), "inventory-test-"));
  try {
    const path = join(folder, "inventory.json");
    saveInventory(path, { label: "work", entries: [] });
    const original = readFileSync(path, "utf8");
    assert.throws(() => saveInventory(path, { replaced: true }), {
      code: "EEXIST",
    });
    assert.equal(readFileSync(path, "utf8"), original);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
