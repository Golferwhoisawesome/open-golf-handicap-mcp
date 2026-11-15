import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { shortTempRoot } from "./support/temp.js";
import { AppError } from "../src/domain/errors.js";
import { PrivateFileStore } from "../src/desktop/credential-store.js";
import {
  ensureProfileDirectory,
  loadSecrets,
  newRosterKey,
  ProfileStateStore,
  saveSecrets,
  type GhinLogin,
} from "../src/desktop/local-profile.js";
import { GhinUsageRepository } from "../src/desktop/ghin-usage.js";
import { saveVerifiedLogin } from "../src/desktop/setup-cli.js";
import { OnDemandGhinProvider } from "../src/providers/on-demand-ghin-provider.js";
import type { SdkFixtureScenario } from "../src/providers/spicygolf-sdk-fixtures.js";

const owner = { subject: "local-owner" };
const fileStore = { OGH_CREDENTIAL_STORE: "file" };
const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;
const login = (mode: GhinLogin["mode"] = "offline-test"): GhinLogin => ({
  username: Buffer.from("synthetic-user@example.invalid"),
  password: Buffer.from("synthetic-password-only"),
  ownGhinNumber: "900000001",
  accountType: "api",
  mode,
});
async function profile() {
  const root = await mkdtemp(join(await shortTempRoot(), "ogh-login-"));
  return { root, directory: join(root, "profile") };
}
function provider(
  directory: string,
  options: {
    mode?: GhinLogin["mode"];
    scenario?: SdkFixtureScenario;
    saved?: () => GhinLogin | undefined;
  } = {},
) {
  const mode = options.mode ?? "offline-test";
  const usage = new GhinUsageRepository(new ProfileStateStore(directory), mode);
  return {
    usage,
    provider: new OnDemandGhinProvider({
      ownerSubject: owner.subject,
      mode,
      usage,
      loadLogin: async () => (options.saved ?? (() => login(mode)))(),
      ...(options.scenario
        ? { sessionOptions: { fixtureScenario: options.scenario } }
        : {}),
    }),
  };
}

