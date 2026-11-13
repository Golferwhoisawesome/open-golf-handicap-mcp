import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { RosterService } from "../domain/roster-service.js";
import { createMcpServer } from "../tools/register.js";
export interface HttpOptions {
  publicUrl: string;
  verifier: OAuthTokenVerifier;
  issuer?: string;
  allowedOrigins?: string[];
  requestsPerMinute?: number;
  logger?: (record: {
    event: string;
    requestId: string;
    status: number;
  }) => void;
}
export function createHttpApp(service: RosterService, options: HttpOptions) {
  const url = new URL(options.publicUrl),
    app = express(),
    log =
      options.logger ??
      ((record) => process.stderr.write(JSON.stringify(record) + "\n"));
  if (
    url.pathname !== "/mcp" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("Public URL must end in /mcp");
  const metadataUrl = new URL(
    "/.well-known/oauth-protected-resource/mcp",
    url,
  ).toString();
  const buckets = new Map<string, { until: number; count: number }>();
  const limit = (key: string, max: number) => {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= now) {
      for (const [k, v] of buckets) if (v.until <= now) buckets.delete(k);
      if (!buckets.has(key) && buckets.size >= 2000) return false;
      bucket = { until: now + 60000, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count++;
    return bucket.count <= max;
  };
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const requestId = randomUUID();
    res.once("finish", () =>
      log({ event: "http_request", requestId, status: res.statusCode }),
    );
    if (req.headers.host !== url.host) {
      res.status(403).json({ error: "Invalid host" });
      return;
    }
    const origin = req.headers.origin;
    if (origin && !options.allowedOrigins?.includes(origin)) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    if (!limit("ip:" + req.socket.remoteAddress, 300)) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "Rate limited" });
      return;
    }
    next();
  });
  app.get("/healthz", (_req, res) =>
    res.json({ status: "ok", provider: "mock", liveAccessEnabled: false }),
  );
  if (options.issuer) {
    const metadata = {
      resource: options.publicUrl,
      authorization_servers: [options.issuer],
      scopes_supported: ["roster:read", "roster:write"],
      bearer_methods_supported: ["header"],
    };
    app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) =>
      res.json(metadata),
    );
    app.get("/.well-known/oauth-protected-resource", (_req, res) =>
      res.json(metadata),
    );
  }
  app.use(
    "/mcp",
    requireBearerAuth({
      verifier: options.verifier,
      ...(options.issuer
        ? { expectedResource: url, resourceMetadataUrl: metadataUrl }
        : {}),
      requiredScopes: ["roster:read"],
    }),
  );
  app.use("/mcp", (req, res, next) => {
    if (
      !limit(
        "user:" + String(req.auth?.extra?.subject),
        options.requestsPerMinute ?? 60,
      )
    ) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "Rate limited" });
      return;
    }
    next();
  });
  app.post(
    "/mcp",
    express.json({ limit: "64kb", strict: true }),
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        const subject = req.auth?.extra?.subject;
        if (typeof subject !== "string" || !subject) {
          res.status(403).json({ error: "Missing subject" });
          return;
        }
        const server = createMcpServer(service, {
            subject,
            scopes: req.auth!.scopes,
          }),
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });
        res.once("close", () => {
          void server.close().catch(() => {});
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      })().catch(next);
    },
  );
  app.all("/mcp", (_req, res) => {
    res.setHeader("Allow", "POST");
    res
      .status(405)
      .json({ error: "Method not allowed for this stateless transport" });
  });
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const e = error as { type?: string };
      if (!res.headersSent)
        res
          .status(
            e.type === "entity.too.large"
              ? 413
              : e instanceof SyntaxError
                ? 400
                : 500,
          )
          .json({ error: "Request could not be processed" });
    },
  );
  return app;
}
