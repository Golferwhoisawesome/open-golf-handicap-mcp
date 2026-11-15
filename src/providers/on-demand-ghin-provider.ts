import { createHash } from "node:crypto";
import { AppError } from "../domain/errors.js";
import type { LookupResult } from "../domain/models.js";
import type {
  HandicapProvider,
  ProviderConnectionState,
  ProviderContext,
} from "./handicap-provider.js";
import { SpicyGolfSdkSession } from "./spicygolf-sdk-client.js";
import {
  canonicalSpicyGolfId,
  dateOnly,
  mapSpicyGolfBatch,
  mapSpicyGolfError,
} from "./spicygolf-mapping.js";
import { assertLiveAccessEnabled } from "./live-access.js";
import { DAILY_LIMITS, SESSION_LIMITS } from "./request-policy.js";
import type { GhinUsageRepository } from "../desktop/ghin-usage.js";
import type { GhinLogin, GhinMode } from "../desktop/local-profile.js";

export interface OnDemandGhinOptions {
  ownerSubject: string;
  mode: GhinMode;
  /** Reads the current saved login (a fresh copy the provider wipes). */
  loadLogin: () => Promise<GhinLogin | undefined>;
  usage: GhinUsageRepository;
  sessionOptions?: Omit<
    ConstructorParameters<typeof SpicyGolfSdkSession>[0],
    "mode" | "allowance" | "onUsage"
  >;
}

const fingerprint = (login: GhinLogin) =>
  createHash("sha256")
    .update(login.username)
    .update("\0")
    .update(login.password)
    .update("\0")
    .update(login.ownGhinNumber ?? "")
    .digest("hex");

function wipe(login: GhinLogin | undefined) {
  login?.username.fill(0);
  login?.password.fill(0);
}

/** Signs in to GHIN with the saved login only when a lookup needs it, and
 * again after the SDK session expires. A rejected login is not retried until
 * the saved login changes (open-golf-handicap-setup login). */
