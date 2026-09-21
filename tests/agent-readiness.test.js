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

test("refresh reports failure even if a new generation was committed before the error", async () => {
  const body = /refreshTree: async \(\) => \{([\s\S]*?)\n  \},/.exec(
    source,
  )?.[1];
  assert.ok(body);
  for (const scenario of ["read-failed", "setup-failed", "loaded"]) {
    const state = { generation: 1, treeLoadFailed: false, treeDigest: "old" };
    const refresh = runInNewContext(`async () => {${body}\n}`, {
      state,
      requireControl: () => {},
      LocalizedError,
      loadTree: async () => {
        if (scenario !== "read-failed") state.generation += 1;
        state.treeLoadFailed = scenario !== "loaded";
      },
      agentSessionId: "session",
      agentSnapshotId: () => `session:${state.generation}`,
    });
    if (scenario === "loaded") {
      assert.equal((await refresh()).snapshotId, "session:2");
    } else {
      await assert.rejects(
        refresh(),
        (error) => error.key === "agent.error.refreshFailed",
      );
    }
  }
});

test("plan loading never reports another UI request as its own accepted plan", async () => {
  const body = /loadPlan: async \(\{ plan \}\) => \{([\s\S]*?)\n  \},/.exec(
    source,
  )?.[1];
  assert.ok(body);
  for (const scenario of ["accepted", "invalid", "replaced"]) {
    const state = { planSeq: 4, plan: null, planDigest: null };
    const load = runInNewContext(`async ({ plan }) => {${body}\n}`, {
      state,
      File,
      requireControl: () => {},
      LocalizedError,
      statusOf: () => ({ kind: "ok" }),
      loadPlan: async () => {
        state.planSeq += 1;
        if (scenario === "replaced") state.planSeq += 1;
        state.plan =
          scenario === "invalid" ? null : { version: 2, operations: [] };
        state.planDigest = scenario;
      },
    });
    if (scenario === "replaced") {
      await assert.rejects(
        load({ plan: {} }),
        (error) => error.key === "agent.error.superseded",
      );
      assert.equal(state.planDigest, "replaced");
    } else {
      const result = await load({ plan: {} });
      assert.equal(result.accepted, scenario === "accepted");
      assert.equal(result.planDigest, scenario);
    }
  }
});

test("apply refuses a different approved plan before executing", async () => {
  const body = /apply: async \(\{ planDigest \}\) => \{([\s\S]*?)\n  \},/.exec(
    source,
  )?.[1];
  assert.ok(body);
  let calls = 0;
  const apply = runInNewContext(`async ({ planDigest }) => {${body}\n}`, {
    state: { planDigest: "a".repeat(64), journal: null, mode: "applied" },
    requireControl: () => {},
    LocalizedError,
    applyMoves: async () => {
      calls += 1;
    },
    statusOf: () => ({ kind: "ok" }),
  });
  await assert.rejects(
    apply({ planDigest: "b".repeat(64) }),
    (error) => error.key === "agent.error.planDigest",
  );
  assert.equal(calls, 0);
  await apply({ planDigest: "a".repeat(64) });
  assert.equal(calls, 1);
});
