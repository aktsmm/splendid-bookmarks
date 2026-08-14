import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const extensionDir = fileURLToPath(new URL("../extension/", import.meta.url));

/**
 * Deterministic gate for the write boundary. The safety argument for this build
 * is not "we intend to write carefully" but "the shipped source reaches the
 * bookmark API only through a fixed, countable set of calls, each in one audited
 * function", which is checkable. What it does NOT prove is when those functions
 * are allowed to run; that is a runtime rule.
 */
const MOVE_ADAPTER = join("src", "adapters", "bookmarks-api.js");
const STORAGE_ADAPTER = join("src", "adapters", "journal-store.js");

// `a?.b` reaches the same function as `a.b`, so every scan below has to accept
// both. Matching only the plain dot would let one added question mark walk the
// whole build past this gate.
const DOT = String.raw`\s*\??\s*\.\s*`;
const COMPUTED = String.raw`\s*(?:\?\s*\.)?\s*\[`;
const member = (...path) => path.join(DOT);

const FORBIDDEN = [
  {
    label: "recursive deletion",
    // Reference level, not call level: holding the function is enough to call it.
    // `update` is not here — it exists in exactly one audited body, and the
    // count test below is what pins it there.
    pattern: new RegExp(`${member("chrome", "bookmarks", "removeTree")}\\b`),
  },
  {
    label: "a bare reference to the chrome namespace",
    // `const c = chrome` hands the whole API to a name none of the other scans
    // follow, which defeats every member-path rule below it.
    pattern: /(?<!typeof\s)\bchrome\b(?!\s*\??\s*[.[])/,
  },
  {
    label: "computed or aliased access to the chrome namespace",
    // A literal member call is auditable; a captured reference is not.
    // `a?.[x]` is computed access too, so the bracket may follow `?.`.
    pattern: new RegExp(
      [
        `chrome${COMPUTED}`,
        `${member("chrome", "bookmarks")}${COMPUTED}`,
        `=\\s*${member("chrome", "bookmarks")}\\b`,
        String.raw`\{[^{}]*\}\s*=\s*chrome\b`,
      ].join("|"),
    ),
  },
  {
    label: "reflective access that a member scan cannot follow",
    // `Reflect.get(chrome.bookmarks, "remove")` reaches the same function while
    // matching none of the member patterns above. `window["chrome"]` is the
    // same escape by another root, and the literal stripper would erase the
    // name before any member scan could see it.
    // `a?.[x]` is computed access too, so the bracket may follow `?.`.
    pattern: new RegExp(
      `\\bReflect\\s*\\??\\s*\\.|\\b(globalThis|window|self)${COMPUTED}`,
    ),
  },
  {
    label: "background lifecycle hook",
    pattern: new RegExp(
      `${member("chrome", "runtime", "(onInstalled|onStartup)")}\\b`,
    ),
  },
  {
    label: "tab or scripting access",
    pattern: new RegExp(
      `${member("chrome", "(tabs|scripting|debugger|downloads|windows)")}\\b`,
    ),
  },
  {
    label: "network request",
    pattern: new RegExp(
      [
        String.raw`\b(fetch\s*\(|XMLHttpRequest|EventSource|WebSocket)\b`,
        `${member("navigator", "sendBeacon")}\\b`,
      ].join("|"),
    ),
  },
  {
    label: "dynamic code evaluation",
    pattern: /\b(eval\s*\(|new\s+Function\s*\()/,
  },
  {
    label: "unsafe html sink",
    pattern: new RegExp(
      [
        String.raw`\b(innerHTML|outerHTML|insertAdjacentHTML)\b`,
        `${member("document", "write")}\\b`,
      ].join("|"),
    ),
  },
  {
    label: "clipboard hijacking",
    pattern: new RegExp(
      [
        `${member("navigator", "clipboard")}\\b`,
        String.raw`\bexecCommand\b`,
      ].join("|"),
    ),
  },
];

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(js|mjs|cjs|html)$/.test(name) ? [full] : [];
  });
}

