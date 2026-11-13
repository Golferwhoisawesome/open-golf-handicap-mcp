import { parentPort, workerData } from "node:worker_threads";
import net from "node:net";
import dgram from "node:dgram";
import {
  assertLiveAccessEnabled,
  setLiveAccessForTesting,
} from "./live-access.js";
import {
  DEFAULT_COOLDOWN_MS,
  SessionRequestPolicy,
  UNLIMITED_ALLOWANCE,
  validAllowance,
  type RequestKind,
} from "./request-policy.js";
import {
  CONTROLLED_TEST_MAX_SESSION_MS,
  ControlledTestPolicy,
  type ControlledStopReason,
} from "./controlled-test-policy.js";
import {
  createSdkFixtureFetch,
  fixtureScenarios,
  isSyntheticSdkPassword,
  isSdkFixtureIdentifier,
  type SdkFixtureScenario,
} from "./spicygolf-sdk-fixtures.js";

// Conservative local pacing, not a GHIN-approved quota. No runtime override.
const MIN_REQUEST_INTERVAL_MS = 2000;

// Only this isolated worker replaces fetch. The host's fetch is never mutated.
const port = parentPort;
if (!port) throw new Error("SDK worker requires its private parent.");
const mode = workerData.mode as "ghin" | "offline-test";
// Worker threads load their own module instance; mirror a test-only disable.
if (workerData.liveAccessDisabledForTesting === true)
  setLiveAccessForTesting(false);
const denyOfflineNetwork = (): never => {
  throw new Error("Network is unavailable in the synthetic SDK worker");
};
if (mode === "offline-test") {
  net.Socket.prototype.connect = denyOfflineNetwork;
  dgram.createSocket = denyOfflineNetwork;
}
const nativeFetch =
  mode === "ghin"
    ? globalThis.fetch.bind(globalThis)
    : async (): Promise<Response> => denyOfflineNetwork();
const credentials = workerData.credentials as {
  username: Uint8Array;
  password: Uint8Array;
  ownGhinNumber: string;
  accountType: "golfer" | "api";
};
const usernameBytes = Buffer.from(credentials.username),
  passwordBytes = Buffer.from(credentials.password);
// SDK0.20.1 trims its configuration strings. Retain exact password bytes only
// in this worker so the allowlisted login gateway can restore them unchanged.
const exactPassword = Buffer.from(passwordBytes);
credentials.username.fill(0);
credentials.password.fill(0);
const timeoutMs = workerData.timeoutMs as number,
  maxSessionMs = workerData.maxSessionMs as number;
const controlledTest = workerData.controlledTest === true;
const policy = controlledTest
  ? new ControlledTestPolicy(credentials.ownGhinNumber)
  : undefined;
const requestPolicy = new SessionRequestPolicy(
  validAllowance(workerData.allowance)
    ? workerData.allowance
    : UNLIMITED_ALLOWANCE,
);
const expiresAt = Date.now() + maxSessionMs;
const fixture =
  mode === "offline-test"
    ? createSdkFixtureFetch(
        workerData.fixtureScenario as SdkFixtureScenario,
        credentials.ownGhinNumber,
        () => exactPassword,
      )
    : undefined;
let stopped = false,
  forbidden = false,
  invalidToken = false,
  cooldownUntil = requestPolicy.cooldownUntil,
  localLimit = false,
  blockedRequests = 0;
let lastStarted: number | undefined;
let token: string | undefined;
let activeId: number | undefined,
  terminalReplied = false;
