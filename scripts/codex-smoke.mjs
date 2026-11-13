import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Invoked explicitly, never by ordinary CI. Uses the user's normal Codex login
// for one ephemeral model run, with only two synthetic MCP servers configured.
const installed = resolve(process.argv[2] ?? "");
assert(process.argv[2], "Pass the temporary installed package directory.");
const reviewSyntheticWrite = process.argv.includes("--review-synthetic-write");
const consumer = resolve(installed, "../..");
const work = join(consumer, "client-check");
const clientVersion = (
  await promisify(execFile)("codex", ["--version"], { timeout: 10_000 })
).stdout.trim();
const packageVersion = JSON.parse(
  await readFile(join(installed, "package.json"), "utf8"),
).version;
await mkdir(work, { recursive: true });
const guard = join(work, "deny-network.cjs");
await writeFile(
  guard,
  `
const deny = () => { throw new Error("No network in synthetic desktop MCP verification"); };
globalThis.fetch = deny;
require("node:net").Socket.prototype.connect = deny;
require("node:dgram").createSocket = deny;
`,
);
const config = (entry, extra = []) =>
  `{ command = ${JSON.stringify(process.execPath)}, args = ${JSON.stringify(["--require", guard, join(installed, "dist", entry), ...extra])}, env = { OGH_PROVIDER = "mock", OGH_STORAGE = "mock" } }`;
const prompt = `This is an explicitly authorized synthetic integration test. Use only the two configured MCP servers ogh_offline and demo_golf_app. Do not use shell, browser, files, network tools, other apps or delegates. Do not ask for credentials. All golfers and results are synthetic.
1. Call ogh_offline get_connection_status. Confirm provider spicygolf-offline and liveAccessEnabled false.
2. Call demo_golf_app list_players.
3. Call ogh_offline get_multiple_handicaps for exactly the six GHIN fixture IDs in that roster. Preserve the complete returned results, including failures, without fabricating data.
4. Call demo_golf_app preview_handicap_updates with synthetic:true and those exact results.
5. Call demo_golf_app list_players again and verify the preview did not change the roster.
6. This test authorizes applying the displayed synthetic changes: Alpha to12.4, Beta remains8.7, Gamma to16.2, Delta to5.9, Plus to-0.9. Fixture900000006 must remain23.6 because lookup is unavailable. Only if the preview matches those exact changes, call apply_handicap_updates with synthetic:true, the identical results, confirmed:true and the returned confirmationToken. These are in-memory test records only; no real application writes are authorized.
7. ${reviewSyntheticWrite ? "The configured approval reviewer will assess that request. If approved, call list_players again and verify final indexes 12.4,8.7,16.2,5.9,-0.9,23.6." : "This read-only test expects the client's never-approval policy to block apply_handicap_updates. Make that call only once, never bypass the approval control, and continue to list_players to verify the original indexes 13.1,8.7,17,null,0.4,23.6 remain unchanged. That specific approval denial is an expected test result."}
8. In ogh_offline, call save_golfer with name "Desktop Fixture Alpha" and ghinNumber "900000001". Then call refresh_saved_handicaps and export_golfer_roster. Verify the saved synthetic golfer has index 12.4.
Report the actual outcomes and explicitly call the data synthetic. Never simulate a successful call. ${reviewSyntheticWrite ? "Any tool failure is a failed test." : "Only the expected client approval denial is permitted; all other tool calls must succeed."}`;
const args = [
  "exec",
  "--ephemeral",
  "--ignore-user-config",
  "--skip-git-repo-check",
  // Default verifies the approval boundary. The optional review mode must be
  // explicitly authorized; its CLI selects workspace-write in this temp folder.
  ...(reviewSyntheticWrite ? ["--approve-for-me"] : ["--sandbox", "read-only"]),
  "--color",
  "never",
  "--json",
  "--disable",
  "shell_tool",
  "--disable",
  "apps",
  "--disable",
  "plugins",
  "--disable",
  "browser_use",
  "--disable",
  "computer_use",
  "--disable",
  "multi_agent",
  "--disable",
  "memories",
  "-c",
  'web_search="disabled"',
  "-C",
  work,
  "-c",
  `mcp_servers.ogh_offline=${config("server/stdio.js", ["--offline-spicygolf"])}`,
  "-c",
  `mcp_servers.demo_golf_app=${config("demo/golf-app-stdio.js")}`,
  "-",
];
const child = spawn("codex", args, {
  detached: process.platform !== "win32",
  cwd: work,
  env: {
    PATH: process.env.PATH ?? "",
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    ...(process.env.TERM ? { TERM: process.env.TERM } : {}),
  },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stdin.end(prompt);
let output = "",
  stderr = "";
child.stdout.on("data", (chunk) => {
  output += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
function stopGroup(signal) {
  try {
    if (process.platform !== "win32" && child.pid)
      process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    /* the owned process group already exited */
  }
}
let forceKill,
  timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  stopGroup("SIGTERM");
  forceKill = setTimeout(() => stopGroup("SIGKILL"), 5000);
}, 180_000);
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
}).finally(() => {
  clearTimeout(timeout);
  clearTimeout(forceKill);
  stopGroup("SIGTERM");
});
await writeFile(join(work, "events.jsonl"), output, { mode: 0o600 });
assert.equal(timedOut, false, "Codex client verification timed out.");
assert.equal(code, 0, `Codex failed: ${stderr.slice(-1500)}`);
const events = output
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);
const calls = events
  .filter(
    (event) =>
      event.type === "item.completed" && event.item?.type === "mcp_tool_call",
  )
  .map((event) => event.item);
