import test from "node:test";
import assert from "node:assert/strict";
import { SpicyGolfProvider } from "../src/providers/spicygolf-provider.js";
import { createOfflineSpicyGolfProvider } from "../src/providers/spicygolf-fixtures.js";
import type {
  SpicyGolfFixtureClient,
  SpicyGolfResult,
} from "../src/providers/spicygolf-contract.js";
const owner = { subject: "offline-owner" };
const ids = ["900000001", "900000002", "900000003", "900000004", "900000005"];
const row = (id: string, extra: Record<string, unknown> = {}) => ({
  ghin: Number(id),
  hi_display: "12.4",
  hi_value: 12.4,
  handicap_index: 12.4,
  rev_date: new Date("2026-10-01T00:00:00Z"),
  ...extra,
});
const ok = (golfers: unknown[], missing: number[] = []): SpicyGolfResult => ({
  isErr: () => false,
  value: { golfers, missing },
});
const err = (error: unknown): SpicyGolfResult => ({ isErr: () => true, error });
function fixture(
  handler: (
    numbers: number[],
    request: { status: null; updated_since?: string },
  ) => Promise<SpicyGolfResult> | SpicyGolfResult,
  options: Partial<{
    allowNames: boolean;
    batchSize: number;
    timeoutMs: number;
  }> = {},
) {
  const calls: {
    numbers: number[];
    request: { status: null; updated_since?: string };
  }[] = [];
  const client: SpicyGolfFixtureClient = {
    fixtureOnly: true,
    golfers: {
      async getMany(numbers, request) {
        calls.push({ numbers, request });
        return handler(numbers, request);
      },
    },
  };
  return {
    calls,
    client,
    provider: new SpicyGolfProvider({
      mode: "offline-fixture",
      ownerSubject: owner.subject,
      client,
      now: () => new Date("2026-10-29T15:00:00Z"),
      ...options,
    }),
  };
}
const code = (
  value: Awaited<ReturnType<SpicyGolfProvider["getMany"]>>[number],
) => (value.ok ? "OK" : value.error.code);

test("offline batches deduplicate and preserve requested order with whitelisted synthetic metadata", async () => {
  const secret = "SYNTHETIC_SECRET_DO_NOT_RETURN";
  const f = fixture(
    (numbers) =>
      ok(
        [...numbers].reverse().map((n) =>
          row(String(n), {
            first_name: "Demo",
            last_name: "Fixture",
            token: secret,
            password: secret,
            source: secret,
            synthetic: false,
          }),
        ),
      ),
    { batchSize: 2 },
  );
  const values = await f.provider.getMany(owner, [
    ids[0]!,
    ids[1]!,
    ids[0]!,
    ids[2]!,
  ]);
  assert.deepEqual(
    f.calls.map((x) => x.numbers),
    [[900000001, 900000002], [900000003]],
  );
  assert.deepEqual(
    values.map((v) => (v.ok ? v.data.ghinNumber : v.ghinNumber)),
    ids.slice(0, 3),
  );
  for (const value of values) {
    assert.equal(value.ok, true);
    if (value.ok) {
      assert.equal(value.data.source, "spicygolf-offline");
      assert.equal(value.data.synthetic, true);
      assert.equal(value.data.name, undefined);
      assert.equal(value.data.effectiveDate, "2026-10-01");
      assert.equal(value.data.retrievedAt, "2026-10-29T15:00:00.000Z");
    }
  }
  assert(!JSON.stringify(values).includes(secret));
  assert.equal(f.provider.capabilities.live, false);
  assert.equal(f.calls[0]!.request.status, null);
});

