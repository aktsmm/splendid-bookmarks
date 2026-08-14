import {
  boundarySignalAvailable,
  getLiveTree,
} from "../src/adapters/bookmarks-api.js";
import { exportJsonFile, readTextFile } from "../src/adapters/file-export.js";
import {
  detectBrowser,
  detectLocale,
  storeLocale,
} from "../src/adapters/locale.js";
import { sha256Hex } from "../src/core/digest.js";
import {
  buildAgentContext,
  subtreeBookmarkCounts,
} from "../src/core/agent-export.js";
import { buildAgentPrompt } from "../src/core/agent-prompt.js";
import {
  SKIP,
  findDuplicateGroups,
  quarantineSelection,
  unparsableUrls,
} from "../src/core/duplicates.js";
import { createTranslator, translateDetail } from "../src/core/i18n.js";
import { describeError, LocalizedError } from "../src/core/errors.js";
import { validatePlanDocument } from "../src/core/plan-schema.js";
import {
  MAX_BATCH_OPERATIONS,
  MAX_RENDERED_ROWS,
  MAX_SNAPSHOT_FILE_BYTES,
  capRows,
  checkPlanFileSize,
} from "../src/core/limits.js";
import { formatBytes, formatCount, formatDigest } from "../src/core/format.js";
import {
  MODE,
  SCOPE_WARNING_KEY,
  deriveControlState,
  scopeWarningAction,
} from "../src/core/ui-state.js";
import { STATUS, dryRun } from "../src/core/validator.js";
import {
  appliedEntries,
  approvalMismatch,
  attemptedEntries,
  createApproval,
  createJournal,
  journalShapeError,
} from "../src/core/execution-session.js";
import { verifyJournal } from "../src/core/reconciliation.js";
import { capabilitiesState } from "../src/core/agent-command.js";
import { exposeAgentApi } from "./agent-api.js";
import {
  buildPlanFromSelection,
  selectableEntries,
  selectedEntries,
} from "../src/core/plan-builder.js";
import {
  buildRestoreMoves,
  buildSnapshotDocument,
  provenanceReport,
  validateSnapshotDocument,
} from "../src/core/snapshot-restore.js";
import {
  createTrashFolder,
  runApply,
  runEmptyTrash,
  runRestore,
  runRestoreBatch,
  runRollback,
  runTrash,
  settleAttempted,
  settleTrashLedger,
} from "./execution-controller.js";
import {
  clearJournal,
  loadJournal,
  loadTrashLedgerRecord,
  saveJournal,
  saveTrashLedger,
} from "../src/adapters/journal-store.js";
import {
  RECEIPT_STATE,
  createLedger,
  isActiveState,
  isExpired,
  readLedger,
  withQuarantined,
} from "../src/core/trash-ledger.js";
import {
  boundaryKey,
  canonicalTreeString,
  countUrls,
  flattenTree,
  foldersByPermanentRoot,
  formatPath,
  indexById,
  isBoundaryIndeterminate,
  topAncestorOf,
} from "../src/core/tree-model.js";
import {
  actionButton,
  applyStaticTranslations,
  checkList,
  clear,
  keepList,
  table,
  text,
} from "./dom.js";

const state = {
  entries: null,
  treeDigest: null,
  browser: null,
  plan: null,
  planDigest: null,
  // "file" survives a tree reload; "manual" is derived from the tree and does not.
  planSource: null,
  // Scope the exported agent-context.json was built with, or undefined if never exported.
  exportedScope: undefined,
  loading: false,
  // Bumped on every successful tree load so late async results can be discarded.
  generation: 0,
  // Bumped on every plan file selection so a superseded read cannot win.
  planSeq: 0,
  // Bumped by anything that changes what a manual plan would contain: the
  // selection and the destination. A build that started before the change must
  // not commit after it.
  builderRev: 0,
  // Execution state; the single source for what a running batch allows.
  mode: MODE.IDLE,
  // Digest the snapshot export produced, and the one the user proved they saved.
  expectedBackupDigest: null,
  backupDigest: null,
  dryRunRows: null,
  approval: null,
  journal: null,
  restoreCandidate: null,
  // Ids the user ticked in the manual builder. Always rendered in full, so a
  // selection can never sit outside the current filter where it cannot be seen.
  builderSelection: new Set(),
  // Group key -> the id of the one copy the user chose to keep. Held here and
  // not in the DOM so a re-render or a language switch cannot silently drop it.
  duplicateKeep: new Map(),
  // Group keys the user expanded past the per-group display cap.
  duplicateExpanded: new Set(),
  duplicateGroupsExpanded: false,
  duplicateSendReport: null,
  // Where the last quarantine send pointed, so the apply result can name the
  // folder the copies landed in. `{ id, path }` or null.
  quarantineDestination: null,
  // Durable recovery records for the Trash folder, plus the raw document they
  // were read from: a write compares against that, not against the working copy.
  // Bumped on every ledger refresh. The ledger outlives the tree, so binding it
  // to `generation` would let a tree reload discard the only read of it.
  trashSeq: 0,
  trashLedger: null,
  trashRecord: null,
  trashQuarantined: [],
  trashPoisoned: new Set(),
  // Why the stored document could not be read, or null. While this is set, no
  // ledger write may happen: the document belongs to a version this build does
  // not understand, and overwriting it would destroy it.
  trashRejected: null,
  // Panels re-render themselves when the language changes.
  views: {
    tree: null,
    duplicates: null,
    agent: null,
    plan: null,
    apply: null,
    restore: null,
    builder: null,
    trash: null,
  },
  statuses: {},
};

let t = createTranslator(detectLocale());

const el = (id) => document.getElementById(id);

function setStatus(id, key, params, kind = "info") {
  state.statuses[id] = { key, params, kind };
  const node = el(id);
  node.textContent = t(key, params);
  node.dataset.kind = kind;
}

/** Progress callbacks rewrite one status line; kept out of the async bodies. */
const progressWriter = (id, key) => (progress) => setStatus(id, key, progress);

function renderAll() {
  document.documentElement.lang = t.locale;
  applyStaticTranslations(document, t);
  for (const [id, status] of Object.entries(state.statuses)) {
    el(id).textContent = t(status.key, status.params);
    el(id).dataset.kind = status.kind;
  }
  for (const view of Object.values(state.views)) {
    view?.();
  }
}

function renderTreeSummary() {
  const entries = state.entries;
  const permanentRoots = entries.filter((entry) => entry.isPermanentRoot);
  const boundaryOk = boundarySignalAvailable(entries);
  const subtreeCounts = new Map(
    subtreeBookmarkCounts(entries).map((root) => [root.id, root.bookmarks]),
  );

  const summary = clear(el("tree-summary"));
  summary.appendChild(
    table(
      [t("tree.stat.item"), t("tree.stat.value")],
      [
        [t("tree.stat.urls"), formatCount(countUrls(entries), t.locale)],
        [
          t("tree.stat.folders"),
          formatCount(
            entries.filter((e) => e.isFolder && !e.isRoot).length,
            t.locale,
          ),
        ],
        [
          t("tree.stat.depth"),
          formatCount(Math.max(0, ...entries.map((e) => e.depth)), t.locale),
        ],
        [t("tree.stat.browser"), t(`browser.${state.browser}`)],
        [t("tree.stat.digest"), state.treeDigest],
        [
          t("tree.stat.boundary"),
          boundaryOk
            ? t("tree.boundary.available")
            : t("tree.boundary.missing"),
        ],
      ],
    ),
  );
  summary.appendChild(text("h3", t("tree.roots.title")));
  summary.appendChild(
    table(
      [
        t("tree.roots.id"),
        t("tree.roots.title.column"),
        t("tree.roots.folderType"),
        t("tree.roots.syncing"),
        t("tree.roots.children"),
        t("tree.roots.subtree"),
      ],
      permanentRoots.map((root) => [
        root.id,
        root.title,
        String(root.folderType),
        String(root.syncing),
        formatCount(
          entries.filter((e) => e.parentId === root.id).length,
          t.locale,
        ),
        formatCount(subtreeCounts.get(root.id) ?? 0, t.locale),
      ]),
    ),
  );
}

/** The only place that writes `disabled`; the rules themselves live in core/ui-state.js. */
function applyControlState() {
  const disabledById = deriveControlState({
    loading: state.loading,
    hasTree: state.entries !== null,
    hasPlan: state.plan !== null,
    mode: state.mode,
    backupVerified: state.backupDigest !== null,
    hasApproval: state.approval !== null,
    hasJournal: state.journal !== null,
    hasAppliedMoves:
      state.journal !== null && appliedEntries(state.journal).length > 0,
    hasRestoreCandidate: state.restoreCandidate !== null,
    hasSelection: state.builderSelection.size > 0,
    hasDestination: el("builder-destination").value !== "",
    hasDuplicateReport: state.views.duplicates !== null,
    hasKeeper: state.duplicateKeep.size > 0,
    hasTrashParent: el("trash-parent").value !== "",
    hasTrashFolder: el("trash-folder").value !== "",
    hasTrashBatch: newestIntactBatchId() !== null,
    hasReceipts:
      trashReceipts().length > 0 || state.trashQuarantined.length > 0,
    hasDeletable: deletableReceiptIds().length > 0,
    deleteConfirmed: el("empty-trash-confirm").checked,
    trashLocked: state.trashRejected !== null,
  });
  for (const [id, disabled] of Object.entries(disabledById)) {
    el(id).disabled = disabled;
  }
}

