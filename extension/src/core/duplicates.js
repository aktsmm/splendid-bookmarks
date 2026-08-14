/**
 * Duplicate detection. Pure and read-only: it reports groups, never removes anything.
 */

const TRACKING_PARAM_PREFIXES = ["utm_"];
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref_src",
  "spm",
]);

function isTrackingParam(name) {
  const lower = name.toLowerCase();
  return (
    TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    TRACKING_PARAMS.has(lower)
  );
}

/**
 * Returns a comparison key, or null when the URL cannot be parsed.
 * Normalization is deliberately conservative: it never merges different paths.
 */
export function normalizeUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";

  const params = [...parsed.searchParams.entries()].filter(
    ([name]) => !isTrackingParam(name),
  );
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  parsed.search = "";
  for (const [name, value] of params) {
    parsed.searchParams.append(name, value);
  }

  let pathname = parsed.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const port = parsed.port ? `:${parsed.port}` : "";
  return `${parsed.protocol.toLowerCase()}//${host}${port}${pathname}${parsed.search}`;
}

/**
 * @param {'exact'|'normalized'} mode
 * @returns groups of two or more bookmarks sharing the same key, largest first.
 */
export function findDuplicateGroups(entries, mode = "normalized") {
  const buckets = new Map();
  for (const entry of entries) {
    if (entry.isFolder || entry.isRoot || entry.url === null) continue;
    const key = mode === "exact" ? entry.url : normalizeUrl(entry.url);
    if (key === null) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
  }

  return [...buckets.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([key, members]) => ({ key, members }))
    .sort(
      (a, b) => b.members.length - a.members.length || (a.key < b.key ? -1 : 1),
    );
}

export function unparsableUrls(entries) {
  return entries.filter(
    (entry) =>
      !entry.isFolder &&
      !entry.isRoot &&
      entry.url !== null &&
      normalizeUrl(entry.url) === null,
  );
}

/** Why a group, or part of one, contributed nothing to the quarantine selection. */
export const SKIP = {
  NO_KEEPER: "no-keeper",
  STALE_KEEPER: "stale-keeper",
  TRUNCATED: "truncated",
  ALREADY_THERE: "already-there",
  BOUNDARY: "boundary",
  LIMIT: "limit",
};

/**
 * Decides which duplicate members should be moved into a quarantine folder,
 * given the one member per group the user chose to keep. Pure: it returns ids,
 * never touches the tree, and nothing here removes a bookmark.
 *
 * A group contributes nothing unless the user picked its keeper, so the caller
 * can never "keep the first one" by accident. `group.truncated` marks a group
 * whose member list was cut for display; sending those would move copies the
 * user never saw, so the whole group is refused until it is expanded.
 *
 * `alreadySelected` ids are dropped before `remainingCapacity` is applied, so a
 * second pass picks up the next batch instead of recomputing the same one.
 *
 * @returns {{addIds: string[], keptIds: string[], skipped: {key: string, reason: string, count: number}[]}}
 */
export function quarantineSelection({
  groups,
  keepByKey,
  destinationFolderId,
  destinationBoundary,
  boundaryOf,
  parentOf,
  alreadySelected,
  remainingCapacity,
}) {
  const addIds = [];
  const keptIds = [];
  const skipped = [];
  const selected = alreadySelected ?? new Set();
  let capacity = Math.max(0, remainingCapacity ?? 0);

  const note = (key, reason, count) => {
    if (count > 0) skipped.push({ key, reason, count });
  };

  for (const group of groups) {
    const keeperId = keepByKey?.get(group.key);
    if (keeperId === undefined || keeperId === null) {
      note(group.key, SKIP.NO_KEEPER, group.members.length);
      continue;
    }
    if (!group.members.some((member) => member.id === keeperId)) {
      note(group.key, SKIP.STALE_KEEPER, group.members.length);
      continue;
    }
    if (group.truncated) {
      note(group.key, SKIP.TRUNCATED, group.members.length);
      continue;
    }

    keptIds.push(keeperId);
    let alreadyThere = 0;
    let offBoundary = 0;
    let overCapacity = 0;

    for (const member of group.members) {
      if (member.id === keeperId) continue;
      if (selected.has(member.id)) continue;
      if (parentOf(member.id) === destinationFolderId) {
        alreadyThere += 1;
        continue;
      }
      // A null boundary means the runtime could not prove it; refuse rather than guess.
      const memberBoundary = boundaryOf(member.id);
      if (memberBoundary === null || memberBoundary !== destinationBoundary) {
        offBoundary += 1;
        continue;
      }
      if (capacity === 0) {
        overCapacity += 1;
        continue;
      }
      addIds.push(member.id);
      capacity -= 1;
    }

    note(group.key, SKIP.ALREADY_THERE, alreadyThere);
    note(group.key, SKIP.BOUNDARY, offBoundary);
    note(group.key, SKIP.LIMIT, overCapacity);
  }

  return { addIds, keptIds, skipped };
}
