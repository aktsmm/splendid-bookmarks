#!/usr/bin/env node
/**
 * Captures the 1280x800 store screenshots the Chrome Web Store listing needs.
 *
 * Runs against a throwaway profile seeded with synthetic bookmarks, and refuses
 * to write anything if the profile is not empty when it starts: browser sign-on
 * can pull a real account into a brand new profile, and a screenshot of somebody's
 * real bookmarks cannot be taken back once it is on a public listing.
 *
 *   node scripts/capture-store-screenshots.mjs [--extension-dir <path>] [--lang en|ja]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planFixtureRoots } from "./lib/pilot-boundary.mjs";
import {
  ROOT,
  launchPilotBrowser,
  makeRecorder,
  makeWaiter,
  sleep,
} from "./lib/pilot-browser.mjs";

const WORK = join(ROOT, "tmp", "screenshots");
const OUT_DIR = join(ROOT, "submission-screenshots");
const WIDTH = 1280;
const HEIGHT = 800;

const argOf = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const EXTENSION_DIR = argOf("--extension-dir");
const LANG = argOf("--lang") ?? "en";

/** Obviously fictional, so a screenshot can never leak a real bookmark. */
const SEED = [
  ["Docs", "MDN Web Docs", "https://developer.mozilla.org/"],
  [
    "Docs",
    "Chrome Extensions",
    "https://developer.chrome.com/docs/extensions/",
  ],
  ["Docs", "Web.dev", "https://web.dev/"],
  ["Reading", "MDN Web Docs", "https://developer.mozilla.org/"],
  ["Reading", "Example Domain", "https://example.com/"],
  ["Reading", "Example Domain", "https://example.com/?utm_source=newsletter"],
  [
    "Archive",
    "Chrome Extensions",
    "https://developer.chrome.com/docs/extensions/",
  ],
  ["Archive", "Example Domain", "https://example.com"],
];

const { record } = makeRecorder();
let cleanup = null;
let failed = false;

try {
  const session = await launchPilotBrowser({
    work: WORK,
    record,
    // The permanent folder names come from the browser, not the extension, so a
    // screenshot mixes languages unless both are set to the listing's locale.
    extraArgs: [`--lang=${LANG === "ja" ? "ja" : "en-US"}`],
    ...(EXTENSION_DIR ? { extensionDir: EXTENSION_DIR } : {}),
  });
  cleanup = session.cleanup;
  const { page, evaluate } = session;
  const waitFor = makeWaiter(evaluate);

  const countBookmarks = () =>
    evaluate(`(async () => {
      const [root] = await chrome.bookmarks.getTree();
      let urls = 0;
      const walk = (node) => { if (node.url) urls += 1; for (const child of node.children ?? []) walk(child); };
      walk(root);
      return urls;
    })()`);

  const existing = await countBookmarks();
  record("bookmarks before seeding", `${existing}`);
  if (existing !== 0) {
    throw new Error(
      `the throwaway profile already holds ${existing} bookmark(s); refusing to seed or capture`,
    );
  }

  const roots = planFixtureRoots(
    await evaluate(`(async () => {
      const [root] = await chrome.bookmarks.getTree();
      return JSON.stringify((root.children ?? []).map((child) => ({
        id: child.id,
        title: child.title,
        folderType: child.folderType ?? null,
        syncing: typeof child.syncing === "boolean" ? child.syncing : null,
        unmodifiable: child.unmodifiable ?? null,
      })));
    })()`).then(JSON.parse),
  );
  if (!roots.home) throw new Error("no writable bookmarks bar in this profile");

  const seeded = await evaluate(`(async () => {
    const bar = ${JSON.stringify(roots.home.bar)};
    const seed = ${JSON.stringify(SEED)};
    const folders = new Map();
    let made = 0;
    for (const [folder, title, url] of seed) {
      if (!folders.has(folder)) {
        const node = await chrome.bookmarks.create({ parentId: bar, title: folder });
        folders.set(folder, node.id);
      }
      await chrome.bookmarks.create({ parentId: folders.get(folder), title, url });
      made += 1;
    }
    return made;
  })()`);
  record("synthetic bookmarks seeded", `${seeded}`);

  await evaluate(
    `localStorage.setItem("agbm.ui-locale", ${JSON.stringify(LANG)})`,
  );
  await evaluate("location.reload()");
  await waitFor(
    `document.readyState === "complete" && typeof window.splendidBookmarks?.run === "function" &&
     document.getElementById("tree-status")?.dataset.kind === "ok" && !document.getElementById("load-tree").disabled`,
    "the options page after the language switch",
  );
  record("ui language", LANG);

  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });

  mkdirSync(OUT_DIR, { recursive: true });

  /** The store rejects anything that is not exactly 1280x800, so measure it here. */
  const capture = async (name) => {
    await sleep(400);
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    const png = Buffer.from(shot.data, "base64");
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    if (width !== WIDTH || height !== HEIGHT) {
      throw new Error(
        `${name}: captured ${width}x${height}, expected ${WIDTH}x${HEIGHT}`,
      );
    }
    const file = join(OUT_DIR, name);
    writeFileSync(file, png);
    record(name, `${width}x${height}, ${(png.length / 1024).toFixed(1)} KB`);
  };

  // Scrolls the whole card into view, not the control: a screenshot that starts
  // mid-section reads as a different feature than the one it is captioned with.
  const scrollToSection = (selector) =>
    evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        (el.closest("section") ?? el).scrollIntoView({ block: "start" });
        window.scrollBy(0, -16);
        return true; })()`,
    );

  const stats = await evaluate(`window.splendidBookmarks.run("getStats")`);
  if (!stats.ok || stats.state.bookmarks !== seeded) {
    throw new Error("loaded screenshot tree does not match synthetic fixtures");
  }
  await evaluate("window.scrollTo(0, 0)");
  await capture("01-live-tree.png");

  await evaluate(`document.getElementById("find-duplicates").click()`);
  await waitFor(
    `document.querySelectorAll('#duplicates input[type="radio"]').length > 0`,
    "the duplicate report",
  );
  await scrollToSection("#duplicates-status");
  await capture("02-duplicate-report.png");

  await scrollToSection("#plan-status");
  await capture("03-moves-to-apply.png");

  await scrollToSection("#apply-status");
  await capture("04-apply-and-rollback.png");

  await scrollToSection("#trash-status");
  await capture("05-trash.png");

  record(
    "verdict",
    `CAPTURE PASS: 5 screenshots at ${WIDTH}x${HEIGHT} in submission-screenshots/`,
  );
} catch (error) {
  failed = true;
  record("error", error.message);
  record("verdict", "CAPTURE FAIL");
} finally {
  if (cleanup && !(await cleanup())) {
    failed = true;
    record("cleanup", "FAIL: disposable profile was not removed");
  }
}

process.exitCode = failed ? 1 : 0;