function clearStatus(id) {
  delete state.statuses[id];
  el(id).textContent = "";
  delete el(id).dataset.kind;
}

// Only the newest export writing to a given status line may report its result.
const exportSeq = { "tree-status": 0, "agent-status": 0 };
const beginExport = (statusId) => (exportSeq[statusId] += 1);
const isCurrentExport = (statusId, seq) => exportSeq[statusId] === seq;

/** Everything below the tree is derived from it, so a reload must not leave stale panels on screen. */
function resetDerivedViews() {
  state.views.duplicates = null;
  state.views.agent = null;
  state.views.plan = null;
  state.exportedScope = undefined;
  // An approval is bound to one tree digest, so a reload always retires it.
  state.dryRunRows = null;
  state.approval = null;
  state.backupDigest = null;
  state.expectedBackupDigest = null;
  state.restoreCandidate = null;
  // Ids and paths belong to the tree that was just replaced.
  state.builderSelection.clear();
  state.duplicateKeep.clear();
  state.duplicateExpanded.clear();
  state.duplicateGroupsExpanded = false;
  state.duplicateSendReport = null;
  state.quarantineDestination = null;
  state.views.builder = null;

  clear(el("duplicates"));
  clear(el("agent-summary"));
  clear(el("dry-run-result"));
  clear(el("builder-panel"));
  clearStatus("duplicates-status");
  clearStatus("builder-status");
  clearStatus("apply-status");
  clearStatus("restore-status");
  el("backup-file").value = "";
  el("restore-file").value = "";

  el("agent-prompt").value = "";
  clearStatus("agent-status");

  // A hand-picked plan describes the tree that just went away, so it goes with
  // it. A plan file is independent input and stays.
  if (state.planSource === "manual") {
    state.plan = null;
    state.planDigest = null;
    state.planSource = null;
  }
  // The plan file is still valid input; only its Dry Run result went stale.
  if (state.plan) {
    setStatus(
      "plan-status",
      "plan.status.loaded",
      {
        count: state.plan.operations.length,
        digest: formatDigest(state.planDigest),
      },
      "ok",
    );
  } else {
    clearStatus("plan-status");
  }
  applyControlState();
}

async function loadTree() {
  if (state.loading) return;
  state.loading = true;
  applyControlState();
  setStatus("tree-status", "tree.status.loading");
  try {
    const roots = await getLiveTree();
    const entries = flattenTree(roots);
    const browser = detectBrowser();
    const treeDigest = await sha256Hex(canonicalTreeString(entries));

    // Commit synchronously: an await here would let a handoff export mix the
    // new entries with the previous treeDigest.
    state.entries = entries;
    state.browser = browser;
    state.treeDigest = treeDigest;
    state.generation += 1;
    resetDerivedViews();
    populateScopeOptions();
    state.views.tree = renderTreeSummary;
    renderTreeSummary();
    renderBuilder();
    // The prompt is derived from the tree, so there is nothing to press.
    renderAgentSummary();

    setStatus(
      "tree-status",
      "tree.status.loaded",
      { count: entries.filter((entry) => !entry.isRoot).length },
      "ok",
    );
    await restorePendingBatch();
  } catch (error) {
    setStatus(
      "tree-status",
      "tree.status.failed",
      { message: describeError(t, error) },
      "error",
    );
  } finally {
    state.loading = false;
    applyControlState();
    focusResult("tree-status");
  }
}

/**
 * The two steps everyone does back to back. It skips no gate: the snapshot
 * still has to be re-selected before Apply unlocks. The export only runs when
 * the load really produced a new tree, so a failed reload cannot write a
 * snapshot of the tree that is still on screen.
 */
async function quickStart() {
  if (state.loading) return;
  const before = state.generation;
  await loadTree();
  if (state.generation === before) return;
  await exportTree();
}

async function exportTree() {
  const generation = state.generation;
  const seq = beginExport("tree-status");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshot = buildSnapshotDocument(state.entries, {
    treeDigest: state.treeDigest,
    exportedAt: new Date().toISOString(),
  });
  try {
    const result = await exportJsonFile(
      `bookmark-snapshot-${stamp}.json`,
      snapshot,
    );
    if (!isCurrentExport("tree-status", seq)) return;
    if (generation !== state.generation) return;
    // Kept so the user can prove later that the file really reached the disk.
    // A new export retires whatever backup was proved before it.
    state.expectedBackupDigest = result.digest;
    state.backupDigest = null;
    refreshApproval();
    applyControlState();
    setStatus(
      "tree-status",
      "tree.export.done",
      {
        filename: result.filename,
        bytes: formatBytes(result.byteLength, t.locale),
        digest: formatDigest(result.digest),
      },
      "ok",
    );
  } catch (error) {
    if (!isCurrentExport("tree-status", seq)) return;
    if (generation !== state.generation) return;
    setStatus(
      "tree-status",
      "error.exportFailed",
      { message: describeError(t, error) },
      "error",
    );
  }
}

/** Above this the report stops being scannable and the radios stop being cheap. */
const MAX_DUPLICATE_GROUPS = 100;
const MAX_GROUP_MEMBERS = 50;

const SKIP_MESSAGE = {
  [SKIP.NO_KEEPER]: "duplicates.skip.no-keeper",
  [SKIP.STALE_KEEPER]: "duplicates.skip.stale-keeper",
  [SKIP.TRUNCATED]: "duplicates.skip.truncated",
  [SKIP.ALREADY_THERE]: "duplicates.skip.already-there",
  [SKIP.BOUNDARY]: "duplicates.skip.boundary",
  [SKIP.LIMIT]: "duplicates.skip.limit",
};

/**
 * The groups as they are currently displayed. `truncated` travels with the
 * group so a send can refuse it: offering "the rest" of a list the user has not
 * seen in full would move copies they never looked at.
 */
function displayedDuplicateGroups() {
  const all = findDuplicateGroups(state.entries, el("dup-mode").value);
  const shown = state.duplicateGroupsExpanded
    ? all
    : all.slice(0, MAX_DUPLICATE_GROUPS);
  return {
    all,
    groupsTruncated: shown.length < all.length,
    groups: shown.map((group) => {
      const cap = state.duplicateExpanded.has(group.key)
        ? group.members.length
        : MAX_GROUP_MEMBERS;
      return {
        key: group.key,
        members: group.members.slice(0, cap),
        totalMembers: group.members.length,
        truncated: group.members.length > cap,
      };
    }),
  };
}

/**
 * Lands the keyboard user on the result of an operation that disabled the whole
 * page. The button they pressed was disabled while it ran, so focus was already
 * on `body` by the time the result arrived.
 */
function focusResult(statusId) {
  el(statusId).focus();
}

/**
 * Puts focus back on the row the user just acted on. Both panels are rebuilt
 * with `replaceChildren`, which destroys the focused control, so without this a
 * keyboard user is returned to the top of the document on every single tick.
 */
function restoreFocus(panelId, id) {
  const row = el(panelId).querySelector(
    `input[data-id="${CSS.escape(String(id))}"]`,
  );
  row?.focus();
}

function pickKeeper(groupKey, memberId) {
  state.duplicateKeep.set(groupKey, memberId);
  // Keeping a copy and moving it are contradictory, so the newer choice wins:
  // a keeper that was already ticked in the builder leaves the selection.
  if (state.builderSelection.delete(memberId)) {
    bumpBuilderRev();
    renderBuilder();
  }
  renderDuplicates();
  restoreFocus("duplicates", memberId);
  applyControlState();
}

function renderSendReport(panel) {
  const report = state.duplicateSendReport;
  if (!report) return;
  panel.appendChild(text("h3", t("duplicates.sent.title")));
  panel.appendChild(
    text("p", t("duplicates.sent.added", { count: report.added })),
  );
  if (report.skipped.length === 0) return;
  const list = document.createElement("ul");
  for (const { reason, count } of report.skipped) {
    list.appendChild(
      text(
        "li",
        t(SKIP_MESSAGE[reason], { count, limit: MAX_BATCH_OPERATIONS }),
        "muted",
      ),
    );
  }
  panel.appendChild(list);
}

