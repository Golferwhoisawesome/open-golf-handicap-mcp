import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runGhinSetup } from "../src/desktop/ghin-setup.js";
import { GhinAuthenticatedProvider } from "../src/providers/ghin-provider.js";
import { GhinCredentialRepository } from "../src/desktop/ghin-credentials.js";
import { InMemorySecretStore } from "../src/desktop/secret-store.js";
import {
  initProfile,
  unlockProfile,
  type UnlockedProfile,
} from "../src/desktop/profile.js";
import { startRosterSession } from "../src/desktop/session-broker.js";
import { setLiveAccessForTesting } from "../src/providers/live-access.js";
import { shortTempRoot } from "./support/temp.js";

const owner = { subject: "local-owner" };
const credentials = () => ({
  username: Buffer.from("controlled-desktop@example.invalid"),
  password: Buffer.from("synthetic-controlled-desktop-password"),
  ownGhinNumber: "900000001",
  accountType: "golfer" as const,
});
const code = (expected: string) => (error: unknown) =>
  (error as { code?: string })?.code === expected;

test("controlled setup rejects retention/resume/API options before any private prompt or profile access", async () => {
  for (const args of [
    ["connect-ghin", "--remember-login"],
    ["connect-ghin", "--account-type", "api"],
    ["resume-ghin"],
    ["disconnect-ghin"],
  ])
    await assert.rejects(
      runGhinSetup([
        ...args,
        "--controlled-test",
        "--offline-test",
        "--profile",
        "/nonexistent-controlled-test-profile",
      ]),
      code("INVALID_INPUT"),
    );
  setLiveAccessForTesting(false);
  try {
    await assert.rejects(
      runGhinSetup([
        "connect-ghin",
        "--controlled-test",
        "--profile",
        "/nonexistent-controlled-test-profile",
      ]),
      code("LIVE_ACCESS_DISABLED"),
    );
  } finally {
    setLiveAccessForTesting(undefined);
  }
});

test("controlled provider cannot retain or resume credentials and leaves the vault untouched when rejected", async () => {
  const store = new InMemorySecretStore();
  const repository = new GhinCredentialRepository(store);
  const input = credentials();
  const before = await repository.status();
  try {
    for (const extra of [
      { credentials: input, remember: true },
      {},
      { credentials: { ...input, accountType: "api" as const } },
    ]) {
      await assert.rejects(
        GhinAuthenticatedProvider.connect({
          ownerSubject: owner.subject,
          mode: "offline-test",
          repository,
          sessionOptions: { controlledTest: true },
          ...extra,
        }),
        code("INVALID_INPUT"),
      );
      assert.deepEqual(await repository.status(), before);
    }
  } finally {
    input.username.fill(0);
    input.password.fill(0);
    await store.lock();
  }
});

test("controlled sign-in failure reports only bounded diagnostics after worker exit and credential cleanup", async () => {
  const store = new InMemorySecretStore();
  const repository = new GhinCredentialRepository(store);
  const input = credentials();
  let diagnostic:
    | ReturnType<GhinAuthenticatedProvider["diagnostics"]>
    | undefined;
  try {
    await assert.rejects(
      GhinAuthenticatedProvider.connect({
        ownerSubject: owner.subject,
        mode: "offline-test",
        repository,
        credentials: input,
        sessionOptions: {
          controlledTest: true,
          fixtureScenario: "auth-denied",
        },
        onConnectionFailure: (result) => {
          diagnostic = result;
        },
      }),
      code("AUTH_REQUIRED"),
    );
    assert.equal(diagnostic?.workerExited, true);
    assert.equal(diagnostic?.lastStatus, 401);
    assert.deepEqual(diagnostic?.requests, {
      installation: 1,
      login: 1,
      search: 0,
      total: 2,
    });
    assert.equal((await repository.status()).configured, false);
    assert.equal((await repository.status()).remembered, false);
    for (const secret of [
      input.username.toString(),
      input.password.toString(),
      input.ownGhinNumber,
    ])
      assert.equal(JSON.stringify(diagnostic).includes(secret), false);
  } finally {
    input.username.fill(0);
    input.password.fill(0);
    await store.lock();
  }
});