const controllers = new Set<AbortController>();
const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
function stop() {
  stopped = true;
  token = undefined;
  usernameBytes.fill(0);
  passwordBytes.fill(0);
  exactPassword.fill(0);
  for (const controller of controllers) controller.abort();
  controllers.clear();
}
function guard() {
  if (Date.now() >= expiresAt) halt("session_expired");
  if (stopped || Date.now() >= expiresAt || policy?.halted)
    throw new Error("Session unavailable");
  if (mode === "ghin") assertLiveAccessEnabled();
}
/** Nonsecret usage events for the persistent local ledger. */
function publishUsage(event: {
  request?: RequestKind;
  cooldownUntil?: number;
  forbidden?: true;
}) {
  port!.postMessage({ id: 0, ok: true, usage: { ...event, at: Date.now() } });
}
function publishDiagnostics() {
  if (policy)
    port!.postMessage({
      id: 0,
      ok: true,
      stats: stats(),
      diagnostics: policy.diagnostics(),
    });
}
function notifyTerminal() {
  if (!policy?.halted || terminalReplied || activeId === undefined) return;
  terminalReplied = true;
  const diagnostics = policy.diagnostics();
  // Return immediately, before the SDK can hide the first error by retrying.
  port!.postMessage({
    id: activeId,
    ok: false,
    terminal: true,
    error: {
      code: "AUTHENTICATION_ERROR",
      ...(diagnostics.lastStatus !== null
        ? { statusCode: diagnostics.lastStatus }
        : {}),
    },
    stats: stats(),
    diagnostics,
  });
}
function halt(reason: ControlledStopReason) {
  policy?.stop(reason);
  notifyTerminal();
}
function retryMilliseconds(value: string | null): number {
  if (value && /^\d+(?:\.\d+)?$/.test(value)) {
    const ms = Number(value) * 1000;
    return Number.isSafeInteger(Math.ceil(ms))
      ? Math.ceil(ms)
      : Number.MAX_SAFE_INTEGER;
  }
  if (value) {
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return DEFAULT_COOLDOWN_MS;
}
function validateJsonShape(value: unknown) {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++nodes > 50_000 || item.depth > 20)
      throw new Error("Bounded response rejected");
    if (typeof item.value === "string" && item.value.length > 65_536)
      throw new Error("Bounded response rejected");
    if (item.value && typeof item.value === "object") {
      const values = Object.values(item.value);
      if (values.length > 2500) throw new Error("Bounded response rejected");
      stack.push(...values.map((value) => ({ value, depth: item.depth + 1 })));
    }
  }
}
async function boundedResponse(response: Response): Promise<Response> {
  const maximum = 512 * 1024,
    declared = response.headers.get("content-length");
  if (declared && Number(declared) > maximum) {
    await response.body?.cancel();
    throw new Error("Bounded response rejected");
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > maximum) throw new Error("Bounded response rejected");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let payload: unknown;
  try {
    payload = JSON.parse(text);
    validateJsonShape(payload);
  } catch {
    halt("invalid_response");
    return json({ error: "Invalid bounded upstream response" }, 502);
  }
  if (
    policy &&
    typeof payload === "object" &&
    payload !== null &&
    "golfers" in payload
  ) {
    const rows = (payload as { golfers: unknown }).golfers;
    if (Array.isArray(rows)) policy.rows(rows.length);
  }
  return json(
    payload,
    response.status,
    response.headers.has("Retry-After")
      ? { "Retry-After": response.headers.get("Retry-After")! }
      : {},
  );
}
globalThis.fetch = async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  try {
    if (policy?.halted) {
      blockedRequests++;
      notifyTerminal();
      return json({ error: "Controlled test stopped" }, 403);
    }
    guard();
    if (typeof input !== "string" && !(input instanceof URL)) {
      halt("invalid_request");
      throw new Error("Unsupported request shape");
    }
    const url = new URL(String(input)),
      method = (init?.method ?? "GET").toUpperCase();
    const api = url.origin === "https://api2.ghin.com";
    const installation =
      url.origin === "https://firebaseinstallations.googleapis.com" &&
      url.pathname === "/v1/projects/ghin-mobile-app/installations" &&
      credentials.accountType === "golfer" &&
      method === "POST";
    const login =
      api &&
      method === "POST" &&
      url.pathname ===
        (credentials.accountType === "api"
          ? "/api/v1/users/login.json"
          : "/api/v1/golfer_login.json");
    const read =
      api && method === "GET" && url.pathname === "/api/v1/golfers/search.json";
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.toString().length > 8192 ||
      !(installation || login || read)
    ) {
      halt("invalid_request");
      throw new Error("Endpoint is not permitted");
    }
    if (login) {
      if (typeof init?.body !== "string" || init.body.length > 8192)
        throw new Error("Invalid login body");
      const body = JSON.parse(init.body);
      if (!body.user || typeof body.user.password !== "string")
        throw new Error("Invalid login body");
      body.user.password = exactPassword.toString("utf8");
      init = { ...init, body: JSON.stringify(body) };
    }
    if (forbidden) {
      blockedRequests++;
      return json({ error: "Access revoked" }, 403);
    }
    if (Date.now() < cooldownUntil) {
      blockedRequests++;
      return json({ error: "Provider cooldown" }, 429, {
        "Retry-After": String(Math.ceil((cooldownUntil - Date.now()) / 1000)),
      });
    }
    // Requests, including SDK-internal retries, share this gateway. The command
    // queue serializes callers; minimum spacing therefore applies to all HTTP.
    // Monotonic time resists wall-clock jumps; recheck early timer wakeups.
    while (lastStarted !== undefined) {
      guard();
      const wait = MIN_REQUEST_INTERVAL_MS - (performance.now() - lastStarted);
      if (wait <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.ceil(wait)));
    }
    guard();
    const kind: RequestKind = installation
      ? "installation"
      : login
        ? "login"
        : "search";
    try {
      policy?.beforeRequest(kind, url);
    } catch {
      notifyTerminal();
      throw new Error("Controlled test request rejected");
    }
    if (!requestPolicy.admit(kind)) {
      blockedRequests++;
      if (requestPolicy.limitReached) {
        localLimit = true;
        return json({ error: "Local request limit reached" }, 429, {
          "Retry-After": "3600",
        });
      }
      throw new Error("Retry limit reached");
    }
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const pendingFetch = fixture
        ? fixture.fetch(url, {
            ...init,
            signal: controller.signal,
            redirect: "error",
          })
        : nativeFetch(url, {
            ...init,
            signal: controller.signal,
            redirect: "error",
          });
      // Record after dispatch so the next start is never earlier than the
      // minimum interval after this actual transport invocation.
      lastStarted = performance.now();
      publishUsage({ request: kind });
      publishDiagnostics();
      let response: Response;
      try {
        response = await pendingFetch;
      } catch (error) {
        requestPolicy.outcome(false);
        throw error;
      }
      requestPolicy.outcome(response.ok);
      policy?.response(response.status);
      if (policy?.halted) {
        notifyTerminal();
        await response.body?.cancel().catch(() => undefined);
        return json({ error: "Controlled test stopped" }, response.status);
      }
      guard();
      if (response.status === 403) {
        forbidden = true;
        publishUsage({ forbidden: true });
      }
      if (response.status === 429) {
        const delay = retryMilliseconds(response.headers.get("Retry-After"));
        cooldownUntil = Math.min(
          Number.MAX_SAFE_INTEGER,
          Date.now() + Math.max(delay, 60_000),
        );
        publishUsage({ cooldownUntil });
      }
      let bounded: Response;
      try {
        bounded = await boundedResponse(response);
      } catch {
        halt("invalid_response");
        throw new Error("Invalid bounded upstream response");
      }
      publishDiagnostics();
      return bounded;
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  } catch {
    halt("transport_error");
    throw new Error("Private transport did not complete");
  }
};

