import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "container-smoke", version: "1" });
const transport = new StdioClientTransport({
  command: "docker",
  args: [
    "run",
    "--rm",
    "--network",
    "none",
    "-i",
    "-e",
    "OGH_PROVIDER=mock",
    "-e",
    "OGH_STORAGE=mock",
    "open-golf-handicap-mcp:local",
    "node",
    "dist/server/stdio.js",
  ],
  stderr: "pipe",
});
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 16);
  const status = await client.callTool({
    name: "get_connection_status",
    arguments: {},
  });
  assert.equal(status.structuredContent.data.liveAccessEnabled, false);
  const saved = await client.callTool({
    name: "save_golfer",
    arguments: { name: "Demo Container", ghinNumber: "900000001" },
  });
  assert.equal(saved.structuredContent.ok, true);
  const refreshed = await client.callTool({
    name: "refresh_saved_handicaps",
    arguments: {},
  });
  assert.equal(refreshed.structuredContent.data.checked, 1);
  console.log(
    JSON.stringify({
      container: "open-golf-handicap-mcp:local",
      network: "none",
      tools: 16,
      syntheticRefresh: "passed",
    }),
  );
} finally {
  await client.close();
}
