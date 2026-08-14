// Scale measurement on a real browser. Seeds a throwaway profile with a known
// shape, verifies that shape before measuring anything, then reports how long
// each stage of the UI takes.
//
// There is deliberately no time budget: a single wall-clock reading on a
// developer machine is too noisy to gate on. The gate here is functional —
// the seeded shape, the detected duplicate groups, and the render cap — and the
// timings are a record to compare against, not a pass/fail.
import { join } from "node:path";

import {
  ROOT,
  launchPilotBrowser,
  makeClicker,
  makeRecorder,
  makeWaiter,
} from "./lib/pilot-browser.mjs";

const WORK = join(ROOT, "tmp", "scale");
const FOLDERS = 100;
const DUP_GROUPS = 50;
const DUP_SIZE = 3;
const REPEATS = 3;
const RENDER_CAP = 500;
const SELECT_COUNT = 200;
// One extra empty folder outside the seeded ones, so the batch has somewhere to
// go that cannot be an ancestor or a descendant of anything it moves.
const DEST_TITLE = "scale-dest";

function positiveInt(raw, fallback) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`PILOT_SCALE must be a positive integer, got ${raw}`);
  }
  return value;
}

const { record } = makeRecorder();
let ok = false;
let cleaned = false;
let cleanup = null;

