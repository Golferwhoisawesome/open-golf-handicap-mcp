import { randomBytes, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { DesktopError } from "./errors.js";
import {
  assertPrivateDirectory,
  createPrivateDirectory,
  errorCode,
  readPrivateFile,
  writePrivateAtomic,
} from "./private-files.js";
import { EncryptedFileSecretStore } from "./encrypted-file-secret-store.js";
import type { SecretStore } from "./secret-store.js";
const profileSchema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: z.uuid(),
    provider: z.literal("mock"),
    storage: z.literal("local-encrypted"),
    rosterDirectory: z.literal("roster"),
    vaultFile: z.literal("vault.bin"),
    createdAt: z.iso.datetime(),
  })
  .strict();
export interface ProfileStatus {
  initialized: boolean;
  profileId?: string;
  provider: "mock";
  storage: "local-encrypted";
  vault: "locked" | "missing";
  osCredentialStore: "not-implemented";
}
export interface UnlockedProfile {
  readonly profileId: string;
  readonly rosterDirectory: string;
  copyRosterKey(): Buffer;
  withSecrets<T>(callback: (store: SecretStore) => Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}
async function readProfile(directory: string) {
  try {
    return profileSchema.parse(
      JSON.parse(
        (await readPrivateFile(join(directory, "profile.json"), 8192)).toString(
          "utf8",
        ),
      ),
    );
  } catch {
    throw new DesktopError("PROFILE_INVALID");
  }
}
export async function inspectProfile(
  directory: string,
): Promise<ProfileStatus> {
  const absolute = resolve(directory),
    missing: ProfileStatus = {
      initialized: false,
      provider: "mock",
      storage: "local-encrypted",
      vault: "missing",
      osCredentialStore: "not-implemented",
    };
  try {
    await lstat(absolute);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return missing;
    throw new DesktopError("PROFILE_INVALID");
  }
  await assertPrivateDirectory(absolute);
  if ((await readdir(absolute)).length === 0) return missing;
  const profile = await readProfile(absolute);
  const envelope = await readPrivateFile(
    join(absolute, "vault.bin"),
    1024 * 1024,
  ).catch(() => {
    throw new DesktopError("PROFILE_INVALID");
  });
  if (
    envelope.length <= 52 ||
    !envelope.subarray(0, 8).equals(Buffer.from("OGHVAU01"))
  )
    throw new DesktopError("PROFILE_INVALID");
  return {
    ...missing,
    initialized: true,
    profileId: profile.profileId,
    vault: "locked",
  };
}
export async function initProfile(
  directory: string,
  passphrase: Buffer,
): Promise<ProfileStatus> {
  if (
    passphrase.length < 12 ||
    passphrase.length > 1024 ||
    passphrase.some((byte) => byte < 32 || byte > 126)
  )
    throw new DesktopError("INVALID_SECRET");
  const absolute = resolve(directory);
  await createPrivateDirectory(absolute);
  const profile = profileSchema.parse({
      schemaVersion: 1,
      profileId: randomUUID(),
      provider: "mock",
      storage: "local-encrypted",
      rosterDirectory: "roster",
      vaultFile: "vault.bin",
      createdAt: new Date().toISOString(),
    }),
    key = randomBytes(32);
  let store: EncryptedFileSecretStore | undefined;
  try {
    store = await EncryptedFileSecretStore.create(
      absolute,
      profile.profileId,
      passphrase,
    );
    await store.set("roster-key", key);
    await createPrivateDirectory(join(absolute, "roster"));
    await writePrivateAtomic(
      join(absolute, "profile.json"),
      Buffer.from(JSON.stringify(profile, null, 2) + "\n"),
      true,
    );
  } finally {
    key.fill(0);
    await store?.lock();
  }
  return inspectProfile(absolute);
}
class OpenProfile implements UnlockedProfile {
  #key: Buffer | undefined;
  constructor(
    readonly profileId: string,
    readonly rosterDirectory: string,
    key: Buffer,
    private readonly store: EncryptedFileSecretStore,
  ) {
    this.#key = key;
  }
  copyRosterKey() {
    if (!this.#key) throw new DesktopError("VAULT_LOCKED");
    return Buffer.from(this.#key);
  }
  async withSecrets<T>(
    callback: (store: SecretStore) => Promise<T>,
  ): Promise<T> {
    if (!this.#key) throw new DesktopError("VAULT_LOCKED");
    return callback(this.store);
  }
  async dispose() {
    this.#key?.fill(0);
    this.#key = undefined;
    await this.store.lock();
  }
  toJSON() {
    return {
      profileId: this.profileId,
      rosterDirectory: this.rosterDirectory,
      secret: "[REDACTED]",
    };
  }
  [inspect.custom]() {
    return "UnlockedProfile [REDACTED]";
  }
}
export async function unlockProfile(
  directory: string,
  passphrase: Buffer,
): Promise<UnlockedProfile> {
  const absolute = resolve(directory),
    status = await inspectProfile(absolute);
  if (!status.initialized) throw new DesktopError("PROFILE_MISSING");
  const profile = await readProfile(absolute);
  await assertPrivateDirectory(join(absolute, "roster"));
  const store = await EncryptedFileSecretStore.unlock(
    absolute,
    profile.profileId,
    passphrase,
  );
  try {
    const handle = await store.get("roster-key");
    if (!handle) throw new DesktopError("VAULT_INVALID");
    let key: Buffer;
    try {
      key = handle.copy();
    } finally {
      handle.dispose();
    }
    if (key.length !== 32) {
      key.fill(0);
      throw new DesktopError("VAULT_INVALID");
    }
    return new OpenProfile(
      profile.profileId,
      join(absolute, "roster"),
      key,
      store,
    );
  } catch (error) {
    await store.lock();
    throw error;
  }
}
