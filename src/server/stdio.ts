#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createService, type OfflineDependencies } from "./bootstrap.js";
import { createMcpServer } from "../tools/register.js";
import { createOfflineSpicyGolfProvider } from "../providers/spicygolf-fixtures.js";
import { inspectProfile } from "../desktop/profile.js";
import {
  getRosterKeyLease,
  watchRosterSession,
  type RosterKeyLease,
} from "../desktop/session-broker.js";
import { AppError, safeError } from "../domain/errors.js";
import { DesktopGhinProvider } from "../providers/desktop-ghin-provider.js";
import { assertLiveAccessEnabled } from "../providers/live-access.js";
import { onTermination } from "../desktop/private-terminal.js";

async function main() {
  let profileDirectory: string | undefined,
    fixtureProvider = false;
  let ghinMode: "offline-test" | "ghin" | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (
      args[i] === "--profile" &&
      !profileDirectory &&
      args[i + 1] &&
      !args[i + 1]!.startsWith("--")
    )
      profileDirectory = args[++i];
    else if (args[i] === "--offline-spicygolf" && !fixtureProvider)
      fixtureProvider = true;
    else if (args[i] === "--offline-ghin" && !ghinMode)
      ghinMode = "offline-test";
    else if (args[i] === "--ghin" && !ghinMode) ghinMode = "ghin";
    else if (args[i] === "--help" && args.length === 1) {
      process.stdout.write(
        "open-golf-handicap-mcp [--offline-spicygolf | --offline-ghin | --ghin] [--profile DIRECTORY]\nUnofficial; not affiliated with the USGA or GHIN. --ghin requires a profile connected with open-golf-handicap-setup connect-ghin.\n",
      );
      return;
    } else throw new AppError("INVALID_INPUT", "Unsupported stdio arguments.");
  }
  if (ghinMode === "ghin") assertLiveAccessEnabled();
  if (ghinMode && (!profileDirectory || fixtureProvider))
    throw new AppError(
      "INVALID_INPUT",
      "SDK sessions require a profile and exactly one provider mode.",
    );
  const subject = "local-owner";
  let server: ReturnType<typeof createMcpServer> | undefined;
  let watcher:
    | { sessionId: string; expiresAt: number; close(): void }
    | undefined;
  let lease: RosterKeyLease | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    watcher?.close();
    lease?.dispose();
    try {
      await server?.close();
    } finally {
      process.exit(0);
    }
  }
  try {
    const offline: OfflineDependencies = {};
    if (fixtureProvider)
      offline.provider = createOfflineSpicyGolfProvider(subject);
    if (profileDirectory) {
      const profile = await inspectProfile(profileDirectory);
      if (!profile.initialized || !profile.profileId)
        throw new AppError(
          "AUTH_REQUIRED",
          "Initialize and unlock the profile privately first.",
        );
      watcher = await watchRosterSession(
        profileDirectory,
        profile.profileId,
        () => {
          void stop();
        },
      );
      lease = await getRosterKeyLease(profileDirectory, profile.profileId);
      if (
        stopping ||
        lease.sessionId !== watcher.sessionId ||
        lease.expiresAt !== watcher.expiresAt
      )
        throw new AppError(
          "AUTH_REQUIRED",
          "Local session changed during startup.",
        );
      offline.localStorage = {
        directory: lease.rosterDirectory,
        key: lease.key,
      };
      if (ghinMode)
        offline.provider = await DesktopGhinProvider.attach(
          profileDirectory,
          profile.profileId,
          lease.sessionId,
          ghinMode,
        );
      timer = setTimeout(
        () => {
          void stop();
        },
        Math.max(0, lease.expiresAt - Date.now()),
      );
    }
    server = createMcpServer(createService(process.env, offline), {
      subject,
      scopes: ["roster:read", "roster:write"],
    });
    server.server.onclose = () => {
      void stop();
    };
    lease?.dispose();
    await server.connect(new StdioServerTransport());
    process.stdin.once("end", () => {
      void stop();
    });
    onTermination(() => {
      void stop();
    });
  } catch (error) {
    stopping = true;
    if (timer) clearTimeout(timer);
    watcher?.close();
    lease?.dispose();
    await server?.close();
    throw error;
  }
}
main().catch((error: unknown) => {
  process.stderr.write(`Open Golf Handicap MCP: ${safeError(error).message}\n`);
  process.exitCode = 1;
});
