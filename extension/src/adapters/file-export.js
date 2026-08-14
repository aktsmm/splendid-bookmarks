/**
 * File export helper. Uses a Blob URL plus a generated anchor, which needs no
 * `downloads` permission.
 *
 * A browser download cannot be confirmed from the page, so the caller must treat
 * the returned digest as an expected value to be re-verified by asking the user
 * to re-select the saved file before any write phase is unlocked.
 */
import { sha256Hex } from "../core/digest.js";
import { LocalizedError } from "../core/errors.js";

export async function exportTextFile(filename, textContent, mimeType) {
  const bytes = new TextEncoder().encode(textContent);
  const digest = await sha256Hex(bytes);

  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Revoke on the next task so the download has already started.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return { filename, byteLength: bytes.byteLength, digest };
}

export function exportJsonFile(filename, data) {
  return exportTextFile(
    filename,
    `${JSON.stringify(data, null, 2)}\n`,
    "application/json",
  );
}

export function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      // FileReader reports a DOMException whose message is often empty, so keep
      // only its name and show it inside a localized sentence.
      const failure = reader.error;
      reject(
        new LocalizedError(
          "error.fileRead",
          { detail: failure?.name ?? "unknown" },
          { cause: failure },
        ),
      );
    };
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(file);
  });
}
