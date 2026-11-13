import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  SpicyGolfSdkSession,
  type SdkCredentials,
} from "../src/providers/spicygolf-sdk-client.js";
import type { SdkFixtureScenario } from "../src/providers/spicygolf-sdk-fixtures.js";
import { mapSpicyGolfBatch } from "../src/providers/spicygolf-mapping.js";
import { AppError } from "../src/domain/errors.js";
import { setLiveAccessForTesting } from "../src/providers/live-access.js";

const ownNumber = 900000001;
const credentials = (): SdkCredentials => ({
  username: Buffer.from("controlled-review@example.invalid"),
  password: Buffer.from("synthetic-controlled-password"),
  ownGhinNumber: String(ownNumber),
  accountType: "golfer",
});
const hasCode = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;
async function connect(
  session: SpicyGolfSdkSession,
  accountType: "golfer" | "api" = "golfer",
) {
  const input = credentials();
  input.accountType = accountType;
  try {
    return await session.connect(input);
  } finally {
    input.username.fill(0);
    input.password.fill(0);
  }
}
function controlled(scenario: SdkFixtureScenario = "happy") {
  return new SpicyGolfSdkSession({
    mode: "offline-test",
    controlledTest: true,
    fixtureScenario: scenario,
  });
}
function assertPrivateDiagnostics(session: SpicyGolfSdkSession) {
  const serialized = JSON.stringify(session.diagnostics());
  for (const marker of [
    "controlled-review",
    "example.invalid",
    "synthetic-controlled-password",
    String(ownNumber),
    "private upstream transport detail",
    "eyJhbGci",
  ])
    assert.equal(serialized.includes(marker), false, marker);
}
async function assertStopped(
  session: SpicyGolfSdkSession,
  expectedSearches: number,
) {
  assert.equal(session.status().authenticated, false);
  assert.equal(session.diagnostics().workerExited, true);
  const before = session.offlineDiagnostics();
  assert.equal(before.installationRequests, 1);
  assert.equal(before.loginRequests, 1);
  assert.equal(before.batchRequests, expectedSearches);
  await assert.rejects(
    session.getMany([ownNumber], { status: null }),
    hasCode("AUTH_REQUIRED"),
  );
  assert.deepEqual(session.offlineDiagnostics(), before);
  assertPrivateDiagnostics(session);
}

test("controlled consumer connection budgets installation, login, validation and one own-golfer read", async () => {
  const session = controlled();
  try {
    const started = Date.now();
    const result = await connect(session);
    assert(result.expiresAt <= started + 300_000 + 1000);
    assert.equal(session.diagnostics().maxSessionMs, 300_000);
    assert.equal(session.diagnostics().controlledTest, true);
    assert.equal(session.diagnostics().workerStarted, true);
    assert.equal(session.diagnostics().workerExited, false);
    assert.deepEqual(session.diagnostics().requests, {
      installation: 1,
      login: 1,
      search: 1,
      total: 3,
    });
    assert.equal(
      (await session.getMany([ownNumber], { status: null })).isErr(),
      false,
    );
    assert.deepEqual(session.diagnostics().requests, {
      installation: 1,
      login: 1,
      search: 2,
      total: 4,
    });
    assert.deepEqual(session.diagnostics().limits, {
      installation: 1,
      login: 1,
      search: 2,
      total: 4,
    });
    assertPrivateDiagnostics(session);
  } finally {
    await session.close();
  }
  assert.equal(session.diagnostics().workerExited, true);
});

test("controlled mode rejects API-account login before starting a worker", async () => {
  const session = controlled();
  try {
    await assert.rejects(connect(session, "api"), hasCode("INVALID_INPUT"));
    assert.equal(session.diagnostics().workerStarted, false);
    assert.deepEqual(session.offlineDiagnostics(), {
      installationRequests: 0,
      loginRequests: 0,
      batchRequests: 0,
      blockedRequests: 0,
    });
  } finally {
    await session.close();
  }
});

test("every actual SDK installation, login and search starts at least two seconds apart", async () => {
  const session = controlled("request-pacing");
  try {
    await connect(session);
    assert.equal(
      (await session.getMany([ownNumber], { status: null })).isErr(),
      false,
    );
    assert.deepEqual(session.offlineDiagnostics(), {
      installationRequests: 1,
      loginRequests: 1,
      batchRequests: 2,
      blockedRequests: 0,
    });
  } finally {
    await session.close();
  }
});

test("expiry during request pacing prevents the next HTTP request", async () => {
  const session = new SpicyGolfSdkSession({
    mode: "offline-test",
    controlledTest: true,
    maxSessionMs: 1000,
  });
  try {
    await assert.rejects(connect(session), hasCode("AUTH_REQUIRED"));
    assert.equal(session.diagnostics().stopReason, "session_expired");
    assert.equal(session.diagnostics().workerExited, true);
    assert.deepEqual(session.offlineDiagnostics(), {
      installationRequests: 1,
      loginRequests: 0,
      batchRequests: 0,
      blockedRequests: 0,
    });
  } finally {
    await session.close();
  }
});

test("disconnect during request pacing prevents a queued lookup", async () => {
  const session = controlled();
  try {
    await connect(session);
    const before = session.offlineDiagnostics();
    const pending = assert.rejects(
      session.getMany([ownNumber], { status: null }),
      hasCode("AUTH_REQUIRED"),
    );
    await delay(50);
    await session.close();
    await pending;
    assert.equal(session.diagnostics().workerExited, true);
    assert.deepEqual(session.offlineDiagnostics(), before);
  } finally {
    await session.close();
  }
});

