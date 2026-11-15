#!/usr/bin/env node
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { AppError, safeError } from "../domain/errors.js";
import { DesktopError, publicDesktopError } from "./errors.js";
import { readVisibleConfirmation } from "./private-prompt.js";
import { readPrivateCredential } from "./private-credential-prompt.js";
import { openCredentialStore } from "./credential-store.js";
import { GhinUsageRepository } from "./ghin-usage.js";
import {
  defaultProfileDirectory,
  ensureProfileDirectory,
  existingProfileDirectory,
  loadSecrets,
  newRosterKey,
  ProfileStateStore,
  saveSecrets,
  wipeSecrets,
  type GhinLogin,
  type GhinMode,
} from "./local-profile.js";
import { SpicyGolfSdkSession } from "../providers/spicygolf-sdk-client.js";
import { assertLiveAccessEnabled } from "../providers/live-access.js";

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

const HELP = `open-golf-handicap-setup — sign in once; your AI app does the rest.

  login    Save your GHIN login in your computer's password store
  logout   Remove the saved GHIN login (add --all to also forget your roster)
  status   Show what is saved and today's remaining lookups

Options:
  --profile DIR             Profile folder (default: ~/.open-golf-handicap)
  --account-type golfer|api GHIN account type for login (default: golfer)

Unofficial; not affiliated with the USGA or GHIN. Type your GHIN password only
into this terminal, never into an AI chat.
`;

interface Parsed {
  command: "login" | "logout" | "status";
  directory: string;
  mode: GhinMode;
  accountType: "golfer" | "api";
  all: boolean;
}
function parse(args: string[]): Parsed {
  const command = args[0];
  if (!["login", "logout", "status"].includes(command ?? ""))
    throw new AppError(
      "INVALID_INPUT",
      "Use login, logout or status. Run with --help for details.",
    );
  let directory: string | undefined,
    offline = false,
    all = false,
    accountType: "golfer" | "api" = "golfer";
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--profile" && !directory && args[i + 1])
      directory = args[++i];
    else if (flag === "--offline-test" && !offline) offline = true;
    else if (flag === "--all" && command === "logout") all = true;
    else if (
      flag === "--account-type" &&
      command === "login" &&
      ["golfer", "api"].includes(args[i + 1] ?? "")
    )
      accountType = args[++i] as "golfer" | "api";
    else
      throw new AppError(
        "INVALID_INPUT",
        `Unsupported option: ${String(flag).slice(0, 40)}`,
      );
  }
  return {
    command: command as Parsed["command"],
    directory: resolve(directory ?? defaultProfileDirectory()),
    mode: offline ? "offline-test" : "ghin",
    accountType,
    all,
  };
}

export interface LoginResult {
  loggedIn: true;
  profile: string;
  credentialStore: string;
  ghinNumber?: string;
}

/** Verify a login against GHIN (a sign-in, plus a lookup of your own number
 * when one is given), then save it with the roster key in the credential
 * store. */
export async function saveVerifiedLogin(options: {
  directory: string;
  login: GhinLogin;
  env?: NodeJS.ProcessEnv;
  sessionOptions?: Omit<
    ConstructorParameters<typeof SpicyGolfSdkSession>[0],
    "mode" | "allowance" | "onUsage"
  >;
}): Promise<LoginResult> {
  const { login } = options;
  if (login.mode === "ghin") assertLiveAccessEnabled();
  const directory = await ensureProfileDirectory(options.directory);
  const usage = new GhinUsageRepository(
    new ProfileStateStore(directory),
    login.mode,
  );
  const state = await usage.allowance();
  if (login.mode === "ghin" && !state.acknowledged)
    throw new AppError(
      "AUTH_REQUIRED",
      "The unofficial-use notice must be accepted first.",
    );
  if (state.cooldownUntil > Date.now())
    throw new AppError(
      "RATE_LIMITED",
      "GHIN asked this app to slow down. Try again later.",
      state.cooldownUntil - Date.now(),
    );
  if (state.login < 1 || state.search < 1)
    throw new AppError(
      "RATE_LIMITED",
      "This app's daily GHIN request limit was reached. Try again tomorrow.",
    );
  const store = await openCredentialStore(directory, options.env);
  const session = new SpicyGolfSdkSession({
    ...options.sessionOptions,
    mode: login.mode,
    allowance: {
      login: state.login,
      search: state.search,
      cooldownUntil: state.cooldownUntil,
    },
    onUsage: (event) => {
      usage.record(event).catch(() => {
        void session.close();
      });
    },
  });
  const copy = {
    username: Buffer.from(login.username),
    password: Buffer.from(login.password),
    ownGhinNumber: login.ownGhinNumber ?? "",
    accountType: login.accountType,
  };
  let reported: string | undefined;
  try {
    reported = (await session.connect(copy)).ownGhinNumber;
  } finally {
    copy.username.fill(0);
    copy.password.fill(0);
    await session.close();
  }
  let existing: Awaited<ReturnType<typeof loadSecrets>>;
  try {
    existing = await loadSecrets(store);
  } catch {
    existing = undefined; // An unreadable item is replaced by a fresh one.
  }
  try {
    // GHIN's sign-in response names the account's own number; keep it so
    // the assistant can answer "what's my handicap" without asking.
    const ownGhinNumber = login.ownGhinNumber ?? reported;
    await saveSecrets(store, {
      rosterKey: existing?.rosterKey ?? newRosterKey(),
      login: { ...login, ...(ownGhinNumber ? { ownGhinNumber } : {}) },
    });
  } finally {
    wipeSecrets(existing);
  }
  await usage.clearForbidden();
  return {
    loggedIn: true,
    profile: directory,
    credentialStore: store.description,
    ...((login.ownGhinNumber ?? reported)
      ? { ghinNumber: (login.ownGhinNumber ?? reported)! }
      : {}),
  };
}