function renderDuplicates() {
  state.views.duplicates = renderDuplicates;
  const mode = el("dup-mode").value;
  const { all, groups, groupsTruncated } = displayedDuplicateGroups();
  const unparsable = unparsableUrls(state.entries);
  const panel = clear(el("duplicates"));

  // One write, and it always carries the count: that number is what the user
  // pressed the button for. Whichever condition still blocks the send rides
  // along, so a disabled button is never left unexplained.
  const needsKeeper = all.length > 0 && state.duplicateKeep.size === 0;
  const needsDestination =
    all.length > 0 && !needsKeeper && el("builder-destination").value === "";
  setStatus(
    "duplicates-status",
    needsKeeper
      ? "duplicates.status.summaryPick"
      : needsDestination
        ? "duplicates.status.summaryDestination"
        : "duplicates.summary",
    {
      mode: t(`duplicates.mode.${mode}`),
      groups: all.length,
      count: all.reduce((sum, g) => sum + g.members.length - 1, 0),
    },
  );
  if (unparsable.length > 0) {
    panel.appendChild(
      text(
        "p",
        t("duplicates.unparsable", { count: unparsable.length }),
        "muted",
      ),
    );
  }
  renderSendReport(panel);

  if (all.length === 0) {
    panel.appendChild(text("p", t("duplicates.none"), "muted"));
  }

  if (groupsTruncated) {
    panel.appendChild(
      text(
        "p",
        t("duplicates.groups.truncated", {
          shown: groups.length,
          total: all.length,
        }),
        "muted",
      ),
    );
    panel.appendChild(
      actionButton(
        t("duplicates.groups.showAll", { total: all.length }),
        () => {
          // The button that had focus is about to be removed by the rebuild.
          const landing = groups[0]?.members[0]?.id;
          state.duplicateGroupsExpanded = true;
          renderDuplicates();
          if (landing) restoreFocus("duplicates", landing);
        },
      ),
    );
  }

  groups.forEach((group, index) => {
    panel.appendChild(text("h3", group.key));
    const keeper = state.duplicateKeep.get(group.key) ?? null;
    panel.appendChild(
      keepList(
        group.members.map((member) => ({
          id: member.id,
          checked: member.id === keeper,
          label: member.title,
          detail: formatPath(member.path),
        })),
        `dup-keep-${index}`,
        t("duplicates.keep.legend", { key: group.key }),
        (memberId) => pickKeeper(group.key, memberId),
      ),
    );
    if (group.truncated) {
      panel.appendChild(
        text(
          "p",
          t("duplicates.group.truncated", {
            shown: group.members.length,
            total: group.totalMembers,
          }),
          "muted",
        ),
      );
      panel.appendChild(
        actionButton(
          t("duplicates.group.showAll", { total: group.totalMembers }),
          () => {
            const landing = group.members[0]?.id;
            state.duplicateExpanded.add(group.key);
            renderDuplicates();
            if (landing) restoreFocus("duplicates", landing);
          },
        ),
      );
    }
  });

  applyControlState();
}

/**
 * Hands the copies the user did not choose to keep to the manual builder. It
 * only ever adds to a selection the user still reviews and approves; nothing is
 * moved here, and nothing is ever deleted.
 */
function sendDuplicates() {
  const byId = indexById(state.entries);
  const destinationFolderId = el("builder-destination").value;
  const destination = byId.get(destinationFolderId);
  if (!destination) return;

  // No copy the user chose to keep may be on its way to the quarantine folder,
  // however it got into the selection.
  for (const keeperId of state.duplicateKeep.values()) {
    state.builderSelection.delete(keeperId);
  }

  // Fail closed: an id whose boundary cannot be proven is treated as off-boundary.
  const boundaryOf = (id) => {
    const entry = byId.get(id);
    if (!entry || isBoundaryIndeterminate(entry, byId)) return null;
    return boundaryKey(topAncestorOf(entry, byId));
  };

  const { groups } = displayedDuplicateGroups();
  const { addIds, skipped } = quarantineSelection({
    groups,
    keepByKey: state.duplicateKeep,
    destinationFolderId,
    destinationBoundary: boundaryOf(destinationFolderId),
    boundaryOf,
    parentOf: (id) => byId.get(id)?.parentId ?? null,
    alreadySelected: state.builderSelection,
    remainingCapacity: MAX_BATCH_OPERATIONS - state.builderSelection.size,
  });

  const byReason = new Map();
  for (const item of skipped) {
    byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + item.count);
  }
  state.duplicateSendReport = {
    added: addIds.length,
    skipped: [...byReason].map(([reason, count]) => ({ reason, count })),
  };

  for (const id of addIds) state.builderSelection.add(id);
  bumpBuilderRev();
  // After the bump: it retires the manual plan, which also clears this.
  state.quarantineDestination = {
    id: destination.id,
    path: formatPath(destination.path),
  };
  renderDuplicates();
  renderBuilder();
  setStatus(
    "duplicates-status",
    addIds.length > 0 ? "duplicates.status.sent" : "duplicates.status.sentNone",
    { count: addIds.length },
    addIds.length > 0 ? "ok" : "warn",
  );
}

function agentContext() {
  return buildAgentContext(state.entries, {
    treeDigest: state.treeDigest,
    scopeFolderId: el("agent-scope").value || null,
  });
}

/** Offer every folder, grouped by permanent root, to each folder-valued select. */
function fillFolderSelect(id) {
  const select = el(id);
  const previous = select.value;
  select.replaceChildren(select.options[0]);

  // A flat list of ~100 full paths is unscannable; group them by permanent root.
  for (const group of foldersByPermanentRoot(state.entries)) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.root.title;
    for (const folder of group.folders) {
      const option = document.createElement("option");
      option.value = folder.id;
      option.textContent = folder.label;
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }

  select.value = [...select.options].some((option) => option.value === previous)
    ? previous
    : "";
}

function populateScopeOptions() {
  fillFolderSelect("agent-scope");
  fillFolderSelect("builder-source");
  fillFolderSelect("builder-destination");
  fillFolderSelect("trash-folder");
  fillFolderSelect("trash-parent");
}

function renderAgentSummary() {
  state.views.agent = renderAgentSummary;
  const context = agentContext();
  const panel = clear(el("agent-summary"));
  panel.appendChild(text("p", t("agent.stats", context.stats)));
  if (context.scope) {
    panel.appendChild(
      text(
        "p",
        t("agent.scope.summary", {
          scope: formatPath(context.scope.path),
          bookmarks: context.stats.bookmarks,
          total: context.stats.totalBookmarks,
        }),
      ),
    );
  }
  panel.appendChild(
    text(
      "p",
      context.ambiguousFolderPaths.length === 0
        ? t("agent.ambiguous.none")
        : t("agent.ambiguous.some", {
            count: context.ambiguousFolderPaths.length,
          }),
      "muted",
    ),
  );
  if (context.ambiguousFolderPaths.length > 0) {
    panel.appendChild(
      table(
        [t("duplicates.col.path"), t("duplicates.col.id")],
        context.ambiguousFolderPaths.map((item) => [
          item.path,
          item.ids.join(", "),
        ]),
      ),
    );
  }
  el("agent-prompt").value = buildAgentPrompt(context, t.locale);
}

/** Keeps the export status honest when the selected scope and the exported file diverge. */
function syncScopeWarning() {
  const action = scopeWarningAction({
    exportedScope: state.exportedScope,
    currentScope: el("agent-scope").value,
    currentStatusKey: state.statuses["agent-status"]?.key,
  });
  if (action === "warn") {
    setStatus("agent-status", SCOPE_WARNING_KEY, undefined, "warn");
  } else if (action === "clear") {
    clearStatus("agent-status");
  }
}

async function exportAgentContext() {
  const generation = state.generation;
  const seq = beginExport("agent-status");
  const scope = el("agent-scope").value;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    const result = await exportJsonFile(
      `agent-context-${stamp}.json`,
      agentContext(),
    );
    if (generation !== state.generation) return;
    if (!isCurrentExport("agent-status", seq)) return;
    state.exportedScope = scope;
    setStatus(
      "agent-status",
      "agent.export.done",
      {
        filename: result.filename,
        bytes: formatBytes(result.byteLength, t.locale),
        digest: formatDigest(result.digest),
      },
      "ok",
    );
    // The selector may have moved while the file was being written.
    syncScopeWarning();
  } catch (error) {
    if (generation !== state.generation) return;
    if (!isCurrentExport("agent-status", seq)) return;
    setStatus(
      "agent-status",
      "error.exportFailed",
      { message: describeError(t, error) },
      "error",
    );
  }
}

function renderPlanErrors(errors, target = el("dry-run-result")) {
  const panel = clear(target);
  const visible = capRows(errors);
  if (visible.truncated) {
    panel.appendChild(
      text(
        "p",
        t("plan.errors.truncated", {
          shown: visible.shown.length,
          total: visible.total,
        }),
        "muted",
      ),
    );
  }
  panel.appendChild(
    table(
      [t("plan.error.path"), t("plan.error.message")],
      visible.shown.map((error) => [error.path, t(error.key, error.params)]),
    ),
  );
}

