import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { LocalizedError } from "../extension/src/core/errors.js";
import { deriveControlState, MODE } from "../extension/src/core/ui-state.js";

const source = readFileSync(
  new URL("../extension/ui/options.js", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
const requireControl = /function requireControl\(id\) \{[\s\S]*?\n\}/.exec(
  source,
)?.[0];
const requireTree = /const requireTree = \(\) => \{[\s\S]*?\n\};/.exec(
  source,
)?.[0];
const sessionBody = /getSession: \(\) => \(\{([\s\S]*?)\n  \}\),/.exec(
  source,
)?.[1];
assert.ok(
  requireControl && requireTree && sessionBody,
  "missing API readiness surface",
);

function readState(overrides = {}) {
  const state = {
    entries: [],
    loading: false,
    mode: MODE.IDLE,
    treeDigest: "digest",
    ...overrides,
  };
  const controls = deriveControlState({
    hasTree: state.entries !== null,
    loading: state.loading,
    mode: state.mode,
  });
  const api = runInNewContext(
    `${requireControl}\n${requireTree}\n({
    read: requireTree, session: () => ({${sessionBody}\n})
  })`,
    {
      state,
      LocalizedError,
      el: (id) => ({ disabled: controls[id] }),
      agentSessionId: "test-session",
      agentSnapshotId: () => "test-session:1",
      location: { host: "test-extension" },
      statusOf: () => ({ kind: "ok", text: "tree loaded" }),
    },
  );
  return { ...api, state, controls };
}

test("running UI batches also block every tree-reading API path", () => {
  for (const mode of [MODE.APPLYING, MODE.ROLLING_BACK, MODE.RESTORING]) {
    const api = readState({ mode });
    assert.equal(api.session().ready, false, mode);
    assert.equal(api.session().mode, mode);
    assert.equal(api.session().loading, false);
    assert.throws(
      api.read,
      (error) =>
        error.key === "agent.error.notReady" &&
        error.params.control === "export-tree",
    );
  }
  for (const command of ["getStats", "getTree", "search"]) {
    const handler = new RegExp(
      `${command}: [\\s\\S]*?const entries = requireTree\\(\\);`,
    ).exec(source);
    assert.ok(handler, `${command} must use the shared tree gate`);
  }
});

test("settled modes permit reading the loaded snapshot without requiring approval", () => {
  for (const mode of [MODE.IDLE, MODE.APPROVED, MODE.APPLIED, MODE.ABORTED]) {
    const api = readState({ mode });
    assert.equal(api.session().ready, true, mode);
    assert.equal(api.read(), api.state.entries);
  }
});

test("missing trees and reloads retain distinct readiness failures", () => {
  const missing = readState({ entries: null });
  assert.equal(missing.session().ready, false);
  assert.throws(missing.read, (error) => error.key === "agent.error.noTree");
  const reloading = readState({ loading: true });
  assert.equal(reloading.session().ready, false);
  assert.throws(
    reloading.read,
    (error) => error.key === "agent.error.notReady",
  );
});
