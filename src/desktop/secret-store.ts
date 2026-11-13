import { inspect } from "node:util";
import { DesktopError } from "./errors.js";
export interface SecretOptions {
  expiresAt?: number;
}
export interface SecretStoreStatus {
  kind: string;
  locked: boolean;
  activeCount: number;
  expiredCount: number;
}
export interface SecretStore {
  readonly kind: string;
  get(name: string): Promise<SecretHandle | undefined>;
  set(name: string, value: Buffer, options?: SecretOptions): Promise<void>;
  revoke(name: string): Promise<void>;
  /** Atomic single-record change. Callback is synchronous and must not reenter
   * the store. Temporary input and returned buffers are wiped after copying.
   * A returned value has no expiry; undefined deletes the record. */
  update(
    name: string,
    change: (current: Buffer | undefined) => Buffer | undefined,
  ): Promise<void>;
  status(): Promise<SecretStoreStatus>;
  lock(): Promise<void>;
}
export function validateSecret(
  name: string,
  value?: Buffer,
  expiresAt?: number,
): void {
  if (
    !/^[a-z][a-z0-9._-]{0,63}$/.test(name) ||
    (value && (value.length === 0 || value.length > 8192)) ||
    (expiresAt !== undefined &&
      (!Number.isSafeInteger(expiresAt) || expiresAt < 0))
  )
    throw new DesktopError("INVALID_SECRET");
}
/** Callers must wipe copies; JavaScript cannot guarantee secure erasure. */
export class SecretHandle {
  #bytes: Buffer;
  #disposed = false;
  #onDispose: (() => void) | undefined;
  constructor(
    bytes: Buffer,
    private readonly expiresAt: number | null = null,
    private readonly now: () => number = Date.now,
    onDispose?: () => void,
  ) {
    this.#bytes = Buffer.from(bytes);
    this.#onDispose = onDispose;
  }
  copy(): Buffer {
    if (
      this.#disposed ||
      (this.expiresAt !== null && this.now() >= this.expiresAt)
    )
      throw new DesktopError("VAULT_LOCKED");
    return Buffer.from(this.#bytes);
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#bytes.fill(0);
    this.#disposed = true;
    const callback = this.#onDispose;
    this.#onDispose = undefined;
    callback?.();
  }
  toJSON() {
    return { secret: "[REDACTED]" };
  }
  [inspect.custom]() {
    return "SecretHandle [REDACTED]";
  }
}
interface MemoryRecord {
  value: Buffer;
  expiresAt: number | null;
}
/** Test-only process memory; this does not integrate an OS credential vault. */
export class InMemorySecretStore implements SecretStore {
  readonly kind = "memory-synthetic";
  #locked = false;
  #records = new Map<string, MemoryRecord>();
  #handles = new Map<string, Set<SecretHandle>>();
  constructor(private readonly now: () => number = Date.now) {}
  private assertUnlocked() {
    if (this.#locked) throw new DesktopError("VAULT_LOCKED");
  }
  private invalidate(name: string) {
    for (const h of this.#handles.get(name) ?? []) h.dispose();
    this.#handles.delete(name);
  }
  async get(name: string) {
    this.assertUnlocked();
    validateSecret(name);
    const record = this.#records.get(name);
    if (
      !record ||
      (record.expiresAt !== null && this.now() >= record.expiresAt)
    )
      return undefined;
    const handles = this.#handles.get(name) ?? new Set<SecretHandle>();
    const handle = new SecretHandle(
      record.value,
      record.expiresAt,
      this.now,
      () => {
        handles.delete(handle);
        if (handles.size === 0 && this.#handles.get(name) === handles)
          this.#handles.delete(name);
      },
    );
    handles.add(handle);
    this.#handles.set(name, handles);
    return handle;
  }
  async set(name: string, value: Buffer, options: SecretOptions = {}) {
    this.assertUnlocked();
    validateSecret(name, value, options.expiresAt);
    if (!this.#records.has(name) && this.#records.size >= 32)
      throw new DesktopError("INVALID_SECRET");
    this.invalidate(name);
    this.#records.get(name)?.value.fill(0);
    this.#records.set(name, {
      value: Buffer.from(value),
      expiresAt: options.expiresAt ?? null,
    });
  }
  async revoke(name: string) {
    this.assertUnlocked();
    validateSecret(name);
    this.invalidate(name);
    this.#records.get(name)?.value.fill(0);
    this.#records.delete(name);
  }
  async update(
    name: string,
    change: (current: Buffer | undefined) => Buffer | undefined,
  ): Promise<void> {
    this.assertUnlocked();
    validateSecret(name);
    const existing = this.#records.get(name);
    const current =
      existing &&
      (existing.expiresAt === null || this.now() < existing.expiresAt)
        ? Buffer.from(existing.value)
        : undefined;
    let next: Buffer | undefined;
    try {
      next = change(current);
      if (next !== undefined) {
        if (!Buffer.isBuffer(next)) throw new DesktopError("INVALID_SECRET");
        validateSecret(name, next);
        if (!this.#records.has(name) && this.#records.size >= 32)
          throw new DesktopError("INVALID_SECRET");
      }
      this.assertUnlocked();
      const copy = next === undefined ? undefined : Buffer.from(next);
      this.invalidate(name);
      existing?.value.fill(0);
      if (copy) this.#records.set(name, { value: copy, expiresAt: null });
      else this.#records.delete(name);
    } finally {
      current?.fill(0);
      if (Buffer.isBuffer(next)) next.fill(0);
    }
  }
  async status(): Promise<SecretStoreStatus> {
    if (this.#locked)
      return { kind: this.kind, locked: true, activeCount: 0, expiredCount: 0 };
    let activeCount = 0,
      expiredCount = 0;
    for (const r of this.#records.values())
      if (r.expiresAt !== null && this.now() >= r.expiresAt) expiredCount++;
      else activeCount++;
    return { kind: this.kind, locked: false, activeCount, expiredCount };
  }
  async lock() {
    if (this.#locked) return;
    this.#locked = true;
    for (const record of this.#records.values()) record.value.fill(0);
    this.#records.clear();
    for (const name of this.#handles.keys()) this.invalidate(name);
  }
  toJSON() {
    return { kind: this.kind, secret: "[REDACTED]" };
  }
  [inspect.custom]() {
    return "InMemorySecretStore [REDACTED]";
  }
}
