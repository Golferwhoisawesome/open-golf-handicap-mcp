import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { AppError } from "../domain/errors.js";
import {
  assertPrivateDirectory,
  errorCode,
  readPrivateFile,
  writePrivateAtomic,
} from "./private-files.js";

const run = promisify(execFile);

/** Create or atomically replace an owner-only file. */
async function writeReplacing(path: string, value: Buffer): Promise<void> {
  let exists = true;
  try {
    await lstat(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    exists = false;
  }
  await writePrivateAtomic(path, value, !exists);
}

/** One opaque secret per profile, held by the operating system's credential
 * service. Values never appear in command-line arguments or the environment. */
export interface CredentialStore {
  readonly kind: "macos-keychain" | "windows-dpapi" | "secret-service" | "file";
  /** Human-readable name for messages. */
  readonly description: string;
  read(): Promise<Buffer | undefined>;
  write(value: Buffer): Promise<void>;
  /** Returns true when something was removed. */
  remove(): Promise<boolean>;
}

const SERVICE = "open-golf-handicap-mcp";
const unavailable = (detail: string) =>
  new AppError("STORAGE_ERROR", `Credential storage failed: ${detail}`);

/** Stable, nonsecret account name so separate profiles never collide. */
export function credentialAccount(profileDirectory: string): string {
  return (
    "profile-" +
    createHash("sha256")
      .update(profileDirectory.toLowerCase())
      .digest("hex")
      .slice(0, 24)
  );
}

/** Writes stdin to a child and collects stdout; stdin carries the secret. */
function pipeThrough(
  command: string,
  args: string[],
  input: Buffer,
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length < 4096) err += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(out), stderr: err }),
    );
    child.stdin.end(input);
  });
}

/** macOS login keychain via /usr/bin/security. The value is passed as hex
 * through `security -i` on stdin, never as an argument. */
export class MacKeychainStore implements CredentialStore {
  readonly kind = "macos-keychain" as const;
  readonly description = "macOS Keychain";
  constructor(private readonly account: string) {}
  async read() {
    try {
      const { stdout } = await run(
        "/usr/bin/security",
        ["find-generic-password", "-a", this.account, "-s", SERVICE, "-w"],
        { maxBuffer: 64 * 1024 },
      );
      return Buffer.from(stdout.trim(), "utf8");
    } catch (error) {
      if ((error as { code?: unknown }).code === 44) return undefined;
      throw unavailable("the macOS Keychain could not be read");
    }
  }
  async write(value: Buffer) {
    const text = value.toString("utf8");
    if (!/^[A-Za-z0-9+/=]+$/.test(text))
      throw unavailable("unexpected credential encoding");
    const command = Buffer.from(
      `add-generic-password -U -a ${this.account} -s ${SERVICE} -l "Open Golf Handicap MCP" -X ${value.toString("hex")}\n`,
    );
    try {
      const result = await pipeThrough("/usr/bin/security", ["-i"], command);
      if (result.code !== 0 || /error|fail/i.test(result.stderr))
        throw new Error();
    } catch {
      throw unavailable("the macOS Keychain refused the update");
    } finally {
      command.fill(0);
    }
  }
  async remove() {
    try {
      await run("/usr/bin/security", [
        "delete-generic-password",
        "-a",
        this.account,
        "-s",
        SERVICE,
      ]);
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code === 44) return false;
      throw unavailable("the macOS Keychain item could not be removed");
    }
  }
}

/** Windows: Data Protection API bound to the current user, stored in the
 * ACL-protected profile directory. PowerShell receives data on stdin only. */
