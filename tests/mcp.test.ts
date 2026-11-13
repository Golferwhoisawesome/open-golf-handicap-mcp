import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generateKeyPair, SignJWT } from "jose";
import { createService } from "../src/server/bootstrap.js";
import { createMcpServer } from "../src/tools/register.js";
import { createHttpApp } from "../src/server/http-app.js";
import { localVerifier, oauthVerifier } from "../src/server/auth.js";
const principal = {
  subject: "synthetic-owner",
  scopes: ["roster:read", "roster:write"],
};
const required = [
  "get_golfer_handicap",
  "get_multiple_handicaps",
  "get_handicap_history",
  "get_recent_scores",
  "get_course_handicap",
  "save_golfer",
  "save_multiple_golfers",
  "get_saved_golfers",
  "update_saved_golfer",
  "remove_saved_golfer",
  "refresh_saved_handicaps",
  "get_handicap_changes",
  "export_golfer_roster",
  "delete_golfer_roster",
  "get_connection_status",
];
test("official SDK discovers schemas and executes full synthetic import/refresh/export/delete workflow", async () => {
  const service = createService({ OGH_PROVIDER: "mock", OGH_STORAGE: "mock" }),
    server = createMcpServer(service, principal),
    client = new Client({ name: "synthetic-test", version: "1" }),
    [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const tools = (await client.listTools()).tools;
    for (const name of required) {
      const t = tools.find((t) => t.name === name);
      assert.ok(t);
      assert.ok(t.outputSchema);
    }
    assert.equal(
      tools.find((t) => t.name === "save_golfer")!.annotations!.readOnlyHint,
      false,
    );
    const golfers = [
      { name: "Demo Alpha", ghinNumber: "900000001" },
      { name: "Demo Beta", ghinNumber: "900000002" },
    ];
    const preview = await client.callTool({
      name: "save_multiple_golfers",
      arguments: { golfers },
    });
    const token = (preview.structuredContent as any).data.confirmationToken;
    assert.equal(
      (await client.callTool({ name: "get_saved_golfers", arguments: {} }))
        .isError,
      undefined,
    );
    const saved = await client.callTool({
      name: "save_multiple_golfers",
      arguments: { golfers, confirmed: true, confirmationToken: token },
    });
    assert.equal((saved.structuredContent as any).data.added.length, 2);
    const refresh = await client.callTool({
      name: "refresh_saved_handicaps",
      arguments: {},
    });
    assert.equal((refresh.structuredContent as any).data.checked, 2);
    const exported = await client.callTool({
      name: "export_golfer_roster",
      arguments: {},
    });
    assert.equal(
      (exported.structuredContent as any).data.roster.golfers.length,
      2,
    );
    const invalid = await client.callTool({
      name: "get_golfer_handicap",
      arguments: { ghinNumber: "invalid" },
    });
    assert.equal(invalid.isError, true);
    const unknown = await client.callTool({
      name: "get_golfer_handicap",
      arguments: { ghinNumber: "123456789" },
    });
    assert.equal((unknown.structuredContent as any).data.result.ok, false);
    const deletion = await client.callTool({
      name: "delete_golfer_roster",
      arguments: {},
    });
    await client.callTool({
      name: "delete_golfer_roster",
      arguments: {
        confirmed: true,
        confirmationToken: (deletion.structuredContent as any).data
          .confirmationToken,
      },
    });
    assert.equal((await service.list(principal)).golfers.length, 0);
  } finally {
    await client.close();
    await server.close();
  }
});
test("Streamable HTTP authenticates, rejects origins/hosts/oversized bodies, and exposes no raw logs", async () => {
  const token = "synthetic-test-token-with-32-characters",
    logs: unknown[] = [];
  let app: ReturnType<typeof createHttpApp>;
  const server = createServer((req, res) => app(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port,
    url = `http://127.0.0.1:${port}/mcp`;
  app = createHttpApp(createService({}), {
    publicUrl: url,
    verifier: localVerifier(token),
    logger: (r) => logs.push(r),
  });
  const client = new Client({ name: "http-test", version: "1" });
  try {
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            origin: "https://untrusted.example",
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      await new Promise<number | undefined>((resolve, reject) => {
        const req = request(
          url,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              host: "evil.example",
              "content-type": "application/json",
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on("error", reject);
        req.end("{}");
      }),
      403,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ blob: "x".repeat(70000) }),
        })
      ).status,
      413,
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    assert.ok((await client.listTools()).tools.length >= 15);
    const status = await client.callTool({
      name: "get_connection_status",
      arguments: {},
    });
    assert.equal(
      (status.structuredContent as any).data.liveAccessEnabled,
      false,
    );
    assert.equal(
      (await fetch(url, { headers: { authorization: `Bearer ${token}` } }))
        .status,
      405,
    );
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(token));
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("OAuth verifies audience, issuer, expiry, allowlist, scopes and signature", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const issuer = "https://auth.example",
    audience = "https://mcp.example/mcp";
  const verify = oauthVerifier(
    {
      issuer,
      audience,
      jwksUrl: "https://auth.example/jwks",
      allowedSubjects: ["owner", "other"],
    },
    async () => publicKey,
  );
  async function token(
    opts: {
      aud?: string;
      iss?: string;
      sub?: string;
      exp?: number;
      scope?: string;
    } = {},
  ) {
    return new SignJWT({ scope: opts.scope ?? "roster:read roster:write" })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject(opts.sub ?? "owner")
      .setIssuer(opts.iss ?? issuer)
      .setAudience(opts.aud ?? audience)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? Math.floor(Date.now() / 1000) + 300)
      .sign(privateKey);
  }
  const valid = await verify.verifyAccessToken(await token());
  assert.deepEqual(valid.scopes, ["roster:read", "roster:write"]);
  for (const options of [
    { aud: "https://other.example" },
    { iss: "https://other.example" },
    { sub: "outsider" },
    { exp: 1 },
    { scope: "roster:write" },
  ])
    await assert.rejects(verify.verifyAccessToken(await token(options)));
  await assert.rejects(verify.verifyAccessToken("not-a-token"));
  const a = valid.extra!.subject as string,
    b = (await verify.verifyAccessToken(await token({ sub: "other" }))).extra!
      .subject as string;
  const service = createService({});
  await service.save(
    { subject: a, scopes: valid.scopes },
    { name: "Demo", ghinNumber: "900000001" },
  );
  assert.equal(
    (await service.list({ subject: b, scopes: valid.scopes })).golfers.length,
    0,
  );
});
test("read-only scope cannot mutate through MCP, and startup cannot enable live GHIN", async () => {
  assert.throws(() => createService({ OGH_PROVIDER: "spicygolf" }), /disabled/);
  const service = createService({}),
    server = createMcpServer(service, {
      ...principal,
      scopes: ["roster:read"],
    }),
    client = new Client({ name: "readonly-test", version: "1" }),
    [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const result = await client.callTool({
      name: "save_golfer",
      arguments: { name: "Demo", ghinNumber: "900000001" },
    });
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as any).error.code, "FORBIDDEN");
  } finally {
    await client.close();
    await server.close();
  }
});
test("stdio SDK handshake and tool call work with synthetic-only child process", async () => {
  const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/server/stdio.ts"],
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        OGH_PROVIDER: "mock",
        OGH_STORAGE: "mock",
      },
      stderr: "pipe",
    }),
    client = new Client({ name: "stdio-test", version: "1" });
  await client.connect(transport);
  try {
    assert.equal((await client.listTools()).tools.length, 16);
    const response = await client.callTool({
      name: "get_connection_status",
      arguments: {},
    });
    assert.equal(
      (response.structuredContent as any).data.liveAccessEnabled,
      false,
    );
  } finally {
    await client.close();
  }
});