const files = sourceFiles(extensionDir);
// Sources are CRLF on Windows; normalize so offset-based slicing stays meaningful.
const normalize = (text) => text.replace(/\r\n/g, "\n");
const read = (file) => normalize(readFileSync(file, "utf8"));
const relative = (file) => file.slice(extensionDir.length);

// A comment can hold text that satisfies a body assertion while the real call
// next to it does something else, so the audited bodies are checked on code.
// Literals go first: a string holding `/*` would otherwise let the stripper
// delete real code and leave a decoy behind.
const stripLiterals = (text) =>
  text
    .replace(/`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, '""');

const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// Split from `auditedBody` so the CRLF handling can be pinned by a test with a
// literal source instead of only being exercised through whatever line endings
// the checkout happens to have.
const bodyFromSource = (source, name) => {
  const normalized = normalize(source);
  const start = normalized.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `${name} not found`);
  const end = normalized.indexOf("\n}\n", start);
  assert.ok(end > start, `could not delimit ${name}`);
  return stripComments(stripLiterals(normalized.slice(start, end)));
};

const auditedBody = (name) =>
  bodyFromSource(readFileSync(join(extensionDir, MOVE_ADAPTER), "utf8"), name);

// Every scan runs on code, never on raw text: an API name inside a string is
// not a call, and a name inside a comment must not be able to satisfy a rule.
const code = (file) => stripComments(stripLiterals(read(file)));

test("the extension source contains at least the expected entry points", () => {
  assert.ok(
    files.length >= 6,
    `expected several source files, found ${files.length}`,
  );
});

for (const { label, pattern } of FORBIDDEN) {
  test(`no ${label} in the shipped build`, () => {
    const offenders = files.filter((file) => pattern.test(code(file)));
    assert.deepEqual(offenders.map(relative), []);
  });
}

/**
 * The scans are the whole safety argument, so they are checked against a sample
 * that should trip them. Without this, one added question mark walks the entire
 * build past every assertion above while they all still report success.
 */
test("the scans catch optional chaining, not only plain member access", () => {
  const deletion = FORBIDDEN.find(
    (entry) => entry.label === "recursive deletion",
  );
  assert.match("chrome?.bookmarks?.removeTree(id)", deletion.pattern);
  // The single-node delete and the title-only update are both allowed now, and
  // are pinned to one audited body each below.
  assert.doesNotMatch("chrome.bookmarks.remove(id)", deletion.pattern);
  assert.doesNotMatch("chrome.bookmarks.update(id, {})", deletion.pattern);

  const aliasing = FORBIDDEN.find((entry) =>
    entry.label.startsWith("computed or aliased"),
  );
  assert.match("const b = chrome?.bookmarks;", aliasing.pattern);
  assert.match("chrome?.[name].bookmarks", aliasing.pattern);

  const reflective = FORBIDDEN.find((entry) =>
    entry.label.startsWith("reflective access"),
  );
  // The literal stripper erases the name, so a member scan never sees these.
  assert.match('window["chrome"].bookmarks.update(id, {})', reflective.pattern);
  assert.match("globalThis[key].bookmarks", reflective.pattern);
  assert.match("self?.[key]", reflective.pattern);

  assert.match(
    "chrome?.bookmarks?.create({ parentId, title, url })",
    new RegExp(`${member("chrome", "bookmarks", "create")}\\b`),
  );
  assert.match(
    "await chrome?.storage?.local.set(x)",
    new RegExp(`${member("chrome", "storage")}\\b`),
  );

  const bare = FORBIDDEN.find((entry) =>
    entry.label.startsWith("a bare reference"),
  );
  // Handing the namespace to a local name would put every other rule out of reach.
  assert.match("const chromeAlias = chrome;", bare.pattern);
  assert.match("register(chrome)", bare.pattern);
  assert.doesNotMatch('typeof chrome !== "undefined"', bare.pattern);
  assert.doesNotMatch("chrome.bookmarks.getTree()", bare.pattern);
  assert.doesNotMatch("chrome?.bookmarks?.getTree()", bare.pattern);
  // The scans read code, so the word inside a string is not a violation.
  assert.doesNotMatch(stripLiterals('return "chrome";'), bare.pattern);

  const network = FORBIDDEN.find((entry) => entry.label === "network request");
  assert.match("navigator?.sendBeacon(u)", network.pattern);
  const sink = FORBIDDEN.find((entry) => entry.label === "unsafe html sink");
  assert.match("document?.write(x)", sink.pattern);
  const clipboard = FORBIDDEN.find(
    (entry) => entry.label === "clipboard hijacking",
  );
  assert.match("navigator?.clipboard.writeText(x)", clipboard.pattern);
});

/**
 * The audited body is read as code, so a string cannot stand in for a call and
 * cannot fake the comment delimiters that would hide the real one.
 */
test("a decoy in a string cannot satisfy the audited body", () => {
  const decoy = [
    "export async function sample() {",
    '  const d = "chrome.bookmarks.create({ parentId, title })";',
    '  const hideStart = "/*";',
    "  const result = alias.bookmarks.create(payload);",
    '  const hideEnd = "*/";',
    "  return result;",
    "}",
  ].join("\n");
  const audited = stripComments(stripLiterals(decoy));

  assert.doesNotMatch(
    audited,
    new RegExp(`${member("chrome", "bookmarks", "create")}\\s*\\(`),
  );
  // The real call survives stripping, so it is the one that gets judged.
  assert.match(audited, /alias\.bookmarks\.create\(/);
});

test("the whole build contains exactly one reference to the move API", () => {
  const pattern = new RegExp(
    `${member("chrome", "bookmarks", "move")}\\b`,
    "g",
  );
  const references = files.flatMap((file) =>
    [...code(file).matchAll(pattern)].map(() => relative(file)),
  );
  assert.deepEqual(references, [MOVE_ADAPTER]);
});

test("the move call lives inside the audited moveBookmark function", () => {
  const body = auditedBody("moveBookmark");
  assert.match(
    body,
    new RegExp(`${member("chrome", "bookmarks", "move")}\\s*\\(`),
  );
  // The availability guard must run before the write, not after it.
  assert.ok(
    body.indexOf("bookmarksApiAvailable()") <
      body.search(/bookmarks\s*\??\s*\.\s*move\s*\(/),
  );
});

test("the whole build contains exactly one reference to the create API", () => {
  const pattern = new RegExp(
    `${member("chrome", "bookmarks", "create")}\\b`,
    "g",
  );
  const references = files.flatMap((file) =>
    [...code(file).matchAll(pattern)].map(() => relative(file)),
  );
  assert.deepEqual(references, [MOVE_ADAPTER]);
});

/**
 * The build gained the ability to add a node, so the safety claim narrowed from
 * "it cannot create anything" to "it can only ever create an empty folder".
 * That is the difference this test fixes: a create whose arguments could carry
 * an address would silently widen the claim back.
 */
test("the create call can only ever produce an empty folder", () => {
  const body = auditedBody("createFolder");
  const call = new RegExp(
    `${member("chrome", "bookmarks", "create")}\\s*\\(`,
    "g",
  );
  assert.equal([...body.matchAll(call)].length, 1, "exactly one create call");
  // An address in any form would make this a bookmark factory.
  assert.doesNotMatch(body, /\burl\b/i);
  // Only the two properties a folder needs may reach the call.
  assert.match(
    body,
    new RegExp(
      `${member("chrome", "bookmarks", "create")}\\s*\\(\\s*\\{\\s*parentId\\s*,\\s*title\\s*\\}\\s*\\)`,
    ),
  );
  assert.ok(
    body.indexOf("bookmarksApiAvailable()") <
      body.search(/bookmarks\s*\??\s*\.\s*create\s*\(/),
  );
});

/** No spread, computed key or bracket access can smuggle a property into the create call. */
test("the folder create takes a fixed argument shape", () => {
  const body = auditedBody("createFolder");
  assert.doesNotMatch(body, /\.\.\./);
  assert.doesNotMatch(body, /\[/);
});

test("the whole build contains exactly one reference to the delete API", () => {
  const pattern = new RegExp(
    `${member("chrome", "bookmarks", "remove")}\\b`,
    "g",
  );
  const references = files.flatMap((file) =>
    [...code(file).matchAll(pattern)].map(() => relative(file)),
  );
  assert.deepEqual(references, [MOVE_ADAPTER]);
});

/**
 * Deletion is the one call that cannot be undone, so what the gate fixes is
 * narrow and worth stating exactly: the call exists once, in one audited
 * function, it takes a single node id, and it is never the recursive variant.
 * Whether a delete is reachable only behind a verified backup is a runtime rule
 * enforced by the controller and covered by tests, NOT something this scan can
 * prove.
 */
test("the delete call takes one node id and is never recursive", () => {
  const body = auditedBody("removeBookmark");
  const call = new RegExp(
    `${member("chrome", "bookmarks", "remove")}\\s*\\(`,
    "g",
  );
  assert.equal([...body.matchAll(call)].length, 1, "exactly one delete call");
  assert.doesNotMatch(body, /removeTree/);
  assert.match(
    body,
    new RegExp(
      `${member("chrome", "bookmarks", "remove")}\\s*\\(\\s*id\\s*\\)`,
    ),
  );
  assert.doesNotMatch(body, /\.\.\./);
  assert.ok(
    body.indexOf("bookmarksApiAvailable()") <
      body.search(/bookmarks\s*\??\s*\.\s*remove\s*\(/),
  );
});

test("the whole build contains exactly one reference to the update API", () => {
  const pattern = new RegExp(
    `${member("chrome", "bookmarks", "update")}\\b`,
    "g",
  );
  const references = files.flatMap((file) =>
    [...code(file).matchAll(pattern)].map(() => relative(file)),
  );
  assert.deepEqual(references, [MOVE_ADAPTER]);
});

/**
 * `update` can write a node's url as easily as its title, and a url rewrite
 * would turn a bookmark into a link to somewhere else while every identity
 * check that matches on url stopped agreeing with the tree. The gate fixes the
 * argument to a title-only literal so widening it cannot happen quietly.
 */
test("the update call can only ever write a title", () => {
  const body = auditedBody("updateBookmark");
  const call = new RegExp(
    `${member("chrome", "bookmarks", "update")}\\s*\\(`,
    "g",
  );
  assert.equal([...body.matchAll(call)].length, 1, "exactly one update call");
  assert.doesNotMatch(body, /\burl\b/i);
  assert.match(
    body,
    new RegExp(
      `${member("chrome", "bookmarks", "update")}\\s*\\(\\s*id\\s*,\\s*\\{\\s*title\\s*\\}\\s*\\)`,
    ),
  );
  assert.doesNotMatch(body, /\.\.\./);
  assert.doesNotMatch(body, /\[/);
  assert.ok(
    body.indexOf("bookmarksApiAvailable()") <
      body.search(/bookmarks\s*\??\s*\.\s*update\s*\(/),
  );
});

test("storage is confined to the journal adapter", () => {
  const pattern = new RegExp(`${member("chrome", "storage")}\\b`);
  const offenders = files
    .filter((file) => pattern.test(read(file)))
    .map(relative)
    .filter((file) => file !== STORAGE_ADAPTER);
  assert.deepEqual(offenders, []);
});

const AGENT_ADAPTER = join("ui", "agent-api.js");

/**
 * What this scan fixes is the *shape* of the exposure: one statement, one
 * frozen object, one entry point, and a property nothing on the page can swap.
 * What it cannot fix is who may call it — anything with script access to this
 * page, including devtools and CDP, could already drive every control — nor
 * that each command routes through a gate, which is a runtime property proven
 * by the wiring test and the browser pilot instead.
 */
test("the agent API is exposed in exactly one place", () => {
  const pattern = /defineProperty\s*\(\s*(window|globalThis|self)\b/g;
  const references = files.flatMap((file) =>
    [...code(file).matchAll(pattern)].map(() => relative(file)),
  );
  assert.deepEqual(references, [AGENT_ADAPTER]);
});

test("nothing else assigns onto the page global", () => {
  // `window.foo = x` is the other way to plant a global, and it stays writable.
  const pattern = /\b(window|globalThis|self)\s*\.\s*\w+\s*=[^=]/;
  const offenders = files
    .filter((file) => pattern.test(code(file)))
    .map(relative);
  assert.deepEqual(offenders, []);
});

test("the exposed object is frozen and its property cannot be replaced", () => {
  const source = code(join(extensionDir, AGENT_ADAPTER));
  assert.match(source, /Object\.freeze\s*\(\s*\{[^}]*\}\s*\)/);
  for (const setting of [/writable\s*:\s*false/, /configurable\s*:\s*false/]) {
    assert.match(source, setting);
  }
  assert.doesNotMatch(source, /writable\s*:\s*true/);
  assert.doesNotMatch(source, /configurable\s*:\s*true/);
});

test("every invocation is validated before a handler can run", () => {
  const source = code(join(extensionDir, AGENT_ADAPTER));
  const validated = source.indexOf("validateInvocation(");
  const dispatched = source.indexOf("handlers[command]");
  assert.ok(validated > 0, "the dispatcher must validate");
  assert.ok(dispatched > validated, "validation must come first");
  // One dispatch site: a second one could skip the check above.
  assert.equal([...source.matchAll(/handlers\s*\[\s*command\s*\]/g)].length, 1);
});

test("localStorage is confined to the locale adapter", () => {
  const allowed = join("src", "adapters", "locale.js");
  const offenders = files
    .filter((file) => /localStorage/.test(code(file)))
    .map(relative)
    .filter((file) => file !== allowed);
  assert.deepEqual(offenders, []);
});

test("the manifest declares exactly the two permissions the build uses", () => {
  const manifest = JSON.parse(
    readFileSync(join(extensionDir, "manifest.json"), "utf8"),
  );
  assert.deepEqual(manifest.permissions, ["bookmarks", "storage"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.background, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.manifest_version, 3);
});

const CONTROLLER = join("ui", "execution-controller.js");

test("the batch controller reaches the browser only through the adapters", () => {
  const source = code(join(extensionDir, CONTROLLER));
  assert.doesNotMatch(source, /\bchrome\s*\??\s*\./);
  assert.doesNotMatch(source, /\bdocument\s*\??\s*\./);
  assert.doesNotMatch(source, /getElementById|querySelector/);
});

test("the journal records the intent before the write is attempted", () => {
  const source = read(join(extensionDir, CONTROLLER));
  const start = source.indexOf("export async function runApply");
  assert.ok(start > 0, "runApply not found");
  const body = source.slice(start, source.indexOf("\n}\n", start));

  // Both write paths have to persist first, so each is measured on its own
  // marks. Searching the whole body for "markApplied(" would find the rename's
  // record and read it as proof about the move.
  const paths = [
    {
      what: "move",
      attempted: body.indexOf("markAttempted("),
      wrote: body.indexOf("performMove("),
      applied: body.lastIndexOf("markApplied("),
    },
    {
      what: "rename",
      attempted: body.indexOf("markUpdateAttempted("),
      wrote: body.indexOf("performRetitle("),
      applied: body.indexOf("markApplied("),
    },
  ];

  for (const path of paths) {
    assert.ok(path.attempted > 0, `${path.what} must persist through commit()`);
    // A crash between the write and the record would leave a change nobody can undo.
    assert.ok(
      path.attempted < path.wrote,
      `the ${path.what} intent must be persisted before the write`,
    );
    assert.ok(
      path.wrote < path.applied,
      `the ${path.what} must be confirmed before it is recorded`,
    );
  }
});

// The whole audited-body gate rests on slicing a function out of the file. On a
// CRLF checkout the "\n}\n" delimiter never matches, the slice runs to the end
// of the source, and every body assertion is then satisfied by some unrelated
// function further down — a silent full PASS. Pin the normalization with a
// literal source instead of trusting whatever endings the checkout has.
const CRLF_SAMPLE = [
  "export async function sampleWrite(id, destination) {",
  "  if (!bookmarksApiAvailable()) {",
  '    throw new LocalizedError("error.bookmarksUnavailable");',
  "  }",
  "  return chrome.bookmarks.move(id, destination);",
  "}",
  "",
  "export async function neighbour() {",
  "  return chrome.bookmarks.removeTree();",
  "}",
  "",
].join("\n");

test("the body scanner reads a CRLF source exactly as it reads an LF source", () => {
  const fromLf = bodyFromSource(CRLF_SAMPLE, "sampleWrite");
  const fromCrlf = bodyFromSource(
    CRLF_SAMPLE.replace(/\n/g, "\r\n"),
    "sampleWrite",
  );

  assert.equal(fromCrlf, fromLf);
  assert.match(
    fromLf,
    new RegExp(`${member("chrome", "bookmarks", "move")}\\s*\\(`),
  );
  // The neighbouring function must stay outside the slice in both encodings;
  // if it leaked in, its removeTree call would be attributed to sampleWrite.
  assert.ok(!fromLf.includes("removeTree"), "LF slice swallowed the neighbour");
  assert.ok(
    !fromCrlf.includes("removeTree"),
    "CRLF slice swallowed the neighbour",
  );
});

test("a violation planted in a body is caught in both line endings", () => {
  const tampered = CRLF_SAMPLE.replace(
    "chrome.bookmarks.move(id, destination)",
    "chrome.bookmarks.removeTree(id)",
  );
  const forbidden = FORBIDDEN.find(
    (rule) => rule.label === "recursive deletion",
  );

  for (const [label, source] of [
    ["lf", tampered],
    ["crlf", tampered.replace(/\n/g, "\r\n")],
  ]) {
    assert.match(
      bodyFromSource(source, "sampleWrite"),
      forbidden.pattern,
      `${label} source hid the planted update call`,
    );
  }
});

test("the content security policy allows no remote or inline code", () => {
  const manifest = JSON.parse(
    readFileSync(join(extensionDir, "manifest.json"), "utf8"),
  );
  const policy = manifest.content_security_policy?.extension_pages;
  assert.ok(policy, "extension_pages CSP must be declared explicitly");
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /object-src 'self'/);
  for (const forbidden of [
    "unsafe-eval",
    "unsafe-inline",
    "http:",
    "https:",
    "data:",
    "*",
  ]) {
    assert.ok(!policy.includes(forbidden), `CSP must not allow ${forbidden}`);
  }
  assert.equal(manifest.sandbox, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.externally_connectable, undefined);
});

test("the untrusted plan file is size-checked before it is read", () => {
  const source = readFileSync(
    join(extensionDir, "ui", "options.js"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const start = source.indexOf("async function loadPlan");
  assert.ok(start > 0, "loadPlan not found");
  const sizeCheck = source.indexOf("checkPlanFileSize(", start);
  const readCall = source.indexOf("readTextFile(file)", start);
  assert.ok(sizeCheck > 0, "loadPlan must check the file size");
  assert.ok(
    sizeCheck < readCall,
    "the size check must run before the file is read",
  );
});
