import { AppError } from "../domain/errors.js";

// Release gate for live GHIN access. Not configurable through tools, argv,
// environment variables or files. Live use additionally requires the user's
// own GHIN sign-in in the private terminal and a recorded risk acknowledgment.
export const LIVE_GHIN_RELEASE_ENABLED: boolean = true;

let testOverride: boolean | undefined;

/** Test-only: lets regression tests prove that a disabled gate blocks every
 * live path. Not reachable from the CLI, MCP tools or the environment. */
export function setLiveAccessForTesting(enabled: boolean | undefined): void {
  testOverride = enabled;
}

export function liveAccessEnabled(): boolean {
  return testOverride ?? LIVE_GHIN_RELEASE_ENABLED;
}

export function assertLiveAccessEnabled(): void {
  if (!liveAccessEnabled())
    throw new AppError(
      "LIVE_ACCESS_DISABLED",
      "Live GHIN access is disabled in this build.",
    );
}
