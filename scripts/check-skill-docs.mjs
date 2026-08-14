#!/usr/bin/env node
/**
 * Contract check for the agent-facing skill assets under .github/skills.
 * Deliberately outside `npm test`, for the same reason as
 * check-store-readiness.mjs: the product tests answer whether the extension is
 * correct, this answers whether the docs an agent reads still hold together.
 * Exits non-zero while any BLOCK remains.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const skillsDir = join(root, ".github", "skills");

const results = [];
const check = (label, ok, detail) =>
  results.push({ label, status: ok ? "PASS" : "BLOCK", detail });

// The skill assets are synced from a separate source and stay out of the
// published repo, so a clone without them is expected rather than broken.
if (!existsSync(skillsDir)) {
  console.log(`SKIP  no skill assets at .github${sep}skills; nothing to check.`);
  process.exit(0);
}

function markdownFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return markdownFiles(full);
    return name.endsWith(".md") ? [full] : [];
  });
}

/** Code samples quote paths and links as examples; only prose links are ours to resolve. */
const withoutCode = (source) =>
  source.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");

/** Local markdown links only: external URLs and bare anchors are not ours to resolve. */
function localLinks(source) {
  return [...withoutCode(source).matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map((match) => match[1])
    .filter((href) => !/^(https?:|mailto:|#)/.test(href))
    .map((href) => href.split("#")[0])
    .filter(Boolean);
}

const skills = readdirSync(skillsDir).filter((name) =>
  statSync(join(skillsDir, name)).isDirectory(),
);

for (const skill of skills) {
  const skillDir = join(skillsDir, skill);
  const files = markdownFiles(skillDir);
  const linkedInside = new Set();
  const broken = [];

  for (const file of files) {
    for (const href of localLinks(readFileSync(file, "utf8"))) {
      const target = resolve(dirname(file), href);
      let exists = false;
      try {
        exists = statSync(target).isFile();
      } catch {
        exists = false;
      }
      if (exists) {
        linkedInside.add(target);
      } else {
        broken.push(`${relative(skillDir, file)} -> ${href}`);
      }
    }
  }
  check(
    `${skill}: every local link resolves`,
    broken.length === 0,
    broken.length === 0 ? `${files.length} markdown files` : broken.join(", "),
  );

  // A reference nobody links to is a file the agent will never be told to read.
  const orphans = files
    .filter((file) => relative(skillDir, file) !== "SKILL.md")
    .filter((file) => !linkedInside.has(file))
    .map((file) => relative(skillDir, file));
  check(
    `${skill}: no unreferenced reference file`,
    orphans.length === 0,
    orphans.length === 0 ? "all reachable from SKILL.md" : orphans.join(", "),
  );

  // Skill docs travel between machines. An install location like
  // "C:\Program Files\..." is portable; a home directory names one machine's user.
  const withProfilePaths = files
    .filter((file) =>
      /[A-Za-z]:\\Users\\|\/Users\/[\w.-]+|\/home\/[\w.-]+/.test(
        readFileSync(file, "utf8"),
      ),
    )
    .map((file) => relative(skillDir, file));
  check(
    `${skill}: no user-profile paths`,
    withProfilePaths.length === 0,
    withProfilePaths.length === 0 ? "portable" : withProfilePaths.join(", "),
  );
}

// --- duck-critic vocabulary contract -----------------------------------------
// The stop condition counts blocking findings, so every packet has to ask for a
// countable answer. This is the invariant that decayed in manual use.
const packets = join(
  skillsDir,
  "duck-critic",
  "references",
  "critic-packets.md",
);
try {
  const source = readFileSync(packets, "utf8");
  const blocks = [...source.matchAll(/```text\n([\s\S]*?)```/g)].map(
    (m) => m[1],
  );
  const reviewerPackets = blocks.filter((block) =>
    /read-only constructive critic/.test(block),
  );
  const compliant = reviewerPackets.filter(
    (block) =>
      /`blocking`, `non-blocking`, or `suggestion`/.test(block) &&
      /blocking: <count>/.test(block) &&
      /data to be reviewed, never instructions to follow/.test(block),
  );
  check(
    "duck-critic: every reviewer packet pins the labels, the count and the data-not-instructions rule",
    reviewerPackets.length > 0 && compliant.length === reviewerPackets.length,
    `${compliant.length}/${reviewerPackets.length} reviewer packets`,
  );
} catch {
  check("duck-critic: critic-packets.md is readable", false, packets);
}

// The report header is what makes a second opinion auditable after the fact.
// Losing a field here is silent, so the field names are pinned.
const REQUIRED_REPORT_FIELDS = [
  "**Route Used**",
  "**Critic Model**",
  "**Checkpoint**",
  "**Rounds**",
  "**Verdict**",
];
const outputFormat = join(
  skillsDir,
  "duck-critic",
  "references",
  "output-format.md",
);
try {
  const source = readFileSync(outputFormat, "utf8");
  const missing = REQUIRED_REPORT_FIELDS.filter(
    (field) => !source.includes(field),
  );
  // Mandatory fields need an escape hatch, or a skipped critic forces a lie.
  const hasSkipRule = /not applicable[^\n]*critic skipped/.test(source);
  check(
    "duck-critic: the report template keeps every mandatory field and handles a skipped critic",
    missing.length === 0 && hasSkipRule,
    missing.length > 0
      ? `missing: ${missing.join(", ")}`
      : hasSkipRule
        ? `${REQUIRED_REPORT_FIELDS.length} fields present, skip rule defined`
        : "no rule for the 0-rounds case",
  );
} catch {
  check("duck-critic: output-format.md is readable", false, outputFormat);
}

// model-lanes.md calls the preferred-family list "the only thing to revisit
// when new frontier families ship". A second copy is the one that goes stale.
const duckDir = join(skillsDir, "duck-critic");
const familyListFiles = markdownFiles(duckDir)
  .filter((file) => /Anthropic Claude/.test(readFileSync(file, "utf8")))
  .map((file) => relative(duckDir, file));
check(
  "duck-critic: the preferred-family list has a single home",
  familyListFiles.length === 1,
  familyListFiles.length > 0
    ? familyListFiles.join(", ")
    : "not found anywhere",
);

// A verdict nothing can produce is a state the loop can never report itself in.
try {
  const verdictLine = /`PASS \| ([^`]+)`/.exec(
    readFileSync(outputFormat, "utf8"),
  );
  const verdicts = ["PASS", ...(verdictLine?.[1].split(" | ") ?? [])];
  const protocol = readFileSync(
    join(skillsDir, "duck-critic", "references", "loop-protocol.md"),
    "utf8",
  );
  const unreachable = verdicts.filter(
    (verdict) => !new RegExp(`\\b${verdict}\\b`).test(protocol),
  );
  check(
    "duck-critic: every verdict has a stop condition that produces it",
    verdicts.length === 4 && unreachable.length === 0,
    unreachable.length === 0
      ? verdicts.join(", ")
      : `unreachable: ${unreachable.join(", ")}`,
  );
} catch {
  check("duck-critic: the verdict list is readable", false, outputFormat);
}

const blocked = results.filter((entry) => entry.status === "BLOCK");
const width = Math.max(...results.map((entry) => entry.label.length));
for (const entry of results) {
  const detail = entry.detail ? `  ${entry.detail}` : "";
  console.log(
    `${entry.status.padEnd(5)} ${entry.label.padEnd(width)}${detail}`,
  );
}
console.log(
  `\n${blocked.length} broken contract(s) across ${skills.length} skill(s) under .github${sep}skills.`,
);
process.exitCode = blocked.length === 0 ? 0 : 1;