async function loadPlan(file) {
  // Selecting a second file while the first is still being read must not let
  // the older result win, and the previous plan must not stay runnable.
  const seq = (state.planSeq += 1);
  state.plan = null;
  state.planDigest = null;
  state.planSource = null;
  state.views.plan = null;
  // A file plan says nothing about the quarantine folder, so the note must not
  // survive into it.
  state.quarantineDestination = null;
  clear(el("dry-run-result"));
  applyControlState();
  setStatus("plan-status", "plan.status.loading");
  try {
    // Check the size before reading: everything after this scales with it.
    const tooLarge = checkPlanFileSize(file.size);
    if (tooLarge) throw tooLarge;
    const raw = await readTextFile(file);
    const planDigest = await sha256Hex(raw);
    const parsed = JSON.parse(raw);
    const validation = validatePlanDocument(parsed);
    if (seq !== state.planSeq) return;
    state.planDigest = planDigest;
    if (!validation.ok) {
      state.plan = null;
      applyControlState();
      state.views.plan = () => renderPlanErrors(validation.errors);
      state.views.plan();
      setStatus(
        "plan-status",
        "plan.status.invalid",
        { count: validation.errors.length },
        "error",
      );
      return;
    }
    state.plan = parsed;
    state.planSource = "file";
    state.views.plan = null;
    clear(el("dry-run-result"));
    applyControlState();
    setStatus(
      "plan-status",
      "plan.status.loaded",
      {
        count: parsed.operations.length,
        digest: formatDigest(state.planDigest),
      },
      "ok",
    );
  } catch (error) {
    if (seq !== state.planSeq) return;
    state.plan = null;
    state.views.plan = null;
    applyControlState();
    setStatus(
      "plan-status",
      "plan.status.failed",
      { message: describeError(t, error) },
      "error",
    );
  }
}

function renderDryRun() {
  state.views.plan = renderDryRun;
  const result = dryRun(state.plan, state.entries, {
    protectedBookmarkIds: renameProtectedBookmarkIds(),
  });
  const panel = clear(el("dry-run-result"));

  if (typeof state.plan.notes === "string" && state.plan.notes.length > 0) {
    panel.appendChild(
      text("p", t("dryRun.notes", { notes: state.plan.notes }), "muted"),
    );
  }

  // A plan may legitimately contain no operations; header-only tables are noise.
  if (result.rows.length > 0) {
    panel.appendChild(
      table(
        [t("dryRun.summary.category"), t("dryRun.summary.count")],
        Object.entries(result.summary)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([status, count]) => [
            t(`status.${status}`),
            formatCount(count, t.locale),
          ]),
      ),
    );
  }
  panel.appendChild(
    text(
      "p",
      t("dryRun.totals", {
        movable: result.movableCount,
        blocked: result.blockedCount,
      }),
    ),
  );
  const visible = capRows(result.rows);
  if (visible.truncated) {
    panel.appendChild(
      text(
        "p",
        t("dryRun.truncated", {
          shown: visible.shown.length,
          total: visible.total,
        }),
        "muted",
      ),
    );
  }
  if (visible.shown.length > 0) {
    const opById = new Map(state.plan.operations.map((op) => [op.opId, op]));
    panel.appendChild(
      table(
        [
          t("dryRun.col.opId"),
          t("dryRun.col.kind"),
          t("dryRun.col.status"),
          t("dryRun.col.current"),
          t("dryRun.col.destination"),
          t("dryRun.col.detail"),
          t("dryRun.col.reason"),
          t("dryRun.col.confidence"),
        ],
        visible.shown.map((row) => {
          const op = opById.get(row.opId);
          // A rename has no destination, and the new title is the one thing the
          // user has to be able to read before approving it.
          const outcome =
            row.type === "update"
              ? t("dryRun.rename.to", { title: op?.newTitle ?? "" })
              : row.destinationPath
                ? formatPath(row.destinationPath)
                : "";
          return [
            row.opId ?? "",
            t(
              row.type === "update" ? "dryRun.kind.rename" : "dryRun.kind.move",
            ),
            t(`status.${row.status}`),
            row.currentPath ? formatPath(row.currentPath) : "",
            outcome,
            translateDetail(t, row.detail),
            row.reason ?? "",
            row.confidence === null ? "" : row.confidence.toFixed(2),
          ];
        }),
      ),
    );
  }

  const blocking = result.rows.filter(
    (row) => row.status !== STATUS.MOVABLE && row.status !== STATUS.NO_OP,
  );
  // Apply re-reads the whole tree per operation, so an unbounded batch is
  // refused here rather than discovered halfway through the run.
  const tooLarge = state.plan.operations.length > MAX_BATCH_OPERATIONS;
  // Only a clean Dry Run can be approved: a partially blocked plan is a plan
  // the agent has to fix, not one the user should be able to half-apply.
  state.dryRunRows = blocking.length === 0 && !tooLarge ? result.rows : null;
  refreshApproval();
  if (tooLarge) {
    setStatus(
      "apply-status",
      "plan.status.tooLarge",
      {
        count: state.plan.operations.length,
        limit: MAX_BATCH_OPERATIONS,
      },
      "error",
    );
  } else if (state.dryRunRows && !state.backupDigest) {
    setStatus("apply-status", "apply.status.approved", {
      count: result.movableCount,
    });
  }
  setStatus(
    "plan-status",
    blocking.length === 0 ? "dryRun.status.clean" : "dryRun.status.blocked",
    { movable: result.movableCount, count: blocking.length },
    blocking.length === 0 ? "ok" : "warn",
  );
  applyControlState();
}

/**
 * The token is rebuilt whenever either half of it changes, so it can never
 * describe a Dry Run and a backup that were not both current at the same time.
 */
function refreshApproval() {
  state.approval =
    state.dryRunRows && state.backupDigest
      ? createApproval({
          planDigest: state.planDigest,
          treeDigest: state.treeDigest,
          snapshotDigest: state.backupDigest,
          rows: state.dryRunRows,
          createdAt: new Date().toISOString(),
        })
      : null;
}

// --- Manual plan builder -----------------------------------------------------

/**
 * Drops the plan and everything derived from it. A file plan is independent
 * input, so only a hand-picked one is retired when the picking changes.
 */
function retireManualPlan() {
  if (state.planSource !== "manual") return;
  state.plan = null;
  state.planDigest = null;
  state.planSource = null;
  state.dryRunRows = null;
  state.views.plan = null;
  state.quarantineDestination = null;
  refreshApproval();
  clear(el("dry-run-result"));
  clearStatus("plan-status");
}

/** Every change to what a manual plan would contain goes through here. */
function bumpBuilderRev() {
  state.builderRev += 1;
  retireManualPlan();
  applyControlState();
}

/** Withdraws `id` as the keeper of whatever group it was keeping. */
function withdrawKeeper(id) {
  let withdrawn = false;
  for (const [key, keeperId] of state.duplicateKeep) {
    if (keeperId === id) {
      state.duplicateKeep.delete(key);
      withdrawn = true;
    }
  }
  return withdrawn;
}

function toggleSelection(id, checked) {
  // Symmetric with pickKeeper: choosing to move a copy withdraws it as its
  // group's keeper, so "keep this" and "move this" can never both be true.
  const withdrawn = checked && withdrawKeeper(id);
  if (checked) state.builderSelection.add(id);
  else state.builderSelection.delete(id);
  bumpBuilderRev();
  renderBuilder();
  restoreFocus("builder-panel", id);
  if (withdrawn && state.views.duplicates) renderDuplicates();
}

function clearSelection() {
  state.builderSelection.clear();
  bumpBuilderRev();
  renderBuilder();
  // The button disables itself once the selection is gone, so focus would be
  // dropped on the floor; the filter is where the user picks again.
  el("builder-filter").focus();
}

const selectionRow = (entry, checked) => ({
  id: entry.id,
  checked,
  label: entry.title,
  detail: formatPath(entry.path),
});

/**
 * Everything selected is listed first and in full, whatever the scope and
 * filter say. A selection the user cannot see is one they cannot revoke, and it
 * would still move.
 */
