import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import {
  OUTCOME,
  boundaryKeys,
  boundaryOutcome,
  checkBrowserIdentity,
  eligibleRoots,
  exitCodeFor,
  groupRootsByBoundary,
  parseBrowserIdentity,
  planFixtureRoots,
  runOutcome,
} from "../scripts/lib/pilot-boundary.mjs";

test("every operator prompt closes its reader even when input fails", async () => {
  const script = readFileSync(
    new URL("../scripts/run-pilot.mjs", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const body = /async function askOperator\(question\) \{[\s\S]*?\n\}/.exec(
    script,
  )?.[0];
  assert.ok(body);
  assert.equal([...script.matchAll(/createInterface\(/g)].length, 1);
  for (const fails of [false, true]) {
    let closed = 0;
    const ask = runInNewContext(`(${body})`, {
      process: { stdin: {}, stdout: {} },
      createInterface: () => ({
        question: async () => {
          if (fails) throw new Error("stdin closed");
          return "yes";
        },
        close: () => {
          closed += 1;
        },
      }),
    });
    if (fails) await assert.rejects(ask("Continue?"), /stdin closed/);
    else assert.equal(await ask("Continue?"), "yes");
    assert.equal(closed, 1);
  }
});

const root = (id, folderType, syncing, extra = {}) => ({
  id,
  title: id,
  folderType,
  syncing,
  ...extra,
});

const singleStore = [
  root("1", "bookmarks-bar", false),
  root("2", "other", false),
  root("3", "mobile", false),
];

const dualStore = [
  root("1", "bookmarks-bar", false),
  root("2", "other", false),
  root("10", "bookmarks-bar", true),
  root("11", "other", true),
];

test("a managed root is not counted as a boundary", () => {
  // Managed nodes always report `syncing: false`, so counting one would let a
  // signed-in single-store profile look like it had both stores.
  const withManaged = [
    root("1", "bookmarks-bar", true),
    root("2", "other", true),
    root("9", "managed", false, { unmodifiable: "managed" }),
  ];
  assert.deepEqual(Array.from(boundaryKeys(withManaged)), ["syncing:true"]);
  assert.equal(eligibleRoots(withManaged).length, 2);
  assert.equal(planFixtureRoots(withManaged).away, null);
});

test("a root without a boolean syncing flag is not eligible", () => {
  const noSignal = [
    root("1", "bookmarks-bar", undefined),
    root("2", "other", null),
  ];
  assert.deepEqual(Array.from(boundaryKeys(noSignal)), []);
  assert.equal(eligibleRoots(noSignal).length, 0);
});

test("both boundaries are reported when both stores exist", () => {
  assert.deepEqual(Array.from(boundaryKeys(dualStore)), [
    "syncing:false",
    "syncing:true",
  ]);
  assert.equal(groupRootsByBoundary(dualStore).length, 2);
});

test("a differing folderType still forms a boundary pair", () => {
  // The extension keys the boundary on `syncing` alone. Requiring a matching
  // folderType here would call a real cross-store profile single-store.
  const lopsided = [
    root("1", "bookmarks-bar", false),
    root("2", "other", false),
    root("10", "mobile", true),
  ];
  assert.deepEqual(Array.from(boundaryKeys(lopsided)), [
    "syncing:false",
    "syncing:true",
  ]);
  const plan = planFixtureRoots(lopsided);
  assert.equal(plan.home.key, "syncing:false");
  assert.equal(plan.away.key, "syncing:true");
});

test("fixtures are seeded in the local store when there is a choice", () => {
  const plan = planFixtureRoots(dualStore);
  assert.equal(plan.home.key, "syncing:false");
  assert.equal(plan.home.bar, "1");
  assert.equal(plan.home.other, "2");
  assert.equal(plan.away.key, "syncing:true");
});

test("a single-store profile still resolves seed roots and has no far side", () => {
  const plan = planFixtureRoots(singleStore);
  assert.equal(plan.home.bar, "1");
  assert.equal(plan.home.other, "2");
  assert.equal(plan.away, null);
});

test("a store without both folders cannot host the fixtures", () => {
  assert.equal(
    planFixtureRoots([root("1", "bookmarks-bar", false)]).home,
    null,
  );
});

test("the Edge product token is read as Edge, not as an unknown browser", () => {
  assert.deepEqual(parseBrowserIdentity("Edg/151.0.4129.78"), {
    family: "edge",
    major: 151,
    raw: "Edg/151.0.4129.78",
  });
  assert.equal(
    parseBrowserIdentity("Microsoft Edge/151.0.4129.78").family,
    "edge",
  );
  assert.equal(parseBrowserIdentity("Chrome/151.0.7922.137").family, "chrome");
  assert.equal(
    parseBrowserIdentity("HeadlessChrome/151.0.1.1").family,
    "chrome",
  );
});

test("an unrecognised product is refused with the raw string kept", () => {
  const result = checkBrowserIdentity("Firefox/140.0");
  assert.equal(result.ok, false);
  assert.equal(result.identity.family, "unknown");
  assert.match(result.reason, /Firefox\/140\.0/);
});

test("a browser older than the syncing flag is refused", () => {
  assert.equal(checkBrowserIdentity("Chrome/133.0.0.0").ok, false);
  assert.equal(checkBrowserIdentity("Chrome/134.0.0.0").ok, true);
});

test("the default identity gate accepts both shipped browsers", () => {
  assert.equal(checkBrowserIdentity("Edg/151.0.4129.78").ok, true);
  assert.equal(checkBrowserIdentity("Chrome/151.0.7922.137").ok, true);
});

test("the boundary run can demand Chrome without breaking the default run", () => {
  assert.equal(
    checkBrowserIdentity("Edg/151.0.4129.78", { requireFamily: "chrome" }).ok,
    false,
  );
  assert.equal(
    checkBrowserIdentity("Chrome/151.0.7922.137", { requireFamily: "chrome" })
      .ok,
    true,
  );
});

const refused = {
  pairFound: true,
  dryRunOk: true,
  approvable: false,
  statusKind: "warn",
  operationRows: 1,
  statusCellMatches: true,
  rowNamesFixture: true,
  applyLocked: true,
};

test("no second boundary is a skip, never a pass", () => {
  assert.equal(boundaryOutcome({ ...refused, pairFound: false }), OUTCOME.SKIP);
});

test("a refused cross-boundary move is the only way to pass", () => {
  assert.equal(boundaryOutcome(refused), OUTCOME.PASS);
});

test("a boundary that exists and did not refuse the move fails", () => {
  // Each of these on its own is the difference between "refused" and "the page
  // happened to warn about something else".
  for (const broken of [
    { approvable: true },
    { dryRunOk: false },
    { statusKind: "ok" },
    { operationRows: 2 },
    { statusCellMatches: false },
    { rowNamesFixture: false },
    { applyLocked: false },
  ]) {
    assert.equal(
      boundaryOutcome({ ...refused, ...broken }),
      OUTCOME.FAIL,
      JSON.stringify(broken),
    );
  }
});

test("the run verdict lets a skipped boundary through but nothing else", () => {
  assert.equal(
    runOutcome({ mainPass: true, boundary: OUTCOME.SKIP }),
    OUTCOME.PASS,
  );
  assert.equal(
    runOutcome({ mainPass: true, boundary: OUTCOME.FAIL }),
    OUTCOME.FAIL,
  );
  assert.equal(
    runOutcome({ mainPass: false, boundary: OUTCOME.PASS }),
    OUTCOME.FAIL,
  );
  assert.equal(
    runOutcome({ mainPass: true, boundary: OUTCOME.PASS, sweepOk: false }),
    OUTCOME.FAIL,
  );
  assert.equal(
    runOutcome({ mainPass: true, boundary: OUTCOME.PASS, identityOk: false }),
    OUTCOME.FAIL,
  );
  assert.equal(
    runOutcome({ aborted: true, mainPass: true, boundary: OUTCOME.PASS }),
    OUTCOME.ABORTED,
  );
});

test("a skipped boundary cannot exit 0 once the boundary was required", () => {
  assert.equal(exitCodeFor(OUTCOME.PASS, { boundary: OUTCOME.SKIP }), 0);
  assert.equal(
    exitCodeFor(OUTCOME.PASS, {
      boundary: OUTCOME.SKIP,
      requireBoundary: true,
    }),
    2,
  );
  assert.equal(
    exitCodeFor(OUTCOME.PASS, {
      boundary: OUTCOME.PASS,
      requireBoundary: true,
    }),
    0,
  );
});

test("a pass that left its throwaway profile behind is not a pass", () => {
  assert.equal(exitCodeFor(OUTCOME.PASS, { cleaned: false }), 1);
});

test("declining the consent has its own exit code", () => {
  assert.equal(exitCodeFor(OUTCOME.ABORTED, { cleaned: false }), 3);
  assert.equal(exitCodeFor(OUTCOME.FAIL), 1);
});
