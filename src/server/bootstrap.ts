import { randomBytes, createHmac } from "node:crypto";
import { resolve } from "node:path";
import { MockHandicapProvider } from "../providers/mock-provider.js";
import { MockRosterStorage } from "../storage/mock-roster-storage.js";
import { LocalRosterStorage } from "../storage/local-roster-storage.js";
import { RosterService } from "../domain/roster-service.js";
import { LookupService } from "../domain/lookup-service.js";
import { Confirmations } from "../domain/confirmation.js";
import type { HandicapProvider } from "../providers/handicap-provider.js";
import { assertLiveAccessEnabled } from "../providers/live-access.js";
export interface OfflineDependencies {
  provider?: HandicapProvider;
  localStorage?: { directory: string; key: Buffer };
}
export function createService(
  env: NodeJS.ProcessEnv = process.env,
  offline: OfflineDependencies = {},
) {
  if (env.OGH_PROVIDER && env.OGH_PROVIDER !== "mock")
    throw new Error("Live GHIN providers are disabled. Use OGH_PROVIDER=mock.");
  if (env.OGH_STORAGE && !["mock", "local"].includes(env.OGH_STORAGE))
    throw new Error("Storage provider is not implemented.");
  if (offline.provider?.capabilities.live) assertLiveAccessEnabled();
  if (offline.localStorage && (env.OGH_STORAGE_KEY || env.OGH_STORAGE_DIR))
    throw new Error(
      "Profile storage cannot be combined with environment storage settings.",
    );
  const raw = env.OGH_STORAGE_KEY;
  if (raw && !/^[a-fA-F0-9]{64}$/.test(raw))
    throw new Error("OGH_STORAGE_KEY must contain 64 hex characters.");
  if (
    !offline.localStorage &&
    env.OGH_STORAGE === "local" &&
    (!raw || !env.OGH_STORAGE_DIR)
  )
    throw new Error("Local storage requires its directory and encryption key.");
  const key =
    offline.localStorage?.key ??
    (raw ? Buffer.from(raw, "hex") : randomBytes(32));
  const storage = offline.localStorage
    ? new LocalRosterStorage(offline.localStorage.directory, key)
    : env.OGH_STORAGE === "local"
      ? new LocalRosterStorage(resolve(env.OGH_STORAGE_DIR!), key)
      : new MockRosterStorage();
  const ttlMs =
    env.OGH_CACHE_TTL_MS === undefined
      ? 3_600_000
      : Number(env.OGH_CACHE_TTL_MS);
  return new RosterService(
    storage,
    new LookupService(offline.provider ?? new MockHandicapProvider(), {
      ttlMs,
    }),
    new Confirmations(
      createHmac("sha256", key)
        .update("open-golf-handicap-confirmation-v1")
        .digest(),
    ),
  );
}
