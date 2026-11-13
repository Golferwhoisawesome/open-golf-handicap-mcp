import test from "node:test";
import assert from "node:assert/strict";
import {
  SpicyGolfSdkSession,
  type SdkCredentials,
  type SdkUsageEvent,
} from "../src/providers/spicygolf-sdk-client.js";
import type { SdkFixtureScenario } from "../src/providers/spicygolf-sdk-fixtures.js";
import {
  DAILY_LIMITS,
  DAILY_WINDOW_MS,
  SESSION_LIMITS,
  SessionRequestPolicy,
} from "../src/providers/request-policy.js";
import { GhinUsageRepository } from "../src/desktop/ghin-usage.js";
import { InMemorySecretStore } from "../src/desktop/secret-store.js";
import { GhinCredentialRepository } from "../src/desktop/ghin-credentials.js";
import { GhinAuthenticatedProvider } from "../src/providers/ghin-provider.js";
import { mapSpicyGolfError } from "../src/providers/spicygolf-mapping.js";
import { AppError } from "../src/domain/errors.js";
import { LIVE_GHIN_RELEASE_ENABLED } from "../src/providers/live-access.js";

const credentials = (): SdkCredentials => ({
  username: Buffer.from("synthetic-user@example.invalid"),
  password: Buffer.from("synthetic-password-only"),
  ownGhinNumber: "900000001",
  accountType: "api",
});
const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;
async function session(
  scenario: SdkFixtureScenario,
  extra: Partial<ConstructorParameters<typeof SpicyGolfSdkSession>[0]> = {},
) {
  const active = new SpicyGolfSdkSession({
    mode: "offline-test",
    fixtureScenario: scenario,
    ...extra,
  });
  const input = credentials();
  try {
    await active.connect(input);
    return active;
  } finally {
    input.username.fill(0);
    input.password.fill(0);
  }
}
async function unlockedStore() {
  const store = new InMemorySecretStore();
  return store;
}

test("release gate is enabled for this build", () => {
  assert.equal(LIVE_GHIN_RELEASE_ENABLED, true);
});

test("session policy enforces per-kind session caps and daily allowance", () => {
  const policy = new SessionRequestPolicy({
    login: 1,
    search: 3,
    cooldownUntil: 0,
  });
  assert.equal(policy.admit("login"), true);
  assert.equal(policy.admit("login"), false);
  assert.equal(policy.limitReached, true);
  for (let i = 0; i < 3; i++) assert.equal(policy.admit("search"), true);
  assert.equal(policy.admit("search"), false);
  const unlimited = new SessionRequestPolicy();
  for (let i = 0; i < SESSION_LIMITS.search; i++)
    assert.equal(unlimited.admit("search"), true);
  assert.equal(unlimited.admit("search"), false);
});

test("a failed request is retried at most once per command", () => {
  const policy = new SessionRequestPolicy();
  policy.startCommand();
  assert.equal(policy.admit("search"), true);
  policy.outcome(false);
  assert.equal(policy.admit("search"), true);
  policy.outcome(false);
  assert.equal(policy.admit("search"), false);
  assert.equal(policy.limitReached, false);
  policy.startCommand();
  assert.equal(policy.admit("search"), true);
});

test("server errors reach the network at most twice per lookup", async () => {
  const active = await session("controlled-server-error");
  try {
    const before = active.offlineDiagnostics().batchRequests;
    const reply = await active.getMany([900000002], { status: null });
    assert.equal(reply.isErr(), true);
    assert.equal(active.offlineDiagnostics().batchRequests - before, 2);
  } finally {
    await active.close();
  }
});

test("a 400 response is sent once and never retried", async () => {
  const active = await session("controlled-bad-request");
  try {
    const before = active.offlineDiagnostics().batchRequests;
    const reply = await active.getMany([900000002], { status: null });
    assert.equal(reply.isErr(), true);
    assert.equal(active.offlineDiagnostics().batchRequests - before, 1);
  } finally {
    await active.close();
  }
});

