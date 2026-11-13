import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { z } from "zod";
import { AppError } from "../domain/errors.js";
import type { SecretStore } from "./secret-store.js";

export interface CredentialInput {
  username: Buffer;
  password: Buffer;
  ownGhinNumber: string;
  accountType: "golfer" | "api";
}
export type CredentialMode = "offline-test" | "ghin";
export interface PendingConnection {
  readonly id: string;
  readonly mode: CredentialMode;
  copyCredentials(): CredentialInput;
  dispose(): void;
}
const NAME = "ghin-connection";
const PENDING_TTL = 5 * 60_000;
const CONNECTION_TTL = 60 * 60_000;
const encodedCredentials = z
  .object({
    username: z.string().max(428),
    password: z.string().max(1368),
    ownGhinNumber: z.string().regex(/^[1-9]\d{5,9}$/),
    accountType: z.enum(["golfer", "api"]),
  })
  .strict();
const recordSchema = z
  .object({
    version: z.literal(1),
    generation: z.uuid(),
    state: z.enum(["pending", "connected", "disconnected"]),
    mode: z.enum(["offline-test", "ghin"]),
    changedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expiresAt: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    credentials: encodedCredentials.optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      (record.state === "disconnected") !== (record.expiresAt === null) ||
      (record.credentials !== undefined && record.state !== "connected")
    )
      context.addIssue({
        code: "custom",
        message: "Invalid connection state.",
      });
  });
type ConnectionRecord = z.infer<typeof recordSchema>;
const invalidInput = () =>
  new AppError("INVALID_INPUT", "Invalid private GHIN credentials.");
const stale = () =>
  new AppError("AUTH_REQUIRED", "The private connection changed or expired.");
const invalidStorage = () =>
  new AppError("STORAGE_ERROR", "The private connection record is invalid.");

function validateText(bytes: Buffer, maximum: number): void {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > maximum)
    throw invalidInput();
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) throw invalidInput();
  } catch {
    throw invalidInput();
  }
}
function validate(input: CredentialInput): void {
  validateText(input.username, 320);
  validateText(input.password, 1024);
  if (
    !/^[1-9]\d{5,9}$/.test(input.ownGhinNumber) ||
    !["golfer", "api"].includes(input.accountType)
  )
    throw invalidInput();
}
function wipe(input: CredentialInput): void {
  input.username.fill(0);
  input.password.fill(0);
}
function copy(input: CredentialInput): CredentialInput {
  const result = {
    username: Buffer.from(input.username),
    password: Buffer.from(input.password),
    ownGhinNumber: input.ownGhinNumber,
    accountType: input.accountType,
  };
  Object.defineProperty(result, "toJSON", {
    value: () => ({ credentials: "[REDACTED]" }),
  });
  Object.defineProperty(result, inspect.custom, {
    value: () => "GHIN credentials [REDACTED]",
  });
  return result;
}
function decodeCredentials(
  value: z.infer<typeof encodedCredentials>,
): CredentialInput {
  const result: CredentialInput = {
    username: Buffer.from(value.username, "base64"),
    password: Buffer.from(value.password, "base64"),
    ownGhinNumber: value.ownGhinNumber,
    accountType: value.accountType,
  };
  try {
    validate(result);
    if (
      result.username.toString("base64") !== value.username ||
      result.password.toString("base64") !== value.password
    )
      throw invalidStorage();
    return result;
  } catch {
    wipe(result);
    throw invalidStorage();
  }
}
function decode(bytes: Buffer | undefined): ConnectionRecord | undefined {
  if (!bytes) return undefined;
  try {
    const record = recordSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (record.credentials) wipe(decodeCredentials(record.credentials));
    return record;
  } catch {
    throw invalidStorage();
  }
}
function encode(record: ConnectionRecord): Buffer {
  return Buffer.from(JSON.stringify(recordSchema.parse(record)));
}