test("controlled mode terminates on another golfer, a multi-golfer request or an updated-since filter", async () => {
  for (const request of [
    { numbers: [900000002], options: { status: null } },
    { numbers: [ownNumber, 900000002], options: { status: null } },
    {
      numbers: [ownNumber],
      options: { status: null, updated_since: "2026-10-29" },
    },
  ]) {
    const session = controlled();
    try {
      await connect(session);
      await assert.rejects(
        session.getMany(request.numbers, request.options),
        hasCode("INVALID_INPUT"),
      );
      await assertStopped(session, 1);
    } finally {
      await session.close();
    }
  }
});

test("controlled mode refuses a third golfer search even for the same number", async () => {
  const session = controlled();
  try {
    await connect(session);
    assert.equal(
      (await session.getMany([ownNumber], { status: null })).isErr(),
      false,
    );
    await assert.rejects(
      session.getMany([ownNumber], { status: null }),
      hasCode("AUTH_REQUIRED"),
    );
    await assertStopped(session, 2);
    assert.equal(session.diagnostics().requests.total, 4);
  } finally {
    await session.close();
  }
});

test("concurrent controlled reads cannot exceed the shared transport request budget", async () => {
  const session = controlled();
  try {
    await connect(session);
    const results = await Promise.allSettled([
      session.getMany([ownNumber], { status: null }),
      session.getMany([ownNumber], { status: null }),
      session.getMany([ownNumber], { status: null }),
    ]);
    assert(results.some((result) => result.status === "rejected"));
    await assertStopped(session, 2);
    assert.equal(session.diagnostics().requests.total, 4);
  } finally {
    await session.close();
  }
});

test("400, 401, 403, 429 and 503 end controlled sessions before any automatic HTTP retry or re-login", async () => {
  const failures = [
    ["controlled-bad-request", 400],
    ["unauthorized-once", 401],
    ["forbidden", 403],
    ["rate-limited", 429],
    ["controlled-server-error", 503],
  ] as const;
  for (const [scenario, status] of failures) {
    const session = controlled(scenario);
    try {
      await connect(session);
      await assert.rejects(
        session.getMany([ownNumber], { status: null }),
        hasCode("AUTH_REQUIRED"),
      );
      assert.equal(session.diagnostics().lastStatus, status);
      assert.equal(typeof session.diagnostics().stopReason, "string");
      await assertStopped(session, 2);
    } finally {
      await session.close();
    }
  }
});

test("a 401 during controlled sign-in validation cannot trigger a second login", async () => {
  const session = controlled("controlled-validation-unauthorized");
  try {
    await assert.rejects(connect(session), hasCode("AUTH_REQUIRED"));
    assert.equal(session.diagnostics().lastStatus, 401);
    await assertStopped(session, 1);
  } finally {
    await session.close();
  }
});

test("controlled pagination is stopped before a second page is fetched", async () => {
  const session = controlled("controlled-pagination");
  try {
    await assert.rejects(connect(session), hasCode("AUTH_REQUIRED"));
    await assertStopped(session, 1);
    assert.equal(session.diagnostics().rawRows, 100);
  } finally {
    await session.close();
  }
});

test("controlled malformed, oversized and failed transports terminate without leaking provider details", async () => {
  for (const scenario of [
    "controlled-invalid-json",
    "controlled-transport-error",
    "oversized",
    "malformed-golfers",
  ] as const) {
    const session = controlled(scenario);
    try {
      await connect(session);
      await assert.rejects(
        session.getMany([ownNumber], { status: null }),
        hasCode("AUTH_REQUIRED"),
      );
      await assertStopped(session, 2);
    } finally {
      await session.close();
    }
  }
});

test("controlled expiry terminates the actual worker and rejects later requests", async () => {
  const session = new SpicyGolfSdkSession({
    mode: "offline-test",
    controlledTest: true,
    maxSessionMs: 6000,
  });
  try {
    const { expiresAt } = await connect(session);
    await delay(Math.max(0, expiresAt - Date.now()) + 100);
    await assertStopped(session, 1);
  } finally {
    await session.close();
  }
});

test("installed SDK accepts Archived rows, selects the home club and safely maps a multi-club golfer", async () => {
  const session = controlled("archived-multi-club");
  try {
    await connect(session);
    const reply = await session.getMany([ownNumber], { status: null });
    assert.equal(reply.isErr(), false);
    const value = reply.value as {
      golfers: Array<{ ghin: number; club_id: number; status: string }>;
      missing: number[];
    };
    assert.equal(value.golfers.length, 1);
    assert.equal(value.golfers[0]!.ghin, ownNumber);
    assert.equal(value.golfers[0]!.club_id, 2);
    assert.equal(value.golfers[0]!.status, "Archived");
    assert.deepEqual(value.missing, []);
    assert.equal(session.diagnostics().rawRows, 2);
    const mapped = mapSpicyGolfBatch(value, [String(ownNumber)], {
      source: "synthetic-controlled-sdk",
      synthetic: true,
      allowNames: false,
      retrievedAt: new Date().toISOString(),
    });
    assert.equal(mapped[0]!.ok, true);
    if (mapped[0]!.ok) assert.equal(mapped[0]!.data.handicapIndex, 12.4);
  } finally {
    await session.close();
  }
});

test("requesting controlled mode cannot bypass a disabled live gate", async () => {
  setLiveAccessForTesting(false);
  const session = new SpicyGolfSdkSession({
    mode: "ghin",
    controlledTest: true,
  });
  try {
    await assert.rejects(
      session.connect(undefined as unknown as SdkCredentials),
      hasCode("LIVE_ACCESS_DISABLED"),
    );
    assert.equal(session.diagnostics().workerStarted, false);
    assert.equal(session.status().authenticated, false);
  } finally {
    setLiveAccessForTesting(undefined);
    await session.close();
  }
});
