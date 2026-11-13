import { AppError, safeError } from "../domain/errors.js";
import { type LookupResult, type PublicError } from "../domain/models.js";
import type {
  HandicapProvider,
  ProviderContext,
  HistoryEntry,
  ScoreEntry,
  ProviderCapabilities,
  ProviderConnectionState,
} from "./handicap-provider.js";
import type {
  OfflineSpicyGolfOptions,
  SpicyGolfFixtureClient,
  SpicyGolfResult,
} from "./spicygolf-contract.js";

import {
  canonicalSpicyGolfId as canonicalId,
  dateOnly,
  mapSpicyGolfError as mapError,
  mapSpicyGolfBatch as mapBatch,
} from "./spicygolf-mapping.js";

const failure = (ghinNumber: string, error: PublicError): LookupResult => ({
  ok: false,
  ghinNumber,
  error,
});
const unavailable = (): PublicError =>
  safeError(new AppError("UNAVAILABLE", "Incomplete provider response."));
const clientOwners = new WeakMap<object, string>();

class WaitStopped extends Error {}

export class SpicyGolfProvider implements HandicapProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  private readonly options?: OfflineSpicyGolfOptions;
  private readonly stop = new AbortController();
  private disconnected = false;

  constructor(options?: OfflineSpicyGolfOptions) {
    this.id = options ? "spicygolf-offline" : "spicygolf-disabled";
    this.capabilities = Object.freeze({
      batch: !!options,
      history: false,
      scores: false,
      updatedSince: !!options,
      courses: false,
      live: false,
    });
    if (!options) return;
    const batchSize = options.batchSize ?? 50,
      timeoutMs = options.timeoutMs ?? 5000;
    if (
      options.mode !== "offline-fixture" ||
      typeof options.ownerSubject !== "string" ||
      !options.ownerSubject ||
      options.ownerSubject.length > 500 ||
      options.client?.fixtureOnly !== true ||
      typeof options.client.golfers?.getMany !== "function" ||
      !Number.isInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > 100 ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 30_000
    )
      throw new AppError(
        "INVALID_INPUT",
        "Invalid offline fixture configuration.",
      );
    const owner = clientOwners.get(options.client);
    if (owner !== undefined && owner !== options.ownerSubject)
      throw new AppError(
        "FORBIDDEN",
        "Fixture client already belongs to another owner.",
      );
    clientOwners.set(options.client, options.ownerSubject);
    this.options = { ...options, batchSize, timeoutMs };
  }

  private authorize(context: ProviderContext): OfflineSpicyGolfOptions {
    if (!this.options)
      throw new AppError(
        "LIVE_ACCESS_DISABLED",
        "Live GHIN access is disabled.",
      );
    if (context.subject !== this.options.ownerSubject)
      throw new AppError(
        "FORBIDDEN",
        "Fixture client belongs to another owner.",
      );
    if (this.disconnected)
      throw new AppError("AUTH_REQUIRED", "Fixture instance is disconnected.");
    return this.options;
  }

  async assertConnected(context: ProviderContext): Promise<void> {
    this.authorize(context);
  }

  async getConnectionState(
    context: ProviderContext,
  ): Promise<ProviderConnectionState> {
    if (this.options && context.subject !== this.options.ownerSubject)
      throw new AppError(
        "FORBIDDEN",
        "Fixture client belongs to another owner.",
      );
    const connected = Boolean(this.options) && !this.disconnected;
    return {
      authenticated: connected,
      connected,
      credentialsStored: false,
      expiresAt: null,
      limitations: [
        "Demo mode: all handicap data is synthetic. Use --ghin with a connected profile for real GHIN lookups.",
      ],
    };
  }

  /** Bounds waiting and ignores late results; does not cancel SDK-internal work. */
  private async invoke(
    client: SpicyGolfFixtureClient,
    numbers: number[],
    request: { status: null; updated_since?: string },
    signal?: AbortSignal,
  ): Promise<SpicyGolfResult> {
    if (signal?.aborted || this.stop.signal.aborted) throw new WaitStopped();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        this.stop.signal.removeEventListener("abort", cancel);
        callback();
      };
      const cancel = () => finish(() => reject(new WaitStopped()));
      const timer = setTimeout(cancel, this.options!.timeoutMs!);
      signal?.addEventListener("abort", cancel, { once: true });
      this.stop.signal.addEventListener("abort", cancel, { once: true });
      Promise.resolve()
        .then(() => {
          if (settled) throw new WaitStopped();
          return client.golfers.getMany(numbers, request);
        })
        .then(
          (result) => finish(() => resolve(result)),
          (error) => finish(() => reject(error)),
        );
    });
  }

  async getMany(
    context: ProviderContext,
    numbers: string[],
    options?: { updatedSince?: string; signal?: AbortSignal },
  ): Promise<LookupResult[]> {
    const configured = this.authorize(context);
    if (
      !Array.isArray(numbers) ||
      numbers.length < 1 ||
      numbers.length > 500 ||
      numbers.some((v) => typeof v !== "string" || canonicalId(v) !== v)
    )
      throw new AppError("INVALID_INPUT", "Supply canonical GHIN identifiers.");
    if (
      options?.updatedSince !== undefined &&
      (dateOnly(options.updatedSince) !== options.updatedSince ||
        options.updatedSince.length !== 10)
    )
      throw new AppError(
        "INVALID_INPUT",
        "Supply a valid YYYY-MM-DD delta date.",
      );
    if (options?.signal?.aborted)
      throw new AppError("UNAVAILABLE", "Request cancelled.");
    const requested = [...new Set(numbers)],
      output: LookupResult[] = [];
    for (
      let start = 0;
      start < requested.length;
      start += configured.batchSize!
    ) {
      this.authorize(context);
      const batch = requested.slice(start, start + configured.batchSize!);
      let envelope: unknown;
      try {
        const result = await this.invoke(
          configured.client,
          batch.map(Number),
          {
            status: null,
            ...(options?.updatedSince
              ? { updated_since: options.updatedSince }
              : {}),
          },
          options?.signal,
        );
        this.authorize(context);
        if (!result || typeof result.isErr !== "function")
          throw new Error("Invalid result envelope.");
        if (result.isErr()) throw result.error;
        envelope = result.value;
      } catch (error) {
        this.authorize(context);
        if (options?.signal?.aborted)
          throw new AppError("UNAVAILABLE", "Request cancelled.");
        const mapped = mapError(error);
        output.push(...batch.map((number) => failure(number, mapped)));
        if (
          error instanceof WaitStopped ||
          ["AUTH_REQUIRED", "FORBIDDEN", "RATE_LIMITED"].includes(mapped.code)
        ) {
          output.push(
            ...requested
              .slice(start + batch.length)
              .map((number) => failure(number, mapped)),
          );
          break;
        }
        continue;
      }
      try {
        const now = (configured.now ?? (() => new Date()))();
        if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
          throw new Error("Invalid clock.");
        output.push(
          ...mapBatch(envelope, batch, {
            retrievedAt: now.toISOString(),
            allowNames: configured.allowNames === true,
            source: "spicygolf-offline",
            synthetic: true,
          }),
        );
      } catch {
        output.push(...batch.map((number) => failure(number, unavailable())));
      }
    }
    this.authorize(context);
    return output;
  }

  async getHistory(
    context: ProviderContext,
    _number: string,
    _limit: number,
  ): Promise<HistoryEntry[]> {
    this.authorize(context);
    throw new AppError(
      "UNSUPPORTED",
      "SpicyGolf has no verified official index-history method.",
    );
  }
  async getScores(
    context: ProviderContext,
    _number: string,
    _limit: number,
  ): Promise<ScoreEntry[]> {
    this.authorize(context);
    // Published adjusted_gross_score is not the grossScore our contract requires.
    throw new AppError(
      "UNSUPPORTED",
      "Score mapping requires a distinct adjusted-score contract.",
    );
  }
  async disconnect(context: ProviderContext): Promise<void> {
    if (!this.options) return;
    if (context.subject !== this.options.ownerSubject)
      throw new AppError(
        "FORBIDDEN",
        "Fixture client belongs to another owner.",
      );
    this.disconnected = true;
    this.stop.abort();
  }
}
