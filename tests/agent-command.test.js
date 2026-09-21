import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  AGENT_API_VERSION,
  COMMAND_NAMES,
  capabilitiesState,
  errorResult,
  okResult,
  validateInvocation,
} from "../extension/src/core/agent-command.js";
import { exposeAgentApi } from "../extension/ui/agent-api.js";

/**
 * The vocabulary is written out here rather than read back from the module: a
 * command added to the export would otherwise join the contract without anyone
 * deciding it should.
 */
const EXPECTED_COMMANDS = [
  "capabilities",
  "getSession",
  "refreshTree",
  "getStats",
  "getTree",
  "search",
  "listTrash",
  "loadPlan",
  "dryRun",
  "apply",
  "verify",
  "rollback",
];

test("the command list is the contract, not whatever was wired up", () => {
  assert.deepEqual([...COMMAND_NAMES], EXPECTED_COMMANDS);
  assert.equal(AGENT_API_VERSION, 1);
});

test("the commands this build deliberately withholds stay out", () => {
  for (const withheld of [
    "emptyTrash",
    "exportSnapshot",
    "sendToTrash",
    "restoreBatch",
    "removeBookmark",
  ]) {
    assert.ok(!COMMAND_NAMES.includes(withheld), withheld);
    assert.equal(validateInvocation(withheld, {}).ok, false, withheld);
  }
});

test("capabilities names its own limits and says what it is not", () => {
  const state = capabilitiesState();
  assert.deepEqual(state.commands, EXPECTED_COMMANDS);
  assert.equal(state.limits.maxPlanOperations, 5000);
  assert.equal(state.limits.maxBatchOperations, 200);
  assert.equal(state.limits.maxRows, 500);
  assert.deepEqual(state.features, {
    pagination: true,
    sessionInfo: true,
    automaticTreeLoad: true,
    treeMetadata: true,
    structuredResults: true,
    refreshTree: true,
    planBinding: true,
  });
  assert.deepEqual(state.notes, {
    applyNeedsHumanBackup: true,
    canDelete: false,
    isSecurityBoundary: false,
  });
});

test("unknown commands, fields and input shapes are refused", () => {
  const cases = [
    ["nope", {}, "agent.error.unknownCommand"],
    [42, {}, "agent.error.unknownCommand"],
    ["getStats", [], "agent.error.inputNotObject"],
    ["getStats", "x", "agent.error.inputNotObject"],
    ["dryRun", { force: true }, "agent.error.unknownField"],
    ["getTree", { query: "x" }, "agent.error.unknownField"],
    ["search", {}, "agent.error.query"],
    ["search", { query: "" }, "agent.error.query"],
    ["search", { query: 1 }, "agent.error.query"],
    ["search", { query: "x", limit: 0 }, "agent.error.limit"],
    ["search", { query: "x", limit: 501 }, "agent.error.limit"],
    ["search", { query: "x", limit: 1.5 }, "agent.error.limit"],
    ["getTree", { limit: -1 }, "agent.error.limit"],
    ["loadPlan", {}, "agent.error.planNotObject"],
    ["loadPlan", { plan: "{}" }, "agent.error.planNotObject"],
    ["apply", { planDigest: "bad" }, "agent.error.planDigest"],
    ["apply", { planDigest: null }, "agent.error.planDigest"],
  ];
  for (const [command, input, key] of cases) {
    const result = validateInvocation(command, input);
    assert.equal(result.ok, false, `${command} ${JSON.stringify(input)}`);
    assert.equal(result.key, key, `${command} ${JSON.stringify(input)}`);
  }
});

test("a plan over the operation cap is refused before it is parsed further", () => {
  const plan = { version: 2, operations: new Array(5001).fill({}) };
  const result = validateInvocation("loadPlan", { plan });
  assert.equal(result.ok, false);
  assert.equal(result.key, "agent.error.tooManyOperations");
  assert.deepEqual(result.params, { count: 5001, limit: 5000 });

  assert.equal(
    validateInvocation("loadPlan", {
      plan: { version: 2, operations: new Array(5000).fill({}) },
    }).ok,
    true,
  );
});

