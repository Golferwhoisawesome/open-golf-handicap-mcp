import { z } from "zod";
import { AppError } from "../domain/errors.js";
import type { SecretStore } from "./secret-store.js";
import {
  DAILY_LIMITS,
  DAILY_WINDOW_MS,
  type RequestKind,
  type UsageAllowance,
} from "../providers/request-policy.js";
import type { SdkUsageEvent } from "../providers/spicygolf-sdk-client.js";

/** Current wording of the live-use acknowledgment. Bump to ask again. */
export const ACKNOWLEDGMENT_VERSION = 1;

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ledgerSchema = z
  .object({
    version: z.literal(1),
    login: z.array(timestamp).max(64),
    search: z.array(timestamp).max(300),
    cooldownUntil: timestamp,
    forbiddenAt: timestamp.nullable(),
    acknowledgedVersion: z.number().int().nonnegative(),
    acknowledgedAt: timestamp.nullable(),
  })
  .strict();
export type UsageLedger = z.infer<typeof ledgerSchema>;

const empty = (): UsageLedger => ({
  version: 1,
  login: [],
  search: [],
  cooldownUntil: 0,
  forbiddenAt: null,
  acknowledgedVersion: 0,
  acknowledgedAt: null,
});
const invalidStorage = () =>
  new AppError("STORAGE_ERROR", "The private usage record is invalid.");

function decode(bytes: Buffer | undefined): UsageLedger {
  if (!bytes) return empty();
  try {
    return ledgerSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw invalidStorage();
  }
}

/** Nonsecret request counts, cooldowns and consent, kept in the encrypted
 * profile vault so a new session cannot reset them. One ledger per mode. */
export class GhinUsageRepository {
  readonly #name: string;
  #writes: Promise<void> = Promise.resolve();
  constructor(
    private readonly store: SecretStore,
    mode: "offline-test" | "ghin",
    private readonly now: () => number = Date.now,
  ) {
    this.#name = mode === "ghin" ? "ghin-usage" : "ghin-usage-offline";
  }
  #prune(ledger: UsageLedger, time: number): UsageLedger {
    const since = time - DAILY_WINDOW_MS;
    return {
      ...ledger,
      login: ledger.login.filter((at) => at > since && at <= time),
      search: ledger.search.filter((at) => at > since && at <= time),
    };
  }
  async read(): Promise<UsageLedger> {
    const handle = await this.store.get(this.#name);
    if (!handle) return empty();
    let bytes: Buffer | undefined;
    try {
      bytes = handle.copy();
      return this.#prune(decode(bytes), this.now());
    } finally {
      bytes?.fill(0);
      handle.dispose();
    }
  }
  async #change(change: (ledger: UsageLedger) => UsageLedger): Promise<void> {
    const run = this.#writes.then(() =>
      this.store.update(this.#name, (bytes) => {
        const time = this.now();
        const next = this.#prune(
          change(this.#prune(decode(bytes), time)),
          time,
        );
        return Buffer.from(JSON.stringify(ledgerSchema.parse(next)), "utf8");
      }),
    );
    this.#writes = run.catch(() => undefined);
    return run;
  }
  async allowance(): Promise<
    UsageAllowance & { forbidden: boolean; acknowledged: boolean }
  > {
    const ledger = await this.read();
    return {
      login: Math.max(0, DAILY_LIMITS.login - ledger.login.length),
      search: Math.max(0, DAILY_LIMITS.search - ledger.search.length),
      cooldownUntil:
        ledger.cooldownUntil > this.now() ? ledger.cooldownUntil : 0,
      forbidden: ledger.forbiddenAt !== null,
      acknowledged: ledger.acknowledgedVersion >= ACKNOWLEDGMENT_VERSION,
    };
  }
  async acknowledge(): Promise<void> {
    await this.#change((ledger) => ({
      ...ledger,
      acknowledgedVersion: ACKNOWLEDGMENT_VERSION,
      acknowledgedAt: this.now(),
    }));
  }
  /** A fresh, explicit sign-in clears a previous GHIN refusal. */
  async clearForbidden(): Promise<void> {
    await this.#change((ledger) => ({ ...ledger, forbiddenAt: null }));
  }
  async record(event: SdkUsageEvent): Promise<void> {
    const at = Math.min(Math.max(0, Math.trunc(event.at)), this.now());
    await this.#change((ledger) => {
      const next = { ...ledger };
      if (event.request && event.request !== "installation") {
        const kind: Exclude<RequestKind, "installation"> = event.request;
        next[kind] = [...ledger[kind], at].slice(kind === "login" ? -64 : -300);
      }
      if (event.cooldownUntil !== undefined)
        next.cooldownUntil = Math.max(
          ledger.cooldownUntil,
          Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(event.cooldownUntil)),
        );
      if (event.forbidden) next.forbiddenAt = at;
      return next;
    });
  }
}
