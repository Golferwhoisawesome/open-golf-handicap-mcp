import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  link,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, resolve, parse } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopError } from "./errors.js";
import {
  hasPrivateAcl,
  hasPrivateMode,
  isWindows,
  renameWithRetry,
  restrictDirectoryAcl,
} from "./platform-security.js";
// Undefined on Windows; there, symlinks are rejected with lstat checks instead.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
async function assertNotLink(path: string): Promise<void> {
  if (isWindows && (await lstat(path)).isSymbolicLink()) throw fail();
}
const fail = () => new DesktopError("PROFILE_INVALID");
export const errorCode = (error: unknown) =>
  (error as NodeJS.ErrnoException | undefined)?.code;
export async function assertAncestors(directory: string): Promise<void> {
  let current = resolve(directory);
  while (true) {
    try {
      const info = await lstat(current);
      // Windows profile folders are often junctions (OneDrive, redirected
      // Documents); creating symlinks there requires elevated rights.
      if (!info.isDirectory() && !(isWindows && info.isSymbolicLink()))
        throw fail();
      if (!isWindows && info.isSymbolicLink()) throw fail();
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw fail();
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
export async function assertPrivateDirectory(directory: string): Promise<void> {
  try {
    await assertAncestors(directory);
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      !hasPrivateMode(info, 0o700) ||
      !(await hasPrivateAcl(directory))
    )
      throw fail();
  } catch {
    throw fail();
  }
}
export async function createPrivateDirectory(directory: string): Promise<void> {
  const absolute = resolve(directory);
  if (absolute === parse(absolute).root) throw fail();
  await assertAncestors(absolute);
  try {
    await mkdir(absolute, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new DesktopError("PROFILE_EXISTS");
    throw fail();
  }
  try {
    await restrictDirectoryAcl(absolute);
  } catch {
    throw fail();
  }
  await assertPrivateDirectory(absolute);
}
export function assertPrivateFile(info: Stats, maxBytes: number): void {
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    !hasPrivateMode(info, 0o600) ||
    info.size > maxBytes
  )
    throw fail();
}
export async function readPrivateFile(
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  await assertPrivateDirectory(dirname(path));
  let handle: FileHandle | undefined;
  try {
    await assertNotLink(path);
    handle = await open(path, constants.O_RDONLY | O_NOFOLLOW);
    assertPrivateFile(await handle.stat(), maxBytes);
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const part = await handle.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    if (length > maxBytes) throw fail();
    return bytes.subarray(0, length);
  } finally {
    await handle?.close();
  }
}
/** Private directories and cooperating processes are required; not a hostile same-UID boundary. */
export async function writePrivateAtomic(
  path: string,
  data: Buffer,
  exclusive = false,
): Promise<void> {
  const directory = dirname(path);
  await assertPrivateDirectory(directory);
  const temporary = join(
    directory,
    `.write-${randomBytes(16).toString("hex")}`,
  );
  let handle: FileHandle | undefined;
  let pending = true;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertPrivateDirectory(directory);
    if (exclusive) {
      await link(temporary, path);
      await unlink(temporary);
      pending = false;
    } else {
      const existing = await lstat(path);
      if (existing.isSymbolicLink()) throw fail();
      assertPrivateFile(existing, 1024 * 1024);
      await renameWithRetry(temporary, path);
      pending = false;
    }
    // Windows cannot open or fsync a directory; NTFS journals the rename.
    if (!isWindows) {
      const parent = await open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW,
      );
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new DesktopError("PROFILE_EXISTS");
    throw fail();
  } finally {
    await handle?.close();
    if (pending) await unlink(temporary).catch(() => undefined);
  }
}
export async function withVaultLock<T>(
  directory: string,
  work: () => Promise<T>,
): Promise<T> {
  await assertPrivateDirectory(directory);
  const path = join(directory, ".vault.lock"),
    deadline = Date.now() + 2000;
  let lock: FileHandle | undefined;
  while (!lock) {
    try {
      lock = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw fail();
      try {
        assertPrivateFile(await lstat(path), 0);
      } catch (inspection) {
        if (errorCode(inspection) === "ENOENT") continue;
        throw fail();
      }
      if (Date.now() >= deadline) throw new DesktopError("VAULT_BUSY");
      await delay(20);
    }
  }
  try {
    assertPrivateFile(await lock.stat(), 0);
    await assertPrivateDirectory(directory);
    return await work();
  } finally {
    try {
      const original = await lock.stat({ bigint: true }),
        current = await lstat(path, { bigint: true });
      if (original.ino === current.ino && original.dev === current.dev)
        await unlink(path);
    } finally {
      await lock.close();
    }
  }
}
