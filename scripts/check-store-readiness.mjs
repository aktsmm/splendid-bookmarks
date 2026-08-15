#!/usr/bin/env node
/**
 * Store-readiness report for the Chrome Web Store.
 * Deliberately not part of `npm test`: the product is correct for its current
 * phase, and this script answers a different question — whether it could be
 * submitted at all. Exits non-zero while any BLOCK remains.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  claimsCannotDelete,
  claimsReadOnly,
  pastedListingCopy,
} from "./lib/listing-claims.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const extensionDir = join(root, "extension");
const manifest = JSON.parse(
  readFileSync(join(extensionDir, "manifest.json"), "utf8"),
);

const results = [];
const check = (label, ok, detail) =>
  results.push({ label, status: ok ? "PASS" : "BLOCK", detail });

// The Chrome Web Store caps the manifest description at 132 characters.
const DESCRIPTION_LIMIT = 132;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

// --- Package shape -----------------------------------------------------------
const packaged = walk(extensionDir).map((file) => relative(extensionDir, file));
const leaked = packaged.filter((file) =>
  /(^|[\\/])(tests?|docs?|node_modules|\.git)([\\/]|$)|\.test\.js$|\.map$/.test(
    file,
  ),
);
check(
  "package contains only runtime files",
  leaked.length === 0,
  leaked.length === 0
    ? `${packaged.length} files under extension/`
    : `would ship: ${leaked.join(", ")}`,
);

// --- Manifest ----------------------------------------------------------------
check("manifest_version is 3", manifest.manifest_version === 3);
check(
  "version is a dotted integer string",
  /^\d+(\.\d+){0,3}$/.test(manifest.version ?? ""),
  manifest.version,
);
check("no update_url (both stores manage updates)", !manifest.update_url);

// The permission set is the whole review story, so it is pinned, not just checked.
const ALLOWED_PERMISSIONS = ["bookmarks", "storage"];
check(
  "permissions are exactly the ones the build uses",
  JSON.stringify(manifest.permissions) === JSON.stringify(ALLOWED_PERMISSIONS),
  (manifest.permissions ?? []).join(", "),
);
const extraSurface = [
  "host_permissions",
  "optional_permissions",
  "background",
  "content_scripts",
  "web_accessible_resources",
  "externally_connectable",
].filter((key) => manifest[key] !== undefined);
check(
  "no background, content script or extra host surface",
  extraSurface.length === 0,
  extraSurface.length === 0 ? "none declared" : extraSurface.join(", "),
);

const iconSizes = Object.keys(manifest.icons ?? {});
check(
  "manifest declares icons including 128",
  iconSizes.includes("128"),
  iconSizes.length ? `declared: ${iconSizes.join(", ")}` : "no icons key",
);
check(
  "toolbar action has a default_icon",
  Boolean(manifest.action?.default_icon),
  manifest.action?.default_icon ? "declared" : "action.default_icon missing",
);

// --- Localized listing text --------------------------------------------------
for (const locale of readdirSync(join(extensionDir, "_locales"))) {
  const messages = JSON.parse(
    readFileSync(
      join(extensionDir, "_locales", locale, "messages.json"),
      "utf8",
    ),
  );
  const name = messages.extensionName?.message ?? "";
  const description = messages.extensionDescription?.message ?? "";
  check(
    `${locale}: name and description are present`,
    Boolean(name && description),
  );
  check(
    `${locale}: description is within ${DESCRIPTION_LIMIT} characters`,
    description.length <= DESCRIPTION_LIMIT,
    `${description.length} characters`,
  );
  check(
    `${locale}: listing text does not say "Chrome"`,
    !/chrome/i.test(`${name} ${description}`),
    "store branding policy",
  );
  // The build writes now; listing text that still promises otherwise is a lie.
  check(
    `${locale}: listing text does not claim to be read-only`,
    !claimsReadOnly(`${name} ${description}`),
    "the build can move, create the one Trash folder, and delete from the Trash",
  );
  // Deleting a confirmed item out of the Trash is implemented and irreversible.
  check(
    `${locale}: listing text does not claim it cannot delete`,
    !claimsCannotDelete(`${name} ${description}`),
    "the build can permanently delete a confirmed item from the Trash",
  );
}

// --- Store listing copy ------------------------------------------------------
// The text above is the manifest's, which is not what the reviewer reads. The
// copy that goes into the dashboard lives here, so it gets the same predicates
// instead of a promise that somebody proofread it.
const listingCopyPath = join(root, "docs", "cws-listing.md");
if (!existsSync(listingCopyPath)) {
  check(
    "store listing copy is drafted in the repository",
    false,
    "docs/cws-listing.md is missing",
  );
} else {
  const flat = pastedListingCopy(readFileSync(listingCopyPath, "utf8"));
  check(
    "store listing copy is drafted in the repository",
    flat.length > 0,
    `docs/cws-listing.md, ${flat.length} characters of pasted copy`,
  );
  check(
    "listing copy does not claim to be read-only",
    !claimsReadOnly(flat),
    "the build can move, create the one Trash folder, and delete from the Trash",
  );
  check(
    "listing copy does not claim it cannot delete",
    !claimsCannotDelete(flat),
    "the build can permanently delete a confirmed item from the Trash",
  );
  // A reviewer reads the description, not the repository. If the two-step delete
  // is not stated there, the listing is quietly softer than the build.
  check(
    "listing copy states that the permanent delete is irreversible",
    /cannot be undone|irreversible|元に戻せません/i.test(flat),
    "the irreversible step has to be visible to a reader of the listing",
  );
}

// --- Icon files exist --------------------------------------------------------
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

for (const [size, path] of Object.entries(manifest.icons ?? {})) {
  const file = join(extensionDir, ...path.split("/"));
  let detail = "missing";
  let ok = false;
  try {
    const bytes = readFileSync(file);
    // The store rejects a mislabelled or wrongly sized icon at upload time.
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    ok =
      bytes.subarray(0, 4).equals(PNG_MAGIC) &&
      width === Number(size) &&
      height === Number(size);
    detail = `${path} (${width}x${height})`;
  } catch {
    detail = `${path} (unreadable)`;
  }
  check(`icon ${size} is a PNG of the declared size`, ok, detail);
}

// --- Every path the manifest points at resolves -------------------------------
const referenced = [
  manifest.action?.default_popup,
  manifest.options_ui?.page,
  ...Object.values(manifest.action?.default_icon ?? {}),
].filter(Boolean);
const dangling = referenced.filter((path) => {
  try {
    return !statSync(join(extensionDir, ...path.split("/"))).isFile();
  } catch {
    return true;
  }
});
check(
  "every file the manifest references exists",
  dangling.length === 0,
  dangling.length === 0
    ? referenced.join(", ")
    : `missing: ${dangling.join(", ")}`,
);

// --- Things that cannot be satisfied from the repo ---------------------------
const manual = [
  "Chrome Web Store developer account is registered and set up",
  "Store listing filled in: category, screenshots, support contact",
  "Privacy tab completed: single purpose, permission justification for bookmarks and storage, data-use certification",
  "The extension has been loaded unpacked and a move has been applied, verified and rolled back in a real browser",
  "A trashed bookmark has been deleted for good in a real browser, and its neighbour was left untouched",
  "The listing copy has been read against the build: it does not promise the extension cannot delete",
  "Upload and submit for review (a signed-in browser action, not automatable here)",
];

const blocked = results.filter((entry) => entry.status === "BLOCK");
const width = Math.max(...results.map((entry) => entry.label.length));
for (const entry of results) {
  const detail = entry.detail ? `  ${entry.detail}` : "";
  console.log(
    `${entry.status.padEnd(5)} ${entry.label.padEnd(width)}${detail}`,
  );
}
console.log("\nRequires a human decision or an account (not checkable here):");
for (const item of manual) console.log(`  - ${item}`);
console.log(
  `\n${blocked.length} blocking item(s) in the repository, ${manual.length} outside it.`,
);

process.exitCode = blocked.length === 0 ? 0 : 1;
