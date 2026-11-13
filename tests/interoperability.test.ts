import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createService } from "../src/server/bootstrap.js";
import { createMcpServer } from "../src/tools/register.js";
import {
  createDemoGolfAppServer,
  demoApplyOutputSchema,
  demoPreviewOutputSchema,
  demoRosterOutputSchema,
  demoUpdateInputSchema,
} from "../src/demo/golf-app-server.js";

async function connect(server: McpServer, name: string) {
  const client = new Client({ name, version: "1" });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function data<S extends z.ZodType>(result: unknown, schema: S): z.output<S> {
  const envelope = z
    .object({
      isError: z.literal(false).optional(),
      structuredContent: z.object({ ok: z.literal(true), data: schema }),
    })
    .parse(result);
  return envelope.structuredContent.data;
}

function assertRejected(result: unknown) {
  assert.equal((result as CallToolResult).isError, true);
}

const syntheticResult = (handicapIndex = 12.4) => ({
  ok: true as const,
  data: {
    ghinNumber: "900000001",
    name: "Synthetic test golfer",
    handicapIndex,
    display: handicapIndex.toFixed(1),
    effectiveDate: "2026-10-01",
    retrievedAt: "2026-10-29T12:00:00.000Z",
    source: "mock",
    freshness: "fresh" as const,
    synthetic: true as const,
  },
});

test("two independent MCP clients coordinate a synthetic app update only after simulation approval", async () => {
  const app = await connect(createDemoGolfAppServer(), "app-coordinator-test");
  const handicap = await connect(
    createMcpServer(
      createService({ OGH_PROVIDER: "mock", OGH_STORAGE: "mock" }),
      {
        subject: "synthetic-interoperability-owner",
        scopes: ["roster:read", "roster:write"],
      },
    ),
    "handicap-coordinator-test",
  );
  try {
    const appTools = (await app.client.listTools()).tools;
    assert.deepEqual(appTools.map((tool) => tool.name).sort(), [
      "apply_handicap_updates",
      "list_players",
      "preview_handicap_updates",
    ]);
    assert.equal(
      appTools.find((tool) => tool.name === "preview_handicap_updates")!
        .annotations!.readOnlyHint,
      true,
    );
    assert.equal(
      appTools.find((tool) => tool.name === "apply_handicap_updates")!
        .annotations!.readOnlyHint,
      false,
    );
    const before = data(
      await app.client.callTool({ name: "list_players", arguments: {} }),
      demoRosterOutputSchema,
    );
    assert.equal(before.revision, 0);
    const lookups = data(
      await handicap.client.callTool({
        name: "get_multiple_handicaps",
        arguments: { ghinNumbers: before.players.map((p) => p.ghinNumber) },
      }),
      z.object({ results: demoUpdateInputSchema.shape.results }),
    );
    assert.equal(lookups.results.filter((r) => r.ok).length, 5);
    assert.equal(lookups.results.filter((r) => !r.ok).length, 1);
    const payload = { synthetic: true, results: lookups.results };
    const preview = data(
      await app.client.callTool({
        name: "preview_handicap_updates",
        arguments: payload,
      }),
      demoPreviewOutputSchema,
    );
    assert.deepEqual(
      preview.updates.map((r) => [
        r.ghinNumber,
        r.previousHandicapIndex,
        r.newHandicapIndex,
      ]),
      [
        ["900000001", 13.1, 12.4],
        ["900000003", 17, 16.2],
        ["900000004", null, 5.9],
        ["900000005", 0.4, -0.9],
      ],
    );
    assert.equal(preview.skipped[0]!.ghinNumber, "900000006");
    assert.equal(preview.skipped[0]!.previousHandicapIndex, 23.6);
    assert.equal(preview.skipped[0]!.newHandicapIndex, null);
    assert.equal(preview.skipped[0]!.status, "failed");

    // A read/lookup/preview sequence grants no permission to mutate the other app.
    assert.deepEqual(
      data(
        await app.client.callTool({ name: "list_players", arguments: {} }),
        demoRosterOutputSchema,
      ),
      before,
    );
    assertRejected(
      await app.client.callTool({
        name: "apply_handicap_updates",
        arguments: { ...payload, confirmationToken: preview.confirmationToken },
      }),
    );
    assertRejected(
      await app.client.callTool({
        name: "apply_handicap_updates",
        arguments: { ...payload, confirmed: true },
      }),
    );
    assert.deepEqual(
      data(
        await app.client.callTool({ name: "list_players", arguments: {} }),
        demoRosterOutputSchema,
      ),
      before,
    );

    // Explicit simulation approval: no human approval is inferred or fabricated.
    const approved = {
      ...payload,
      confirmed: true,
      confirmationToken: preview.confirmationToken,
    };
    const applied = data(
      await app.client.callTool({
        name: "apply_handicap_updates",
        arguments: approved,
      }),
      demoApplyOutputSchema,
    );
    assert.equal(applied.updated.length, 4);
    assert.equal(applied.unchanged.length, 1);
    assert.equal(applied.skipped.length, 1);
    assert.deepEqual(
      applied.players.map((p) => p.handicapIndex),
      [12.4, 8.7, 16.2, 5.9, -0.9, 23.6],
    );
    assert.equal(applied.mode, "synthetic-demo");
    assert.ok(
      applied.players.every(
        (p) => p.synthetic && p.name.startsWith("Synthetic App "),
      ),
    );
    assert.ok(
      applied.updated.every((row) => row.source === "mock" && row.synthetic),
    );
    const after = data(
      await app.client.callTool({ name: "list_players", arguments: {} }),
      demoRosterOutputSchema,
    );
    assert.deepEqual(after.players, applied.players);
    assert.equal(after.revision, 1);
    assertRejected(
      await app.client.callTool({
        name: "apply_handicap_updates",
        arguments: approved,
      }),
    );
    assert.deepEqual(
      data(
        await app.client.callTool({ name: "list_players", arguments: {} }),
        demoRosterOutputSchema,
      ),
      after,
    );

    // Coordination did not create a saved roster in the independent handicap MCP.
    const saved = data(
      await handicap.client.callTool({
        name: "get_saved_golfers",
        arguments: {},
      }),
      z.object({ golfers: z.array(z.unknown()) }),
    );
    assert.deepEqual(saved.golfers, []);
  } finally {
    await handicap.close();
    await app.close();
  }
});

test("demo rejects non-synthetic, unknown-source, duplicate, and malformed results without zeroing prior or missing values", async () => {
  const app = await connect(
    createDemoGolfAppServer(),
    "invalid-synthetic-test",
  );
  try {
    const before = data(
      await app.client.callTool({ name: "list_players", arguments: {} }),
      demoRosterOutputSchema,
    );
    for (const payload of [
      { synthetic: false, results: [syntheticResult()] },
      {
        synthetic: true,
        results: [
          {
            ...syntheticResult(),
            data: { ...syntheticResult().data, synthetic: false },
          },
        ],
      },
      {
        synthetic: true,
        results: [
          {
            ...syntheticResult(),
            data: { ...syntheticResult().data, source: "ghin" },
          },
        ],
      },
      {
        synthetic: true,
        results: [
          {
            ...syntheticResult(),
            data: { ...syntheticResult().data, ghinNumber: "123456789" },
          },
        ],
      },
      {
        synthetic: true,
        results: [
          {
            ...syntheticResult(),
            data: { ...syntheticResult().data, handicapIndex: null },
          },
        ],
      },
      { synthetic: true, results: [syntheticResult(), syntheticResult(10)] },
    ]) {
      assertRejected(
        await app.client.callTool({
          name: "preview_handicap_updates",
          arguments: payload,
        }),
      );
    }
    assert.deepEqual(
      data(
        await app.client.callTool({ name: "list_players", arguments: {} }),
        demoRosterOutputSchema,
      ),
      before,
    );
    const payload = {
      synthetic: true,
      results: [
        {
          ok: false,
          ghinNumber: "900000001",
          error: {
            code: "NO_HANDICAP",
            message: "Synthetic unavailable result.",
          },
        },
      ],
    };
    const preview = data(
      await app.client.callTool({
        name: "preview_handicap_updates",
        arguments: payload,
      }),
      demoPreviewOutputSchema,
    );
    assert.equal(preview.updates.length, 0);
    assert.equal(preview.rows[0]!.status, "failed");
    assert.equal(preview.rows[3]!.status, "not_checked");
    assert.ok(preview.rows.every((row) => row.newHandicapIndex === null));
    const approved = {
      ...payload,
      confirmed: true,
      confirmationToken: preview.confirmationToken,
    };
    const applied = data(
      await app.client.callTool({
        name: "apply_handicap_updates",
        arguments: approved,
      }),
      demoApplyOutputSchema,
    );
    assert.deepEqual(applied.players, before.players);
    assert.equal(applied.players[0]!.handicapIndex, 13.1);
    assert.equal(applied.players[3]!.handicapIndex, null);
    // A no-op consumes its approval too.
    assertRejected(
      await app.client.callTool({
        name: "apply_handicap_updates",
        arguments: approved,
      }),
    );
  } finally {
    await app.close();
  }
});

test("demo approvals reject changed payloads, stale state, expiry, and tokens from another instance", async () => {
  let now = Date.parse("2026-10-29T12:00:00Z");
  const app = await connect(
    createDemoGolfAppServer({ now: () => now }),
    "confirmation-test",
  );
  const another = await connect(
    createDemoGolfAppServer({ now: () => now }),
    "another-demo-instance",
  );
  const payload = { synthetic: true, results: [syntheticResult()] };
  const alternate = { synthetic: true, results: [syntheticResult(11)] };
  try {
    const preview = data(
      await app.client.callTool({
        name: "preview_handicap_updates",
        arguments: payload,
      }),
      demoPreviewOutputSchema,
    );
    const alternatePreview = data(
      await app.client.callTool({
        name: "preview_handicap_updates",
        arguments: alternate,
      }),
      demoPreviewOutputSchema,
    );
    const approved = {
      ...payload,
      confirmed: true,
      confirmationToken: preview.confirmationToken,
    };
    assertRejected(
      await app.client.callTool({
        name: "apply_handicap_updates",
        arguments: {
          ...alternate,
          confirmed: true,
          confirmationToken: preview.confirmationToken,
        },
      }),
    );
    assertRejected(
      await another.client.callTool({
        name: "apply_handicap_updates",
        arguments: approved,
      }),
    );
    data(
      await app.client.callTool({
        name: "apply_handicap_updates",
        arguments: approved,
      }),
      demoApplyOutputSchema,
    );
    assertRejected(
      await app.client.callTool({
        name: "apply_handicap_updates",
        arguments: {
          ...alternate,
          confirmed: true,
          confirmationToken: alternatePreview.confirmationToken,
        },
      }),
    );
    const fresh = data(
      await app.client.callTool({
        name: "preview_handicap_updates",
        arguments: alternate,
      }),
      demoPreviewOutputSchema,
    );
    now += 300_001;
    assertRejected(
      await app.client.callTool({
        name: "apply_handicap_updates",
        arguments: {
          ...alternate,
          confirmed: true,
          confirmationToken: fresh.confirmationToken,
        },
      }),
    );
    assert.equal(
      data(
        await app.client.callTool({ name: "list_players", arguments: {} }),
        demoRosterOutputSchema,
      ).players[0]!.handicapIndex,
      12.4,
    );
  } finally {
    await another.close();
    await app.close();
  }
});

test("offline SpicyGolf provenance and a legitimate synthetic zero survive preview/apply", async () => {
  const app = await connect(createDemoGolfAppServer(), "offline-source-test");
  try {
    const result = syntheticResult(0);
    result.data.source = "spicygolf-offline";
    const payload = { synthetic: true, results: [result] };
    const preview = data(
      await app.client.callTool({
        name: "preview_handicap_updates",
        arguments: payload,
      }),
      demoPreviewOutputSchema,
    );
    assert.equal(preview.updates[0]!.newHandicapIndex, 0);
    const applied = data(
      await app.client.callTool({
        name: "apply_handicap_updates",
        arguments: {
          ...payload,
          confirmed: true,
          confirmationToken: preview.confirmationToken,
        },
      }),
      demoApplyOutputSchema,
    );
    assert.equal(applied.players[0]!.handicapIndex, 0);
    assert.equal(applied.players[0]!.source, "spicygolf-offline");
    assert.equal(applied.players[0]!.synthetic, true);
    assert.equal(applied.players[3]!.handicapIndex, null);
  } finally {
    await app.close();
  }
});

test("standalone demo stdio advertises only synthetic in-memory application tools", async () => {
  const client = new Client({ name: "demo-stdio-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/demo/golf-app-stdio.ts"],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    assert.match(client.getInstructions() ?? "", /DEMO ONLY/);
    const roster = data(
      await client.callTool({ name: "list_players", arguments: {} }),
      demoRosterOutputSchema,
    );
    assert.equal(roster.mode, "synthetic-demo");
    assert.equal(roster.players.length, 6);
    assert.equal(roster.revision, 0);
    assert.ok(roster.players.every((p) => p.synthetic));
  } finally {
    await client.close();
  }
});
