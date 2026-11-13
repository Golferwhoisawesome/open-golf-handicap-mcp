export type DesktopErrorCode =
  | "PROFILE_MISSING"
  | "PROFILE_EXISTS"
  | "PROFILE_INVALID"
  | "VAULT_INVALID"
  | "VAULT_LOCKED"
  | "VAULT_BUSY"
  | "PRIVATE_INPUT_REQUIRED"
  | "INPUT_CANCELLED"
  | "INVALID_SECRET"
  | "PASSPHRASE_MISMATCH";
const messages: Record<DesktopErrorCode, string> = {
  PROFILE_MISSING:
    "The private desktop profile does not exist. Run setup init first.",
  PROFILE_EXISTS:
    "The profile directory already exists. Existing data was not replaced.",
  PROFILE_INVALID:
    "The private profile is incomplete, unsafe, or invalid. Existing data was not changed.",
  VAULT_INVALID:
    "The vault could not be unlocked or validated. Check the passphrase and preserve the original files.",
  VAULT_LOCKED: "The private vault is locked.",
  VAULT_BUSY:
    "The private vault is busy. Retry later; abandoned locks require manual inspection.",
  PRIVATE_INPUT_REQUIRED:
    "A private local terminal is required. Never enter the vault passphrase in an AI conversation.",
  INPUT_CANCELLED: "Private input was cancelled.",
  INVALID_SECRET:
    "The private input is invalid. Vault passphrases must contain 12 to 1024 printable ASCII characters.",
  PASSPHRASE_MISMATCH:
    "The two passphrases did not match. Nothing was created; try again.",
};
export class DesktopError extends Error {
  constructor(public readonly code: DesktopErrorCode) {
    super(messages[code]);
    this.name = "DesktopError";
  }
}
/** Ignores raw exception text, paths, payloads and credentials. */
export function publicDesktopError(error: unknown): {
  code: DesktopErrorCode;
  message: string;
} {
  const code = error instanceof DesktopError ? error.code : "VAULT_INVALID";
  return { code, message: messages[code] };
}