assert(calls.length >= 7, "Actual MCP tool-call events were not recorded.");
const names = calls.map((call) => call.tool);
const completedItems = events
  .filter(
    (event) => event.type === "item.completed" || event.type === "item.started",
  )
  .map((event) => event.item);
assert(
  completedItems.every((item) =>
    ["mcp_tool_call", "agent_message", "reasoning", "todo_list"].includes(
      item?.type,
    ),
  ),
  "The client used an unexpected non-MCP tool.",
);
for (const name of [
  "get_connection_status",
  "get_multiple_handicaps",
  "preview_handicap_updates",
  "apply_handicap_updates",
  "save_golfer",
  "refresh_saved_handicaps",
  "export_golfer_roster",
])
  assert(names.includes(name), `Missing real tool call: ${name}`);
assert(
  calls.every((call) => ["ogh_offline", "demo_golf_app"].includes(call.server)),
  "Unexpected MCP server used.",
);
assert(
  calls.every(
    (call) =>
      (call.status === "completed" && !call.error && !call.result?.isError) ||
      (!reviewSyntheticWrite &&
        call.server === "demo_golf_app" &&
        call.tool === "apply_handicap_updates" &&
        call.status === "failed" &&
        call.error?.message ===
          "MCP tool call requires approval, but approval policy is never"),
  ),
  `MCP tool failure: ${JSON.stringify(calls.map((call) => ({ server: call.server, tool: call.tool, status: call.status, error: call.error, isError: call.result?.isError, diagnostic: call.result?.isError ? call.result?.content : undefined })))}`,
);
function data(call) {
  if (call.result?.structuredContent) return call.result.structuredContent.data;
  const text = call.result?.content?.find(
    (entry) => entry.type === "text",
  )?.text;
  return JSON.parse(text).data;
}
const status = data(
  calls.find((call) => call.tool === "get_connection_status"),
);
assert.equal(status.provider, "spicygolf-offline");
assert.equal(status.liveAccessEnabled, false);
const lists = calls.filter((call) => call.tool === "list_players");
assert(lists.length >= 3);
const lookupCall = calls.find((call) => call.tool === "get_multiple_handicaps");
const previewCall = calls.find(
  (call) => call.tool === "preview_handicap_updates",
);
const applyCall = calls.find((call) => call.tool === "apply_handicap_updates");
assert.equal(
  calls.filter((call) => call.tool === "apply_handicap_updates").length,
  1,
);
assert.equal(applyCall.status, reviewSyntheticWrite ? "completed" : "failed");
const expectedIds = [
  "900000001",
  "900000002",
  "900000003",
  "900000004",
  "900000005",
  "900000006",
];
assert.deepEqual([...lookupCall.arguments.ghinNumbers].sort(), expectedIds);
const lookupResults = data(lookupCall).results;
assert.equal(lookupResults.length, 6);
assert.deepEqual(
  lookupResults
    .map((row) => (row.ok ? row.data.ghinNumber : row.ghinNumber))
    .sort(),
  expectedIds,
);
assert.equal(lookupResults.filter((row) => row.ok).length, 5);
assert(
  lookupResults
    .filter((row) => row.ok)
    .every(
      (row) =>
        row.data.synthetic === true && row.data.source === "spicygolf-offline",
    ),
);
assert(
  lookupResults.some(
    (row) => row.ok === false && row.ghinNumber === "900000006",
  ),
);
assert.deepEqual(previewCall.arguments.results, lookupResults);
assert.deepEqual(applyCall.arguments.results, lookupResults);
assert.equal(previewCall.arguments.synthetic, true);
assert.equal(applyCall.arguments.synthetic, true);
assert.equal(applyCall.arguments.confirmed, true);
assert.equal(
  applyCall.arguments.confirmationToken,
  data(previewCall).confirmationToken,
);
const ordered = [
  lists[0],
  lookupCall,
  previewCall,
  lists[1],
  applyCall,
  lists.at(-1),
].map((call) => calls.indexOf(call));
assert(
  ordered.every((index, i) => i === 0 || index > ordered[i - 1]),
  "MCP workflow ran out of order.",
);
assert.deepEqual(
  data(lists[0]),
  data(lists[1]),
  "Preview mutated application state.",
);
const finalPlayers = data(lists.at(-1)).players;
assert.deepEqual(
  finalPlayers.map((player) => player.handicapIndex),
  reviewSyntheticWrite
    ? [12.4, 8.7, 16.2, 5.9, -0.9, 23.6]
    : [13.1, 8.7, 17, null, 0.4, 23.6],
);
if (!reviewSyntheticWrite)
  assert.deepEqual(
    data(lists[0]),
    data(lists.at(-1)),
    "An unapproved application update changed state.",
  );
