import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { connectCdp } from "./lib/cdp-client.mjs";
import { collectInventory, inspectSession } from "./lib/agent-inventory.mjs";

const STORE_ID = "ehmdjfhakpifieboiogjemfdbgaemmaj";
const HELP = `Read-only bookmark inventory (Node.js 22+)
  npm run inventory -- --cdp-url http://127.0.0.1:9223 --list
  npm run inventory -- --cdp-url http://127.0.0.1:9223 --target-id <id> --session-id <id> --label work [--output tmp/inventory.json]
  --extension-id <id>  Use the selected unpacked extension instead of the CWS id.
The manager tab must already be open. No browser launch, reload, activation, or bookmark writes.
Without --output only counts are printed. Existing output files are never overwritten.`;

export function inventoryOptions(args) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      "cdp-url": { type: "string" },
      "extension-id": { type: "string", default: STORE_ID },
      "target-id": { type: "string" },
      "session-id": { type: "string" },
      label: { type: "string" },
      output: { type: "string" },
      list: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return { help: true };
  let endpoint;
  try {
    endpoint = new URL(values["cdp-url"]);
  } catch {
    throw new Error("Specify --cdp-url http://127.0.0.1:<port>");
  }
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/"
  )
    throw new Error("CDP must be an explicit loopback HTTP endpoint");
  if (!/^[a-p]{32}$/.test(values["extension-id"]))
    throw new Error("Invalid extension id");
  if (values.list) {
    if (
      values.output ||
      values.label ||
      values["target-id"] ||
      values["session-id"]
    ) {
      throw new Error("--list cannot be combined with collection options");
    }
  } else {
    if (!/^[a-fA-F0-9]{32}$/.test(values["target-id"] ?? ""))
      throw new Error("Specify the --target-id returned by --list");
    if (!values["session-id"] || values["session-id"].length > 160)
      throw new Error("Specify the --session-id returned by --list");
    if (
      !values.label ||
      values.label.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(values.label)
    ) {
      throw new Error(
        "Specify a --label of 1 to 80 characters without control characters",
      );
    }
    if (values.output !== undefined && !values.output.trim())
      throw new Error("Output path must not be empty");
  }
  return { ...values, endpoint: endpoint.origin };
}

async function cdpJson(endpoint, path) {
  const response = await fetch(`${endpoint}${path}`, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`CDP HTTP error: ${response.status}`);
  return response.json();
}

export function validateTarget(target, endpoint, extensionId) {
  const expected = `chrome-extension://${extensionId}/ui/options.html`;
  if (
    target?.type !== "page" ||
    target.url !== expected ||
    !/^[a-fA-F0-9]{32}$/.test(target.id ?? "")
  ) {
    throw new Error(
      "The selected target is not the requested extension manager",
    );
  }
  const websocket = new URL(target.webSocketDebuggerUrl);
  const base = new URL(endpoint);
  if (
    websocket.protocol !== "ws:" ||
    websocket.hostname !== base.hostname ||
    websocket.port !== base.port ||
    websocket.username ||
    websocket.password ||
    websocket.search ||
    websocket.hash ||
    websocket.pathname !== `/devtools/page/${target.id}`
  ) {
    throw new Error(
      "CDP WebSocket does not belong to the selected endpoint and target",
    );
  }
  return expected;
}

async function withTarget(target, options, action) {
  const expected = validateTarget(
    target,
    options.endpoint,
    options["extension-id"],
  );
  const client = connectCdp(target.webSocketDebuggerUrl);
  try {
    await client.ready;
    await client.send("Runtime.enable");
    const call = async (command, input) => {
      if (
        !["capabilities", "getSession", "getStats", "getTree"].includes(command)
      ) {
        throw new Error("Inventory only allows read commands");
      }
      const response = await client.send("Runtime.evaluate", {
        expression: `(async () => {
          if (location.href !== ${JSON.stringify(expected)}) throw new Error("Target navigated away");
          if (typeof window.splendidBookmarks?.run !== "function") throw new Error("Agent API unavailable");
          return window.splendidBookmarks.run(${JSON.stringify(command)}, ${JSON.stringify(input ?? {})});
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (response.exceptionDetails)
        throw new Error("Agent API unavailable or target navigated away");
      return response.result?.value;
    };
    return await action(call);
  } finally {
    client.close();
  }
}

export function saveInventory(output, inventory) {
  writeFileSync(output, `${JSON.stringify(inventory, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

export async function runInventory(options) {
  const version = await cdpJson(options.endpoint, "/json/version");
  const targets = await cdpJson(options.endpoint, "/json/list");
  if (!Array.isArray(targets)) throw new Error("Invalid CDP target list");
  const matching = targets.filter(
    (target) =>
      target.type === "page" &&
      target.url ===
        `chrome-extension://${options["extension-id"]}/ui/options.html`,
  );
  if (options.list) {
    const candidates = [];
    for (const target of matching) {
      try {
        const { session, stats } = await withTarget(
          target,
          options,
          inspectSession,
        );
        candidates.push({
          targetId: target.id,
          sessionId: session.sessionId,
          ready: session.ready,
          loading: session.loading,
          mode: session.mode ?? null,
          treeStatus: session.treeStatus?.kind,
          bookmarks: stats?.bookmarks ?? null,
          folders: stats?.folders ?? null,
        });
      } catch (error) {
        candidates.push({ targetId: target.id, error: error.message });
      }
    }
    return { browser: version.Browser, candidates };
  }
  const target = matching.find(
    (candidate) => candidate.id === options["target-id"],
  );
  if (!target)
    throw new Error(
      "Target not found; open the manager in the intended profile and run --list again",
    );
  const inventory = await withTarget(target, options, (call) =>
    collectInventory(call, { sessionId: options["session-id"] }),
  );
  const identity = {
    label: options.label,
    browser: version.Browser,
    extensionId: options["extension-id"],
    targetId: target.id,
    sessionId: inventory.session.sessionId,
  };
  if (options.output)
    saveInventory(options.output, {
      capturedAt: new Date().toISOString(),
      ...identity,
      ...inventory,
    });
  return {
    ...identity,
    total: inventory.total,
    bookmarks: inventory.stats.bookmarks,
    folders: inventory.stats.folders,
    output: options.output ?? null,
  };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const options = inventoryOptions(process.argv.slice(2));
    console.log(
      options.help
        ? HELP
        : JSON.stringify(await runInventory(options), null, 2),
    );
  } catch (error) {
    console.error(`INVENTORY FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
