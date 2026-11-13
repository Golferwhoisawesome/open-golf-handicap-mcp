import { createService } from "./bootstrap.js";
import { createHttpApp } from "./http-app.js";
import { localVerifier, oauthVerifier } from "./auth.js";
const env = process.env,
  host = env.OGH_HOST ?? "127.0.0.1",
  port = Number(env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid port");
const local = ["127.0.0.1", "::1", "localhost"].includes(host),
  publicUrl = env.OGH_PUBLIC_URL ?? `http://127.0.0.1:${port}/mcp`;
const oauth = env.OGH_AUTH_MODE === "oauth";
if (!oauth && !local)
  throw new Error(
    "Local bearer authentication must bind to loopback. Configure OAuth for remote hosting.",
  );
if (oauth)
  for (const key of ["OGH_ISSUER", "OGH_JWKS_URL", "OGH_PUBLIC_URL"]) {
    const value = env[key];
    if (!value || new URL(value).protocol !== "https:")
      throw new Error(`${key} must be an HTTPS URL`);
  }
if (!oauth && new URL(publicUrl).protocol !== "http:")
  throw new Error("Local mode requires a loopback HTTP URL");
if (
  !oauth &&
  !["localhost", "127.0.0.1", "[::1]"].includes(new URL(publicUrl).hostname)
)
  throw new Error("Local mode requires a loopback public URL");
if (env.OGH_AUTH_MODE && !["oauth", "local"].includes(env.OGH_AUTH_MODE))
  throw new Error("Invalid authentication mode");
const subjects = (env.OGH_ALLOWED_SUBJECTS ?? "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);
if (oauth && !subjects.length)
  throw new Error("OAuth requires an explicit owner subject allowlist");
if (oauth && env.OGH_STORAGE !== "local")
  throw new Error(
    "Remote mode requires durable user-controlled local storage. Ephemeral memory is local-only.",
  );
const verifier = oauth
  ? oauthVerifier({
      issuer: env.OGH_ISSUER!,
      audience: publicUrl,
      jwksUrl: env.OGH_JWKS_URL!,
      allowedSubjects: subjects,
    })
  : localVerifier(env.OGH_DEV_TOKEN ?? "");
const app = createHttpApp(createService(), {
  publicUrl,
  verifier,
  issuer: oauth ? env.OGH_ISSUER : undefined,
  allowedOrigins: (env.OGH_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
});
const server = app.listen(port, host, () =>
  process.stderr.write(
    JSON.stringify({ event: "listening", host, port, provider: "mock" }) + "\n",
  ),
);
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
