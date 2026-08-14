/**
 * The one place the page is exposed to a script driving it.
 *
 * Every command runs through `validateInvocation` and then through a handler
 * the options page supplies — the same functions its own buttons call — so the
 * API cannot reach a gate the UI would have applied. It is a stable entry
 * point, not a permission: whatever can call this can already click the page.
 */
import {
  AGENT_API_VERSION,
  COMMAND_NAMES,
  errorResult,
  okResult,
  validateInvocation,
} from "../src/core/agent-command.js";

const GLOBAL_NAME = "splendidBookmarks";

export function exposeAgentApi(handlers) {
  const missing = COMMAND_NAMES.filter(
    (name) => typeof handlers[name] !== "function",
  );
  if (missing.length > 0) {
    throw new Error(`agent api handlers missing: ${missing.join(", ")}`);
  }

  // Commands are serial. Two of them started from the same tick would race on
  // the journal the way two very fast clicks can, and a caller that can await
  // has no reason to need the overlap.
  let inFlight = false;

  const run = async (command, input) => {
    if (inFlight) return errorResult(command, "agent.error.busy");
    inFlight = true;
    try {
      // Validation is inside the guard on purpose: the input is untrusted, so
      // reading its own keys can throw. A rejected promise here would break the
      // one thing every caller is told to rely on — a result object.
      const check = validateInvocation(command, input);
      if (!check.ok) return errorResult(command, check.key, check.params);
      return okResult(command, await handlers[command](input ?? {}));
    } catch (error) {
      // A handler that refused on purpose already says why, in a key a caller
      // can branch on. Wrapping it would flatten every refusal into "failed".
      if (typeof error?.key === "string") {
        return errorResult(command, error.key, error.params);
      }
      return errorResult(command, "agent.error.failed", {
        message: String(error?.message ?? error),
      });
    } finally {
      inFlight = false;
    }
  };

  const api = Object.freeze({ version: AGENT_API_VERSION, run });
  // Freezing the object is not enough on its own: the property itself has to be
  // non-writable and non-configurable or anything on the page could swap it.
  // Neither stops a CDP client, which can rewrite the page regardless.
  Object.defineProperty(window, GLOBAL_NAME, {
    value: api,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  return api;
}