test("saved secrets round-trip through an owner-only store; logout keeps the roster key", async () => {
  const f = await profile();
  try {
    const directory = await ensureProfileDirectory(f.directory);
    const store = new PrivateFileStore(directory);
    const key = newRosterKey();
    await saveSecrets(store, { rosterKey: key, login: login() });
    const raw = await readFile(join(directory, "credentials.json"), "utf8");
    assert.equal(raw.includes("synthetic-password-only"), false);
    const loaded = await loadSecrets(store);
    assert(loaded?.rosterKey.equals(key));
    assert.equal(loaded?.login?.password.toString(), "synthetic-password-only");
    assert.equal(JSON.stringify(loaded?.login).includes("synthetic"), false);
    await saveSecrets(store, { rosterKey: loaded!.rosterKey });
    const after = await loadSecrets(store);
    assert.equal(after?.login, undefined);
    assert(after?.rosterKey.equals(key));
    assert.equal(await store.remove(), true);
    assert.equal(await loadSecrets(store), undefined);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("login verifies with GHIN before saving, and a rejected login saves nothing", async () => {
  const f = await profile();
  try {
    await assert.rejects(
      saveVerifiedLogin({
        directory: f.directory,
        login: login(),
        env: fileStore,
        sessionOptions: { fixtureScenario: "auth-denied" },
      }),
      code("AUTH_REQUIRED"),
    );
    const store = new PrivateFileStore(f.directory);
    assert.equal(await loadSecrets(store), undefined);
    const result = await saveVerifiedLogin({
      directory: f.directory,
      login: login(),
      env: fileStore,
    });
    assert.equal(result.loggedIn, true);
    const saved = await loadSecrets(store);
    assert.equal(saved?.login?.ownGhinNumber, "900000001");
    // A second login keeps the same roster key, so the roster stays readable.
    const key = Buffer.from(saved!.rosterKey);
    await saveVerifiedLogin({
      directory: f.directory,
      login: login(),
      env: fileStore,
    });
    assert((await loadSecrets(store))?.rosterKey.equals(key));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("live login requires the acknowledgment before any network request", async () => {
  const f = await profile();
  try {
    const live = {
      ...login("ghin"),
      username: Buffer.from("someone@example.com"),
    };
    await assert.rejects(
      saveVerifiedLogin({
        directory: f.directory,
        login: live,
        env: fileStore,
      }),
      code("AUTH_REQUIRED"),
    );
    const directory = await ensureProfileDirectory(f.directory);
    const { provider: live2, usage } = provider(directory, {
      mode: "ghin",
      saved: () => live,
    });
    await assert.rejects(
      live2.getMany(owner, ["1234567"]),
      code("AUTH_REQUIRED"),
    );
    const state = await usage.allowance();
    assert.equal(state.acknowledged, false);
    await live2.close();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("provider signs in only when a lookup needs it and reuses the session", async () => {
  const f = await profile();
  try {
    const directory = await ensureProfileDirectory(f.directory);
    const { provider: active, usage } = provider(directory);
    try {
      const before = await active.getConnectionState(owner);
      assert.equal(before.authenticated, false);
      assert.equal(before.credentialsStored, true);
      assert.equal((await usage.allowance()).login, 10);
      const first = await active.getMany(owner, ["900000002", "900000005"]);
      assert.deepEqual(
        first.map((row) => row.ok && row.data.handicapIndex),
        [8.7, -0.9],
      );
      await active.getMany(owner, ["900000003"]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const used = await usage.allowance();
      assert.equal(used.login, 9, "exactly one sign-in");
      assert.equal(used.search, 200 - 3, "validation plus two lookups");
      assert.equal(
        (await active.getConnectionState(owner)).authenticated,
        true,
      );
    } finally {
      await active.close();
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a rejected login is not retried until the saved login changes", async () => {
  const f = await profile();
  try {
    const directory = await ensureProfileDirectory(f.directory);
    let current = login();
    const { provider: active, usage } = provider(directory, {
      scenario: "auth-denied",
      saved: () => ({
        ...current,
        username: Buffer.from(current.username),
        password: Buffer.from(current.password),
      }),
    });
    try {
      await assert.rejects(
        active.getMany(owner, ["900000002"]),
        code("AUTH_REQUIRED"),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      const afterFirst = (await usage.allowance()).login;
      await assert.rejects(
        active.getMany(owner, ["900000002"]),
        code("AUTH_REQUIRED"),
      );
      assert.equal((await usage.allowance()).login, afterFirst, "no retry");
      current = { ...login(), password: Buffer.from("synthetic-password-new") };
      await assert.rejects(
        active.getMany(owner, ["900000002"]),
        code("AUTH_REQUIRED"),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(
        (await usage.allowance()).login,
        afterFirst - 1,
        "a changed login is tried once",
      );
    } finally {
      await active.close();
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("persisted cooldowns and GHIN refusals block sign-in without network", async () => {
  const f = await profile();
  try {
    const directory = await ensureProfileDirectory(f.directory);
    const { provider: limited, usage } = provider(directory);
    await usage.record({ at: Date.now(), cooldownUntil: Date.now() + 60_000 });
    await assert.rejects(
      limited.getMany(owner, ["900000002"]),
      code("RATE_LIMITED"),
    );
    assert.equal((await usage.allowance()).login, 10);
    await limited.close();
    const other = await ensureProfileDirectory(join(f.root, "refused"));
    const { provider: refused, usage: refusedUsage } = provider(other);
    await refusedUsage.record({ at: Date.now(), forbidden: true });
    await assert.rejects(
      refused.getMany(owner, ["900000002"]),
      code("FORBIDDEN"),
    );
    await refused.close();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("disconnect ends the session and blocks further lookups in this process", async () => {
  const f = await profile();
  try {
    const directory = await ensureProfileDirectory(f.directory);
    const { provider: active } = provider(directory);
    await active.getMany(owner, ["900000002"]);
    await active.disconnect(owner);
    const state = await active.getConnectionState(owner);
    assert.equal(state.connected, false);
    assert.equal(
      state.credentialsStored,
      true,
      "logout, not disconnect, removes it",
    );
    await assert.rejects(
      active.getMany(owner, ["900000002"]),
      code("AUTH_REQUIRED"),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

async function stdioClient(args: string[], env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server/stdio.ts", ...args],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...env,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "login-test", version: "1" });
  await client.connect(transport, { timeout: 60_000 });
  return client;
}
async function call(client: Client, name: string, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return result.structuredContent as {
    ok: boolean;
    data?: any;
    error?: { code: string };
  };
}

test(
  "the MCP server uses a saved login without any open terminal, and persists the roster",
  { timeout: 90_000 },
  async () => {
    const f = await profile();
    try {
      await saveVerifiedLogin({
        directory: f.directory,
        login: login(),
        env: fileStore,
      });
      const first = await stdioClient(["--profile", f.directory], fileStore);
      try {
        const status = await call(first, "get_connection_status");
        assert.equal(status.data.provider, "spicygolf-sdk-offline");
        assert.equal(status.data.credentialsStored, true);
        const lookup = await call(first, "get_golfer_handicap", {
          ghinNumber: "900000002",
        });
        assert.equal(lookup.ok, true);
        assert.equal(lookup.data.result.ok, true);
        assert.equal(lookup.data.result.data.handicapIndex, 8.7);
        assert.equal(lookup.data.result.data.synthetic, true);
        const mine = await call(first, "get_golfer_handicap", {});
        assert.equal(mine.ok, true, "no number means the user's own");
        assert.equal(mine.data.result.data.ghinNumber, "900000001");
        assert.equal(mine.data.result.data.handicapIndex, 12.4);
        const statusNumber = await call(first, "get_connection_status");
        assert.equal(statusNumber.data.yourGhinNumber, "900000001");
        const saved = await call(first, "save_golfer", {
          name: "Synthetic Golfer",
          ghinNumber: "900000002",
        });
        assert.equal(saved.ok, true);
      } finally {
        await first.close();
      }
      const second = await stdioClient(["--profile", f.directory], fileStore);
      try {
        const roster = await call(second, "get_saved_golfers");
        assert.equal(roster.ok, true);
        assert.equal(
          JSON.stringify(roster.data).includes("Synthetic Golfer"),
          true,
        );
      } finally {
        await second.close();
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "without a saved login the server starts in demo mode",
  { timeout: 60_000 },
  async () => {
    const f = await profile();
    try {
      const client = await stdioClient(["--profile", f.directory], fileStore);
      try {
        const status = await call(client, "get_connection_status");
        assert.equal(status.data.provider, "mock");
        assert.equal(status.data.liveAccessEnabled, false);
        assert.match(
          status.data.limitations.join(" "),
          /open-golf-handicap-setup login/,
        );
      } finally {
        await client.close();
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test("the GHIN number is optional: login verifies the sign-in alone and lookups still work", async () => {
  const f = await profile();
  try {
    const { ownGhinNumber: _omit, ...withoutNumber } = login();
    await saveVerifiedLogin({
      directory: f.directory,
      login: withoutNumber,
      env: fileStore,
    });
    const directory = await ensureProfileDirectory(f.directory);
    const usage = new GhinUsageRepository(
      new ProfileStateStore(directory),
      "offline-test",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterLogin = await usage.allowance();
    assert.equal(afterLogin.login, 9, "one sign-in");
    assert.equal(afterLogin.search, 200, "no lookup without a number");
    const saved = await loadSecrets(new PrivateFileStore(directory));
    assert.equal(saved?.login?.ownGhinNumber, undefined);
    const { provider: active } = provider(directory, {
      saved: () => ({
        ...withoutNumber,
        username: Buffer.from(withoutNumber.username),
        password: Buffer.from(withoutNumber.password),
      }),
    });
    try {
      const state = await active.getConnectionState(owner);
      assert.equal(state.ownGhinNumber, null);
      const rows = await active.getMany(owner, ["900000005"]);
      assert.equal(rows[0]!.ok && rows[0]!.data.handicapIndex, -0.9);
    } finally {
      await active.close();
    }
    const { provider: withNumber } = provider(directory);
    assert.equal(
      (await withNumber.getConnectionState(owner)).ownGhinNumber,
      "900000001",
    );
    await withNumber.close();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a golfer login saves the GHIN number reported by GHIN's sign-in, without asking", async () => {
  const f = await profile();
  try {
    const { ownGhinNumber: _omit, ...withoutNumber } = login();
    const result = await saveVerifiedLogin({
      directory: f.directory,
      login: { ...withoutNumber, accountType: "golfer" },
      env: fileStore,
    });
    assert.equal(result.ghinNumber, "900000001");
    const saved = await loadSecrets(new PrivateFileStore(f.directory));
    assert.equal(saved?.login?.ownGhinNumber, "900000001");
    const usage = await new GhinUsageRepository(
      new ProfileStateStore(await ensureProfileDirectory(f.directory)),
      "offline-test",
    ).allowance();
    assert.equal(usage.search, 200, "sign-in alone; no lookup");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("name search returns identity, club, state and index only", async () => {
  const f = await profile();
  try {
    const directory = await ensureProfileDirectory(f.directory);
    const { provider: active, usage } = provider(directory);
    try {
      const matches = await active.searchByName!(owner, {
        firstName: "Synthetic",
        lastName: "SDK",
        state: "NC",
      });
      assert.equal(matches.length, 5);
      assert.deepEqual(matches[4], {
        ghinNumber: "900000005",
        name: "Synthetic SDK 5",
        club: "Synthetic Golf Club",
        state: "NC",
        handicapIndex: -0.9,
        display: "+0.9",
        effectiveDate: "2026-10-29",
      });
      const text = JSON.stringify(matches);
      assert.equal(text.includes("555-0100"), false, "no phone numbers");
      assert.equal(text.includes("example.invalid"), false, "no emails");
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Validation lookup at sign-in plus one search, both counted.
      assert.equal((await usage.allowance()).search, 198);
    } finally {
      await active.close();
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test(
  "search_golfers works through the MCP server and in demo mode",
  { timeout: 90_000 },
  async () => {
    const f = await profile();
    try {
      const demo = await stdioClient(["--demo"]);
      try {
        const found = await call(demo, "search_golfers", { firstName: "Demo" });
        assert.equal(found.ok, true);
        assert.equal(found.data.matches.length, 5);
      } finally {
        await demo.close();
      }
      await saveVerifiedLogin({
        directory: f.directory,
        login: login(),
        env: fileStore,
      });
      const live = await stdioClient(["--profile", f.directory], fileStore);
      try {
        const found = await call(live, "search_golfers", {
          firstName: "synthetic",
          lastName: "sdk",
          state: "nc",
        });
        assert.equal(found.ok, true);
        assert.equal(found.data.matches[0].ghinNumber, "900000001");
        const bad = await live.callTool({
          name: "search_golfers",
          arguments: { firstName: "<script>" },
        });
        assert.equal(bad.isError, true, "invalid names are rejected");
      } finally {
        await live.close();
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);