test("HTTP OAuth discovery, separate user contexts, write scopes and rate limits work together", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const issuer = "https://auth.example";
  let app: ReturnType<typeof createHttpApp>;
  const listener = createServer((req, res) => app(req, res));
  await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(listener.address() as any).port}/mcp`;
  const verifier = oauthVerifier(
      {
        issuer,
        audience: url,
        jwksUrl: "https://auth.example/jwks",
        allowedSubjects: ["alice", "bob", "reader"],
      },
      async () => publicKey,
    ),
    service = createService({});
  app = createHttpApp(service, {
    publicUrl: url,
    issuer,
    verifier,
    requestsPerMinute: 8,
    logger: () => {},
  });
  const clients: Client[] = [];
  async function connect(subject: string, scope = "roster:read roster:write") {
    const token = await new SignJWT({ scope })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject(subject)
      .setIssuer(issuer)
      .setAudience(url)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const client = new Client({ name: subject, version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(client);
    return { client, token };
  }
  try {
    const challenge = await fetch(url, { method: "POST", body: "{}" });
    assert.equal(challenge.status, 401);
    assert.match(
      challenge.headers.get("www-authenticate")!,
      /resource_metadata/,
    );
    const meta = await (
      await fetch(new URL("/.well-known/oauth-protected-resource/mcp", url))
    ).json();
    assert.equal(meta.resource, url);
    assert.deepEqual(meta.authorization_servers, [issuer]);
    const [a, b, r] = await Promise.all([
      connect("alice"),
      connect("bob"),
      connect("reader", "roster:read"),
    ]);
    await a.client.callTool({
      name: "save_golfer",
      arguments: { name: "Demo private Alpha", ghinNumber: "900000001" },
    });
    assert.equal(
      (
        (await b.client.callTool({ name: "get_saved_golfers", arguments: {} }))
          .structuredContent as any
      ).data.golfers.length,
      0,
    );
    assert.equal(
      (
        (await a.client.callTool({ name: "get_saved_golfers", arguments: {} }))
          .structuredContent as any
      ).data.golfers.length,
      1,
    );
    const denied = await r.client.callTool({
      name: "save_golfer",
      arguments: { name: "Demo read-only", ghinNumber: "900000002" },
    });
    assert.equal(denied.isError, true);
    assert.equal((denied.structuredContent as any).error.code, "FORBIDDEN");
    let limited = false;
    for (let i = 0; i < 10; i++) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${b.token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      if (response.status === 429) {
        assert.equal(response.headers.get("retry-after"), "60");
        limited = true;
        break;
      }
    }
    assert.equal(limited, true);
  } finally {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    listener.closeAllConnections();
    await new Promise<void>((r) => listener.close(() => r()));
  }
});
