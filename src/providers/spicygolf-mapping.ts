import { AppError, safeError } from "../domain/errors.js";
import {
  formatIndex,
  type LookupResult,
  type PublicError,
} from "../domain/models.js";

export interface SpicyGolfMappingOptions {
  source: string;
  synthetic: boolean;
  allowNames: boolean;
  retrievedAt: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
export const canonicalSpicyGolfId = (value: unknown): string | undefined => {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    return undefined;
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const text = String(value);
  return /^[1-9]\d{5,9}$/.test(text) ? text : undefined;
};
const failure = (ghinNumber: string, error: PublicError): LookupResult => ({
  ok: false,
  ghinNumber,
  error,
});
const unavailable = (): PublicError =>
  safeError(new AppError("UNAVAILABLE", "Incomplete provider response."));
const noIndex = (withdrawn = false): PublicError => ({
  code: "NO_HANDICAP",
  message: withdrawn
    ? "The provider reports a withdrawn Handicap Index."
    : "The golfer has no established Handicap Index.",
});
const nullMarker = (value: unknown): boolean =>
  value === null ||
  value === 999 ||
  (typeof value === "string" &&
    ["", "NH", "WD", "-", "999"].includes(value.trim().toUpperCase()));
const isWithdrawn = (value: unknown): boolean =>
  typeof value === "string" && value.trim().toUpperCase() === "WD";
const numericIndex = (value: unknown): number | undefined => {
  if (typeof value === "number")
    return Number.isFinite(value) &&
      Math.abs(value * 10 - Math.round(value * 10)) < 1e-8
      ? value
      : undefined;
  if (
    typeof value !== "string" ||
    !/^[+-]?\d{1,3}(?:\.\d)?M?$/i.test(value.trim())
  )
    return undefined;
  return Number(value.trim().replace(/M$/i, ""));
};
export const dateOnly = (value: unknown): string | null | undefined => {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date)
    return Number.isFinite(value.getTime())
      ? value.toISOString().slice(0, 10)
      : undefined;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(value)
  )
    return undefined;
  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value.slice(0, 10)
  )
    return undefined;
  return value.slice(0, 10);
};
const allowedName = (row: Record<string, unknown>): string | undefined => {
  const first = row.first_name,
    last = row.last_name;
  if (first !== undefined && first !== null && typeof first !== "string")
    return undefined;
  if (typeof last !== "string") return undefined;
  const name = [first, last]
    .filter((v) => typeof v === "string" && v.trim())
    .map((v) => (v as string).trim())
    .join(" ");
  return name.length > 0 &&
    name.length <= 120 &&
    !/[\u0000-\u001f\u007f]/.test(name)
    ? name
    : undefined;
};

/** Display supplies the sign: SpicyGolf's numeric coercion loses a leading +.
 * Missing display evidence is therefore ambiguous, not permission to assume a sign.
 */
export function normalizeSpicyGolfRow(
  ghinNumber: string,
  row: Record<string, unknown>,
  options: SpicyGolfMappingOptions,
): LookupResult {
  const display = row.hi_display;
  if (
    row.hi_withdrawn === true ||
    isWithdrawn(display) ||
    isWithdrawn(row.hi_value) ||
    isWithdrawn(row.handicap_index)
  )
    return failure(ghinNumber, noIndex(true));
  if (
    (display !== undefined && display !== null && nullMarker(display)) ||
    (row.hi_value !== undefined && nullMarker(row.hi_value)) ||
    (row.handicap_index !== undefined && nullMarker(row.handicap_index))
  )
    return failure(ghinNumber, noIndex());
  if (typeof display !== "string") return failure(ghinNumber, unavailable());
  const match = /^(\+)?(\d{1,2}(?:\.\d)?)(M)?$/i.exec(display.trim());
  if (!match) return failure(ghinNumber, unavailable());
  const magnitude = Number(match[2]);
  const handicapIndex = magnitude === 0 ? 0 : match[1] ? -magnitude : magnitude;
  if (handicapIndex < -10 || handicapIndex > 54)
    return failure(ghinNumber, unavailable());
  for (const value of [row.hi_value, row.handicap_index]) {
    if (value === undefined) continue;
    const parsed = numericIndex(value);
    if (
      parsed === undefined ||
      Math.abs(Math.abs(parsed) - magnitude) > 1e-8 ||
      (parsed < 0 && !match[1]) ||
      (typeof value === "string" && value.trim().startsWith("+") && !match[1])
    )
      return failure(ghinNumber, unavailable());
  }
  const effectiveDate = dateOnly(row.rev_date);
  if (effectiveDate === undefined) return failure(ghinNumber, unavailable());
  const name = options.allowNames ? allowedName(row) : undefined;
  return {
    ok: true,
    data: {
      ghinNumber,
      ...(name ? { name } : {}),
      handicapIndex,
      display: formatIndex(handicapIndex) + (match[3] ? "M" : ""),
      effectiveDate,
      retrievedAt: options.retrievedAt,
      source: options.source,
      freshness: "fresh",
      synthetic: options.synthetic,
    },
  };
}

