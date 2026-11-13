import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GhinAuthenticatedProvider } from "../src/providers/ghin-provider.js";
import {
  GhinCredentialRepository,
  type CredentialInput,
} from "../src/desktop/ghin-credentials.js";
import { InMemorySecretStore } from "../src/desktop/secret-store.js";
import {
  initProfile,
  unlockProfile,
  type UnlockedProfile,
} from "../src/desktop/profile.js";
import { startRosterSession } from "../src/desktop/session-broker.js";
import { LocalRosterStorage } from "../src/storage/local-roster-storage.js";
import { setLiveAccessForTesting } from "../src/providers/live-access.js";
import { shortTempRoot } from "./support/temp.js";

const owner = { subject: "local-owner" };
const code = (expected: string) => (error: unknown) =>
  (error as { code?: string })?.code === expected;
const credentials = (): CredentialInput => ({
  username: Buffer.from("user@example.invalid"),
  password: Buffer.from("synthetic-password-test"),
  ownGhinNumber: "900000001",
  accountType: "golfer",
});
const wipe = (input: CredentialInput) => {
  input.username.fill(0);
  input.password.fill(0);
};
const options = (repository: GhinCredentialRepository) => ({
  ownerSubject: owner.subject,
  mode: "offline-test" as const,
  repository,
});
async function data(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name} should succeed`);
  assert.equal(
    result.structuredContent?.ok,
    true,
    `${name} should return success`,
  );
  return result.structuredContent!.data as any;
}

test(
  "two desktop MCP processes share the actual offline SDK; disconnect blocks cached reads and preserves encrypted roster",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(
        join(await shortTempRoot(), "ogh-sdk-integration-"),
      ),
      directory = join(root, "p");
    const passphrase = Buffer.from("synthetic-sdk-integration-vault"),
      login = credentials();
    let profile: UnlockedProfile | undefined,
      reopened: UnlockedProfile | undefined;
    let provider: GhinAuthenticatedProvider | undefined;
    let session: Awaited<ReturnType<typeof startRosterSession>> | undefined;
    const clients: Client[] = [],
      diagnostics: string[] = [];
    async function attach() {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          "--import",
          "tsx",
          "src/server/stdio.ts",
          "--offline-ghin",
          "--profile",
          directory,
        ],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "", OGH_PROVIDER: "mock" },
        stderr: "pipe",
      });
      transport.stderr?.on("data", (chunk) => diagnostics.push(String(chunk)));
      const client = new Client({
        name: "offline-ghin-integration",
        version: "1",
      });
      clients.push(client);
      await client.connect(transport, { timeout: 60_000 });
      return client;
    }
    try {
      await initProfile(directory, passphrase);
      profile = await unlockProfile(directory, passphrase);
      const repository = await profile.withSecrets(
        async (store) => new GhinCredentialRepository(store),
      );
      provider = await GhinAuthenticatedProvider.connect({
        ...options(repository),
        credentials: login,
        remember: true,
      });
      const key = profile.copyRosterKey();
      try {
        session = await startRosterSession({
          directory,
          profileId: profile.profileId,
          rosterDirectory: profile.rosterDirectory,
          key,
          provider,
          onClose: () => provider!.close(),
        });
      } finally {
        key.fill(0);
      }
      const first = await attach(),
        second = await attach();
      const status = await data(first, "get_connection_status");
      assert.equal(status.provider, "spicygolf-sdk-offline");
      assert.equal(status.providerAuthenticated, true);
      assert.equal(status.connected, true);
      assert.equal(status.credentialsStored, true);
      assert.equal(status.liveAccessEnabled, false);
      await data(first, "save_golfer", {
        name: "Synthetic SDK Desktop",
        ghinNumber: "900000001",
      });
      assert.equal((await data(first, "refresh_saved_handicaps")).checked, 1);
      const cached = (
        await data(second, "get_golfer_handicap", { ghinNumber: "900000001" })
      ).result;
      assert.equal(cached.ok, true);
      assert.equal(cached.data.handicapIndex, 12.4);
      assert.equal(cached.data.source, "spicygolf-sdk-offline");
      assert.equal(cached.data.synthetic, true);
      const exported = await data(second, "export_golfer_roster");
      assert.equal(exported.roster.golfers.length, 1);
      assert.equal(exported.roster.golfers[0].handicap.handicapIndex, 12.4);
      const disconnected = await data(first, "disconnect_provider");
      assert.equal(disconnected.disconnected, true);
      assert.equal(disconnected.credentialsStored, false);
      const blocked = await second.callTool({
        name: "get_golfer_handicap",
        arguments: { ghinNumber: "900000001" },
      });
      const blockedBody = blocked.structuredContent as any;
      assert.equal(blockedBody.ok, false);
      assert.equal(blockedBody.error.code, "AUTH_REQUIRED");
      assert.equal(
        (await data(second, "get_connection_status")).providerAuthenticated,
        false,
      );
      assert.equal(
        (await data(second, "export_golfer_roster")).roster.golfers[0].handicap
          .handicapIndex,
        12.4,
      );
      await first.close();
      await second.close();
      await session.close();
      await profile.dispose();
      reopened = await unlockProfile(directory, passphrase);
      const retained = await reopened.withSecrets(
        async (store) => new GhinCredentialRepository(store),
      );
      assert.equal((await retained.status()).remembered, false);
      assert.equal(await retained.beginRemembered(), undefined);
      await assert.rejects(
        GhinAuthenticatedProvider.connect(options(retained)),
        code("AUTH_REQUIRED"),
      );
      const reopenedKey = reopened.copyRosterKey();
      try {
        const saved = await new LocalRosterStorage(
          reopened.rosterDirectory,
          reopenedKey,
        ).read(owner.subject);
        assert.equal(saved.golfers.length, 1);
        assert.equal(saved.golfers[0]!.handicap?.handicapIndex, 12.4);
      } finally {
        reopenedKey.fill(0);
      }
      const ciphertext = await readFile(join(directory, "vault.bin"));
      assert.equal(ciphertext.includes(login.password), false);
      assert.equal(ciphertext.includes(login.username), false);
      const publicOutput =
        JSON.stringify([status, cached, exported, disconnected, blockedBody]) +
        diagnostics.join("");
      for (const secret of [
        login.username.toString(),
        login.password.toString(),
        passphrase.toString(),
        login.password.toString("base64"),
      ])
        assert.equal(publicOutput.includes(secret), false);
    } finally {
      for (const client of clients) await client.close();
      await session?.close();
      await provider?.close();
      await reopened?.dispose();
      await profile?.dispose();
      wipe(login);
      passphrase.fill(0);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "provider keeps 403 distinct from authentication expiry and rejects invalid delta dates",
  { timeout: 60_000 },
  async () => {
    const store = new InMemorySecretStore(),
      repository = new GhinCredentialRepository(store),
      login = credentials();
    let provider: GhinAuthenticatedProvider | undefined;
    try {
      provider = await GhinAuthenticatedProvider.connect({
        ...options(repository),
        credentials: login,
        sessionOptions: { fixtureScenario: "forbidden" },
      });
      await assert.rejects(
        provider.getMany(owner, ["900000001"], { updatedSince: "2026-02-30" }),
        code("INVALID_INPUT"),
      );
      await assert.rejects(
        provider.getMany(owner, ["900000001"]),
        code("FORBIDDEN"),
      );
      assert.equal((await provider.getConnectionState(owner)).connected, false);
      await assert.rejects(
        provider.getMany(owner, ["900000001"]),
        code("AUTH_REQUIRED"),
      );
    } finally {
      await provider?.close();
      wipe(login);
      await store.lock();
    }
  },
);

test("failed session construction clears pending credentials and release gate runs before any sign-in", async () => {
  const store = new InMemorySecretStore(),
    repository = new GhinCredentialRepository(store),
    login = credentials();
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    networkCalls++;
    throw new Error("Unexpected network");
  };
  try {
    await assert.rejects(
      GhinAuthenticatedProvider.connect({
        ...options(repository),
        credentials: login,
        remember: true,
        sessionOptions: { timeoutMs: 1 },
      }),
      code("INVALID_INPUT"),
    );
    assert.equal((await repository.status()).configured, false);
    assert.equal((await repository.status()).remembered, false);
    const before = await repository.status();
    setLiveAccessForTesting(false);
    try {
      await assert.rejects(
        GhinAuthenticatedProvider.connect({
          ...options(repository),
          mode: "ghin",
          credentials: login,
          remember: true,
        }),
        code("LIVE_ACCESS_DISABLED"),
      );
    } finally {
      setLiveAccessForTesting(undefined);
    }
    assert.deepEqual(await repository.status(), before);
    assert.equal(networkCalls, 0);
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      GhinAuthenticatedProvider.connect({
        ...options(repository),
        credentials: login,
        signal: cancelled.signal,
      }),
      code("AUTH_REQUIRED"),
    );
    assert.deepEqual(await repository.status(), before);
  } finally {
    globalThis.fetch = originalFetch;
    wipe(login);
    await store.lock();
  }
});

test(
  "expired SDK session retains opted-in login for explicit reconnect and stale disconnect cannot erase it",
  { timeout: 60_000 },
  async () => {
    const store = new InMemorySecretStore(),
      repository = new GhinCredentialRepository(store),
      login = credentials();
    let first: GhinAuthenticatedProvider | undefined,
      next: GhinAuthenticatedProvider | undefined;
    try {
      first = await GhinAuthenticatedProvider.connect({
        ...options(repository),
        credentials: login,
        remember: true,
        // Room for slow CI worker startup plus two paced requests.
        sessionOptions: { maxSessionMs: 12_000 },
      });
      const expiration = (await first.getConnectionState(owner)).expiresAt;
      assert(expiration);
      await delay(Math.max(0, Date.parse(expiration) - Date.now()) + 50);
      assert.equal((await first.getConnectionState(owner)).connected, false);
      assert.equal((await repository.status()).remembered, true);
      await assert.rejects(
        first.getMany(owner, ["900000001"]),
        code("AUTH_REQUIRED"),
      );
      await first.close();
      next = await GhinAuthenticatedProvider.connect(options(repository));
      const result = await next.getMany(owner, ["900000001", "900000005"]);
      assert.deepEqual(
        result
          .filter((row) => row.ok)
          .map((row) => row.ok && row.data.handicapIndex),
        [12.4, -0.9],
      );
      await assert.rejects(first.disconnect(owner), code("CONFLICT"));
      assert.equal((await next.getConnectionState(owner)).connected, true);
      await next.disconnect(owner);
      assert.equal((await repository.status()).remembered, false);
    } finally {
      await first?.close();
      await next?.close();
      wipe(login);
      await store.lock();
    }
  },
);