async function login(options: Parsed) {
  if (options.mode === "ghin") assertLiveAccessEnabled();
  const directory = await ensureProfileDirectory(options.directory);
  const usage = new GhinUsageRepository(
    new ProfileStateStore(directory),
    options.mode,
  );
  if (options.mode === "ghin" && !(await usage.allowance()).acknowledged) {
    process.stdout.write(LIVE_USE_NOTICE + "\n");
    const answer = await readVisibleConfirmation(
      `Type ${ACKNOWLEDGMENT_PHRASE} to continue: `,
    );
    if (answer.trim().toUpperCase() !== ACKNOWLEDGMENT_PHRASE)
      throw new DesktopError("INPUT_CANCELLED");
    await usage.acknowledge();
  }
  process.stdout.write(
    options.mode === "offline-test"
      ? "Offline test: use an .invalid username, a synthetic- test password and fixture 900000001. No network is used.\n"
      : "Sign in with your GHIN account. Nothing is shown as you type; it stays on this computer.\n",
  );
  const username = await readPrivateCredential("GHIN username or email: ");
  const password = await readPrivateCredential("GHIN password: ");
  try {
    process.stdout.write("Checking with GHIN…\n");
    const result = await saveVerifiedLogin({
      directory,
      login: {
        username,
        password,
        accountType: options.accountType,
        mode: options.mode,
      },
    });
    process.stdout.write(
      `\nSigned in${result.ghinNumber ? ` as GHIN ${result.ghinNumber}` : ""}. Your login is saved in your ${result.credentialStore}.\n` +
        "Next, add the server to your AI app (see the README), for example:\n" +
        "  claude mcp add golf-handicap -- npx -y open-golf-handicap-mcp" +
        (options.directory === resolve(defaultProfileDirectory())
          ? ""
          : ` --profile "${result.profile}"`) +
        '\nThen ask your assistant: "What\'s my golf handicap?"\n',
    );
  } finally {
    username.fill(0);
    password.fill(0);
  }
}

async function logout(options: Parsed) {
  const directory = await existingProfileDirectory(options.directory);
  if (!directory) {
    process.stdout.write("Nothing is saved for this profile.\n");
    return;
  }
  const store = await openCredentialStore(directory);
  if (options.all) {
    const removed = await store.remove();
    process.stdout.write(
      removed
        ? `Removed the saved login and roster key from your ${store.description}. The roster files in ${directory} can no longer be read; delete that folder to remove them.\n`
        : "Nothing was saved.\n",
    );
    return;
  }
  const secrets = await loadSecrets(store);
  try {
    if (!secrets?.login) {
      process.stdout.write("No GHIN login was saved.\n");
      return;
    }
    await saveSecrets(store, { rosterKey: secrets.rosterKey });
    process.stdout.write(
      `Removed your GHIN login from your ${store.description}. Your roster is kept. Restart your AI app to end any active session.\n`,
    );
  } finally {
    wipeSecrets(secrets);
  }
}

async function status(options: Parsed) {
  const directory = await existingProfileDirectory(options.directory);
  if (!directory) {
    process.stdout.write(
      JSON.stringify({ profile: options.directory, exists: false }) + "\n",
    );
    return;
  }
  const store = await openCredentialStore(directory);
  const secrets = await loadSecrets(store).catch(() => undefined);
  const usage = await new GhinUsageRepository(
    new ProfileStateStore(directory),
    secrets?.login?.mode ?? "ghin",
  ).allowance();
  process.stdout.write(
    JSON.stringify({
      profile: directory,
      credentialStore: store.description,
      loggedIn: secrets?.login !== undefined,
      ghinNumberSaved: secrets?.login?.ownGhinNumber !== undefined,
      noticeAccepted: usage.acknowledged,
      lookupsLeftToday: usage.search,
      signInsLeftToday: usage.login,
      cooldownUntil: usage.cooldownUntil
        ? new Date(usage.cooldownUntil).toISOString()
        : null,
      blockedByGhin: usage.forbidden,
    }) + "\n",
  );
  wipeSecrets(secrets);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    process.stdout.write(HELP);
    return;
  }
  const options = parse(args);
  if (options.command === "login") return login(options);
  if (options.command === "logout") return logout(options);
  return status(options);
}

// npm runs bins through a symlink (or a .cmd shim on Windows), so compare
// the real path of the invoked script with this module's real path.
function invokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      pathToFileURL(realpathSync(resolve(process.argv[1]))).href ===
      pathToFileURL(realpathSync(new URL(import.meta.url))).href
    );
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  main().catch((error: unknown) => {
    // Messages here are this program's own fixed text, never provider data.
    const diagnostic =
      error instanceof AppError
        ? { ...safeError(error), message: error.message }
        : publicDesktopError(error);
    process.stderr.write(`Error (${diagnostic.code}): ${diagnostic.message}\n`);
    process.exitCode = 1;
  });
}