let client:
  | InstanceType<typeof import("@spicygolf/ghin").GhinClient>
  | undefined;
let startupError: { code: string; statusCode?: number } | undefined;
try {
  if (
    !["offline-test", "ghin"].includes(mode) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 50 ||
    timeoutMs > 30_000 ||
    !Number.isInteger(maxSessionMs) ||
    maxSessionMs < 100 ||
    maxSessionMs > 3_600_000 ||
    (workerData.controlledTest !== undefined &&
      typeof workerData.controlledTest !== "boolean") ||
    (controlledTest &&
      (maxSessionMs > CONTROLLED_TEST_MAX_SESSION_MS ||
        credentials.accountType !== "golfer")) ||
    !/^[1-9]\d{5,9}$/.test(credentials.ownGhinNumber) ||
    !["golfer", "api"].includes(credentials.accountType)
  )
    throw new Error("Invalid session");
  guard();
  const username = usernameBytes.toString("utf8"),
    password = passwordBytes.toString("utf8");
  if (
    username.length < 1 ||
    username.length > 254 ||
    password.length < 1 ||
    password.length > 1024 ||
    username.trim() !== username ||
    /\p{Cc}/u.test(username + password) ||
    !Buffer.from(username).equals(usernameBytes) ||
    !Buffer.from(password).equals(passwordBytes)
  )
    throw new Error("Invalid credentials");
  if (
    mode === "offline-test" &&
    (!fixtureScenarios.includes(workerData.fixtureScenario) ||
      !/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.invalid$/.test(username) ||
      !isSyntheticSdkPassword(passwordBytes) ||
      !/^90000000[1-5]$/.test(credentials.ownGhinNumber))
  )
    throw new Error("Offline fixture credentials only");
  if (
    mode === "ghin" &&
    (/\.invalid$/i.test(username) ||
      isSdkFixtureIdentifier(credentials.ownGhinNumber))
  )
    throw new Error("Synthetic identities cannot be used with GHIN");
  const { GhinClient } = await import("@spicygolf/ghin");
  client = new GhinClient({
    username,
    // The unmodified SDK trims strings. It receives a non-secret placeholder;
    // the allowlisted login gateway supplies the user's exact UTF-8 bytes.
    password: "private-password-supplied-by-gateway",
    apiAccess: credentials.accountType === "api",
    baseUrl: "https://api2.ghin.com/api",
    apiVersion: "v1",
    cache: {
      read: () => token,
      write: (next: string) => {
        try {
          if (next.length > 16_384) throw new Error();
          const payload = JSON.parse(
            Buffer.from(next.split(".")[1] ?? "", "base64url").toString("utf8"),
          );
          if (
            typeof payload.exp !== "number" ||
            !Number.isFinite(payload.exp) ||
            payload.exp * 1000 <= Date.now()
          )
            throw new Error();
          token = next;
        } catch {
          invalidToken = true;
          throw new Error("Invalid session token");
        }
      },
    },
    onDegraded: () => {
      halt("invalid_response");
    },
  });
} catch (error) {
  startupError = {
    code:
      typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code
        : "INVALID_INPUT",
  };
} finally {
  usernameBytes.fill(0);
  passwordBytes.fill(0);
}

