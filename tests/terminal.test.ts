import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { SecretHandle } from "../src/desktop/secret-store.js";
import { publicDesktopError } from "../src/desktop/errors.js";
const code = (expected: string) => (error: unknown) =>
  (error as { code?: string })?.code === expected;
test("public desktop errors redact arbitrary exception messages", () => {
  const marker = "synthetic-sensitive-marker";
  const output = JSON.stringify(publicDesktopError(new Error(marker)));
  assert.equal(output.includes(marker), false);
  assert.equal(JSON.parse(output).code, "VAULT_INVALID");
});
test("secret disposal deregisters exactly once and prevents future copies", () => {
  let disposals = 0;
  const handle = new SecretHandle(
    Buffer.from("synthetic:disposable"),
    null,
    Date.now,
    () => {
      disposals++;
    },
  );
  handle.dispose();
  handle.dispose();
  assert.equal(disposals, 1);
  assert.throws(() => handle.copy(), code("VAULT_LOCKED"));
});
test("private prompt fails closed without a controlling terminal and does not consume MCP stdin", async () => {
  const url = new URL("../src/desktop/private-prompt.ts", import.meta.url).href;
  const script = `import {readHiddenPassphrase} from ${JSON.stringify(url)};try{await readHiddenPassphrase('Private: ');process.exitCode=2;}catch(error){process.stdout.write(error.code);}`;
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { detached: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end("synthetic-do-not-read-stdin\n");
    child.on("error", reject);
    child.on("exit", (exit) =>
      exit === 0 ? resolve(stdout) : reject(new Error(stderr)),
    );
  });
  assert.equal(output, "PRIVATE_INPUT_REQUIRED");
});
