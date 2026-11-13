/** A bounded diagnostic surface: no identities, URLs, headers or response bodies. */
export const CONTROLLED_TEST_LIMITS = Object.freeze({
  installation: 1,
  login: 1,
  search: 2,
  total: 4,
});
export const CONTROLLED_TEST_MAX_SESSION_MS = 300_000;
export type ControlledStopReason =
  | "invalid_request"
  | "budget_exhausted"
  | "http_error"
  | "invalid_response"
  | "transport_error"
  | "session_expired"
  | "request_timeout"
  | "sdk_error";
export interface ControlledTransportDiagnostics {
  requests: {
    installation: number;
    login: number;
    search: number;
    total: number;
  };
  limits: typeof CONTROLLED_TEST_LIMITS;
  lastStatus: number | null;
  stopReason: ControlledStopReason | null;
  rawRows: number | null;
}
export function emptyControlledDiagnostics(): ControlledTransportDiagnostics {
  return {
    requests: { installation: 0, login: 0, search: 0, total: 0 },
    limits: { ...CONTROLLED_TEST_LIMITS },
    lastStatus: null,
    stopReason: null,
    rawRows: null,
  };
}

/** Applied immediately before each fetch, including SDK-owned retries. */
export class ControlledTestPolicy {
  readonly #ownNumber: string;
  readonly #state = emptyControlledDiagnostics();
  constructor(ownNumber: string) {
    this.#ownNumber = ownNumber;
  }
  stop(reason: ControlledStopReason): void {
    this.#state.stopReason ??= reason;
  }
  get halted(): boolean {
    return this.#state.stopReason !== null;
  }
  beforeRequest(kind: "installation" | "login" | "search", url: URL): void {
    if (this.halted) throw new Error("Controlled test stopped");
    if (kind === "search") {
      const allowed = new Set([
        "source",
        "golfer_id",
        "page",
        "per_page",
        "sorting_criteria",
        "order",
      ]);
      if (
        [...url.searchParams.keys()].some(
          (key) =>
            !allowed.has(key) || url.searchParams.getAll(key).length !== 1,
        ) ||
        url.searchParams.get("golfer_id") !== this.#ownNumber ||
        url.searchParams.get("page") !== "1" ||
        url.searchParams.get("per_page") !== "100"
      ) {
        this.stop("invalid_request");
        throw new Error("Controlled test request rejected");
      }
    } else if (url.search) {
      this.stop("invalid_request");
      throw new Error("Controlled test request rejected");
    }
    const counts = this.#state.requests;
    if (
      counts[kind] >= CONTROLLED_TEST_LIMITS[kind] ||
      counts.total >= CONTROLLED_TEST_LIMITS.total
    ) {
      this.stop("budget_exhausted");
      throw new Error("Controlled test request budget exhausted");
    }
    counts[kind]++;
    counts.total++;
  }
  response(status: number): void {
    this.#state.lastStatus =
      Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : null;
    if (status < 200 || status >= 300) this.stop("http_error");
  }
  rows(count: number): void {
    this.#state.rawRows = count;
  }
  diagnostics(): ControlledTransportDiagnostics {
    return structuredClone(this.#state);
  }
}
