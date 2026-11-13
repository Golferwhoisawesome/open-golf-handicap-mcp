import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
} from "node:crypto";
import { inspect } from "node:util";
import { join } from "node:path";
import { z } from "zod";
import { DesktopError } from "./errors.js";
import {
  readPrivateFile,
  writePrivateAtomic,
  withVaultLock,
} from "./private-files.js";
import {
  SecretHandle,
  validateSecret,
  type SecretOptions,
  type SecretStore,
  type SecretStoreStatus,
} from "./secret-store.js";
const MAGIC = Buffer.from("OGHVAU01"),
  MAX_BYTES = 1024 * 1024,
  HEADER = 52;
const recordSchema = z
  .object({
    value: z
      .string()
      .max(10924)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    expiresAt: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
  })
  .strict();
const payloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    records: z
      .record(z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/), recordSchema)
      .refine((v) => Object.keys(v).length <= 32),
  })
  .strict();
type Payload = z.infer<typeof payloadSchema>;
const invalid = () => new DesktopError("VAULT_INVALID");
function validatePassphrase(passphrase: Buffer) {
  if (
    passphrase.length < 12 ||
    passphrase.length > 1024 ||
    passphrase.some((byte) => byte < 32 || byte > 126)
  )
    throw new DesktopError("INVALID_SECRET");
}
async function derive(passphrase: Buffer, salt: Buffer): Promise<Buffer> {
  validatePassphrase(passphrase);
  return new Promise((resolve, reject) =>
    scrypt(
      passphrase,
      salt,
      32,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(invalid()) : resolve(key)),
    ),
  );
}
function readHeader(envelope: Buffer) {
  if (
    envelope.length <= HEADER ||
    envelope.length > MAX_BYTES ||
    !envelope.subarray(0, 8).equals(MAGIC)
  )
    throw invalid();
  return {
    salt: envelope.subarray(8, 24),
    iv: envelope.subarray(24, 36),
    tag: envelope.subarray(36, 52),
    ciphertext: envelope.subarray(52),
  };
}
export class EncryptedFileSecretStore implements SecretStore {
  readonly kind = "encrypted-file";
  #key: Buffer | undefined;
  #salt: Buffer;
  #queue: Promise<void> = Promise.resolve();
  #handles = new Map<string, Set<SecretHandle>>();
  private constructor(
    private readonly directory: string,
    private readonly profileId: string,
    key: Buffer,
    salt: Buffer,
    private readonly now: () => number = Date.now,
  ) {
    this.#key = key;
    this.#salt = Buffer.from(salt);
  }
  private static checkId(profileId: string) {
    if (!/^[a-f0-9-]{36}$/.test(profileId)) throw invalid();
  }
  static async create(
    directory: string,
    profileId: string,
    passphrase: Buffer,
    now: () => number = Date.now,
  ): Promise<EncryptedFileSecretStore> {
    this.checkId(profileId);
    const salt = randomBytes(16),
      key = await derive(passphrase, salt),
      store = new EncryptedFileSecretStore(
        directory,
        profileId,
        key,
        salt,
        now,
      );
    try {
      await withVaultLock(directory, () =>
        store.write({ schemaVersion: 1, revision: 0, records: {} }, true),
      );
      return store;
    } catch (error) {
      await store.lock();
      throw error;
    }
  }
  static async unlock(
    directory: string,
    profileId: string,
    passphrase: Buffer,
    now: () => number = Date.now,
  ): Promise<EncryptedFileSecretStore> {
    this.checkId(profileId);
    let key: Buffer | undefined;
    try {
      const envelope = await readPrivateFile(
          join(directory, "vault.bin"),
          MAX_BYTES,
        ),
        header = readHeader(envelope);
      key = await derive(passphrase, header.salt);
      const store = new EncryptedFileSecretStore(
        directory,
        profileId,
        key,
        header.salt,
        now,
      );
      store.decode(envelope);
      return store;
    } catch {
      key?.fill(0);
      throw invalid();
    }
  }
  private assertUnlocked(): Buffer {
    if (!this.#key) throw new DesktopError("VAULT_LOCKED");
    return this.#key;
  }
  private async serial<T>(work: () => Promise<T>): Promise<T> {
    const preceding = this.#queue;
    let release!: () => void;
    this.#queue = new Promise((resolve) => {
      release = resolve;
    });
    await preceding;
    try {
      return await work();
    } finally {
      release();
    }
  }
  private aad() {
    return Buffer.from(`open-golf-handicap-mcp:vault:v1:${this.profileId}`);
  }
  private decode(envelope: Buffer): Payload {
    let plaintext: Buffer | undefined;
    try {
      const header = readHeader(envelope);
      if (!header.salt.equals(this.#salt)) throw invalid();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.assertUnlocked(),
        header.iv,
      );
      decipher.setAAD(this.aad());
      decipher.setAuthTag(header.tag);
      plaintext = Buffer.concat([
        decipher.update(header.ciphertext),
        decipher.final(),
      ]);
      const payload = payloadSchema.parse(
        JSON.parse(plaintext.toString("utf8")),
      );
      for (const [name, record] of Object.entries(payload.records)) {
        const bytes = Buffer.from(record.value, "base64");
        try {
          validateSecret(name, bytes, record.expiresAt ?? undefined);
          if (bytes.toString("base64") !== record.value) throw invalid();
        } finally {
          bytes.fill(0);
        }
      }
      return payload;
    } catch {
      throw invalid();
    } finally {
      plaintext?.fill(0);
    }
  }
  private async load() {
    return this.decode(
      await readPrivateFile(join(this.directory, "vault.bin"), MAX_BYTES),
    );
  }
  private async write(payload: Payload, exclusive = false) {
    let plaintext: Buffer | undefined;
    try {
      plaintext = Buffer.from(JSON.stringify(payloadSchema.parse(payload)));
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", this.assertUnlocked(), iv);
      cipher.setAAD(this.aad());
      const ciphertext = Buffer.concat([
          cipher.update(plaintext),
          cipher.final(),
        ]),
        envelope = Buffer.concat([
          MAGIC,
          this.#salt,
          iv,
          cipher.getAuthTag(),
          ciphertext,
        ]);
      if (envelope.length > MAX_BYTES) throw invalid();
      await writePrivateAtomic(
        join(this.directory, "vault.bin"),
        envelope,
        exclusive,
      );
    } finally {
      plaintext?.fill(0);
    }
  }
  private invalidate(name: string) {
    for (const h of this.#handles.get(name) ?? []) h.dispose();
    this.#handles.delete(name);
  }
  async get(name: string): Promise<SecretHandle | undefined> {
    validateSecret(name);
    return this.serial(async () => {
      this.assertUnlocked();
      return withVaultLock(this.directory, async () => {
        const record = (await this.load()).records[name];
        if (
          !record ||
          (record.expiresAt !== null && this.now() >= record.expiresAt)
        )
          return undefined;
        const bytes = Buffer.from(record.value, "base64"),
          handles = this.#handles.get(name) ?? new Set<SecretHandle>();
        let handle: SecretHandle;
        try {
          handle = new SecretHandle(bytes, record.expiresAt, this.now, () => {
            handles.delete(handle);
            if (handles.size === 0 && this.#handles.get(name) === handles)
              this.#handles.delete(name);
          });
        } finally {
          bytes.fill(0);
        }
        handles.add(handle);
        this.#handles.set(name, handles);
        return handle;
      });
    });
  }
  async set(
    name: string,
    value: Buffer,
    options: SecretOptions = {},
  ): Promise<void> {
    validateSecret(name, value, options.expiresAt);
    const copy = Buffer.from(value);
    try {
      await this.serial(async () => {
        this.assertUnlocked();
        await withVaultLock(this.directory, async () => {
          const payload = await this.load();
          if (
            !payload.records[name] &&
            Object.keys(payload.records).length >= 32
          )
            throw new DesktopError("INVALID_SECRET");
          payload.records[name] = {
            value: copy.toString("base64"),
            expiresAt: options.expiresAt ?? null,
          };
          payload.revision++;
          await this.write(payload);
          this.invalidate(name);
        });
      });
    } finally {
      copy.fill(0);
    }
  }
  async revoke(name: string): Promise<void> {
    validateSecret(name);
    await this.serial(async () => {
      this.assertUnlocked();
      await withVaultLock(this.directory, async () => {
        const payload = await this.load();
        delete payload.records[name];
        payload.revision++;
        await this.write(payload);
        this.invalidate(name);
      });
    });
  }
  async update(
    name: string,
    change: (current: Buffer | undefined) => Buffer | undefined,
  ): Promise<void> {
    validateSecret(name);
    await this.serial(async () => {
      this.assertUnlocked();
      await withVaultLock(this.directory, async () => {
        const payload = await this.load(),
          existing = payload.records[name];
        const current =
          existing &&
          (existing.expiresAt === null || this.now() < existing.expiresAt)
            ? Buffer.from(existing.value, "base64")
            : undefined;
        let next: Buffer | undefined;
        try {
          next = change(current);
          if (next !== undefined) {
            if (!Buffer.isBuffer(next))
              throw new DesktopError("INVALID_SECRET");
            validateSecret(name, next);
            if (!existing && Object.keys(payload.records).length >= 32)
              throw new DesktopError("INVALID_SECRET");
            payload.records[name] = {
              value: next.toString("base64"),
              expiresAt: null,
            };
          } else delete payload.records[name];
          payload.revision++;
          await this.write(payload);
          this.invalidate(name);
        } finally {
          current?.fill(0);
          if (Buffer.isBuffer(next)) next.fill(0);
        }
      });
    });
  }
  async status(): Promise<SecretStoreStatus> {
    return this.serial(async () => {
      if (!this.#key)
        return {
          kind: this.kind,
          locked: true,
          activeCount: 0,
          expiredCount: 0,
        };
      return withVaultLock(this.directory, async () => {
        const payload = await this.load();
        let activeCount = 0,
          expiredCount = 0;
        for (const record of Object.values(payload.records))
          if (record.expiresAt !== null && this.now() >= record.expiresAt)
            expiredCount++;
          else activeCount++;
        return { kind: this.kind, locked: false, activeCount, expiredCount };
      });
    });
  }
  async lock(): Promise<void> {
    await this.serial(async () => {
      this.#key?.fill(0);
      this.#key = undefined;
      for (const name of this.#handles.keys()) this.invalidate(name);
    });
  }
  toJSON() {
    return { kind: this.kind, secret: "[REDACTED]" };
  }
  [inspect.custom]() {
    return "EncryptedFileSecretStore [REDACTED]";
  }
}
