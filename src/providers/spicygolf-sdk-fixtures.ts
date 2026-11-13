/** Synthetic HTTP fixtures for the actual published SDK. No network fallback. */
export const fixtureScenarios = [
  "happy",
  "request-pacing",
  "auth-denied",
  "login-rate-limited",
  "missing-self",
  "malformed-login",
  "expired-login",
  "unauthorized-once",
  "forbidden",
  "rate-limited",
  "timeout",
  "oversized",
  "malformed-golfers",
  "controlled-bad-request",
  "controlled-server-error",
  "controlled-invalid-json",
  "controlled-transport-error",
  "controlled-validation-unauthorized",
  "controlled-pagination",
  "archived-multi-club",
] as const;
export type SdkFixtureScenario = (typeof fixtureScenarios)[number];
/** Marker validation never changes the credential bytes sent to the fixture. */
export function isSyntheticSdkPassword(bytes: Buffer): boolean {
  const value = bytes.toString("utf8");
  const marked = value.trimStart();
  return (
    Buffer.from(value).equals(bytes) &&
    !/\p{Cc}/u.test(value) &&
    marked.startsWith("synthetic-") &&
    Buffer.byteLength(marked.slice(10), "utf8") >= 8
  );
}
/** These identifiers were invented by this project and must never leave it. */
export const isSdkFixtureIdentifier = (value: string) =>
  /^9000000\d{2}$/.test(value);
const rows = [12.4, 8.7, 16.2, 5.9, 0.9].map((value, index) => ({
  ghin: 900000001 + index,
  first_name: "Synthetic",
  last_name: `SDK ${index + 1}`,
  hi_value: value,
  handicap_index: value,
  hi_display: index === 4 ? "+0.9" : value.toFixed(1),
  rev_date: "2026-10-29",
  status: "Active",
}));
const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
export function createSdkFixtureFetch(
  scenario: SdkFixtureScenario,
  ownGhinNumber: string,
  expectedPassword: () => Buffer,
) {
  let loginCount = 0,
    batchCount = 0;
  let lastRequestAt: number | undefined;
  const stats = { installationRequests: 0, loginRequests: 0, batchRequests: 0 };
  return {
    stats,
    async fetch(
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> {
      const requestAt = performance.now();
      // Independent transport observation: do not import the worker's limit.
      if (
        scenario === "request-pacing" &&
        lastRequestAt !== undefined &&
        requestAt - lastRequestAt < 2000
      )
        throw new Error("Synthetic transport requests arrived too quickly");
      lastRequestAt = requestAt;
      const url = new URL(String(input));
      if (url.hostname === "firebaseinstallations.googleapis.com") {
        stats.installationRequests++;
        return json({
          authToken: { token: "synthetic-installation", expiresIn: "3600s" },
        });
      }
      if (
        url.pathname.endsWith("/users/login.json") ||
        url.pathname.endsWith("/golfer_login.json")
      ) {
        stats.loginRequests++;
        loginCount++;
        const submitted = JSON.parse(String(init?.body ?? "{}"))?.user
          ?.password;
        if (
          typeof submitted !== "string" ||
          !Buffer.from(submitted, "utf8").equals(expectedPassword())
        )
          return json({ error: "Synthetic credential bytes changed" }, 401);
        if (scenario === "auth-denied")
          return json({ error: "synthetic denied" }, 401);
        if (scenario === "login-rate-limited")
          return json({ error: "synthetic login quota" }, 429, {
            "Retry-After": "30",
          });
        if (scenario === "malformed-login") return json({ unexpected: true });
        const expires =
          Math.floor(Date.now() / 1000) +
          (scenario === "expired-login" ? -60 : 3600);
        const token = [
          "eyJhbGciOiJub25lIn0",
          Buffer.from(
            JSON.stringify({ exp: expires, sub: `synthetic-${loginCount}` }),
          ).toString("base64url"),
          "synthetic-signature",
        ].join(".");
        return url.pathname.endsWith("/users/login.json")
          ? json({ user: { id: "synthetic-user" }, token })
          : json({ golfer_user: { golfer_user_token: token } });
      }
      if (
        url.pathname !== "/api/v1/golfers/search.json" ||
        (init?.method && init.method !== "GET")
      )
        throw new Error("Unexpected offline endpoint");
      stats.batchRequests++;
      batchCount++;
      if (scenario === "controlled-validation-unauthorized")
        return json({ error: "synthetic validation denied" }, 401);
      // The first batch validates the account against its supplied own identifier.
      if (batchCount > 1) {
        if (scenario === "controlled-bad-request")
          return json({ error: "synthetic bad request" }, 400);
        if (scenario === "controlled-server-error")
          return json({ error: "synthetic service failure" }, 503);
        if (scenario === "controlled-invalid-json")
          return new Response("synthetic invalid JSON", {
            headers: { "content-type": "application/json" },
          });
        if (scenario === "controlled-transport-error")
          throw new Error("synthetic private upstream transport detail");
        if (scenario === "timeout") return new Promise<Response>(() => {});
        if (scenario === "rate-limited")
          return json({ error: "synthetic quota" }, 429, {
            "Retry-After": "30",
          });
        if (scenario === "forbidden")
          return json({ error: "synthetic access revoked" }, 403);
        if (scenario === "unauthorized-once" && batchCount === 2)
          return json({ error: "synthetic token expired" }, 401);
        if (scenario === "oversized")
          return json({ padding: "x".repeat(600_000) });
        if (scenario === "malformed-golfers")
          return json({ golfers: "invalid" });
      }
      const ids = (url.searchParams.get("golfer_id") ?? "")
        .split(",")
        .map(Number);
      const golfers = rows.filter(
        (row) =>
          ids.includes(row.ghin) &&
          !(scenario === "missing-self" && String(row.ghin) === ownGhinNumber),
      );
      if (scenario === "controlled-pagination")
        return json({
          golfers: Array.from({ length: 100 }, (_, index) => ({
            ...rows[0],
            club_id: index + 1,
            is_home_club: index === 0,
          })),
        });
      if (scenario === "archived-multi-club")
        return json({
          golfers: golfers.flatMap((row) => [
            {
              ...row,
              status: "Archived",
              club_id: 1,
              is_home_club: false,
            },
            {
              ...row,
              status: "Archived",
              club_id: 2,
              is_home_club: true,
            },
          ]),
        });
      return json({ golfers });
    },
  };
}
