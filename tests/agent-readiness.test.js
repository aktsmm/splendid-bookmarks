import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { LocalizedError } from "../extension/src/core/errors.js";
import { deriveControlState, MODE } from "../extension/src/core/ui-state.js";
import { buildPlanFromProposal } from "../extension/src/core/plan-builder.js";
import { flattenTree } from "../extension/src/core/tree-model.js";
import { sampleTree } from "./fixtures/sample-tree.js";

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

test("proposal preparation uses shared plan loading and dry run without returning a second plan copy", async () => {
  const body = /preparePlan: async \(input\) => \{([\s\S]*?)\n  \},/.exec(
    source,
  )?.[1];
  assert.ok(body);
  for (const scenario of [
    "accepted",
    "blocked",
    "replaced",
    "stale",
    "scope-changed",
    "invalid",
  ]) {
    const previousPlan = { version: 2, operations: [] };
    const state = {
      planSeq: 4,
      plan: previousPlan,
      planDigest: "previous",
      dryRunRows: null,
      views: {},
    };
    const input = {
      snapshotId: "session:1",
      scopeFolderId: null,
      moves: [
        {
          bookmarkId: "200",
          destinationFolderId: scenario === "blocked" ? "300" : "10",
          reason: "group",
        },
      ],
    };
    let loaded = 0;
    let rendered = 0;
    const statuses = [];
    const prepare = runInNewContext(`async (input) => {${body}\n}`, {
      state,
      File,
      LocalizedError,
      requireTree: () => flattenTree(sampleTree()),
      requireControl: () => {},
      clear: () => {},
      clearStatus: () => {},
      setStatus: (...args) => statuses.push(args),
      describeError: (_translator, error) => error.key,
      t: {},
      applyControlState: () => {},
      buildPlanFromProposal,
      agentSnapshotId: () => "session:1",
      el: () => ({ value: "" }),
      statusOf: () => ({ kind: "ok" }),
      assertProposalBinding: () => {
        if (scenario === "stale")
          throw new LocalizedError("agent.error.staleProposal");
        if (scenario === "scope-changed")
          throw new LocalizedError("agent.error.proposalScope");
      },
      loadPlan: async (file, binding) => {
        loaded += 1;
        assert.equal(binding, input);
        state.planSeq += scenario === "replaced" ? 2 : 1;
        state.plan =
          scenario === "invalid" ? null : JSON.parse(await file.text());
        state.planDigest = "digest";
      },
      renderDryRun: () => {
        rendered += 1;
        state.dryRunRows = [];
        return { rows: [], movableCount: 1, blockedCount: 0 };
      },
    });
    if (["replaced", "stale", "scope-changed"].includes(scenario)) {
      const key =
        scenario === "replaced"
          ? "agent.error.superseded"
          : scenario === "stale"
            ? "agent.error.staleProposal"
            : "agent.error.proposalScope";
      await assert.rejects(prepare(input), (error) => error.key === key);
      assert.equal(rendered, 0);
      if (scenario === "replaced") {
        assert.notEqual(state.plan, null);
        assert.equal(state.planDigest, "digest");
      } else {
        assert.equal(state.plan, null);
        assert.equal(state.planDigest, null);
        assert.equal(state.approval, null);
        assert.equal(state.dryRunRows, null);
        assert.equal(statuses[0][0], "plan-status");
        assert.equal(statuses[0][1], "plan.status.failed");
        assert.equal(statuses[0][3], "error");
        assert.equal(statuses[0][2].message, key);
      }
    } else {
      const result = await prepare(input);
      assert.equal(result.accepted, scenario === "accepted");
      assert.equal(loaded, scenario === "blocked" ? 0 : 1);
      assert.equal(rendered, scenario === "accepted" ? 1 : 0);
      assert.equal(result.plan?.operations, undefined);
      if (scenario === "blocked") {
        assert.equal(state.plan, previousPlan);
        assert.equal(state.planDigest, "previous");
        assert.equal(result.approvable, false);
      }
    }
  }
});

test("plan loading invalidates approval immediately and rechecks proposal binding before committing", async () => {
  const loadSource =
    /async function loadPlan\(file, proposalBinding = null\) \{[\s\S]*?\n\}/.exec(
      source,
    )?.[0];
  const bindingSource =
    /function assertProposalBinding\(input\) \{[\s\S]*?\n\}/.exec(source)?.[0];
  assert.ok(loadSource && bindingSource);
  for (const scenario of [
    "accepted",
    "invalid-schema",
    "stale",
    "scope-changed",
    "scope-missing",
    "busy",
  ]) {
    const state = {
      planSeq: 0,
      plan: {},
      planDigest: "old",
      dryRunRows: [{}],
      approval: {},
      views: {},
    };
    let snapshotId = "session:1";
    let scope = "";
    let missing = false;
    let busy = false;
    const load = runInNewContext(`${bindingSource}\n${loadSource}\nloadPlan`, {
      state,
      LocalizedError,
      requireTree: () => {
        if (busy) throw new LocalizedError("agent.error.notReady");
      },
      agentSnapshotId: () => snapshotId,
      agentScopeMissing: () => missing,
      el: () => ({ value: scope }),
      clear: () => {},
      renderPlanErrors: () => {},
      applyControlState: () => {},
      setStatus: () => {},
      checkPlanFileSize: () => null,
      readTextFile: async () => {
        assert.equal(state.dryRunRows, null);
        assert.equal(state.approval, null);
        if (scenario === "stale") snapshotId = "session:2";
        if (scenario === "scope-changed") scope = "2";
        if (scenario === "scope-missing") missing = true;
        if (scenario === "busy") busy = true;
        return JSON.stringify({ version: 2, operations: [] });
      },
      sha256Hex: async () => "new",
      validatePlanDocument: () =>
        scenario === "invalid-schema"
          ? { ok: false, errors: [{ path: "$", key: "schema.version" }] }
          : { ok: true },
      formatDigest: (digest) => digest,
      describeError: (_translator, error) => error.key,
      t: {},
    });
    await load({ size: 1 }, { snapshotId: "session:1", scopeFolderId: null });
    assert.equal(state.plan !== null, scenario === "accepted");
    assert.equal(state.planDigest, scenario === "accepted" ? "new" : null);
    assert.equal(state.approval, null);
  }
});
