import test from "node:test";
import assert from "node:assert/strict";
import { Confirmations } from "../src/domain/confirmation.js";
import { LookupService } from "../src/domain/lookup-service.js";
import { RosterService } from "../src/domain/roster-service.js";
import { MockRosterStorage } from "../src/storage/mock-roster-storage.js";
import { AppError } from "../src/domain/errors.js";
import { courseHandicap } from "../src/domain/course-handicap.js";
import { formatIndex, type LookupResult } from "../src/domain/models.js";
import type { HandicapProvider } from "../src/providers/handicap-provider.js";
const owner = {
    subject: "synthetic-owner",
    scopes: ["roster:read", "roster:write"],
  },
  other = { ...owner, subject: "synthetic-other" };
function fixture() {
  let index: number | null = 12.4,
    calls = 0,
    stamp = Date.parse("2026-10-20T00:00:00Z");
  const provider: HandicapProvider = {
    id: "test-synthetic",
    capabilities: {
      batch: true,
      history: false,
      scores: false,
      updatedSince: false,
      courses: false,
      live: false,
    },
    async getMany(_ctx, numbers) {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return numbers.map((ghinNumber) =>
        index === null
          ? {
              ok: false,
              ghinNumber,
              error: {
                code: "NO_HANDICAP",
                message: "sensitive upstream text",
              },
            }
          : {
              ok: true,
              data: {
                ghinNumber,
                handicapIndex: index,
                display: formatIndex(index),
                effectiveDate: null,
                retrievedAt: new Date(stamp).toISOString(),
                source: "test-synthetic",
                freshness: "fresh",
                synthetic: true,
              },
            },
      ) as LookupResult[];
    },
    async getHistory() {
      return [];
    },
    async getScores() {
      return [];
    },
    async disconnect() {},
  };
  const lookup = new LookupService(provider, {
      now: () => stamp,
      minIntervalMs: 0,
      ttlMs: 1000,
    }),
    storage = new MockRosterStorage(),
    service = new RosterService(
      storage,
      lookup,
      new Confirmations(Buffer.alloc(32, 1), () => stamp),
      () => new Date(stamp),
    );
  return {
    provider,
    lookup,
    storage,
    service,
    get calls() {
      return calls;
    },
    setIndex(v: number | null) {
      index = v;
    },
    advance(ms: number) {
      stamp += ms;
    },
  };
}
test("bulk preview binds exact payload, user, revision, expiration and rejects replay", async () => {
  const f = fixture(),
    records = [
      { name: "Demo Alpha", ghinNumber: "900000001" },
      { name: "Demo duplicate", ghinNumber: "900000001" },
    ];
  const preview = await f.service.import(owner, records);
  assert.equal(preview.status, "preview");
  assert.equal(preview.duplicates.length, 1);
  assert.equal((await f.service.list(owner)).golfers.length, 0);
  await assert.rejects(
    f.service.import(other, records, true, preview.confirmationToken!),
    { code: "CONFIRMATION_REQUIRED" },
  );
  await assert.rejects(
    f.service.import(
      owner,
      [{ ...records[0]!, name: "Changed" }],
      true,
      preview.confirmationToken!,
    ),
    { code: "CONFIRMATION_REQUIRED" },
  );
  const saved = await f.service.import(
    owner,
    records,
    true,
    preview.confirmationToken!,
  );
  assert.equal(saved.added.length, 1);
  await assert.rejects(
    f.service.import(owner, records, true, preview.confirmationToken!),
    { code: "CONFIRMATION_REQUIRED" },
  );
  const later = await f.service.import(owner, [
    { name: "Demo Beta", ghinNumber: "900000002" },
  ]);
  f.advance(300001);
  await assert.rejects(
    f.service.import(owner, later.records, true, later.confirmationToken!),
    { code: "CONFIRMATION_REQUIRED" },
  );
});
test("partial failures never zero or overwrite a valid value; cached checks preserve retrieval time", async () => {
  const f = fixture(),
    { golfer } = await f.service.save(owner, {
      name: "Demo Alpha",
      ghinNumber: "900000001",
    });
  const first = await f.service.refresh(owner);
  assert.equal(first.updated[0]!.previous, null);
  const time = first.updated[0]!.handicap.retrievedAt;
  f.advance(100);
  const cached = await f.service.refresh(owner);
  assert.equal(cached.unchanged[0]!.handicap.freshness, "cached");
  assert.equal(cached.unchanged[0]!.handicap.retrievedAt, time);
  assert.equal(f.calls, 1);
  f.setIndex(null);
  const failed = await f.service.refresh(owner, undefined, true);
  assert.equal(failed.failed.length, 1);
  const retained = (await f.service.list(owner)).golfers[0]!;
  assert.equal(retained.handicap!.handicapIndex, 12.4);
  assert.equal(retained.lastCheckedAt, time);
  assert.doesNotMatch(JSON.stringify(failed), /sensitive upstream/);
  f.advance(100);
  f.setIndex(0);
  const zero = await f.service.refresh(owner, undefined, true);
  assert.equal(zero.updated[0]!.current, 0);
  assert.equal(zero.updated[0]!.previous, 12.4);
  await f.service.update(owner, {
    id: golfer.id,
    patch: { ghinNumber: "900000003" },
  });
  const changed = (await f.service.list(owner)).golfers[0]!;
  assert.equal(changed.handicap, null);
  assert.equal(
    (await f.service.changes(owner, "2026-01-01T00:00:00Z")).changes.length,
    0,
  );
});
test("cache and in-flight requests deduplicate without sharing across owners; TTL and force work", async () => {
  const f = fixture();
  await Promise.all([
    f.lookup.getMany(owner.subject, ["900000001", "900000001"]),
    f.lookup.getMany(owner.subject, ["900000001"]),
  ]);
  assert.equal(f.calls, 1);
  await f.lookup.getMany(other.subject, ["900000001"]);
  assert.equal(f.calls, 2);
  await f.lookup.getMany(owner.subject, ["900000001"], true);
  assert.equal(f.calls, 3);
  f.advance(1001);
  await f.lookup.getMany(owner.subject, ["900000001"]);
  assert.equal(f.calls, 4);
});
test("deletion confirms current content and clears history/cache; authorization and owner isolation", async () => {
  const f = fixture(),
    { golfer } = await f.service.save(owner, {
      name: "Demo Alpha",
      ghinNumber: "900000001",
    });
  await f.service.refresh(owner);
  assert.equal((await f.service.list(other)).golfers.length, 0);
  await assert.rejects(f.service.remove(other, golfer.id), {
    code: "NOT_FOUND",
  });
  await assert.rejects(
    f.service.save(
      { subject: owner.subject, scopes: ["roster:read"] },
      { name: "Demo beta", ghinNumber: "900000002" },
    ),
    { code: "FORBIDDEN" },
  );
  const preview = await f.service.delete(owner);
  await f.service.update(owner, {
    id: golfer.id,
    patch: { notes: "New note" },
  });
  await assert.rejects(
    f.service.delete(owner, true, preview.confirmationToken!),
    { code: "CONFIRMATION_REQUIRED" },
  );
  const current = await f.service.delete(owner);
  await f.service.delete(owner, true, current.confirmationToken!);
  assert.equal((await f.service.export(owner)).roster.golfers.length, 0);
  assert.equal(
    (await f.service.changes(owner, "2026-01-01T00:00:00Z")).changes.length,
    0,
  );
  await f.service.lookup(owner, ["900000001"]);
  assert.equal(f.calls, 2);
  await f.service.disconnect(owner);
  await assert.rejects(f.service.lookup(owner, ["900000001"]), {
    code: "AUTH_REQUIRED",
  });
});
test("bounded retries respect Retry-After and never retry authentication failures", async () => {
  const f = fixture();
  let attempts = 0;
  const waits: number[] = [];
  f.provider.getMany = async () => {
    attempts++;
    throw new AppError("RATE_LIMITED", "private provider detail", 1200);
  };
  const engine = new LookupService(f.provider, {
    minIntervalMs: 0,
    retries: 2,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  const result = await engine.getMany(owner.subject, ["900000001"]);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1200, 1200]);
  assert.equal(result[0]!.ok, false);
  attempts = 0;
  f.provider.getMany = async () => {
    attempts++;
    throw new AppError("AUTH_REQUIRED", "secret");
  };
  await engine.getMany(owner.subject, ["900000002"]);
  assert.equal(attempts, 1);
  attempts = 0;
  f.provider.getMany = async () => {
    attempts++;
    throw new AppError("RATE_LIMITED", "secret", 60000);
  };
  await engine.getMany(owner.subject, ["900000003"], true);
  assert.equal(attempts, 1);
});
test("missing batch rows, contradictory identities, invalid numbers and injection fields fail closed", async () => {
  const f = fixture();
  f.provider.getMany = async () => [];
  const result = await f.lookup.getMany(owner.subject, ["900000001"]);
  assert.equal(result[0]!.ok, false);
  await assert.rejects(
    f.service.save(owner, { name: "Demo", ghinNumber: "ABC" }),
  );
  await assert.rejects(
    f.service.save(owner, {
      name: "Demo",
      ghinNumber: "900000001",
      subject: "other",
    } as never),
  );
});
test("Course Handicap matches authoritative USGA examples and handles plus/9-hole input", () => {
  for (const [index, slope, expected] of [
    [1, 116, 1],
    [18, 116, 18],
    [1, 132, 1],
    [18, 132, 21],
  ])
    assert.equal(
      courseHandicap({
        handicapIndex: index!,
        slope: slope!,
        courseRating: 71,
        par: 71,
        holes: 18,
      }).courseHandicap,
      expected,
    );
  assert.equal(
    courseHandicap({
      handicapIndex: -0.5,
      slope: 113,
      courseRating: 72,
      par: 72,
      holes: 18,
    }).courseHandicap,
    0,
  );
  assert.equal(
    courseHandicap({
      handicapIndex: 12.3,
      slope: 113,
      courseRating: 36,
      par: 36,
      holes: 9,
    }).unrounded,
    6.2,
  );
  assert.throws(() =>
    courseHandicap({
      handicapIndex: 12,
      slope: 113,
      courseRating: 72,
      par: 72,
      holes: 9,
    }),
  );
});

test("batch scheduler enforces chunk size and concurrency under overlapping workloads", async () => {
  const f = fixture();
  let active = 0,
    max = 0;
  const sizes: number[] = [];
  f.provider.getMany = async (_context, numbers) => {
    active++;
    max = Math.max(max, active);
    sizes.push(numbers.length);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    return numbers.map((ghinNumber) => ({
      ok: false,
      ghinNumber,
      error: { code: "NOT_FOUND", message: "Unavailable fixture" },
    }));
  };
  const engine = new LookupService(f.provider, {
    batchSize: 2,
    concurrency: 2,
    minIntervalMs: 0,
  });
  const result = await engine.getMany(owner.subject, [
    "900000001",
    "900000002",
    "900000003",
    "900000004",
    "900000005",
  ]);
  assert.equal(result.length, 5);
  assert.deepEqual(sizes, [2, 2, 1]);
  assert.equal(max, 2);
});
