import { createServer, createConnection, type Socket } from "node:net";
import { chmod, lstat, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  hasPrivateAcl,
  hasPrivateMode,
  isWindows,
} from "./platform-security.js";
import {
  readPrivateFile,
  writePrivateAtomic,
  errorCode,
} from "./private-files.js";
import { AppError, safeError } from "../domain/errors.js";
import type { HandicapProvider } from "../providers/handicap-provider.js";
import { z } from "zod";

// Single trusted OS account only: any process running as that account can access
// this socket. Keys never enter argv, environment, MCP responses or disk here.
const MAX_FRAME = 2048;
const MAX_PROVIDER_RESPONSE = 128 * 1024;
const providerRequestSchema = z
  .object({
    operation: z.literal("provider"),
    profileId: z.string(),
    sessionId: z.string(),
    method: z.enum(["status", "getMany", "disconnect"]),
    numbers: z
      .array(z.string().regex(/^[1-9]\d{5,9}$/))
      .min(1)
      .max(100)
      .optional(),
    updatedSince: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();
const SOCKET_NAME = "session.sock";
// Windows has no Unix sockets. The broker listens on a named pipe with a random
// name recorded in this file inside the owner-only profile directory, so other
// accounts can neither find the pipe nor pre-create (squat) its name.
const PIPE_FILE = "session.pipe";
const PIPE_PATTERN = /^\\\\\.\\pipe\\open-golf-handicap-[0-9a-f]{32}$/;
export interface RosterKeyLease {
  profileId: string;
  sessionId: string;
  rosterDirectory: string;
  key: Buffer;
  expiresAt: number;
  dispose(): void;
}
const unavailable = () =>
  new AppError(
    "AUTH_REQUIRED",
    "Unlock the local profile in a private terminal first.",
  );
async function profileDirectory(directory: string) {
  const canonical = await realpath(directory);
  const same = isWindows
    ? canonical.toLowerCase() === resolve(directory).toLowerCase()
    : canonical === resolve(directory);
  if (!same) throw unavailable();
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !hasPrivateMode(info, 0o700) ||
    !(await hasPrivateAcl(canonical))
  )
    throw unavailable();
  return canonical;
}
async function socketPath(directory: string) {
  const path = join(await profileDirectory(directory), SOCKET_NAME);
  if (Buffer.byteLength(path) > 100)
    throw new AppError(
      "UNSUPPORTED",
      "Local sessions require a shorter profile directory path.",
    );
  return path;
}
/** The pipe a running broker recorded, or undefined when none is recorded. */
async function recordedPipe(directory: string): Promise<string | undefined> {
  const file = join(await profileDirectory(directory), PIPE_FILE);
  let bytes: Buffer;
  try {
    bytes = await readPrivateFile(file, 256);
  } catch (error) {
    try {
      await lstat(file);
    } catch (missing) {
      if (errorCode(missing) === "ENOENT") return undefined;
    }
    throw error;
  }
  const name = bytes.toString("utf8").trim();
  if (!PIPE_PATTERN.test(name)) throw unavailable();
  return name;
}
/** The endpoint clients connect to; validated for its platform. */
async function endpointPath(directory: string): Promise<string> {
  if (isWindows) {
    const pipe = await recordedPipe(directory);
    if (!pipe) throw unavailable();
    return pipe;
  }
  const path = await socketPath(directory);
  const info = await lstat(path);
  if (!info.isSocket() || info.isSymbolicLink() || !hasPrivateMode(info, 0o600))
    throw unavailable();
  return path;
}
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(path);
    const done = (alive: boolean) => {
      probe.destroy();
      resolve(alive);
    };
    probe.setTimeout(1000, () => done(false));
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });
}
export async function startRosterSession(options: {
  directory: string;
  profileId: string;
  rosterDirectory: string;
  key: Buffer;
  durationMs?: number;
  provider?: HandicapProvider;
  onClose?: () => Promise<void>;
  onDisconnectPending?: () => Promise<void>;
}) {
  const durationMs = options.durationMs ?? 3_600_000;
  if (
    options.key.length !== 32 ||
    !Number.isInteger(durationMs) ||
    durationMs < 100 ||
    durationMs > 3_600_000
  )
    throw new AppError("INVALID_INPUT", "Invalid local session options.");
  let path: string, pipeFile: string | undefined;
  if (isWindows) {
    const canonical = await profileDirectory(options.directory);
    pipeFile = join(canonical, PIPE_FILE);
    const existing = await recordedPipe(canonical);
    if (existing) {
      if (await answers(existing))
        throw new AppError("CONFLICT", "A local session is already running.");
      // Windows never runs SIGTERM cleanup; a crashed broker leaves this file.
      await unlink(pipeFile);
    }
    path = `\\\\.\\pipe\\open-golf-handicap-${randomBytes(16).toString("hex")}`;
  } else {
    path = await socketPath(options.directory);
    // Do not overwrite a live/stale socket or a symlink. Only our own socket is removed.
    try {
      await lstat(path);
      throw new AppError("CONFLICT", "A local session socket already exists.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const key = Buffer.from(options.key);
  const expiresAt = Date.now() + durationMs;
  const sessionId = randomUUID();
  const clients = new Set<Socket>();
  const watchers = new Set<Socket>();
  const disconnectReplies = new Set<Socket>();
  let stopped = false;
  let activeLookups = 0;
  let ready = false;
  let socketIdentity: { ino: number; dev: number } | undefined;
  let pipeRecorded = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const server = createServer((socket) => {
    if (!ready || stopped || Date.now() >= expiresAt || clients.size >= 32) {
      socket.destroy();
      return;
    }
    clients.add(socket);
    socket.setTimeout(2000, () => socket.destroy());
    socket.on("error", () => {});
    socket.once("close", () => {
      clients.delete(socket);
      watchers.delete(socket);
      disconnectReplies.delete(socket);
    });
    let bytes = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (bytes.length + chunk.length > MAX_FRAME) {
        socket.destroy();
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      socket.removeAllListeners("data");
      try {
        const request = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
        if (
          request.profileId !== options.profileId ||
          stopped ||
          Date.now() >= expiresAt
        )
          throw unavailable();
        if (request.operation === "watch") {
          if (watchers.size >= 16) throw unavailable();
          watchers.add(socket);
          socket.setTimeout(0);
          socket.write(
            JSON.stringify({ watching: true, sessionId, expiresAt }) + "\n",
          );
        } else if (request.operation === "lock") {
          void close(socket);
        } else if (request.operation === "lease") {
          socket.end(
            JSON.stringify({
              profileId: options.profileId,
              sessionId,
              rosterDirectory: options.rosterDirectory,
              key: key.toString("base64"),
              expiresAt,
            }) + "\n",
          );
        } else if (request.operation === "provider") {
          const input = providerRequestSchema.parse(request);
          if (input.sessionId !== sessionId) throw unavailable();
          socket.setTimeout(20_000, () => socket.destroy());
          void providerRequest(socket, input);
        } else throw unavailable();
      } catch {
        socket.end('{"error":"AUTH_REQUIRED"}\n');
      } finally {
        bytes.fill(0);
      }
    });
  });
  async function providerRequest(
    socket: Socket,
    input: z.infer<typeof providerRequestSchema>,
  ) {
    // A pending sign-in may exit as soon as disconnect cancels its prompt. Keep
    // this control socket alive until its persistence result has been delivered.
    if (input.method === "disconnect") disconnectReplies.add(socket);
    const cancellation = new AbortController();
    const cancelled = () => cancellation.abort();
    socket.once("close", cancelled);
    let hasLookupPermit = false;
    let response: unknown;
    try {
      if (stopped || Date.now() >= expiresAt) throw unavailable();
      const provider = options.provider;
      const owner = { subject: "local-owner" };
      let data: unknown;
      if (input.method === "status") {
        if (!provider?.getConnectionState) throw unavailable();
        data = {
          id: provider.id,
          capabilities: provider.capabilities,
          state: await provider.getConnectionState(owner),
        };
      } else if (input.method === "disconnect") {
        if (provider) await provider.disconnect(owner);
        else if (options.onDisconnectPending)
          await options.onDisconnectPending();
        else throw unavailable();
        data = { disconnected: true };
      } else {
        if (!provider) throw unavailable();
        if (!input.numbers)
          throw new AppError("INVALID_INPUT", "Missing identifiers.");
        if (activeLookups >= 2)
          throw new AppError(
            "RATE_LIMITED",
            "Local lookup capacity reached.",
            1000,
          );
        activeLookups++;
        hasLookupPermit = true;
        data = await provider.getMany(owner, input.numbers, {
          updatedSince: input.updatedSince,
          signal: cancellation.signal,
        });
      }
      if (
        input.method !== "disconnect" &&
        (stopped || cancellation.signal.aborted || Date.now() >= expiresAt)
      )
        throw unavailable();
      response = { ok: true, data };
    } catch (error) {
      response = { ok: false, error: safeError(error) };
    } finally {
      socket.removeListener("close", cancelled);
      if (hasLookupPermit) activeLookups--;
    }
    if (!socket.destroyed) {
      const encoded = JSON.stringify(response) + "\n";
      socket.end(
        Buffer.byteLength(encoded) <= MAX_PROVIDER_RESPONSE
          ? encoded
          : JSON.stringify({
              ok: false,
              error: safeError(
                new AppError("UNAVAILABLE", "Response too large."),
              ),
            }) + "\n",
      );
    }
  }
  async function close(acknowledge?: Socket) {
    if (stopped) return closed;
    stopped = true;
    ready = false;
    if (timer) clearTimeout(timer);
    key.fill(0);
    for (const client of clients)
      if (client !== acknowledge && !disconnectReplies.has(client))
        client.destroy();
    const serverClosed = server.listening
      ? new Promise<void>((resolve) => server.close(() => resolve()))
      : Promise.resolve();
    try {
      if (pipeFile) {
        // Remove only our own record; a pipe disappears with its server.
        if (pipeRecorded && (await recordedPipe(options.directory)) === path)
          await unlink(pipeFile);
      } else {
        const info = await lstat(path);
        if (
          socketIdentity &&
          info.ino === socketIdentity.ino &&
          info.dev === socketIdentity.dev &&
          info.isSocket()
        )
          await unlink(path);
      }
    } catch {
      /* already removed; never remove a replacement */
    }
    // Stop the SDK worker before reporting lock. The caller disposes its unlocked
    // vault after closed; explicit remembered credentials survive ordinary lock.
    try {
      await options.onClose?.();
    } catch {
      /* fail closed even if cleanup reports an error */
    }
    // Admission is stopped, keys wiped and socket removed before acknowledging.
    acknowledge?.end('{"locked":true}\n');
    await serverClosed;
    resolveClosed();
  }
  server.on("error", () => {
    void close();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    if (pipeFile) {
      // Exclusive create: a concurrent broker that won the race keeps its record.
      await writePrivateAtomic(pipeFile, Buffer.from(path + "\n"), true);
      pipeRecorded = true;
    } else {
      const info = await lstat(path);
      socketIdentity = { ino: info.ino, dev: info.dev };
      await chmod(path, 0o600);
    }
    if (stopped || Date.now() >= expiresAt) throw unavailable();
    ready = true;
    timer = setTimeout(
      () => {
        void close();
      },
      Math.max(0, expiresAt - Date.now()),
    );
    return { expiresAt, close, closed };
  } catch {
    await close();
    throw unavailable();
  }
}
async function request(
  directory: string,
  profileId: string,
  operation: "lease" | "lock" | "provider",
  payload: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    const path = await endpointPath(directory);
    return await new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(unavailable());
        return;
      }
      const socket = createConnection(path);
      let data = Buffer.alloc(0),
        completed = false;
      function finish(value?: unknown) {
        if (completed) return;
        completed = true;
        signal?.removeEventListener("abort", abort);
        data.fill(0);
        socket.destroy();
        if (value === undefined) reject(unavailable());
        else resolve(value);
      }
      const abort = () => finish();
      signal?.addEventListener("abort", abort, { once: true });
      socket.setTimeout(operation === "provider" ? 20_000 : 2000, () =>
        finish(),
      );
      socket.on("error", () => finish());
      socket.on("end", () => finish());
      socket.once("connect", () =>
        socket.write(
          JSON.stringify({ ...payload, operation, profileId }) + "\n",
        ),
      );
      socket.on("data", (chunk) => {
        if (
          data.length + chunk.length >
          (operation === "provider" ? MAX_PROVIDER_RESPONSE : MAX_FRAME)
        ) {
          finish();
          return;
        }
        data = Buffer.concat([data, chunk]);
        const newline = data.indexOf(10);
        if (newline < 0) return;
        try {
          finish(JSON.parse(data.subarray(0, newline).toString("utf8")));
        } catch {
          finish();
        }
      });
    });
  } catch {
    throw unavailable();
  }
}
/** Only normalized data and state cross this socket; credentials stay in the broker. */
export async function requestRosterProvider(
  directory: string,
  profileId: string,
  sessionId: string,
  method: "status" | "getMany" | "disconnect",
  parameters: {
    numbers?: string[];
    updatedSince?: string;
    signal?: AbortSignal;
  } = {},
): Promise<unknown> {
  const result = (await request(
    directory,
    profileId,
    "provider",
    {
      sessionId,
      method,
      ...(parameters.numbers ? { numbers: parameters.numbers } : {}),
      ...(parameters.updatedSince
        ? { updatedSince: parameters.updatedSince }
        : {}),
    },
    parameters.signal,
  )) as {
    ok?: boolean;
    data?: unknown;
    error?: { code?: string; retryAfterMs?: number };
  };
  if (result?.ok === true) return result.data;
  const known = [
    "INVALID_INPUT",
    "AUTH_REQUIRED",
    "FORBIDDEN",
    "RATE_LIMITED",
    "UNAVAILABLE",
    "UNSUPPORTED",
    "CONFLICT",
    "STORAGE_ERROR",
    "LIVE_ACCESS_DISABLED",
  ];
  const code = known.includes(result?.error?.code ?? "")
    ? (result.error!.code as AppError["code"])
    : "UNAVAILABLE";
  const retry = result?.error?.retryAfterMs;
  throw new AppError(
    code,
    "Local provider operation failed.",
    typeof retry === "number" && Number.isFinite(retry) && retry >= 0
      ? retry
      : undefined,
  );
}
export async function getRosterKeyLease(
  directory: string,
  profileId: string,
): Promise<RosterKeyLease> {
  const result = (await request(directory, profileId, "lease")) as Record<
    string,
    unknown
  >;
  if (
    !result ||
    result.profileId !== profileId ||
    typeof result.sessionId !== "string" ||
    !/^[0-9a-f-]{36}$/.test(result.sessionId) ||
    typeof result.key !== "string" ||
    !/^[A-Za-z0-9+/]{43}=$/.test(result.key) ||
    result.rosterDirectory !== join(await realpath(directory), "roster") ||
    typeof result.expiresAt !== "number" ||
    !Number.isFinite(result.expiresAt) ||
    result.expiresAt <= Date.now() ||
    result.expiresAt > Date.now() + 3_601_000
  )
    throw unavailable();
  const key = Buffer.from(result.key, "base64");
  delete result.key;
  return {
    profileId,
    sessionId: result.sessionId,
    rosterDirectory: result.rosterDirectory,
    key,
    expiresAt: result.expiresAt,
    dispose() {
      key.fill(0);
    },
  };
}
export async function lockRosterSession(directory: string, profileId: string) {
  const result = (await request(directory, profileId, "lock")) as {
    locked?: boolean;
  };
  if (result?.locked !== true) throw unavailable();
}

