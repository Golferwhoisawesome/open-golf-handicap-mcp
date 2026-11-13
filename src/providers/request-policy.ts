/** Conservative local limits for every SDK session. These are this project's
 * own policy, not quotas published or approved by GHIN. */
export const SESSION_LIMITS = Object.freeze({
  installation: 2,
  // Initial sign-in plus at most two token refreshes in one session.
  login: 3,
  search: 60,
});
export const DAILY_LIMITS = Object.freeze({ login: 10, search: 200 });
export const DAILY_WINDOW_MS = 24 * 60 * 60_000;
/** Applied after a 429 without a usable Retry-After header. */
export const DEFAULT_COOLDOWN_MS = 15 * 60_000;
/** A failed request may be retried once within one command, then it stops. */
export const MAX_FAILURES_PER_COMMAND = 2;

export type RequestKind = "installation" | "login" | "search";

/** Remaining daily allowance supplied by the persistent usage ledger. */
export interface UsageAllowance {
  login: number;
  search: number;
  cooldownUntil: number;
}
export const UNLIMITED_ALLOWANCE: UsageAllowance = Object.freeze({
  login: Number.MAX_SAFE_INTEGER,
  search: Number.MAX_SAFE_INTEGER,
  cooldownUntil: 0,
});

export function validAllowance(value: unknown): value is UsageAllowance {
  const candidate = value as Partial<UsageAllowance> | undefined;
  return (
    !!candidate &&
    Number.isSafeInteger(candidate.login) &&
    candidate.login! >= 0 &&
    Number.isSafeInteger(candidate.search) &&
    candidate.search! >= 0 &&
    Number.isSafeInteger(candidate.cooldownUntil) &&
    candidate.cooldownUntil! >= 0
  );
}

/** Counts every outgoing HTTP request, including SDK-internal retries. */
export class SessionRequestPolicy {
  readonly #counts = { installation: 0, login: 0, search: 0 };
  readonly #allowance: UsageAllowance;
  #commandFailures = 0;
  #limitReached = false;
  constructor(allowance: UsageAllowance = UNLIMITED_ALLOWANCE) {
    this.#allowance = { ...allowance };
  }
  /** True after any session or daily limit refused a request. */
  get limitReached(): boolean {
    return this.#limitReached;
  }
  get cooldownUntil(): number {
    return this.#allowance.cooldownUntil;
  }
  startCommand(): void {
    this.#commandFailures = 0;
  }
  /** Returns false (and sends nothing) when the request must not be made. */
  admit(kind: RequestKind): boolean {
    if (this.#commandFailures >= MAX_FAILURES_PER_COMMAND) return false;
    const daily =
      kind === "installation" ? Number.MAX_SAFE_INTEGER : this.#allowance[kind];
    if (this.#counts[kind] >= SESSION_LIMITS[kind] || daily <= 0) {
      this.#limitReached = true;
      return false;
    }
    this.#counts[kind]++;
    if (kind !== "installation") this.#allowance[kind]--;
    return true;
  }
  /** Record the outcome of an admitted request. */
  outcome(ok: boolean): void {
    if (!ok) this.#commandFailures++;
  }
  counts() {
    return { ...this.#counts };
  }
}