assert(finalPlayers.every((player) => player.synthetic === true));
const savedCall = calls.find((call) => call.tool === "save_golfer");
const refreshedCall = calls.find(
  (call) => call.tool === "refresh_saved_handicaps",
);
const exportedCall = calls.find((call) => call.tool === "export_golfer_roster");
assert(calls.indexOf(savedCall) < calls.indexOf(refreshedCall));
assert(calls.indexOf(refreshedCall) < calls.indexOf(exportedCall));
assert.equal(savedCall.server, "ogh_offline");
assert.equal(refreshedCall.server, "ogh_offline");
assert.equal(exportedCall.server, "ogh_offline");
const savedRoster = data(exportedCall).roster.golfers;
assert.equal(savedRoster.length, 1);
assert.equal(savedRoster[0].ghinNumber, "900000001");
assert.equal(savedRoster[0].handicap.handicapIndex, 12.4);
assert.equal(savedRoster[0].handicap.synthetic, true);
const proof = {
  client: "Codex CLI",
  clientVersion,
  packageVersion,
  platform: process.platform,
  nodeVersion: process.version,
  verifiedAt: new Date().toISOString(),
  passed: true,
  scope: reviewSyntheticWrite
    ? "synthetic full workflow with client approval review"
    : "synthetic lookup, preview, personal roster and client approval enforcement",
  crossApplicationUpdateVerified: reviewSyntheticWrite,
  clientApprovalDenialVerified: !reviewSyntheticWrite,
  actualMcpCalls: names,
  provider: status.provider,
  liveAccessEnabled: false,
  previewDidNotMutate: true,
  realLookupDataflowVerified: true,
  finalIndexes: finalPlayers.map((player) => player.handicapIndex),
  unknownPreserved: true,
  personalRosterSaveRefreshExport: true,
  approvalPath: reviewSyntheticWrite
    ? "Codex automatic approval review"
    : "read-only sandbox; client rejects unapproved demo mutation",
};
console.log(JSON.stringify(proof));
if (process.env.OGH_VERIFICATION_OUTPUT)
  await writeFile(
    process.env.OGH_VERIFICATION_OUTPUT,
    JSON.stringify(proof, null, 2) + "\n",
    { mode: 0o600 },
  );
