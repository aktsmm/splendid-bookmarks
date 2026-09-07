/**
 * Shared driver for the real-browser scripts. It launches a throwaway profile,
 * proves the DevTools endpoint belongs to that profile, and hands back a page
 * handle plus a cleanup that only ever touches what this process started.
 *
 * The endpoint is discovered from `DevToolsActivePort` **inside the profile
 * directory this process just created**, never from a fixed port. A fixed port
 * can be answered by a browser someone else is using, and a bind-test before
 * launching still leaves a window where another process takes it.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { connectCdp as connect } from "./cdp-client.mjs";

export const ROOT = resolve(process.cwd());
export const EXT = join(ROOT, "extension");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_BROWSER =
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

// The documented way to put an account store and a local store side by side for
// testing. Spelled here rather than taken from the environment: a pass-through
// for arbitrary switches would let a caller override `--user-data-dir`, the
// debugging port, or the sync flag this harness relies on.
const DUAL_STORE_FLAGS =
  "--enable-features=SyncEnableBookmarksInTransportMode,EnableBookmarksSelectedTypeOnSigninForTesting";

async function untilJson(url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return res.json();
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`devtools endpoint never answered: ${url}`);
}

/**
 * Reads the endpoint the browser wrote into its own profile. Because the
 * profile directory is one this process created and passed as
 * `--user-data-dir`, whatever is described here is that browser and no other.
 */
async function ownEndpoint(profile, tries = 80) {
  const file = join(profile, "DevToolsActivePort");
  for (let i = 0; i < tries; i += 1) {
    if (existsSync(file)) {
      const [portLine, pathLine] = readFileSync(file, "utf8").split("\n");
      const port = Number((portLine ?? "").trim());
      const wsPath = (pathLine ?? "").trim();
      if (Number.isInteger(port) && port > 0 && wsPath.startsWith("/")) {
        return { port, browserWs: `ws://127.0.0.1:${port}${wsPath}` };
      }
    }
    await sleep(250);
  }
  throw new Error(
    "the browser never published DevToolsActivePort in its own profile",
  );
}

/**
 * Starts a throwaway browser and returns handles plus `cleanup`.
 * Callers must run the rest of their work inside `try` and call `cleanup` from
 * `finally`, and must not call `process.exit()` before that finally runs.
 */
