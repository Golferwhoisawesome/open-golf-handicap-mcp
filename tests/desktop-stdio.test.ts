import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initProfile, unlockProfile } from "../src/desktop/profile.js";
import {
  startRosterSession,
  lockRosterSession,
} from "../src/desktop/session-broker.js";
import { shortTempRoot } from "./support/temp.js";

test(
  "private profile reopens across MCP processes and locking closes active clients",
  { timeout: 20_000 },
  async () => {
    const root = await mkdtemp(join(await shortTempRoot(), "ogh-profile-"));
    const directory = join(root, "profile");
    const passphrase = Buffer.from("synthetic-vault-passphrase-for-test-only");
    let session: Awaited<ReturnType<typeof startRosterSession>> | undefined;
    const clients: Client[] = [];
    async function connect() {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          "--import",
          "tsx",
          "src/server/stdio.ts",
          "--offline-spicygolf",
          "--profile",
          directory,
        ],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "", OGH_PROVIDER: "mock" },
        stderr: "pipe",
      });
      let stderr = "";
      transport.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      const client = new Client({ name: "private-profile-test", version: "1" });
      clients.push(client);
      await client.connect(transport, { timeout: 5000 });
      return { client, stderr: () => stderr };
    }
    try {
      await initProfile(directory, passphrase);
      const profile = await unlockProfile(directory, passphrase);
      const key = profile.copyRosterKey();
      session = await startRosterSession({
        directory,
        profileId: profile.profileId,
        rosterDirectory: profile.rosterDirectory,
        key,
      });
      key.fill(0);
      await profile.dispose();
      const first = await connect();
      const saved = await first.client.callTool({
        name: "save_golfer",
        arguments: { name: "Demo Private Profile", ghinNumber: "900000001" },
      });
      assert.equal(saved.structuredContent?.ok, true);
      assert.equal(
        (
          await first.client.callTool({
            name: "refresh_saved_handicaps",
            arguments: {},
          })
        ).structuredContent?.ok,
        true,
      );
      await first.client.close();
      const second = await connect();
      const roster = (
        await second.client.callTool({
          name: "get_saved_golfers",
          arguments: {},
        })
      ).structuredContent as any;
      assert.equal(roster.data.golfers[0].handicap.handicapIndex, 12.4);
      assert.equal(roster.data.golfers[0].handicap.source, "spicygolf-offline");
      assert.equal(roster.data.golfers[0].handicap.synthetic, true);
      const status = (
        await second.client.callTool({
          name: "get_connection_status",
          arguments: {},
        })
      ).structuredContent as any;
      assert.equal(status.data.storage, "local-encrypted");
      assert.equal(status.data.liveAccessEnabled, false);
      const closed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("MCP did not stop on profile lock")),
          5000,
        );
        second.client.onclose = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      await lockRosterSession(directory, profile.profileId);
      await closed;
      await assert.rejects(
        second.client.callTool({ name: "get_saved_golfers", arguments: {} }),
      );
      assert(!first.stderr().includes(passphrase.toString()));
      assert(!second.stderr().includes(passphrase.toString()));
    } finally {
      for (const client of clients) await client.close();
      await session?.close();
      passphrase.fill(0);
      await rm(root, { recursive: true, force: true });
    }
  },
);