test("plus sign, modified index and scratch normalize without turning unavailable into zero", async () => {
  const cases = [
    { hi_display: "+0.9", hi_value: 0.9, handicap_index: 0.9 },
    { hi_display: "+0.9M", hi_value: -0.9, handicap_index: "0.9M" },
    { hi_display: "0.0", hi_value: 0, handicap_index: 0 },
    { hi_display: "NH", hi_value: null, handicap_index: null },
    { hi_display: "WD", hi_value: 999, handicap_index: null },
    { hi_display: "12.4", hi_value: null, handicap_index: 12.4 },
    { hi_display: "12.4", hi_value: 999, handicap_index: 12.4 },
  ];
  const numbers = cases.map((_, i) => String(900000001 + i));
  const f = fixture(() => ok(cases.map((c, i) => row(numbers[i]!, c))));
  const values = await f.provider.getMany(owner, numbers);
  assert.deepEqual(values.map(code), [
    "OK",
    "OK",
    "OK",
    "NO_HANDICAP",
    "NO_HANDICAP",
    "NO_HANDICAP",
    "NO_HANDICAP",
  ]);
  assert.equal(values[0]!.ok && values[0]!.data.handicapIndex, -0.9);
  assert.equal(values[1]!.ok && values[1]!.data.display, "+0.9M");
  assert.equal(values[2]!.ok && values[2]!.data.handicapIndex, 0);
  assert(!values[4]!.ok && values[4]!.error.message.includes("withdrawn"));
});

test("conflicting magnitudes, negative normal display, absent sign evidence and invalid dates fail closed", async () => {
  const changes = [
    { hi_value: 13 },
    { hi_display: "12.4", hi_value: -12.4 },
    { hi_display: undefined },
    { rev_date: "2026-02-30" },
    { hi_display: "-0.9", hi_value: -0.9 },
    { hi_display: "12.4", handicap_index: NaN },
    { hi_display: "12.4", hi_value: "" },
  ];
  const numbers = changes.map((_, i) => String(900000001 + i));
  const f = fixture(() =>
    ok(changes.map((extra, i) => row(numbers[i]!, extra))),
  );
  assert.deepEqual((await f.provider.getMany(owner, numbers)).map(code), [
    "UNAVAILABLE",
    "UNAVAILABLE",
    "UNAVAILABLE",
    "UNAVAILABLE",
    "UNAVAILABLE",
    "UNAVAILABLE",
    "NO_HANDICAP",
  ]);
});

test("identity collisions, absent identifiers and found/missing contradictions cannot assign another golfer", async () => {
  const f = fixture(() =>
    ok(
      [
        row(ids[0]!),
        row(ids[0]!, { is_home_club: true }),
        row(ids[1]!),
        row(ids[2]!, { ghin: null }),
        row("900000099"),
      ],
      [900000002],
    ),
  );
  const values = await f.provider.getMany(owner, ids.slice(0, 3));
  assert.deepEqual(values.map(code), [
    "UNAVAILABLE",
    "UNAVAILABLE",
    "UNAVAILABLE",
  ]);
  assert(!JSON.stringify(values).includes("900000099"));
});

test("explicit plus text conflicting with a normal display is never accepted", async () => {
  const f = fixture(() =>
    ok([row(ids[0]!, { hi_display: "12.4", handicap_index: "+12.4" })]),
  );
  const values = await f.provider.getMany(owner, [ids[0]!]);
  assert.equal(code(values[0]!), "UNAVAILABLE");
});

test("delta and full omissions remain unverified, not unchanged or definitive not-found", async () => {
  const f = fixture(() => ok([row(ids[0]!)], [900000002]));
  const delta = await f.provider.getMany(owner, ids.slice(0, 2), {
    updatedSince: "2026-09-01",
  });
  assert.deepEqual(delta.map(code), ["OK", "UNAVAILABLE"]);
  assert.equal(f.calls[0]!.request.updated_since, "2026-09-01");
  assert.deepEqual(
    (await f.provider.getMany(owner, ids.slice(0, 2))).map(code),
    ["OK", "UNAVAILABLE"],
  );
});

