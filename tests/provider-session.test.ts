import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../src/domain/errors.js";
import { LookupService } from "../src/domain/lookup-service.js";
import { RosterService } from "../src/domain/roster-service.js";
import { Confirmations } from "../src/domain/confirmation.js";
import { MockRosterStorage } from "../src/storage/mock-roster-storage.js";
import { MockHandicapProvider } from "../src/providers/mock-provider.js";
import type {
  HandicapProvider,
  ProviderConnectionState,
} from "../src/providers/handicap-provider.js";
import { mapSpicyGolfBatch } from "../src/providers/spicygolf-mapping.js";
import { createOfflineSpicyGolfProvider } from "../src/providers/spicygolf-fixtures.js";

const owner = {
  subject: "synthetic-session-owner",
  scopes: ["roster:read", "roster:write"],
};
function fixture() {
  const mock = new MockHandicapProvider();
  let now = Date.now(),
    expiresAt = now + 1000,
    connected = true,
    stored = true,
    calls = 0;
  let hold: Promise<void> | undefined;
  let started = () => {};
  let failRemoval = false;
  const authenticated = () => connected && now < expiresAt;
  const state = (): ProviderConnectionState => ({
    authenticated: authenticated(),
    connected: authenticated(),
    credentialsStored: stored,
    expiresAt: new Date(expiresAt).toISOString(),
    limitations: ["Synthetic session test; no upstream connection."],
  });
  const provider: HandicapProvider = {
    id: "synthetic-auth-session",
    capabilities: { ...mock.capabilities },
    async assertConnected() {
      if (!authenticated())
        throw new AppError("AUTH_REQUIRED", "Synthetic session expired.");
    },
    async getConnectionState() {
      return state();
    },
    async getMany(context, numbers, options) {
      calls++;
      started();
      await hold;
      return mock.getMany(context, numbers, options);
    },
    getHistory: (...args) => mock.getHistory(...args),
    getScores: (...args) => mock.getScores(...args),
    async disconnect() {
      connected = false;
      if (failRemoval)
        throw new AppError(
          "STORAGE_ERROR",
          "Synthetic credential deletion failed.",
        );
      stored = false;
    },
  };
  const lookup = new LookupService(provider, {
    now: () => now,
    ttlMs: 60_000,
    minIntervalMs: 0,
    retries: 0,
  });
  const service = new RosterService(
    new MockRosterStorage(),
    lookup,
    new Confirmations(Buffer.alloc(32, 7)),
  );
  return {
    provider,
    lookup,
    service,
    get calls() {
      return calls;
    },
    expire() {
      now = expiresAt + 1;
    },
    reconnect() {
      connected = true;
      stored = true;
      expiresAt = now + 1000;
    },
    failRemoval() {
      failRemoval = true;
    },
    defer() {
      let release!: () => void;
      hold = new Promise((resolve) => {
        release = resolve;
      });
      const requestStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      return {
        requestStarted,
        release: () => {
          hold = undefined;
          release();
        },
      };
    },
  };
}

test("an expired session cannot read cached handicaps, and reauthentication starts with an empty cache", async () => {
  const f = fixture();
  assert.equal(
    (await f.lookup.getMany(owner.subject, ["900000001"]))[0]?.ok,
    true,
  );
  const cached = (await f.lookup.getMany(owner.subject, ["900000001"]))[0]!;
  assert(cached.ok);
  assert.equal(cached.data.freshness, "cached");
  assert.equal(f.calls, 1);
  f.expire();
  await assert.rejects(f.lookup.getMany(owner.subject, ["900000001"]), {
    code: "AUTH_REQUIRED",
  });
  await assert.rejects(f.lookup.getMany(owner.subject, ["900000001"], true), {
    code: "AUTH_REQUIRED",
  });
  assert.equal(f.calls, 1);
  f.reconnect();
  const fresh = (await f.lookup.getMany(owner.subject, ["900000001"]))[0]!;
  assert(fresh.ok);
  assert.equal(fresh.data.freshness, "fresh");
  assert.equal(f.calls, 2);
});

