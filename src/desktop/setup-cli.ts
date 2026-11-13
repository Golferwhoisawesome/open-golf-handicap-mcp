#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initProfile, inspectProfile, unlockProfile } from "./profile.js";
import { readHiddenPassphrase } from "./private-prompt.js";
import { DesktopError, publicDesktopError } from "./errors.js";
import { startRosterSession, lockRosterSession } from "./session-broker.js";
import { AppError, safeError } from "../domain/errors.js";
import { runGhinSetup } from "./ghin-setup.js";
import { onTermination } from "./private-terminal.js";
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(
      "open-golf-handicap-setup <init|status|unlock|lock> --profile DIRECTORY\nopen-golf-handicap-setup <connect-ghin|resume-ghin> --profile DIRECTORY [--offline-test]\nconnect-ghin also accepts --remember-login and --account-type golfer|api.\nconnect-ghin --controlled-test restricts access to your number with a small request budget; cannot remember login or use an API account.\nopen-golf-handicap-setup disconnect-ghin --profile DIRECTORY\nUnofficial; not affiliated with the USGA or GHIN. Enter secrets only in this private terminal, never in an AI chat.\n",
    );
    return;
  }
  if (
    ["connect-ghin", "resume-ghin", "disconnect-ghin"].includes(args[0] ?? "")
  )
    return runGhinSetup(args);
  const [command, flag, directory] = args;
  if (
    args.length !== 3 ||
    flag !== "--profile" ||
    !directory ||
    directory.startsWith("--") ||
    !["init", "status", "unlock", "lock"].includes(command ?? "")
  )
    throw new AppError(
      "INVALID_INPUT",
      "Use a setup command followed by --profile DIRECTORY.",
    );
  const profileDirectory = resolve(directory),
    status = await inspectProfile(profileDirectory);
  if (command === "status") {
    process.stdout.write(JSON.stringify(status) + "\n");
    return;
  }
  if (command === "lock") {
    if (!status.initialized || !status.profileId)
      throw new DesktopError("PROFILE_MISSING");
    await lockRosterSession(profileDirectory, status.profileId);
    process.stdout.write("Local profile session locked.\n");
    return;
  }
  if (command === "init" && status.initialized)
    throw new DesktopError("PROFILE_EXISTS");
  if (command === "unlock" && !status.initialized)
    throw new DesktopError("PROFILE_MISSING");
  const passphrase = await readHiddenPassphrase(
    "Vault passphrase (not a GHIN password): ",
  );
  try {
    if (command === "init") {
      const confirmation = await readHiddenPassphrase(
        "Repeat vault passphrase: ",
      );
      try {
        if (!passphrase.equals(confirmation))
          throw new DesktopError("PASSPHRASE_MISMATCH");
      } finally {
        confirmation.fill(0);
      }
      process.stdout.write(
        JSON.stringify(await initProfile(profileDirectory, passphrase)) + "\n",
      );
      return;
    }
    const unlocked = await unlockProfile(profileDirectory, passphrase);
    passphrase.fill(0);
    let session: Awaited<ReturnType<typeof startRosterSession>>;
    const key = unlocked.copyRosterKey();
    try {
      session = await startRosterSession({
        directory: profileDirectory,
        profileId: unlocked.profileId,
        rosterDirectory: unlocked.rosterDirectory,
        key,
      });
    } finally {
      key.fill(0);
      await unlocked.dispose();
    }
    const stop = () => {
      void session.close();
    };
    const removeSignals = onTermination(stop);
    try {
      process.stdout.write(
        `Local roster unlocked until ${new Date(session.expiresAt).toISOString()}. Leave this terminal open; Ctrl-C locks it.\n`,
      );
      await session.closed;
      process.stdout.write("Local profile session locked.\n");
    } finally {
      removeSignals();
      await session.close();
    }
  } finally {
    passphrase.fill(0);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    const diagnostic =
      error instanceof AppError ? safeError(error) : publicDesktopError(error);
    process.stderr.write(
      JSON.stringify({ ok: false, error: diagnostic }) + "\n",
    );
    process.exitCode = 1;
  });
}
