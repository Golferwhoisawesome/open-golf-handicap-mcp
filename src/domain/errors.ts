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
  RATE_LIMITED:
    "A request limit was reached (this app's daily GHIN limit, or GHIN asked it to slow down). Try again later.",
  AUTH_REQUIRED:
    "GHIN sign-in is needed. In a terminal, run: open-golf-handicap-setup login — then try again.",
  FORBIDDEN:
    "This action is not permitted. If GHIN refused access, run open-golf-handicap-setup login in a terminal to sign in again.",
  LIVE_ACCESS_DISABLED: "Live GHIN access is disabled in this build.",
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
