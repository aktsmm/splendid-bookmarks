import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DEFAULT_LOCALE, MESSAGES } from "../extension/src/core/messages.js";
import { CONTROL_IDS } from "../extension/src/core/ui-state.js";

const uiDir = fileURLToPath(new URL("../extension/ui/", import.meta.url));
// Sources are CRLF on Windows; normalize so offset-based checks stay meaningful.
const read = (name) =>
  readFileSync(join(uiDir, name), "utf8").replace(/\r\n/g, "\n");

const PAGES = [
  { script: "options.js", markup: "options.html" },
  { script: "popup.js", markup: "popup.html" },
];

function matchAll(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function declaredIds(markup) {
  return new Set(matchAll(markup, /\bid="([\w-]+)"/g));
}

function referencedIds(script) {
  return new Set([
    ...matchAll(script, /\bel\(\s*"([\w-]+)"\s*\)/g),
    ...matchAll(script, /getElementById\(\s*"([\w-]+)"\s*\)/g),
  ]);
}

/** Static message keys reachable from the page scripts. */
function referencedKeys(script) {
  return new Set([
    ...matchAll(script, /\bt\(\s*"([^"]+)"/g),
    ...matchAll(script, /\bsetStatus\(\s*"[\w-]+"\s*,\s*"([^"]+)"/g),
  ]);
}

for (const { script, markup } of PAGES) {
  test(`${script} only touches element ids that ${markup} declares`, () => {
    const ids = declaredIds(read(markup));
    const used = referencedIds(read(script));
    assert.ok(used.size > 0, `${script} referenced no ids`);
    assert.deepEqual(
      [...used].filter((id) => !ids.has(id)),
      [],
    );
  });

  test(`${script} only uses message keys that exist in the catalog`, () => {
    for (const key of referencedKeys(read(script))) {
      assert.ok(
        MESSAGES[DEFAULT_LOCALE][key],
        `${script} uses missing message key: ${key}`,
      );
    }
  });

  test(`every label in ${markup} points at an existing control`, () => {
    const ids = declaredIds(read(markup));
    for (const target of matchAll(
      read(markup),
      /<label[^>]*\bfor="([\w-]+)"/g,
    )) {
      assert.ok(ids.has(target), `label points at missing id: ${target}`);
    }
  });

  test(`every form control in ${markup} has an accessible name`, () => {
    const source = read(markup);
    const labelled = new Set(matchAll(source, /<label[^>]*\bfor="([\w-]+)"/g));
    for (const [tag] of source.matchAll(/<(input|select|textarea)\b[^>]*>/g)) {
      const id = /\bid="([\w-]+)"/.exec(tag)?.[1];
      const named =
        (id && labelled.has(id)) || /aria-label(?:ledby)?=/.test(tag);
      assert.ok(named, `control without an accessible name: ${tag}`);
    }
  });
}

test("the dynamic message key families are complete", () => {
  const required = [
    "browser.edge",
    "browser.chrome",
    "browser.other",
    "duplicates.mode.normalized",
    "duplicates.mode.exact",
  ];
  for (const key of required) {
    assert.ok(MESSAGES[DEFAULT_LOCALE][key], `missing ${key}`);
  }
});

test("loadTree commits its derived state without an await in between", () => {
  const script = read("options.js");
  const anchors = [
    "state.entries = entries;",
    "state.browser = browser;",
    "state.treeDigest = treeDigest;",
  ].map((anchor) => {
    const index = script.indexOf(anchor);
    assert.ok(index > 0, `missing commit anchor: ${anchor}`);
    return index;
  });
  const start = Math.min(...anchors);
  const end = script.indexOf("renderTreeSummary();", Math.max(...anchors));
  assert.ok(end > start, "could not locate the commit block");

  // An await inside this block would let a handoff export pair the new entries
  // with the previous treeDigest, in any assignment order.
  assert.doesNotMatch(script.slice(start, end), /\bawait\b/);
});

test("every async status writer is guarded against a superseded result", () => {
  const script = read("options.js");
  const bodies = script.split(/\basync function /).slice(1);
  const writers = bodies.filter(
    (body) =>
      body.includes("await ") &&
      body.includes("setStatus(") &&
      // The function that bumps the generation is the authority, not a consumer.
      !body.includes("state.generation += 1"),
  );
  assert.ok(
    writers.length >= 4,
    `expected several writers, got ${writers.length}`,
  );

  const CHECK =
    /(isCurrentExport\([^)]*\)|\w+ !== state\.(generation|planSeq|trashSeq))/;
  for (const body of writers) {
    const name = body.slice(0, body.indexOf("("));
    const firstAwait = body.indexOf("await ");
    assert.ok(firstAwait > 0, `${name} has no await`);

    // try and catch are separate control-flow branches: each needs its own check.
    const catchAt = body.indexOf("} catch (");
    const regions = [
      {
        label: "try",
        text: body.slice(firstAwait, catchAt > 0 ? catchAt : body.length),
      },
      { label: "catch", text: catchAt > 0 ? body.slice(catchAt) : "" },
    ];

    for (const region of regions) {
      const write = region.text.indexOf("setStatus(");
      if (write < 0) continue;
      assert.match(
        region.text.slice(0, write),
        CHECK,
        `${name} writes a status in its ${region.label} branch without a supersession check`,
      );
    }
  }
});