export class WindowsDpapiStore implements CredentialStore {
  readonly kind = "windows-dpapi" as const;
  readonly description = "Windows Data Protection (your Windows account)";
  readonly #file: string;
  constructor(profileDirectory: string) {
    this.#file = join(profileDirectory, "credentials.dpapi");
  }
  static #powershell(): string {
    const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
    return join(
      root,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
  }
  async #transform(operation: "Protect" | "Unprotect", input: Buffer) {
    const script =
      "Add-Type -AssemblyName System.Security;" +
      "$i=[Console]::In.ReadToEnd().Trim();" +
      `$o=[System.Security.Cryptography.ProtectedData]::${operation}(` +
      "[Convert]::FromBase64String($i),$null," +
      "[System.Security.Cryptography.DataProtectionScope]::CurrentUser);" +
      "[Console]::Out.Write([Convert]::ToBase64String($o))";
    const encoded = Buffer.from(input.toString("base64"));
    try {
      const result = await pipeThrough(
        WindowsDpapiStore.#powershell(),
        ["-NoProfile", "-NonInteractive", "-Command", script],
        encoded,
      );
      if (result.code !== 0) throw new Error();
      return Buffer.from(result.stdout.toString("utf8").trim(), "base64");
    } finally {
      encoded.fill(0);
    }
  }
  async read() {
    let sealed: Buffer;
    try {
      sealed = await readPrivateFile(this.#file, 64 * 1024);
    } catch (error) {
      try {
        await lstat(this.#file);
      } catch (missing) {
        if (errorCode(missing) === "ENOENT") return undefined;
      }
      throw error;
    }
    try {
      return await this.#transform("Unprotect", sealed);
    } catch {
      throw unavailable("Windows could not decrypt the saved login");
    }
  }
  async write(value: Buffer) {
    let sealed: Buffer;
    try {
      sealed = await this.#transform("Protect", value);
    } catch {
      throw unavailable("Windows could not encrypt the login");
    }
    await writeReplacing(this.#file, sealed);
  }
  async remove() {
    try {
      await unlink(this.#file);
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw unavailable("the saved login could not be removed");
    }
  }
}

/** Linux desktops: the Secret Service (GNOME Keyring, KWallet) via secret-tool. */
export class SecretServiceStore implements CredentialStore {
  readonly kind = "secret-service" as const;
  readonly description = "Secret Service keyring";
  constructor(private readonly account: string) {}
  async read() {
    const result = await pipeThrough(
      "secret-tool",
      ["lookup", "service", SERVICE, "account", this.account],
      Buffer.alloc(0),
    ).catch(() => {
      throw unavailable("secret-tool is not available");
    });
    if (result.code !== 0 || result.stdout.length === 0) return undefined;
    return Buffer.from(result.stdout.toString("utf8").trim(), "utf8");
  }
  async write(value: Buffer) {
    const result = await pipeThrough(
      "secret-tool",
      [
        "store",
        "--label=Open Golf Handicap MCP",
        "service",
        SERVICE,
        "account",
        this.account,
      ],
      value,
    ).catch(() => {
      throw unavailable("secret-tool is not available");
    });
    if (result.code !== 0) throw unavailable("the keyring refused the update");
  }
  async remove() {
    const existed = (await this.read()) !== undefined;
    const result = await pipeThrough(
      "secret-tool",
      ["clear", "service", SERVICE, "account", this.account],
      Buffer.alloc(0),
    ).catch(() => {
      throw unavailable("secret-tool is not available");
    });
    if (result.code !== 0)
      throw unavailable("the keyring item was not removed");
    return existed;
  }
}

/** Plain file readable only by your account. For headless Linux and tests,
 * selected explicitly with OGH_CREDENTIAL_STORE=file. */
export class PrivateFileStore implements CredentialStore {
  readonly kind = "file" as const;
  readonly description = "private file (owner-only permissions)";
  readonly #file: string;
  constructor(profileDirectory: string) {
    this.#file = join(profileDirectory, "credentials.json");
  }
  async read() {
    try {
      await assertPrivateDirectory(join(this.#file, ".."));
      return await readPrivateFile(this.#file, 64 * 1024);
    } catch (error) {
      try {
        await lstat(this.#file);
      } catch (missing) {
        if (errorCode(missing) === "ENOENT") return undefined;
      }
      throw error;
    }
  }
  async write(value: Buffer) {
    await writeReplacing(this.#file, value);
  }
  async remove() {
    try {
      await unlink(this.#file);
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw unavailable("the saved login could not be removed");
    }
  }
}

async function hasSecretTool(): Promise<boolean> {
  try {
    await run("secret-tool", ["--version"]);
    return true;
  } catch (error) {
    // secret-tool prints usage and exits non-zero for --version on some
    // builds; only a missing binary means it is unavailable.
    return errorCode(error) !== "ENOENT";
  }
}

/** The platform credential service, or the private file when explicitly
 * requested with OGH_CREDENTIAL_STORE=file. */
export async function openCredentialStore(
  profileDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialStore> {
  const choice = env.OGH_CREDENTIAL_STORE ?? "auto";
  if (choice === "file") return new PrivateFileStore(profileDirectory);
  if (choice !== "auto")
    throw new AppError(
      "INVALID_INPUT",
      "OGH_CREDENTIAL_STORE must be auto or file.",
    );
  const account = credentialAccount(profileDirectory);
  if (process.platform === "darwin") return new MacKeychainStore(account);
  if (process.platform === "win32")
    return new WindowsDpapiStore(profileDirectory);
  if (await hasSecretTool()) return new SecretServiceStore(account);
  throw new AppError(
    "UNSUPPORTED",
    "No system keyring was found. Install secret-tool (libsecret), or set OGH_CREDENTIAL_STORE=file to keep the login in an owner-only file.",
  );
}
