import { Worker } from "node:worker_threads";
import { AppError, type ErrorCode } from "../domain/errors.js";
import type { SpicyGolfResult } from "./spicygolf-contract.js";
import {
  fixtureScenarios,
  isSyntheticSdkPassword,
  isSdkFixtureIdentifier,
  type SdkFixtureScenario,
} from "./spicygolf-sdk-fixtures.js";
import { assertLiveAccessEnabled, liveAccessEnabled } from "./live-access.js";
import {
  validAllowance,
  type RequestKind,
  type UsageAllowance,
} from "./request-policy.js";
import {
  CONTROLLED_TEST_MAX_SESSION_MS,
  emptyControlledDiagnostics,
  type ControlledTransportDiagnostics,
  type ControlledStopReason,
} from "./controlled-test-policy.js";

export interface SdkSessionOptions {
  mode: "offline-test" | "ghin";
  timeoutMs?: number;
  maxSessionMs?: number;
  fixtureScenario?: SdkFixtureScenario;
  controlledTest?: boolean;
  /** Remaining daily allowance from the persistent ledger. */
  allowance?: UsageAllowance;
  /** Receives nonsecret request/cooldown/forbidden events for persistence. */
  onUsage?: (event: SdkUsageEvent) => void;
}
export interface SdkUsageEvent {
  at: number;
  request?: RequestKind;
  cooldownUntil?: number;
  forbidden?: true;
}
export interface SdkCredentials {
  username: Buffer;
  password: Buffer;
  ownGhinNumber: string;
  accountType: "golfer" | "api";
}
type WireReply = {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: { code: string; statusCode?: number; retryAfter?: number };
  terminal?: boolean;
  usage?: SdkUsageEvent;
  diagnostics?: ControlledTransportDiagnostics;
  stats?: {
    installationRequests: number;
    loginRequests: number;
    batchRequests: number;
    blockedRequests: number;
  };
};
const unavailable = () =>
  new AppError("UNAVAILABLE", "SDK operation did not complete.");
function asError(reply: WireReply): AppError {
  if (reply.terminal)
    return new AppError(
      "AUTH_REQUIRED",
      "Controlled test stopped. No further provider requests are permitted.",
    );
  if (reply.error?.code === "LOCAL_LIMIT_ERROR")
    return new AppError(
      "RATE_LIMITED",
      "This app's local safety limit was reached (60 GHIN requests per session, 200 per day). Try again later.",
      3_600_000,
    );
  const code: ErrorCode =
    reply.error?.statusCode === 429 || reply.error?.code === "RATE_LIMIT_ERROR"
      ? "RATE_LIMITED"
      : reply.error?.statusCode === 403
        ? "FORBIDDEN"
        : reply.error?.statusCode === 401 ||
            reply.error?.code === "AUTHENTICATION_ERROR"
          ? "AUTH_REQUIRED"
          : reply.error?.code === "LIVE_ACCESS_DISABLED"
            ? "LIVE_ACCESS_DISABLED"
            : reply.error?.code === "INVALID_INPUT"
              ? "INVALID_INPUT"
              : "UNAVAILABLE";
  const retrySeconds = reply.error?.retryAfter;
  return new AppError(
    code,
    "SDK operation failed.",
    code === "RATE_LIMITED" &&
    typeof retrySeconds === "number" &&
    Number.isFinite(retrySeconds) &&
    retrySeconds >= 0
      ? Math.ceil(retrySeconds * 1000)
      : undefined,
  );
}
/** One owner/session per isolated worker. Credentials never enter argv or env.
 * Closing terminates the SDK, including its password-bearing config and retries.
 */
