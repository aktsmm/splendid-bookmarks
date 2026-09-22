import assert from "node:assert/strict";
import test from "node:test";
import {
  collectInventory,
  inspectSession,
} from "../scripts/lib/agent-inventory.mjs";
import {
  capabilitiesState,
  okResult,
  paginateEntries,
} from "../extension/src/core/agent-command.js";

const session = {
  sessionId: "session-one",
  snapshotId: "session-one:1",
  treeDigest: "digest",
  ready: true,
  loading: false,
  mode: "idle",
};
const entries = Array.from({ length: 1203 }, (_, index) => ({
  id: String(index),
  title: "Bookmark " + index,
  url: "https://example.com/" + index,
  path: ["Folder", String(index)],
}));
function fakeCall(transform = (command, result) => result) {
  const calls = [];
  const call = async (command, input) => {
    calls.push(command);
    let state;
    if (command === "capabilities") state = capabilitiesState();
    else if (command === "getSession") state = { ...session };
    else if (command === "getStats")
      state = { ...session, bookmarks: entries.length, folders: 0 };
    else if (command === "getTree")
      state = paginateEntries(entries, {
        command,
        snapshotId: session.snapshotId,
        ...input,
      });
    else throw new Error("Unexpected command: " + command);
    return transform(command, okResult(command, state), calls);
  };
  return { call, calls };
}

test("collector returns all pages without mutating commands", async () => {
  const { call, calls } = fakeCall();
  const result = await collectInventory(call, { sessionId: session.sessionId });
  assert.deepEqual(result.entries, entries);
  assert.equal(result.total, entries.length);
  assert.equal(calls.filter((command) => command === "getTree").length, 3);
  assert.deepEqual(
    [...new Set(calls)],
    ["capabilities", "getSession", "getStats", "getTree"],
  );
});

test("collector refuses the wrong session or an unready tree before listing", async () => {
  const normal = fakeCall();
  await assert.rejects(
    collectInventory(normal.call, { sessionId: "another-session" }),
    /Session mismatch/,
  );
  assert.ok(!normal.calls.includes("getTree"));
  const loading = fakeCall((command, result) => {
    if (command === "getSession") result.state.ready = false;
    return result;
  });
  await assert.rejects(
    collectInventory(loading.call, { sessionId: session.sessionId }),
    /Tree not ready/,
  );
  assert.ok(!loading.calls.includes("getTree"));
});

test("collector rejects mismatched stats identity before requesting any tree page", async () => {
  for (const changed of [
    { snapshotId: "session-one:2" },
    { sessionId: "other-session" },
  ]) {
    const { call, calls } = fakeCall((command, result) => {
      if (command === "getStats") Object.assign(result.state, changed);
      return result;
    });
    await assert.rejects(
      collectInventory(call, { sessionId: session.sessionId }),
      /Snapshot changed before collection/,
    );
    assert.ok(!calls.includes("getTree"));
  }
});

test("collector preserves empty root and bookmark titles as data", async () => {
  const { call } = fakeCall((command, result) => {
    if (command === "getTree") {
      result.state.shown = result.state.shown.map((entry) =>
        entry.id === "0"
          ? { ...entry, title: "", url: null, path: [] }
          : entry.id === "1"
            ? { ...entry, title: "", path: ["Folder", ""] }
            : entry,
      );
    }
    if (command === "getStats") {
      result.state.bookmarks -= 1;
      result.state.folders += 1;
    }
    return result;
  });
  const result = await collectInventory(call, { sessionId: session.sessionId });
  assert.equal(result.entries[0].title, "");
  assert.equal(result.entries[0].url, null);
  assert.deepEqual(result.entries[0].path, []);
  assert.equal(result.entries[1].title, "");
  assert.equal(result.entries[1].url, entries[1].url);
  assert.equal(result.total, entries.length);
});

test("collector never treats the old capped API as a complete inventory", async () => {
  const { call } = fakeCall((command, result) => {
    if (command === "capabilities") delete result.state.features;
    return result;
  });
  await assert.rejects(
    collectInventory(call, { sessionId: session.sessionId }),
    /does not support full inventory/,
  );
});

test("collector rejects malformed, duplicated or incomplete pages", async () => {
  const mutations = [
    (page) => {
      page.shown = [];
    },
    (page) => {
      page.shown[1] = page.shown[0];
    },
    (page) => {
      page.total = -1;
    },
    (page) => {
      page.total = 200001;
    },
    (page) => {
      page.truncated = false;
    },
    (page) => {
      page.nextCursor = null;
    },
    (page) => {
      page.nextCursor.offset = 1;
    },
    (page) => {
      page.snapshotId = "other:1";
    },
    (page) => {
      page.shown[0] = { ...page.shown[0], path: null };
    },
  ];
  for (const mutate of mutations) {
    const { call } = fakeCall((command, result) => {
      if (command === "getTree") mutate(result.state);
      return result;
    });
    await assert.rejects(
      collectInventory(call, { sessionId: session.sessionId }),
    );
  }
});

test("collector detects a page reload after the last result", async () => {
  const { call } = fakeCall((command, result, calls) => {
    if (
      command === "getSession" &&
      calls.filter((name) => name === command).length > 1
    ) {
      result.state.sessionId = "reloaded-session";
    }
    return result;
  });
  await assert.rejects(
    collectInventory(call, { sessionId: session.sessionId }),
    /changed after collection/,
  );
});

test("collector checks count agreement and response envelopes", async () => {
  for (const transform of [
    (command, result) => {
      if (command === "getStats") result.state.bookmarks += 1;
      return result;
    },
    (command, result) => {
      if (command === "getTree") result.version = 99;
      return result;
    },
  ]) {
    const { call } = fakeCall(transform);
    await assert.rejects(
      collectInventory(call, { sessionId: session.sessionId }),
    );
  }
});

test("session inspection reports UI activity without requesting blocked stats", async () => {
  for (const mode of ["applying", "rollingBack", "restoring"]) {
    const { call, calls } = fakeCall((command, result) => {
      if (command === "getSession")
        Object.assign(result.state, { ready: false, mode });
      return result;
    });
    const inspected = await inspectSession(call);
    assert.equal(inspected.session.mode, mode);
    assert.equal(inspected.session.ready, false);
    assert.equal(inspected.stats, null);
    assert.ok(!calls.includes("getStats"));
    await assert.rejects(
      collectInventory(call, { sessionId: session.sessionId }),
      /Tree not ready.*mode/,
    );
    assert.ok(!calls.includes("getTree"));
  }
});

test("a UI operation starting between pages rejects the inventory without continuing", async () => {
  const { call, calls } = fakeCall((command, result, history) => {
    if (
      command === "getTree" &&
      history.filter((name) => name === command).length === 2
    ) {
      return {
        ok: false,
        version: 1,
        command,
        state: null,
        error: {
          key: "agent.error.notReady",
          params: { control: "export-tree" },
        },
      };
    }
    return result;
  });
  await assert.rejects(
    collectInventory(call, { sessionId: session.sessionId }),
    /agent.error.notReady/,
  );
  assert.equal(calls.filter((command) => command === "getTree").length, 2);
});

test("a UI operation starting after the last page prevents completed inventory", async () => {
  const { call } = fakeCall((command, result, calls) => {
    if (
      command === "getSession" &&
      calls.filter((name) => name === command).length === 2
    ) {
      Object.assign(result.state, { ready: false, mode: "applying" });
    }
    return result;
  });
  await assert.rejects(
    collectInventory(call, { sessionId: session.sessionId }),
    /changed after collection/,
  );
});