function safeSdkError(error: unknown) {
  const candidate = error as {
    code?: unknown;
    statusCode?: unknown;
    retryAfter?: unknown;
  };
  if (localLimit && !invalidToken && !forbidden)
    return { code: "LOCAL_LIMIT_ERROR", statusCode: 429, retryAfter: 3600 };
  return {
    code: invalidToken
      ? "AUTHENTICATION_ERROR"
      : forbidden
        ? "AUTHENTICATION_ERROR"
        : typeof candidate?.code === "string" &&
            [
              "AUTHENTICATION_ERROR",
              "RATE_LIMIT_ERROR",
              "NETWORK_ERROR",
              "VALIDATION_ERROR",
              "CACHE_ERROR",
            ].includes(candidate.code)
          ? candidate.code
          : "NETWORK_ERROR",
    ...(invalidToken
      ? { statusCode: 401 }
      : forbidden
        ? { statusCode: 403 }
        : typeof candidate?.statusCode === "number"
          ? [401, 403, 429].includes(candidate.statusCode)
            ? { statusCode: candidate.statusCode }
            : {}
          : {}),
    ...(typeof candidate?.retryAfter === "number" &&
    Number.isFinite(candidate.retryAfter) &&
    candidate.retryAfter >= 0
      ? { retryAfter: candidate.retryAfter }
      : {}),
  };
}
function stats() {
  return {
    ...(fixture?.stats ?? {
      installationRequests: 0,
      loginRequests: 0,
      batchRequests: 0,
    }),
    blockedRequests,
  };
}
let connected = false,
  queue = Promise.resolve();
