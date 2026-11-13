import { AppError } from "../domain/errors.js";
import type { LookupResult } from "../domain/models.js";
import type {
  HandicapProvider,
  ProviderContext,
  ProviderConnectionState,
} from "./handicap-provider.js";
import { SpicyGolfSdkSession } from "./spicygolf-sdk-client.js";
import {
  canonicalSpicyGolfId,
  dateOnly,
  mapSpicyGolfBatch,
  mapSpicyGolfError,
} from "./spicygolf-mapping.js";
import { assertLiveAccessEnabled } from "./live-access.js";
import {
  GhinCredentialRepository,
  type CredentialInput,
} from "../desktop/ghin-credentials.js";
import type { GhinUsageRepository } from "../desktop/ghin-usage.js";

export type GhinMode = "offline-test" | "ghin";
export interface GhinProviderOptions {
  ownerSubject: string;
  mode: GhinMode;
  repository: GhinCredentialRepository;
  /** Persistent daily limits, cooldowns and live-use acknowledgment. */
  usage?: GhinUsageRepository;
  credentials?: CredentialInput;
  remember?: boolean;
  signal?: AbortSignal;
  onConnectionFailure?: (
    diagnostics: ReturnType<SpicyGolfSdkSession["diagnostics"]>,
  ) => void;
  sessionOptions?: Omit<
    ConstructorParameters<typeof SpicyGolfSdkSession>[0],
    "mode" | "allowance" | "onUsage"
  >;
}

function wipe(input: CredentialInput) {
  input.username.fill(0);
  input.password.fill(0);
}

