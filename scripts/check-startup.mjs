import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  watch,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { MESSAGES } from "../extension/src/core/messages.js";
import {
  ROOT,
  launchPilotBrowser,
  makeRecorder,
  makeWaiter,
} from "./lib/pilot-browser.mjs";

const { record } = makeRecorder();
const session = await launchPilotBrowser({
  work: join(ROOT, "tmp", "startup-check"),
  record,
  sync: false,
});
let passed = false;
let cancelDownloadWait = () => {};
try {
  const { page, evaluate, downloads } = session;
  const waitFor = makeWaiter(evaluate);
  const ready = `typeof window.splendidBookmarks?.run === "function" &&
    !document.getElementById("load-tree").disabled &&
    document.getElementById("tree-status").dataset.kind === "ok"`;
  await waitFor(ready, "automatic initial tree load");
  const emptyStats = await evaluate(`window.splendidBookmarks.run("getStats")`);
  assert.equal(emptyStats.ok, true);
  assert.equal(emptyStats.state.bookmarks, 0);
  assert.equal(readdirSync(downloads).length, 0);
  record(
    "first open",
    "Agent API ready without clicking Load tree or exporting a backup",
  );

  for (const locale of ["en", "ja"]) {
    const rendered = await evaluate(`(() => {
      const control = document.getElementById("ui-locale");
      control.value = ${JSON.stringify(locale)};
      control.dispatchEvent(new Event("change", { bubbles: true }));
      const heading = document.querySelector('[data-i18n="section.agent.title"]');
      const note = document.querySelector('[data-i18n="section.agent.note"]');
      return {
        heading: heading.textContent,
        note: note.textContent,
        rendered: heading.getBoundingClientRect().height > 0 && note.getBoundingClientRect().height > 0,
        description: chrome.runtime.getManifest().description,
      };
    })()`);
    assert.equal(rendered.heading, MESSAGES[locale]["section.agent.title"]);
    assert.equal(rendered.note, MESSAGES[locale]["section.agent.note"]);
    assert.equal(rendered.rendered, true);
    assert.ok(
      [
        MESSAGES.en.extensionDescription,
        MESSAGES.ja.extensionDescription,
      ].includes(rendered.description),
    );
  }
  record(
    "agent-first copy",
    "English/Japanese plan-file headings and API notes rendered; packaged summary matches",
  );

  const captures = join(ROOT, "tmp", "agent-ux-captures");
  mkdirSync(captures, { recursive: true });
  for (const [locale, width, height, theme] of [
    ["en", 1280, 800, "light"],
    ["ja", 390, 844, "dark"],
    ["en", 320, 568, "light"],
    ["ja", 320, 568, "dark"],
  ]) {
    await page.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: theme }],
    });
    await page.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const layout = await evaluate(`(() => {
      const locale = document.getElementById("ui-locale");
      locale.value = ${JSON.stringify(locale)};
      locale.dispatchEvent(new Event("change", { bubbles: true }));
      window.scrollTo(0, 0);
      const button = document.getElementById("copy-agent-prompt");
      const bounds = button.getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom, height: innerHeight,
        disabled: button.disabled,
        overflow: document.documentElement.scrollWidth > innerWidth,
        prompt: document.getElementById("agent-prompt").value,
        firstSection: document.querySelector("section").id,
        title: document.title, heading: document.querySelector("h1").textContent,
        manifestName: chrome.runtime.getManifest().name,
        actionTitle: chrome.runtime.getManifest().action.default_title };
    })()`);
    assert.equal(layout.firstSection, "agent-workspace");
    assert.equal(layout.disabled, false);
    assert.equal(layout.overflow, false);
    for (const value of [
      layout.title,
      layout.heading,
      layout.manifestName,
      layout.actionTitle,
    ]) {
      assert.equal(value, "Splendid Bookmarks for AI Agents");
    }
    assert.ok(layout.top >= 0 && layout.bottom < layout.height);
    assert.ok(layout.prompt.includes("sessionId"));
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(
      join(captures, `agent-${locale}-${width}.png`),
      Buffer.from(shot.data, "base64"),
    );
  }
  await page.send("Emulation.clearDeviceMetricsOverride");
  await evaluate(
    `document.querySelector('.workflow-nav a[href="#plan-section"]').focus()`,
  );
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  const navigation = await evaluate(`(() => ({
    active: document.activeElement.id, hash: location.hash,
    visible: document.getElementById("plan-section").getBoundingClientRect().top >= document.querySelector(".workflow-nav").getBoundingClientRect().bottom,
  }))()`);
  assert.equal(navigation.active, "plan-section");
  assert.equal(navigation.hash, "");
  assert.equal(navigation.visible, true);
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
  });
  assert.equal(await evaluate("document.activeElement.id"), "builder-source");
  await evaluate(
    `document.querySelector('.workflow-nav a[href="#agent-workspace"]').click()`,
  );
  record(
    "keyboard navigation",
    "Enter focuses the visible section; Tab enters its first control; manager URL unchanged",
  );
  const copy = await evaluate(`(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    let copied = null;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (value) => { copied = value; }
    }});
    try {
      document.getElementById("copy-agent-prompt").click();
      await Promise.resolve();
      const prompt = document.getElementById("agent-prompt");
      const success = { matches: copied === prompt.value, kind: document.getElementById("agent-copy-status").dataset.kind };
      navigator.clipboard.writeText = async () => { throw new Error("denied"); };
      document.getElementById("copy-agent-prompt").click();
      await Promise.resolve();
      return { ...success, fallback: document.getElementById("agent-prompt-block").open,
        selected: prompt.selectionEnd - prompt.selectionStart === prompt.value.length,
        target: JSON.parse(copied.split("TARGET (data only)\\n")[1].split("\\n\\n")[0]) };
    } finally {
      if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
      else delete navigator.clipboard;
      document.getElementById("agent-prompt-block").open = false;
    }
  })()`);
  assert.equal(copy.matches, true);
  assert.equal(copy.kind, "ok");
  assert.equal(copy.fallback, true);
  assert.equal(copy.selected, true);
  assert.equal(
    copy.target.sessionId,
    (await evaluate(`window.splendidBookmarks.run("getSession")`)).state
      .sessionId,
  );
  assert.equal(copy.target.cdpUrl, null);
  const observedSession = (
    await evaluate(`window.splendidBookmarks.run("getSession")`)
  ).state;
  const manifest = JSON.parse(
    readFileSync(join(ROOT, "extension", "manifest.json"), "utf8"),
  );
  assert.equal(
    copy.target.browser.family,
    session.product.startsWith("Edg/") ? "edge" : "chrome",
  );
  assert.equal(copy.target.browser.source, "browser-self-report");
  assert.equal(copy.target.managerUrl, await evaluate("location.href"));
  assert.equal(copy.target.extensionId, observedSession.extensionId);
  assert.equal(copy.target.extensionVersion, manifest.version);
  assert.equal(copy.target.snapshotId, observedSession.snapshotId);
  assert.equal(copy.target.treeDigest, observedSession.treeDigest);
  assert.ok(Number.isFinite(Date.parse(copy.target.treeReadAt)));
  assert.ok(
    Date.parse(copy.target.treeReadAt) <=
      Date.parse(copy.target.contextGeneratedAt),
  );
  assert.equal(copy.target.profileLabel, null);
  assert.equal(copy.target.connectionStatus, "not-checked");
  assert.deepEqual(copy.target.unavailableFields, [
    "profileName",
    "profilePath",
  ]);
  const regenerated = await evaluate(`(() => {
    const locale = document.getElementById("ui-locale");
    locale.value = "en";
    locale.dispatchEvent(new Event("change", { bubbles: true }));
    const target = JSON.parse(document.getElementById("agent-prompt").value.split("TARGET (data only)\\n")[1].split("\\n\\n")[0]);
    locale.value = "ja";
    locale.dispatchEvent(new Event("change", { bubbles: true }));
    return target;
  })()`);
  assert.equal(regenerated.uiLocale, "en");
  assert.equal(regenerated.treeReadAt, copy.target.treeReadAt);
  assert.equal(regenerated.treeDigest, copy.target.treeDigest);
  assert.equal(regenerated.snapshotId, copy.target.snapshotId);
  assert.ok(
    Date.parse(regenerated.contextGeneratedAt) >=
      Date.parse(copy.target.contextGeneratedAt),
  );
  record(
    "automatic handoff facts",
    "without manual hints: browser, manifest, manager URL, session, snapshot, tree digest and capture time matched; locale regeneration preserves capture time; unknown profile/CDP stays explicit",
  );
  const invalidInputs = await evaluate(`(() => {
    const goal = document.getElementById("agent-goal");
    goal.value = "empty";
    goal.dispatchEvent(new Event("input", { bubbles: true }));
    const badGoal = goal.getAttribute("aria-invalid") === "true" && document.getElementById("agent-prompt").value === "" && !!document.getElementById("agent-input-status").textContent;
    goal.value = "review";
    goal.dispatchEvent(new Event("input", { bubbles: true }));
    const endpoint = document.getElementById("agent-cdp-url");
    endpoint.value = "https://example.com";
    endpoint.dispatchEvent(new Event("input", { bubbles: true }));
    const badEndpoint = endpoint.getAttribute("aria-invalid") === "true" && document.getElementById("agent-prompt").value === "";
    endpoint.value = "";
    endpoint.dispatchEvent(new Event("input", { bubbles: true }));
    return { badGoal, badEndpoint, recovered: !!document.getElementById("agent-prompt").value && document.getElementById("agent-input-status").textContent === "" };
  })()`);
  assert.deepEqual(invalidInputs, {
    badGoal: true,
    badEndpoint: true,
    recovered: true,
  });
  record(
    "agent copy UX",
    "desktop/mobile first viewport; localized prompt; clipboard adapter success/failure; target session matched; captures in tmp/agent-ux-captures",
  );

  await evaluate(`(async () => {
    const [root] = await chrome.bookmarks.getTree();
    const parent = root.children.find((node) => !node.unmodifiable && !node.url);
    if (!parent) throw new Error("No writable fixture root");
    const folder = await chrome.bookmarks.create({ parentId: parent.id, title: "Startup test" });
    for (let index = 0; index < 627; index += 1) {
      await chrome.bookmarks.create({
        parentId: folder.id,
        title: "Startup bookmark " + index,
        url: "https://example.com/startup/" + index,
      });
    }
  })()`);
  const baseline = await evaluate(
    `chrome.bookmarks.getTree().then(JSON.stringify)`,
  );
  await page.send("Page.enable");
  const probeSource = (failFirst) => `(() => {
    const probe = window.__startupProbe = { reads: 0, writes: [], release: null };
    const originalRead = chrome.bookmarks.getTree.bind(chrome.bookmarks);
    chrome.bookmarks.getTree = async (...args) => {
      probe.reads += 1;
      if (${failFirst} && probe.reads === 1) throw new Error("Injected startup read failure");
      const result = await originalRead(...args);
      if (!${failFirst} && probe.reads === 1) {
        await new Promise((resolve) => { probe.release = resolve; });
      }
      return result;
    };
    for (const method of ["create", "move", "update", "remove", "removeTree"]) {
      chrome.bookmarks[method] = () => {
        probe.writes.push(method);
        throw new Error("Unexpected bookmark write: " + method);
      };
    }
  })()`;
  const probe = await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: probeSource(false),
  });
  await page.send("Page.reload");
  await waitFor(
    `!!window.__startupProbe?.release && typeof window.splendidBookmarks?.run === "function"`,
    "pending startup read",
  );
  const loading = await evaluate(`(async () => {
    document.getElementById("ui-locale").focus();
    return {
      session: await window.splendidBookmarks.run("getSession"),
      stats: await window.splendidBookmarks.run("getStats"),
      apply: await window.splendidBookmarks.run("apply"),
      loadDisabled: document.getElementById("load-tree").disabled,
      readiness: document.getElementById("agent-readiness").textContent,
    };
  })()`);
  assert.equal(loading.stats.error?.key, "agent.error.noTree");
  assert.equal(loading.session.ok, true);
  assert.equal(loading.session.state.ready, false);
  assert.equal(loading.session.state.loading, true);
  assert.equal(loading.apply.error?.key, "agent.error.notReady");
  assert.equal(loading.loadDisabled, true);
  assert.equal(loading.readiness, MESSAGES.ja["agent.ready.loading"]);
  await evaluate(`window.__startupProbe.release()`);
  await waitFor(ready, "automatic populated tree load");
  const loaded = await evaluate(`(async () => ({
    stats: await window.splendidBookmarks.run("getStats"),
    tree: await window.splendidBookmarks.run("getTree"),
    apply: await window.splendidBookmarks.run("apply"),
    active: document.activeElement.id,
    reads: window.__startupProbe.reads,
    writes: window.__startupProbe.writes,
  }))()`);
  assert.equal(loaded.stats.ok, true);
  assert.equal(loaded.stats.state.bookmarks, 627);
  assert.equal(loaded.stats.state.backupVerified, false);
  assert.equal(loaded.stats.state.hasPlan, false);
  assert.equal(loaded.tree.ok, true);
  assert.ok(loaded.tree.state.total > loaded.tree.state.shown.length);
  assert.equal(loaded.tree.state.shown.length, 500);
  assert.equal(loaded.apply.error?.key, "agent.error.notReady");
  assert.equal(loaded.active, "ui-locale");
  assert.equal(loaded.reads, 1);
  assert.deepEqual(loaded.writes, []);
  assert.ok(
    loaded.tree.state.shown.every(
      (entry) =>
        "boundary" in entry && "unmodifiable" in entry && "isFolder" in entry,
    ),
  );
  assert.equal(readdirSync(downloads).length, 0);
  assert.equal(
    await evaluate(`chrome.bookmarks.getTree().then(JSON.stringify)`),
    baseline,
  );
  record(
    "populated startup",
    "627 bookmarks; one automatic read; focus retained; no writes/downloads; Apply locked",
  );
  const refreshFailure = await evaluate(`(async () => {
    const before = await window.splendidBookmarks.run("getSession");
    const scope = document.getElementById("agent-scope");
    const replace = scope.replaceChildren;
    let failed;
    try {
      scope.replaceChildren = () => { throw new Error("Injected render failure after tree commit"); };
      failed = await window.splendidBookmarks.run("refreshTree");
    } finally {
      scope.replaceChildren = replace;
    }
    const after = await window.splendidBookmarks.run("getSession");
    const recovered = await window.splendidBookmarks.run("refreshTree");
    return { before, failed, after, recovered };
  })()`);
  assert.equal(refreshFailure.failed.ok, false);
  assert.equal(refreshFailure.failed.error.key, "agent.error.refreshFailed");
  assert.notEqual(
    refreshFailure.after.state.snapshotId,
    refreshFailure.before.state.snapshotId,
  );
  assert.equal(refreshFailure.after.state.treeStatus.kind, "error");
  assert.equal(refreshFailure.recovered.ok, true);
  record(
    "refresh failure contract",
    "failure after generation commit is rejected; next explicit refresh recovers",
  );

  const planRace = await evaluate(`(async () => {
    const originalRead = FileReader.prototype.readAsText;
    let release;
    let finishUi;
    const uiDone = new Promise((resolve) => { finishUi = resolve; });
    FileReader.prototype.readAsText = function(file) {
      if (file.name === "agent-plan.json") {
        release = () => originalRead.call(this, file);
      } else {
        this.addEventListener("loadend", () => finishUi(), { once: true });
        originalRead.call(this, file);
      }
    };
    try {
      const pending = window.splendidBookmarks.run("loadPlan", { plan: { version: 2, notes: "API request", operations: [] } });
      if (!release) throw new Error("API file read did not start");
      const transfer = new DataTransfer();
      transfer.items.add(new File([JSON.stringify({ version: 2, notes: "UI replacement", operations: [] })], "ui-plan.json", { type: "application/json" }));
      const input = document.getElementById("plan-file");
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await uiDone;
      release();
      return await pending;
    } finally {
      FileReader.prototype.readAsText = originalRead;
    }
  })()`);
  assert.equal(planRace.ok, false);
  assert.equal(planRace.error.key, "agent.error.superseded");
  await waitFor(
    `document.getElementById("plan-status").dataset.kind === "ok"`,
    "UI replacement plan accepted",
  );
  await evaluate(`window.splendidBookmarks.run("dryRun")`);
  assert.ok(
    await evaluate(
      `document.getElementById("dry-run-result").textContent.includes("UI replacement")`,
    ),
  );
  assert.deepEqual(await evaluate("window.__startupProbe.writes"), []);
  record(
    "plan load race",
    "UI replacement retained; superseded API request rejected; no bookmark writes",
  );
  const search = await evaluate(`(async () => {
    let cursor;
    const ids = [];
    do {
      const result = await window.splendidBookmarks.run("search", {
        query: "Startup bookmark", ...(cursor ? { cursor } : {}),
      });
      if (!result.ok) throw new Error(result.error.key);
      ids.push(...result.state.shown.map((entry) => entry.id));
      cursor = result.state.nextCursor;
    } while (cursor);
    return { count: ids.length, unique: new Set(ids).size };
  })()`);
  assert.equal(search.count, 627);
  assert.equal(search.unique, 627);
  const originalCursor = loaded.tree.state.nextCursor;
  assert.ok(originalCursor);
  const refresh = await evaluate(`window.splendidBookmarks.run("refreshTree")`);
  assert.equal(refresh.ok, true);
  await waitFor(ready, "manual refresh before stale cursor check");
  const stale = await evaluate(
    `window.splendidBookmarks.run("getTree", { cursor: ${JSON.stringify(originalCursor)} })`,
  );
  assert.equal(stale.error?.key, "agent.error.staleCursor");
  record(
    "pagination",
    "all search results retrieved; old cursor rejected after tree refresh",
  );

  const proposal = await evaluate(`(async () => {
    const tree = (await window.splendidBookmarks.run("getTree")).state.shown;
    const bookmark = tree.find((entry) => !entry.isFolder);
    const folder = tree.find((entry) => entry.isPermanentRoot && entry.boundary === bookmark.boundary && !entry.unmodifiable);
    const plan = { version: 2, operations: [{ opId: "proposal-1", type: "move", bookmarkId: bookmark.id,
      expectedTitle: bookmark.title, expectedUrl: bookmark.url, currentPath: bookmark.path,
      destinationPath: folder.path, destinationFolderId: folder.id, reason: "Test proposal", confidence: 1 }] };
    const loaded = await window.splendidBookmarks.run("loadPlan", { plan });
    const checked = await window.splendidBookmarks.run("dryRun");
    const denied = await window.splendidBookmarks.run("apply", { planDigest: loaded.state.planDigest });
    return { loaded, checked, denied, writes: window.__startupProbe.writes };
  })()`);
  assert.equal(proposal.loaded.state.accepted, true);
  assert.equal(proposal.checked.state.approvable, true);
  assert.equal(proposal.checked.state.rows[0].status, "movable");
  assert.equal(
    proposal.checked.state.planDigest,
    proposal.loaded.state.planDigest,
  );
  assert.equal(proposal.denied.error?.key, "agent.error.notReady");
  assert.deepEqual(proposal.writes, []);
  record(
    "API proposal",
    "metadata-only move plan accepted; detailed Dry Run; Apply blocked without backup; zero bookmark writes",
  );

  const compact = await evaluate(`(async () => {
    const run = (command, input) => window.splendidBookmarks.run(command, input);
    const session = (await run("getSession")).state;
    const tree = (await run("getTree")).state.shown;
    const bookmark = tree.find((entry) => !entry.isFolder);
    const folder = tree.find((entry) => entry.isPermanentRoot && entry.boundary === bookmark.boundary && !entry.unmodifiable);
    const input = { snapshotId: session.snapshotId, scopeFolderId: session.scopeFolderId,
      moves: [{ bookmarkId: bookmark.id, destinationFolderId: folder.id, reason: "Test proposal" }] };
    const legacyInput = { plan: { version: 2, operations: [{ opId: "agent-0001", type: "move", bookmarkId: bookmark.id,
      expectedTitle: bookmark.title, expectedUrl: bookmark.url, currentPath: bookmark.path,
      destinationPath: folder.path, destinationFolderId: folder.id, reason: "Test proposal", confidence: 1 }] } };
    const legacyLoaded = await run("loadPlan", legacyInput);
    const legacyChecked = await run("dryRun");
    const prepared = await run("preparePlan", input);
    const stats = await run("getStats");
    const duplicate = await run("preparePlan", { ...input, moves: [...input.moves, ...input.moves] });
    const afterRefusal = await run("getStats");
    const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
    await run("refreshTree");
    const stale = await run("preparePlan", input);
    return { prepared, legacyChecked, duplicate, stats, afterRefusal, stale, writes: window.__startupProbe.writes,
      bytes: { legacyInput: bytes(legacyInput), compactInput: bytes(input),
        legacyOutput: bytes(legacyLoaded) + bytes(legacyChecked), compactOutput: bytes(prepared) } };
  })()`);
  assert.equal(compact.prepared.ok, true);
  assert.equal(compact.prepared.state.accepted, true);
  assert.equal(compact.prepared.state.approvable, true);
  assert.deepEqual(
    compact.prepared.state.rows,
    compact.legacyChecked.state.rows,
  );
  assert.equal(compact.duplicate.state.accepted, false);
  assert.equal(compact.duplicate.state.rows.length, 2);
  assert.equal(
    compact.stats.state.planDigest,
    compact.afterRefusal.state.planDigest,
  );
  assert.equal(compact.stale.error.key, "agent.error.staleProposal");
  assert.deepEqual(compact.writes, []);
  assert.deepEqual(compact.bytes, {
    legacyInput: 359,
    compactInput: 156,
    legacyOutput: 1010,
    compactOutput: 768,
  });
  record(
    "compact proposal",
    `same fixture and identical Dry Run rows; preparePlan=1 call vs loadPlan+dryRun=2; UTF-8 JSON bytes ${JSON.stringify(compact.bytes)}; actual tokens not measured; zero writes`,
  );

  const execute = promisify(execFile);
  const extensionId = await evaluate("location.host");
  const cliArgs = [
    join(ROOT, "scripts", "bookmark-inventory.mjs"),
    "--cdp-url",
    `http://127.0.0.1:${session.port}`,
    "--extension-id",
    extensionId,
  ];
  const cli = async (args) => {
    const { stdout } = await execute(process.execPath, [...cliArgs, ...args], {
      timeout: 20000,
    });
    return JSON.parse(stdout);
  };
  const candidates = await cli(["--list"]);
  assert.equal(candidates.candidates.length, 1);
  const selected = candidates.candidates[0];
  assert.equal(selected.ready, true);
  assert.equal(selected.bookmarks, 627);
  const output = join(session.profile, "inventory-test.json");
  const collectArgs = [
    "--target-id",
    selected.targetId,
    "--session-id",
    selected.sessionId,
    "--label",
    "startup-test",
    "--output",
    output,
  ];
  const summary = await cli(collectArgs);
  assert.equal(summary.bookmarks, 627);
  assert.equal(summary.label, "startup-test");
  const savedText = readFileSync(output, "utf8");
  const saved = JSON.parse(savedText);
  assert.equal(saved.total, loaded.tree.state.total);
  assert.equal(saved.entries.length, saved.total);
  assert.equal(
    new Set(saved.entries.map((entry) => entry.id)).size,
    saved.total,
  );
  assert.equal(saved.session.sessionId, selected.sessionId);
  await assert.rejects(cli(collectArgs), /EEXIST/);
  assert.equal(readFileSync(output, "utf8"), savedText);
  assert.deepEqual(await evaluate("window.__startupProbe.writes"), []);
  assert.equal(readdirSync(downloads).length, 0);
  record(
    "inventory CLI",
    "explicit target/session/label; full JSON read-back; existing output preserved",
  );

  await page.send("Page.removeScriptToEvaluateOnNewDocument", {
    identifier: probe.identifier,
  });
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: probeSource(true),
  });
  await page.send("Page.reload");
  await waitFor(
    `document.getElementById("tree-status")?.dataset.kind === "error" &&
    !document.getElementById("load-tree").disabled`,
    "failed startup with retry enabled",
  );
  const failed = await evaluate(`window.splendidBookmarks.run("getStats")`);
  assert.equal(failed.error?.key, "agent.error.noTree");
  assert.equal(
    await evaluate(`document.getElementById("agent-readiness").dataset.kind`),
    "error",
  );
  assert.equal(await evaluate(`window.__startupProbe.reads`), 1);
  await evaluate(`document.getElementById("load-tree").click()`);
  await waitFor(ready, "manual retry after startup failure");
  const retried = await evaluate(`window.splendidBookmarks.run("getStats")`);
  assert.equal(retried.ok, true);
  assert.equal(retried.state.bookmarks, 627);
  assert.equal(await evaluate(`window.__startupProbe.reads`), 2);
  assert.deepEqual(await evaluate(`window.__startupProbe.writes`), []);
  assert.equal(readdirSync(downloads).length, 0);
  assert.equal(
    await evaluate(`chrome.bookmarks.getTree().then(JSON.stringify)`),
    baseline,
  );
  record(
    "failure recovery",
    "error shown; manual retry succeeds; no automatic retry or bookmark changes",
  );
  await assert.rejects(
    cli([
      "--target-id",
      selected.targetId,
      "--session-id",
      selected.sessionId,
      "--label",
      "stale-test",
    ]),
    /Session mismatch/,
  );
  record(
    "connection guard",
    "CLI refuses a session id from before the page reload",
  );

  const scopeRecovery = await evaluate(`(async () => {
    const tree = (await window.splendidBookmarks.run("getTree")).state.shown;
    const folder = tree.find((entry) => entry.isFolder && !entry.isPermanentRoot && entry.parentId !== null);
    const scope = document.getElementById("agent-scope");
    scope.value = folder.id;
    scope.dispatchEvent(new Event("change", { bubbles: true }));
    const originalRead = chrome.bookmarks.getTree;
    try {
      chrome.bookmarks.getTree = async () => {
        const roots = await originalRead();
        const prune = (node) => { if (node.children) { node.children = node.children.filter((child) => child.id !== folder.id); node.children.forEach(prune); } };
        roots.forEach(prune);
        return roots;
      };
      const refreshed = await window.splendidBookmarks.run("refreshTree");
      if (!refreshed.ok) throw new Error(refreshed.error.key);
      const missing = { id: scope.value, copyDisabled: document.getElementById("copy-agent-prompt").disabled,
        exportDisabled: document.getElementById("export-agent-context").disabled,
        preview: document.getElementById("agent-prompt").value,
        status: document.getElementById("agent-readiness").textContent };
      scope.value = "";
      scope.dispatchEvent(new Event("change", { bubbles: true }));
      return { missing, expectedId: folder.id, recovered: !document.getElementById("copy-agent-prompt").disabled };
    } finally {
      chrome.bookmarks.getTree = originalRead;
      await window.splendidBookmarks.run("refreshTree");
    }
  })()`);
  assert.equal(scopeRecovery.missing.id, scopeRecovery.expectedId);
  assert.equal(scopeRecovery.missing.copyDisabled, true);
  assert.equal(scopeRecovery.missing.exportDisabled, true);
  assert.equal(scopeRecovery.missing.preview, "");
  assert.equal(
    scopeRecovery.missing.status,
    MESSAGES.ja["agent.scope.missing"],
  );
  assert.equal(scopeRecovery.recovered, true);
  assert.deepEqual(await evaluate("window.__startupProbe.writes"), []);
  assert.equal(
    await evaluate(`chrome.bookmarks.getTree().then(JSON.stringify)`),
    baseline,
  );
  record(
    "missing scope recovery",
    "virtual missing folder remains selected; handoff blocked; explicit reselection recovers; live bookmarks unchanged",
  );

  await evaluate(
    `window.splendidBookmarks.run("loadPlan", { plan: { version: 2, operations: [] } })`,
  );
  await evaluate(`window.splendidBookmarks.run("dryRun")`);
  const beforeBackup = await evaluate(
    `window.splendidBookmarks.run("getStats")`,
  );
  const downloadReady = new Promise((resolve, reject) => {
    let watcher;
    let deadline;
    let settled = false;
    const finish = (error, filename) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      watcher?.close();
      if (error) reject(error);
      else resolve(filename);
    };
    cancelDownloadWait = () =>
      finish(new Error("backup download wait cancelled"));
    watcher = watch(downloads, () => {
      let filename;
      try {
        filename = readdirSync(downloads).find((name) =>
          name.endsWith(".json"),
        );
        if (!filename) return;
        JSON.parse(readFileSync(join(downloads, filename), "utf8"));
      } catch (error) {
        if (!(error instanceof SyntaxError)) finish(error);
        return;
      }
      finish(null, filename);
    });
    watcher.on("error", (error) => finish(error));
    deadline = setTimeout(() => {
      finish(new Error("backup download did not reach disk"));
    }, 10000);
  });
  void downloadReady.catch(() => {});
  await evaluate(`document.getElementById("quick-start").click()`);
  await waitFor(
    `document.getElementById("tree-status").dataset.kind === "ok" && document.getElementById("tree-status").textContent.includes("sha256")`,
    "backup saved without reloading",
  );
  const afterBackup = await evaluate(
    `window.splendidBookmarks.run("getStats")`,
  );
  assert.equal(afterBackup.state.snapshotId, beforeBackup.state.snapshotId);
  assert.equal(afterBackup.state.planDigest, beforeBackup.state.planDigest);
  assert.equal(afterBackup.state.hasPlan, true);
  assert.equal(afterBackup.state.backupVerified, false);
  await downloadReady;
  assert.equal(readdirSync(downloads).length, 1);
  assert.deepEqual(await evaluate("window.__startupProbe.writes"), []);
  record(
    "backup UX",
    "saved snapshot without invalidating plan/tree; backup verification still required; no writes",
  );
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 280,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const popupUrl = await evaluate(`new URL("popup.html", location.href).href`);
  for (const locale of ["en", "ja"]) {
    await evaluate(
      `localStorage.setItem("agbm.ui-locale", ${JSON.stringify(locale)})`,
    );
    await page.send("Page.navigate", { url: popupUrl });
    await waitFor(
      `document.readyState === "complete" && document.documentElement.lang === ${JSON.stringify(locale)} && !!document.getElementById("open-manager")`,
      "localized popup",
    );
    const popup = await evaluate(`(() => {
      const heading = document.querySelector("h1");
      const button = document.getElementById("open-manager");
      return { title: document.title, heading: heading.textContent,
        overflow: document.documentElement.scrollWidth > innerWidth,
        separated: heading.getBoundingClientRect().bottom <= button.getBoundingClientRect().top,
        buttonVisible: button.getBoundingClientRect().bottom <= innerHeight };
    })()`);
    assert.equal(popup.title, "Splendid Bookmarks for AI Agents");
    assert.equal(popup.heading, popup.title);
    assert.equal(popup.overflow, false);
    assert.equal(popup.separated, true);
    assert.equal(popup.buttonVisible, true);
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(
      join(captures, `popup-${locale}-280.png`),
      Buffer.from(shot.data, "base64"),
    );
  }
  record(
    "popup branding",
    "English/Japanese title and heading match; 280px layout has no overlap or overflow",
  );
  passed = true;
} finally {
  cancelDownloadWait();
  assert.equal(
    await session.cleanup(),
    true,
    "disposable browser/profile cleanup failed",
  );
}
assert.equal(passed, true);
console.log("STARTUP PASS (owned disposable browser cleaned up)");
