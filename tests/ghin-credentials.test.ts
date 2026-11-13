import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  GhinCredentialRepository,
  type CredentialInput,
} from "../src/desktop/ghin-credentials.js";
import {
  InMemorySecretStore,
  type SecretStore,
} from "../src/desktop/secret-store.js";
import { EncryptedFileSecretStore } from "../src/desktop/encrypted-file-secret-store.js";
import { readPrivateCredential } from "../src/desktop/private-credential-prompt.js";
import {
  initProfile,
  unlockProfile,
  type UnlockedProfile,
} from "../src/desktop/profile.js";
import { shortTempRoot } from "./support/temp.js";
const code = (expected: string) => (error: unknown) =>
  (error as { code?: string })?.code === expected;
const input = (): CredentialInput => ({
  username: Buffer.from("synthetic@example.invalid"),
  password: Buffer.from("  synthetic-密码-🔐  "),
  ownGhinNumber: "900000001",
  accountType: "golfer",
});
const wipe = (value: CredentialInput) => {
  value.username.fill(0);
  value.password.fill(0);
};
async function raw(store: SecretStore): Promise<string | undefined> {
  const handle = await store.get("ghin-connection");
  if (!handle) return undefined;
  const bytes = handle.copy();
  try {
    return bytes.toString("utf8");
  } finally {
    bytes.fill(0);
    handle.dispose();
  }
}
async function fixture() {
  const root = await mkdtemp(
    join(await shortTempRoot(), "ogh-ghin-credentials-"),
  );
  const directory = join(root, "profile"),
    passphrase = Buffer.from("synthetic-private-vault-passphrase");
  await initProfile(directory, passphrase);
  const profile = await unlockProfile(directory, passphrase);
  return {
    root,
    directory,
    passphrase,
    profile,
    async close() {
      await profile.dispose();
      passphrase.fill(0);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("session-only GHIN credentials preserve Unicode and never persist before or after commit", async () => {
  const store = new InMemorySecretStore(),
    repository = new GhinCredentialRepository(store);
  const credentials = input(),
    original = Buffer.from(credentials.password);
  const pending = await repository.begin(credentials, { remember: false });
  assert.equal((await repository.status()).connected, false);
  assert.equal(await repository.isCurrent(pending.id), true);
  const pendingRecord = await raw(store);
  for (const forbidden of [
    credentials.username.toString(),
    credentials.password.toString(),
    credentials.password.toString("base64"),
    credentials.ownGhinNumber,
  ])
    assert(!pendingRecord!.includes(forbidden));
  credentials.password.fill(0);
  const copy = pending.copyCredentials();
  assert.deepEqual(copy.password, original);
  assert(!JSON.stringify(copy).includes("synthetic"));
  assert(!inspect(copy).includes("synthetic"));
  wipe(copy);
  assert.equal(await repository.commit(pending.id), true);
  assert.equal(
    await repository.commit(pending.id),
    false,
    "commit must not renew a session without new authentication",
  );
  assert.deepEqual(await repository.status(), {
    configured: true,
    remembered: false,
    connected: true,
    generation: pending.id,
    mode: "offline-test",
  });
  assert(!(await raw(store))!.includes(original.toString("base64")));
  assert.equal(
    await new GhinCredentialRepository(store).beginRemembered(),
    undefined,
  );
  await repository.disconnect();
  assert.equal(await repository.isCurrent(pending.id), false);
  assert.throws(() => pending.copyCredentials(), code("AUTH_REQUIRED"));
  assert.equal((await repository.status()).configured, false);
  wipe(credentials);
  original.fill(0);
  await store.lock();
});

test("remembered credentials are persisted only after verification and reconnect gets a new generation", async () => {
  const store = new InMemorySecretStore(),
    repository = new GhinCredentialRepository(store),
    credentials = input();
  const first = await repository.begin(credentials, { remember: true });
  assert.equal(JSON.parse((await raw(store))!).credentials, undefined);
  assert.equal(await repository.commit(first.id), true);
  first.dispose();
  assert.equal((await repository.status()).remembered, true);
  assert.equal(
    JSON.parse((await raw(store))!).credentials.password,
    credentials.password.toString("base64"),
  );
  const reopened = new GhinCredentialRepository(store),
    resumed = await reopened.beginRemembered();
  assert(resumed);
  assert.notEqual(resumed.id, first.id);
  assert.equal(await repository.isCurrent(first.id), false);
  assert.equal(
    JSON.parse((await raw(store))!).credentials,
    undefined,
    "reconnect holds credentials only in memory until reverified",
  );
  const copy = resumed.copyCredentials();
  assert.deepEqual(copy.password, credentials.password);
  wipe(copy);
  assert.equal(await reopened.commit(resumed.id), true);
  resumed.dispose();
  wipe(credentials);
  await store.lock();
});

test("expiration denies current use but preserves opted-in login for explicit reauthentication", async () => {
  let time = 1_000;
  const store = new InMemorySecretStore(() => time),
    repository = new GhinCredentialRepository(store, () => time),
    credentials = input();
  const first = await repository.begin(credentials, { remember: true });
  assert.equal(await repository.commit(first.id), true);
  first.dispose();
  time += 3_600_000;
  assert.equal(await repository.isCurrent(first.id), false);
  assert.deepEqual(await repository.status(), {
    configured: true,
    remembered: true,
    connected: false,
    generation: first.id,
    mode: "offline-test",
  });
  const resumed = await repository.beginRemembered();
  assert(resumed);
  time += 300_000;
  assert.equal(await repository.commit(resumed.id), false);
  assert.equal(await repository.isCurrent(resumed.id), false);
  assert.equal(await repository.cancel(resumed.id), true);
  assert.equal((await repository.status()).remembered, false);
  resumed.dispose();
  wipe(credentials);
  await store.lock();
});

test("remembered credentials are bound to their connection mode without destructive fallback", async () => {
  const store = new InMemorySecretStore(),
    repository = new GhinCredentialRepository(store),
    credentials = input();
  const pending = await repository.begin(credentials, {
    remember: true,
    mode: "offline-test",
  });
  assert.equal(pending.mode, "offline-test");
  await repository.commit(pending.id);
  const before = await raw(store);
  await assert.rejects(repository.beginRemembered("ghin"), code("FORBIDDEN"));
  assert.equal(await raw(store), before);
  const copy = pending.copyCredentials();
  assert.deepEqual(copy.password, credentials.password);
  wipe(copy);
  const resumed = await repository.beginRemembered("offline-test");
  assert(resumed);
  assert.equal(resumed.mode, "offline-test");
  await repository.cancel(resumed.id);
  const liveLabelOnly = await repository.begin(credentials, {
    remember: true,
    mode: "ghin",
  });
  await repository.commit(liveLabelOnly.id);
  const liveBefore = await raw(store);
  await assert.rejects(
    repository.beginRemembered("offline-test"),
    code("FORBIDDEN"),
  );
  assert.equal(await raw(store), liveBefore);
  assert.equal((await repository.status()).mode, "ghin");
  liveLabelOnly.dispose();
  wipe(credentials);
  await store.lock();
});

test("disconnect wins against late authentication and old cancellation cannot erase a newer connection", async () => {
  const store = new InMemorySecretStore(),
    a = new GhinCredentialRepository(store),
    b = new GhinCredentialRepository(store),
    credentials = input();
  const old = await a.begin(credentials, { remember: true });
  await b.disconnect();
  assert.equal(await a.commit(old.id), false);
  const next = await b.begin(credentials, { remember: true });
  assert.equal(await a.cancel(old.id), false);
  assert.equal(await b.commit(next.id), true);
  assert.equal(await a.isCurrent(old.id), false);
  assert.equal(await b.isCurrent(next.id), true);
  await a.disconnect();
  assert.equal(await b.isCurrent(next.id), false);
  assert.equal(await b.commit(next.id), false);
  assert.equal(await b.beginRemembered(), undefined);
  old.dispose();
  next.dispose();
  wipe(credentials);
  await store.lock();
});

test("disposed pending input cannot commit, and a failed replacement does not retain another account", async () => {
  const store = new InMemorySecretStore(),
    repository = new GhinCredentialRepository(store),
    credentials = input();
  const previous = await repository.begin(credentials, { remember: true });
  await repository.commit(previous.id);
  previous.dispose();
  const replacement = await repository.begin(
    {
      ...credentials,
      username: Buffer.from("synthetic-replacement@example.invalid"),
    },
    { remember: true },
  );
  replacement.dispose();
  assert.equal(await repository.commit(replacement.id), false);
  assert.equal(await repository.beginRemembered(), undefined);
  assert.equal((await repository.status()).connected, false);
  assert.equal(await repository.cancel(replacement.id), true);
  wipe(credentials);
  await store.lock();
});

test("input validation never stores malformed UTF-8, control characters, oversized or noncanonical inputs", async () => {
  const store = new InMemorySecretStore(),
    repository = new GhinCredentialRepository(store),
    original = input();
  const cases: CredentialInput[] = [
    { ...original, username: Buffer.alloc(321, 65) },
    { ...original, password: Buffer.alloc(1025, 65) },
    { ...original, password: Buffer.from([0xc3, 0x28]) },
    { ...original, password: Buffer.from("synthetic\u0085control") },
    { ...original, password: Buffer.from("synthetic\ncontrol") },
    { ...original, password: Buffer.alloc(0) },
    { ...original, ownGhinNumber: "090000001" },
    { ...original, accountType: "unknown" as "golfer" },
  ];
  for (const invalid of cases)
    await assert.rejects(
      repository.begin(invalid, { remember: false }),
      code("INVALID_INPUT"),
    );
  assert.equal(await raw(store), undefined);
  for (const candidate of cases) {
    if (candidate.username !== original.username) candidate.username.fill(0);
    if (candidate.password !== original.password) candidate.password.fill(0);
  }
  wipe(original);
  await store.lock();
});

test("repository and pending handles redact inspection; invalid encrypted records fail closed", async () => {
  const store = new InMemorySecretStore(),
    repository = new GhinCredentialRepository(store),
    credentials = input();
  const pending = await repository.begin(credentials, { remember: true });
  for (const output of [
    JSON.stringify(repository),
    inspect(repository),
    JSON.stringify(pending),
    inspect(pending),
    JSON.stringify(await repository.status()),
  ]) {
    assert(!output.includes(credentials.username.toString()));
    assert(!output.includes(credentials.password.toString()));
    assert(!output.includes(credentials.ownGhinNumber));
  }
  pending.dispose();
  await store.set("ghin-connection", Buffer.from("not-json"));
  await assert.rejects(
    repository.begin(credentials, { remember: true }),
    code("STORAGE_ERROR"),
  );
  assert.equal(await raw(store), "not-json");
  await assert.rejects(repository.status(), code("STORAGE_ERROR"));
  wipe(credentials);
  await store.lock();
});

test("atomic memory update wipes temporary buffers and rolls back invalid callbacks", async () => {
  const store = new InMemorySecretStore();
  await store.set("counter", Buffer.from("1"));
  let seen: Buffer | undefined, returned: Buffer | undefined;
  await store.update("counter", (current) => {
    seen = current;
    returned = Buffer.from("2");
    return returned;
  });
  assert(seen?.every((byte) => byte === 0));
  assert(returned?.every((byte) => byte === 0));
  await assert.rejects(
    store.update("counter", () => {
      throw new Error("synthetic failure");
    }),
  );
  await assert.rejects(
    store.update("counter", (() => ({ unexpected: true })) as any),
    code("INVALID_SECRET"),
  );
  const handle = await store.get("counter");
  assert(handle);
  const copy = handle.copy();
  assert.equal(copy.toString(), "2");
  copy.fill(0);
  handle.dispose();
  await store.lock();
  await assert.rejects(
    store.update("counter", () => Buffer.from("3")),
    code("VAULT_LOCKED"),
  );
});

test("encrypted credentials survive restart and a second vault instance disconnects the first safely", async () => {
  const f = await fixture(),
    credentials = input();
  let other: UnlockedProfile | undefined;
  try {
    const repository = await f.profile.withSecrets(
      async (store) => new GhinCredentialRepository(store),
    );
    const pending = await repository.begin(credentials, { remember: true });
    await repository.commit(pending.id);
    pending.dispose();
    const bytes = await readFile(join(f.directory, "vault.bin"));
    for (const marker of [
      credentials.username,
      credentials.password,
      Buffer.from(credentials.password.toString("base64")),
    ])
      assert.equal(bytes.includes(marker), false);
    other = await unlockProfile(f.directory, f.passphrase);
    const reopened = await other.withSecrets(
      async (store) => new GhinCredentialRepository(store),
    );
    const remembered = await reopened.beginRemembered();
    assert(remembered);
    assert.equal(await reopened.commit(remembered.id), true);
    await repository.disconnect();
    assert.equal(await reopened.isCurrent(remembered.id), false);
    assert.equal(await reopened.commit(remembered.id), false);
    assert.equal(await reopened.beginRemembered(), undefined);
    remembered.dispose();
    const rosterKey = f.profile.copyRosterKey();
    assert.equal(rosterKey.length, 32);
    rosterKey.fill(0);
    await f.profile.dispose();
    await assert.rejects(
      f.profile.withSecrets(async () => undefined),
      code("VAULT_LOCKED"),
    );
  } finally {
    await other?.dispose();
    wipe(credentials);
    await f.close();
  }
});

test("atomic encrypted updates coordinate independent vault instances and preserve failures", async () => {
  const f = await fixture();
  let other: EncryptedFileSecretStore | undefined;
  try {
    other = await EncryptedFileSecretStore.unlock(
      f.directory,
      f.profile.profileId,
      f.passphrase,
    );
    await f.profile.withSecrets(async (first) => {
      await first.set("counter", Buffer.from("0"));
      await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          (index % 2 ? first : other!).update("counter", (current) =>
            Buffer.from(String(Number(current!.toString()) + 1)),
          ),
        ),
      );
      await assert.rejects(
        other!.update("counter", () => {
          throw new Error("synthetic transaction failure");
        }),
      );
      const handle = await first.get("counter");
      assert(handle);
      const bytes = handle.copy();
      assert.equal(bytes.toString(), "12");
      bytes.fill(0);
      handle.dispose();
    });
  } finally {
    await other?.lock();
    await f.close();
  }
});

test("a pre-aborted private credential prompt cancels before requiring a terminal", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    readPrivateCredential("Private: ", controller.signal),
    code("INPUT_CANCELLED"),
  );
});

test("private credential prompt requires a controlling terminal and does not consume stdin", async () => {
  const url = new URL(
    "../src/desktop/private-credential-prompt.ts",
    import.meta.url,
  ).href;
  const script = `import {readPrivateCredential} from ${JSON.stringify(url)};try{await readPrivateCredential('Private: ');process.exitCode=2;}catch(error){process.stdout.write(error.code+'\\n');for await(const chunk of process.stdin)process.stdout.write(chunk);}`;
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { detached: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Private prompt test timed out"));
    }, 5000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end("synthetic-stdin-remains-unread\n");
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exit) => {
      clearTimeout(timer);
      exit === 0 ? resolve(stdout) : reject(new Error(stderr));
    });
  });
  assert.equal(
    output,
    "PRIVATE_INPUT_REQUIRED\nsynthetic-stdin-remains-unread\n",
  );
});