class Pending implements PendingConnection {
  #credentials: CredentialInput | undefined;
  constructor(
    readonly id: string,
    readonly mode: CredentialMode,
    input: CredentialInput,
    private readonly released: () => void,
  ) {
    this.#credentials = copy(input);
  }
  copyCredentials(): CredentialInput {
    if (!this.#credentials) throw stale();
    return copy(this.#credentials);
  }
  dispose(): void {
    if (!this.#credentials) return;
    wipe(this.#credentials);
    this.#credentials = undefined;
    this.released();
  }
  toJSON() {
    return { id: this.id, mode: this.mode, credentials: "[REDACTED]" };
  }
  [inspect.custom]() {
    return "Pending GHIN connection [REDACTED]";
  }
}

/** Internal credential storage only. It performs no login and cannot grant GHIN
 * access. The caller must authenticate successfully before calling commit().
 * JavaScript/SDK strings cannot be guaranteed erased; buffers are wiped best-effort.
 */
export class GhinCredentialRepository {
  #pending = new Map<string, { connection: Pending; remember: boolean }>();
  #epoch = 0;
  constructor(
    private readonly store: SecretStore,
    private readonly now: () => number = Date.now,
  ) {}
  private time(): number {
    const time = this.now();
    if (
      !Number.isSafeInteger(time) ||
      time < 0 ||
      time > Number.MAX_SAFE_INTEGER - CONNECTION_TTL
    )
      throw invalidInput();
    return time;
  }
  private clearPending(): void {
    for (const entry of this.#pending.values()) entry.connection.dispose();
    this.#pending.clear();
  }
  private pending(
    id: string,
    mode: CredentialMode,
    input: CredentialInput,
    remember: boolean,
  ): Pending {
    const connection = new Pending(id, mode, input, () => {
      if (this.#pending.get(id)?.connection === connection)
        this.#pending.delete(id);
    });
    this.#pending.set(id, { connection, remember });
    return connection;
  }
  private async record(): Promise<ConnectionRecord | undefined> {
    const handle = await this.store.get(NAME);
    if (!handle) return undefined;
    let bytes: Buffer | undefined;
    try {
      bytes = handle.copy();
      return decode(bytes);
    } finally {
      bytes?.fill(0);
      handle.dispose();
    }
  }
  async begin(
    input: CredentialInput,
    options: { remember: boolean; mode?: CredentialMode },
  ): Promise<PendingConnection> {
    validate(input);
    if (typeof options?.remember !== "boolean") throw invalidInput();
    const mode = options.mode ?? "offline-test";
    if (!["offline-test", "ghin"].includes(mode)) throw invalidInput();
    const epoch = ++this.#epoch,
      id = randomUUID();
    this.clearPending();
    const connection = this.pending(id, mode, input, options.remember);
    try {
      await this.store.update(NAME, (bytes) => {
        decode(bytes); // Never overwrite malformed existing data.
        if (epoch !== this.#epoch || !this.#pending.has(id)) throw stale();
        const time = this.time();
        return encode({
          version: 1,
          generation: id,
          state: "pending",
          mode,
          changedAt: time,
          expiresAt: time + PENDING_TTL,
        });
      });
      if (epoch !== this.#epoch || !this.#pending.has(id)) throw stale();
      return connection;
    } catch (error) {
      connection.dispose();
      throw error;
    }
  }
  async beginRemembered(
    expectedMode: CredentialMode = "offline-test",
  ): Promise<PendingConnection | undefined> {
    if (!["offline-test", "ghin"].includes(expectedMode)) throw invalidInput();
    const observedEpoch = this.#epoch,
      id = randomUUID();
    let epoch: number | undefined;
    let connection: Pending | undefined;
    try {
      await this.store.update(NAME, (bytes) => {
        const record = decode(bytes);
        if (record?.state !== "connected" || !record.credentials) return bytes;
        if (record.mode !== expectedMode)
          throw new AppError(
            "FORBIDDEN",
            "Stored credentials belong to a different connection mode.",
          );
        if (observedEpoch !== this.#epoch) throw stale();
        epoch = ++this.#epoch;
        this.clearPending();
        const input = decodeCredentials(record.credentials);
        try {
          connection = this.pending(id, expectedMode, input, true);
        } finally {
          wipe(input);
        }
        const time = this.time();
        return encode({
          version: 1,
          generation: id,
          state: "pending",
          mode: expectedMode,
          changedAt: time,
          expiresAt: time + PENDING_TTL,
        });
      });
      if (epoch !== undefined && epoch !== this.#epoch) throw stale();
      return connection;
    } catch (error) {
      connection?.dispose();
      throw error;
    }
  }
  async commit(id: string): Promise<boolean> {
    const entry = this.#pending.get(id);
    if (!entry) return false;
    let committed = false;
    await this.store.update(NAME, (bytes) => {
      const record = decode(bytes),
        time = this.time();
      if (
        this.#pending.get(id) !== entry ||
        record?.generation !== id ||
        record.state !== "pending" ||
        record.expiresAt! <= time
      )
        return bytes;
      const next: ConnectionRecord = {
        version: 1,
        generation: id,
        state: "connected",
        mode: record.mode,
        changedAt: time,
        expiresAt: time + CONNECTION_TTL,
      };
      if (entry.remember) {
        const input = entry.connection.copyCredentials();
        try {
          next.credentials = {
            username: input.username.toString("base64"),
            password: input.password.toString("base64"),
            ownGhinNumber: input.ownGhinNumber,
            accountType: input.accountType,
          };
        } finally {
          wipe(input);
        }
      }
      const output = encode(next);
      committed = true;
      return output;
    });
    return committed;
  }
  async isCurrent(id: string): Promise<boolean> {
    const record = await this.record();
    return (
      !!record &&
      record.generation === id &&
      record.state !== "disconnected" &&
      record.expiresAt! > this.time()
    );
  }
  async disconnect(): Promise<void> {
    ++this.#epoch;
    this.clearPending();
    await this.store.update(NAME, (bytes) => {
      const previous = decode(bytes);
      return encode({
        version: 1,
        generation: randomUUID(),
        state: "disconnected",
        mode: previous?.mode ?? "offline-test",
        changedAt: this.time(),
        expiresAt: null,
      });
    });
  }
  async cancel(id: string): Promise<boolean> {
    this.#pending.get(id)?.connection.dispose();
    let cancelled = false;
    await this.store.update(NAME, (bytes) => {
      const record = decode(bytes);
      if (record?.generation !== id || record.state === "disconnected")
        return bytes;
      cancelled = true;
      return encode({
        version: 1,
        generation: randomUUID(),
        state: "disconnected",
        mode: record.mode,
        changedAt: this.time(),
        expiresAt: null,
      });
    });
    return cancelled;
  }
  async status(): Promise<{
    configured: boolean;
    remembered: boolean;
    connected: boolean;
    generation?: string;
    mode?: CredentialMode;
  }> {
    const record = await this.record();
    if (!record)
      return { configured: false, remembered: false, connected: false };
    const active =
      record.state !== "disconnected" && record.expiresAt! > this.time();
    const remembered =
      record.state === "connected" && record.credentials !== undefined;
    return {
      configured: active || remembered,
      remembered,
      connected: record.state === "connected" && active,
      generation: record.generation,
      mode: record.mode,
    };
  }
  toJSON() {
    return { credentials: "[REDACTED]" };
  }
  [inspect.custom]() {
    return "GHIN credential repository [REDACTED]";
  }
}