test("a failed chunk preserves successes and continues later transient chunks exactly once", async () => {
  const f = fixture(
    (numbers) =>
      numbers[0] === 900000002
        ? err({
            code: "NETWORK_ERROR",
            statusCode: 503,
            message: "SYNTHETIC_SECRET",
          })
        : ok(numbers.map((n) => row(String(n)))),
    { batchSize: 1 },
  );
  const values = await f.provider.getMany(owner, ids.slice(0, 3));
  assert.deepEqual(values.map(code), ["OK", "UNAVAILABLE", "OK"]);
  assert.equal(f.calls.length, 3);
  assert(!JSON.stringify(values).includes("SYNTHETIC_SECRET"));
});

test("auth expiry, forbidden and rate limits stop further chunks and redact library internals", async () => {
  for (const upstream of [
    { code: "AUTHENTICATION_ERROR", statusCode: 401 },
    { code: "AUTHENTICATION_ERROR", statusCode: 403 },
    { code: "RATE_LIMIT_ERROR", statusCode: 429, retryAfter: 120 },
  ]) {
    const f = fixture(
      () =>
        err({
          ...upstream,
          message: "SYNTHETIC_PASSWORD",
          cause: { token: "SYNTHETIC_TOKEN" },
          response: "SYNTHETIC_BODY",
        }),
      { batchSize: 1 },
    );
    const values = await f.provider.getMany(owner, ids.slice(0, 3));
    const expected =
      upstream.statusCode === 401
        ? "AUTH_REQUIRED"
        : upstream.statusCode === 403
          ? "FORBIDDEN"
          : "RATE_LIMITED";
    assert.deepEqual(values.map(code), [expected, expected, expected]);
    assert.equal(f.calls.length, 1);
    assert(!JSON.stringify(values).includes("SYNTHETIC_"));
    if (upstream.statusCode === 429) {
      const value = values[0]!;
      assert(!value.ok);
      if (!value.ok) assert.equal(value.error.retryAfterMs, 120000);
    }
  }
  const f = fixture(() =>
    err({ statusCode: 429, retryAfter: "SYNTHETIC_SECRET" }),
  );
  const value = (await f.provider.getMany(owner, [ids[0]!]))[0]!;
  assert(!value.ok);
  if (!value.ok) assert.equal(value.error.retryAfterMs, undefined);
});

test("thrown SDK failures, malformed envelopes and unsafe getters are redacted", async () => {
  const f = fixture(() => {
    throw new Error("SYNTHETIC_SECRET");
  });
  const values = await f.provider.getMany(owner, [ids[0]!]);
  assert.equal(code(values[0]!), "UNAVAILABLE");
  assert(!JSON.stringify(values).includes("SYNTHETIC_SECRET"));
  const malformed = fixture(() => ({
    isErr: () => false,
    value: { golfers: [], missing: [null] },
  }));
  assert.equal(
    code((await malformed.provider.getMany(owner, [ids[0]!]))[0]!),
    "UNAVAILABLE",
  );
  const unsafe = fixture(() =>
    ok([
      Object.defineProperty({}, "ghin", {
        get() {
          throw new Error("SYNTHETIC_SECRET");
        },
      }),
    ]),
  );
  assert.equal(
    code((await unsafe.provider.getMany(owner, [ids[0]!]))[0]!),
    "UNAVAILABLE",
  );
});

test("optional names require opt-in and reject unsafe text", async () => {
  const f = fixture(
    () =>
      ok([
        row(ids[0]!, { first_name: "Demo", last_name: "Allowed" }),
        row(ids[1]!, { first_name: "Demo", last_name: "Bad\nName" }),
      ]),
    { allowNames: true },
  );
  const values = await f.provider.getMany(owner, ids.slice(0, 2));
  assert(values[0]!.ok && values[1]!.ok);
  if (values[0]!.ok && values[1]!.ok) {
    assert.equal(values[0]!.data.name, "Demo Allowed");
    assert.equal(values[1]!.data.name, undefined);
  }
});

