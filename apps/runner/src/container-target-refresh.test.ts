import assert from "node:assert/strict";
import test from "node:test";
import type { RunnerContainerTarget } from "./config.js";
import { ContainerTargetRegistry } from "./container-target.js";

const image = `example/agent@sha256:${"a".repeat(64)}`;
const template: RunnerContainerTarget = {
  id: "offline-tools", name: "Offline tools", revision: 3, runtime: "podman", image, network: "deny",
  agentCommands: { codex: { command: "codex", args: ["app-server"] } },
  setupChecks: [{ name: "git", command: "git", args: ["--version"] }],
};

for (const failure of ["before discovery", "during discovery"] as const) {
  test(`Podman refresh clears advertised installations when defaults become unsafe ${failure}`, {
    skip: process.platform !== "linux",
  }, async () => {
    let safe = true;
    let refreshing = false;
    let refreshProbeRuns = 0;
    const registry = new ContainerTargetRegistry("runner", "host", [template], {
      resolveRuntime: async () => ({
        path: "/usr/bin/podman", via: "path", launch: { command: "/usr/bin/podman", args: [] },
      }),
      podmanDefaultsSafe: () => safe,
      run: async (_file, args) => {
        if (args[0] === "--version") return { code: 0, stdout: "podman version 5.4.0\n", stderr: "" };
        if (args[0] === "info") return { code: 0, stdout: "false\n", stderr: "" };
        if (args.includes("/bin/sh")) {
          if (refreshing) {
            refreshProbeRuns += 1;
            if (failure === "during discovery") safe = false;
          }
          return { code: 0, stdout: "/usr/bin/codex\n", stderr: "" };
        }
        if (args.at(-1) === "--version") return { code: 0, stdout: "codex 1.0.0\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await registry.initialize();
    const original = registry.definitions()[0]!;
    const installation = original.harnessInstallations?.[0];
    assert.equal(original.available, true);
    assert.ok(installation, "startup advertises an installed harness before defaults change");

    refreshing = true;
    if (failure === "before discovery") safe = false;
    await registry.refreshInstallations();

    const refreshed = registry.definitions()[0]!;
    assert.equal(refreshed.available, false);
    assert.equal(refreshed.unavailableReason, "Podman defaults prevent a secret-free container target");
    assert.equal(refreshed.harnessInstallations, undefined,
      "the control plane must not receive stale installation evidence");
    assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(refreshed)) as object, "harnessInstallations"), false,
      "serialized target metadata must omit the stale installation list");
    assert.equal(refreshProbeRuns, failure === "before discovery" ? 0 : 1);
    safe = true;
    assert.match(registry.validationError({
      id: refreshed.id, runnerId: refreshed.runnerId, kind: "container", adapter: "container",
      workspaceStrategy: "worktree", boundaries: refreshed.boundaries,
      environment: refreshed.environment, harnessInstallationId: installation.id,
    }, true, { kind: "native" }, "codex") ?? "", /selected container harness installation is unavailable/u,
    "a later safety check must not revive an installation cleared by the failed refresh");
  });
}
