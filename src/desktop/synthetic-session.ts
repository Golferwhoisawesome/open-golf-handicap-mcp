import { DesktopError } from "./errors.js";
import type { SecretStore } from "./secret-store.js";
/** Exercises expiration/revocation only; cannot log in to or revoke anything at GHIN. */
export class SyntheticSession {
  constructor(private readonly store: SecretStore) {}
  async connect(token: Buffer, expiresAt: number) {
    if (!token.subarray(0, 18).equals(Buffer.from("synthetic-session:")))
      throw new DesktopError("INVALID_SECRET");
    await this.store.set("synthetic-session", token, { expiresAt });
  }
  async status() {
    const handle = await this.store.get("synthetic-session");
    handle?.dispose();
    return {
      provider: "synthetic",
      authenticated: Boolean(handle),
      liveGhinAccess: false,
    };
  }
  async disconnect() {
    await this.store.revoke("synthetic-session");
    return { provider: "synthetic", disconnected: true, liveGhinAccess: false };
  }
}
