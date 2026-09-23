import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentDefinition } from "@wollipog/protocol";
import { resolveLaunchForAgent } from "../external/sources.js";
import { resolvedLaunchIdentity } from "./resolve.js";
import { invalidateStaleNativeInstallation, nativeInstallationChanged } from "./stale-installation.js";

test("a replaced native executable invalidates status, update guidance, and launch", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-stale-native-"));
  const command = join(root, "codex");
  const next = join(root, "next");
  try {
    writeFileSync(command, "old executable");
    const binary = { path: command, via: "path" as const, launch: { command, args: [] } };
    const agent: AgentDefinition = {
      id: "codex", name: "Codex", command, args: [], env: {}, driver: "codex-app-server",
      context: { kind: "native" }, available: true, version: "0.155.1",
      installation: { id: "selected", path: command, via: "path", targetIdentity: resolvedLaunchIdentity(binary) },
      update: { status: "update_available", installedVersion: "0.155.1", latestPublishedVersion: "0.156.0",
        checkedAt: 1, channel: "stable", evidenceSource: "npm", managedExternally: true,
        guidance: "Run the selected executable's update command." },
    };
    assert.equal(nativeInstallationChanged(agent), false);
    assert.ok(resolveLaunchForAgent([agent], "codex", "codex-app-server", { kind: "native" }));

    writeFileSync(next, "replacement executable");
    renameSync(next, command);
    assert.equal(nativeInstallationChanged(agent), true);
    const stale = invalidateStaleNativeInstallation(agent, 2);
    assert.equal(stale.available, false);
    assert.equal(stale.version, undefined);
    assert.equal(stale.update?.status, "version_unknown");
    assert.equal(stale.update?.latestPublishedVersion, undefined);
    assert.match(stale.update?.guidance ?? "", /Rediscover this Machine/);
    assert.doesNotMatch(stale.update?.guidance ?? "", /Run the selected/);
    assert.match(stale.unavailableReason ?? "", /Rediscover this Machine/);
    let rediscoveries = 0;
    assert.equal(resolveLaunchForAgent([agent], "codex", "codex-app-server", { kind: "native" },
      () => { rediscoveries++; }), null);
    assert.equal(rediscoveries, 1);

    const rediscovered = { ...agent, installation: {
      ...agent.installation!, targetIdentity: resolvedLaunchIdentity(binary),
    } };
    assert.equal(nativeInstallationChanged(rediscovered), false);
    assert.ok(resolveLaunchForAgent([rediscovered], "codex", "codex-app-server", { kind: "native" }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
