import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import {
  SpicyGolfSdkSession,
  type SdkCredentials,
} from "../src/providers/spicygolf-sdk-client.js";
import type { SdkFixtureScenario } from "../src/providers/spicygolf-sdk-fixtures.js";
import { isSdkFixtureIdentifier } from "../src/providers/spicygolf-sdk-fixtures.js";
import { AppError } from "../src/domain/errors.js";
import { setLiveAccessForTesting } from "../src/providers/live-access.js";

const credentials = (
  accountType: "golfer" | "api" = "api",
): SdkCredentials => ({
  username: Buffer.from("synthetic-user@example.invalid"),
  password: Buffer.from("synthetic-password-only"),
  ownGhinNumber: "900000001",
  accountType,
});
const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;
async function connected(
  scenario: SdkFixtureScenario = "happy",
  accountType: "golfer" | "api" = "api",
) {
  const session = new SpicyGolfSdkSession({
    mode: "offline-test",
    fixtureScenario: scenario,
  });
  const input = credentials(accountType);
  try {
    await session.connect(input);
    return session;
  } finally {
    input.username.fill(0);
    input.password.fill(0);
  }
}
test("actual SDK uses patched Zod4 dependency rather than the vulnerable Zod3 path", async () => {
  const require = createRequire(import.meta.url),
    sdkRequire = createRequire(require.resolve("@spicygolf/ghin"));
  const zod = JSON.parse(
    await readFile(sdkRequire.resolve("zod/package.json"), "utf8"),
  );
  assert.equal(zod.version, "4.6.7");
});
test("API login and real SDK batch lookup run offline, preserving cache, ordering, plus values and missing IDs", async () => {
  const hostFetch = globalThis.fetch,
    session = await connected();
  try {
    assert.equal(globalThis.fetch, hostFetch);
    assert.equal(session.status().authenticated, true);
    const reply = await session.getMany(
      [900000002, 900000005, 900000002, 900000006],
      { status: null },
    );
    assert.equal(reply.isErr(), false);
    const result = reply.value as {
      golfers: Array<{
        ghin: number;
        hi_display: string;
        hi_value: number;
        rev_date: Date;
      }>;
      missing: number[];
    };
    assert.deepEqual(
      result.golfers.map((row) => row.ghin),
      [900000002, 900000005],
    );
    assert.equal(result.golfers[1]!.hi_display, "+0.9");
    assert.equal(result.golfers[1]!.hi_value, 0.9);
    assert(result.golfers[0]!.rev_date instanceof Date);
    assert.deepEqual(result.missing, [900000006]);
    assert.deepEqual(session.offlineDiagnostics(), {
      installationRequests: 0,
      loginRequests: 1,
      batchRequests: 2,
      blockedRequests: 0,
    });
    assert(!JSON.stringify(session).includes("synthetic-password"));
  } finally {
    await session.close();
  }
});
test("consumer SDK authentication uses only intercepted installation and login fixtures", async () => {
  const session = await connected("happy", "golfer");
  try {
    assert.deepEqual(session.offlineDiagnostics(), {
      installationRequests: 1,
      loginRequests: 1,
      batchRequests: 1,
      blockedRequests: 0,
    });
  } finally {
    await session.close();
  }
});
test("login gateway preserves exact UTF-8 password bytes, spaces and combining marks across SDK reauthentication", async () => {
  for (const accountType of ["api", "golfer"] as const) {
    const session = new SpicyGolfSdkSession({
      mode: "offline-test",
      fixtureScenario: "unauthorized-once",
    });
    const input = credentials(accountType);
    input.password.fill(0);
    input.password = Buffer.from("  synthetic-Päss密碼 e\u0301 🔒  ", "utf8");
    const before = Buffer.from(input.password);
    try {
      await session.connect(input);
      assert.equal(
        (await session.getMany([900000002], { status: null })).isErr(),
        false,
      );
      assert.equal(session.offlineDiagnostics().loginRequests, 2);
      assert.deepEqual(input.password, before);
    } finally {
      input.username.fill(0);
      input.password.fill(0);
      before.fill(0);
      await session.close();
    }
  }
});
test("login endpoint rate limits retain Retry-After instead of becoming an unavailable error", async () => {
  const session = new SpicyGolfSdkSession({
    mode: "offline-test",
    fixtureScenario: "login-rate-limited",
  });
  const input = credentials();
  try {
    await assert.rejects(
      session.connect(input),
      (error) =>
        error instanceof AppError &&
        error.code === "RATE_LIMITED" &&
        error.retryAfterMs === 30_000,
    );
    assert.equal(session.status().authenticated, false);
    assert.equal(session.offlineDiagnostics().loginRequests, 1);
  } finally {
    input.username.fill(0);
    input.password.fill(0);
    await session.close();
  }
});
test("all project synthetic SDK identifiers are recognized for the future live-mode rejection", () => {
  for (const id of [
    "900000000",
    "900000001",
    "900000005",
    "900000006",
    "900000099",
  ])
    assert.equal(isSdkFixtureIdentifier(id), true);
  assert.equal(isSdkFixtureIdentifier("1234567"), false);
});
test("401 allows one SDK reauthentication within the private session", async () => {
  const session = await connected("unauthorized-once");
  try {
    const result = await session.getMany([900000002], { status: null });
    assert.equal(result.isErr(), false);
    assert.equal(session.offlineDiagnostics().loginRequests, 2);
    assert.equal(session.offlineDiagnostics().batchRequests, 3);
  } finally {
    await session.close();
  }
});
test("403 blocks SDK re-login traffic and closes the private session", async () => {
  const session = await connected("forbidden");
  try {
    const result = await session.getMany([900000002], { status: null });
    assert.equal(result.isErr(), true);
    assert.equal((result.error as { statusCode: number }).statusCode, 403);
    assert.equal(session.offlineDiagnostics().loginRequests, 1);
    assert.equal(session.offlineDiagnostics().batchRequests, 2);
    assert.equal(session.offlineDiagnostics().blockedRequests, 1);
    assert.equal(session.status().authenticated, false);
    await assert.rejects(
      session.getMany([900000001], { status: null }),
      code("AUTH_REQUIRED"),
    );
  } finally {
    await session.close();
  }
});
test(
  "429 cooldown suppresses actual HTTP despite the SDK's internal retry loop",
  { timeout: 40_000 },
  async () => {
    const session = await connected("rate-limited");
    try {
      const result = await session.getMany([900000002], { status: null });
      assert.equal(result.isErr(), true);
      const error = result.error as { code: string; retryAfter: number };
      assert.equal(error.code, "RATE_LIMIT_ERROR");
      assert(error.retryAfter >= 25);
      assert.equal(session.offlineDiagnostics().batchRequests, 2);
      assert.equal(session.offlineDiagnostics().blockedRequests, 2);
    } finally {
      await session.close();
    }
  },
);
test("invalid login, expired token and missing own golfer never establish a session", async () => {
  for (const scenario of [
    "auth-denied",
    "malformed-login",
    "expired-login",
    "missing-self",
  ] as const) {
    const session = new SpicyGolfSdkSession({
      mode: "offline-test",
      fixtureScenario: scenario,
    });
    const input = credentials();
    try {
      await assert.rejects(
        session.connect(input),
        (error) =>
          error instanceof AppError &&
          !error.message.includes(input.password.toString()),
      );
      assert.equal(session.status().authenticated, false);
    } finally {
      input.username.fill(0);
      input.password.fill(0);
      await session.close();
    }
  }
});
test(
  "worker deadline terminates hung HTTP; explicit close invalidates in-flight SDK results",
  { timeout: 60_000 },
  async () => {
    const timed = new SpicyGolfSdkSession({
      mode: "offline-test",
      fixtureScenario: "timeout",
      // Long enough for a paced sign-in on a slow CI runner; the hung lookup
      // after sign-in must still be cut off by this deadline.
      timeoutMs: 15_000,
    });
    const input = credentials();
    try {
      await timed.connect(input);
      await assert.rejects(
        timed.getMany([900000002], { status: null }),
        code("UNAVAILABLE"),
      );
      assert.equal(timed.status().authenticated, false);
    } finally {
      input.username.fill(0);
      input.password.fill(0);
      await timed.close();
    }
    const session = await connected("timeout");
    const pending = assert.rejects(
      session.getMany([900000002], { status: null }),
      code("UNAVAILABLE"),
    );
    await delay(20);
    await session.close();
    await pending;
  },
);
test(
  "private session expires independently of the SDK's JWT cache",
  { timeout: 25_000 },
  async () => {
    const session = new SpicyGolfSdkSession({
      mode: "offline-test",
      // Room for slow CI worker startup plus two paced requests.
      maxSessionMs: 10_000,
    });
    const input = credentials();
    try {
      const result = await session.connect(input);
      await delay(Math.max(0, result.expiresAt - Date.now()) + 50);
      assert.equal(session.status().authenticated, false);
      await assert.rejects(
        session.getMany([900000001], { status: null }),
        code("AUTH_REQUIRED"),
      );
    } finally {
      input.username.fill(0);
      input.password.fill(0);
      await session.close();
    }
  },
);
test(
  "oversized or malformed SDK responses yield safe failures rather than arbitrary data",
  { timeout: 25_000 },
  async () => {
    for (const scenario of ["oversized", "malformed-golfers"] as const) {
      const session = await connected(scenario);
      try {
        const result = await session.getMany([900000002], { status: null });
        assert.equal(result.isErr(), true);
        assert.deepEqual(Object.keys(result.error as object).sort(), ["code"]);
      } finally {
        await session.close();
      }
    }
  },
);
test("offline credential markers and input bounds fail before any worker lookup", async () => {
  const session = new SpicyGolfSdkSession({ mode: "offline-test" }),
    input = credentials();
  try {
    input.username = Buffer.from("real-looking@example.com");
    await assert.rejects(session.connect(input), code("INVALID_INPUT"));
    assert.deepEqual(session.offlineDiagnostics(), {
      installationRequests: 0,
      loginRequests: 0,
      batchRequests: 0,
      blockedRequests: 0,
    });
  } finally {
    input.username.fill(0);
    input.password.fill(0);
    await session.close();
  }
  const active = await connected();
  try {
    await assert.rejects(
      active.getMany([0], { status: null }),
      code("INVALID_INPUT"),
    );
    assert.equal(active.offlineDiagnostics().batchRequests, 1);
  } finally {
    await active.close();
  }
});
test("live gate rejects connect before reading credentials or constructing a worker", async () => {
  setLiveAccessForTesting(false);
  const session = new SpicyGolfSdkSession({ mode: "ghin" });
  try {
    await assert.rejects(
      session.connect(undefined as unknown as SdkCredentials),
      code("LIVE_ACCESS_DISABLED"),
    );
    assert.equal(session.status().authenticated, false);
  } finally {
    setLiveAccessForTesting(undefined);
    await session.close();
  }
});
