import test from "node:test";
import assert from "node:assert/strict";
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
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { MockRosterStorage } from "../src/storage/mock-roster-storage.js";
import { LocalRosterStorage } from "../src/storage/local-roster-storage.js";
import { GoogleDriveRosterStorage } from "../src/storage/google-drive-roster-storage.js";
import type { Roster, SavedGolfer } from "../src/domain/models.js";
import { modeOf, posixOnly, privateTemp } from "./support/temp.js";
const golfer = (): SavedGolfer => ({
  id: "demo",
  name: "Synthetic Only Golfer",
  ghinNumber: "900000001",
  notes: "Private synthetic note",
  createdAt: "2026-10-29T00:00:00.000Z",
  modifiedAt: "2026-10-29T00:00:00.000Z",
  lastCheckedAt: null,
  lastAttemptAt: null,
  handicap: null,
  lastError: null,
});
const errorCode = (code: string) => (error: unknown) =>
  (error as { code?: string })?.code === code;
async function fixture() {
  const directory = await privateTemp(
      join(await realpath(tmpdir()), "oghmcp-storage-"),
    ),
    key = randomBytes(32);
  return { directory, key, storage: new LocalRosterStorage(directory, key) };
}
test("mock isolates owners, rolls back failures, clones reads and increments once", async () => {
  const s = new MockRosterStorage();
  let retained: Roster | undefined;
  await s.transact("alice", (r) => {
    r.golfers.push(golfer());
    r.revision = 123;
    retained = r;
  });
  retained!.golfers[0]!.name = "Changed outside transaction";
  assert.equal((await s.read("alice")).revision, 1);
  assert.equal(
    (await s.read("alice")).golfers[0]!.name,
    "Synthetic Only Golfer",
  );
  assert.equal((await s.read("bob")).golfers.length, 0);
  const copy = await s.read("alice");
  copy.golfers = [];
  assert.equal((await s.read("alice")).golfers.length, 1);
  await assert.rejects(
    s.transact("alice", (r) => {
      r.golfers = [];
      throw new Error("rollback");
    }),
    /rollback/,
  );
  assert.equal((await s.read("alice")).revision, 1);
  await Promise.all(
    Array.from({ length: 30 }, () =>
      s.transact("alice", async () => {
        await Promise.resolve();
      }),
    ),
  );
  assert.equal((await s.read("alice")).revision, 31);
  await s.delete("alice");
  assert.equal((await s.read("alice")).revision, 0);
});
test("local encrypts data, persists and retains strict permissions", async () => {
  const f = await fixture();
  try {
    await f.storage.transact("alice", (r) => {
      r.golfers.push(golfer());
    });
    const files = await readdir(f.directory);
    assert.equal(files.length, 1);
    const path = join(f.directory, files[0]!),
      bytes = await readFile(path);
    for (const text of [
      "Synthetic Only Golfer",
      "900000001",
      "Private synthetic note",
    ])
      assert.equal(bytes.includes(Buffer.from(text)), false);
    assert.equal(await modeOf(f.directory, 0o700), 0o700);
    assert.equal(await modeOf(path, 0o600), 0o600);
    const reopened = new LocalRosterStorage(f.directory, f.key);
    assert.equal(
      (await reopened.read("alice")).golfers[0]!.name,
      "Synthetic Only Golfer",
    );
    assert.equal((await reopened.read("bob")).golfers.length, 0);
    await assert.rejects(
      reopened.transact("alice", (r) => {
        r.golfers = [];
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.deepEqual(await readFile(path), bytes);
    await f.storage.delete("alice");
    assert.equal((await readdir(f.directory)).length, 0);
    assert.equal((await reopened.read("alice")).golfers.length, 0);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
test("wrong key, corruption and ciphertext copied to another owner fail closed", async () => {
  const f = await fixture();
  try {
    await f.storage.transact("alice", (r) => {
      r.golfers.push(golfer());
    });
    const alice = (await readdir(f.directory))[0]!;
    await assert.rejects(
      new LocalRosterStorage(f.directory, randomBytes(32)).read("alice"),
      errorCode("STORAGE_ERROR"),
    );
    await f.storage.transact("bob", () => {});
    const bob = (await readdir(f.directory)).find((p) => p !== alice)!;
    await copyFile(join(f.directory, alice), join(f.directory, bob));
    await assert.rejects(f.storage.read("bob"), errorCode("STORAGE_ERROR"));
    const bytes = await readFile(join(f.directory, alice));
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(join(f.directory, alice), bytes);
    await assert.rejects(f.storage.read("alice"), errorCode("STORAGE_ERROR"));
    assert.deepEqual(
      (await readdir(f.directory)).filter((p) => p.endsWith(".lock")),
      [],
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
test("two local instances serialize and roll back invalid roster data", async () => {
  const f = await fixture();
  try {
    const other = new LocalRosterStorage(f.directory, f.key);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? other : f.storage).transact("alice", async () => {
          await new Promise((r) => setTimeout(r, 2));
        }),
      ),
    );
    assert.equal((await f.storage.read("alice")).revision, 20);
    await assert.rejects(
      f.storage.transact("alice", (r) => {
        r.schemaVersion = 2 as 1;
      }),
      errorCode("STORAGE_ERROR"),
    );
    assert.equal((await other.read("alice")).revision, 20);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
test(
  "local rejects file and directory symlinks and permissive storage roots",
  { skip: posixOnly },
  async () => {
    const f = await fixture();
    try {
      await f.storage.transact("alice", () => {});
      const name = (await readdir(f.directory))[0]!,
        path = join(f.directory, name);
      await rm(path);
      await symlink("missing-target", path);
      await assert.rejects(f.storage.read("alice"), errorCode("STORAGE_ERROR"));
      const alias = f.directory + "-alias";
      await symlink(f.directory, alias);
      try {
        await assert.rejects(
          new LocalRosterStorage(alias, f.key).read("alice"),
          errorCode("STORAGE_ERROR"),
        );
      } finally {
        await rm(alias);
      }
      await chmod(f.directory, 0o755);
      await assert.rejects(f.storage.read("bob"), errorCode("STORAGE_ERROR"));
      await chmod(f.directory, 0o700);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
test("independent processes use the same filesystem transaction lock", async () => {
  const f = await fixture();
  try {
    const moduleUrl = new URL(
      "../src/storage/local-roster-storage.ts",
      import.meta.url,
    ).href;
    const code = `import {LocalRosterStorage} from ${JSON.stringify(moduleUrl)};const s=new LocalRosterStorage(process.argv[1],Buffer.from(process.env.SYNTHETIC_TEST_STORAGE_KEY,'hex'));for(let i=0;i<8;i++)await s.transact('shared',async()=>{await new Promise(r=>setTimeout(r,5));});`;
    const run = () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", code, f.directory],
          {
            env: {
              ...process.env,
              SYNTHETIC_TEST_STORAGE_KEY: f.key.toString("hex"),
            },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        let errors = "";
        child.stderr.on("data", (b) => {
          errors += b;
        });
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(errors)),
        );
      });
    await Promise.all([run(), run()]);
    assert.equal((await f.storage.read("shared")).revision, 16);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
test("stale lock fails after bounded wait without stealing it; oversized data is rejected", async () => {
  const f = await fixture();
  try {
    await f.storage.transact("alice", () => {});
    const filename = (await readdir(f.directory))[0]!,
      lock = join(f.directory, filename.replace(".roster", ".lock"));
    await writeFile(lock, "", { mode: 0o600 });
    await assert.rejects(f.storage.read("alice"), errorCode("CONFLICT"));
    assert.ok(await stat(lock));
    await rm(lock);
    await writeFile(join(f.directory, filename), Buffer.alloc(6 * 1024 * 1024));
    await assert.rejects(f.storage.read("alice"), errorCode("STORAGE_ERROR"));
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
test("Google Drive extension fails closed and never invokes a callback", async () => {
  const s = new GoogleDriveRosterStorage();
  let called = false;
  await assert.rejects(s.read("alice"), errorCode("UNSUPPORTED"));
  await assert.rejects(
    s.transact("alice", () => {
      called = true;
    }),
    errorCode("UNSUPPORTED"),
  );
  assert.equal(called, false);
  await assert.rejects(s.delete("alice"), errorCode("UNSUPPORTED"));
});
