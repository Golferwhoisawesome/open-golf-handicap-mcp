import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, rename } from "node:fs/promises";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
export const isWindows = process.platform === "win32";

/** Absolute System32 tools: PATH may resolve `whoami` or `icacls` to
 * look-alikes from Git Bash, MSYS2 or Cygwin, or to a planted binary. */
function systemTool(name: "whoami.exe" | "icacls.exe"): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  return join(root, "System32", name);
}

/** POSIX: owner-only permission bits and the current uid.
 * Windows: permission bits are not meaningful; directory ACLs are checked
 * separately and files inherit the protected directory ACL. */
export function hasPrivateMode(info: Stats, mode: 0o700 | 0o600): boolean {
  if (isWindows) return true;
  return (
    (info.mode & 0o777) === mode &&
    !!process.getuid &&
    info.uid === process.getuid()
  );
}

let currentUserSid: Promise<string> | undefined;
async function userSid(): Promise<string> {
  currentUserSid ??= run(
    systemTool("whoami.exe"),
    ["/user", "/fo", "csv", "/nh"],
    {
      windowsHide: true,
    },
  ).then(({ stdout }) => {
    const sid = stdout.trim().match(/"(S-1-[0-9-]+)"\s*$/)?.[1];
    if (!sid) throw new Error("Current user SID unavailable");
    return sid;
  });
  return currentUserSid;
}

// The current user, LocalSystem and the built-in Administrators group, which
// mirror POSIX owner plus root. No other principal may hold an entry.
const TRUSTED_ALIASES = new Set(["SY", "BA", "S-1-5-18", "S-1-5-32-544"]);

/** Replace inherited permissions with owner/SYSTEM/Administrators only. */
export async function restrictDirectoryAcl(directory: string): Promise<void> {
  if (!isWindows) return;
  const sid = await userSid();
  await run(
    systemTool("icacls.exe"),
    [
      directory,
      "/inheritance:r",
      "/grant:r",
      `*${sid}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
    ],
    { windowsHide: true },
  );
  verifiedDirectories.delete(directory.toLowerCase());
}

const verifiedDirectories = new Set<string>();
/** True when the directory's DACL is protected and only trusted principals
 * appear. Results are cached for the life of the process. */
export async function hasPrivateAcl(directory: string): Promise<boolean> {
  if (!isWindows) return true;
  const key = directory.toLowerCase();
  if (verifiedDirectories.has(key)) return true;
  const scratch = await mkdtemp(join(tmpdir(), "ogh-acl-"));
  try {
    const output = join(scratch, "acl.txt");
    await run(systemTool("icacls.exe"), [directory, "/save", output], {
      windowsHide: true,
    });
    const saved = (await readFile(output)).toString("utf16le");
    const sddl = saved.split(/\r?\n/)[1]?.trim() ?? "";
    const dacl = sddl.match(/D:([A-Z]*)((?:\([^)]*\))+)/);
    if (!dacl || !dacl[1]!.includes("P")) return false;
    const sid = await userSid();
    // SDDL abbreviates the built-in Administrator account (RID 500) as "LA".
    const self = new Set([sid, ...(/-500$/.test(sid) ? ["LA"] : [])]);
    const entries = [...dacl[2]!.matchAll(/\(([^)]*)\)/g)].map((match) =>
      match[1]!.split(";"),
    );
    const ok =
      entries.length > 0 &&
      entries.every(
        ([type, flags = "", , , , trustee = ""]) =>
          type === "A" &&
          !flags.includes("ID") &&
          (self.has(trustee) || TRUSTED_ALIASES.has(trustee)),
      ) &&
      entries.some(([, , , , , trustee = ""]) => self.has(trustee));
    if (ok) verifiedDirectories.add(key);
    return ok;
  } catch {
    return false;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Windows may briefly hold a destination open (indexer, antivirus). */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        !isWindows ||
        attempt >= 10 ||
        !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")
      )
        throw error;
      await delay(25 * (attempt + 1));
    }
  }
}