test(
  "controlled MCP hookup shares its budget across clients and blocks cached reads after budget termination",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(await shortTempRoot(), "ogh-controlled-"));
    const directory = join(root, "p");
    const passphrase = Buffer.from("synthetic-controlled-vault-only");
    const login = credentials();
    let profile: UnlockedProfile | undefined;
    let provider: GhinAuthenticatedProvider | undefined;
    let session: Awaited<ReturnType<typeof startRosterSession>> | undefined;
    const clients: Client[] = [];
    const diagnostics: string[] = [];
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
        name: "controlled-desktop-test",
        version: "1",
      });
      clients.push(client);
      await client.connect(transport, { timeout: 60_000 });
      return client;
    }
    async function call(client: Client, name: string, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      return result.structuredContent as any;
    }
    try {
      await initProfile(directory, passphrase);
      profile = await unlockProfile(directory, passphrase);
      const repository = await profile.withSecrets(
        async (store) => new GhinCredentialRepository(store),
      );
      provider = await GhinAuthenticatedProvider.connect({
        ownerSubject: owner.subject,
        mode: "offline-test",
        repository,
        credentials: login,
        sessionOptions: { controlledTest: true },
      });
      const key = profile.copyRosterKey();
      try {
        session = await startRosterSession({
          directory,
          profileId: profile.profileId,
          rosterDirectory: profile.rosterDirectory,
          durationMs: 300_000,
          key,
          provider,
          onClose: () => provider!.close(),
        });
      } finally {
        key.fill(0);
      }
      const first = await attach();
      const second = await attach();
      const status = await call(first, "get_connection_status");
      assert.equal(status.ok, true);
      assert.equal(status.data.controlledTest, true);
      assert.equal(status.data.credentialsStored, false);
      assert.equal(status.data.liveAccessEnabled, false);
      assert.equal(status.data.capabilities.batch, false);
      assert.equal(status.data.capabilities.updatedSince, false);
      const own = { ghinNumber: "900000001" };
      const fresh = await call(first, "get_golfer_handicap", own);
      assert.equal(fresh.data.result.ok, true);
      assert.equal(fresh.data.result.data.synthetic, true);
      assert.equal(fresh.data.result.data.handicapIndex, 12.4);
      const cached = await call(first, "get_golfer_handicap", own);
      assert.equal(cached.data.result.data.freshness, "cached");
      assert.equal(provider.diagnostics(owner).requests.total, 4);
      // A second MCP process has its own cache, but cannot obtain another request
      // allowance. Exhaustion at the common SDK transport ends both clients' access.
      const exhausted = await call(second, "get_golfer_handicap", own);
      assert.equal(exhausted.data.result.ok, false);
      assert.equal(exhausted.data.result.error.code, "AUTH_REQUIRED");
      assert.equal(provider.diagnostics(owner).workerExited, true);
      assert.equal(provider.diagnostics(owner).requests.total, 4);
      const cachedAfterStop = await call(first, "get_golfer_handicap", own);
      assert.equal(cachedAfterStop.ok, false);
      assert.equal(cachedAfterStop.error.code, "AUTH_REQUIRED");
      const disconnected = await call(first, "disconnect_provider");
      assert.equal(disconnected.ok, true);
      assert.equal(disconnected.data.credentialsStored, false);
      assert.equal((await repository.status()).remembered, false);
      const publicDiagnostics = JSON.stringify([
        status,
        provider.diagnostics(owner),
        diagnostics,
      ]);
      for (const secret of [
        login.username.toString(),
        login.password.toString(),
        passphrase.toString(),
        login.ownGhinNumber,
      ])
        assert.equal(publicDiagnostics.includes(secret), false);
    } finally {
      for (const client of clients) await client.close();
      await session?.close();
      await provider?.close();
      await profile?.dispose();
      login.username.fill(0);
      login.password.fill(0);
      passphrase.fill(0);
      await rm(root, { recursive: true, force: true });
    }
  },
);