export async function launchPilotBrowser({
  work,
  record,
  sync = false,
  dualStoreFlags = false,
  extensionDir = EXT,
  extraArgs = [],
  callTimeoutMs = 30000,
}) {
  // Resolved and proven here rather than at the load call: a missing or wrong
  // directory otherwise surfaces as a page that never becomes ready.
  const extension = resolve(extensionDir);
  if (!existsSync(join(extension, "manifest.json"))) {
    throw new Error(`no manifest.json under ${extension}`);
  }
  record?.("extension under test", extension);

  // A unique directory per run. A fixed path would have to be cleared before
  // launching, and that delete cannot tell a stale profile from one another run
  // is using right now.
  mkdirSync(dirname(work), { recursive: true });
  const root = mkdtempSync(`${work}-`);
  const profile = join(root, "profile");
  const downloads = join(root, "downloads");
  mkdirSync(downloads, { recursive: true });

  const binary = process.env.PILOT_BROWSER ?? DEFAULT_BROWSER;
  const child = spawn(
    binary,
    [
      `--user-data-dir=${profile}`,
      // Port 0 makes the browser pick a free port and publish it in the profile.
      "--remote-debugging-port=0",
      `--disable-extensions-except=${extension}`,
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check",
      ...(sync ? [] : ["--disable-sync"]),
      ...(dualStoreFlags ? [DUAL_STORE_FLAGS] : []),
      ...extraArgs,
      "--new-window",
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  let browser = null;
  let page = null;

  const cleanup = async () => {
    try {
      page?.close();
    } catch {
      /* the socket usually dies with the browser */
    }
    try {
      await browser?.send("Browser.close");
    } catch {
      /* closing the browser closes the socket that carried the request */
    }
    try {
      browser?.close();
    } catch {
      /* already gone */
    }
    await sleep(1000);
    // Only ever the child this function spawned. No process enumeration.
    if (child.exitCode === null) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    } // The browser can hold profile files for a while after it is asked to go,
    // so this waits rather than declaring a failure the caller cannot act on.
    for (let i = 0; i < 40; i += 1) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        await sleep(500);
      }
    }
    return !existsSync(root);
  };

  try {
    const { port, browserWs } = await ownEndpoint(profile);
    browser = connect(browserWs, callTimeoutMs);
    await browser.ready;
    const version = await browser.send("Browser.getVersion");
    record("browser", `${version.product} (own endpoint on port ${port})`);
    await browser.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloads,
    });

    if (process.env.PILOT_FAIL_AFTER_LAUNCH === "1") {
      throw new Error("PILOT_FAIL_AFTER_LAUNCH: injected failure");
    }

    // Loaded after the endpoint is proven to be ours, so no unpacked extension
    // is ever pushed into a browser this process did not start.
    const loaded = await browser.send("Extensions.loadUnpacked", {
      path: extension,
    });
    // A browser can accept the load and still leave the extension disabled, and
    // that shows up much later as a page that never becomes ready. Ask.
    let enabled = null;
    let enabledNote = "not reported";
    try {
      const installed = await browser.send("Extensions.getExtensions");
      enabled =
        installed.extensions?.find((item) => item.id === loaded.id)?.enabled ??
        null;
      enabledNote =
        enabled === null ? "not in the installed list" : `${enabled}`;
    } catch (error) {
      enabledNote = `unavailable (${error.message})`;
    }
    record(
      "extension",
      `loaded via CDP: ${loaded.id} (enabled: ${enabledNote})`,
    );
    if (enabled === false) {
      throw new Error(
        `${loaded.id} was installed but left disabled, so the options page can never be driven`,
      );
    }

    const optionsUrl = `chrome-extension://${loaded.id}/ui/options.html`;
    const created = await browser.send("Target.createTarget", {
      url: optionsUrl,
    });
    const targets = await untilJson(`http://127.0.0.1:${port}/json/list`);
    const target = targets.find((t) => t.id === created.targetId);
    if (!target) throw new Error("options page target not found");

    page = connect(target.webSocketDebuggerUrl, callTimeoutMs);
    await page.ready;
    await page.send("Runtime.enable");
    await page.send("DOM.enable");
    record("options page", optionsUrl);

    const evaluate = async (expression) => {
      const result = await page.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ??
            JSON.stringify(result.exceptionDetails),
        );
      }
      return result.result.value;
    };

    // The target exists before it has navigated and before its module has run,
    // so everything below would otherwise race the page. Waiting for the real
    // document and its handlers here is what keeps the callers from having to
    // guess whether a click was received.
    let ready = false;
    for (let i = 0; i < 120; i += 1) {
      try {
        ready = await evaluate(
          `document.location.href === ${JSON.stringify(optionsUrl)} &&
           typeof chrome !== "undefined" &&
           !!chrome.bookmarks &&
           document.readyState === "complete" &&
           !!document.getElementById("load-tree")`,
        );
      } catch {
        ready = false; // Evaluating during a navigation throws; try again.
      }
      if (ready) break;
      await sleep(250);
    }
    if (!ready) {
      throw new Error("the options page never became ready to drive");
    }

    // Second factor. A profile this process created moments ago has no user
    // bookmarks; anything else means the handles are not what they claim.
    const existing = await evaluate(
      `chrome.bookmarks.getTree().then((roots) => {
        let n = 0;
        const walk = (node) => {
          if (node.parentId !== undefined && node.parentId !== "0") n += 1;
          for (const child of node.children ?? []) walk(child);
        };
        for (const root of roots) walk(root);
        return n;
      })`,
    );
    if (existing !== 0) {
      throw new Error(
        `refusing to drive a profile that already holds ${existing} bookmark nodes`,
      );
    }
    record("profile", "pristine throwaway profile (0 existing nodes)");

    return {
      page,
      evaluate,
      downloads,
      profile,
      port,
      product: version.product,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export function makeRecorder() {
  const log = [];
  return {
    log,
    record(step, detail) {
      log.push({ step, detail });
      console.log(
        `[${String(log.length).padStart(2, "0")}] ${step}: ${detail}`,
      );
    },
  };
}

/** Polls a page expression until it is truthy. */
export function makeWaiter(evaluate) {
  return async function waitFor(expression, what, tries = 60) {
    for (let i = 0; i < tries; i += 1) {
      if (await evaluate(expression)) return true;
      await sleep(500);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
}

/**
 * Clicks until the page reacts, for idempotent read-only actions only.
 *
 * The options page attaches its handlers when its module finishes running, and
 * the page is opened moments before the first click, so a single dispatch can
 * land on markup that has no listener yet and be lost with no error anywhere.
 * The page also disables every control while it is busy, and those clicks are
 * swallowed too.
 */
export function makeClicker(evaluate) {
  return async function clickUntil(buttonId, doneExpression, what, tries = 60) {
    const id = JSON.stringify(buttonId);
    const done = `(${doneExpression}) && !!document.getElementById(${id}) && !document.getElementById(${id}).disabled`;
    let clicked = false;
    for (let i = 0; i < tries; i += 1) {
      if (clicked && (await evaluate(done))) return true;
      const dispatched = await evaluate(`(() => {
        const button = document.getElementById(${id});
        if (!button || button.disabled) return false;
        button.click();
        return true;
      })()`);
      clicked = clicked || dispatched;
      await sleep(250);
    }
    if (clicked && (await evaluate(done))) return true;
    const state = await evaluate(
      `JSON.stringify({ present: !!document.getElementById(${id}), disabled: document.getElementById(${id})?.disabled ?? null })`,
    );
    throw new Error(`timed out waiting for ${what} (button ${state})`);
  };
}
