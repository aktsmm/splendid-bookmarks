import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const source = readFileSync(
  new URL("../extension/ui/options.js", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
const loadStart = source.indexOf("async function loadTree(");
assert.ok(loadStart >= 0);
const loadEnd = source.indexOf("\n}\n", loadStart);
assert.ok(loadEnd > loadStart);
const loadSource = source.slice(loadStart, loadEnd + 2);
const startup =
  /\nif \(state.entries === null\) \{\n  void loadTree\(\{ focus: false \}\);\n\}\s*$/.exec(
    source,
  );
assert.ok(
  startup,
  "missing guarded automatic load at the end of initialization",
);

function harness({ entries = null, getLiveTree = async () => [] } = {}) {
  const calls = [];
  const state = { entries, loading: false, generation: 0 };
  const context = createContext({
    state,
    getLiveTree: async () => {
      calls.push("getLiveTree");
      return getLiveTree();
    },
    applyControlState: () => calls.push(`loading:${state.loading}`),
    setStatus: (...args) => calls.push(args),
    flattenTree: (roots) => roots,
    detectBrowser: () => "test",
    canonicalTreeString: JSON.stringify,
    sha256Hex: async () => "test-digest",
    resetDerivedViews: () => {
      state.views = {};
    },
    populateScopeOptions: () => {},
    renderTreeSummary: () => {},
    renderBuilder: () => {},
    renderAgentSummary: () => {},
    restorePendingBatch: async () => {
      assert.notEqual(state.entries, null);
      assert.equal(state.loading, true);
      calls.push("restorePendingBatch");
    },
    describeError: (_translator, error) => error.message,
    t: {},
    focusResult: (id) => calls.push(`focus:${id}`),
  });
  runInContext(loadSource, context);
  const loadTree = runInContext("loadTree", context);
  let pending;
  context.loadTree = (options) => {
    pending = loadTree(options);
    return pending;
  };
  return {
    state,
    calls,
    loadTree,
    start: () => {
      runInContext(startup[0], context);
      return pending;
    },
  };
}

test("startup loads the tree after exposing the API without downloading or taking focus", async () => {
  assert.ok(startup.index > source.indexOf("exposeAgentApi({"));
  const page = harness();
  const pending = page.start();
  assert.equal(page.state.loading, true);
  await pending;
  assert.notEqual(page.state.entries, null);
  assert.equal(page.state.generation, 1);
  assert.equal(page.state.loading, false);
  assert.equal(page.calls.filter((call) => call === "getLiveTree").length, 1);
  assert.ok(page.calls.includes("restorePendingBatch"));
  assert.ok(!page.calls.includes("focus:tree-status"));
});

test("startup preserves an already loaded tree and never repeats after success", async () => {
  const existing = [];
  const loaded = harness({ entries: existing });
  await loaded.start();
  assert.equal(loaded.state.entries, existing);
  assert.equal(loaded.state.generation, 0);
  assert.deepEqual(loaded.calls, []);
  const page = harness();
  await page.start();
  await page.start();
  assert.equal(page.state.generation, 1);
});

test("a manual click during automatic load cannot start a second read", async () => {
  let finishRead;
  const page = harness({
    getLiveTree: () =>
      new Promise((resolve) => {
        finishRead = resolve;
      }),
  });
  const pending = page.start();
  await page.loadTree();
  assert.equal(page.calls.filter((call) => call === "getLiveTree").length, 1);
  finishRead([]);
  await pending;
  assert.equal(page.state.generation, 1);
});

test("failed automatic load unlocks a manual retry without a background retry loop", async () => {
  let attempts = 0;
  const page = harness({
    getLiveTree: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("read denied");
      return [];
    },
  });
  await page.start();
  assert.equal(attempts, 1);
  assert.equal(page.state.entries, null);
  assert.equal(page.state.loading, false);
  assert.equal(page.state.generation, 0);
  assert.ok(
    page.calls.some(
      (call) => Array.isArray(call) && call[1] === "tree.status.failed",
    ),
  );
  assert.ok(!page.calls.includes("focus:tree-status"));
  await page.loadTree();
  assert.equal(attempts, 2);
  assert.equal(page.state.generation, 1);
  assert.ok(page.calls.includes("focus:tree-status"));
});
