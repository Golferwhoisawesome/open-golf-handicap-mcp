import { AppError, safeError } from "./errors.js";
import { handicapSchema, type LookupResult, type Handicap } from "./models.js";
import type { HandicapProvider } from "../providers/handicap-provider.js";
export interface LookupOptions {
  ttlMs?: number;
  batchSize?: number;
  concurrency?: number;
  minIntervalMs?: number;
  retries?: number;
  maxCacheEntries?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export class LookupService {
  private readonly cache = new Map<
    string,
    { data: Handicap; expires: number }
  >();
  private readonly pending = new Map<string, Promise<LookupResult>>();
  private readonly epochs = new Map<string, number>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private nextStart = 0;
  private readonly options: Required<LookupOptions>;
  constructor(
    readonly provider: HandicapProvider,
    options: LookupOptions = {},
  ) {
    // Live providers already pace, cap and retry once inside the SDK worker;
    // a second retry layer here would multiply real GHIN traffic.
    const live = provider.capabilities.live;
    this.options = {
      ttlMs: 3_600_000,
      batchSize: live ? 100 : 50,
      concurrency: live ? 1 : 2,
      minIntervalMs: 100,
      retries: live ? 0 : 2,
      maxCacheEntries: 2000,
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...options,
    };
    if (
      !Number.isFinite(this.options.ttlMs) ||
      this.options.ttlMs < 0 ||
      this.options.ttlMs > 86_400_000 ||
      !Number.isInteger(this.options.batchSize) ||
      this.options.batchSize < 1 ||
      this.options.batchSize > 100 ||
      !Number.isInteger(this.options.concurrency) ||
      this.options.concurrency < 1 ||
      this.options.concurrency > 8 ||
      this.options.retries < 0 ||
      this.options.retries > 3 ||
      !Number.isFinite(this.options.minIntervalMs) ||
      this.options.minIntervalMs < 0
    )
      throw new Error("Invalid lookup policy");
  }
  private key(subject: string, number: string) {
    return JSON.stringify([subject, number]);
  }
  clear(subject: string) {
    for (const key of this.cache.keys())
      if (JSON.parse(key)[0] === subject) this.cache.delete(key);
    this.epochs.set(subject, (this.epochs.get(subject) ?? 0) + 1);
  }
  private async assertConnected(subject: string) {
    try {
      await this.provider.assertConnected?.({ subject });
    } catch (error) {
      this.clear(subject);
      throw error;
    }
  }
  private async permit() {
    if (this.active >= this.options.concurrency)
      await new Promise<void>((r) => this.waiters.push(r));
    else this.active++;
    const delay = Math.max(0, this.nextStart - this.options.now());
    this.nextStart = this.options.now() + delay + this.options.minIntervalMs;
    if (delay) await this.options.sleep(delay);
    return () => {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    };
  }
  private async fetchBatch(
    subject: string,
    numbers: string[],
  ): Promise<LookupResult[]> {
    const release = await this.permit();
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await this.assertConnected(subject);
          const results = await this.provider.getMany({ subject }, numbers, {
            signal: AbortSignal.timeout(15_000),
          });
          // A response that completed after expiry/disconnect cannot revive cache.
          await this.assertConnected(subject);
          return numbers.map((number) => {
            const matches = results.filter((r) =>
              r.ok ? r.data.ghinNumber === number : r.ghinNumber === number,
            );
            if (matches.length !== 1)
              return {
                ok: false,
                ghinNumber: number,
                error: safeError(
                  new AppError("UNAVAILABLE", "Incomplete provider response"),
                ),
              };
            const result = matches[0]!;
            if (result.ok) {
              const parsed = handicapSchema.safeParse(result.data);
              if (
                !parsed.success ||
                Date.parse(parsed.data.retrievedAt) >
                  this.options.now() + 60_000
              )
                return {
                  ok: false,
                  ghinNumber: number,
                  error: safeError(
                    new AppError("UNAVAILABLE", "Invalid provider data"),
                  ),
                };
              return { ok: true, data: { ...parsed.data, freshness: "fresh" } };
            }
            // Only allow known error codes; never forward provider-controlled text.
            const allowed = [
              "NOT_FOUND",
              "NO_HANDICAP",
              "UNAVAILABLE",
              "RATE_LIMITED",
              "AUTH_REQUIRED",
              "FORBIDDEN",
              "LIVE_ACCESS_DISABLED",
              "UNSUPPORTED",
            ];
            return {
              ok: false,
              ghinNumber: number,
              error: safeError(
                new AppError(
                  allowed.includes(result.error.code)
                    ? (result.error.code as AppError["code"])
                    : "UNAVAILABLE",
                  "Provider failure",
                  result.error.retryAfterMs,
                ),
              ),
            };
          });
        } catch (error) {
          if (
            error instanceof AppError &&
            ["AUTH_REQUIRED", "FORBIDDEN"].includes(error.code)
          )
            this.clear(subject);
          const retry =
            error instanceof AppError &&
            (error.code === "UNAVAILABLE" || error.code === "RATE_LIMITED");
          const delay = Math.max(
            error instanceof AppError ? (error.retryAfterMs ?? 0) : 0,
            250 * 2 ** attempt,
          );
          if (!retry || attempt >= this.options.retries || delay > 5000)
            return numbers.map((ghinNumber) => ({
              ok: false,
              ghinNumber,
              error: safeError(error),
            }));
          await this.options.sleep(delay);
        }
      }
    } finally {
      release();
    }
  }
  async getMany(
    subject: string,
    numbers: string[],
    force = false,
  ): Promise<LookupResult[]> {
    await this.assertConnected(subject);
    const unique = [...new Set(numbers)],
      resultPromises = new Map<string, Promise<LookupResult>>(),
      missing: string[] = [];
    for (const number of unique) {
      const key = this.key(subject, number),
        cached = this.cache.get(key),
        pending = this.pending.get(key);
      if (!force && cached && cached.expires > this.options.now())
        resultPromises.set(
          number,
          Promise.resolve({
            ok: true,
            data: { ...cached.data, freshness: "cached" },
          }),
        );
      else if (pending) resultPromises.set(number, pending);
      else missing.push(number);
    }
    const size = this.provider.capabilities.batch ? this.options.batchSize : 1,
      epoch = this.epochs.get(subject) ?? 0;
    for (let i = 0; i < missing.length; i += size) {
      const numbers = missing.slice(i, i + size),
        batch = this.fetchBatch(subject, numbers);
      for (const number of numbers) {
        const key = this.key(subject, number);
        const promise = batch
          .then((results) => {
            const result = results.find((r) =>
              r.ok ? r.data.ghinNumber === number : r.ghinNumber === number,
            )!;
            if (result.ok && (this.epochs.get(subject) ?? 0) !== epoch)
              return {
                ok: false as const,
                ghinNumber: number,
                error: safeError(
                  new AppError("UNAVAILABLE", "Request invalidated."),
                ),
              };
            if (result.ok && (this.epochs.get(subject) ?? 0) === epoch) {
              if (this.cache.size >= this.options.maxCacheEntries)
                this.cache.delete(this.cache.keys().next().value!);
              this.cache.set(key, {
                data: structuredClone(result.data),
                expires:
                  Date.parse(result.data.retrievedAt) + this.options.ttlMs,
              });
            }
            return structuredClone(result);
          })
          .finally(() => {
            if (this.pending.get(key) === promise) this.pending.delete(key);
          });
        this.pending.set(key, promise);
        resultPromises.set(number, promise);
      }
    }
    const results = await Promise.all(
      unique.map((n) => resultPromises.get(n)!),
    );
    if (results.some((result) => result.ok)) {
      try {
        await this.assertConnected(subject);
      } catch (error) {
        // Preserve a meaningful upstream rejection while refusing all successes
        // (including cached values) from the now-inactive session.
        return results.map((result) =>
          result.ok
            ? {
                ok: false as const,
                ghinNumber: result.data.ghinNumber,
                error: safeError(error),
              }
            : result,
        );
      }
    }
    return results;
  }
}
