import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  lstat,
  rm,
  symlink,
  writeFile,
  readFile,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  startRosterSession,
  getRosterKeyLease,
  lockRosterSession,
  watchRosterSession,
  requestRosterProvider,
} from "../src/desktop/session-broker.js";
import { AppError } from "../src/domain/errors.js";
import {
  shortTempRoot,
  privateDirectory,
  posix,
  posixOnly,
  privateTemp,
} from "./support/temp.js";

test("pending disconnect reports persistence success or failure before sign-in shutdown closes its socket", async () => {
  for (const fail of [false, true]) {
    const directory = await privateTemp(
      join(await shortTempRoot(), "ogh-disconnect-"),
    );
    const key = randomBytes(32),
      profileId = randomUUID();
    let session: Awaited<ReturnType<typeof startRosterSession>>;
    let persisted = false;
    session = await startRosterSession({
      directory,
      profileId,
      rosterDirectory: join(directory, "roster"),
      key,
      onDisconnectPending: async () => {
        void session.close();
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (fail)
          throw new AppError("STORAGE_ERROR", "Synthetic deletion failure.");
        persisted = true;
      },
    });
    try {
      const lease = await getRosterKeyLease(directory, profileId);
      lease.dispose();
      const response = requestRosterProvider(
        directory,
        profileId,
        lease.sessionId,
        "disconnect",
      );
      if (fail) await assert.rejects(response, { code: "STORAGE_ERROR" });
      else assert.deepEqual(await response, { disconnected: true });
      assert.equal(persisted, !fail);
      await session.closed;
    } finally {
      await session.close();
      key.fill(0);
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("private session leases bind profile, expire, notify active clients and never persist a key", async () => {
  const root = await mkdtemp(join(await shortTempRoot(), "ogh-session-"));
  const profile = join(root, "profile");
  await privateDirectory(profile);
  const key = randomBytes(32),
    profileId = randomUUID();
  const session = await startRosterSession({
    directory: profile,
    profileId,
    rosterDirectory: join(profile, "roster"),
    key,
    durationMs: 2000,
  });
  try {
    if (posix)
      assert.equal(
        (await lstat(join(profile, "session.sock"))).mode & 0o777,
        0o600,
      );
    const lease = await getRosterKeyLease(profile, profileId);
    assert.deepEqual(lease.key, key);
    lease.dispose();
    assert(lease.key.every((byte) => byte === 0));
    await assert.rejects(getRosterKeyLease(profile, "another-owner"), {
      code: "AUTH_REQUIRED",
    });
    await assert.rejects(
      startRosterSession({
        directory: profile,
        profileId,
        rosterDirectory: join(profile, "roster"),
        key,
      }),
      { code: "CONFLICT" },
    );
    let locked!: () => void;
    const notification = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const watcher = await watchRosterSession(profile, profileId, locked);
    assert.equal(watcher.sessionId, lease.sessionId);
    await lockRosterSession(profile, profileId);
    await notification;
    await session.closed;
    watcher.close();
    await assert.rejects(getRosterKeyLease(profile, profileId), {
      code: "AUTH_REQUIRED",
    });
    await assert.rejects(lstat(join(profile, "session.sock")), {
      code: "ENOENT",
    });
  } finally {
    await session.close();
    key.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});

test("persistent watchers cannot occupy the capacity reserved for locking", async () => {
  const root = await mkdtemp(join(await shortTempRoot(), "ogh-session-"));
  const profile = join(root, "profile");
  await privateDirectory(profile);
  const profileId = randomUUID(),
    key = randomBytes(32);
  const session = await startRosterSession({
    directory: profile,
    profileId,
    rosterDirectory: join(profile, "roster"),
    key,
  });
  const watchers: Array<{ close(): void }> = [];
  try {
    for (let i = 0; i < 16; i++)
      watchers.push(await watchRosterSession(profile, profileId, () => {}));
    await assert.rejects(
      watchRosterSession(profile, profileId, () => {}),
      { code: "AUTH_REQUIRED" },
    );
    await lockRosterSession(profile, profileId);
    await session.closed;
    const next = await startRosterSession({
      directory: profile,
      profileId,
      rosterDirectory: join(profile, "roster"),
      key,
    });
    await next.close();
  } finally {
    for (const watcher of watchers) watcher.close();
    await session.close();
    key.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "session TTL stops new leases; stale files and symlink profiles fail closed",
  { skip: posixOnly },
  async () => {
    const root = await mkdtemp(join(await shortTempRoot(), "ogh-session-"));
    const profile = join(root, "profile");
    await privateDirectory(profile);
    const profileId = randomUUID(),
      key = randomBytes(32);
    const session = await startRosterSession({
      directory: profile,
      profileId,
      rosterDirectory: join(profile, "roster"),
      key,
      durationMs: 100,
    });
    try {
      await session.closed;
      await assert.rejects(getRosterKeyLease(profile, profileId), {
        code: "AUTH_REQUIRED",
      });
      await writeFile(join(profile, "session.sock"), "keep", { mode: 0o600 });
      await assert.rejects(
        startRosterSession({
          directory: profile,
          profileId,
          rosterDirectory: join(profile, "roster"),
          key,
        }),
        { code: "CONFLICT" },
      );
      assert.equal(
        await readFile(join(profile, "session.sock"), "utf8"),
        "keep",
      );
      const link = join(root, "link");
      await symlink(profile, link);
      await assert.rejects(getRosterKeyLease(link, profileId), {
        code: "AUTH_REQUIRED",
      });
    } finally {
      await session.close();
      key.fill(0);
      await rm(root, { recursive: true, force: true });
    }
  },
);
