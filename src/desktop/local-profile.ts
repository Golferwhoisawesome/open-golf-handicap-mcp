import { randomBytes } from "node:crypto";
import { lstat, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { inspect } from "node:util";
import { z } from "zod";
import { AppError } from "../domain/errors.js";
import type { CredentialStore } from "./credential-store.js";
import {
  assertPrivateDirectory,
  createPrivateDirectory,
  errorCode,
  readPrivateFile,
  withVaultLock,
  writePrivateAtomic,
} from "./private-files.js";
import {
  SecretHandle,
  validateSecret,
  type SecretOptions,
  type SecretStore,
  type SecretStoreStatus,
} from "./secret-store.js";

export type GhinMode = "ghin" | "offline-test";
export interface GhinLogin {
  username: Buffer;
  password: Buffer;
  ownGhinNumber: string;
  accountType: "golfer" | "api";
  mode: GhinMode;
}
export interface ProfileSecrets {
  rosterKey: Buffer;
  login?: GhinLogin;
}

export function defaultProfileDirectory(): string {
  return join(homedir(), ".open-golf-handicap");
}

/** Creates the owner-only profile directory when missing and returns its
 * canonical path. An existing directory must already be private. */
export async function ensureProfileDirectory(
  directory: string,
): Promise<string> {
  const absolute = resolve(directory);
  try {
    await lstat(absolute);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    await createPrivateDirectory(absolute);
  }
  await assertPrivateDirectory(absolute);
  return realpath(absolute);
}

/** The canonical profile path when it exists and is private, else undefined. */
export async function existingProfileDirectory(
  directory: string,
): Promise<string | undefined> {
  const absolute = resolve(directory);
  try {
    await lstat(absolute);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  await assertPrivateDirectory(absolute);
  return realpath(absolute);
}

const b64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);
const secretsSchema = z
  .object({
    version: z.literal(1),
    rosterKey: z.string().regex(/^[0-9a-f]{64}$/),
    login: z
      .object({
        username: b64.max(428),
        password: b64.max(1368),
        ownGhinNumber: z.string().regex(/^[1-9]\d{5,9}$/),
        accountType: z.enum(["golfer", "api"]),
        mode: z.enum(["ghin", "offline-test"]),
      })
      .strict()
      .optional(),
  })
  .strict();

function redact<T extends object>(value: T): T {
  Object.defineProperty(value, "toJSON", {
    value: () => ({ credentials: "[REDACTED]" }),
  });
  Object.defineProperty(value, inspect.custom, {
    value: () => "GHIN login [REDACTED]",
  });
  return value;
}

/** The store holds base64 of a small JSON document. */
export async function loadSecrets(
  store: CredentialStore,
): Promise<ProfileSecrets | undefined> {
  const raw = await store.read();
  if (!raw) return undefined;
  let json: Buffer | undefined;
  try {
    json = Buffer.from(raw.toString("utf8"), "base64");
    const parsed = secretsSchema.parse(JSON.parse(json.toString("utf8")));
    return {
      rosterKey: Buffer.from(parsed.rosterKey, "hex"),
      ...(parsed.login
        ? {
            login: redact({
              username: Buffer.from(parsed.login.username, "base64"),
              password: Buffer.from(parsed.login.password, "base64"),
              ownGhinNumber: parsed.login.ownGhinNumber,
              accountType: parsed.login.accountType,
              mode: parsed.login.mode,
            }),
          }
        : {}),
    };
  } catch {
    throw new AppError(
      "STORAGE_ERROR",
      "The saved login is unreadable. Run open-golf-handicap-setup login again.",
    );
  } finally {
    raw.fill(0);
    json?.fill(0);
  }
}

export async function saveSecrets(
  store: CredentialStore,
  secrets: ProfileSecrets,
): Promise<void> {
  if (secrets.rosterKey.length !== 32)
    throw new AppError("INVALID_INPUT", "Invalid roster key.");
  const document = Buffer.from(
    JSON.stringify({
      version: 1,
      rosterKey: secrets.rosterKey.toString("hex"),
      ...(secrets.login
        ? {
            login: {
              username: secrets.login.username.toString("base64"),
              password: secrets.login.password.toString("base64"),
              ownGhinNumber: secrets.login.ownGhinNumber,
              accountType: secrets.login.accountType,
              mode: secrets.login.mode,
            },
          }
        : {}),
    }),
  );
  const encoded = Buffer.from(document.toString("base64"));
  try {
    await store.write(encoded);
  } finally {
    document.fill(0);
    encoded.fill(0);
  }
}

export function newRosterKey(): Buffer {
  return randomBytes(32);
}

export function wipeSecrets(secrets: ProfileSecrets | undefined): void {
  secrets?.rosterKey.fill(0);
  secrets?.login?.username.fill(0);
  secrets?.login?.password.fill(0);
}

/** Nonsecret profile state (usage counters, consent) as owner-only JSON files
 * in the profile directory, shared safely by concurrent MCP processes. */
export class ProfileStateStore implements SecretStore {
  readonly kind = "profile-state-file";
  constructor(private readonly directory: string) {}
  #path(name: string) {
    validateSecret(name);
    return join(this.directory, `${name}.json`);
  }
  async get(name: string) {
    const path = this.#path(name);
    try {
      return new SecretHandle(await readPrivateFile(path, 64 * 1024));
    } catch (error) {
      try {
        await lstat(path);
      } catch (missing) {
        if (errorCode(missing) === "ENOENT") return undefined;
      }
      throw error;
    }
  }
  async set(name: string, value: Buffer, _options?: SecretOptions) {
    await this.update(name, () => Buffer.from(value));
  }
  async revoke(name: string) {
    await this.update(name, () => undefined);
  }
  async update(
    name: string,
    change: (current: Buffer | undefined) => Buffer | undefined,
  ) {
    const path = this.#path(name);
    await withVaultLock(this.directory, async () => {
      const handle = await this.get(name);
      let current: Buffer | undefined;
      let next: Buffer | undefined;
      try {
        current = handle?.copy();
        next = change(current);
        if (next === undefined) {
          if (current !== undefined) await unlink(path);
          return;
        }
        validateSecret(name, next);
        await writePrivateAtomic(path, next, current === undefined);
      } finally {
        handle?.dispose();
        current?.fill(0);
        next?.fill(0);
      }
    });
  }
  async status(): Promise<SecretStoreStatus> {
    return { kind: this.kind, locked: false, activeCount: 0, expiredCount: 0 };
  }
  async lock() {}
}