test("accepted invocations are accepted", () => {
  const cases = [
    ["capabilities", undefined],
    ["capabilities", {}],
    ["getSession", {}],
    ["getStats", {}],
    ["getTree", { limit: 500 }],
    ["search", { query: "azure" }],
    ["search", { query: "azure", limit: 1 }],
    ["listTrash", {}],
    ["loadPlan", { plan: { version: 2, operations: [] } }],
    ["dryRun", {}],
    ["apply", {}],
    ["apply", { planDigest: "a".repeat(64) }],
    ["refreshTree", {}],
    ["verify", {}],
    ["rollback", {}],
  ];
  for (const [command, input] of cases) {
    assert.equal(
      validateInvocation(command, input).ok,
      true,
      `${command} ${JSON.stringify(input)}`,
    );
  }
});

test("the result shape is fixed and errors carry a catalog key, not prose", () => {
  assert.deepEqual(okResult("getStats", { bookmarks: 1 }), {
    ok: true,
    version: 1,
    command: "getStats",
    state: { bookmarks: 1 },
    error: null,
  });
  assert.deepEqual(errorResult("dryRun", "agent.error.noTree"), {
    ok: false,
    version: 1,
    command: "dryRun",
    state: null,
    error: { key: "agent.error.noTree" },
  });
  assert.deepEqual(
    errorResult("search", "agent.error.limit", {
      command: "search",
      limit: 500,
    }),
    {
      ok: false,
      version: 1,
      command: "search",
      state: null,
      error: {
        key: "agent.error.limit",
        params: { command: "search", limit: 500 },
      },
    },
  );
});

// --- dispatch wiring ---------------------------------------------------------

function withFakeWindow(run) {
  const previous = globalThis.window;
  globalThis.window = {};
  try {
    return run(globalThis.window);
  } finally {
    globalThis.window = previous;
  }
}

const spyHandlers = () => {
  const calls = [];
  const handlers = {};
  for (const name of COMMAND_NAMES) {
    handlers[name] = async (input) => {
      calls.push({ name, input });
      return { ran: name };
    };
  }
  return { calls, handlers };
};

test("every command routes to its own handler, exactly once", async () => {
  await withFakeWindow(async (win) => {
    const { calls, handlers } = spyHandlers();
    exposeAgentApi(handlers);
    for (const name of COMMAND_NAMES) {
      const input =
        name === "search"
          ? { query: "x" }
          : name === "loadPlan"
            ? { plan: {} }
            : {};
      const result = await win.splendidBookmarks.run(name, input);
      assert.equal(result.ok, true, name);
      assert.deepEqual(result.state, { ran: name }, name);
    }
    assert.deepEqual(
      calls.map((call) => call.name),
      [...COMMAND_NAMES],
    );
  });
});

test("a refused invocation never reaches a handler", async () => {
  await withFakeWindow(async (win) => {
    const { calls, handlers } = spyHandlers();
    exposeAgentApi(handlers);
    for (const [command, input] of [
      ["nope", {}],
      ["dryRun", { force: true }],
      ["search", {}],
    ]) {
      const result = await win.splendidBookmarks.run(command, input);
      assert.equal(result.ok, false, command);
      assert.ok(result.error.key.startsWith("agent.error."), command);
    }
    assert.deepEqual(calls, []);
  });
});

test("a throwing handler becomes a keyed error, not an unhandled rejection", async () => {
  await withFakeWindow(async (win) => {
    const { handlers } = spyHandlers();
    handlers.getStats = async () => {
      throw new Error("boom");
    };
    exposeAgentApi(handlers);
    const result = await win.splendidBookmarks.run("getStats", {});
    assert.equal(result.ok, false);
    assert.equal(result.error.key, "agent.error.failed");
    assert.equal(result.error.params.message, "boom");
  });
});

test("a handler that refuses on purpose keeps its own key", async () => {
  await withFakeWindow(async (win) => {
    const { handlers } = spyHandlers();
    handlers.apply = async () => {
      const error = new Error("agent.error.notReady");
      error.key = "agent.error.notReady";
      error.params = { control: "apply-moves" };
      throw error;
    };
    exposeAgentApi(handlers);
    const result = await win.splendidBookmarks.run("apply", {});
    assert.equal(result.ok, false);
    // Flattening this into "failed" would leave a caller unable to tell a
    // refusal it can act on from a crash it cannot.
    assert.equal(result.error.key, "agent.error.notReady");
    assert.deepEqual(result.error.params, { control: "apply-moves" });
  });
});