test("owner checks bind the client and disconnect rejects late and subsequent results", async () => {
  let finish!: (value: SpicyGolfResult) => void;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await assert.rejects(
    f.provider.getMany({ subject: "another-owner" }, [ids[0]!]),
    { code: "FORBIDDEN" },
  );
  assert.equal(f.calls.length, 0);
  assert.throws(
    () =>
      new SpicyGolfProvider({
        mode: "offline-fixture",
        ownerSubject: "another-owner",
        client: f.client,
      }),
    { code: "FORBIDDEN" },
  );
  const pending = f.provider.getMany(owner, [ids[0]!]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await f.provider.disconnect(owner);
  await assert.rejects(pending, { code: "AUTH_REQUIRED" });
  finish(ok([row(ids[0]!)]));
  await assert.rejects(f.provider.getMany(owner, [ids[0]!]), {
    code: "AUTH_REQUIRED",
  });
  assert.equal(f.calls.length, 1);
});

test("timeouts stop waiting without claiming upstream cancellation or starting another chunk", async () => {
  const f = fixture(() => new Promise(() => {}), {
    timeoutMs: 10,
    batchSize: 1,
  });
  assert.deepEqual(
    (await f.provider.getMany(owner, ids.slice(0, 2))).map(code),
    ["UNAVAILABLE", "UNAVAILABLE"],
  );
  assert.equal(f.calls.length, 1);
});

test("caller cancellation prevents initial calls and invalidates in-flight waits", async () => {
  const f = fixture(() => new Promise(() => {})),
    early = new AbortController();
  early.abort();
  await assert.rejects(
    f.provider.getMany(owner, [ids[0]!], { signal: early.signal }),
    { code: "UNAVAILABLE" },
  );
  assert.equal(f.calls.length, 0);
  const controller = new AbortController(),
    pending = f.provider.getMany(owner, [ids[0]!], {
      signal: controller.signal,
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { code: "UNAVAILABLE" });
  assert.equal(f.calls.length, 1);
  const immediate = fixture(() => ok([row(ids[0]!)])),
    immediateController = new AbortController();
  const cancelled = immediate.provider.getMany(owner, [ids[0]!], {
    signal: immediateController.signal,
  });
  immediateController.abort();
  await assert.rejects(cancelled, { code: "UNAVAILABLE" });
  assert.equal(immediate.calls.length, 0);
});

test("ambiguous inputs make no call and official history and score semantics stay unsupported", async () => {
  const f = fixture(() => ok([]));
  for (const numbers of [
    [],
    [""],
    ["000900000001"],
    ["900000001", "not-a-number"],
  ])
    await assert.rejects(f.provider.getMany(owner, numbers), {
      code: "INVALID_INPUT",
    });
  await assert.rejects(
    f.provider.getMany(owner, [ids[0]!], { updatedSince: "2026-02-30" }),
    { code: "INVALID_INPUT" },
  );
  await assert.rejects(f.provider.getHistory(owner, ids[0]!, 10), {
    code: "UNSUPPORTED",
  });
  await assert.rejects(f.provider.getScores(owner, ids[0]!, 10), {
    code: "UNSUPPORTED",
  });
  assert.equal(f.calls.length, 0);
});

test("fixed factory returns only five synthetic golfers without invoking network", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("network forbidden");
  };
  try {
    const provider = createOfflineSpicyGolfProvider(owner.subject),
      values = await provider.getMany(owner, [...ids, "900000006"]);
    assert.deepEqual(
      values
        .slice(0, 5)
        .map((value) => (value.ok ? value.data.handicapIndex : undefined)),
      [12.4, 8.7, 16.2, 5.9, -0.9],
    );
    assert.equal(code(values[5]!), "UNAVAILABLE");
    assert.equal(calls, 0);
    assert.equal(provider.capabilities.history, false);
    assert.equal(provider.capabilities.scores, false);
  } finally {
    globalThis.fetch = original;
  }
});
