#!/usr/bin/env node
import { join, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createService, type OfflineDependencies } from "./bootstrap.js";
import { createMcpServer } from "../tools/register.js";
import { createOfflineSpicyGolfProvider } from "../providers/spicygolf-fixtures.js";
import { AppError } from "../domain/errors.js";
import { onTermination } from "../desktop/private-terminal.js";
import { openCredentialStore } from "../desktop/credential-store.js";
import { GhinUsageRepository } from "../desktop/ghin-usage.js";
import {
  defaultProfileDirectory,
  existingProfileDirectory,
  loadSecrets,
  ProfileStateStore,
  wipeSecrets,
} from "../desktop/local-profile.js";
import { OnDemandGhinProvider } from "../providers/on-demand-ghin-provider.js";

const HELP = `open-golf-handicap-mcp [--profile DIR] [--demo]

An MCP server for your AI app. It uses the GHIN login saved by
"open-golf-handicap-setup login" and signs in only when a lookup needs it.
Without a saved login it runs in demo mode with synthetic golfers.

  --profile DIR  Profile folder (default: ~/.open-golf-handicap)
  --demo         Always use synthetic demo data

Unofficial; not affiliated with the USGA or GHIN.
`;

async function main() {
  let profile: string | undefined,
    demo = false,
    fixtureProvider = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--profile" && !profile && args[i + 1]) profile = args[++i];
    else if (args[i] === "--demo") demo = true;
    else if (args[i] === "--offline-spicygolf") fixtureProvider = true;
    else if (args[i] === "--help" && args.length === 1) {
      process.stdout.write(HELP);
      return;
    } else
      throw new AppError(
        "INVALID_INPUT",
        `Unsupported option: ${String(args[i]).slice(0, 40)}. Run with --help.`,
      );
  }
  const subject = "local-owner";
  const offline: OfflineDependencies = {};
  let provider: OnDemandGhinProvider | undefined;
  if (fixtureProvider)
    offline.provider = createOfflineSpicyGolfProvider(subject);
  else if (!demo) {
    const directory = await existingProfileDirectory(
      resolve(profile ?? defaultProfileDirectory()),
    );
    if (directory) {
      const store = await openCredentialStore(directory);
      const secrets = await loadSecrets(store);
      if (secrets) {
        const mode = secrets.login?.mode ?? "ghin";
        provider = new OnDemandGhinProvider({
          ownerSubject: subject,
          mode,
          usage: new GhinUsageRepository(
            new ProfileStateStore(directory),
            mode,
          ),
          loadLogin: async () => {
            const current = await loadSecrets(store);
            const login = current?.login;
            current?.rosterKey.fill(0);
            return login;
          },
        });
        offline.provider = provider;
        offline.localStorage = {
          directory: join(directory, "roster"),
          key: Buffer.from(secrets.rosterKey),
        };
        wipeSecrets(secrets);
      }
    }
  }
  const server = createMcpServer(createService(process.env, offline), {
    subject,
    scopes: ["roster:read", "roster:write"],
  });
  offline.localStorage?.key.fill(0);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await provider?.close();
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  server.server.onclose = () => {
    void stop();
  };
  await server.connect(new StdioServerTransport());
  process.stdin.once("end", () => {
    void stop();
  });
  onTermination(() => {
    void stop();
  });
}
main().catch((error: unknown) => {
  // Fixed program text only; never provider data or credentials.
  const message = error instanceof AppError ? error.message : "Startup failed.";
  process.stderr.write(`Open Golf Handicap MCP: ${message}\n`);
  process.exitCode = 1;
});
