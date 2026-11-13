import test from "node:test";
import assert from "node:assert/strict";
import { MockHandicapProvider } from "../src/providers/mock-provider.js";
import { SpicyGolfProvider } from "../src/providers/spicygolf-provider.js";
const context = { subject: "synthetic-owner" };
test("mock only answers fixed synthetic fixtures, deduplicates, and preserves plus indexes", async () => {
  const provider = new MockHandicapProvider();
  const result = await provider.getMany(context, [
    "900000001",
    "900000001",
    "900000005",
    "123456789",
  ]);
  assert.equal(result.length, 3);
  assert.equal(result[0]!.ok, true);
  const plus = result[1]!;
  assert.equal(plus.ok, true);
  if (plus.ok) {
    assert.equal(plus.data.handicapIndex, -0.9);
    assert.equal(plus.data.display, "+0.9");
    assert.equal(plus.data.synthetic, true);
    assert.equal(plus.data.source, "mock");
  }
  const missing = result[2]!;
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, "NOT_FOUND");
  assert.equal(provider.capabilities.live, false);
});
test("mock history/scores are bounded and unknown identities never receive fabricated data", async () => {
  const provider = new MockHandicapProvider();
  assert.equal((await provider.getHistory(context, "900000001", 1)).length, 1);
  assert.equal((await provider.getScores(context, "900000001", 1)).length, 1);
  await assert.rejects(provider.getHistory(context, "123456789", 10), {
    code: "NOT_FOUND",
  });
  await assert.rejects(provider.getScores(context, "123456789", 10), {
    code: "NOT_FOUND",
  });
  await assert.rejects(
    provider.getMany(context, ["900000001"], { updatedSince: "2026-10-01" }),
    { code: "UNSUPPORTED" },
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    provider.getMany(context, ["900000001"], { signal: controller.signal }),
    { code: "UNAVAILABLE" },
  );
});
test("SpicyGolf adapter rejects every live read without invoking fetch", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("Network forbidden in this test");
  };
  try {
    const provider = new SpicyGolfProvider();
    assert.equal(provider.capabilities.live, false);
    await assert.rejects(provider.getMany(context, ["900000001"]), {
      code: "LIVE_ACCESS_DISABLED",
    });
    await assert.rejects(provider.getHistory(context, "900000001", 10), {
      code: "LIVE_ACCESS_DISABLED",
    });
    await assert.rejects(provider.getScores(context, "900000001", 10), {
      code: "LIVE_ACCESS_DISABLED",
    });
    await provider.disconnect(context);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = original;
  }
});
