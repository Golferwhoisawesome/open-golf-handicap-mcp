import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { shortTempRoot, privateDirectory } from "./support/temp.js";
import {
  hasPrivateAcl,
  restrictDirectoryAcl,
} from "../src/desktop/platform-security.js";
import {
  getRosterKeyLease,
  startRosterSession,
} from "../src/desktop/session-broker.js";
import { inspectProfile, initProfile } from "../src/desktop/profile.js";

const windowsOnly = process.platform === "win32" ? false : "Windows only";

test(
  "inherited ACLs are rejected and restricted ACLs accepted",
  { skip: windowsOnly },
  async () => {
    const root = await mkdtemp(join(await shortTempRoot(), "ogh-acl-"));
    try {
      const open = join(root, "inherited");
      await mkdir(open);
      assert.equal(await hasPrivateAcl(open), false);
      await restrictDirectoryAcl(open);
      assert.equal(await hasPrivateAcl(open), true);
      const created = join(root, "profile");
      await initProfile(created, Buffer.from("synthetic windows passphrase"));
      assert.equal((await inspectProfile(created)).initialized, true);
      assert.equal(await hasPrivateAcl(created), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "broker uses a randomly named pipe recorded in the private profile",
  { skip: windowsOnly },
  async () => {
    const root = await mkdtemp(join(await shortTempRoot(), "ogh-pipe-"));
    const profile = join(root, "profile");
    await privateDirectory(profile);
    const profileId = randomUUID(),
      key = randomBytes(32);
    const session = await startRosterSession({
      directory: profile,
      profileId,
      rosterDirectory: join(profile, "roster"),
      key,
      durationMs: 5000,
    });
    try {
      const recorded = (
        await readFile(join(profile, "session.pipe"), "utf8")
      ).trim();
      assert.match(recorded, /^\\\\\.\\pipe\\open-golf-handicap-[0-9a-f]{32}$/);
      const lease = await getRosterKeyLease(profile, profileId);
      assert.equal(lease.key.equals(key), true);
      lease.dispose();
      await assert.rejects(
        startRosterSession({
          directory: profile,
          profileId,
          rosterDirectory: join(profile, "roster"),
          key,
        }),
        { code: "CONFLICT" },
      );
    } finally {
      await session.close();
      key.fill(0);
    }
    await assert.rejects(stat(join(profile, "session.pipe")), {
      code: "ENOENT",
    });
    await rm(root, { recursive: true, force: true });
  },
);
