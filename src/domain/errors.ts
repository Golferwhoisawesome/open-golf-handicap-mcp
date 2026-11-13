export type ErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "DUPLICATE"
  | "CONFLICT"
  | "UNAVAILABLE"
  | "NO_HANDICAP"
  | "RATE_LIMITED"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "LIVE_ACCESS_DISABLED"
  | "UNSUPPORTED"
  | "CONFIRMATION_REQUIRED"
  | "STORAGE_ERROR";
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AppError";
  }
}
const messages: Record<ErrorCode, string> = {
  INVALID_INPUT: "Input is invalid.",
  NOT_FOUND: "Record was not found.",
  DUPLICATE: "This GHIN number is already saved.",
  CONFLICT: "Data changed; retrieve it and retry.",
  UNAVAILABLE: "Provider is temporarily unavailable.",
  NO_HANDICAP: "No verified handicap is available.",
  RATE_LIMITED: "Request limit reached; retry later.",
  AUTH_REQUIRED: "Authentication is required.",
  FORBIDDEN: "This action is not permitted.",
  LIVE_ACCESS_DISABLED:
    "Live GHIN access is disabled pending written authorization.",
  UNSUPPORTED: "This capability is unavailable.",
  CONFIRMATION_REQUIRED: "Review the preview and confirm the exact records.",
  STORAGE_ERROR: "Storage could not complete the operation.",
};
export function safeError(error: unknown) {
  const code = error instanceof AppError ? error.code : "UNAVAILABLE";
  return {
    code,
    message: messages[code],
    ...(error instanceof AppError && error.retryAfterMs !== undefined
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
  };
}
