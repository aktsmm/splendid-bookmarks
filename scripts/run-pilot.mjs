// Real-browser pilot: launches a throwaway profile with the unpacked extension,
// seeds duplicate bookmarks, then drives the quarantine send through
// Dry Run -> Apply -> Verify -> Rollback and reports what the browser actually
// did. Judged by live `chrome.bookmarks.get` readings, never by UI text.
//
// PILOT_SIGNIN_PAUSE=1 leaves sync enabled and waits, so the operator can sign
// the throwaway profile into a test account; the account/local boundary case is
// then exercised for real instead of resting on unit tests alone. That mode
// asks for consent before a browser exists, and requires Chrome, because the
// two-store procedure it depends on is a documented Chrome procedure.
// PILOT_REQUIRE_BOUNDARY=1 makes a skipped boundary its own exit code.
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  OUTCOME,
  boundaryOutcome,
  checkBrowserIdentity,
  exitCodeFor,
  planFixtureRoots,
  runOutcome,
} from "./lib/pilot-boundary.mjs";
import {
  ROOT,
  launchPilotBrowser,
  makeRecorder,
  makeClicker,
  makeWaiter,
  sleep,
} from "./lib/pilot-browser.mjs";

const WORK = join(ROOT, "tmp", "pilot");
const SIGNIN_PAUSE = process.env.PILOT_SIGNIN_PAUSE === "1";
const REQUIRE_BOUNDARY = process.env.PILOT_REQUIRE_BOUNDARY === "1";
// Release verification loads the unpacked build, not the working tree, so the
// artifact that goes to the store is the artifact that was driven here.
const EXTENSION_DIR = (() => {
  const at = process.argv.indexOf("--extension-dir");
  if (at === -1) return undefined;
  const value = process.argv[at + 1];
  if (!value) throw new Error("--extension-dir needs a path");
  return value;
})();
// Every node this run creates carries this tag, so the sweep at the end can find
// its own fixtures by name when a create's id never came back over CDP, and can
// never match a different run's.
const TAG = `pilot-${randomUUID().slice(0, 8)}`;

const { record } = makeRecorder();
let verdict = "PILOT FAIL: the run did not reach a verdict";
let outcome = OUTCOME.FAIL;
let boundaryResult = OUTCOME.SKIP;
let boundaryDetail = "the boundary case was never reached";
let mainPass = false;
let identityOk = true;
let sweepOk = false;
let aborted = false;
let failureReason = "";
let cleaned = false;
let cleanup = null;
// Held at this scope so the sweep in `finally` can run after a failure halfway
// through, while the fixtures are still reachable.
let evaluate = null;
const createdIds = [];

/** Thrown when the operator declines: not a failure of the build. */
class PilotAbort extends Error {}

/**
 * Asked before a browser exists and before a profile directory is created, so
 * declining costs nothing and leaves nothing behind. What the profile holds
 * cannot be the gate: a machine with browser single sign-on can sign a brand new
 * profile into an account with nobody touching the window, and an account with
 * ten bookmarks in it is still somebody's account.
 */
async function askOperatorConsent() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    "\nPILOT_SIGNIN_PAUSE=1 drives a signed-in browser profile.\n" +
      "Browser single sign-on can sign a brand new profile into an account you already use.\n" +
      "This run then creates bookmarks in whatever account it ends up in, and deletes one of\n" +
      "its own fixtures for good. Use a throwaway account only.\n" +
      'Type "yes" to continue, anything else to stop: ',
  );
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

