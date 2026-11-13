import { AppError } from "../domain/errors.js";
import { readTerminalLine } from "./private-terminal.js";

const invalid = () =>
  new AppError(
    "INVALID_INPUT",
    "Private input must contain valid UTF-8 without control characters.",
  );

/** Private controlling terminal only; no stdin, argument, environment or chat
 * input. UTF-8 bytes are preserved exactly; passwords are never normalized. */
export async function readPrivateCredential(
  prompt: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  return readTerminalLine({
    prompt,
    utf8Backspace: true,
    overflowError: invalid,
    ...(signal ? { signal } : {}),
    rejectByte: (byte) => (byte < 32 ? invalid() : undefined),
    validate: (bytes) => {
      try {
        const decoded = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
        if (bytes.length === 0 || /[\u0000-\u001f\u007f-\u009f]/.test(decoded))
          return invalid();
        return undefined;
      } catch {
        return invalid();
      }
    },
  });
}
