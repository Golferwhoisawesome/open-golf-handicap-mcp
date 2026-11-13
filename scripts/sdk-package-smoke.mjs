import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

assert(process.argv[2], "Supply the temporary installed package path.");
const installed = resolve(process.argv[2]);
const { SpicyGolfSdkSession } = await import(
  pathToFileURL(join(installed, "dist/providers/spicygolf-sdk-client.js")).href
);
const session = new SpicyGolfSdkSession({
  mode: "offline-test",
  fixtureScenario: "request-pacing",
});
const credentials = {
  username: Buffer.from("package-test@example.invalid"),
  password: Buffer.from("synthetic-package-password"),
  ownGhinNumber: "900000001",
  accountType: "golfer",
};
try {
  await session.connect(credentials);
  assert.equal(session.status().authenticated, true);
  const result = await session.getMany([900000001, 900000005, 900000006], {
    status: null,
  });
  assert.equal(result.isErr(), false);
  assert.deepEqual(
    result.value.golfers.map((row) => row.ghin),
    [900000001, 900000005],
  );
  assert.deepEqual(result.value.missing, [900000006]);
  assert.equal(result.value.golfers[1].hi_display, "+0.9");
  const diagnostics = session.offlineDiagnostics();
  assert.equal(diagnostics.loginRequests, 1);
  assert.equal(diagnostics.installationRequests, 1);
  assert.equal(diagnostics.batchRequests, 2);
} finally {
  credentials.username.fill(0);
  credentials.password.fill(0);
  await session.close();
}
assert.equal(session.status().authenticated, false);
await assert.rejects(session.getMany([900000001], { status: null }));
for (const fixtureScenario of ["request-pacing", "unauthorized-once"]) {
  const controlled = new SpicyGolfSdkSession({
    mode: "offline-test",
    controlledTest: true,
    fixtureScenario,
  });
  const login = {
    username: Buffer.from("controlled-package@example.invalid"),
    password: Buffer.from("synthetic-controlled-package-password"),
    ownGhinNumber: "900000001",
    accountType: "golfer",
  };
  try {
    await controlled.connect(login);
    if (fixtureScenario === "request-pacing") {
      assert.equal(
        (await controlled.getMany([900000001], { status: null })).isErr(),
        false,
      );
      await assert.rejects(controlled.getMany([900000001], { status: null }), {
        code: "AUTH_REQUIRED",
      });
      assert.equal(controlled.diagnostics().stopReason, "budget_exhausted");
    } else {
      await assert.rejects(controlled.getMany([900000001], { status: null }), {
        code: "AUTH_REQUIRED",
      });
      assert.equal(controlled.diagnostics().lastStatus, 401);
    }
    assert.deepEqual(controlled.diagnostics().requests, {
      installation: 1,
      login: 1,
      search: 2,
      total: 4,
    });
    assert.equal(controlled.diagnostics().workerExited, true);
  } finally {
    login.username.fill(0);
    login.password.fill(0);
    await controlled.close();
  }
}
console.log(
  JSON.stringify({
    installedSdkWorker: "passed",
    transport: "offline fixtures only",
    actualSdkAuthenticationAndBatch: true,
    developmentRuntimeRequired: false,
    sessionClose: "passed",
    controlledBudgetAnd401Stop: "passed",
    controlledWorkerExit: "observed",
    minimumRequestSpacingMs: 2000,
  }),
);