test("the exposed property cannot be replaced from the page", async () => {
  await withFakeWindow((win) => {
    const { handlers } = spyHandlers();
    exposeAgentApi(handlers);
    const descriptor = Object.getOwnPropertyDescriptor(
      win,
      "splendidBookmarks",
    );
    assert.equal(descriptor.writable, false);
    assert.equal(descriptor.configurable, false);
    assert.equal(Object.isFrozen(descriptor.value), true);
    assert.throws(() => {
      "use strict";
      win.splendidBookmarks = {};
    });
  });
});

test("a handler map missing a command is refused at wiring time", () => {
  withFakeWindow(() => {
    const { handlers } = spyHandlers();
    delete handlers.rollback;
    assert.throws(() => exposeAgentApi(handlers), /rollback/);
  });
});

test("commands run one at a time", async () => {
  await withFakeWindow(async (win) => {
    const { calls, handlers } = spyHandlers();
    let release;
    const started = new Promise((resolve) => {
      handlers.getTree = async () => {
        calls.push({ name: "getTree" });
        resolve();
        await new Promise((done) => {
          release = done;
        });
        return { ran: "getTree" };
      };
    });
    exposeAgentApi(handlers);

    const first = win.splendidBookmarks.run("getTree", {});
    await started;
    // A second call from the same tick would race the first on the journal.
    const second = await win.splendidBookmarks.run("getStats", {});
    assert.equal(second.ok, false);
    assert.equal(second.error.key, "agent.error.busy");

    release();
    assert.equal((await first).ok, true);
    // The guard releases, so the next call goes through.
    assert.equal((await win.splendidBookmarks.run("getStats", {})).ok, true);
  });
});

test("input that throws while being inspected still returns a result", async () => {
  await withFakeWindow(async (win) => {
    const { calls, handlers } = spyHandlers();
    exposeAgentApi(handlers);

    const hostile = [
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("no keys for you");
          },
        },
      ),
      {
        get plan() {
          throw new Error("no plan for you");
        },
      },
    ];

    for (const input of hostile) {
      // A rejected promise here would break the one thing every caller is told
      // to rely on: that `run` answers with a result object.
      const result = await win.splendidBookmarks.run("loadPlan", input);
      assert.equal(result.ok, false);
      assert.equal(result.version, 1);
      assert.equal(result.command, "loadPlan");
      assert.equal(result.state, null);
      assert.equal(result.error.key, "agent.error.failed");
    }
    assert.deepEqual(calls, [], "no handler ran");
  });
});

/**
 * The page adapter is the only thing allowed to reach a bookmark write, so the
 * handlers it registers must be the page's own functions rather than a second
 * route into the controller.
 */
test("the options page wires the API to its own controls, not to the adapters", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../extension/ui/options.js", import.meta.url)),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const start = source.indexOf("exposeAgentApi({");
  assert.ok(start > 0, "the options page must expose the API");
  const body = source.slice(start, source.indexOf("\n});", start));

  for (const gated of [
    ['requireControl("load-tree")', "refreshTree"],
    ['requireControl("plan-file")', "loadPlan"],
    ['requireControl("dry-run")', "dryRun"],
    ['requireControl("apply-moves")', "apply"],
    ['requireControl("verify-result")', "verify"],
    ['requireControl("rollback-batch")', "rollback"],
  ]) {
    assert.ok(
      body.includes(gated[0]),
      `${gated[1]} must ask the control first`,
    );
  }
  // No write adapter is called from the handler block: every mutating command
  // goes through the same function the button calls.
  for (const forbidden of [
    "runApply(",
    "runRollback(",
    "runTrash(",
    "runEmptyTrash(",
    "moveBookmark",
    "removeBookmark",
    "updateBookmark",
  ]) {
    assert.ok(!body.includes(forbidden), `${forbidden} must not be reachable`);
  }
});
