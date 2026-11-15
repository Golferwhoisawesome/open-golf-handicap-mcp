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
import { ensureProfileDirectory } from "../src/desktop/local-profile.js";

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
      await ensureProfileDirectory(created);
      assert.equal(await hasPrivateAcl(created), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