export class OnDemandGhinProvider implements HandicapProvider {
  readonly id: string;
  readonly capabilities;
  #session?: SpicyGolfSdkSession;
  #connecting?: Promise<SpicyGolfSdkSession>;
  #disconnected = false;
  #rejectedLogin?: string;
  #lastError?: AppError;
  /** The number GHIN reported at sign-in, when the saved login lacks one. */
  #reportedNumber?: string;
  constructor(private readonly options: OnDemandGhinOptions) {
    if (!options.ownerSubject || options.ownerSubject.length > 500)
      throw new AppError("INVALID_INPUT", "Invalid connection owner.");
    this.id =
      options.mode === "ghin" ? "ghin-spicygolf" : "spicygolf-sdk-offline";
    this.capabilities = Object.freeze({
      batch: true,
      history: false,
      scores: false,
      updatedSince: true,
      courses: false,
      live: options.mode === "ghin",
    });
  }
  #owner(context: ProviderContext) {
    if (context.subject !== this.options.ownerSubject)
      throw new AppError("FORBIDDEN", "Connection belongs to another owner.");
  }
  async #open(): Promise<SpicyGolfSdkSession> {
    if (this.options.mode === "ghin") assertLiveAccessEnabled();
    const state = await this.options.usage.allowance();
    if (this.options.mode === "ghin" && !state.acknowledged)
      throw new AppError(
        "AUTH_REQUIRED",
        "Run open-golf-handicap-setup login and accept the unofficial-use notice first.",
      );
    if (state.forbidden)
      throw new AppError(
        "FORBIDDEN",
        "GHIN refused access earlier. Run open-golf-handicap-setup login to sign in again.",
      );
    if (state.cooldownUntil > Date.now())
      throw new AppError(
        "RATE_LIMITED",
        "GHIN asked this app to slow down. Try again later.",
        state.cooldownUntil - Date.now(),
      );
    if (state.login < 1 || state.search < 1)
      throw new AppError(
        "RATE_LIMITED",
        "This app's daily GHIN request limit was reached. Try again tomorrow.",
      );
    const login = await this.options.loadLogin();
    try {
      if (!login)
        throw new AppError(
          "AUTH_REQUIRED",
          "No GHIN login is saved. Run open-golf-handicap-setup login.",
        );
      if (login.mode !== this.options.mode)
        throw new AppError(
          "AUTH_REQUIRED",
          "The saved login belongs to a different mode. Run open-golf-handicap-setup login again.",
        );
      const print = fingerprint(login);
      if (this.#rejectedLogin === print)
        throw new AppError(
          "AUTH_REQUIRED",
          "GHIN rejected the saved login. Run open-golf-handicap-setup login with the correct details.",
        );
      const usage = this.options.usage;
      const session: SpicyGolfSdkSession = new SpicyGolfSdkSession({
        ...this.options.sessionOptions,
        mode: this.options.mode,
        allowance: {
          login: state.login,
          search: state.search,
          cooldownUntil: state.cooldownUntil,
        },
        onUsage: (event) => {
          // Fail closed: an unrecorded request ends the session.
          usage.record(event).catch(() => {
            void session.close();
          });
        },
      });
      const copy = {
        username: Buffer.from(login.username),
        password: Buffer.from(login.password),
        ownGhinNumber: login.ownGhinNumber ?? "",
        accountType: login.accountType,
      };
      try {
        const connected = await session.connect(copy);
        if (connected.ownGhinNumber)
          this.#reportedNumber = connected.ownGhinNumber;
      } catch (error) {
        await session.close();
        if (
          error instanceof AppError &&
          (error.code === "AUTH_REQUIRED" || error.code === "FORBIDDEN")
        )
          this.#rejectedLogin = print;
        throw error;
      } finally {
        copy.username.fill(0);
        copy.password.fill(0);
      }
      this.#rejectedLogin = undefined;
      return session;
    } finally {
      wipe(login);
    }
  }
  async #ready(): Promise<SpicyGolfSdkSession> {
    if (this.#disconnected)
      throw new AppError(
        "AUTH_REQUIRED",
        "Disconnected. Restart your AI app to reconnect.",
      );
    if (this.#session?.status().authenticated) return this.#session;
    if (!this.#connecting) {
      const previous = this.#session;
      this.#session = undefined;
      void previous?.close();
      this.#connecting = this.#open()
        .then((session) => {
          this.#lastError = undefined;
          if (this.#disconnected) {
            void session.close();
            throw new AppError("AUTH_REQUIRED", "Disconnected.");
          }
          this.#session = session;
          return session;
        })
        .catch((error: unknown) => {
          this.#lastError =
            error instanceof AppError
              ? error
              : new AppError("UNAVAILABLE", "GHIN sign-in did not complete.");
          throw this.#lastError;
        })
        .finally(() => {
          this.#connecting = undefined;
        });
    }
    return this.#connecting;
  }
  async assertConnected(context: ProviderContext): Promise<void> {
    this.#owner(context);
    if (this.#disconnected)
      throw new AppError(
        "AUTH_REQUIRED",
        "Disconnected. Restart your AI app to reconnect.",
      );
  }
  async getConnectionState(
    context: ProviderContext,
  ): Promise<ProviderConnectionState> {
    this.#owner(context);
    const login = await this.options.loadLogin().catch(() => undefined);
    const stored = login !== undefined && login.mode === this.options.mode;
    const ownGhinNumber = stored
      ? (login?.ownGhinNumber ?? this.#reportedNumber ?? null)
      : null;
    wipe(login);
    const state = await this.options.usage.allowance();
    const status = this.#session?.status();
    const signedIn = !this.#disconnected && status?.authenticated === true;
    return {
      authenticated: signedIn,
      connected: !this.#disconnected && stored && !state.forbidden,
      credentialsStored: stored,
      ownGhinNumber,
      expiresAt:
        signedIn && status?.expiresAt
          ? new Date(status.expiresAt).toISOString()
          : null,
      limitations: [
        this.options.mode === "ghin"
          ? "Unofficial GHIN connection using your own saved GHIN login; read-only. Not affiliated with or endorsed by the USGA or GHIN."
          : "Offline SDK test mode with synthetic responses; no GHIN access.",
        stored
          ? "Signs in to GHIN automatically when a lookup needs it."
          : "No GHIN login is saved. Run open-golf-handicap-setup login in a terminal.",
        `Local limits: ${SESSION_LIMITS.search} GHIN requests per session; ${state.search} of ${DAILY_LIMITS.search} lookups left in the last 24 hours.`,
        ...(state.cooldownUntil > Date.now()
          ? [
              `GHIN asked this app to slow down; lookups resume after ${new Date(state.cooldownUntil).toISOString()}.`,
            ]
          : []),
        ...(state.forbidden
          ? [
              "GHIN refused access. Run open-golf-handicap-setup login to sign in again.",
            ]
          : []),
        ...(this.#lastError
          ? [`Last sign-in problem: ${this.#lastError.code}.`]
          : []),
        "Official index history and score mapping are unavailable.",
      ],
    };
  }
  async getMany(
    context: ProviderContext,
    numbers: string[],
    options?: { updatedSince?: string; signal?: AbortSignal },
  ): Promise<LookupResult[]> {
    await this.assertConnected(context);
    if (
      !Array.isArray(numbers) ||
      numbers.length < 1 ||
      numbers.length > 100 ||
      numbers.some((number) => canonicalSpicyGolfId(number) !== number)
    )
      throw new AppError("INVALID_INPUT", "Invalid GHIN identifiers.");
    if (
      options?.updatedSince !== undefined &&
      (options.updatedSince.length !== 10 ||
        dateOnly(options.updatedSince) !== options.updatedSince)
    )
      throw new AppError("INVALID_INPUT", "Invalid delta date.");
    if (options?.signal?.aborted)
      throw new AppError("UNAVAILABLE", "Request was cancelled.");
    const session = await this.#ready();
    const stop = () => {
      void session.close();
    };
    options?.signal?.addEventListener("abort", stop, { once: true });
    try {
      const unique = [...new Set(numbers)];
      const result = await session.getMany(unique.map(Number), {
        status: null,
        ...(options?.updatedSince
          ? { updated_since: options.updatedSince }
          : {}),
      });
      if (options?.signal?.aborted)
        throw new AppError("UNAVAILABLE", "Request was cancelled.");
      if (result.isErr()) {
        const error = mapSpicyGolfError(result.error);
        if (["AUTH_REQUIRED", "FORBIDDEN"].includes(error.code))
          await session.close();
        throw new AppError(
          error.code as AppError["code"],
          error.message,
          error.retryAfterMs,
        );
      }
      await this.assertConnected(context);
      return mapSpicyGolfBatch(result.value, unique, {
        source: this.id,
        synthetic: this.options.mode === "offline-test",
        allowNames: true,
        retrievedAt: new Date().toISOString(),
      });
    } finally {
      options?.signal?.removeEventListener("abort", stop);
    }
  }
  async getHistory(context: ProviderContext): Promise<never> {
    await this.assertConnected(context);
    throw new AppError(
      "UNSUPPORTED",
      "Official index history is not implemented.",
    );
  }
  async getScores(context: ProviderContext): Promise<never> {
    await this.assertConnected(context);
    throw new AppError("UNSUPPORTED", "Score semantics have not been mapped.");
  }
  /** Ends this process's GHIN session. The saved login stays until logout. */
  async disconnect(context: ProviderContext): Promise<void> {
    this.#owner(context);
    this.#disconnected = true;
    await this.#connecting?.catch(() => undefined);
    await this.#session?.close();
    this.#session = undefined;
  }
  async close(): Promise<void> {
    this.#disconnected = true;
    await this.#connecting?.catch(() => undefined);
    await this.#session?.close();
  }
}
