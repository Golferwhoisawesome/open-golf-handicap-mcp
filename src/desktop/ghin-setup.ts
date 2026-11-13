import { resolve } from "node:path";
import { AppError } from "../domain/errors.js";
import { assertLiveAccessEnabled } from "../providers/live-access.js";
import { GhinAuthenticatedProvider } from "../providers/ghin-provider.js";
import { inspectProfile, unlockProfile } from "./profile.js";
import {
  readHiddenPassphrase,
  readVisibleConfirmation,
} from "./private-prompt.js";
import { GhinUsageRepository } from "./ghin-usage.js";
import { onTermination } from "./private-terminal.js";
import { readPrivateCredential } from "./private-credential-prompt.js";
import {
  GhinCredentialRepository,
  type CredentialInput,
} from "./ghin-credentials.js";
import { DesktopError } from "./errors.js";
import {
  startRosterSession,
  watchRosterSession,
  requestRosterProvider,
} from "./session-broker.js";

function parse(args: string[]) {
  const command = args[0];
  if (
    !["connect-ghin", "resume-ghin", "disconnect-ghin"].includes(command ?? "")
  )
    throw new AppError("INVALID_INPUT", "Unknown private connection command.");
  let directory: string | undefined,
    offline = false,
    controlledTest = false,
    remember = false,
    accountType: "golfer" | "api" = "golfer",
    explicitAccount = false;
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (
      flag === "--profile" &&
      !directory &&
      args[i + 1] &&
      !args[i + 1]!.startsWith("--")
    )
      directory = args[++i];
    else if (
      flag === "--controlled-test" &&
      !controlledTest &&
      command === "connect-ghin"
    )
      controlledTest = true;
    else if (
      flag === "--offline-test" &&
      !offline &&
      command !== "disconnect-ghin"
    )
      offline = true;
    else if (
      flag === "--remember-login" &&
      !remember &&
      command === "connect-ghin"
    )
      remember = true;
    else if (
      flag === "--account-type" &&
      !explicitAccount &&
      command === "connect-ghin" &&
      ["golfer", "api"].includes(args[i + 1] ?? "")
    ) {
      explicitAccount = true;
      accountType = args[++i] as "golfer" | "api";
    } else
      throw new AppError(
        "INVALID_INPUT",
        "Unsupported private connection arguments.",
      );
  }
  if (!directory)
    throw new AppError("INVALID_INPUT", "Supply --profile DIRECTORY.");
  if (controlledTest && (remember || accountType !== "golfer"))
    throw new AppError(
      "INVALID_INPUT",
      "Controlled tests require a session-only golfer account.",
    );
  return {
    command: command!,
    directory: resolve(directory),
    mode: offline ? ("offline-test" as const) : ("ghin" as const),
    remember,
    controlledTest,
    accountType,
  };
}

export const LIVE_USE_NOTICE = [
  "",
  "IMPORTANT: Open Golf Handicap MCP is unofficial.",
  "  - It is not affiliated with, endorsed by or supported by the USGA or GHIN.",
  "  - It signs in to GHIN with YOUR account, the way the GHIN mobile app does.",
  "    The GHIN Terms of Service restrict automated access; using this tool may",
  "    violate them and could get your GHIN account suspended.",
  "  - It only reads handicap data. It never posts scores.",
  "  - You use it entirely at your own risk. The software has no warranty.",
  "",
].join("\n");
export const ACKNOWLEDGMENT_PHRASE = "I UNDERSTAND";

async function unlockPrivately(directory: string) {
  const secret = await readHiddenPassphrase(
    "Local vault passphrase (not a GHIN password): ",
  );
  try {
    return await unlockProfile(directory, secret);
  } finally {
    secret.fill(0);
  }
}

async function disconnectPrivately(directory: string, profileId: string) {
  let watcher: Awaited<ReturnType<typeof watchRosterSession>> | undefined;
  try {
    watcher = await watchRosterSession(directory, profileId, () => {});
    const result = (await requestRosterProvider(
      directory,
      profileId,
      watcher.sessionId,
      "disconnect",
    )) as { disconnected?: boolean };
    if (result?.disconnected !== true)
      throw new AppError("UNAVAILABLE", "Disconnect was not confirmed.");
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "AUTH_REQUIRED")
      throw error;
    // No active connection: privately unlock the file vault to revoke retained
    // credentials. A concurrent pending sign-in cannot commit over the tombstone.
    const profile = await unlockPrivately(directory);
    try {
      await profile.withSecrets((store) =>
        new GhinCredentialRepository(store).disconnect(),
      );
    } finally {
      await profile.dispose();
    }
  } finally {
    watcher?.close();
  }
  process.stdout.write(
    JSON.stringify({
      disconnected: true,
      credentialsStored: false,
      remoteRevocation: "not-established",
    }) + "\n",
  );
}

