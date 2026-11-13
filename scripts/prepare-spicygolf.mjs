import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  readFile,
  writeFile,
  readdir,
  realpath,
  rm,
  lstat,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// npm overrides do not propagate into a consumer's root. Bundle the tested SDK
// closure and correct its dependency metadata so downstream installs also retain
// patched Zod. Compiled upstream code must remain byte-for-byte unchanged.
const directory = fileURLToPath(
  new URL("../node_modules/@spicygolf/ghin/", import.meta.url),
);
assert.equal(await realpath(directory), directory.replace(/[\\/]$/, ""));
assert(!(await lstat(directory)).isSymbolicLink());
const metadataPath = join(directory, "package.json");
const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
assert.equal(metadata.name, "@spicygolf/ghin");
assert.equal(metadata.version, "0.20.1");
assert(["^3.22.4", "4.6.7"].includes(metadata.dependencies.zod));
for (const [file, hash] of Object.entries({
  "index.js":
    "16a88a75fa4f38668da3360d328dc5b25fd90dadbe05f00e76adb533144d6f65",
  "index.cjs":
    "dea138119589c3308cdf90e78e74a2097bb77da7be2db704ef43a0c24f522534",
}))
  assert.equal(
    createHash("sha256")
      .update(await readFile(join(directory, "dist", file)))
      .digest("hex"),
    hash,
    `Unexpected upstream SDK code: ${file}`,
  );
assert(
  (await readFile(join(directory, "LICENSE"), "utf8")).includes("MIT License"),
);
metadata.dependencies.zod = "4.6.7";
metadata.files = ["dist", "LICENSE"];
await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + "\n");
// Upstream ships development prompts, example environment files and payload
// research. Only the runtime, license and manifest belong in our distributable.
for (const entry of await readdir(directory)) {
  if (!["dist", "LICENSE", "package.json", "node_modules"].includes(entry))
    await rm(join(directory, entry), { recursive: true, force: true });
}
console.log(
  "Prepared unchanged SpicyGolf 0.20.1 runtime with tested Zod 4.6.7 dependency metadata.",
);
