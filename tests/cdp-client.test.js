import assert from "node:assert/strict";
import test from "node:test";
import { connectCdp } from "../scripts/lib/cdp-client.mjs";

class FakeSocket {
  static OPEN = 1;
  static current;
  readyState = 1;
  sent = [];
  constructor() {
    FakeSocket.current = this;
    queueMicrotask(() => this.onopen());
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  reply(message) {
    this.onmessage({ data: JSON.stringify(message) });
  }
}

function useFakeSocket(context) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: FakeSocket,
  });
  context.after(() =>
    Object.defineProperty(globalThis, "WebSocket", descriptor),
  );
}

test("CDP matches response ids and ignores unrelated events", async (context) => {
  useFakeSocket(context);
  const client = connectCdp("ws://example.invalid", 1000);
  await client.ready;
  try {
    const first = client.send("Runtime.enable");
    const second = client.send("Page.enable");
    FakeSocket.current.reply({ method: "Runtime.event" });
    FakeSocket.current.reply({ id: 2, result: { second: true } });
    FakeSocket.current.reply({ id: 1, result: { first: true } });
    assert.deepEqual(await first, { first: true });
    assert.deepEqual(await second, { second: true });
  } finally {
    client.close();
  }
});

test("closing a CDP connection rejects outstanding work immediately", async (context) => {
  useFakeSocket(context);
  const client = connectCdp("ws://example.invalid", 1000);
  await client.ready;
  const pending = client.send("Runtime.evaluate");
  client.close();
  await assert.rejects(pending, /closed/);
  await assert.rejects(client.send("Runtime.enable"), /not open/);
});

test("CDP timeouts fail the command without needing another event", async (context) => {
  useFakeSocket(context);
  const client = connectCdp("ws://example.invalid", 10);
  await client.ready;
  try {
    await assert.rejects(client.send("Runtime.evaluate"), /timed out/);
  } finally {
    client.close();
  }
});

test("non-object CDP responses fail pending commands immediately", async (context) => {
  useFakeSocket(context);
  for (const invalid of [null, [], 42, "text"]) {
    const client = connectCdp("ws://example.invalid", 1000);
    await client.ready;
    const pending = client.send("Runtime.evaluate");
    FakeSocket.current.reply(invalid);
    await assert.rejects(pending, /Invalid CDP response/);
    await assert.rejects(client.send("Runtime.enable"), /not open/);
    client.close();
  }
});