// The MCP process keeps this connection open and exits when it is closed.
// A lease alone never implies that an unlocked session is still active.
export async function watchRosterSession(
  directory: string,
  profileId: string,
  onLocked: () => void,
) {
  const path = await endpointPath(directory);
  return await new Promise<{
    sessionId: string;
    expiresAt: number;
    close(): void;
  }>((resolve, reject) => {
    const socket = createConnection(path);
    let active = false,
      intentional = false,
      notified = false;
    let data = "";
    const fail = () => {
      socket.destroy();
      if (intentional || notified) return;
      notified = true;
      if (active) onLocked();
      else reject(unavailable());
    };
    socket.setTimeout(2000, fail);
    socket.on("error", fail);
    socket.on("close", fail);
    socket.once("connect", () =>
      socket.write(JSON.stringify({ operation: "watch", profileId }) + "\n"),
    );
    socket.on("data", (chunk) => {
      if (active || data.length + chunk.length > MAX_FRAME) {
        fail();
        return;
      }
      data += chunk.toString("utf8");
      if (!data.includes("\n")) return;
      try {
        const ack = JSON.parse(data.split("\n")[0]!);
        if (
          ack.watching !== true ||
          typeof ack.sessionId !== "string" ||
          !/^[0-9a-f-]{36}$/.test(ack.sessionId) ||
          !Number.isFinite(ack.expiresAt) ||
          ack.expiresAt <= Date.now()
        )
          throw unavailable();
        active = true;
        data = "";
        socket.setTimeout(0);
        resolve({
          sessionId: ack.sessionId,
          expiresAt: ack.expiresAt,
          close() {
            intentional = true;
            socket.destroy();
          },
        });
      } catch {
        fail();
      }
    });
  });
}