test("the existing offline SpicyGolf adapter also blocks cached reads after direct disconnect", async () => {
  const provider = createOfflineSpicyGolfProvider(owner.subject);
  const lookups = new LookupService(provider, { minIntervalMs: 0 });
  assert.equal(
    (await lookups.getMany(owner.subject, ["900000001"]))[0]?.ok,
    true,
  );
  await provider.disconnect(owner);
  await assert.rejects(lookups.getMany(owner.subject, ["900000001"]), {
    code: "AUTH_REQUIRED",
  });
  const status = await provider.getConnectionState(owner);
  assert.equal(status.authenticated, false);
  assert.equal(status.connected, false);
  assert.equal(status.credentialsStored, false);
});

test("late results from a disconnected session cannot populate a reconnected session's cache", async () => {
  const f = fixture(),
    deferred = f.defer();
  const pending = f.lookup.getMany(owner.subject, ["900000001"]);
  await deferred.requestStarted;
  await f.service.disconnect(owner);
  f.reconnect();
  deferred.release();
  const result = (await pending)[0]!;
  assert.equal(result.ok, false);
  const next = (await f.lookup.getMany(owner.subject, ["900000001"]))[0]!;
  assert(next.ok);
  assert.equal(next.data.freshness, "fresh");
  assert.equal(f.calls, 2);
});

test("a lookup completing after session expiry is rejected and never cached", async () => {
  const f = fixture(),
    deferred = f.defer();
  const pending = f.lookup.getMany(owner.subject, ["900000001"]);
  await deferred.requestStarted;
  f.expire();
  deferred.release();
  const result = (await pending)[0]!;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "AUTH_REQUIRED");
  f.reconnect();
  await f.lookup.getMany(owner.subject, ["900000001"]);
  assert.equal(f.calls, 2);
});

test("connection status distinguishes MCP identity, provider expiry and retained credentials", async () => {
  const f = fixture();
  const connected = await f.service.status(owner);
  assert.equal(connected.authenticated, true);
  assert.equal(connected.providerAuthenticated, true);
  assert.equal(connected.connected, true);
  assert.equal(connected.credentialsStored, true);
  assert.equal(connected.liveAccessEnabled, false);
  assert.equal(
    connected.limitations[0],
    "Synthetic session test; no upstream connection.",
  );
  assert.equal(typeof connected.sessionExpiresAt, "string");
  f.expire();
  const expired = await f.service.status(owner);
  assert.equal(expired.authenticated, true);
  assert.equal(expired.providerAuthenticated, false);
  assert.equal(expired.connected, false);
  assert.equal(expired.credentialsStored, true);
  const disconnected = await f.service.disconnect(owner);
  assert.equal(disconnected.disconnected, true);
  assert.equal(disconnected.credentialsStored, false);
  assert.equal((await f.service.status(owner)).credentialsStored, false);
});

test("failed credential deletion is not reported as successful removal", async () => {
  const f = fixture();
  f.failRemoval();
  await assert.rejects(f.service.disconnect(owner), { code: "STORAGE_ERROR" });
  const status = await f.service.status(owner);
  assert.equal(status.credentialsStored, true);
  assert.equal(status.connected, false);
  assert.equal(status.providerAuthenticated, false);
  await assert.rejects(f.service.lookup(owner, ["900000001"]), {
    code: "AUTH_REQUIRED",
  });
});

test("a provider forbidden rejection retains its code after the session closes", async () => {
  const f = fixture();
  f.provider.getMany = async () => {
    f.expire();
    throw new AppError("FORBIDDEN", "Synthetic upstream rejection.");
  };
  const result = (await f.lookup.getMany(owner.subject, ["900000001"]))[0]!;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "FORBIDDEN");
  await assert.rejects(f.lookup.getMany(owner.subject, ["900000001"]), {
    code: "AUTH_REQUIRED",
  });
});

test("shared normalization takes explicit provenance without labeling every adapter offline", () => {
  // Only synthetic fixture input is used; this verifies controlled output metadata.
  const rows = mapSpicyGolfBatch(
    {
      golfers: [{ ghin: 900000001, hi_display: "+0.9", hi_value: 0.9 }],
      missing: [],
    },
    ["900000001"],
    {
      source: "contract-provenance-test",
      synthetic: false,
      allowNames: false,
      retrievedAt: "2026-10-29T00:00:00.000Z",
    },
  );
  const result = rows[0]!;
  assert(result.ok);
  assert.equal(result.data.source, "contract-provenance-test");
  assert.equal(result.data.synthetic, false);
  assert.equal(result.data.handicapIndex, -0.9);
});
