import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";

/** A short temporary root: Unix socket paths are limited to about 100 bytes,
 * and macOS's default temp directory is long. Windows uses named pipes. */
export function shortTempRoot(): Promise<string> {
  return realpath(process.platform === "win32" ? tmpdir() : "/tmp");
}

import { mkdir, stat } from "node:fs/promises";
import { restrictDirectoryAcl } from "../../src/desktop/platform-security.js";

export const posix = process.platform !== "win32";
/** Skip reason for tests of POSIX permission bits or unprivileged symlinks. */
export const posixOnly = posix ? false : "POSIX permissions and symlinks";

/** An owner-only directory: mode 0700 on POSIX, a protected ACL on Windows. */
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  await restrictDirectoryAcl(path);
}

/** Permission bits are meaningless on Windows; ACLs are verified instead. */
export async function modeOf(path: string, expected: number): Promise<number> {
  return posix ? (await stat(path)).mode & 0o777 : expected;
}
