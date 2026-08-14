/**
 * Errors the extension raises itself carry a message key so the UI can show
 * them in the active language. Errors thrown by the platform keep their own
 * native message and are rendered inside a localized frame.
 */
import { formatBytes } from "./format.js";

/** Only explicitly byte-named params render as sizes, so a plain `limit` stays a number. */
const BYTE_PARAMS = new Set(["sizeBytes", "limitBytes"]);

export class LocalizedError extends Error {
  constructor(key, params, options) {
    super(key, options);
    this.name = "LocalizedError";
    this.key = key;
    this.params = params;
  }
}

export function describeError(translate, error) {
  if (!(error instanceof LocalizedError) && typeof error?.key !== "string") {
    return error?.message ?? String(error);
  }

  const params = {};
  for (const [name, value] of Object.entries(error.params ?? {})) {
    params[name] =
      BYTE_PARAMS.has(name) && typeof value === "number"
        ? formatBytes(value, translate.locale)
        : value;
  }
  return translate(error.key, params);
}
