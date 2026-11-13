import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Tests the distributable, not a server launched from TypeScript source.
// Only npm installation needs network access. No GHIN credentials are read.
const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(await realpath(tmpdir()), "ogh-package-"));
const installDir = join(temporary, "consumer");
const packageName = "open-golf-handicap-mcp";
let client;
try {
  await mkdir(installDir);
  const config = join(temporary, "empty.npmrc");
  const globalConfig = join(temporary, "empty-global.npmrc");
  await writeFile(config, "", { mode: 0o600 });
  await writeFile(globalConfig, "", { mode: 0o600 });
  const env = {
    PATH: process.env.PATH ?? dirname(process.execPath),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    npm_config_userconfig: config,
    npm_config_globalconfig: globalConfig,
    npm_config_cache: join(temporary, "npm-cache"),
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_fetch_retries: "0",
    npm_config_fetch_timeout: "20000",
    npm_config_update_notifier: "false",
  };
  const npm = async (args, cwd) => {
    const command = process.env.npm_execpath
      ? process.execPath
      : process.platform === "win32"
        ? "npm.cmd"
        : "npm";
    const commandArgs = process.env.npm_execpath
      ? [process.env.npm_execpath, ...args]
      : args;
    return run(command, commandArgs, {
      cwd,
      env,
      // Node refuses to launch .cmd shims without a shell.
      shell: command === "npm.cmd",
      // Installing ~6,000 bundled files is slow on Windows CI runners.
      timeout: 300_000,
      maxBuffer: 2_000_000,
    });
  };
  console.log("Building and packing the local package (no publication).");
  // A stale compiled file must not survive prepack's clean build.
  const staleFileName = `package-smoke-stale-${randomUUID()}.js`;
  const staleFile = join(root, "dist", staleFileName);
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(staleFile, "// Synthetic stale build output.\n", {
    flag: "wx",
  });
  try {
    await npm(["pack", "--pack-destination", temporary], root);
    await assert.rejects(access(staleFile), { code: "ENOENT" });
  } finally {
    await rm(staleFile, { force: true });
  }
  const metadata = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const tarball = join(temporary, `${packageName}-${metadata.version}.tgz`);
  // Git Bash's GNU tar reads "C:" as a remote host; use Windows' bsdtar.
  const tar =
    process.platform === "win32"
      ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      : "tar";
  const listing = await run(tar, ["-tzf", tarball]);
  const entries = listing.stdout.trim().split(/\r?\n/);
  const bundledRoots = new Set([
    "@spicygolf/ghin",
    "async-mutex",
    "date-fns",
    "date-fns-tz",
    "jwt-decode",
    "neverthrow",
    "tslib",
    "zod",
  ]);
  assert(entries.includes("package/dist/server/stdio.js"));
  assert(entries.includes("package/THIRD_PARTY_NOTICES.md"));
  assert(!entries.includes(`package/dist/${staleFileName}`));
  for (const entry of entries) {
    if (entry.startsWith("package/node_modules/")) {
      const relative = entry.slice("package/node_modules/".length);
      const parts = relative.split("/");
      const name = parts[0].startsWith("@")
        ? parts.slice(0, 2).join("/")
        : parts[0];
      assert(bundledRoots.has(name), `Unreviewed bundled dependency: ${name}`);
      assert(
        !parts.some((part) => part.startsWith(".")),
        `Hidden file in bundle: ${entry}`,
      );
      if (name === "@spicygolf/ghin")
        assert.match(
          parts.slice(2).join("/"),
          /^(dist\/|LICENSE$|package\.json$)/,
        );
      continue;
    }
    assert.match(
      entry,
      /^package\/(dist\/|docs\/|package\.json$|README\.md$|LICENSE$|SECURITY\.md$|THIRD_PARTY_NOTICES\.md$|CHANGELOG\.md$)/,
    );
    assert(
      !entry
        .split("/")
        .some((part) => part.startsWith(".") || part === "node_modules"),
      entry,
    );
  }
  await writeFile(
    join(installDir, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  console.log(
    "Installing the tarball with production dependencies in a temporary consumer directory.",
  );
  await npm(
    [
      "install",
      tarball,
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--package-lock=true",
    ],
    installDir,
  );
  const installed = join(installDir, "node_modules", packageName);
  const sdkManifest = join(
    installed,
    "node_modules",
    "@spicygolf",
    "ghin",
    "package.json",
  );
  const sdkMetadata = JSON.parse(await readFile(sdkManifest, "utf8"));
  assert.equal(sdkMetadata.version, "0.20.1");
  assert.equal(sdkMetadata.dependencies.zod, "4.6.7");
  const sdkRequire = createRequire(sdkManifest);
  assert.equal(
    JSON.parse(await readFile(sdkRequire.resolve("zod/package.json"), "utf8"))
      .version,
    "4.6.7",
  );
  await npm(["ls", "--omit=dev", "--all"], installDir);
  const audit = JSON.parse(
    (await npm(["audit", "--omit=dev", "--json"], installDir)).stdout,
  );
  assert.equal(
    audit.metadata.vulnerabilities.total,
    0,
    "Installed consumer has a vulnerable dependency.",
  );
  const sdkSmoke = await run(
    process.execPath,
    [join(root, "scripts", "sdk-package-smoke.mjs"), installed],
    { cwd: installDir, env, timeout: 45_000, maxBuffer: 100_000 },
  );
  process.stdout.write(sdkSmoke.stdout);
  const installedMetadata = JSON.parse(
    await readFile(join(installed, "package.json"), "utf8"),
  );
  assert.equal(installedMetadata.bin[packageName], "dist/server/stdio.js");
  const entrypoint = join(installed, installedMetadata.bin[packageName]);
  await access(entrypoint);
  if (process.platform !== "win32") {
    assert.equal(
      await realpath(join(installDir, "node_modules", ".bin", packageName)),
      await realpath(entrypoint),
    );
  }
  // Both commands must actually run when launched through npm's bin links.
  for (const [bin, expected] of [
    [packageName, "open-golf-handicap-mcp ["],
    ["open-golf-handicap-setup", "open-golf-handicap-setup <init"],
  ]) {
    const shim = join(
      installDir,
      "node_modules",
      ".bin",
      process.platform === "win32" ? `${bin}.cmd` : bin,
    );
    const help = await run(shim, ["--help"], {
      cwd: installDir,
      env,
      timeout: 30_000,
      shell: process.platform === "win32",
    });
    assert(help.stdout.includes(expected), `${bin} --help did not run`);
  }
  for (const developmentDependency of ["typescript", "tsx"]) {
    await assert.rejects(
      access(join(installDir, "node_modules", developmentDependency)),
      { code: "ENOENT" },
    );
  }
  const guard = join(temporary, "deny-network.cjs");
  await writeFile(
    guard,
    `
const deny = () => { throw new Error("Network forbidden in packaged mock smoke test"); };
globalThis.fetch = deny;
require("node:net").Socket.prototype.connect = deny;
require("node:dgram").createSocket = deny;
`,
  );
  // A runtime assertion for this trusted Node program, not a security sandbox.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--require", guard, entrypoint],
    cwd: installDir,
    env: {
      PATH: dirname(process.execPath),
      OGH_PROVIDER: "mock",
      OGH_STORAGE: "mock",
    },
    stderr: "pipe",
  });
  client = new Client({ name: "installed-package-smoke", version: "1" });
  await client.connect(transport, { timeout: 15_000 });
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 16);
  for (const tool of tools) {
    assert(tool.inputSchema);
    assert(tool.outputSchema);
  }
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, name);
    assert.equal(response.structuredContent?.ok, true, name);
    return response.structuredContent.data;
  };
  const status = await call("get_connection_status");
  assert.equal(status.liveAccessEnabled, false);
  const known = (await call("get_golfer_handicap", { ghinNumber: "900000001" }))
    .result;
  assert.equal(known.ok, true);
  assert.equal(known.data.synthetic, true);
  assert.equal(known.data.source, "mock");
  assert.equal(known.data.handicapIndex, 12.4);
  const unknown = (
    await call("get_golfer_handicap", { ghinNumber: "900000099" })
  ).result;
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "NOT_FOUND");
  await call("save_golfer", {
    name: "Demo Installed Package",
    ghinNumber: "900000001",
  });
  assert.equal((await call("get_saved_golfers")).golfers.length, 1);
  assert.equal((await call("refresh_saved_handicaps")).checked, 1);
  assert.equal((await call("export_golfer_roster")).roster.golfers.length, 1);
  console.log(
    JSON.stringify({
      package: `${packageName}@${metadata.version}`,
      sha256: createHash("sha256")
        .update(await readFile(tarball))
        .digest("hex"),
      productionInstall: "passed",
      developmentRuntimeRequired: false,
      tools: tools.length,
      syntheticLookupAndRoster: "passed",
      liveAccessEnabled: false,
      runtimeNetworkGuard: "fetch, TCP and UDP blocked",
      installedDependencyAudit: "0 vulnerabilities",
      bundledSdk: "0.20.1 with tested Zod 4.6.7 metadata",
    }),
  );
  if (process.argv.includes("--codex-client")) {
    console.log(
      "Verifying the installed package in the actual Codex CLI with two synthetic MCP servers.",
    );
    const result = await run(
      process.execPath,
      [
        join(root, "scripts", "codex-smoke.mjs"),
        installed,
        ...(process.argv.includes("--review-synthetic-write")
          ? ["--review-synthetic-write"]
          : []),
      ],
      { cwd: installDir, timeout: 200_000, maxBuffer: 4_000_000 },
    );
    process.stdout.write(result.stdout);
  }
} finally {
  try {
    await client?.close();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
