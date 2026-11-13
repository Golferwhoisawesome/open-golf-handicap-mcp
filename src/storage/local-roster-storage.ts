import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { dirname, join, parse, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "../domain/errors.js";
import { emptyRoster, rosterSchema, type Roster } from "../domain/models.js";
import {
  hasPrivateAcl,
  hasPrivateMode,
  isWindows,
  renameWithRetry,
  restrictDirectoryAcl,
} from "../desktop/platform-security.js";
// Undefined on Windows; lstat checks reject links there instead.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
import type { RosterStorageProvider } from "./roster-storage-provider.js";
const MAX_BYTES = 5 * 1024 * 1024,
  LOCK_WAIT_MS = 2000,
  MAGIC = Buffer.from("OGHMCP01"),
  HEADER_BYTES = MAGIC.length + 12 + 16;
const storageError = () =>
  new AppError(
    "STORAGE_ERROR",
    "Encrypted roster storage is unavailable or invalid.",
  );
const codeOf = (error: unknown) =>
  (error as NodeJS.ErrnoException | undefined)?.code;
/** Encrypted POSIX storage; every writer must use the same exclusive lock protocol. */
export class LocalRosterStorage implements RosterStorageProvider {
  readonly kind = "local-encrypted";
  private readonly directory: string;
  private readonly key: Buffer;
  constructor(directory: string, key: Buffer) {
    if (!directory.trim() || key.length !== 32) throw storageError();
    this.directory = resolve(directory);
    if (this.directory === parse(this.directory).root) throw storageError();
    this.key = Buffer.from(key);
  }
  private owner(subject: string): string {
    if (!subject.trim() || Buffer.byteLength(subject) > 2048)
      throw storageError();
    return createHash("sha256")
      .update("open-golf-handicap-mcp:owner:v1\0")
      .update(subject)
      .digest("hex");
  }
  private async checkAncestors(): Promise<void> {
    let cursor = this.directory;
    while (true) {
      try {
        const info = await lstat(cursor);
        // Windows profile folders are often junctions (OneDrive, redirection).
        const junction =
          isWindows && info.isSymbolicLink() && cursor !== this.directory;
        if (
          (!info.isDirectory() && !junction) ||
          (!isWindows && info.isSymbolicLink())
        )
          throw storageError();
      } catch (error) {
        if (codeOf(error) !== "ENOENT") throw storageError();
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  private async prepare(): Promise<void> {
    try {
      await this.checkAncestors();
      const created = await mkdir(this.directory, {
        recursive: true,
        mode: 0o700,
      });
      if (created !== undefined) await restrictDirectoryAcl(this.directory);
      await this.checkAncestors();
      const info = await lstat(this.directory);
      if (
        !info.isDirectory() ||
        !hasPrivateMode(info, 0o700) ||
        !(await hasPrivateAcl(this.directory))
      )
        throw storageError();
    } catch {
      throw storageError();
    }
  }
  private validateFile(info: Stats): void {
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      !hasPrivateMode(info, 0o600) ||
      info.size > MAX_BYTES + HEADER_BYTES
    )
      throw storageError();
  }
  private async exclusive<T>(
    subject: string,
    work: (owner: string) => Promise<T>,
  ): Promise<T> {
    const owner = this.owner(subject);
    await this.prepare();
    const lockPath = join(this.directory, `${owner}.lock`),
      deadline = Date.now() + LOCK_WAIT_MS;
    let lock: FileHandle | undefined;
    while (!lock) {
      try {
        lock = await open(
          lockPath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if (codeOf(error) !== "EEXIST") throw storageError();
        try {
          this.validateFile(await lstat(lockPath));
        } catch (inspectionError) {
          if (codeOf(inspectionError) === "ENOENT") continue;
          throw storageError();
        }
        if (Date.now() >= deadline)
          throw new AppError("CONFLICT", "Storage is busy; retry later.");
        await delay(20);
      }
    }
    try {
      this.validateFile(await lock.stat());
      await this.checkAncestors();
      return await work(owner);
    } finally {
      try {
        const original = await lock.stat({ bigint: true }),
          current = await lstat(lockPath, { bigint: true });
        if (original.ino === current.ino && original.dev === current.dev)
          await unlink(lockPath);
      } finally {
        await lock.close();
      }
    }
  }
  private async readUnlocked(owner: string): Promise<Roster> {
    let handle: FileHandle | undefined;
    try {
      try {
        if (
          isWindows &&
          (
            await lstat(join(this.directory, `${owner}.roster`))
          ).isSymbolicLink()
        )
          throw storageError();
        handle = await open(
          join(this.directory, `${owner}.roster`),
          constants.O_RDONLY | O_NOFOLLOW,
        );
      } catch (error) {
        if (codeOf(error) === "ENOENT") return emptyRoster();
        throw error;
      }
      this.validateFile(await handle.stat());
      const bytes = Buffer.alloc(MAX_BYTES + HEADER_BYTES + 1);
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
      if (length < HEADER_BYTES || length > MAX_BYTES + HEADER_BYTES)
        throw storageError();
      const envelope = bytes.subarray(0, length);
      if (!envelope.subarray(0, MAGIC.length).equals(MAGIC))
        throw storageError();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        envelope.subarray(MAGIC.length, MAGIC.length + 12),
      );
      decipher.setAAD(Buffer.from(`open-golf-handicap-mcp:roster:v1:${owner}`));
      decipher.setAuthTag(envelope.subarray(MAGIC.length + 12, HEADER_BYTES));
      const plaintext = Buffer.concat([
          decipher.update(envelope.subarray(HEADER_BYTES)),
          decipher.final(),
        ]),
        roster = rosterSchema.parse(JSON.parse(plaintext.toString("utf8")));
      if (!Number.isSafeInteger(roster.revision)) throw storageError();
      return roster;
    } catch {
      throw storageError();
    } finally {
      await handle?.close();
    }
  }
  private async writeUnlocked(owner: string, roster: Roster): Promise<void> {
    let temporary: string | undefined, handle: FileHandle | undefined;
    try {
      const parsed = rosterSchema.parse(roster),
        plaintext = Buffer.from(JSON.stringify(parsed));
      if (plaintext.length > MAX_BYTES) throw storageError();
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", this.key, iv);
      cipher.setAAD(Buffer.from(`open-golf-handicap-mcp:roster:v1:${owner}`));
      const ciphertext = Buffer.concat([
          cipher.update(plaintext),
          cipher.final(),
        ]),
        envelope = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
      temporary = join(
        this.directory,
        `${owner}.${randomBytes(16).toString("hex")}.tmp`,
      );
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(envelope);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.checkAncestors();
      const destination = join(this.directory, `${owner}.roster`);
      try {
        this.validateFile(await lstat(destination));
      } catch (error) {
        if (codeOf(error) !== "ENOENT") throw error;
      }
      await renameWithRetry(temporary, destination);
      temporary = undefined;
    } catch {
      throw storageError();
    } finally {
      await handle?.close();
      if (temporary) await unlink(temporary).catch(() => undefined);
    }
  }
  read(subject: string): Promise<Roster> {
    return this.exclusive(subject, (owner) => this.readUnlocked(owner));
  }
  transact<T>(
    subject: string,
    update: (roster: Roster) => T | Promise<T>,
  ): Promise<T> {
    return this.exclusive(subject, async (owner) => {
      const draft = await this.readUnlocked(owner),
        revision = draft.revision,
        result = await update(draft);
      if (!Number.isSafeInteger(revision + 1)) throw storageError();
      draft.revision = revision + 1;
      await this.writeUnlocked(owner, draft);
      return result;
    });
  }
  delete(subject: string): Promise<void> {
    return this.exclusive(subject, async (owner) => {
      const path = join(this.directory, `${owner}.roster`);
      try {
        this.validateFile(await lstat(path));
        await unlink(path);
      } catch (error) {
        if (codeOf(error) !== "ENOENT") throw storageError();
      }
    });
  }
}
