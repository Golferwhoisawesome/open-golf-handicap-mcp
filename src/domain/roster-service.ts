import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "./errors.js";
import {
  golferInputSchema,
  type GolferInput,
  type Principal,
  type Roster,
  type SavedGolfer,
  type Handicap,
  type PublicError,
} from "./models.js";
import type { RosterStorageProvider } from "../storage/roster-storage-provider.js";
import { LookupService } from "./lookup-service.js";
import { Confirmations } from "./confirmation.js";
export const updateInputSchema = z
  .object({
    id: z.string().uuid(),
    patch: golferInputSchema
      .partial()
      .strict()
      .refine(
        (v) => Object.keys(v).length > 0,
        "At least one change is required",
      ),
  })
  .strict();
export class RosterService {
  private readonly disconnected = new Set<string>();
  constructor(
    readonly storage: RosterStorageProvider,
    readonly lookups: LookupService,
    private readonly confirmations: Confirmations,
    private readonly now: () => Date = () => new Date(),
  ) {}
  authorize(principal: Principal, write = false) {
    if (
      !principal.subject ||
      !principal.scopes.includes(write ? "roster:write" : "roster:read")
    )
      throw new AppError("FORBIDDEN", "Insufficient scope");
  }
  private connected(p: Principal) {
    this.authorize(p);
    if (this.disconnected.has(p.subject))
      throw new AppError("AUTH_REQUIRED", "Provider disconnected");
  }
  private create(input: GolferInput): SavedGolfer {
    const time = this.now().toISOString();
    return {
      ...input,
      id: randomUUID(),
      createdAt: time,
      modifiedAt: time,
      lastAttemptAt: null,
      lastCheckedAt: null,
      handicap: null,
      lastError: null,
    };
  }
  async save(p: Principal, input: GolferInput) {
    this.authorize(p, true);
    const clean = golferInputSchema.parse(input);
    return this.storage.transact(p.subject, (r) => {
      if (r.golfers.some((g) => g.ghinNumber === clean.ghinNumber))
        throw new AppError("DUPLICATE", "Duplicate");
      if (r.golfers.length >= 500)
        throw new AppError("INVALID_INPUT", "Roster limit");
      const golfer = this.create(clean);
      r.golfers.push(golfer);
      return { golfer };
    });
  }
  async list(p: Principal, query?: string) {
    this.authorize(p);
    const r = await this.storage.read(p.subject);
    return {
      revision: r.revision,
      golfers: r.golfers.filter(
        (g) =>
          !query ||
          [g.name, g.nickname ?? ""].some((v) =>
            v.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
          ),
      ),
    };
  }
  async update(p: Principal, input: z.infer<typeof updateInputSchema>) {
    this.authorize(p, true);
    const { id, patch } = updateInputSchema.parse(input);
    const result = await this.storage.transact(p.subject, (r) => {
      const golfer = r.golfers.find((g) => g.id === id);
      if (!golfer) throw new AppError("NOT_FOUND", "Missing");
      if (
        patch.ghinNumber &&
        r.golfers.some((g) => g.id !== id && g.ghinNumber === patch.ghinNumber)
      )
        throw new AppError("DUPLICATE", "Duplicate");
      if (patch.ghinNumber && patch.ghinNumber !== golfer.ghinNumber) {
        golfer.handicap = null;
        golfer.lastCheckedAt = null;
        golfer.lastAttemptAt = null;
        golfer.lastError = null;
        r.changes = r.changes.filter((c) => c.golferId !== id);
      }
      Object.assign(golfer, patch, { modifiedAt: this.now().toISOString() });
      return { golfer };
    });
    this.lookups.clear(p.subject);
    return result;
  }
  async remove(p: Principal, id: string) {
    this.authorize(p, true);
    const result = await this.storage.transact(p.subject, (r) => {
      if (!r.golfers.some((g) => g.id === id))
        throw new AppError("NOT_FOUND", "Missing");
      r.golfers = r.golfers.filter((g) => g.id !== id);
      r.changes = r.changes.filter((c) => c.golferId !== id);
      return { removed: true, id };
    });
    this.lookups.clear(p.subject);
    return result;
  }
  private planImport(roster: Roster, records: GolferInput[]) {
    const seen = new Set(roster.golfers.map((g) => g.ghinNumber));
    const added: GolferInput[] = [],
      duplicates: Array<{ record: GolferInput; reason: string }> = [];
    for (const record of records) {
      if (seen.has(record.ghinNumber))
        duplicates.push({
          record,
          reason: "GHIN number already present in roster or this import",
        });
      else {
        seen.add(record.ghinNumber);
        added.push(record);
      }
    }
    if (roster.golfers.length + added.length > 500)
      throw new AppError("INVALID_INPUT", "Roster limit");
    return { added, duplicates };
  }
  async import(
    p: Principal,
    records: GolferInput[],
    confirmed = false,
    confirmationToken?: string,
  ) {
    this.authorize(p, true);
    const clean = z.array(golferInputSchema).min(1).max(100).parse(records);
    if (!confirmed) {
      const r = await this.storage.read(p.subject);
      const plan = this.planImport(r, clean);
      return {
        status: "preview" as const,
        records: clean,
        added: [] as SavedGolfer[],
        willAdd: plan.added,
        duplicates: plan.duplicates,
        skipped: plan.duplicates.length,
        confirmationToken: this.confirmations.issue(
          p.subject,
          "import",
          clean,
          r,
        ),
      };
    }
    if (!confirmationToken)
      throw new AppError("CONFIRMATION_REQUIRED", "Preview first");
    return this.storage.transact(p.subject, (r) => {
      this.confirmations.verify(
        confirmationToken,
        p.subject,
        "import",
        clean,
        r,
      );
      const plan = this.planImport(r, clean),
        added = plan.added.map((g) => this.create(g));
      r.golfers.push(...added);
      return {
        status: "saved" as const,
        records: clean,
        added,
        willAdd: [] as GolferInput[],
        duplicates: plan.duplicates,
        skipped: plan.duplicates.length,
        confirmationToken: null,
      };
    });
  }
  async lookup(p: Principal, numbers: string[], force = false) {
    this.connected(p);
    return { results: await this.lookups.getMany(p.subject, numbers, force) };
  }
  async history(p: Principal, number: string, limit: number) {
    this.connected(p);
    if (!this.lookups.provider.capabilities.history)
      throw new AppError("UNSUPPORTED", "History unavailable");
    return {
      ghinNumber: number,
      entries: await this.lookups.provider.getHistory(
        { subject: p.subject },
        number,
        limit,
      ),
      source: this.lookups.provider.id,
      synthetic: !this.lookups.provider.capabilities.live,
    };
  }
  async scores(p: Principal, number: string, limit: number) {
    this.connected(p);
    if (!this.lookups.provider.capabilities.scores)
      throw new AppError("UNSUPPORTED", "Scores unavailable");
    return {
      ghinNumber: number,
      entries: await this.lookups.provider.getScores(
        { subject: p.subject },
        number,
        limit,
      ),
      source: this.lookups.provider.id,
      synthetic: !this.lookups.provider.capabilities.live,
    };
  }
  async refresh(p: Principal, ids?: string[], force = false) {
    this.authorize(p, true);
    this.connected(p);
    const before = await this.storage.read(p.subject);
    const selected = ids
      ? before.golfers.filter((g) => ids.includes(g.id))
      : before.golfers;
    if (ids && new Set(ids).size !== selected.length)
      throw new AppError("NOT_FOUND", "Unknown roster id");
    const values = await this.lookups.getMany(
        p.subject,
        selected.map((g) => g.ghinNumber),
        force,
      ),
      attempted = this.now().toISOString();
    return this.storage.transact(p.subject, (r) => {
      const updated: Array<{
          golferId: string;
          previous: number | null;
          current: number;
          handicap: Handicap;
        }> = [],
        unchanged: Array<{ golferId: string; handicap: Handicap }> = [],
        failed: Array<{
          golferId: string;
          ghinNumber: string;
          error: PublicError;
        }> = [];
      for (const previousGolfer of selected) {
        const golfer = r.golfers.find(
          (g) =>
            g.id === previousGolfer.id &&
            g.ghinNumber === previousGolfer.ghinNumber,
        );
        if (!golfer) {
          failed.push({
            golferId: previousGolfer.id,
            ghinNumber: previousGolfer.ghinNumber,
            error: {
              code: "CONFLICT",
              message: "Golfer changed or was removed during refresh.",
            },
          });
          continue;
        }
        const lookup = values.find((v) =>
          v.ok
            ? v.data.ghinNumber === golfer.ghinNumber
            : v.ghinNumber === golfer.ghinNumber,
        )!;
        if (
          lookup.ok &&
          golfer.handicap &&
          Date.parse(golfer.handicap.retrievedAt) >
            Date.parse(lookup.data.retrievedAt)
        ) {
          failed.push({
            golferId: golfer.id,
            ghinNumber: golfer.ghinNumber,
            error: {
              code: "CONFLICT",
              message: "A newer retrieval is already saved.",
            },
          });
          continue;
        }
        // Failures cannot replace a successful result committed by another concurrent refresh.
        if (
          !lookup.ok &&
          golfer.lastAttemptAt &&
          golfer.lastAttemptAt > attempted
        ) {
          failed.push({
            golferId: golfer.id,
            ghinNumber: golfer.ghinNumber,
            error: lookup.error,
          });
          continue;
        }
        golfer.lastAttemptAt = attempted;
        if (!lookup.ok) {
          golfer.lastError = lookup.error;
          failed.push({
            golferId: golfer.id,
            ghinNumber: golfer.ghinNumber,
            error: lookup.error,
          });
          continue;
        }
        const previous = golfer.handicap?.handicapIndex ?? null,
          current = lookup.data.handicapIndex;
        golfer.handicap = lookup.data;
        golfer.lastCheckedAt = lookup.data.retrievedAt;
        golfer.lastError = null;
        if (previous !== current) {
          golfer.modifiedAt = attempted;
          updated.push({
            golferId: golfer.id,
            previous,
            current,
            handicap: lookup.data,
          });
          r.changes.push({
            golferId: golfer.id,
            ghinNumber: golfer.ghinNumber,
            previous,
            current,
            observedAt: attempted,
            retrievedAt: lookup.data.retrievedAt,
            source: lookup.data.source,
            synthetic: lookup.data.synthetic,
          });
        } else unchanged.push({ golferId: golfer.id, handicap: lookup.data });
      }
      r.changes = r.changes.slice(-5000);
      return {
        updated,
        unchanged,
        failed,
        attemptedAt: attempted,
        checked: updated.length + unchanged.length,
        total: selected.length,
      };
    });
  }
  async changes(p: Principal, since: string, until?: string) {
    this.authorize(p);
    const r = await this.storage.read(p.subject);
    return {
      changes: r.changes.filter(
        (c) =>
          Date.parse(c.observedAt) >= Date.parse(since) &&
          (!until || Date.parse(c.observedAt) <= Date.parse(until)),
      ),
      retentionLimit: 5000,
    };
  }
  async export(p: Principal) {
    this.authorize(p);
    return {
      format: "open-golf-handicap-roster" as const,
      exportedAt: this.now().toISOString(),
      roster: await this.storage.read(p.subject),
    };
  }
  async delete(p: Principal, confirmed = false, confirmationToken?: string) {
    this.authorize(p, true);
    if (!confirmed) {
      const r = await this.storage.read(p.subject);
      return {
        status: "preview" as const,
        count: r.golfers.length,
        confirmationToken: this.confirmations.issue(
          p.subject,
          "delete",
          null,
          r,
        ),
      };
    }
    if (!confirmationToken)
      throw new AppError("CONFIRMATION_REQUIRED", "Preview first");
    // Transactionally wipe content to avoid a check/delete race. Encrypted empty roster remains as a revision tombstone.
    const result = await this.storage.transact(p.subject, (r) => {
      this.confirmations.verify(
        confirmationToken,
        p.subject,
        "delete",
        null,
        r,
      );
      const count = r.golfers.length;
      r.golfers = [];
      r.changes = [];
      return { status: "deleted" as const, count, confirmationToken: null };
    });
    this.lookups.clear(p.subject);
    return result;
  }
  async status(p: Principal) {
    this.authorize(p);
    const provider = this.lookups.provider;
    const state = await provider.getConnectionState?.({ subject: p.subject });
    if (provider.capabilities.live && !state)
      throw new AppError(
        "UNAVAILABLE",
        "Provider connection state is unavailable.",
      );
    const locallyConnected = !this.disconnected.has(p.subject);
    return {
      // This field describes the MCP caller, not upstream GHIN authentication.
      authenticated: true,
      providerAuthenticated: state?.authenticated ?? locallyConnected,
      credentialsStored: state?.credentialsStored ?? false,
      sessionExpiresAt: state?.expiresAt ?? null,
      controlledTest: state?.controlledTest ?? false,
      provider: provider.id,
      connected: locallyConnected && (state?.connected ?? true),
      liveAccessEnabled: provider.capabilities.live,
      storage: this.storage.kind,
      capabilities: provider.capabilities,
      limitations: [
        ...(state?.limitations ?? [
          "Demo mode: all handicap data is synthetic. Use --ghin with a connected profile for real GHIN lookups.",
        ]),
        "Google Drive storage is not implemented.",
        "No other application is contacted.",
        "Change history retains the latest 5000 observations.",
      ],
    };
  }
  async disconnect(p: Principal) {
    this.authorize(p, true);
    this.disconnected.add(p.subject);
    this.lookups.clear(p.subject);
    await this.lookups.provider.disconnect({ subject: p.subject });
    const state = await this.lookups.provider.getConnectionState?.({
      subject: p.subject,
    });
    if (state?.connected)
      throw new AppError("UNAVAILABLE", "Provider connection did not close.");
    return {
      disconnected: true,
      credentialsStored: state?.credentialsStored ?? false,
      limitation: state
        ? "Local provider connection is closed. Remote revocation is provider-specific; revoke MCP grants separately at their issuer."
        : "No GHIN credentials exist in mock mode. Restart this mock instance to reconnect; revoke MCP grants at the authorization server separately.",
    };
  }
}