/** Never pass library messages, raw responses, causes, URLs or secrets through. */
export function mapSpicyGolfError(error: unknown): PublicError {
  try {
    const value = record(error),
      status = value?.statusCode,
      code = value?.code;
    if (status === 403)
      return safeError(new AppError("FORBIDDEN", "Provider access denied."));
    if (status === 401 || code === "AUTHENTICATION_ERROR")
      return safeError(
        new AppError("AUTH_REQUIRED", "Authentication expired."),
      );
    if (code === "LOCAL_LIMIT_ERROR")
      return safeError(
        new AppError(
          "RATE_LIMITED",
          "Local safety limit reached (60 GHIN requests per session, 200 per day).",
          3_600_000,
        ),
      );
    if (status === 429 || code === "RATE_LIMIT_ERROR") {
      const seconds = value?.retryAfter;
      const parsed =
        typeof seconds === "number"
          ? seconds
          : typeof seconds === "string" && /^\d+(?:\.\d+)?$/.test(seconds)
            ? Number(seconds)
            : NaN;
      const retryAfterMs =
        Number.isFinite(parsed) &&
        parsed >= 0 &&
        parsed <= Number.MAX_SAFE_INTEGER / 1000
          ? Math.ceil(parsed * 1000)
          : undefined;
      return safeError(
        new AppError(
          "RATE_LIMITED",
          "Provider request limit reached.",
          retryAfterMs,
        ),
      );
    }
  } catch {
    /* Untrusted error getters are not safe diagnostics. */
  }
  return unavailable();
}

export function mapSpicyGolfBatch(
  envelope: unknown,
  batch: string[],
  options: SpicyGolfMappingOptions,
): LookupResult[] {
  const payload = record(envelope);
  if (
    !payload ||
    !Array.isArray(payload.golfers) ||
    !Array.isArray(payload.missing) ||
    payload.golfers.length > 2500 ||
    payload.missing.length > 500 ||
    payload.missing.some((v) => !canonicalSpicyGolfId(v))
  )
    return batch.map((number) => failure(number, unavailable()));
  const missing = new Set(payload.missing.map(canonicalSpicyGolfId));
  const rows = new Map<string, Record<string, unknown>[]>();
  for (const candidate of payload.golfers) {
    const row = record(candidate),
      id = canonicalSpicyGolfId(row?.ghin);
    if (!row || !id || !batch.includes(id)) continue;
    rows.set(id, [...(rows.get(id) ?? []), row]);
  }
  return batch.map((number) => {
    const matches = rows.get(number) ?? [];
    // Missing covers filtered, unchanged, invalid and unknown rows. None proves
    // NOT_FOUND or unchanged. Duplicate identity rows are also ambiguous.
    if (matches.length !== 1 || missing.has(number))
      return failure(number, unavailable());
    return normalizeSpicyGolfRow(number, matches[0]!, options);
  });
}