try {
  const TOTAL = positiveInt(process.env.PILOT_SCALE, 5000);
  const DUPLICATES = DUP_GROUPS * DUP_SIZE;
  if (TOTAL < DUPLICATES) {
    throw new Error(`PILOT_SCALE must be at least ${DUPLICATES}`);
  }
  record(
    "target shape",
    `${TOTAL} bookmarks / ${FOLDERS} source folders + 1 destination / ${DUP_GROUPS} duplicate groups of ${DUP_SIZE}`,
  );

  const session = await launchPilotBrowser({
    work: WORK,
    record,
    // A slow stage has to be measured, not reported as a driver timeout.
    callTimeoutMs: 300000,
  });
  cleanup = session.cleanup;
  const { evaluate } = session;
  const waitFor = makeWaiter(evaluate);
  const clickUntil = makeClicker(evaluate);

  // --- seed ------------------------------------------------------------------
  const seedStart = Date.now();
  const folderIds = await evaluate(`(async () => {
    const ids = [];
    for (let i = 0; i < ${FOLDERS}; i += 1) {
      const folder = await chrome.bookmarks.create({ parentId: "2", title: "scale-f" + i });
      ids.push(folder.id);
    }
    return JSON.stringify(ids);
  })()`).then(JSON.parse);
  if (folderIds.length !== FOLDERS) {
    throw new Error(`seeded ${folderIds.length} folders, expected ${FOLDERS}`);
  }

  // Under the bookmarks bar, so it shares the sync boundary with the sources
  // while sitting outside every subtree the batch moves.
  const destId = await evaluate(
    `chrome.bookmarks.create({ parentId: "1", title: ${JSON.stringify(DEST_TITLE)} }).then((f) => f.id)`,
  );

  // Chunked so no single evaluate outlives the CDP call timeout.
  const CHUNK = 500;
  let created = 0;
  for (let from = 0; from < TOTAL; from += CHUNK) {
    const to = Math.min(from + CHUNK, TOTAL);
    created += await evaluate(`(async () => {
      const folders = ${JSON.stringify(folderIds)};
      let n = 0;
      for (let i = ${from}; i < ${to}; i += 1) {
        // The first DUPLICATES entries form ${DUP_GROUPS} groups of ${DUP_SIZE}
        // sharing one URL each; everything after that is unique.
        const url = i < ${DUPLICATES}
          ? "https://example.com/dup/" + Math.floor(i / ${DUP_SIZE})
          : "https://example.com/unique/" + i;
        await chrome.bookmarks.create({
          parentId: folders[i % folders.length],
          title: "scale-b" + i,
          url,
        });
        n += 1;
      }
      return n;
    })()`);
  }
  record(
    "seed",
    `${created} bookmarks in ${((Date.now() - seedStart) / 1000).toFixed(1)}s`,
  );

  // --- verify the shape before measuring anything ----------------------------
  const actual = await evaluate(`(async () => {
    const roots = await chrome.bookmarks.getTree();
    let folders = 0;
    let bookmarks = 0;
    const urls = new Map();
    const walk = (node) => {
      if (node.parentId !== undefined && node.parentId !== "0") {
        if (node.url === undefined) folders += 1;
        else {
          bookmarks += 1;
          urls.set(node.url, (urls.get(node.url) ?? 0) + 1);
        }
      }
      for (const child of node.children ?? []) walk(child);
    };
    for (const root of roots) walk(root);
    let groups = 0;
    let wrongSize = 0;
    for (const count of urls.values()) {
      if (count > 1) {
        groups += 1;
        if (count !== ${DUP_SIZE}) wrongSize += 1;
      }
    }
    return JSON.stringify({ folders, bookmarks, groups, wrongSize });
  })()`).then(JSON.parse);

  const shapeErrors = [];
  if (actual.folders !== FOLDERS + 1)
    shapeErrors.push(`folders ${actual.folders} != ${FOLDERS + 1}`);
  if (actual.bookmarks !== TOTAL)
    shapeErrors.push(`bookmarks ${actual.bookmarks} != ${TOTAL}`);
  if (actual.groups !== DUP_GROUPS)
    shapeErrors.push(`duplicate groups ${actual.groups} != ${DUP_GROUPS}`);
  if (actual.wrongSize !== 0)
    shapeErrors.push(`${actual.wrongSize} groups have the wrong member count`);
  if (shapeErrors.length > 0) {
    // Before any timing: numbers from an incomplete profile mean nothing.
    throw new Error(`seeded shape is wrong: ${shapeErrors.join("; ")}`);
  }
  record(
    "verified shape",
    `${actual.bookmarks} bookmarks / ${actual.folders} folders / ${actual.groups} duplicate groups`,
  );

  // The bare API read, before any UI timing. It separates "the browser is still
  // settling after a bulk import" from "our load path is slow", instead of
  // leaving a multi-second outlier attributed by guesswork.
  const apiReads = [];
  for (let i = 0; i < 5; i += 1) {
    apiReads.push(
      await evaluate(`(async () => {
        const t0 = performance.now();
        await chrome.bookmarks.getTree();
        return performance.now() - t0;
      })()`),
    );
  }
  record(
    "direct bookmarks API read",
    `${apiReads.map((v) => v.toFixed(0)).join(", ")} ms`,
  );

  /**
   * Waits for the control to be usable, clears the status node, clicks, and
   * returns the milliseconds the page took to write the next status. Measured
   * in the page so the polling interval of the driver never enters the number.
   *
   * The page disables every control while a batch or a load is in flight, and a
   * click on a disabled button is silently swallowed. Without the wait below,
   * the next iteration clicks into nothing and then blocks on a status that is
   * never written, which reads as a multi-minute stage instead of a bug here.
   */
  const timeAction = (buttonId, statusId, done, timeoutMs = 120000) =>
    evaluate(`(async () => {
      const button = document.getElementById(${JSON.stringify(buttonId)});
      const deadline = performance.now() + ${timeoutMs};
      while (button.disabled) {
        if (performance.now() > deadline) {
          throw new Error(${JSON.stringify(buttonId)} + " stayed disabled for " + ${timeoutMs} + " ms");
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      const status = document.getElementById(${JSON.stringify(statusId)});
      status.textContent = "";
      delete status.dataset.kind;
      const finished = () => (${done});
      let observer;
      const settled = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error(${JSON.stringify(statusId)} + " never met the done condition; last text: " + status.textContent));
        }, ${timeoutMs});
        observer = new MutationObserver(() => {
          if (finished()) { clearTimeout(timer); observer.disconnect(); resolve(); }
        });
        observer.observe(status, { attributes: true, childList: true, subtree: true });
      });
      const t0 = performance.now();
      button.click();
      await settled;
      return performance.now() - t0;
    })()`);

  const median = (values) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  // Every reading is printed. Dropping the first one silently is how a
  // multi-second outlier ends up hidden behind a healthy median.
  const report = (label, all) => {
    const [first, ...rest] = all;
    record(
      label,
      `first ${first.toFixed(0)} ms, then median ${median(rest).toFixed(0)} ms  (${rest
        .map((v) => v.toFixed(0))
        .join(", ")})`,
    );
  };

  // --- measure ---------------------------------------------------------------
  const loadTimes = [];
  for (let i = 0; i <= REPEATS; i += 1) {
    loadTimes.push(
      await timeAction(
        "load-tree",
        "tree-status",
        `status.dataset.kind === "ok"`,
      ),
    );
  }
  report("end-to-end tree load and digest", loadTimes);

  const dupTimes = [];
  for (let i = 0; i <= REPEATS; i += 1) {
    dupTimes.push(
      await timeAction(
        "find-duplicates",
        "duplicates-status",
        `status.textContent.length > 0`,
      ),
    );
  }
  report("duplicate detection and render", dupTimes);

  const builderTimes = [];
  for (let i = 0; i <= REPEATS; i += 1) {
    builderTimes.push(
      await evaluate(`(async () => {
      const filter = document.getElementById("builder-filter");
      filter.value = "";
      filter.dispatchEvent(new Event("input"));
      const t0 = performance.now();
      filter.value = "scale-b1";
      filter.dispatchEvent(new Event("input"));
      return performance.now() - t0;
    })()`),
    );
  }
  report("builder filter and render", builderTimes);

  const exportTimes = [];
  for (let i = 0; i <= REPEATS; i += 1) {
    exportTimes.push(
      await timeAction(
        "export-agent-context",
        "agent-status",
        `status.dataset.kind !== undefined`,
      ),
    );
  }
  report("agent context export", exportTimes);

  // --- functional invariants -------------------------------------------------
  const rendered = await evaluate(
    `document.querySelectorAll("#builder-panel input[type=checkbox]").length`,
  );
  if (rendered > RENDER_CAP) {
    throw new Error(
      `the builder rendered ${rendered} rows, over the ${RENDER_CAP} cap`,
    );
  }
  record("builder rows rendered", `${rendered} (cap ${RENDER_CAP})`);

  const dupRendered = await evaluate(
    `document.querySelectorAll("#duplicates h3").length`,
  );
  record("duplicate groups rendered", `${dupRendered} of ${DUP_GROUPS}`);
  if (dupRendered !== DUP_GROUPS) {
    throw new Error(
      `the report rendered ${dupRendered} duplicate groups, expected ${DUP_GROUPS}: the detection this run times was not the detection that ran`,
    );
  }

  // --- the Trash folder, before anything is selected --------------------------
  // Adopting a Trash folder re-reads the tree, and a tree reload discards the
  // builder selection. Creating it after the selection would silently send an
  // empty batch, so it has to exist before the first checkbox is ticked.
  await evaluate(`(() => {
    const parent = document.getElementById("trash-parent");
    parent.value = "2";
    parent.dispatchEvent(new Event("change"));
    document.getElementById("trash-title").value = "scale-trash";
  })()`);
  await clickUntil(
    "create-trash-folder",
    `document.getElementById("trash-status").dataset.kind === "ok" && document.getElementById("trash-folder").value !== ""`,
    "the Trash folder to be created and adopted",
  );
  const trashFolderId = await evaluate(
    `document.getElementById("trash-folder").value`,
  );
  record("trash folder", `id=${trashFolderId} under "2"`);

  // --- a full-size batch through the Dry Run ---------------------------------
  const selectStart = Date.now();
  const selected = await evaluate(`(async () => {
    // "scale-b" matches the seeded bookmarks only, never a folder, so the
    // destination can never end up among the rows being moved.
    const filter = document.getElementById("builder-filter");
    filter.value = "scale-b";
    filter.dispatchEvent(new Event("input"));
    // Every toggle re-renders the whole panel, so the next row has to be
    // re-queried. Holding a NodeList would click nodes that are already
    // detached, which silently selects nothing.
    for (let i = 0; i < ${SELECT_COUNT}; i += 1) {
      const box = document.querySelector(
        "#builder-panel input[type=checkbox]:not(:checked)",
      );
      if (!box) break;
      box.click();
    }
    return document.querySelectorAll(
      "#builder-panel input[type=checkbox]:checked",
    ).length;
  })()`);
  record(
    `selecting ${SELECT_COUNT} rows one by one`,
    `${selected} selected in ${((Date.now() - selectStart) / 1000).toFixed(1)}s`,
  );
  if (selected !== SELECT_COUNT) {
    throw new Error(
      `selected ${selected} rows, expected ${SELECT_COUNT}: the batch this run reports on was never assembled`,
    );
  }

  const dryRunMs = await evaluate(`(async () => {
    const dest = document.getElementById("builder-destination");
    dest.value = ${JSON.stringify(destId)};
    dest.dispatchEvent(new Event("change"));
    const build = document.getElementById("build-plan");
    const deadline = performance.now() + 120000;
    while (build.disabled) {
      if (performance.now() > deadline) throw new Error("build-plan stayed disabled");
      await new Promise((r) => setTimeout(r, 20));
    }
    const status = document.getElementById("plan-status");
    status.textContent = "";
    delete status.dataset.kind;
    let observer;
    const settled = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error("plan-status never settled; last text: " + status.textContent));
      }, 120000);
      observer = new MutationObserver(() => {
        if (status.dataset.kind !== undefined) { clearTimeout(timer); observer.disconnect(); resolve(); }
      });
      observer.observe(status, { attributes: true, childList: true, subtree: true });
    });
    const t0 = performance.now();
    build.click();
    await settled;
    return performance.now() - t0;
  })()`);
  record(
    `build plan and Dry Run for ${selected} operations`,
    `${dryRunMs.toFixed(0)} ms`,
  );

  // `renderDryRun` writes "ok" only when no row is blocked, and "warn"
  // otherwise. The status text itself is localized, the kind is not.
  const dryRunKind = await evaluate(
    `document.getElementById("plan-status").dataset.kind ?? ""`,
  );
  // The panel renders a category summary table before the operations table, so
  // only the last one holds one row per operation.
  const dryRunRows = await evaluate(
    `[...document.querySelectorAll("#dry-run-result table")].pop()?.tBodies[0].rows.length ?? 0`,
  );
  record(
    "dry run outcome",
    `kind=${dryRunKind} rows=${dryRunRows} — ${await evaluate(`document.getElementById("plan-status").textContent`)}`,
  );
  if (dryRunKind !== "ok") {
    throw new Error(
      `the Dry Run for ${selected} operations came back "${dryRunKind}", so the batch was refused`,
    );
  }
  if (dryRunRows !== selected) {
    throw new Error(
      `the Dry Run listed ${dryRunRows} rows for ${selected} selected bookmarks`,
    );
  }

  // --- a full-size Trash round trip on a full-size profile --------------------
  // A whole 5000-bookmark profile cannot go to the Trash in one go: the batch
  // cap is 200 operations and the ledger holds 500 receipts. What this proves is
  // that a batch at the cap still comes back to its exact positions when the
  // surrounding tree is large, which is where an index-based restore would drift.
  //
  // The Dry Run above left the same rows checked, so this is the batch at the
  // cap. Read the ids off the boxes rather than re-deriving them from the tree.
  const trashIds = await evaluate(
    `JSON.stringify([...document.querySelectorAll("#builder-panel input[type=checkbox]:checked")].map((box) => box.dataset.id))`,
  ).then(JSON.parse);
  if (trashIds.length !== SELECT_COUNT) {
    throw new Error(
      `the Trash batch carried ${trashIds.length} ids, expected ${SELECT_COUNT}`,
    );
  }

  // Keyed by id, not by array position: `chrome.bookmarks.get` does not promise
  // to answer in the order it was asked, and comparing by index would let two
  // bookmarks swap places without the before/after check noticing.
  const positionsOf = async (ids) =>
    JSON.parse(
      await evaluate(
        `chrome.bookmarks.get(${JSON.stringify(ids)}).then((nodes) =>
          JSON.stringify(Object.fromEntries(nodes.map((n) => [n.id, n.parentId + ":" + n.index])))
        )`,
      ),
    );
  const beforeTrash = await positionsOf(trashIds);
  if (Object.keys(beforeTrash).length !== trashIds.length) {
    throw new Error(
      `read ${Object.keys(beforeTrash).length} positions for ${trashIds.length} ids`,
    );
  }

  // The status keeps the previous step's verdict until the next one settles, so
  // it is cleared before each click; otherwise a stale "ok" reads as done while
  // the button is merely disabled for being busy. An "error" is not a finish.
  //
  // `clickUntil` is deliberately not used here. It is for idempotent actions,
  // and a Trash send is not one: it re-clicks every 250 ms and would start a
  // second batch the moment the button came back. A 200-item batch also runs
  // well past its 15 s ceiling, which is what made the first run time out.
  const settleTrashStatus = async (buttonId, what) => {
    const id = JSON.stringify(buttonId);
    // A disabled button swallows clicks silently, so name the precondition that
    // is missing instead of reporting a bare timeout.
    await waitFor(
      `document.getElementById(${id}).disabled === false`,
      `${what} to unlock (control state: ${await evaluate(
        `JSON.stringify({
          selected: document.querySelectorAll("#builder-panel input[type=checkbox]:checked").length,
          trashFolder: document.getElementById("trash-folder").value,
          trashStatus: document.getElementById("trash-status").dataset.kind ?? null,
          planStatus: document.getElementById("plan-status").dataset.kind ?? null,
        })`,
      )})`,
      20,
    );
    await evaluate(`(() => {
      const status = document.getElementById("trash-status");
      status.textContent = "";
      delete status.dataset.kind;
      document.getElementById(${id}).click();
    })()`);
    const t0 = Date.now();
    // 200 moves with event correlation take minutes, not seconds.
    await waitFor(
      `["ok","error"].includes(document.getElementById("trash-status").dataset.kind)`,
      `${what} to settle`,
      600,
    );
    const kind = await evaluate(
      `document.getElementById("trash-status").dataset.kind`,
    );
    const text = await evaluate(
      `document.getElementById("trash-status").textContent`,
    );
    if (kind !== "ok") throw new Error(`${what} reported "${kind}": ${text}`);
    return { ms: Date.now() - t0, text };
  };

  const sent = await settleTrashStatus(
    "send-to-trash",
    "the Trash send at scale",
  );
  record(
    `send ${trashIds.length} bookmarks to the Trash`,
    `${sent.ms} ms — ${sent.text}`,
  );

  const landed = await positionsOf(trashIds);
  const strays = trashIds.filter(
    (id) => landed[id]?.split(":")[0] !== trashFolderId,
  );
  if (strays.length > 0) {
    throw new Error(
      `${strays.length} of ${trashIds.length} bookmarks did not reach the Trash folder (first: ${strays[0]} at ${landed[strays[0]]})`,
    );
  }

  const receiptCount = await evaluate(
    `chrome.storage.local.get("trash-ledger").then((bag) =>
      (bag["trash-ledger"]?.receipts ?? []).length
    )`,
  );
  record("recovery records written", `${receiptCount} receipts`);
  if (receiptCount !== trashIds.length) {
    throw new Error(
      `the ledger holds ${receiptCount} receipts for a batch of ${trashIds.length}`,
    );
  }

  await waitFor(
    `document.getElementById("trash-restore-batch").disabled === false`,
    "the batch restore to unlock",
  );
  const restored = await settleTrashStatus(
    "trash-restore-batch",
    "the batch restore at scale",
  );
  record(
    `restore ${trashIds.length} bookmarks from the Trash`,
    `${restored.ms} ms — ${restored.text}`,
  );

  const afterTrash = await positionsOf(trashIds);
  const drifted = trashIds.filter((id) => afterTrash[id] !== beforeTrash[id]);
  record(
    "positions after the batch restore",
    drifted.length === 0
      ? `all ${trashIds.length} back at their exact parent:index`
      : `${drifted.length} drifted`,
  );
  if (drifted.length > 0) {
    throw new Error(
      `${drifted.length} of ${trashIds.length} bookmarks did not come back to their exact position (first: ${drifted[0]} at ${afterTrash[drifted[0]]}, expected ${beforeTrash[drifted[0]]})`,
    );
  }

  ok = true;
  record(
    "verdict",
    `SCALE PASS: the seeded shape held, ${SELECT_COUNT} rows were selected one by one, their Dry Run came back clean, and a ${SELECT_COUNT}-item Trash round trip landed on exact positions`,
  );
} catch (error) {
  record("error", error.message);
} finally {
  if (cleanup) {
    // A throwaway profile left on disk is a failure of this run, not a footnote.
    cleaned = await cleanup();
    record("cleanup", `profile removed: ${cleaned}`);
  }
}

process.exitCode = ok && cleaned ? 0 : 1;
