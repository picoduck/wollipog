import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connectLocalRunner,
  hasBundledLocalRunner,
  isManagedLocalRunnerRepair,
  readLocalRunnerStatus,
  selectLocalRunnerId,
  type LocalRunnerDesktopRuntime,
} from "./local-runner.js";

test("browser dashboards do not offer bundled local runner setup", async () => {
  const desktop: LocalRunnerDesktopRuntime = {
    isTauri: () => false,
    invoke: async () => {
      throw new Error("invoke should not run");
    },
  };
  assert.equal(hasBundledLocalRunner(desktop), false);
  assert.equal(await readLocalRunnerStatus(desktop), null);
  await assert.rejects(() => connectLocalRunner("this-machine", desktop), /desktop app/);
});

test("desktop setup delegates credential provisioning and startup to the trusted host", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const desktop: LocalRunnerDesktopRuntime = {
    isTauri: () => true,
    invoke: async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return {
        available: true,
        enabled: command === "connect_local_runner",
        running: command === "connect_local_runner",
        runnerId: command === "connect_local_runner" ? "this-machine" : null,
        suggestedRunnerId: "this-machine-a1b2c3d4",
      } as T;
    },
  };
  assert.equal(hasBundledLocalRunner(desktop), true);
  assert.deepEqual(await readLocalRunnerStatus(desktop), {
    available: true,
    enabled: false,
    running: false,
    runnerId: null,
    suggestedRunnerId: "this-machine-a1b2c3d4",
  });
  const token = "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678";
  assert.deepEqual(await connectLocalRunner("this-machine", desktop, token), {
    available: true,
    enabled: true,
    running: true,
    runnerId: "this-machine",
    suggestedRunnerId: "this-machine-a1b2c3d4",
  });
  assert.deepEqual(calls, [
    { command: "local_runner_status", args: undefined },
    {
      command: "connect_local_runner",
      args: { runnerId: "this-machine", localDeviceToken: token },
    },
  ]);
});

test("repair routing distinguishes the managed local runner from external runners", () => {
  const status = {
    available: true,
    enabled: true,
    running: false,
    runnerId: "this-machine",
  };
  assert.equal(isManagedLocalRunnerRepair("this-machine", status, true, true), true);
  assert.equal(isManagedLocalRunnerRepair("external-runner", status, true, true), false);
  assert.equal(isManagedLocalRunnerRepair("this-machine", status, false, true), false);
  assert.equal(isManagedLocalRunnerRepair("this-machine", status, true, false), false);
  assert.equal(isManagedLocalRunnerRepair("this-machine", { ...status, available: false }, true, true), false);
  assert.equal(isManagedLocalRunnerRepair("this-machine", null, true, true), false);
});

test("local runner setup preserves configuration and deconflicts the per-install suggestion", () => {
  const unconfigured = {
    available: true,
    enabled: false,
    running: false,
    runnerId: null,
    suggestedRunnerId: "this-machine-a1b2c3d4",
  };
  assert.equal(selectLocalRunnerId(unconfigured, []), "this-machine-a1b2c3d4");
  assert.equal(
    selectLocalRunnerId(unconfigured, ["this-machine-a1b2c3d4"]),
    "this-machine-a1b2c3d4-2",
  );
  assert.equal(
    selectLocalRunnerId({ ...unconfigured, suggestedRunnerId: undefined }, []),
    "this-machine",
    "an older desktop response must retain the compatibility name",
  );
  assert.equal(
    selectLocalRunnerId({ ...unconfigured, suggestedRunnerId: "" }, ["this-machine"]),
    "this-machine-2",
    "an empty suggestion must still be deconflicted",
  );
  assert.equal(
    selectLocalRunnerId(
      { ...unconfigured, enabled: true, running: true, runnerId: "configured-runner" },
      ["configured-runner"],
    ),
    "configured-runner",
    "an existing configuration must not be renamed by a new machine suggestion",
  );
});