export async function runGhinSetup(args: string[]): Promise<void> {
  const options = parse(args);
  // Check before reading any GHIN username/password, constructing SDK workers,
  // or changing saved connection state. Cleanup is always available.
  if (options.command !== "disconnect-ghin" && options.mode === "ghin")
    assertLiveAccessEnabled();
  const status = await inspectProfile(options.directory);
  if (!status.initialized || !status.profileId)
    throw new DesktopError("PROFILE_MISSING");
  if (options.command === "disconnect-ghin")
    return disconnectPrivately(options.directory, status.profileId);
  const profile = await unlockPrivately(options.directory);
  try {
    await profile.withSecrets(async (store) => {
      const repository = new GhinCredentialRepository(store);
      const usage = new GhinUsageRepository(store, options.mode);
      if (options.mode === "ghin") {
        const state = await usage.allowance();
        if (!state.acknowledged) {
          if (options.command !== "connect-ghin")
            throw new AppError(
              "AUTH_REQUIRED",
              "Run connect-ghin first to review the unofficial-use notice.",
            );
          process.stdout.write(LIVE_USE_NOTICE + "\n");
          const answer = await readVisibleConfirmation(
            `Type ${ACKNOWLEDGMENT_PHRASE} to continue: `,
          );
          if (answer.trim().toUpperCase() !== ACKNOWLEDGMENT_PHRASE)
            throw new DesktopError("INPUT_CANCELLED");
          await usage.acknowledge();
        }
      }
      const cancellation = new AbortController();
      let provider: GhinAuthenticatedProvider | undefined;
      const key = profile.copyRosterKey();
      const brokerOptions: Parameters<typeof startRosterSession>[0] = {
        directory: options.directory,
        profileId: profile.profileId,
        rosterDirectory: profile.rosterDirectory,
        key,
        ...(options.controlledTest ? { durationMs: 300_000 } : {}),
        onClose: async () => {
          cancellation.abort();
          await provider?.close();
        },
        onDisconnectPending: async () => {
          cancellation.abort();
          await repository.disconnect();
        },
      };
      let broker: Awaited<ReturnType<typeof startRosterSession>>;
      // Reserve the exclusive profile socket before any login or retained-state
      // change. A second setup process must not authenticate concurrently.
      try {
        broker = await startRosterSession(brokerOptions);
      } finally {
        key.fill(0);
      }
      const stop = () => {
        void broker.close();
      };
      const removeSignals = onTermination(stop);
      let username: Buffer | undefined,
        password: Buffer | undefined,
        ownNumber: Buffer | undefined;
      try {
        let credentials: CredentialInput | undefined;
        if (options.command === "connect-ghin") {
          if (options.controlledTest)
            process.stdout.write(
              "Controlled test: only your privately entered number, five minutes, one login and at most two golfer reads. Errors stop further provider traffic.\n",
            );
          process.stdout.write(
            options.mode === "offline-test"
              ? "Offline SDK test: use an .invalid username, a synthetic- test password, and fixture 900000001 through 900000005. No network is used.\n"
              : "Private GHIN sign-in. Your username and password stay on this computer and are never sent to the AI conversation.\n",
          );
          process.stdout.write(
            options.remember
              ? "Remember login selected: the verified username/password will be retained in this encrypted vault for private reconnect.\n"
              : "Session-only login: the username/password will not be saved to disk.\n",
          );
          username = await readPrivateCredential(
            "GHIN username (hidden): ",
            cancellation.signal,
          );
          password = await readPrivateCredential(
            "GHIN password (hidden): ",
            cancellation.signal,
          );
          ownNumber = await readPrivateCredential(
            "Your GHIN number for sign-in verification (hidden): ",
            cancellation.signal,
          );
          credentials = {
            username,
            password,
            ownGhinNumber: ownNumber.toString("utf8"),
            accountType: options.accountType,
          };
        }
        if (cancellation.signal.aborted)
          throw new DesktopError("INPUT_CANCELLED");
        provider = await GhinAuthenticatedProvider.connect({
          ownerSubject: "local-owner",
          mode: options.mode,
          repository,
          usage,
          credentials,
          remember: options.remember,
          signal: cancellation.signal,
          ...(options.controlledTest
            ? {
                onConnectionFailure: (
                  diagnostics: ReturnType<
                    GhinAuthenticatedProvider["diagnostics"]
                  >,
                ) => {
                  process.stdout.write(
                    JSON.stringify({
                      event: "controlled-test-stopped",
                      diagnostics,
                    }) + "\n",
                  );
                },
              }
            : {}),
          sessionOptions: {
            controlledTest: options.controlledTest,
            maxSessionMs: Math.max(100, broker.expiresAt - Date.now()),
          },
        });
        username?.fill(0);
        password?.fill(0);
        ownNumber?.fill(0);
        if (cancellation.signal.aborted)
          throw new DesktopError("INPUT_CANCELLED");
        brokerOptions.provider = provider;
        const connection = await provider.getConnectionState({
          subject: "local-owner",
        });
        process.stdout.write(
          JSON.stringify({
            connected: connection.connected,
            provider: provider.id,
            liveAccessEnabled: provider.capabilities.live,
            credentialsStored: connection.credentialsStored,
            expiresAt: connection.expiresAt,
            controlledTest: connection.controlledTest === true,
            ...(options.controlledTest
              ? {
                  diagnostics: provider.diagnostics({ subject: "local-owner" }),
                }
              : {}),
          }) + "\n",
        );
        process.stdout.write(
          "Leave this private session open while using the MCP. Ctrl-C locks the profile; disconnect-ghin removes any retained login.\n",
        );
        await broker.closed;
      } finally {
        username?.fill(0);
        password?.fill(0);
        ownNumber?.fill(0);
        removeSignals();
        await broker.close();
        await provider?.close();
        if (options.controlledTest && provider)
          process.stdout.write(
            JSON.stringify({
              event: "controlled-test-closed",
              diagnostics: provider.diagnostics({ subject: "local-owner" }),
            }) + "\n",
          );
      }
    });
  } finally {
    await profile.dispose();
  }
}