test("a rebuilt panel does not throw the keyboard user back to the top", () => {
  const script = read("options.js");
  // Both panels are rebuilt with replaceChildren on every click, which destroys
  // the focused control. 200 selections means 200 lost positions without this.
  for (const [fn, render] of [
    ["function toggleSelection", "renderBuilder()"],
    ["function pickKeeper", "renderDuplicates()"],
  ]) {
    const start = script.indexOf(fn);
    assert.ok(start > 0, `${fn} is missing`);
    const body = script.slice(start, script.indexOf("\n}\n", start));
    assert.match(body, /restoreFocus\(/, fn);
    // Restoring before the rebuild would be silently useless.
    assert.ok(
      body.indexOf("restoreFocus(") > body.indexOf(render),
      `${fn} must restore focus after ${render}`,
    );
  }
  const helper = script.slice(
    script.indexOf("function restoreFocus"),
    script.indexOf("\n}\n", script.indexOf("function restoreFocus")),
  );
  assert.match(helper, /data-id/);
  // The id comes from the tree, so it is escaped before entering a selector.
  assert.match(helper, /CSS\.escape/);

  const dom = read("dom.js");
  for (const list of ["function checkList", "function keepList"]) {
    const start = dom.indexOf(list);
    assert.match(
      dom.slice(start, dom.indexOf("\n}\n", start)),
      /box\.dataset\.id = item\.id/,
      list,
    );
  }
});

test("an operation that locks the page hands focus to its result", () => {
  const script = read("options.js");
  const markup = read("options.html");
  // The button that started the run was disabled while it ran, so focus was
  // already gone by the time the result was written.
  for (const fn of [
    "async function loadTree",
    "async function applyMoves",
    "async function verifyResult",
    "async function rollbackBatch",
    "async function runRestoreNow",
  ]) {
    const start = script.indexOf(fn);
    assert.ok(start > 0, `${fn} is missing`);
    assert.match(
      script.slice(start, script.indexOf("\n}\n", start)),
      /focusResult\("[\w-]+"\)/,
      fn,
    );
  }
  // A status node is not focusable without this.
  for (const id of ["tree-status", "apply-status", "restore-status"]) {
    assert.match(
      markup,
      new RegExp(`id="${id}"[^>]*tabindex="-1"`),
      `${id} must be focusable`,
    );
  }
});

test("the duplicate count is never overwritten by the pick prompt", () => {
  const script = read("options.js");
  const start = script.indexOf("function renderDuplicates");
  const body = script.slice(start, script.indexOf("\n}\n", start));

  // The count is what the user pressed the button for, so there is exactly one
  // status write and it always carries the numbers, whichever condition is
  // still blocking the send.
  const statusWrites = [...body.matchAll(/setStatus\(\s*"duplicates-status"/g)];
  assert.equal(statusWrites.length, 1, "the summary must be the only status");
  for (const key of [
    "duplicates.status.summaryPick",
    "duplicates.status.summaryDestination",
    "duplicates.summary",
  ]) {
    assert.match(body, new RegExp(`"${key.replace(/\./g, "\\.")}"`), key);
  }
  assert.match(body, /t\("duplicates\.none"\)/);
});

test("applyControlState maps state to the pure rules without inverting them", () => {
  const script = read("options.js");
  const start = script.indexOf("function applyControlState");
  const end = script.indexOf("\n}\n", start);
  const body = script.slice(start, end);

  assert.match(body, /loading: state\.loading,/);
  assert.match(body, /hasTree: state\.entries !== null,/);
  assert.match(body, /hasPlan: state\.plan !== null,/);
  assert.match(body, /mode: state\.mode,/);
  assert.match(body, /backupVerified: state\.backupDigest !== null,/);
  assert.match(body, /hasApproval: state\.approval !== null,/);
  assert.match(body, /hasJournal: state\.journal !== null,/);
  assert.match(body, /hasRestoreCandidate: state\.restoreCandidate !== null,/);
  assert.match(body, /hasDuplicateReport: state\.views\.duplicates !== null,/);
  assert.match(body, /hasKeeper: state\.duplicateKeep\.size > 0,/);
});

test("every change to what a manual plan contains retires that plan", () => {
  const script = read("options.js");
  const retire = script.slice(
    script.indexOf("function retireManualPlan"),
    script.indexOf("\n}\n", script.indexOf("function retireManualPlan")),
  );
  // A file plan is independent input: the selection does not describe it.
  assert.match(retire, /state\.planSource !== "manual"/);
  assert.match(retire, /state\.approval|refreshApproval\(\)/);
  assert.match(retire, /state\.dryRunRows = null/);

  const bump = script.slice(
    script.indexOf("function bumpBuilderRev"),
    script.indexOf("\n}\n", script.indexOf("function bumpBuilderRev")),
  );
  assert.match(bump, /state\.builderRev \+= 1/);
  assert.match(bump, /retireManualPlan\(\)/);

  // The selection and the destination are the two inputs to a manual plan.
  for (const caller of [
    "function toggleSelection",
    "function clearSelection",
    "function sendDuplicates",
  ]) {
    const start = script.indexOf(caller);
    assert.ok(start > 0, `${caller} is missing`);
    assert.match(
      script.slice(start, script.indexOf("\n}\n", start)),
      /bumpBuilderRev\(\)/,
      caller,
    );
  }
  // Changing the destination changes the plan just as much as the selection.
  const destinationListener = script.slice(
    script.indexOf('el("builder-destination").addEventListener("change"'),
  );
  assert.match(
    destinationListener.slice(0, destinationListener.indexOf("});") + 3),
    /bumpBuilderRev\(\)|bumpBuilderRev\)/,
  );
});

test("a plan built before the builder moved cannot commit after it", () => {
  const script = read("options.js");
  const start = script.indexOf("async function buildPlan");
  const body = script.slice(start, script.indexOf("\n}\n", start));

  // The digest is awaited, so the selection and destination can both change
  // underneath a build that already read them.
  assert.match(body, /const rev = state\.builderRev;/);
  assert.match(body, /rev !== state\.builderRev/);
  assert.ok(
    body.indexOf("rev !== state.builderRev") > body.indexOf("await sha256Hex"),
    "the revision must be re-checked after the digest, not before",
  );
});

test("a batch larger than the cap can never be approved", () => {
  const script = read("options.js");
  const start = script.indexOf("function renderDryRun");
  const body = script.slice(start, script.indexOf("\n}\n", start));

  assert.match(body, /MAX_BATCH_OPERATIONS/);
  // The rows must be withheld, not merely reported: the approval is built from them.
  assert.match(body, /state\.dryRunRows =[\s\S]{0,80}!tooLarge/);
});

test("sending duplicates never guesses which copy to keep", () => {
  const script = read("options.js");
  const start = script.indexOf("function sendDuplicates");
  const body = script.slice(start, script.indexOf("\n}\n", start));

  // The keeper map is the only source; an empty map yields an empty selection.
  assert.match(body, /keepByKey: state\.duplicateKeep/);
  assert.match(body, /alreadySelected: state\.builderSelection/);
  assert.match(
    body,
    /remainingCapacity: MAX_BATCH_OPERATIONS - state\.builderSelection\.size/,
  );
  assert.equal(/chrome\.bookmarks/.test(body), false);
});

test("a copy chosen as the keeper is never left in the move selection", () => {
  const script = read("options.js");
  // Ticking a bookmark and then choosing it as the keeper would otherwise move
  // the one copy the user asked to keep.
  const pick = script.slice(
    script.indexOf("function pickKeeper"),
    script.indexOf("\n}\n", script.indexOf("function pickKeeper")),
  );
  assert.match(pick, /state\.builderSelection\.delete\(memberId\)/);
  assert.match(pick, /bumpBuilderRev\(\)/);

  const send = script.slice(
    script.indexOf("function sendDuplicates"),
    script.indexOf("\n}\n", script.indexOf("function sendDuplicates")),
  );
  assert.match(
    send,
    /state\.duplicateKeep\.values\(\)[\s\S]{0,120}state\.builderSelection\.delete/,
  );

  // The reverse direction too: ticking a keeper in the builder must withdraw it
  // as the keeper, or the two sections would disagree with no signal.
  const toggle = script.slice(
    script.indexOf("function toggleSelection"),
    script.indexOf("\n}\n", script.indexOf("function toggleSelection")),
  );
  assert.match(toggle, /withdrawKeeper\(id\)/);
  const withdraw = script.slice(
    script.indexOf("function withdrawKeeper"),
    script.indexOf("\n}\n", script.indexOf("function withdrawKeeper")),
  );
  assert.match(withdraw, /state\.duplicateKeep\.delete\(key\)/);
});

test("a journal with unresolved moves blocks a fresh Apply", () => {
  const script = read("options.js");
  const start = script.indexOf("async function applyMoves");
  const body = script.slice(start, script.indexOf("\n}\n", start));

  // A crash between the move and its journal entry leaves an `attempted` entry
  // that is the only record of a move that already happened. Starting a new
  // batch would save a new journal over it.
  const guard = body.slice(0, body.indexOf("createJournal"));
  assert.match(guard, /appliedEntries\(state\.journal\)\.length > 0/);
  assert.match(guard, /attemptedEntries\(state\.journal\)\.length > 0/);
  assert.match(guard, /apply\.reject\.batchPending/);
});

test("the builder renders the whole selection before it renders the filtered list", () => {
  const script = read("options.js");
  const start = script.indexOf("function renderBuilder");
  const end = script.indexOf("\n}\n", start);
  const body = script.slice(start, end);

  // A selection hidden by the scope or the filter would still move, and the
  // user could not untick what they cannot see.
  const selection = body.indexOf("selectedEntries(state.builderSelection");
  const candidates = body.indexOf("selectableEntries(");
  assert.ok(selection > 0, "renderBuilder must resolve the full selection");
  assert.ok(candidates > selection, "the selection must be listed first");
});

test("a hand-picked plan does not outlive the tree it describes", () => {
  const script = read("options.js");
  const start = script.indexOf("function resetDerivedViews");
  const body = script.slice(start, script.indexOf("\n}\n", start));

  // The generation guard cannot cover a build that resolves after the reload
  // starts but before it commits, so the reload drops the plan by provenance.
  assert.match(body, /state\.planSource === "manual"/);
  assert.ok(
    script.includes('state.planSource = "manual";'),
    "buildPlan must record the provenance it is dropped by",
  );
  assert.ok(
    script.includes('state.planSource = "file";'),
    "loadPlan must record provenance so a file plan is kept",
  );
});

test("a built plan is discarded when the tree it was built from is replaced", () => {
  const script = read("options.js");
  const start = script.indexOf("async function buildPlan");
  const body = script.slice(start, script.indexOf("\n}\n", start));
  const guard = body.indexOf("generation !== state.generation");
  const adopt = body.indexOf("state.plan = plan;");

  // Without this the selection UI can be empty while a plan built from the
  // previous tree is adopted and dry-run against the new one.
  assert.ok(guard > 0, "buildPlan must check the tree generation");
  assert.ok(guard < adopt, "the check must run before the plan is adopted");
});

test("a tree reload retires the approval it was bound to", () => {
  const script = read("options.js");
  const start = script.indexOf("function resetDerivedViews");
  const end = script.indexOf("\n}\n", start);
  const body = script.slice(start, end);

  // An approval outlives its tree only if it is cleared here.
  for (const cleared of [
    "state.dryRunRows = null;",
    "state.approval = null;",
    "state.backupDigest = null;",
    "state.expectedBackupDigest = null;",
  ]) {
    assert.ok(body.includes(cleared), `resetDerivedViews must run ${cleared}`);
  }
});

test("every control the state machine decides exists in the page", () => {
  const ids = declaredIds(read("options.html"));
  for (const id of CONTROL_IDS) {
    assert.ok(ids.has(id), `options.html declares no control with id ${id}`);
  }
});

test("generated table headers are associated with their column", () => {
  const dom = read("dom.js");
  const start = dom.indexOf("export function table");
  const end = dom.indexOf("\n}\n", start);
  assert.ok(end > start, "could not delimit the table helper");
  assert.match(dom.slice(start, end), /\.scope = "col";/);
});

test("panels do not skip a heading level below their section h2", () => {
  const script = read("options.js");
  const generated = [...script.matchAll(/text\(\s*"(h[1-6])"/g)].map(
    (match) => match[1],
  );
  assert.ok(generated.length > 0, "no generated headings found");
  // Sections use h2, so the first generated level inside a panel must be h3.
  assert.deepEqual([...new Set(generated)], ["h3"]);
});

test("digests and byte counts reach the UI through the formatters", () => {
  const script = read("options.js");
  const shown = [...script.matchAll(/\b(?:digest|bytes):[^,\n]*/g)].map(
    (match) => match[0],
  );
  assert.ok(shown.length >= 5, `expected several sites, found ${shown.length}`);
  for (const call of shown) {
    const [name] = call.split(":");
    assert.match(
      call,
      name === "digest" ? /formatDigest\(/ : /formatBytes\(/,
      `raw value shown to the user: ${call.trim()}`,
    );
  }
});

test("counts rendered into tables go through the locale formatter", () => {
  const script = read("options.js");
  const raw = [
    ...script.matchAll(
      /String\(\s*(?:[^)\n]*\.length|countUrls\(|Math\.max\(|count\b)/g,
    ),
  ].map((match) => match[0]);
  assert.deepEqual(raw, [], "numeric values must use formatCount");
  assert.ok(
    script.includes("formatCount("),
    "options.js never formats a count",
  );
});

test("only applyControlState writes the disabled flag", () => {
  const script = read("options.js");
  const writes = [...script.matchAll(/\.disabled\s*=/g)].map(
    (match) => match.index,
  );
  assert.ok(writes.length > 0, "no disabled assignment found");

  const start = script.indexOf("function applyControlState");
  const end = script.indexOf("\n}\n", start);
  assert.ok(start > 0 && end > start, "applyControlState not found");

  // Scattered assignments are what the pure state machine replaced.
  for (const index of writes) {
    assert.ok(
      index > start && index < end,
      `disabled written outside applyControlState at offset ${index}`,
    );
  }
});

test("the generation owner guards against re-entry instead", () => {
  const script = read("options.js");
  const start = script.indexOf("async function loadTree");
  assert.ok(start > 0, "loadTree not found");
  const end = script.indexOf("\n}\n", start);
  assert.ok(end > start, "could not delimit the loadTree body");
  const body = script.slice(start, end);

  assert.match(body, /if \(state\.loading\) return;/);
  assert.match(body, /state\.loading = true;/);
  assert.match(body, /state\.loading = false;/);
  assert.ok(
    body.indexOf("if (state.loading) return;") < body.indexOf("await "),
    "the re-entrancy check must run before the first await",
  );
});

test("no :empty rule hides a control whose content comes from .value", () => {
  // Drop at-rule preludes first so nested blocks are inspected too.
  const css = read("styles.css").replace(/@[\w-]+[^{]*\{/g, "");
  const selectors = css
    .split("}")
    .map((block) => block.split("{")[0].trim())
    .filter(Boolean);
  const offenders = selectors.filter(
    (selector) =>
      selector.includes(":empty") &&
      /textarea|input|select|\.agent-output/.test(selector),
  );
  // A textarea populated through `.value` keeps zero child nodes, so `:empty`
  // would hide it forever.
  assert.deepEqual(offenders, []);
});