function renderBuilder() {
  state.views.builder = renderBuilder;
  const byId = indexById(state.entries);
  const panel = clear(el("builder-panel"));
  const { resolved, missing } = selectedEntries(state.builderSelection, byId);

  if (resolved.length > 0) {
    panel.appendChild(text("h3", t("builder.selected.title")));
    panel.appendChild(
      checkList(
        resolved.map((entry) => selectionRow(entry, true)),
        toggleSelection,
      ),
    );
  }

  const chosen = new Set(resolved.map((entry) => entry.id));
  const candidates = selectableEntries(state.entries, {
    scopeFolderId: el("builder-source").value || null,
    query: el("builder-filter").value,
    byId,
  }).filter((entry) => !chosen.has(entry.id));

  panel.appendChild(text("h3", t("builder.candidates.title")));
  const visible = capRows(candidates);
  if (visible.truncated) {
    panel.appendChild(
      text(
        "p",
        t("builder.truncated", {
          shown: visible.shown.length,
          total: visible.total,
        }),
        "muted",
      ),
    );
  }
  if (visible.shown.length === 0) {
    panel.appendChild(text("p", t("builder.candidates.none"), "muted"));
  } else {
    panel.appendChild(
      checkList(
        visible.shown.map((entry) => selectionRow(entry, false)),
        toggleSelection,
      ),
    );
  }

  if (missing.length > 0) {
    setStatus("builder-status", "builder.status.stale", undefined, "warn");
  } else if (resolved.length === 0) {
    setStatus("builder-status", "builder.status.none");
  } else if (el("builder-destination").value === "") {
    // "Use this selection" stays disabled until a destination exists, and a
    // greyed-out button with a bare count does not say which half is missing.
    setStatus("builder-status", "builder.status.selectedNeedsDestination", {
      count: resolved.length,
    });
  } else {
    setStatus("builder-status", "builder.status.selected", {
      count: resolved.length,
    });
  }
}

async function buildPlan() {
  // Adopting a plan retires the previous Dry Run and its approval together,
  // whatever produced that plan.
  const generation = state.generation;
  const rev = state.builderRev;
  const seq = (state.planSeq += 1);
  state.plan = null;
  state.planDigest = null;
  state.planSource = null;
  state.dryRunRows = null;
  state.views.plan = null;
  refreshApproval();
  clear(el("dry-run-result"));
  applyControlState();

  const byId = indexById(state.entries);
  const { plan, dropped } = buildPlanFromSelection({
    entries: state.entries,
    byId,
    selectedIds: state.builderSelection,
    destinationFolderId: el("builder-destination").value,
    reason: t("builder.reason"),
    generatedAt: new Date().toISOString(),
  });
  if (!plan) {
    setStatus(
      "builder-status",
      "builder.status.needsDestination",
      undefined,
      "error",
    );
    return;
  }

  // The manual plan is hashed exactly like a file plan, so the Dry Run to Apply
  // binding is the same check on the same bytes. A tree reload retires it too:
  // the ids and paths in it belong to the tree it was built from. `builderRev`
  // covers the selection and the destination moving while the digest ran.
  const planDigest = await sha256Hex(`${JSON.stringify(plan, null, 2)}\n`);
  if (
    generation !== state.generation ||
    seq !== state.planSeq ||
    rev !== state.builderRev
  ) {
    return;
  }

  state.plan = plan;
  state.planDigest = planDigest;
  state.planSource = "manual";
  applyControlState();
  setStatus(
    "builder-status",
    dropped.length > 0 ? "builder.status.builtDropped" : "builder.status.built",
    { count: plan.operations.length, dropped: dropped.length },
    "ok",
  );
  renderDryRun();
}

// --- Apply, verify, rollback -------------------------------------------------

async function readLiveEntries() {
  return flattenTree(await getLiveTree());
}

/**
 * A download cannot be observed from the page, so the only proof that a backup
 * exists is the user handing the saved file back and its bytes hashing to the
 * digest the export produced.
 */
async function verifyBackup(file) {
  const generation = state.generation;
  state.backupDigest = null;
  refreshApproval();
  applyControlState();
  setStatus("apply-status", "apply.backup.checking");
  try {
    const tooLarge = checkPlanFileSize(file.size, MAX_SNAPSHOT_FILE_BYTES);
    if (tooLarge) throw tooLarge;
    const raw = await readTextFile(file);
    const digest = await sha256Hex(raw);
    if (generation !== state.generation) return;

    if (digest !== state.expectedBackupDigest) {
      setStatus(
        "apply-status",
        "apply.backup.digestMismatch",
        undefined,
        "error",
      );
    } else if (JSON.parse(raw).treeDigest !== state.treeDigest) {
      setStatus(
        "apply-status",
        "apply.backup.treeMismatch",
        undefined,
        "error",
      );
    } else {
      state.backupDigest = digest;
      setStatus(
        "apply-status",
        "apply.backup.ok",
        { filename: file.name, digest: formatDigest(digest) },
        "ok",
      );
    }
  } catch (error) {
    if (generation !== state.generation) return;
    setStatus(
      "apply-status",
      "apply.backup.failed",
      { message: describeError(t, error) },
      "error",
    );
  } finally {
    refreshApproval();
    applyControlState();
  }
}

function renderBatchResult(result, options = {}) {
  state.views.apply = () => renderBatchResult(result, options);
  const panel = clear(el("apply-result"));
  const journal = result.journal;

  if (options.quarantinePath) {
    // Where they went, not what to do about it. This build cannot delete, and
    // the folder's contents can change after this line is written, so telling
    // anyone to delete it would be advice we cannot stand behind.
    panel.appendChild(
      text(
        "p",
        t("apply.quarantine.landed", { path: options.quarantinePath }),
        "muted",
      ),
    );
  }
  panel.appendChild(
    table(
      [t("apply.col.opId"), t("apply.col.status"), t("apply.col.expected")],
      journal.entries.map((entry) => [
        entry.opId,
        entry.state,
        entry.targetParentId === null
          ? ""
          : `${entry.targetParentId} / ${entry.targetIndex}`,
      ]),
    ),
  );
  if (result.drift) renderDrift(panel, result.drift);
}

function renderDrift(panel, drift) {
  panel.appendChild(text("h3", t("apply.drift.title")));
  if (drift.truncated) {
    panel.appendChild(
      text(
        "p",
        t("apply.drift.truncated", {
          shown: drift.changes.length,
          total: drift.total,
        }),
        "muted",
      ),
    );
  }
  panel.appendChild(
    table(
      [
        t("apply.drift.id"),
        t("apply.drift.field"),
        t("apply.drift.expected"),
        t("apply.drift.actual"),
      ],
      drift.changes.map((change) => [
        change.id,
        change.field,
        String(change.expected),
        String(change.actual),
      ]),
    ),
  );
}

/**
 * The quarantine folder to name in the result, or null. Every applied entry has
 * to have landed in the folder the send recorded; a batch that put anything
 * anywhere else is not the batch this note describes.
 */
function quarantineLanding(result) {
  const landing = state.quarantineDestination;
  if (!landing || result.aborted || state.planSource !== "manual") return null;
  const applied = appliedEntries(result.journal);
  if (applied.length === 0) return null;
  return applied.every((entry) => entry.targetParentId === landing.id)
    ? landing.path
    : null;
}