try {
  if (SIGNIN_PAUSE && !(await askOperatorConsent())) {
    throw new PilotAbort(
      'the operator did not type "yes" at the consent prompt',
    );
  }

  const session = await launchPilotBrowser({
    work: WORK,
    record,
    sync: SIGNIN_PAUSE,
    dualStoreFlags: process.env.PILOT_DUAL_STORE_FLAGS === "1",
    ...(EXTENSION_DIR ? { extensionDir: EXTENSION_DIR } : {}),
  });
  cleanup = session.cleanup;
  const {
    page,
    evaluate: evaluateInPage,
    downloads,
    profile,
    product,
  } = session;
  evaluate = evaluateInPage;
  const waitFor = makeWaiter(evaluate);
  const clickUntil = makeClicker(evaluate);

  // The boundary story depends on `BookmarkTreeNode.syncing`, which is Chrome
  // 134+. The product string is recorded either way so an unknown browser is
  // reported rather than guessed at.
  const identity = checkBrowserIdentity(product, {
    requireFamily: SIGNIN_PAUSE ? "chrome" : null,
  });
  identityOk = identity.ok;
  record(
    "browser identity",
    `${identity.identity.raw} family=${identity.identity.family} major=${identity.identity.major} ok=${identity.ok}`,
  );
  if (!identity.ok) throw new Error(identity.reason);

  /**
   * Clears the status the previous step left behind, waits for the control, and
   * clicks once. A single click only, because these actions write.
   */
  const actAndWait = async (buttonId, statusId, done, what, tries) => {
    await waitFor(
      `!document.getElementById(${JSON.stringify(buttonId)}).disabled`,
      `${buttonId} to become available`,
    );
    await evaluate(`(() => {
      const status = document.getElementById(${JSON.stringify(statusId)});
      status.textContent = "";
      delete status.dataset.kind;
      document.getElementById(${JSON.stringify(buttonId)}).click();
    })()`);
    await waitFor(done, what, tries);
  };

  const statusOf = (id) =>
    evaluate(
      `JSON.stringify({text: document.getElementById(${JSON.stringify(id)}).textContent, kind: document.getElementById(${JSON.stringify(id)}).dataset.kind ?? ""})`,
    ).then(JSON.parse);

  // --- preflight -------------------------------------------------------------
  // The profile is new, so both records must be absent. A leftover journal or
  // ledger would mean this run is not starting from the state it reports on.
  // Nothing above this point has written a bookmark.
  const preflight = await evaluate(
    `chrome.storage.local.get(["apply-journal", "trash-ledger"]).then((bag) =>
      JSON.stringify(Object.keys(bag))
    )`,
  ).then(JSON.parse);
  record(
    "preflight",
    preflight.length === 0
      ? "no journal and no trash ledger in this profile"
      : `stored records already present: ${preflight.join(", ")}`,
  );
  if (preflight.length > 0) {
    throw new Error(
      `the throwaway profile already holds ${preflight.join(", ")}, so this run would not start clean`,
    );
  }

  // --- resolve the roots this run may write to -------------------------------
  // Root ids are not fixed, and a profile carrying both stores has more than one
  // of each folder type, so "1" and "2" cannot be spelled here.
  const readRootChildren = () =>
    evaluate(`(async () => {
      const [root] = await chrome.bookmarks.getTree();
      return JSON.stringify((root.children ?? []).map((child) => ({
        id: child.id,
        title: child.title,
        folderType: child.folderType ?? null,
        syncing: typeof child.syncing === "boolean" ? child.syncing : null,
        unmodifiable: child.unmodifiable ?? null,
      })));
    })()`).then(JSON.parse);
  const countNodes = () =>
    evaluate(`(async () => {
      const [root] = await chrome.bookmarks.getTree();
      let nodes = 0;
      const walk = (node) => { nodes += 1; for (const child of node.children ?? []) walk(child); };
      walk(root);
      return nodes;
    })()`);
  const noSeedRoots = () =>
    new Error(
      "no writable bookmarks-bar and other pair to seed from in this profile",
    );

  let roots = planFixtureRoots(await readRootChildren());
  record("boundary keys at launch", roots.keys.join(", ") || "none");

  let localMarkerId = null;
  if (SIGNIN_PAUSE) {
    if (!roots.home) throw noSeedRoots(); // Evidence, not a gate. The gate for this mode was the consent taken before
    // the browser existed, because a count cannot tell a throwaway account from
    // a real one that happens to be nearly empty.
    record("profile before sign-in", `${await countNodes()} nodes`);

    // Seeded before the sign-in on purpose. `syncing` distinguishes the account
    // copy of a folder type from the local one, so two boundaries only exist
    // when both stores do. A bookmark that was already here when the browser
    // signed in is the one thing that might stay in the local store; anything
    // created afterwards lands in the account store, which is what the first
    // measured run did and why it saw only `syncing:true`.
    localMarkerId = await evaluate(
      `chrome.bookmarks.create({ parentId: ${JSON.stringify(roots.home.bar)}, title: ${JSON.stringify(`${TAG}-local-marker`)}, url: "https://example.com/local" }).then((n) => n.id)`,
    );
    createdIds.push(localMarkerId);
    record("local marker before sign-in", `id=${localMarkerId}`);

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    await rl.question(
      "\nSign the throwaway browser window in, decline sync when it is offered, decline any\n" +
        "offer to upload the existing bookmarks, then press Enter to continue...\n",
    );
    rl.close();
    record("profile after the sign-in pause", `${await countNodes()} nodes`);

    // Sign-in, transport mode and the account roots all arrive asynchronously,
    // so a single read here would report a slow profile as single-store.
    for (let i = 0; i < 60; i += 1) {
      roots = planFixtureRoots(await readRootChildren());
      if (roots.away) break;
      await sleep(1000);
    }
    record(
      "boundary keys after sign-in",
      `${roots.keys.join(", ") || "none"} — second store: ${roots.away ? "yes" : "no"}`,
    );
  }
  if (!roots.home) throw noSeedRoots();

  // --- seed throwaway fixtures -----------------------------------------------
  // Three copies of one URL across two folders, so the quarantine send has to
  // gather members that do not share a parent.
  const fixtures = await evaluate(`(async () => {
    const tag = ${JSON.stringify(TAG)};
    const bar = ${JSON.stringify(roots.home.bar)};
    const other = ${JSON.stringify(roots.home.other)};
    const src = await chrome.bookmarks.create({ parentId: other, title: tag + "-src" });
    const src2 = await chrome.bookmarks.create({ parentId: other, title: tag + "-src2" });
    const dest = await chrome.bookmarks.create({ parentId: bar, title: tag + "-quarantine" });
    const url = "https://example.com/pilot";
    const keep = await chrome.bookmarks.create({ parentId: src.id, title: tag + "-keep", url });
    const dupA = await chrome.bookmarks.create({ parentId: src.id, title: tag + "-dup-a", url });
    const dupB = await chrome.bookmarks.create({ parentId: src2.id, title: tag + "-dup-b", url });
    return JSON.stringify({
      src: src.id, src2: src2.id, dest: dest.id,
      keep: keep.id, dupA: dupA.id, dupB: dupB.id,
    });
  })()`).then(JSON.parse);
  createdIds.push(fixtures.src, fixtures.src2, fixtures.dest);
  record(
    "fixtures",
    `src=${fixtures.src} src2=${fixtures.src2} dest=${fixtures.dest} keep=${fixtures.keep} dupA=${fixtures.dupA} dupB=${fixtures.dupB}`,
  );

  // --- 1. load the tree ------------------------------------------------------
  // Reading the tree is idempotent, so this may retry; the page has only just
  // been opened and its module may not have attached the handler yet.
  await clickUntil(
    "load-tree",
    `document.getElementById("tree-status").dataset.kind === "ok"`,
    "tree load",
  );
  record("load tree", (await statusOf("tree-status")).text);

  // --- 1.5 the agent command API ---------------------------------------------
  // Driven the way an agent would: over CDP, through the exposed entry point,
  // with no DOM scraping. Run here, before any plan exists, so Apply is refused
  // by the page for a reason the probe did not have to arrange. Asking later
  // would have found a loaded plan still approved — a file plan deliberately
  // survives a tree reload — and the probe itself would have started a batch.
  const api = await evaluate(
    `(async () => {
      const run = (command, input) => window.splendidBookmarks.run(command, input);
      const applyDisabled = document.getElementById("apply-moves").disabled;
      const capabilities = await run("capabilities");
      const stats = await run("getStats");
      const search = await run("search", { query: ${JSON.stringify(`${TAG}-keep`)} });
      const unknown = await run("nope");
      const badField = await run("dryRun", { force: true });
      // Only asked while the page is already refusing, so the probe can never
      // be the thing that starts a batch.
      const applyNow = applyDisabled ? await run("apply") : null;
      const dryRunNow = await run("dryRun");
      const emptyTrash = await run("emptyTrash");
      return JSON.stringify({
        exposed: typeof window.splendidBookmarks?.run === "function",
        frozen: Object.isFrozen(window.splendidBookmarks),
        applyDisabled,
        version: capabilities.state?.version ?? null,
        commands: capabilities.state?.commands ?? [],
        notes: capabilities.state?.notes ?? null,
        bookmarks: stats.state?.bookmarks ?? null,
        searchHits: search.state?.total ?? null,
        searchTitle: search.state?.shown?.[0]?.title ?? null,
        unknownKey: unknown.error?.key ?? null,
        badFieldKey: badField.error?.key ?? null,
        applyKey: applyNow?.error?.key ?? null,
        dryRunKey: dryRunNow.error?.key ?? null,
        emptyTrashKey: emptyTrash.error?.key ?? null,
      });
    })()`,
  ).then(JSON.parse);
  record(
    "agent api",
    `v${api.version} commands=${api.commands.length} bookmarks=${api.bookmarks} search="${api.searchTitle}"`,
  );
  record(
    "agent api refusals",
    `unknown=${api.unknownKey} badField=${api.badFieldKey} apply=${api.applyKey} dryRun=${api.dryRunKey} emptyTrash=${api.emptyTrashKey}`,
  );

  const apiResult =
    api.exposed &&
    api.frozen &&
    api.version === 1 &&
    api.commands.includes("dryRun") &&
    !api.commands.includes("emptyTrash") &&
    api.notes?.applyNeedsHumanBackup === true &&
    api.notes?.isSecurityBoundary === false &&
    api.bookmarks > 0 &&
    api.searchHits === 1 &&
    api.searchTitle === `${TAG}-keep` &&
    api.unknownKey === "agent.error.unknownCommand" &&
    api.badFieldKey === "agent.error.unknownField" &&
    // Refused because the control is disabled, not because the command is unknown.
    api.applyDisabled &&
    api.applyKey === "agent.error.notReady" &&
    api.dryRunKey === "agent.error.notReady" &&
    api.emptyTrashKey === "agent.error.unknownCommand"
      ? "PASS: the API answered reads, refused unknown input, and refused Apply and Dry Run for the same reason the page did"
      : `FAIL: ${JSON.stringify(api)}`;
  record("agent api result", apiResult);

  // --- 2. export the snapshot ------------------------------------------------
  await evaluate(`document.getElementById("export-tree").click()`);
  await waitFor(
    `["ok","error"].includes(document.getElementById("tree-status").dataset.kind) && !document.getElementById("tree-status").textContent.includes("\u30ce\u30fc\u30c9") && !document.getElementById("tree-status").textContent.includes("nodes")`,
    "snapshot export",
  );
  record("export snapshot", (await statusOf("tree-status")).text);

  let snapshotFile = null;
  for (let i = 0; i < 40 && !snapshotFile; i += 1) {
    const files = readdirSync(downloads).filter((f) => f.endsWith(".json"));
    if (files.length > 0) snapshotFile = join(downloads, files[0]);
    else await sleep(250);
  }
  if (!snapshotFile)
    throw new Error("the snapshot never reached the download dir");
  record("snapshot file", snapshotFile);

  // --- 3. quarantine the duplicates ------------------------------------------
  // The destination is required before sending: that is what lets the send
  // report an off-boundary copy instead of blocking the whole Dry Run later.
  await evaluate(`(() => {
    const dest = document.getElementById("builder-destination");
    dest.value = ${JSON.stringify(fixtures.dest)};
    dest.dispatchEvent(new Event("change"));
  })()`);

  await evaluate(`document.getElementById("find-duplicates").click()`);
  await waitFor(
    `document.querySelectorAll("#duplicates input[type=radio]").length > 0`,
    "duplicate report",
  );
  record("find duplicates", (await statusOf("duplicates-status")).text);

  record(
    "send disabled without a keeper",
    await evaluate(`document.getElementById("send-duplicates").disabled`),
  );

  await evaluate(`(() => {
    const rows = [...document.querySelectorAll("#duplicates li")];
    const row = rows.find((li) => li.textContent.includes(${JSON.stringify(`${TAG}-keep`)}));
    row.querySelector("input[type=radio]").click();
  })()`);
  record(
    "send enabled after picking a keeper",
    await evaluate(`!document.getElementById("send-duplicates").disabled`),
  );

  await evaluate(`document.getElementById("send-duplicates").click()`);
  await waitFor(
    `document.getElementById("duplicates-status").dataset.kind === "ok"`,
    "quarantine send",
  );
  record("send duplicates", (await statusOf("duplicates-status")).text);
  record("selection", (await statusOf("builder-status")).text);
  record(
    "the kept copy stayed out of the selection",
    await evaluate(
      `![...document.querySelectorAll("#builder-panel li")].some((li) => li.textContent.includes(${JSON.stringify(`${TAG}-keep`)}) && li.querySelector("input").checked)`,
    ),
  );
  // What a selection row actually reads like. The rows are built at runtime, so
  // nothing else in the suite ever sees the text the user is given.
  const row = await evaluate(`(() => {
    const li = document.querySelector("#builder-panel li");
    if (!li) return JSON.stringify({ found: false });
    const spans = li.querySelectorAll("label > span");
    const title = spans[0]?.innerText ?? "";
    const text = li.innerText;
    // The character immediately after the title decides whether the title and
    // the path read as two things. A CSS gap alone does not put one there.
    const boundary = text.slice(title.length, title.length + 1);
    return JSON.stringify({
      found: true,
      text,
      title,
      separated: spans.length > 1 && /\\s/.test(boundary),
    });
  })()`).then(JSON.parse);
  record("a selection row as rendered", JSON.stringify(row.text ?? ""));
  const rowReadable = row.found === true && row.separated === true;
  record("the row separates the title from the path", rowReadable);

  await evaluate(`document.getElementById("build-plan").click()`);
  await waitFor(
    `document.getElementById("builder-status").dataset.kind === "ok"`,
    "plan build",
  );
  record("build plan", (await statusOf("builder-status")).text);
  record("dry run", (await statusOf("plan-status")).text);

  // --- 4. prove the backup ---------------------------------------------------
  const doc = await page.send("DOM.getDocument");
  const input = await page.send("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector: "#backup-file",
  });
  await page.send("DOM.setFileInputFiles", {
    nodeId: input.nodeId,
    files: [snapshotFile],
  });
  await waitFor(
    `["ok","error"].includes(document.getElementById("apply-status").dataset.kind)`,
    "backup check",
  );
  record("verify backup", (await statusOf("apply-status")).text);

  // --- 5. apply --------------------------------------------------------------
  // The exact position, not just the parent: rollback restores `index` too, and
  // a verdict that only compares parents would pass a batch that came back to
  // the right folder in the wrong place. Read before anything moves.
  const positionsOf = (ids) =>
    evaluate(
      `chrome.bookmarks.get(${JSON.stringify(ids)}).then((nodes) => JSON.stringify(nodes.map((n) => ({ parentId: n.parentId, index: n.index }))))`,
    ).then(JSON.parse);
  const moved = [fixtures.dupA, fixtures.dupB];
  const before = await positionsOf(moved);
  record(
    "positions before apply",
    before.map((p) => `${p.parentId}:${p.index}`).join(" "),
  );

  record(
    "apply enabled",
    String(
      !(await evaluate(`document.getElementById("apply-moves").disabled`)),
    ),
  );
  await evaluate(`document.getElementById("apply-moves").click()`);
  await waitFor(
    `["ok","error"].includes(document.getElementById("apply-status").dataset.kind)`,
    "apply",
    120,
  );
  record("apply", (await statusOf("apply-status")).text);
  record(
    "the result names the destination folder",
    await evaluate(
      `document.getElementById("apply-result").innerText.includes(${JSON.stringify(`${TAG}-quarantine`)})`,
    ),
  );

  const afterApply = await evaluate(
    `chrome.bookmarks.get([${JSON.stringify(fixtures.dupA)}, ${JSON.stringify(fixtures.dupB)}, ${JSON.stringify(fixtures.keep)}]).then((nodes) => JSON.stringify(nodes.map((n) => n.parentId)))`,
  ).then(JSON.parse);
  record(
    "browser state after apply",
    `dupA=${afterApply[0]} dupB=${afterApply[1]} keep=${afterApply[2]} (dest=${fixtures.dest} src=${fixtures.src})`,
  );

  // --- 6. verify -------------------------------------------------------------
  // The status still carries the kind Apply wrote, so it has to be cleared
  // before the wait; otherwise the condition is already true and the next step
  // races the verify it claims to have observed.
  await actAndWait(
    "verify-result",
    "apply-status",
    `["ok","error"].includes(document.getElementById("apply-status").dataset.kind)`,
    "verify",
  );
  const verifyKind = await evaluate(
    `document.getElementById("apply-status").dataset.kind ?? ""`,
  );
  record(
    "verify",
    `kind=${verifyKind} — ${(await statusOf("apply-status")).text}`,
  );

  // --- 7. roll back ----------------------------------------------------------
  await actAndWait(
    "rollback-batch",
    "apply-status",
    `["ok","error"].includes(document.getElementById("apply-status").dataset.kind)`,
    "rollback",
    120,
  );
  const rollbackKind = await evaluate(
    `document.getElementById("apply-status").dataset.kind ?? ""`,
  );
  record(
    "rollback",
    `kind=${rollbackKind} — ${(await statusOf("apply-status")).text}`,
  );

  const restored = await positionsOf(moved);
  const positionsRestored = moved.every(
    (_, i) =>
      restored[i].parentId === before[i].parentId &&
      restored[i].index === before[i].index,
  );
  record(
    "positions after rollback",
    `${restored.map((p) => `${p.parentId}:${p.index}`).join(" ")} (expected ${before
      .map((p) => `${p.parentId}:${p.index}`)
      .join(" ")})`,
  );

  const afterRollback = await evaluate(
    `chrome.bookmarks.get([${JSON.stringify(fixtures.dupA)}, ${JSON.stringify(fixtures.dupB)}]).then((nodes) => JSON.stringify(nodes.map((n) => n.parentId)))`,
  ).then(JSON.parse);
  record(
    "browser state after rollback",
    `dupA=${afterRollback[0]} (src=${fixtures.src}) dupB=${afterRollback[1]} (src2=${fixtures.src2})`,
  );

  // --- 7.5 rename one bookmark and put the title back -------------------------
  // The only write that changes a node without moving it, so it is the only one
  // whose rollback cannot be judged by position. Driven through a plan file
  // because that is the only input route a rename has.
  await clickUntil(
    "load-tree",
    `document.getElementById("tree-status").dataset.kind === "ok"`,
    "tree reload before the rename run",
  );
  const renameTarget = await evaluate(
    `chrome.bookmarks.get(${JSON.stringify(fixtures.keep)}).then(([n]) =>
      JSON.stringify({ title: n.title, url: n.url, parentId: n.parentId, index: n.index })
    )`,
  ).then(JSON.parse);
  const renamedTitle = `${renameTarget.title} (renamed)`;
  // The root folder names are localized, so the path the plan has to match is
  // read out of the live tree instead of being spelled here.
  const renamePath = await evaluate(
    `(async () => {
      const path = [];
      let id = ${JSON.stringify(fixtures.keep)};
      while (id) {
        const [node] = await chrome.bookmarks.get(id);
        if (!node.parentId) break;
        path.unshift(node.title);
        id = node.parentId;
      }
      return JSON.stringify(path);
    })()`,
  ).then(JSON.parse);
  // Not in `downloads`: that directory is scanned for exported snapshots by
  // filename, and a plan file sitting there would be handed to the backup input.
  const renamePlan = join(profile, "pilot-rename-plan.json");
  writeFileSync(
    renamePlan,
    JSON.stringify(
      {
        version: 2,
        generatedAt: new Date().toISOString(),
        generatedBy: "pilot",
        operations: [
          {
            opId: "rename-0001",
            type: "update",
            bookmarkId: fixtures.keep,
            expectedTitle: renameTarget.title,
            expectedUrl: renameTarget.url,
            currentPath: renamePath,
            newTitle: renamedTitle,
            reason: "pilot rename round trip",
            confidence: 1,
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  const renameDoc = await page.send("DOM.getDocument");
  const planInput = await page.send("DOM.querySelector", {
    nodeId: renameDoc.root.nodeId,
    selector: "#plan-file",
  });
  await page.send("DOM.setFileInputFiles", {
    nodeId: planInput.nodeId,
    files: [renamePlan],
  });
  await waitFor(
    `["ok","warn","error"].includes(document.getElementById("plan-status").dataset.kind)`,
    "the rename plan to be read",
  );
  record("load rename plan", (await statusOf("plan-status")).text);

  await actAndWait(
    "dry-run",
    "plan-status",
    `["ok","warn","error"].includes(document.getElementById("plan-status").dataset.kind)`,
    "the rename Dry Run",
  );
  const renameDryRunKind = await evaluate(
    `document.getElementById("plan-status").dataset.kind ?? ""`,
  );
  record(
    "rename dry run",
    `kind=${renameDryRunKind} — ${(await statusOf("plan-status")).text}`,
  );

  let renameResult = `FAIL: the rename Dry Run came back "${renameDryRunKind}"`;
  if (renameDryRunKind === "ok") {
    const snapshots = () =>
      readdirSync(downloads)
        .filter((f) => f.startsWith("bookmark-snapshot") && f.endsWith(".json"))
        .sort();
    const renameSnapshotsBefore = snapshots().length;
    await evaluate(`document.getElementById("export-tree").click()`);
    let renameSnapshot = null;
    for (let i = 0; i < 40 && !renameSnapshot; i += 1) {
      const files = snapshots();
      if (files.length > renameSnapshotsBefore) {
        renameSnapshot = join(downloads, files[files.length - 1]);
      } else await sleep(250);
    }
    if (!renameSnapshot) throw new Error("no snapshot for the rename batch");
    const backupDoc = await page.send("DOM.getDocument");
    const backupInput = await page.send("DOM.querySelector", {
      nodeId: backupDoc.root.nodeId,
      selector: "#backup-file",
    });
    await page.send("DOM.setFileInputFiles", {
      nodeId: backupInput.nodeId,
      files: [renameSnapshot],
    });
    await waitFor(
      `["ok","error"].includes(document.getElementById("apply-status").dataset.kind)`,
      "the rename backup check",
    );
    record(
      "rename backup check",
      `kind=${await evaluate(`document.getElementById("apply-status").dataset.kind`)} — ${(await statusOf("apply-status")).text}`,
    );

    await actAndWait(
      "apply-moves",
      "apply-status",
      `["ok","warn","error"].includes(document.getElementById("apply-status").dataset.kind)`,
      "the rename apply",
    );
    const titleAfterApply = await evaluate(
      `chrome.bookmarks.get(${JSON.stringify(fixtures.keep)}).then(([n]) => JSON.stringify(n.title))`,
    ).then(JSON.parse);

    await actAndWait(
      "verify-result",
      "apply-status",
      `["ok","warn","error"].includes(document.getElementById("apply-status").dataset.kind)`,
      "the rename verify",
    );
    const renameVerifyKind = await evaluate(
      `document.getElementById("apply-status").dataset.kind ?? ""`,
    );

    await actAndWait(
      "rollback-batch",
      "apply-status",
      `["ok","warn","error"].includes(document.getElementById("apply-status").dataset.kind)`,
      "the rename rollback",
    );
    const renameRollbackKind = await evaluate(
      `document.getElementById("apply-status").dataset.kind ?? ""`,
    );
    const afterRename = await evaluate(
      `chrome.bookmarks.get(${JSON.stringify(fixtures.keep)}).then(([n]) =>
        JSON.stringify({ title: n.title, parentId: n.parentId, index: n.index })
      )`,
    ).then(JSON.parse);
    record(
      "rename round trip",
      `applied="${titleAfterApply}" verify=${renameVerifyKind} rollback=${renameRollbackKind} final="${afterRename.title}"`,
    );

    renameResult =
      titleAfterApply === renamedTitle &&
      renameVerifyKind === "ok" &&
      renameRollbackKind === "ok" &&
      afterRename.title === renameTarget.title &&
      afterRename.parentId === renameTarget.parentId &&
      afterRename.index === renameTarget.index
        ? "PASS: the bookmark was renamed, verified on its title, and the old title was put back without moving it"
        : `FAIL: applied="${titleAfterApply}" verify=${renameVerifyKind} rollback=${renameRollbackKind} final="${afterRename.title}" at ${afterRename.parentId}:${afterRename.index} (expected "${renameTarget.title}" at ${renameTarget.parentId}:${renameTarget.index})`;
  }
  record("rename result", renameResult);

  // --- 8. Trash: send a batch away and put it back ---------------------------
  // Stage 1 of the delete story. It has to be exact: the whole point of the
  // ledger is that a batch returns to the positions it left, not just to the
  // right folder.
  await clickUntil(
    "load-tree",
    `document.getElementById("tree-status").dataset.kind === "ok"`,
    "tree reload before the Trash run",
  );

  await evaluate(`(() => {
    const parent = document.getElementById("trash-parent");
    parent.value = ${JSON.stringify(roots.home.bar)};
    parent.dispatchEvent(new Event("change"));
    document.getElementById("trash-title").value = ${JSON.stringify(`${TAG}-trash`)};
  })()`);
  await actAndWait(
    "create-trash-folder",
    "trash-status",
    `document.getElementById("trash-status").dataset.kind === "ok" && document.getElementById("trash-folder").value !== ""`,
    "the Trash folder to be created and adopted",
  );
  const trashFolderId = await evaluate(
    `document.getElementById("trash-folder").value`,
  );
  createdIds.push(trashFolderId);
  record(
    "create trash folder",
    `${(await statusOf("trash-status")).text} id=${trashFolderId}`,
  );

  const beforeTrash = await positionsOf(moved);
  await evaluate(`(() => {
    const filter = document.getElementById("builder-filter");
    filter.value = ${JSON.stringify(`${TAG}-dup`)};
    filter.dispatchEvent(new Event("input"));
  })()`);
  await waitFor(
    `[...document.querySelectorAll("#builder-panel li")].filter((li) => li.textContent.includes(${JSON.stringify(`${TAG}-dup`)})).length >= 2`,
    "both duplicates in the builder",
  );
  // One at a time: every tick rebuilds the panel, so a list captured up front
  // would have its later rows clicked after they were detached.
  for (const marker of [`${TAG}-dup-a`, `${TAG}-dup-b`]) {
    await evaluate(`(() => {
      const li = [...document.querySelectorAll("#builder-panel li")]
        .find((node) => node.textContent.includes(${JSON.stringify(marker)}));
      const box = li && li.querySelector("input[type=checkbox]");
      if (box && !box.checked) box.click();
    })()`);
    await waitFor(
      `[...document.querySelectorAll("#builder-panel li")].some((li) => li.textContent.includes(${JSON.stringify(marker)}) && li.querySelector("input[type=checkbox]")?.checked)`,
      `${marker} to be selected`,
    );
  }
  await actAndWait(
    "send-to-trash",
    "trash-status",
    `document.getElementById("trash-status").dataset.kind === "ok" || document.getElementById("trash-status").dataset.kind === "error"`,
    "the Trash send",
  );
  record("send to trash", (await statusOf("trash-status")).text);

  const inTrash = await evaluate(
    `chrome.bookmarks.get(${JSON.stringify(moved)}).then((nodes) => JSON.stringify(nodes.map((n) => n.parentId)))`,
  ).then(JSON.parse);
  record(
    "browser state after the send",
    `${inTrash.join(" ")} (trash=${trashFolderId})`,
  );
  const receiptRows = await evaluate(
    `document.querySelectorAll("#trash-panel tbody tr").length`,
  );
  // The count alone would pass on rows about something else entirely.
  const receiptsNameBoth = await evaluate(
    `${JSON.stringify([`${TAG}-dup-a`, `${TAG}-dup-b`])}.every((title) => [...document.querySelectorAll("#trash-panel tbody tr")].some((row) => row.textContent.includes(title)))`,
  );
  record(
    "recovery records rendered",
    `${receiptRows} rows, both items named: ${receiptsNameBoth}`,
  );

  await actAndWait(
    "trash-restore-batch",
    "trash-status",
    `document.getElementById("trash-status").dataset.kind === "ok" || document.getElementById("trash-status").dataset.kind === "error"`,
    "the batch restore",
  );
  record("restore batch", (await statusOf("trash-status")).text);

  const afterTrash = await positionsOf(moved);
  const trashExact = moved.every(
    (_, i) =>
      afterTrash[i].parentId === beforeTrash[i].parentId &&
      afterTrash[i].index === beforeTrash[i].index,
  );
  record(
    "positions after the batch restore",
    `${afterTrash.map((p) => `${p.parentId}:${p.index}`).join(" ")} (expected ${beforeTrash
      .map((p) => `${p.parentId}:${p.index}`)
      .join(" ")})`,
  );

  // Nothing is left to put back, so the control that offers it must lock again.
  const restoreRelocked = await evaluate(
    `document.getElementById("trash-restore-batch").disabled`,
  );
  const trashResult =
    inTrash.every((parentId) => parentId === trashFolderId) &&
    receiptRows >= moved.length &&
    receiptsNameBoth &&
    trashExact &&
    restoreRelocked
      ? "PASS: the batch went to the Trash folder and came back to its exact positions"
      : `FAIL: inTrash=${inTrash.join(",")} rows=${receiptRows} named=${receiptsNameBoth} exact=${trashExact} relocked=${restoreRelocked}`;
  record("trash round trip", trashResult);

  // --- 9. delete for good ----------------------------------------------------
  // The irreversible path. One item goes back to Trash, a fresh backup is taken
  // and proven, and only then can the delete run.
  const doomed = moved[0];
  const survivor = moved[1];
  await evaluate(`(() => {
    const filter = document.getElementById("builder-filter");
    filter.value = ${JSON.stringify(`${TAG}-dup-a`)};
    filter.dispatchEvent(new Event("input"));
  })()`);
  await waitFor(
    `[...document.querySelectorAll("#builder-panel li")].some((li) => li.textContent.includes(${JSON.stringify(`${TAG}-dup-a`)}))`,
    "the item to delete",
  );
  await evaluate(`(() => {
    const li = [...document.querySelectorAll("#builder-panel li")]
      .find((node) => node.textContent.includes(${JSON.stringify(`${TAG}-dup-a`)}));
    const box = li && li.querySelector("input[type=checkbox]");
    if (box && !box.checked) box.click();
  })()`);
  await actAndWait(
    "send-to-trash",
    "trash-status",
    `document.getElementById("trash-status").dataset.kind === "ok" || document.getElementById("trash-status").dataset.kind === "error"`,
    "the second Trash send",
  );

  const snapshotsBefore = readdirSync(downloads).filter((f) =>
    f.endsWith(".json"),
  ).length;
  await evaluate(`document.getElementById("export-tree").click()`);
  let freshSnapshot = null;
  for (let i = 0; i < 40 && !freshSnapshot; i += 1) {
    const files = readdirSync(downloads)
      .filter((f) => f.endsWith(".json"))
      .sort();
    if (files.length > snapshotsBefore) {
      freshSnapshot = join(downloads, files[files.length - 1]);
    } else await sleep(250);
  }
  if (!freshSnapshot) throw new Error("no fresh snapshot was written");

  const freshDoc = await page.send("DOM.getDocument");
  const freshInput = await page.send("DOM.querySelector", {
    nodeId: freshDoc.root.nodeId,
    selector: "#backup-file",
  });
  await page.send("DOM.setFileInputFiles", {
    nodeId: freshInput.nodeId,
    files: [freshSnapshot],
  });
  await waitFor(
    `["ok","error"].includes(document.getElementById("apply-status").dataset.kind)`,
    "the fresh backup check",
  );
  record("verify fresh backup", (await statusOf("apply-status")).text);

  // The delete stays locked until the confirmation is ticked.
  const lockedWithoutConfirm = await evaluate(
    `document.getElementById("empty-trash").disabled`,
  );
  await evaluate(`(() => {
    const box = document.getElementById("empty-trash-confirm");
    box.checked = true;
    box.dispatchEvent(new Event("change"));
  })()`);
  // The box starts unchecked, so reading `false` after the run proves nothing on
  // its own. Prove it was armed — and the button unlocked — before the delete.
  const armedBeforeDelete = await evaluate(
    `JSON.stringify({
      checked: document.getElementById("empty-trash-confirm").checked,
      enabled: document.getElementById("empty-trash").disabled === false,
    })`,
  ).then(JSON.parse);
  record(
    "confirmation before the delete",
    `checked=${armedBeforeDelete.checked} button-enabled=${armedBeforeDelete.enabled}`,
  );
  await actAndWait(
    "empty-trash",
    "trash-status",
    `document.getElementById("trash-status").dataset.kind === "ok" || document.getElementById("trash-status").dataset.kind === "error"`,
    "the delete",
  );
  record("delete for good", (await statusOf("trash-status")).text);

  const presence = await evaluate(
    `Promise.all([${JSON.stringify(doomed)}, ${JSON.stringify(survivor)}].map((id) =>
      chrome.bookmarks.get(id).then(() => "present").catch(() => "gone")
    )).then((r) => JSON.stringify(r))`,
  ).then(JSON.parse);
  record(
    "browser state after the delete",
    `deleted=${presence[0]} untouched=${presence[1]}`,
  );

  // Named receipts, not "some receipt somewhere says deleted": an unrelated
  // leftover in the ledger would satisfy that and hide a delete that never ran.
  const receipts = await evaluate(
    `chrome.storage.local.get("trash-ledger").then((bag) =>
      JSON.stringify((bag["trash-ledger"]?.receipts ?? []).map((r) => ({
        receiptId: r.receiptId,
        bookmarkId: r.bookmarkId,
        state: r.state,
      })))
    )`,
  ).then(JSON.parse);
  record(
    "receipt states",
    receipts.map((r) => `${r.receiptId}=${r.state}`).join(", "),
  );

  // Both bookmarks were trashed and restored earlier, so each already has a
  // `restored` receipt. `find` would return that first one and read a correct
  // run as a failure; the receipt this step is about is the newest one.
  const latestReceiptFor = (bookmarkId) =>
    receipts.findLast((r) => r.bookmarkId === bookmarkId);
  const doomedReceipt = latestReceiptFor(doomed);
  const survivorReceipt = latestReceiptFor(survivor);
  const doomedReceiptDeleted = doomedReceipt?.state === "deleted";
  // The survivor's receipt must still exist and still say it was put back.
  // `state !== "deleted"` would also be satisfied by no receipt at all, which is
  // exactly the ledger loss this check is supposed to catch.
  const survivorReceiptIntact = survivorReceipt?.state === "restored";
  record(
    "receipt for the deleted item",
    `${doomedReceipt?.receiptId ?? "missing"} -> ${doomedReceipt?.state ?? "missing"}`,
  );
  record(
    "receipt for the untouched item",
    `${survivorReceipt?.receiptId ?? "missing"} -> ${survivorReceipt?.state ?? "missing"}`,
  );

  const confirmReset = await evaluate(
    `document.getElementById("empty-trash-confirm").checked === false`,
  );
  const deleteResult =
    lockedWithoutConfirm &&
    armedBeforeDelete.checked &&
    armedBeforeDelete.enabled &&
    presence[0] === "gone" &&
    presence[1] === "present" &&
    doomedReceiptDeleted &&
    survivorReceiptIntact &&
    confirmReset
      ? "PASS: one trashed bookmark was deleted, its own receipt says deleted, the other was untouched, and the confirmation reset"
      : `FAIL: locked=${lockedWithoutConfirm} armed=${armedBeforeDelete.checked} enabled=${armedBeforeDelete.enabled} deleted=${presence[0]} other=${presence[1]} doomedReceipt=${doomedReceipt?.state ?? "missing"} survivorReceipt=${survivorReceipt?.state ?? "missing"} reset=${confirmReset}`;
  record("delete for good result", deleteResult);

  // --- 10. the account/local boundary, only when the profile really has two ----
  // `roots.away` is a second store this run may write to. Managed roots are not
  // eligible for it: they always report `syncing:false`, so counting one would
  // let a single-store profile fake the whole case.
  boundaryDetail = `no second store materialised (observed ${roots.keys.join(", ") || "no boundary keys"})`;
  if (roots.away) {
    const crossTitle = `${TAG}-cross`;
    const cross = await evaluate(`(async () => {
      const mark = await chrome.bookmarks.create({
        parentId: ${JSON.stringify(roots.home.bar)},
        title: ${JSON.stringify(crossTitle)},
        url: "https://example.com/cross"
      });
      const target = await chrome.bookmarks.create({
        parentId: ${JSON.stringify(roots.away.any)},
        title: ${JSON.stringify(`${TAG}-cross-dest`)}
      });
      return JSON.stringify({ mark: mark.id, target: target.id });
    })()`).then(JSON.parse);
    createdIds.push(cross.mark, cross.target);
    record(
      "cross-boundary fixtures",
      `mark=${cross.mark} (${roots.home.key}) dest=${cross.target} (${roots.away.key})`,
    );

    // Where they were sent is not where they necessarily are. The flag the
    // extension keys on is read back off the two nodes, so a profile that
    // quietly put both in one store cannot be reported as a boundary test.
    const sides = await evaluate(
      `chrome.bookmarks.get(${JSON.stringify([cross.mark, cross.target])}).then((nodes) =>
        JSON.stringify(nodes.map((n) => (typeof n.syncing === "boolean" ? n.syncing : null)))
      )`,
    ).then(JSON.parse);
    const reallyCrosses =
      typeof sides[0] === "boolean" &&
      typeof sides[1] === "boolean" &&
      sides[0] !== sides[1];
    record(
      "the two fixtures sit on opposite sides",
      `source syncing=${sides[0]} destination syncing=${sides[1]} -> ${reallyCrosses}`,
    );

    await clickUntil(
      "load-tree",
      `document.getElementById("tree-status").dataset.kind === "ok"`,
      "tree reload for the boundary case",
    );
    await evaluate(`(() => {
      const dest = document.getElementById("builder-destination");
      dest.value = ${JSON.stringify(cross.target)};
      dest.dispatchEvent(new Event("change"));
      const filter = document.getElementById("builder-filter");
      filter.value = ${JSON.stringify(crossTitle)};
      filter.dispatchEvent(new Event("input"));
    })()`);
    await waitFor(
      `[...document.querySelectorAll("#builder-panel li")].some((li) => li.textContent.includes(${JSON.stringify(crossTitle)}))`,
      "the cross-boundary candidate",
    );
    await evaluate(`(() => {
      const rows = [...document.querySelectorAll("#builder-panel li")];
      const row = rows.find((li) => li.textContent.includes(${JSON.stringify(crossTitle)}));
      row.querySelector("input[type=checkbox]").click();
    })()`);
    await evaluate(`document.getElementById("build-plan").click()`);
    await waitFor(
      `document.getElementById("plan-status").dataset.kind !== undefined`,
      "the cross-boundary Dry Run",
    );

    // Asked through the agent entry point, so the answer is the structured one
    // the page gives an agent rather than something read back out of prose.
    const dry = await evaluate(
      `window.splendidBookmarks.run("dryRun").then((r) => JSON.stringify(r))`,
    ).then(JSON.parse);
    const statusKind = await evaluate(
      `document.getElementById("plan-status").dataset.kind ?? ""`,
    );
    const applyLocked = await evaluate(
      `document.getElementById("apply-moves").disabled`,
    );

    // The status cell is compared against the extension's own catalogue value
    // for `boundary-violation`, in every locale it ships. A translated string
    // spelled here would either pin the page's locale or quietly match any
    // other warning that happened to render.
    const shown = await evaluate(`(async () => {
      const { MESSAGES, SUPPORTED_LOCALES } = await import("/src/core/messages.js");
      const pick = (key) => SUPPORTED_LOCALES.map((l) => MESSAGES[l]?.[key]).filter(Boolean);
      const expected = pick("status.boundary-violation");
      const opIdHeaders = pick("dryRun.col.opId");
      // The panel also renders a two-column summary table. The operations table
      // is the one whose first header is the operation id column.
      const table = [...document.querySelectorAll("#dry-run-result table")].find((node) =>
        opIdHeaders.includes(node.querySelector("thead th")?.textContent ?? "")
      );
      const rows = table ? [...table.querySelectorAll("tbody tr")] : [];
      return JSON.stringify({
        table: Boolean(table),
        rows: rows.length,
        statuses: rows.map((row) => row.children[2]?.textContent ?? ""),
        texts: rows.map((row) => row.textContent ?? ""),
        expected,
      });
    })()`).then(JSON.parse);

    const statusCellMatches =
      shown.rows === 1 && shown.expected.includes(shown.statuses[0]);
    // Bound to this run: the row has to be about the bookmark this run created,
    // not a leftover row from an earlier step or another run's fixture.
    const rowNamesFixture =
      shown.rows === 1 && shown.texts[0].includes(crossTitle);

    record("cross-boundary dry run", (await statusOf("plan-status")).text);
    record(
      "cross-boundary evidence",
      `dryRun.ok=${dry.ok} approvable=${dry.state?.approvable} kind=${statusKind} rows=${shown.rows} status="${shown.statuses[0] ?? ""}" namesFixture=${rowNamesFixture} applyLocked=${applyLocked}`,
    );

    boundaryResult = reallyCrosses
      ? boundaryOutcome({
          pairFound: true,
          dryRunOk: dry.ok === true,
          approvable: dry.state?.approvable ?? null,
          statusKind,
          operationRows: shown.rows,
          statusCellMatches,
          rowNamesFixture,
          applyLocked,
        })
      : OUTCOME.FAIL;
    boundaryDetail = reallyCrosses
      ? `dryRun.ok=${dry.ok} approvable=${dry.state?.approvable} kind=${statusKind} rows=${shown.rows} statusMatches=${statusCellMatches} namesFixture=${rowNamesFixture} applyLocked=${applyLocked}`
      : `the two fixtures did not end up on opposite sides (${sides[0]} vs ${sides[1]}), so nothing crossed a boundary`;
  }
  record("account/local boundary", `${boundaryResult}: ${boundaryDetail}`);

  mainPass =
    afterApply[0] === fixtures.dest &&
    afterApply[1] === fixtures.dest &&
    // The copy the user chose to keep must not have moved.
    afterApply[2] === fixtures.src &&
    afterRollback[0] === fixtures.src &&
    afterRollback[1] === fixtures.src2 &&
    // The page has to agree, not just the tree: Verify and Rollback both report
    // failure as "error", and a verdict built only from parents would pass a
    // batch the extension itself said went wrong.
    verifyKind === "ok" &&
    rollbackKind === "ok" &&
    positionsRestored &&
    rowReadable &&
    trashResult.startsWith("PASS") &&
    deleteResult.startsWith("PASS") &&
    renameResult.startsWith("PASS") &&
    apiResult.startsWith("PASS");
} catch (error) {
  if (error instanceof PilotAbort) {
    aborted = true;
    failureReason = error.message;
  } else {
    record("error", error.message);
    failureReason = `the run threw before it finished (${error.message})`;
  }
} finally {
  // Cleanup runs here rather than at the end of the try. A failure halfway
  // through a signed-in run would otherwise leave this run's fixtures in the
  // account it was signed into.
  //
  // `removeTree` is the harness talking to the browser directly. The extension
  // itself still has no such call; tests/no-write-api.test.js scans `extension/`.
  if (evaluate) {
    try {
      // By id first, then by tag: a create whose response was lost over CDP
      // still made a node, and only the name can find that one again.
      const leftBehind = await evaluate(
        `(async () => {
          for (const id of ${JSON.stringify(createdIds)}) {
            try { await chrome.bookmarks.removeTree(id); } catch { /* already gone */ }
          }
          const tag = ${JSON.stringify(TAG)};
          const [root] = await chrome.bookmarks.getTree();
          const strays = [];
          const walk = (node) => {
            if ((node.title ?? "").startsWith(tag)) strays.push(node);
            for (const child of node.children ?? []) walk(child);
          };
          walk(root);
          for (const stray of strays) {
            try { await chrome.bookmarks.removeTree(stray.id); } catch { /* already gone */ }
          }
          const [after] = await chrome.bookmarks.getTree();
          const left = [];
          const check = (node) => {
            if ((node.title ?? "").startsWith(tag)) left.push(node.title);
            for (const child of node.children ?? []) check(child);
          };
          check(after);
          return JSON.stringify(left);
        })()`,
      ).then(JSON.parse);
      sweepOk = leftBehind.length === 0;
      record(
        "fixture cleanup",
        sweepOk
          ? `PASS: ${createdIds.length} fixture roots removed, nothing named ${TAG}* is left in the tree`
          : `FAIL: still present: ${leftBehind.join(", ")}`,
      );
    } catch (error) {
      sweepOk = false;
      record(
        "fixture cleanup",
        `FAIL: the sweep could not run (${error.message})`,
      );
    }
    if (SIGNIN_PAUSE) {
      // The harness can prove the local tree, never the account. Say so instead
      // of implying the test data is gone from the cloud.
      record(
        "sync cleanup",
        "deletions were made locally while signed in; whether they reached the account cannot be proven from here, so check the test account",
      );
    }
  } else {
    // The page was never driven, so this run created nothing to remove.
    sweepOk = true;
  }
  if (cleanup) {
    // A throwaway profile left on disk is a failure of this run, and after a
    // signed-in run it leaves credentials behind.
    cleaned = await cleanup();
    record("cleanup", `profile removed: ${cleaned}`);
  }
}

// A skipped case is not a passed case. The verdict has to carry it, because the
// exit code on its own reads as "the boundary was checked".
outcome = runOutcome({
  aborted,
  mainPass,
  boundary: boundaryResult,
  sweepOk,
  identityOk,
});
if (outcome === OUTCOME.ABORTED) {
  verdict = `PILOT ABORTED: ${failureReason}. No browser was launched and nothing was created.`;
} else if (outcome === OUTCOME.FAIL) {
  verdict = failureReason
    ? `PILOT FAIL: ${failureReason}`
    : "PILOT FAIL: see the recorded states above";
} else {
  const boundaryNote =
    boundaryResult === OUTCOME.PASS
      ? "the cross-boundary move was refused"
      : `the account/local boundary case was SKIPPED and is still unverified (${boundaryDetail})`;
  verdict = `PILOT PASS: both duplicates were quarantined and undone to their exact original positions, the kept copy never moved, one bookmark was renamed and the old title put back, the agent command API answered and refused through the page's own gates, a Trash batch was sent and put back exactly, one trashed bookmark was deleted for good while its neighbour was untouched, and ${boundaryNote}`;
}
record("verdict", verdict);

// Exit code contract: 0 only when the run passed, its throwaway profile was
// removed and, if the boundary was required, it was actually observed. Set
// after the cleanup ran; `process.exit()` inside the lifecycle would skip it.
process.exitCode = exitCodeFor(outcome, {
  boundary: boundaryResult,
  requireBoundary: REQUIRE_BOUNDARY,
  cleaned,
});
