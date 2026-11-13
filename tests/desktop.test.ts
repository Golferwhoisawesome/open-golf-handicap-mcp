import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  realpath,
  rm,
  readdir,
  readFile,
  writeFile,
  chmod,
  copyFile,
  symlink,
  link,
  stat,
  mkdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initProfile,
  inspectProfile,
  unlockProfile,
} from "../src/desktop/profile.js";
import { EncryptedFileSecretStore } from "../src/desktop/encrypted-file-secret-store.js";
import {
  InMemorySecretStore,
  SecretHandle,
} from "../src/desktop/secret-store.js";
import { SyntheticSession } from "../src/desktop/synthetic-session.js";
import { publicDesktopError } from "../src/desktop/errors.js";
import { modeOf, posixOnly } from "./support/temp.js";
const pass = () => Buffer.from("synthetic vault passphrase only");
const code = (expected: string) => (error: unknown) =>
  (error as { code?: string })?.code === expected;
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "oghmcp-desktop-"));
  return { root, directory: join(root, "profile") };
}
test("missing desktop status is read-only and unlock does not create a profile", async () => {
  const f = await fixture();
  try {
    assert.equal((await inspectProfile(f.directory)).initialized, false);
    assert.deepEqual(await readdir(f.root), []);
    await assert.rejects(
      unlockProfile(f.directory, pass()),
      code("PROFILE_MISSING"),
    );
    assert.deepEqual(await readdir(f.root), []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("private profile keeps the roster key encrypted, reopens and disposes with redacted inspection", async () => {
  const f = await fixture();
  try {
    const status = await initProfile(f.directory, pass());
    assert.equal(status.initialized, true);
    assert.equal(status.osCredentialStore, "not-implemented");
    const first = await unlockProfile(f.directory, pass()),
      key = first.copyRosterKey();
    assert.equal(key.length, 32);
    assert.equal(
      first.rosterDirectory,
      join(await realpath(f.directory), "roster"),
    );
    const profile = await readFile(join(f.directory, "profile.json")),
      vault = await readFile(join(f.directory, "vault.bin"));
    for (const bytes of [profile, vault]) {
      assert.equal(bytes.includes(pass()), false);
      assert.equal(bytes.includes(key), false);
      assert.equal(bytes.includes(Buffer.from(key.toString("hex"))), false);
    }
    assert.equal(JSON.stringify(first).includes(key.toString("hex")), false);
    assert.equal(inspect(first).includes(key.toString("hex")), false);
    assert.equal(await modeOf(f.directory, 0o700), 0o700);
    assert.equal(await modeOf(join(f.directory, "roster"), 0o700), 0o700);
    for (const name of ["profile.json", "vault.bin"])
      assert.equal(await modeOf(join(f.directory, name), 0o600), 0o600);
    await first.dispose();
    assert.throws(() => first.copyRosterKey(), code("VAULT_LOCKED"));
    await first.dispose();
    const reopened = await unlockProfile(f.directory, pass());
    const copy = reopened.copyRosterKey();
    assert.deepEqual(copy, key);
    copy.fill(0);
    key.fill(0);
    await reopened.dispose();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("wrong passphrase and envelope tampering never replace or repair existing data", async () => {
  const f = await fixture();
  try {
    await initProfile(f.directory, pass());
    const path = join(f.directory, "vault.bin"),
      original = await readFile(path);
    await assert.rejects(
      unlockProfile(f.directory, Buffer.from("wrong synthetic passphrase")),
      code("VAULT_INVALID"),
    );
    assert.deepEqual(await readFile(path), original);
    for (const offset of [0, 8, 24, 36, original.length - 1]) {
      const changed = Buffer.from(original);
      changed[offset] = changed[offset]! ^ 1;
      await writeFile(path, changed);
      await assert.rejects(unlockProfile(f.directory, pass()));
      assert.deepEqual(await readFile(path), changed);
    }
    await assert.rejects(
      initProfile(f.directory, pass()),
      code("PROFILE_EXISTS"),
    );
    assert.notDeepEqual(await readFile(path), original);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("profile identity is authenticated and vault swapping fails", async () => {
  const f = await fixture();
  try {
    const other = join(f.root, "other");
    await initProfile(f.directory, pass());
    await initProfile(other, pass());
    await copyFile(join(f.directory, "vault.bin"), join(other, "vault.bin"));
    await assert.rejects(unlockProfile(other, pass()), code("VAULT_INVALID"));
    const profilePath = join(f.directory, "profile.json"),
      profile = JSON.parse(await readFile(profilePath, "utf8"));
    profile.profileId = "00000000-0000-4000-8000-000000000000";
    await writeFile(profilePath, JSON.stringify(profile));
    await assert.rejects(
      unlockProfile(f.directory, pass()),
      code("VAULT_INVALID"),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test(
  "unsafe permissions, symlinks and hardlinks fail closed",
  { skip: posixOnly },
  async () => {
    const f = await fixture();
    try {
      await initProfile(f.directory, pass());
      const path = join(f.directory, "vault.bin");
      await chmod(path, 0o644);
      await assert.rejects(
        unlockProfile(f.directory, pass()),
        code("PROFILE_INVALID"),
      );
      await chmod(path, 0o600);
      const alias = join(f.root, "alias");
      await symlink(f.directory, alias);
      await assert.rejects(inspectProfile(alias), code("PROFILE_INVALID"));
      const duplicate = join(f.directory, "duplicate.bin");
      await link(path, duplicate);
      await assert.rejects(
        unlockProfile(f.directory, pass()),
        code("PROFILE_INVALID"),
      );
      await rm(duplicate);
      await chmod(f.directory, 0o755);
      await assert.rejects(
        inspectProfile(f.directory),
        code("PROFILE_INVALID"),
      );
      await chmod(f.directory, 0o700);
      await rm(path);
      await symlink("missing-target", path);
      await assert.rejects(
        unlockProfile(f.directory, pass()),
        code("PROFILE_INVALID"),
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);
test("partial initialization is preserved and concurrent init has exactly one winner", async () => {
  const f = await fixture();
  try {
    const attempts = await Promise.allSettled([
      initProfile(f.directory, pass()),
      initProfile(f.directory, pass()),
    ]);
    assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await inspectProfile(f.directory)).initialized, true);
    const partial = join(f.root, "partial");
    await mkdir(partial, { mode: 0o700 });
    const marker = Buffer.from("synthetic partial data");
    await writeFile(join(partial, "vault.bin"), marker, { mode: 0o600 });
    await assert.rejects(inspectProfile(partial), code("PROFILE_INVALID"));
    await assert.rejects(initProfile(partial, pass()), code("PROFILE_EXISTS"));
    assert.deepEqual(await readFile(join(partial, "vault.bin")), marker);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("synthetic sessions expire, revoke and lock without accepting real provider credentials", async () => {
  let now = 100;
  const store = new InMemorySecretStore(() => now),
    session = new SyntheticSession(store),
    token = Buffer.from("synthetic-session:demo");
  await assert.rejects(
    session.connect(Buffer.from("unmarked credential"), 200),
    code("INVALID_SECRET"),
  );
  await session.connect(token, 200);
  token.fill(0);
  assert.equal((await session.status()).authenticated, true);
  const handle = await store.get("synthetic-session");
  assert.ok(handle);
  assert.equal(JSON.stringify(handle).includes("demo"), false);
  assert.equal(inspect(store).includes("demo"), false);
  now = 200;
  assert.equal((await session.status()).authenticated, false);
  assert.throws(() => handle.copy(), code("VAULT_LOCKED"));
  assert.equal((await store.status()).expiredCount, 1);
  await session.connect(Buffer.from("synthetic-session:new"), 300);
  const second = await store.get("synthetic-session");
  await session.disconnect();
  assert.equal((await session.status()).authenticated, false);
  assert.throws(() => second!.copy(), code("VAULT_LOCKED"));
  await store.lock();
  await store.lock();
  await assert.rejects(store.get("synthetic-session"), code("VAULT_LOCKED"));
  assert.equal((await store.status()).locked, true);
});
test("encrypted-store revocation survives stale instances, reopen and expiration", async () => {
  const f = await fixture();
  let a: EncryptedFileSecretStore | undefined,
    b: EncryptedFileSecretStore | undefined;
  try {
    const profile = await initProfile(f.directory, pass());
    let now = 100;
    a = await EncryptedFileSecretStore.unlock(
      f.directory,
      profile.profileId!,
      pass(),
      () => now,
    );
    b = await EncryptedFileSecretStore.unlock(
      f.directory,
      profile.profileId!,
      pass(),
      () => now,
    );
    await a.set("synthetic-session", Buffer.from("synthetic-session:private"), {
      expiresAt: 200,
    });
    const handle = await a.get("synthetic-session");
    assert.ok(handle);
    const copied = handle.copy();
    copied.fill(0);
    assert.equal(
      (await a.get("synthetic-session"))!.copy().toString(),
      "synthetic-session:private",
    );
    await a.revoke("synthetic-session");
    await b.set("another-synthetic", Buffer.from("synthetic:other"));
    assert.equal(await b.get("synthetic-session"), undefined);
    assert.throws(() => handle.copy(), code("VAULT_LOCKED"));
    await b.set("expired", Buffer.from("synthetic:expires"), {
      expiresAt: 200,
    });
    now = 200;
    assert.equal(await a.get("expired"), undefined);
    assert.equal((await a.status()).expiredCount, 1);
    const bytes = await readFile(join(f.directory, "vault.bin"));
    assert.equal(bytes.includes(Buffer.from("synthetic:other")), false);
    await a.lock();
    await assert.rejects(
      a.set("locked", Buffer.from("synthetic:value")),
      code("VAULT_LOCKED"),
    );
    assert.equal((await a.status()).locked, true);
  } finally {
    await a?.lock();
    await b?.lock();
    await rm(f.root, { recursive: true, force: true });
  }
});
test("public desktop errors redact arbitrary exception messages", () => {
  const marker = "synthetic-sensitive-marker";
  const output = JSON.stringify(publicDesktopError(new Error(marker)));
  assert.equal(output.includes(marker), false);
  assert.equal(JSON.parse(output).code, "VAULT_INVALID");
});
test("secret disposal deregisters exactly once and prevents future copies", () => {
  let disposals = 0;
  const handle = new SecretHandle(
    Buffer.from("synthetic:disposable"),
    null,
    Date.now,
    () => {
      disposals++;
    },
  );
  handle.dispose();
  handle.dispose();
  assert.equal(disposals, 1);
  assert.throws(() => handle.copy(), code("VAULT_LOCKED"));
});
test("private prompt fails closed without a controlling terminal and does not consume MCP stdin", async () => {
  const url = new URL("../src/desktop/private-prompt.ts", import.meta.url).href;
  const script = `import {readHiddenPassphrase} from ${JSON.stringify(url)};try{await readHiddenPassphrase('Private: ');process.exitCode=2;}catch(error){process.stdout.write(error.code);}`;
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { detached: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end("synthetic-do-not-read-stdin\n");
    child.on("error", reject);
    child.on("exit", (exit) =>
      exit === 0 ? resolve(stdout) : reject(new Error(stderr)),
    );
  });
  assert.equal(output, "PRIVATE_INPUT_REQUIRED");
});
