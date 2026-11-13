import { DesktopError } from "./errors.js";
import { readTerminalLine } from "./private-terminal.js";

/** Dedicated controlling terminal; never reads MCP stdin or logs typed text. */
export async function readHiddenPassphrase(prompt: string): Promise<Buffer> {
  return readTerminalLine({
    prompt,
    rejectByte: (byte) =>
      byte < 32 || byte > 126 ? new DesktopError("INVALID_SECRET") : undefined,
  });
}

/** Visible, non-secret confirmation typed in the private terminal. */
export async function readVisibleConfirmation(
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const bytes = await readTerminalLine({
    prompt,
    echo: true,
    ...(signal ? { signal } : {}),
    rejectByte: (byte) =>
      byte < 32 || byte > 126 ? new DesktopError("INVALID_SECRET") : undefined,
  });
  try {
    return bytes.toString("ascii");
  } finally {
    bytes.fill(0);
  }
}
