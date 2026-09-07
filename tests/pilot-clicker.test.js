import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { makeClicker } from "../scripts/lib/pilot-browser.mjs";

function page({ disabled = false, finish = true, keepDisabled = false } = {}) {
  let clicks = 0;
  const status = { dataset: { kind: "ok" } };
  const button = {
    disabled,
    click() {
      clicks += 1;
      status.dataset.kind = finish ? "ok" : "loading";
      button.disabled = !finish || keepDisabled;
    },
  };
  const document = {
    getElementById: (id) => (id === "load-tree" ? button : status),
  };
  const clickUntil = makeClicker(async (expression) =>
    runInNewContext(expression, { document }),
  );
  return { clickUntil, count: () => clicks };
}
const done = 'document.getElementById("tree-status").dataset.kind === "ok"';

test("an old successful status cannot skip the requested refresh", async () => {
  const fixture = page();
  await fixture.clickUntil("load-tree", done, "fresh tree", 1);
  assert.equal(fixture.count(), 1);
});

test("a disabled refresh button cannot succeed using an old status", async () => {
  const fixture = page({ disabled: true });
  await assert.rejects(
    fixture.clickUntil("load-tree", done, "fresh tree", 1),
    /timed out/,
  );
  assert.equal(fixture.count(), 0);
});

test("refresh must complete after the click, not merely have succeeded earlier", async () => {
  const fixture = page({ finish: false });
  await assert.rejects(
    fixture.clickUntil("load-tree", done, "fresh tree", 1),
    /timed out/,
  );
  assert.equal(fixture.count(), 1);
});

test("a successful status must also release the loading control lock", async () => {
  const fixture = page({ keepDisabled: true });
  await assert.rejects(
    fixture.clickUntil("load-tree", done, "fresh tree", 1),
    /timed out/,
  );
  assert.equal(fixture.count(), 1);
});
