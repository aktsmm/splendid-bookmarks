import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
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
    };
  })()`);
  assert.equal(loading.stats.error?.key, "agent.error.noTree");
  assert.equal(loading.session.ok, true);
  assert.equal(loading.session.state.ready, false);
  assert.equal(loading.session.state.loading, true);
  assert.equal(loading.apply.error?.key, "agent.error.notReady");
  assert.equal(loading.loadDisabled, true);
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
  assert.equal(readdirSync(downloads).length, 0);
  assert.equal(
    await evaluate(`chrome.bookmarks.getTree().then(JSON.stringify)`),
    baseline,
  );
  record(
    "populated startup",
    "627 bookmarks; one automatic read; focus retained; no writes/downloads; Apply locked",
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
  await evaluate(`document.getElementById("load-tree").click()`);
  await waitFor(ready, "manual refresh before stale cursor check");
  const stale = await evaluate(
    `window.splendidBookmarks.run("getTree", { cursor: ${JSON.stringify(originalCursor)} })`,
  );
  assert.equal(stale.error?.key, "agent.error.staleCursor");
  record(
    "pagination",
    "all search results retrieved; old cursor rejected after tree refresh",
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
  passed = true;
} finally {
  assert.equal(
    await session.cleanup(),
    true,
    "disposable browser/profile cleanup failed",
  );
}
assert.equal(passed, true);
console.log("STARTUP PASS (owned disposable browser cleaned up)");