/** A single desktop connection owns one SDK worker. No credentials enter MCP. */
export class GhinAuthenticatedProvider implements HandicapProvider {
  readonly id: string;
  readonly capabilities;
  private disconnected = false;
  private constructor(
    private readonly options: GhinProviderOptions,
    private readonly generation: string,
    private readonly session: SpicyGolfSdkSession,
  ) {
    this.id =
      options.mode === "ghin" ? "ghin-spicygolf" : "spicygolf-sdk-offline";
    this.capabilities = Object.freeze({
      batch: options.sessionOptions?.controlledTest !== true,
      history: false,
      scores: false,
      updatedSince: options.sessionOptions?.controlledTest !== true,
      courses: false,
      live: options.mode === "ghin",
    });
  }
  static async connect(
    options: GhinProviderOptions,
  ): Promise<GhinAuthenticatedProvider> {
    if (options.mode === "ghin") assertLiveAccessEnabled();
    // A controlled test never resumes or persists a login. Validate this before
    // touching any existing connection generation in the user's vault.
    if (
      options.sessionOptions?.controlledTest &&
      (options.remember ||
        !options.credentials ||
        options.credentials.accountType !== "golfer")
    )
      throw new AppError(
        "INVALID_INPUT",
        "Controlled tests require fresh session-only golfer credentials.",
      );
    if (!options.ownerSubject || options.ownerSubject.length > 500)
      throw new AppError("INVALID_INPUT", "Invalid connection owner.");
    if (options.signal?.aborted)
      throw new AppError("AUTH_REQUIRED", "Connection was cancelled.");
    if (options.mode === "ghin" && !options.usage)
      throw new AppError(
        "INVALID_INPUT",
        "Live sessions require the persistent usage ledger.",
      );
    let allowance: { login: number; search: number; cooldownUntil: number };
    if (options.usage) {
      const state = await options.usage.allowance();
      if (options.mode === "ghin" && !state.acknowledged)
        throw new AppError(
          "AUTH_REQUIRED",
          "Run connect-ghin in a private terminal and accept the unofficial-use notice first.",
        );
      if (state.forbidden) {
        if (!options.credentials)
          throw new AppError(
            "FORBIDDEN",
            "GHIN refused access in an earlier session. Run connect-ghin to sign in again.",
          );
        await options.usage.clearForbidden();
      }
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
      allowance = {
        login: state.login,
        search: state.search,
        cooldownUntil: state.cooldownUntil,
      };
    }
    const pending = options.credentials
      ? await options.repository.begin(options.credentials, {
          remember: options.remember === true,
          mode: options.mode,
        })
      : await options.repository.beginRemembered(options.mode);
    if (!pending)
      throw new AppError(
        "AUTH_REQUIRED",
        "No retained connection is available.",
      );
    let session: SpicyGolfSdkSession | undefined;
    const cancelled = () => {
      void session?.close();
    };
    try {
      if (options.signal?.aborted)
        throw new AppError("AUTH_REQUIRED", "Connection was cancelled.");
      const usage = options.usage;
      session = new SpicyGolfSdkSession({
        ...options.sessionOptions,
        mode: options.mode,
        ...(usage
          ? {
              allowance: allowance!,
              onUsage: (event) => {
                // Fail closed: an unrecorded request ends the session.
                usage.record(event).catch(() => {
                  void session?.close();
                });
              },
            }
          : {}),
      });
      options.signal?.addEventListener("abort", cancelled, { once: true });
      const credentials = pending.copyCredentials();
      try {
        await session.connect(credentials);
      } finally {
        wipe(credentials);
      }
      if (options.signal?.aborted)
        throw new AppError("AUTH_REQUIRED", "Connection was cancelled.");
      if (!(await options.repository.commit(pending.id)))
        throw new AppError(
          "AUTH_REQUIRED",
          "Connection changed during sign-in.",
        );
      if (options.signal?.aborted)
        throw new AppError("AUTH_REQUIRED", "Connection was cancelled.");
      // Do not retain the original credentials through a configuration object.
      const { credentials: _credentials, ...configuration } = options;
      return new GhinAuthenticatedProvider(configuration, pending.id, session);
    } catch (error) {
      await session?.close();
      await options.repository.cancel(pending.id);
      if (options.sessionOptions?.controlledTest && session)
        options.onConnectionFailure?.(session.diagnostics());
      throw error instanceof AppError
        ? error
        : new AppError("AUTH_REQUIRED", "Private sign-in did not complete.");
    } finally {
      options.signal?.removeEventListener("abort", cancelled);
      pending.dispose();
    }
  }
  private owner(context: ProviderContext) {
    if (context.subject !== this.options.ownerSubject)
      throw new AppError("FORBIDDEN", "Connection belongs to another owner.");
  }
  async assertConnected(context: ProviderContext): Promise<void> {
    this.owner(context);
    if (
      this.disconnected ||
      this.options.signal?.aborted ||
      !this.session.status().authenticated ||
      !(await this.options.repository.isCurrent(this.generation))
    ) {
      await this.session.close();
      throw new AppError(
        "AUTH_REQUIRED",
        "Sign in again in the private terminal.",
      );
    }
  }
  async getConnectionState(
    context: ProviderContext,
  ): Promise<ProviderConnectionState> {
    this.owner(context);
    const saved = await this.options.repository.status();
    const session = this.session.status();
    const connected =
      !this.disconnected &&
      !this.options.signal?.aborted &&
      saved.connected &&
      saved.generation === this.generation &&
      session.authenticated;
    return {
      authenticated: connected,
      connected,
      credentialsStored: saved.remembered,
      controlledTest: this.options.sessionOptions?.controlledTest === true,
      expiresAt:
        session.expiresAt === null
          ? null
          : new Date(session.expiresAt).toISOString(),
      limitations: [
        ...(this.options.sessionOptions?.controlledTest
          ? [
              "Controlled test: only the privately supplied golfer; at most five minutes and four HTTP requests (one installation, one login, two reads). Any transport error ends provider access. Cached reads add no requests.",
            ]
          : []),
        this.options.mode === "ghin"
          ? "Unofficial GHIN connection using your own GHIN sign-in; read-only. Not affiliated with or endorsed by the USGA or GHIN. Local limits: 60 GHIN requests per session and 200 per day."
          : "Actual SpicyGolf SDK with intercepted synthetic HTTP responses; no live GHIN access.",
        "Official index history and score mapping are unavailable.",
        "Disconnect deletes locally retained credentials; remote token revocation is not established.",
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
    const stop = () => {
      void this.session.close();
    };
    options?.signal?.addEventListener("abort", stop, { once: true });
    try {
      const unique = [...new Set(numbers)];
      const result = await this.session.getMany(unique.map(Number), {
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
          await this.session.close();
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
  async getHistory(
    context: ProviderContext,
    _number: string,
    _limit: number,
  ): Promise<never> {
    await this.assertConnected(context);
    throw new AppError(
      "UNSUPPORTED",
      "Official index history is not implemented.",
    );
  }
  async getScores(
    context: ProviderContext,
    _number: string,
    _limit: number,
  ): Promise<never> {
    await this.assertConnected(context);
    throw new AppError("UNSUPPORTED", "Score semantics have not been mapped.");
  }
  async disconnect(context: ProviderContext): Promise<void> {
    this.owner(context);
    this.disconnected = true;
    await this.session.close();
    if (!(await this.options.repository.cancel(this.generation)))
      throw new AppError(
        "CONFLICT",
        "The saved connection changed; disconnect its current generation privately.",
      );
  }
  /** Lock/expiry ends the worker; explicit remember consent survives session exit. */
  async close(): Promise<void> {
    this.disconnected = true;
    await this.session.close();
  }
  /** Fixed nonsecret diagnostics for the owner's private test terminal. */
  diagnostics(context: ProviderContext) {
    this.owner(context);
    return this.session.diagnostics();
  }
}
