/**
 * Pure decision logic for the real-browser pilot: which roots can carry an
 * account/local boundary claim, what browser the run is actually driving, and
 * which outcome the run is allowed to report.
 *
 * It lives here rather than inside `run-pilot.mjs` because these are the
 * judgements that decide whether a signed-in run is safe and whether the
 * boundary case may be called verified. A browser is needed to observe them and
 * is not needed to check them, so tests pin them directly.
 */

export const OUTCOME = {
  PASS: "PASS",
  SKIP: "SKIP",
  FAIL: "FAIL",
  ABORTED: "ABORTED",
};

const isManaged = (node) =>
  node.unmodifiable !== undefined && node.unmodifiable !== null;

/**
 * Roots that may be counted towards a boundary.
 *
 * `folderType` is deliberately not part of the test. The extension keys the
 * boundary on `syncing` alone, because "other -> bookmarks bar" inside one
 * store is a legitimate move, so requiring a matching folder type here would
 * refuse real cross-store pairs. Managed roots are dropped instead: they are
 * refused as a source and a destination anyway, and counting one would let a
 * single-store profile look like it had two boundaries.
 */
export function eligibleRoots(children = []) {
  return children.filter(
    (node) =>
      node &&
      typeof node.syncing === "boolean" &&
      !isManaged(node) &&
      typeof node.id === "string",
  );
}

export function boundaryKeys(children = []) {
  const keys = new Set(
    eligibleRoots(children).map((node) => `syncing:${node.syncing}`),
  );
  return [...keys].sort();
}

/** Eligible roots grouped by boundary key, with the folders a run can seed. */
export function groupRootsByBoundary(children = []) {
  const groups = new Map();
  for (const node of eligibleRoots(children)) {
    const key = `syncing:${node.syncing}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        syncing: node.syncing,
        bar: null,
        other: null,
        any: null,
      });
    }
    const group = groups.get(key);
    if (!group.any) group.any = node.id;
    if (node.folderType === "bookmarks-bar" && !group.bar) group.bar = node.id;
    if (node.folderType === "other" && !group.other) group.other = node.id;
  }
  return [...groups.values()];
}

/**
 * Where the run seeds its fixtures, and which store is on the far side of the
 * boundary. `home` needs both a bookmarks bar and an "other" folder because the
 * duplicate scenario places sources and a destination in different folders of
 * one store. The far side only needs somewhere writable to point at, so any of
 * its roots will do. Root ids are resolved here instead of being spelled as "1"
 * and "2": the ids are not fixed, and a dual-store profile has more than one of
 * each.
 */
export function planFixtureRoots(children = []) {
  const groups = groupRootsByBoundary(children);
  const complete = groups.filter((group) => group.bar && group.other);
  // Prefer the local store when there is a choice: on a signed-in profile it is
  // the side that is not pushed to the account.
  const home =
    complete.find((group) => group.syncing === false) ?? complete[0] ?? null;
  const away = home
    ? (groups.find((group) => group.key !== home.key && group.any) ?? null)
    : null;
  return { home, away, keys: boundaryKeys(children) };
}

const PRODUCT_PATTERNS = [
  { family: "edge", pattern: /^(?:Microsoft Edge|Edge|Edg)\/(\d+)\./ },
  { family: "chrome", pattern: /^(?:Headless)?Chrome\/(\d+)\./ },
];

/**
 * Reads the CDP `Browser.getVersion` product string. Edge is matched first
 * because its token is checked before the Chromium one, and the raw string is
 * always carried through: an unknown product is reported, never guessed.
 */
export function parseBrowserIdentity(product) {
  const raw = typeof product === "string" ? product.trim() : "";
  for (const { family, pattern } of PRODUCT_PATTERNS) {
    const match = pattern.exec(raw);
    if (match) return { family, major: Number(match[1]), raw };
  }
  return { family: "unknown", major: null, raw };
}

/**
 * `minMajor` defaults to 134 because that is the first version reporting
 * `BookmarkTreeNode.syncing`, which the whole boundary story depends on.
 */
export function checkBrowserIdentity(
  product,
  { minMajor = 134, requireFamily = null } = {},
) {
  const identity = parseBrowserIdentity(product);
  if (identity.family === "unknown") {
    return {
      ok: false,
      identity,
      reason: `unrecognised browser product "${identity.raw}"`,
    };
  }
  if (identity.major < minMajor) {
    return {
      ok: false,
      identity,
      reason: `${identity.raw} is older than the required major ${minMajor}`,
    };
  }
  if (requireFamily && identity.family !== requireFamily) {
    return {
      ok: false,
      identity,
      reason: `this run requires ${requireFamily} and got ${identity.raw}`,
    };
  }
  return { ok: true, identity, reason: "" };
}

/**
 * The boundary case only passes on a positive observation. A profile that never
 * grew a second boundary is SKIP; a profile that had one and did not refuse the
 * move is FAIL, because that is the defect this case exists to catch.
 */
export function boundaryOutcome(observed = {}) {
  const {
    pairFound = false,
    dryRunOk = false,
    approvable = null,
    statusKind = "",
    operationRows = 0,
    statusCellMatches = false,
    rowNamesFixture = false,
    applyLocked = false,
  } = observed;

  if (!pairFound) return OUTCOME.SKIP;

  const passed =
    dryRunOk === true &&
    approvable === false &&
    statusKind === "warn" &&
    operationRows === 1 &&
    statusCellMatches === true &&
    rowNamesFixture === true &&
    applyLocked === true;
  return passed ? OUTCOME.PASS : OUTCOME.FAIL;
}

/**
 * The run verdict. A skipped boundary does not fail the run - it is reported as
 * skipped and, when the caller asked for the boundary, it changes the exit code
 * instead. Anything that failed outranks anything that passed.
 */
export function runOutcome({
  aborted = false,
  mainPass = false,
  boundary = OUTCOME.SKIP,
  sweepOk = true,
  identityOk = true,
} = {}) {
  if (aborted) return OUTCOME.ABORTED;
  if (!identityOk || !sweepOk || !mainPass || boundary === OUTCOME.FAIL) {
    return OUTCOME.FAIL;
  }
  return OUTCOME.PASS;
}

/**
 * Exit codes: 0 pass, 1 fail, 2 the boundary was required and skipped, 3 the
 * operator declined. A skipped boundary keeps its own code so a machine gate
 * cannot read it as a pass.
 */
export function exitCodeFor(
  outcome,
  { boundary = OUTCOME.SKIP, requireBoundary = false, cleaned = true } = {},
) {
  if (outcome === OUTCOME.ABORTED) return 3;
  if (outcome !== OUTCOME.PASS) return 1;
  if (!cleaned) return 1;
  if (requireBoundary && boundary !== OUTCOME.PASS) return 2;
  return 0;
}
