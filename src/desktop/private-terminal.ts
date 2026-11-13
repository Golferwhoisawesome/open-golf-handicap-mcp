import { openSync, closeSync, writeSync, constants } from "node:fs";
import { ReadStream } from "node:tty";
import { DesktopError } from "./errors.js";

/** Signals that end a private prompt. SIGBREAK is Ctrl-Break on Windows. */
export const TERMINATION_SIGNALS: NodeJS.Signals[] =
  process.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];

export function onTermination(listener: () => void): () => void {
  for (const signal of TERMINATION_SIGNALS) process.once(signal, listener);
  return () => {
    for (const signal of TERMINATION_SIGNALS)
      process.removeListener(signal, listener);
  };
}

interface TerminalDevice {
  input: ReadStream;
  write(text: string): void;
  close(): void;
}

/** The controlling terminal (POSIX) or attached console (Windows). Never the
 * process's stdin, which belongs to the MCP transport or a parent process. */
function openTerminal(): TerminalDevice {
  const windows = process.platform === "win32";
  let readFd: number | undefined, writeFd: number | undefined;
  try {
    if (windows) {
      readFd = openSync("\\\\.\\CONIN$", "r+");
      writeFd = openSync("\\\\.\\CONOUT$", "w");
    } else {
      readFd = openSync(
        "/dev/tty",
        constants.O_RDWR | (constants.O_NOCTTY ?? 0),
      );
      writeFd = readFd;
    }
  } catch {
    for (const fd of new Set([readFd, writeFd]))
      if (fd !== undefined) closeSync(fd);
    throw new DesktopError("PRIVATE_INPUT_REQUIRED");
  }
  let input: ReadStream;
  try {
    input = new ReadStream(readFd);
  } catch {
    for (const fd of new Set([readFd, writeFd])) closeSync(fd);
    throw new DesktopError("PRIVATE_INPUT_REQUIRED");
  }
  if (!input.isTTY) {
    input.destroy();
    if (writeFd !== readFd) closeSync(writeFd);
    throw new DesktopError("PRIVATE_INPUT_REQUIRED");
  }
  const outputFd = writeFd;
  return {
    input,
    write(text: string) {
      writeSync(outputFd, text);
    },
    close() {
      input.destroy();
      if (outputFd !== readFd) {
        try {
          closeSync(outputFd);
        } catch {
          /* Already closed. */
        }
      }
    },
  };
}

export interface TerminalReadOptions {
  prompt: string;
  /** Show typed characters (used only for non-secret confirmations). */
  echo?: boolean;
  /** Reject a byte immediately; return the error to raise. */
  rejectByte?: (byte: number) => Error | undefined;
  /** Validate completed input; return the error to raise. */
  validate?: (bytes: Buffer) => Error | undefined;
  /** Remove a whole UTF-8 code point on backspace. */
  utf8Backspace?: boolean;
  /** Error raised when input exceeds the 1024-byte buffer. */
  overflowError?: () => Error;
  signal?: AbortSignal;
}

/** Reads one line in raw mode. Typed bytes are wiped after copying. */
export async function readTerminalLine(
  options: TerminalReadOptions,
): Promise<Buffer> {
  const { prompt, signal } = options;
  if (signal?.aborted) throw new DesktopError("INPUT_CANCELLED");
  if (prompt.length > 200 || /[\u0000-\u001f\u007f]/.test(prompt))
    throw new DesktopError("PRIVATE_INPUT_REQUIRED");
  const device = openTerminal();
  const terminal = device.input;
  return new Promise((resolve, reject) => {
    const bytes = Buffer.alloc(1024),
      wasRaw = terminal.isRaw;
    let length = 0,
      finished = false;
    const restore = () => {
      try {
        terminal.setRawMode(wasRaw);
      } catch {
        /* Device may already be gone. */
      }
    };
    let removeSignals = () => {};
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      let result: Buffer | undefined;
      if (!error) {
        result = Buffer.from(bytes.subarray(0, length));
        error = options.validate?.(result);
      }
      restore();
      terminal.pause();
      terminal.removeAllListeners("data");
      terminal.removeAllListeners("error");
      terminal.removeAllListeners("end");
      process.removeListener("exit", restore);
      removeSignals();
      signal?.removeEventListener("abort", cancel);
      try {
        device.write("\n");
      } catch {
        /* No secret is printed. */
      }
      bytes.fill(0);
      device.close();
      if (error) {
        result?.fill(0);
        reject(error);
      } else resolve(result!);
    };
    const cancel = () => finish(new DesktopError("INPUT_CANCELLED"));
    terminal.on("error", () =>
      finish(new DesktopError("PRIVATE_INPUT_REQUIRED")),
    );
    terminal.on("end", cancel);
    terminal.on("data", (chunk: Buffer) => {
      try {
        for (const byte of chunk) {
          if (byte === 3 || byte === 4) {
            cancel();
            break;
          }
          // Some terminals send Enter as CR LF; a leading LF is the tail of
          // the previous prompt's Enter, not an empty answer.
          if (byte === 10 && length === 0) continue;
          if (byte === 13 || byte === 10) {
            finish();
            break;
          }
          if (byte === 127 || byte === 8) {
            if (length) {
              let start = length - 1;
              if (options.utf8Backspace)
                while (start > 0 && (bytes[start]! & 0xc0) === 0x80) start--;
              bytes.fill(0, start, length);
              const removed = length - start;
              length = start;
              if (options.echo && removed)
                try {
                  device.write("\b \b");
                } catch {
                  /* Display only. */
                }
            }
            continue;
          }
          const rejected = options.rejectByte?.(byte);
          if (rejected || length === bytes.length) {
            finish(
              rejected ??
                options.overflowError?.() ??
                new DesktopError("INVALID_SECRET"),
            );
            break;
          }
          bytes[length++] = byte;
          if (options.echo)
            try {
              device.write(String.fromCharCode(byte));
            } catch {
              /* Display only. */
            }
        }
      } finally {
        chunk.fill(0);
      }
    });
    process.once("exit", restore);
    removeSignals = onTermination(cancel);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) {
      cancel();
      return;
    }
    try {
      terminal.setRawMode(true);
      device.write(prompt);
      terminal.resume();
    } catch {
      finish(new DesktopError("PRIVATE_INPUT_REQUIRED"));
    }
  });
}