port.on(
  "message",
  (message: {
    id: number;
    operation: string;
    args?: {
      numbers?: number[];
      request?: { status: null; updated_since?: string };
    };
  }) => {
    if (message.operation === "close") {
      stop();
      client = undefined;
      port.close();
      return;
    }
    queue = queue
      .then(async () => {
        activeId = message.id;
        terminalReplied = false;
        localLimit = false;
        requestPolicy.startCommand();
        let result: {
          ok: boolean;
          value?: unknown;
          error?: { code: string; statusCode?: number; retryAfter?: number };
        };
        try {
          guard();
          if (startupError) {
            result = { ok: false, error: startupError };
          } else if (!client)
            result = { ok: false, error: { code: "NETWORK_ERROR" } };
          else if (message.operation === "connect" && !connected) {
            const verified = await client.golfers.getMany(
              [Number(credentials.ownGhinNumber)],
              { status: null },
            );
            guard();
            if (verified.isErr())
              result = { ok: false, error: safeSdkError(verified.error) };
            else if (
              !verified.value.golfers.some(
                (row: { ghin: unknown }) =>
                  String(row.ghin) === credentials.ownGhinNumber,
              )
            )
              result = {
                ok: false,
                error: { code: "AUTHENTICATION_ERROR", statusCode: 401 },
              };
            else {
              connected = true;
              result = { ok: true, value: { expiresAt } };
            }
          } else if (message.operation === "getMany" && connected) {
            const numbers = message.args?.numbers,
              request = message.args?.request;
            if (
              !Array.isArray(numbers) ||
              numbers.length < 1 ||
              numbers.length > 500 ||
              numbers.some(
                (number) =>
                  !Number.isSafeInteger(number) ||
                  !/^[1-9]\d{5,9}$/.test(String(number)),
              ) ||
              request?.status !== null ||
              (request.updated_since !== undefined &&
                !/^\d{4}-\d{2}-\d{2}$/.test(request.updated_since))
            ) {
              halt("invalid_request");
              throw new Error("Invalid lookup");
            }
            if (
              policy &&
              (numbers.length !== 1 ||
                String(numbers[0]) !== credentials.ownGhinNumber ||
                request.updated_since !== undefined)
            ) {
              halt("invalid_request");
              throw new Error("Controlled test identifier rejected");
            }
            if (
              mode === "ghin" &&
              numbers.some((number) => isSdkFixtureIdentifier(String(number)))
            )
              throw new Error("Synthetic identifiers cannot be sent to GHIN");
            const response = await client.golfers.getMany(numbers, request);
            guard();
            result = response.isErr()
              ? { ok: false, error: safeSdkError(response.error) }
              : { ok: true, value: response.value };
          } else
            result = {
              ok: false,
              error: { code: "AUTHENTICATION_ERROR", statusCode: 401 },
            };
        } catch {
          halt("sdk_error");
          result = { ok: false, error: { code: "NETWORK_ERROR" } };
        }
        if (!result.ok) halt("sdk_error");
        if (!stopped && !terminalReplied)
          port.postMessage({
            id: message.id,
            ...result,
            stats: stats(),
            ...(policy ? { diagnostics: policy.diagnostics() } : {}),
          });
        activeId = undefined;
      })
      .catch(() => {
        stop();
        port.close();
      });
  },
);
