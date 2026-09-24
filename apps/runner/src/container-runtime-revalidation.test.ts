import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecutionTargetRef } from "@wollipog/protocol";
import type { RunnerContainerTarget } from "./config.js";
import { ContainerTargetRegistry, resolveContainerRuntime } from "./container-target.js";
import { run } from "./discovery/resolve.js";
import { spawnAgent } from "./spawn.js";

const template: RunnerContainerTarget = {
  id: "offline-tools", name: "Offline Tools", revision: 1, runtime: "docker",
  image: `example/agent@sha256:${"a".repeat(64)}`, network: "deny",
  agentCommands: { codex: { command: "codex" } },
  setupChecks: [{ name: "git", command: "git", args: ["--version"] }],
};

test("a Docker target rechecks a replaced command and a changed endpoint before later launches", {
  skip: process.platform === "win32",
}, async (t) => {
  const previousHost = process.env.DOCKER_HOST;
  const previousConfig = process.env.DOCKER_CONFIG;
  const directory = mkdtempSync(join(tmpdir(), "wollipog-runtime-revalidation-"));
  const state = join(directory, "engine");
  const launches = join(directory, "launches");
  const command = join(directory, "docker");
  const pinnedHost = `unix://${join(directory, "docker.sock")}`;
  writeFileSync(state, "docker");
  writeFileSync(command, [
    "#!/bin/sh",
    `state=$(cat ${JSON.stringify(state)})`,
    "if [ \"$1\" = '--version' ]; then",
    "  if [ \"$state\" = 'podman-command' ]; then echo 'podman version 5.0.0'; else echo 'Docker version 27.0.0'; fi",
    "  exit 0",
    "fi",
    "if [ \"$1\" = 'version' ]; then",
    `  if [ "$state" = 'podman-endpoint' ] && [ "$DOCKER_HOST" = ${JSON.stringify(pinnedHost)} ]; then`,
    "    echo '{\"Server\":{\"Platform\":{\"Name\":\"Podman Engine\"}}}'",
    `  elif [ "$state" = 'unknown-endpoint' ] && [ "$DOCKER_HOST" = ${JSON.stringify(pinnedHost)} ]; then`,
    "    echo '{\"Server\":{\"Components\":[{\"Name\":\"Unknown\"}]}}'",
    "  else",
    "    echo '{\"Server\":{\"Components\":[{\"Name\":\"Engine\"}]}}'",
    "  fi",
    "  exit 0",
    "fi",
    "if [ \"$1\" = 'run' ]; then",
    `  echo run >> ${JSON.stringify(launches)}`,
    "  case \" $* \" in *' --entrypoint git '*) exit 0;; esac",
    "  exit 1",
    "fi",
    "exit 0",
  ].join("\n"));
  chmodSync(command, 0o700);
  try {
    process.env.DOCKER_CONFIG = join(directory, "empty-client-config");
    for (const changed of ["podman-command", "podman-endpoint", "unknown-endpoint"] as const) await t.test(changed, async () => {
      writeFileSync(state, "docker");
      process.env.DOCKER_HOST = pinnedHost;
      const registry = new ContainerTargetRegistry("runner", "host", [template], {
        resolveRuntime: () => resolveContainerRuntime("docker", async () => ({
          path: command, via: "path", launch: { command, args: [] },
        }), run),
        run,
      });
      await registry.initialize();
      const definition = registry.definitions()[0]!;
      assert.equal(definition.available, true);
      assert.equal(definition.boundaries.secrets, "none");
      const target = { ...definition } as ExecutionTargetRef;
      const isolation = registry.isolation(target, "codex", "codex", [], "session");
      const start = () => spawnAgent({ command: "codex", args: [], cwd: directory,
        context: { kind: "native" }, isolation });
      writeFileSync(launches, "");
      await once(start(), "exit");
      assert.equal(readFileSync(launches, "utf8"), "run\n");
      writeFileSync(launches, "");

      // A service can change behind the same checked Unix socket without changing its path.
      writeFileSync(state, changed);
      if (changed !== "podman-command") {
        // An operator selector now points to a healthy decoy; the launch still uses its pinned socket.
        process.env.DOCKER_HOST = `unix://${join(directory, "decoy-docker.sock")}`;
      }
      let blocked = false;
      try {
        await once(start(), "exit");
      } catch (error) {
        assert.match(String(error), /runtime|engine|Podman/iu);
        blocked = true;
      }
      assert.equal(blocked, true, "a changed engine must block the launch");
      assert.equal(readFileSync(launches, "utf8"), "", "a changed engine must not receive run");
    });
  } finally {
    if (previousHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previousHost;
    if (previousConfig === undefined) delete process.env.DOCKER_CONFIG;
    else process.env.DOCKER_CONFIG = previousConfig;
    rmSync(directory, { recursive: true, force: true });
  }
});