export class SpicyGolfSdkSession {
  #worker?: Worker;
  #closed = false;
  #authenticated = false;
  #expiresAt: number | null = null;
  #timer?: ReturnType<typeof setTimeout>;
  #next = 1;
  #closing?: Promise<void>;
  #workerStarted = false;
  #workerExited = false;
  #ownNumber?: string;
  #diagnostics = emptyControlledDiagnostics();
  #pending = new Map<
    number,
    {
      resolve: (reply: WireReply) => void;
      reject: (error: AppError) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  #stats = {
    installationRequests: 0,
    loginRequests: 0,
    batchRequests: 0,
    blockedRequests: 0,
  };
  readonly #options: Required<Omit<SdkSessionOptions, "allowance" | "onUsage">>;
  readonly #allowance: UsageAllowance | undefined;
  readonly #onUsage: SdkSessionOptions["onUsage"];
  constructor(options: SdkSessionOptions) {
    // Paced requests (two seconds apart) plus SDK backoff need headroom.
    const timeoutMs = options.timeoutMs ?? 30_000,
      requestedSessionMs = options.maxSessionMs ?? 3_600_000,
      controlledTest = options.controlledTest ?? false,
      fixtureScenario = options.fixtureScenario ?? "happy";
    if (
      !["ghin", "offline-test"].includes(options.mode) ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 50 ||
      timeoutMs > 30_000 ||
      !Number.isInteger(requestedSessionMs) ||
      requestedSessionMs < 100 ||
      requestedSessionMs > 3_600_000 ||
      typeof controlledTest !== "boolean" ||
      !fixtureScenarios.includes(fixtureScenario) ||
      (options.allowance !== undefined && !validAllowance(options.allowance)) ||
      (options.onUsage !== undefined && typeof options.onUsage !== "function")
    )
      throw new AppError("INVALID_INPUT", "Invalid SDK session options.");
    if (options.mode === "ghin" && options.fixtureScenario !== undefined)
      throw new AppError(
        "INVALID_INPUT",
        "Fixtures are unavailable for live sessions.",
      );
    this.#options = {
      mode: options.mode,
      timeoutMs,
      maxSessionMs: controlledTest
        ? Math.min(requestedSessionMs, CONTROLLED_TEST_MAX_SESSION_MS)
        : requestedSessionMs,
      fixtureScenario,
      controlledTest,
    };
    this.#allowance = options.allowance ? { ...options.allowance } : undefined;
    this.#onUsage = options.onUsage;
  }
  async connect(credentials: SdkCredentials): Promise<{ expiresAt: number }> {
    if (this.#options.mode === "ghin") assertLiveAccessEnabled();
    if (this.#worker || this.#closed)
      throw new AppError("CONFLICT", "Create a new SDK session.");
    if (
      !Buffer.isBuffer(credentials.username) ||
      !Buffer.isBuffer(credentials.password) ||
      credentials.username.length < 1 ||
      credentials.username.length > 254 ||
      credentials.password.length < 1 ||
      credentials.password.length > 1024 ||
      !/^[1-9]\d{5,9}$/.test(credentials.ownGhinNumber) ||
      !["golfer", "api"].includes(credentials.accountType)
    )
      throw new AppError("INVALID_INPUT", "Invalid private credentials.");
    if (this.#options.controlledTest && credentials.accountType !== "golfer")
      throw new AppError(
        "INVALID_INPUT",
        "Controlled tests require a golfer account.",
      );
    this.#ownNumber = credentials.ownGhinNumber;
    if (
      this.#options.mode === "offline-test" &&
      (!/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.invalid$/.test(
        credentials.username.toString("utf8"),
      ) ||
        !isSyntheticSdkPassword(credentials.password) ||
        !/^90000000[1-5]$/.test(credentials.ownGhinNumber))
    )
      throw new AppError(
        "INVALID_INPUT",
        "Offline tests accept only synthetic credentials and fixture identifiers.",
      );
    if (
      this.#options.mode === "ghin" &&
      (/\.invalid$/i.test(credentials.username.toString("utf8")) ||
        isSdkFixtureIdentifier(credentials.ownGhinNumber))
    )
      throw new AppError(
        "INVALID_INPUT",
        "Synthetic identities cannot be used with GHIN.",
      );
    const username = Buffer.from(credentials.username),
      password = Buffer.from(credentials.password);
    const source = import.meta.url.endsWith(".ts");
    const workerUrl = new URL(
      source ? "spicygolf-sdk-worker.ts" : "spicygolf-sdk-worker.js",
      import.meta.url,
    );
    // tsx's --import hook does not remap worker entry imports on every Node
    // release. Source-only tests register its scoped loader explicitly; installed
    // JavaScript uses the ordinary worker file and has no tsx runtime dependency.
    const entry = source
      ? new URL(
          `data:text/javascript,${encodeURIComponent(`import {tsImport} from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; await tsImport(${JSON.stringify(workerUrl.href)},${JSON.stringify(import.meta.url)});`)}`,
        )
      : workerUrl;
    try {
      this.#worker = new Worker(entry, {
        workerData: {
          ...this.#options,
          ...(this.#allowance ? { allowance: this.#allowance } : {}),
          liveAccessDisabledForTesting: !liveAccessEnabled(),
          credentials: { ...credentials, username, password },
        },
        execArgv: [],
        stdout: true,
        stderr: true,
      });
      this.#workerStarted = true;
    } finally {
      username.fill(0);
      password.fill(0);
    }
    this.#worker.stdout?.resume();
    this.#worker.stderr?.resume();
    this.#worker.on("message", (reply: WireReply) => {
      if (reply.stats) this.#stats = reply.stats;
      if (reply.diagnostics) this.#diagnostics = reply.diagnostics;
      if (reply.usage && this.#onUsage) {
        try {
          this.#onUsage({ ...reply.usage });
        } catch {
          void this.close();
        }
      }
      const pending = this.#pending.get(reply?.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(reply.id);
      pending.resolve(reply);
    });
    this.#worker.on("error", () => {
      this.#stopReason("transport_error");
      void this.close();
    });
    this.#worker.on("exit", () => {
      this.#workerExited = true;
      void this.close();
    });
    try {
      const result = await this.#request("connect", {});
      if (this.#closed || !this.#worker) throw unavailable();
      if (!result.ok) throw asError(result);
      const expiry = (result.value as { expiresAt?: unknown })?.expiresAt;
      if (
        typeof expiry !== "number" ||
        expiry <= Date.now() ||
        expiry > Date.now() + this.#options.maxSessionMs + 1000
      )
        throw unavailable();
      this.#authenticated = true;
      this.#expiresAt = expiry;
      this.#timer = setTimeout(
        () => {
          this.#stopReason("session_expired");
          void this.close();
        },
        Math.max(0, expiry - Date.now()),
      );
      return { expiresAt: expiry };
    } catch (error) {
      await this.close();
      throw error instanceof AppError ? error : unavailable();
    }
  }
  status() {
    return {
      authenticated:
        this.#authenticated &&
        !this.#closed &&
        this.#expiresAt !== null &&
        this.#expiresAt > Date.now(),
      expiresAt: this.#expiresAt,
    };
  }
  /** Nonsecret counters only; unavailable for live sessions. */
  offlineDiagnostics() {
    if (this.#options.mode !== "offline-test")
      throw new AppError("UNSUPPORTED", "Offline diagnostics only.");
    return { ...this.#stats };
  }
  /** Counts and lifecycle only; never includes the privately entered identifier. */
  diagnostics() {
    if (!this.#options.controlledTest)
      throw new AppError("UNSUPPORTED", "Controlled test diagnostics only.");
    return {
      mode: this.#options.mode,
      controlledTest: this.#options.controlledTest,
      maxSessionMs: this.#options.maxSessionMs,
      workerStarted: this.#workerStarted,
      workerExited: this.#workerExited,
      ...structuredClone(this.#diagnostics),
    };
  }
  #stopReason(reason: ControlledStopReason) {
    if (this.#options.controlledTest) this.#diagnostics.stopReason ??= reason;
  }
  async getMany(
    numbers: number[],
    request: { status: null; updated_since?: string },
  ): Promise<SpicyGolfResult> {
    if (!this.status().authenticated)
      throw new AppError(
        "AUTH_REQUIRED",
        "Private session expired or disconnected.",
      );
    if (
      this.#options.controlledTest &&
      (!Array.isArray(numbers) ||
        numbers.length !== 1 ||
        !Number.isSafeInteger(numbers[0]) ||
        String(numbers[0]) !== this.#ownNumber ||
        !request ||
        request.status !== null ||
        request.updated_since !== undefined)
    ) {
      this.#stopReason("invalid_request");
      await this.close();
      throw new AppError(
        "INVALID_INPUT",
        "Controlled tests permit only the approved golfer lookup.",
      );
    }
    if (
      !Array.isArray(numbers) ||
      numbers.length < 1 ||
      numbers.length > 500 ||
      numbers.some(
        (number) =>
          !Number.isSafeInteger(number) ||
          !/^[1-9]\d{5,9}$/.test(String(number)),
      ) ||
      request.status !== null ||
      (request.updated_since !== undefined &&
        !/^\d{4}-\d{2}-\d{2}$/.test(request.updated_since))
    )
      throw new AppError("INVALID_INPUT", "Invalid SDK lookup.");
    if (
      this.#options.mode === "ghin" &&
      numbers.some((number) => isSdkFixtureIdentifier(String(number)))
    )
      throw new AppError(
        "INVALID_INPUT",
        "Synthetic identifiers cannot be sent to GHIN.",
      );
    let reply: WireReply;
    try {
      reply = await this.#request("getMany", { numbers, request });
    } catch (error) {
      if (this.#options.controlledTest) await this.close();
      throw error;
    }
    if (reply.terminal) {
      await this.close();
      throw asError(reply);
    }
    if (reply.error?.statusCode === 401 || reply.error?.statusCode === 403)
      await this.close();
    return reply.ok
      ? { isErr: () => false, value: reply.value }
      : { isErr: () => true, error: reply.error };
  }
  #request(operation: string, args: unknown): Promise<WireReply> {
    if (!this.#worker || this.#closed) return Promise.reject(unavailable());
    if (this.#pending.size >= 32)
      return Promise.reject(
        new AppError(
          "RATE_LIMITED",
          "Too many pending private SDK operations.",
        ),
      );
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#stopReason("request_timeout");
        void this.close();
      }, this.#options.timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#worker!.postMessage({ id, operation, args });
    });
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#authenticated = false;
    this.#expiresAt = null;
    this.#ownNumber = undefined;
    if (this.#timer) clearTimeout(this.#timer);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        this.#options.controlledTest
          ? new AppError("AUTH_REQUIRED", "Controlled test session ended.")
          : unavailable(),
      );
    }
    this.#pending.clear();
    const worker = this.#worker;
    this.#worker = undefined;
    if (worker) {
      try {
        worker.postMessage({ operation: "close" });
      } catch {
        /* An exiting worker is already unavailable. */
      }
    }
    this.#closing = worker
      ? worker.terminate().then(
          () => undefined,
          () => undefined,
        )
      : Promise.resolve();
    return this.#closing;
  }
  toJSON() {
    return {
      provider: "spicygolf",
      ...this.status(),
      credentials: "[REDACTED]",
    };
  }
}