async function applyMoves() {
  const generation = state.generation;
  const token = state.approval;
  state.mode = MODE.APPLYING;
  applyControlState();
  setStatus("apply-status", "apply.status.running", {
    done: 0,
    total: token.approvedOpIds.length,
  });
  try {
    // A previous batch that can still be rolled back must not be overwritten.
    // `attempted` counts too: a crash between the move and its journal entry
    // leaves the only record of a move that already happened.
    if (
      state.journal &&
      (appliedEntries(state.journal).length > 0 ||
        attemptedEntries(state.journal).length > 0)
    ) {
      state.mode = MODE.IDLE;
      setStatus(
        "apply-status",
        "apply.reject.batchPending",
        undefined,
        "error",
      );
      return;
    }
    // Re-derive both halves of the token from the live tree, not from state.
    const entries = await readLiveEntries();
    const treeDigest = await sha256Hex(canonicalTreeString(entries));
    const mismatch = approvalMismatch(token, {
      planDigest: state.planDigest,
      treeDigest,
      rows: dryRun(state.plan, entries, {
        protectedBookmarkIds: renameProtectedBookmarkIds(),
      }).rows,
    });
    if (generation !== state.generation) return;
    if (mismatch) {
      state.mode = MODE.IDLE;
      setStatus(
        "apply-status",
        "apply.status.aborted",
        { message: t(mismatch.key, mismatch.params) },
        "error",
      );
      return;
    }

    const journal = createJournal({
      token,
      rows: state.dryRunRows,
      journalId: globalThis.crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
    await saveJournal(journal);

    const result = await runApply({
      journal,
      plan: state.plan,
      treeDigest,
      protectedBookmarkIds: renameProtectedBookmarkIds(),
      onProgress: progressWriter("apply-status", "apply.status.running"),
    });
    if (generation !== state.generation) return;

    state.journal = result.journal;
    state.mode = result.aborted ? MODE.ABORTED : MODE.APPLIED;
    renderBatchResult(result, {
      quarantinePath: quarantineLanding(result),
    });
    if (result.aborted) {
      setStatus(
        "apply-status",
        "apply.status.aborted",
        { message: t(result.aborted.key, result.aborted.params) },
        "error",
      );
    } else {
      setStatus(
        "apply-status",
        "apply.status.done",
        { count: appliedEntries(result.journal).length },
        "ok",
      );
    }
  } catch (error) {
    if (generation !== state.generation) return;
    state.mode = MODE.ABORTED;
    setStatus(
      "apply-status",
      "apply.status.aborted",
      { message: describeError(t, error) },
      "error",
    );
  } finally {
    applyControlState();
    focusResult("apply-status");
  }
}

async function verifyResult() {
  const generation = state.generation;
  // Verify settles the journal and writes it back, so it has to hold the page
  // the way the other batch actions do. Without this, a rollback started while
  // a verify was still in flight could delete the journal and then have the
  // late verify save it again, resurrecting a batch that was already undone.
  state.loading = true;
  applyControlState();
  try {
    const journal = await settleAttempted(state.journal);
    const entries = await readLiveEntries();
    const result = verifyJournal(journal, indexById(entries));
    if (generation !== state.generation) return;

    state.journal = journal;
    state.views.apply = () => renderVerify(result);
    renderVerify(result);
    const ok = result.summary.verified ?? 0;
    setStatus(
      "apply-status",
      result.ok ? "apply.status.verified" : "apply.status.verifyFailed",
      { ok, total: result.rows.length, count: result.rows.length - ok },
      result.ok ? "ok" : "error",
    );
  } catch (error) {
    if (generation !== state.generation) return;
    setStatus(
      "apply-status",
      "apply.status.aborted",
      { message: describeError(t, error) },
      "error",
    );
  } finally {
    state.loading = false;
    applyControlState();
    focusResult("apply-status");
  }
}

function renderVerify(result) {
  const panel = clear(el("apply-result"));
  // A rename reports titles, not positions, so the cell follows the shape it was
  // given instead of assuming a parent and an index.
  const cell = (value) => {
    if (value === null || value === undefined) return "";
    if (typeof value.title === "string") return value.title;
    return `${value.parentId} / ${value.index}`;
  };
  panel.appendChild(
    table(
      [
        t("apply.col.opId"),
        t("apply.col.status"),
        t("apply.col.expected"),
        t("apply.col.actual"),
      ],
      result.rows.map((row) => [
        row.opId,
        t(`verify.${row.status}`),
        cell(row.expected),
        cell(row.actual),
      ]),
    ),
  );
}

async function rollbackBatch() {
  const generation = state.generation;
  state.mode = MODE.ROLLING_BACK;
  applyControlState();
  setStatus("apply-status", "apply.status.rollingBack", { done: 0, total: 0 });
  try {
    const journal = await settleAttempted(state.journal);
    const result = await runRollback({
      journal,
      onProgress: progressWriter("apply-status", "apply.status.rollingBack"),
    });
    if (generation !== state.generation) return;

    renderBatchResult(result);
    if (result.aborted) {
      state.journal = result.journal;
      state.mode = MODE.ABORTED;
      setStatus(
        "apply-status",
        "apply.status.aborted",
        { message: t(result.aborted.key, result.aborted.params) },
        "error",
      );
    } else {
      const count = appliedEntries(journal).length;
      state.journal = null;
      state.mode = MODE.IDLE;
      setStatus("apply-status", "apply.status.rolledBack", { count }, "ok");
    }
  } catch (error) {
    if (generation !== state.generation) return;
    state.mode = MODE.ABORTED;
    setStatus(
      "apply-status",
      "apply.status.aborted",
      { message: describeError(t, error) },
      "error",
    );
  } finally {
    applyControlState();
    focusResult("apply-status");
  }
}

// --- Restore from a snapshot -------------------------------------------------

async function loadRestoreFile(file) {
  const generation = state.generation;
  state.restoreCandidate = null;
  clear(el("restore-result"));
  applyControlState();
  setStatus("restore-status", "restore.status.checking");
  try {
    const tooLarge = checkPlanFileSize(file.size, MAX_SNAPSHOT_FILE_BYTES);
    if (tooLarge) throw tooLarge;
    const parsed = JSON.parse(await readTextFile(file));
    if (generation !== state.generation) return;

    const validation = validateSnapshotDocument(parsed);
    if (!validation.ok) {
      renderPlanErrors(validation.errors, el("restore-result"));
      setStatus(
        "restore-status",
        "plan.status.invalid",
        { count: validation.errors.length },
        "error",
      );
      return;
    }

    const byId = indexById(state.entries);
    const provenance = provenanceReport(parsed, byId);
    if (!provenance.accepted) {
      setStatus(
        "restore-status",
        "restore.status.rejected",
        { matched: provenance.matched, total: provenance.total },
        "error",
      );
      return;
    }

    const candidate = buildRestoreMoves(parsed, byId);
    state.restoreCandidate =
      candidate.moves.length > 0 ? { ...candidate, snapshot: parsed } : null;
    state.views.restore = () => renderRestorePreview(candidate);
    renderRestorePreview(candidate);
    setStatus(
      "restore-status",
      candidate.moves.length === 0
        ? "restore.status.nothing"
        : "restore.status.ready",
      { moves: candidate.moves.length, skipped: candidate.skipped.length },
      "ok",
    );
  } catch (error) {
    if (generation !== state.generation) return;
    setStatus(
      "restore-status",
      "restore.status.failed",
      { message: describeError(t, error) },
      "error",
    );
  } finally {
    applyControlState();
  }
}

/**
 * Restore writes, so it shows what it will write. Listing only the skipped
 * nodes meant the user approved every actual move sight unseen, which is less
 * than the Dry Run gives them on the Apply path.
 */
function renderRestorePreview({ moves, skipped }) {
  const panel = clear(el("restore-result"));
  const byId = indexById(state.entries);
  const pathOf = (id) => {
    const entry = byId.get(id);
    return entry ? formatPath(entry.path) : id;
  };

  if (moves.length > 0) {
    panel.appendChild(text("h3", t("restore.moves.title")));
    const visible = capRows(moves);
    if (visible.truncated) {
      panel.appendChild(
        text(
          "p",
          t("dryRun.truncated", {
            shown: visible.shown.length,
            total: visible.total,
          }),
          "muted",
        ),
      );
    }
    panel.appendChild(
      table(
        [
          t("duplicates.col.id"),
          t("restore.moves.from"),
          t("restore.moves.to"),
        ],
        visible.shown.map((move) => [
          move.bookmarkId,
          `${pathOf(move.currentParentId)} [${move.currentIndex}]`,
          `${pathOf(move.targetParentId)} [${move.targetIndex}]`,
        ]),
      ),
    );
  }

  if (skipped.length === 0) return;
  panel.appendChild(text("h3", t("restore.skipped.title")));
  const visible = capRows(skipped);
  panel.appendChild(
    table(
      [t("restore.skipped.id"), t("restore.skipped.reason")],
      visible.shown.map((item) => [item.id, t(item.key)]),
    ),
  );
}

async function runRestoreNow() {
  const generation = state.generation;
  const moves = state.restoreCandidate.moves;
  const snapshot = state.restoreCandidate.snapshot;
  state.mode = MODE.RESTORING;
  applyControlState();
  setStatus("restore-status", "restore.status.running", {
    done: 0,
    total: moves.length,
  });
  try {
    const result = await runRestore({
      journal: {
        version: 1,
        kind: "apply-journal",
        journalId: globalThis.crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        planDigest: null,
        snapshotDigest: null,
        aborted: null,
        entries: [],
      },
      moves,
      snapshot,
      onProgress: progressWriter("restore-status", "restore.status.running"),
    });
    if (generation !== state.generation) return;

    state.mode = result.aborted ? MODE.ABORTED : MODE.IDLE;
    if (result.aborted) {
      if (result.drift) renderDrift(clear(el("restore-result")), result.drift);
      setStatus(
        "restore-status",
        "restore.status.failed",
        { message: t(result.aborted.key, result.aborted.params) },
        "error",
      );
    } else {
      state.restoreCandidate = null;
      setStatus(
        "restore-status",
        "restore.status.done",
        { count: moves.length },
        "ok",
      );
    }
  } catch (error) {
    if (generation !== state.generation) return;
    state.mode = MODE.ABORTED;
    setStatus(
      "restore-status",
      "restore.status.failed",
      { message: describeError(t, error) },
      "error",
    );
  } finally {
    applyControlState();
    focusResult("restore-status");
  }
}

/**
 * A batch survives the page that started it. Without this, a crash or a closed
 * tab would leave moves applied and no way to reach the rollback.
 */
async function restorePendingBatch() {
  const generation = state.generation;
  try {
    const journal = await loadJournal();
    if (generation !== state.generation) return;
    if (!journal) return;
    // Storage survives crashes and upgrades, so the record is validated before
    // it is allowed to drive a rollback. It is not deleted: a shape we cannot
    // read is still evidence, and Restore from a snapshot remains available.
    const problem = journalShapeError(journal);
    if (problem) {
      setStatus(
        "apply-status",
        "apply.reject.journalUnusable",
        { reason: problem },
        "error",
      );
      return;
    }
    // A journal with nothing left to undo is a leftover, not pending work.
    if (
      appliedEntries(journal).length === 0 &&
      attemptedEntries(journal).length === 0
    ) {
      await clearJournal();
      return;
    }
    state.journal = journal;
    setStatus(
      "apply-status",
      "apply.status.pending",
      { count: appliedEntries(journal).length },
      "warn",
    );
  } catch (error) {
    if (generation !== state.generation) return;
    setStatus(
      "apply-status",
      "apply.backup.failed",
      { message: describeError(t, error) },
      "error",
    );
  } finally {
    applyControlState();
  }
}

function trashReceipts() {
  return state.trashLedger?.receipts ?? [];
}

/**
 * Bookmarks whose title the Trash ledger is still matching on, so a rename would
 * break their own restore or delete. Not knowing is the worst case, not the
 * safest one: a ledger that was rejected, or that has not been read yet, cannot
 * list its protected ids, so every id is treated as protected until it can.
 */
function renameProtectedBookmarkIds() {
  if (state.trashRejected !== null) return ALL_IDS_PROTECTED;
  if (state.trashLedger === null) return ALL_IDS_PROTECTED;
  const ids = new Set(state.trashPoisoned ?? []);
  for (const receipt of trashReceipts()) {
    if (isActiveState(receipt.state)) ids.add(receipt.bookmarkId);
  }
  return ids;
}

/** Stands in for "every id", so an unreadable ledger cannot be renamed around. */
const ALL_IDS_PROTECTED = { has: () => true };

/** Only what this extension put in the Trash folder is ever a delete candidate. */
function deletableReceiptIds() {
  return trashReceipts()
    .filter((receipt) => receipt.state === RECEIPT_STATE.TRASHED)
    .map((receipt) => receipt.receiptId);
}

/**
 * The most recent batch whose members are all still in the Trash folder. Only a
 * complete batch can be put back in its original order, so a partly restored or
 * partly missing one is not offered.
 */
function newestIntactBatchId() {
  const sizes = new Map();
  const intact = new Map();
  for (const receipt of trashReceipts()) {
    sizes.set(receipt.batchId, receipt.batchSize);
    if (receipt.state !== RECEIPT_STATE.TRASHED) continue;
    intact.set(receipt.batchId, (intact.get(receipt.batchId) ?? 0) + 1);
  }
  let newest = null;
  for (const [batchId, size] of sizes) {
    if (intact.get(batchId) === size) newest = batchId;
  }
  return newest;
}

function renderTrash() {
  state.views.trash = renderTrash;
  const panel = clear(el("trash-panel"));
  const receipts = trashReceipts();
  if (receipts.length === 0) return;

  const now = Date.now();
  panel.appendChild(text("h3", t("trash.panel.title")));
  // The ledger is capped at MAX_TRASH_RECEIPTS, so this table cannot outgrow
  // the render budget the other panels cap themselves against.
  panel.appendChild(
    table(
      [
        t("trash.column.item"),
        t("trash.column.state"),
        t("trash.column.origin"),
        t("trash.column.batch"),
        t("trash.column.retention"),
      ],
      receipts.map((receipt) => [
        receipt.title,
        t(`trash.state.${receipt.state}`),
        formatPath(receipt.originalParentPath),
        receipt.batchId,
        isExpired(receipt, now)
          ? t("trash.retention.expired")
          : t("trash.retention.active", {
              date: new Date(receipt.retentionUntil).toLocaleDateString(
                t.locale,
              ),
            }),
      ]),
    ),
  );
}

/** The stored document keeps the quarantined receipts the working copy drops. */
function adoptLedger(ledger) {
  state.trashLedger = ledger;
  state.trashRecord = withQuarantined(ledger, state.trashQuarantined);
  renderTrash();
}

async function refreshTrash() {
  state.trashSeq += 1;
  const seq = state.trashSeq;
  const record = await loadTrashLedgerRecord();
  if (seq !== state.trashSeq) return;
  const parsed = readLedger(record);
  if (parsed.rejected !== null) {
    // Leave it exactly as it is. Adopting the raw document as a write baseline
    // would let the next send overwrite a newer version's records.
    state.trashRejected = parsed.rejected;
    setStatus(
      "trash-status",
      "trash.status.unreadable",
      { reason: parsed.rejected },
      "error",
    );
    applyControlState();
    return;
  }
  // Anything a crash left mid-move is resolved before it is offered to the user.
  const settled = await settleTrashLedger(parsed.ledger, {
    quarantined: parsed.quarantined,
    expect: record,
  });
  if (seq !== state.trashSeq) return;

  state.trashQuarantined = parsed.quarantined;
  state.trashPoisoned = parsed.poisonedBookmarkIds;
  state.trashLedger = settled;
  renderTrash();
  // The compare-and-set baseline has to be what storage actually holds. An
  // untouched ledger was never written, so a normalized empty document here
  // would disagree with the absent key and refuse the first write.
  state.trashRecord =
    settled === parsed.ledger
      ? record
      : withQuarantined(settled, parsed.quarantined);
  if (parsed.quarantined.length > 0) {
    setStatus(
      "trash-status",
      "trash.status.quarantined",
      { count: parsed.quarantined.length },
      "warn",
    );
  } else if (settled.receipts.length === 0) {
    setStatus("trash-status", "trash.status.empty");
  }
  applyControlState();
}

async function createTrashFolderNow() {
  const generation = state.generation;
  let createdId = null;
  state.mode = MODE.APPLYING;
  applyControlState();
  try {
    const { folder, error } = await createTrashFolder({
      parentId: el("trash-parent").value,
      title: el("trash-title").value.trim() || "Trash",
    });
    if (generation !== state.generation) return;
    if (error) {
      setStatus("trash-status", error.key, error.params, "error");
      return;
    }
    createdId = folder.id;
    setStatus(
      "trash-status",
      "trash.status.created",
      { title: folder.title },
      "ok",
    );
  } catch (error) {
    if (generation !== state.generation) return;
    setStatus(
      "trash-status",
      "trash.status.failed",
      { message: describeError(t, error) },
      "error",
    );
  } finally {
    state.mode = MODE.IDLE;
    applyControlState();
  }

  if (createdId === null) return;
  // A folder that is not in `state.entries` yet cannot be selected, so the tree
  // is read again before it is adopted.
  await loadTree();
  el("trash-folder").value = createdId;
  applyControlState();
  focusResult("trash-status");
}

async function sendToTrash() {
  const generation = state.generation;
  const bookmarkIds = [...state.builderSelection];
  const now = Date.now();
  let moved = false;
  state.mode = MODE.APPLYING;
  applyControlState();
  try {
    const result = await runTrash({
      ledger: state.trashLedger ?? createLedger(),
      quarantined: state.trashQuarantined,
      expect: state.trashRecord,
      bookmarkIds,
      trashFolderId: el("trash-folder").value,
      batchId: `trash-${now}`,
      trashedAt: now,
      onProgress: progressWriter("trash-status", "trash.status.working"),
    });
    if (generation !== state.generation) return;
    adoptLedger(result.ledger);
    moved = true;
    if (result.aborted) {
      setStatus(
        "trash-status",
        result.aborted.key,
        result.aborted.params,
        "error",
      );
    } else {
      setStatus(
        "trash-status",
        "trash.status.sent",
        { count: bookmarkIds.length },
        "ok",
      );
    }
  } catch (error) {
    if (generation !== state.generation) return;
    setStatus(
      "trash-status",
      "trash.status.failed",
      { message: describeError(t, error) },
      "error",
    );
  } finally {
    state.mode = MODE.IDLE;
    applyControlState();
  }

  if (!moved) return;
  // The selection and every derived panel describe positions that just changed.
  await loadTree();
  focusResult("trash-status");
}

async function restoreTrashBatch() {
  const generation = state.generation;
  const batchId = newestIntactBatchId();
  let ran = false;
  state.mode = MODE.RESTORING;
  applyControlState();
  try {
    const result = await runRestoreBatch({
      ledger: state.trashLedger,
      quarantined: state.trashQuarantined,
      expect: state.trashRecord,
      batchId,
      poisonedBookmarkIds: state.trashPoisoned,
      onProgress: progressWriter("trash-status", "trash.status.working"),
    });
    if (generation !== state.generation) return;
    adoptLedger(result.ledger);
    ran = true;
    if (result.aborted) {
      setStatus(
        "trash-status",
        result.aborted.key,
        result.aborted.params,
        "error",
      );
    } else {
      setStatus(
        "trash-status",
        "trash.status.restored",
        {
          count: result.ledger.receipts.filter((r) => r.batchId === batchId)
            .length,
        },
        "ok",
      );
    }
  } catch (error) {
    if (generation !== state.generation) return;
    setStatus(
      "trash-status",
      "trash.status.failed",
      { message: describeError(t, error) },
      "error",
    );
  } finally {
    state.mode = MODE.IDLE;
    applyControlState();
  }

  if (!ran) return;
  await loadTree();
  focusResult("trash-status");
}

/**
 * Drops the recovery records only. The bookmarks stay in the Trash folder; what
 * is lost is the record of where they came from, which is also the only way out
 * of a ledger that has filled up.
 */ async function forgetTrashRecords() {
  const generation = state.generation;
  const count = trashReceipts().length + state.trashQuarantined.length;
  const empty = createLedger();
  try {
    await saveTrashLedger(empty, { expect: state.trashRecord });
    if (generation !== state.generation) return;
    state.trashQuarantined = [];
    state.trashPoisoned = new Set();
    adoptLedger(empty);
    setStatus("trash-status", "trash.status.forgotten", { count }, "ok");
  } catch (error) {
    if (generation !== state.generation) return;
    setStatus(
      "trash-status",
      "trash.status.failed",
      { message: describeError(t, error) },
      "error",
    );
  } finally {
    applyControlState();
  }
}

/**
 * The only irreversible action in the page. It runs one item at a time and stops
 * at the first item that no longer matches its record, so a mistake costs one
 * bookmark rather than the batch.
 */
async function emptyTrashNow() {
  const generation = state.generation;
  const receiptIds = deletableReceiptIds();
  let ran = false;
  state.mode = MODE.APPLYING;
  applyControlState();
  try {
    const result = await runEmptyTrash({
      ledger: state.trashLedger,
      quarantined: state.trashQuarantined,
      expect: state.trashRecord,
      receiptIds,
      snapshotDigest: state.backupDigest,
      onProgress: progressWriter("trash-status", "trash.status.working"),
    });
    if (generation !== state.generation) return;
    adoptLedger(result.ledger);
    ran = true;
    if (result.aborted) {
      setStatus(
        "trash-status",
        result.aborted.key,
        result.aborted.params,
        "error",
      );
    } else {
      setStatus(
        "trash-status",
        "trash.status.deleted",
        { count: receiptIds.length },
        "ok",
      );
    }
  } catch (error) {
    if (generation !== state.generation) return;
    setStatus(
      "trash-status",
      "trash.status.failed",
      { message: describeError(t, error) },
      "error",
    );
  } finally {
    state.mode = MODE.IDLE;
    // The confirmation is deliberately single-use.
    el("empty-trash-confirm").checked = false;
    applyControlState();
  }

  if (!ran) return;
  await loadTree();
  focusResult("trash-status");
}

el("load-tree").addEventListener("click", loadTree);
el("quick-start").addEventListener("click", quickStart);
el("export-tree").addEventListener("click", exportTree);
el("backup-file").addEventListener("change", (event) => {
  const [file] = event.target.files ?? [];
  if (file) verifyBackup(file);
});
el("apply-moves").addEventListener("click", applyMoves);
el("verify-result").addEventListener("click", verifyResult);
el("rollback-batch").addEventListener("click", rollbackBatch);
el("restore-file").addEventListener("change", (event) => {
  const [file] = event.target.files ?? [];
  if (file) loadRestoreFile(file);
});
el("run-restore").addEventListener("click", runRestoreNow);
el("find-duplicates").addEventListener("click", renderDuplicates);
el("send-duplicates").addEventListener("click", sendDuplicates);
el("builder-source").addEventListener("change", renderBuilder);
el("builder-filter").addEventListener("input", renderBuilder);
// The destination is part of the plan, so changing it retires a hand-picked one.
el("builder-destination").addEventListener("change", () => {
  bumpBuilderRev();
  renderBuilder();
  // The duplicate report names the destination as the condition it is waiting on.
  if (state.views.duplicates) renderDuplicates();
});
el("build-plan").addEventListener("click", buildPlan);
el("clear-selection").addEventListener("click", clearSelection);
el("dup-mode").addEventListener("change", () => {
  // Keepers are per group key, and the keys change with the mode.
  state.duplicateKeep.clear();
  state.duplicateExpanded.clear();
  state.duplicateGroupsExpanded = false;
  state.duplicateSendReport = null;
  if (state.views.duplicates) renderDuplicates();
  applyControlState();
});
el("export-agent-context").addEventListener("click", exportAgentContext);
el("agent-scope").addEventListener("change", () => {
  if (state.views.agent) renderAgentSummary();
  syncScopeWarning();
});
el("dry-run").addEventListener("click", renderDryRun);
el("plan-file").addEventListener("change", (event) => {
  const [file] = event.target.files ?? [];
  if (file) loadPlan(file);
});
el("ui-locale").addEventListener("change", (event) => {
  const locale = event.target.value;
  storeLocale(locale);
  t = createTranslator(locale);
  renderAll();
});
el("trash-folder").addEventListener("change", applyControlState);
el("trash-parent").addEventListener("change", applyControlState);
el("create-trash-folder").addEventListener("click", createTrashFolderNow);
el("send-to-trash").addEventListener("click", sendToTrash);
el("trash-restore-batch").addEventListener("click", restoreTrashBatch);
el("trash-forget").addEventListener("click", forgetTrashRecords);
el("empty-trash-confirm").addEventListener("change", applyControlState);
el("empty-trash").addEventListener("click", emptyTrashNow);

el("ui-locale").value = t.locale;
applyControlState();
renderAll();
// The ledger outlives the tree, so it is read once at startup rather than on load.
void refreshTrash();

/**
 * A control that is disabled is the page refusing, and the API has to refuse
 * for the same reason rather than reaching past it.
 */
function requireControl(id) {
  if (el(id).disabled) {
    throw new LocalizedError("agent.error.notReady", { control: id });
  }
}

const statusOf = (id) => ({
  kind: el(id).dataset.kind ?? null,
  text: el(id).textContent,
});

const requireTree = () => {
  if (state.entries === null) {
    throw new LocalizedError("agent.error.noTree");
  }
  return state.entries;
};

const asRow = (entry) => ({
  id: entry.id,
  title: entry.title,
  url: entry.url,
  path: entry.path,
  parentId: entry.parentId,
  index: entry.index,
});

// Every handler either reads page state or calls the function a button calls.
// Nothing here performs a bookmark write of its own.
exposeAgentApi({
  capabilities: () => capabilitiesState(),
  getStats: () => {
    const entries = requireTree();
    return {
      bookmarks: entries.filter((entry) => !entry.isFolder).length,
      folders: entries.filter((entry) => entry.isFolder).length,
      boundaries: [
        ...new Set(
          entries
            .filter((entry) => entry.isPermanentRoot)
            .map((entry) => boundaryKey(entry))
            .filter(Boolean),
        ),
      ],
      mode: state.mode,
      hasPlan: state.plan !== null,
      backupVerified: state.backupDigest !== null,
    };
  },
  getTree: ({ limit }) => {
    const entries = requireTree();
    const cap = limit ?? MAX_RENDERED_ROWS;
    return { total: entries.length, shown: entries.slice(0, cap).map(asRow) };
  },
  // Local filtering over the tree already in memory. `chrome.bookmarks.search`
  // is not used anywhere in this build.
  search: ({ query, limit }) => {
    const entries = requireTree();
    const needle = query.toLowerCase();
    const hits = entries.filter(
      (entry) =>
        !entry.isFolder &&
        (entry.title.toLowerCase().includes(needle) ||
          (entry.url ?? "").toLowerCase().includes(needle)),
    );
    const cap = limit ?? MAX_RENDERED_ROWS;
    return { total: hits.length, shown: hits.slice(0, cap).map(asRow) };
  },
  listTrash: () => ({
    rejected: state.trashRejected !== null,
    quarantined: state.trashQuarantined.length,
    receipts: trashReceipts().map((receipt) => ({
      receiptId: receipt.receiptId,
      batchId: receipt.batchId,
      bookmarkId: receipt.bookmarkId,
      title: receipt.title,
      state: receipt.state,
    })),
  }),
  loadPlan: async ({ plan }) => {
    requireControl("plan-file");
    // Handed to the same reader the file input uses, so the size check, the
    // digest and the schema validation are the ones a file would have got.
    await loadPlan(
      new File([JSON.stringify(plan)], "agent-plan.json", {
        type: "application/json",
      }),
    );
    return { plan: statusOf("plan-status"), accepted: state.plan !== null };
  },
  dryRun: () => {
    requireControl("dry-run");
    renderDryRun();
    return {
      plan: statusOf("plan-status"),
      approvable: state.dryRunRows !== null,
    };
  },
  apply: async () => {
    // The backup has to be re-selected from disk, which is a file picker and
    // therefore a person. That is why this command cannot carry a batch from
    // plan to applied on its own.
    requireControl("apply-moves");
    await applyMoves();
    return { apply: statusOf("apply-status"), mode: state.mode };
  },
  verify: async () => {
    requireControl("verify-result");
    await verifyResult();
    return { apply: statusOf("apply-status"), mode: state.mode };
  },
  rollback: async () => {
    requireControl("rollback-batch");
    await rollbackBatch();
    return { apply: statusOf("apply-status"), mode: state.mode };
  },
});
