import { rm } from "node:fs/promises";

// Only generated output belonging to this package; no caller-supplied path.
// rm removes a dist symlink itself instead of traversing its target.
await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