test("daily allowance stops lookups locally without network traffic", async () => {
  const events: SdkUsageEvent[] = [];
  const active = await session("happy", {
    allowance: { login: 5, search: 2, cooldownUntil: 0 },
    onUsage: (event) => events.push(event),
  });
  try {
    const first = await active.getMany([900000002], { status: null });
    assert.equal(first.isErr(), false);
    const before = active.offlineDiagnostics().batchRequests;
    const limited = await active.getMany([900000003], { status: null });
    assert.equal(limited.isErr(), true);
    assert.equal(active.offlineDiagnostics().batchRequests, before);
    const mapped = mapSpicyGolfError(limited.isErr() ? limited.error : null);
    assert.equal(mapped.code, "RATE_LIMITED");
    assert.equal(events.filter((e) => e.request === "search").length, 2);
    assert.equal(events.filter((e) => e.request === "login").length, 1);
  } finally {
    await active.close();
  }
});

test("usage ledger persists counts, cooldowns, refusals and consent across instances", async () => {
  let now = 1_800_000_000_000;
  const store = await unlockedStore();
  const usage = new GhinUsageRepository(store, "ghin", () => now);
  assert.deepEqual(await usage.allowance(), {
    login: DAILY_LIMITS.login,
    search: DAILY_LIMITS.search,
    cooldownUntil: 0,
    forbidden: false,
    acknowledged: false,
  });
  await usage.acknowledge();
  await usage.record({ at: now, request: "login" });
  await usage.record({ at: now, request: "search" });
  await usage.record({ at: now, request: "installation" });
  await usage.record({ at: now, cooldownUntil: now + 60_000 });
  await usage.record({ at: now, forbidden: true });
  const reopened = new GhinUsageRepository(store, "ghin", () => now);
  assert.deepEqual(await reopened.allowance(), {
    login: DAILY_LIMITS.login - 1,
    search: DAILY_LIMITS.search - 1,
    cooldownUntil: now + 60_000,
    forbidden: true,
    acknowledged: true,
  });
  await reopened.clearForbidden();
  now += DAILY_WINDOW_MS + 1;
  assert.deepEqual(await reopened.allowance(), {
    login: DAILY_LIMITS.login,
    search: DAILY_LIMITS.search,
    cooldownUntil: 0,
    forbidden: false,
    acknowledged: true,
  });
  // Offline fixtures keep a separate ledger.
  const offline = new GhinUsageRepository(store, "offline-test", () => now);
  assert.equal((await offline.allowance()).acknowledged, false);
});

test("live provider refuses to start without a ledger or an acknowledgment", async () => {
  const store = await unlockedStore();
  const repository = new GhinCredentialRepository(store);
  await assert.rejects(
    GhinAuthenticatedProvider.connect({
      ownerSubject: "local-owner",
      mode: "ghin",
      repository,
      credentials: credentials(),
    }),
    code("INVALID_INPUT"),
  );
  await assert.rejects(
    GhinAuthenticatedProvider.connect({
      ownerSubject: "local-owner",
      mode: "ghin",
      repository,
      usage: new GhinUsageRepository(store, "ghin"),
      credentials: credentials(),
    }),
    code("AUTH_REQUIRED"),
  );
  assert.equal((await repository.status()).configured, false);
});

test("persisted cooldowns and refusals block new sessions before any sign-in", async () => {
  const store = await unlockedStore();
  const repository = new GhinCredentialRepository(store);
  const usage = new GhinUsageRepository(store, "offline-test");
  const provider = await GhinAuthenticatedProvider.connect({
    ownerSubject: "local-owner",
    mode: "offline-test",
    repository,
    usage,
    remember: true,
    credentials: credentials(),
    sessionOptions: { fixtureScenario: "rate-limited" },
  });
  try {
    await assert.rejects(
      provider.getMany({ subject: "local-owner" }, ["900000002"]),
      code("RATE_LIMITED"),
    );
  } finally {
    await provider.close();
  }
  // Let the fire-and-forget ledger write settle.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert((await usage.allowance()).cooldownUntil > Date.now());
  await assert.rejects(
    GhinAuthenticatedProvider.connect({
      ownerSubject: "local-owner",
      mode: "offline-test",
      repository,
      usage,
    }),
    code("RATE_LIMITED"),
  );

  const refused = new InMemorySecretStore();
  const refusedUsage = new GhinUsageRepository(refused, "offline-test");
  await refusedUsage.record({ at: Date.now(), forbidden: true });
  await assert.rejects(
    GhinAuthenticatedProvider.connect({
      ownerSubject: "local-owner",
      mode: "offline-test",
      repository: new GhinCredentialRepository(refused),
      usage: refusedUsage,
    }),
    code("FORBIDDEN"),
  );
});
