import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunnerContainerTarget } from "./config.js";
import { ContainerTargetRegistry } from "./container-target.js";
import { dockerTargetClientConfig } from "./docker-client-config.js";

const template: RunnerContainerTarget = {
  id: "docker-recovery", name: "Docker Recovery", revision: 1,
  runtime: "docker", image: `example/agent@sha256:${"a".repeat(64)}`, network: "deny",
  agentCommands: { codex: { command: "codex", args: ["app-server"] } },
  setupChecks: [{ name: "git", command: "git", args: ["--version"] }],
};
const localDockerHost = process.platform === "win32"
  ? "npipe:////./pipe/docker_engine" : "unix:///var/run/docker.sock";

function fixture() {
  const launches: Array<{ args: string[]; env?: Record<string, string> }> = [];
  let engineName = "Engine";
  const registry = new ContainerTargetRegistry("runner", "host", [template], {
    resolveRuntime: async () => ({ path: "/usr/bin/docker", via: "path",
      launch: { command: "/usr/bin/docker", args: [] } }),
    run: async (_file, args, options) => {
      launches.push({ args, env: options.env });
      if (args[0] === "--version") {
        return { code: 0, stdout: "Docker version 29.2.1, build a5c7197\n", stderr: "" };
      }
      if (args[0] === "version") {
        return { code: 0, stdout: JSON.stringify({ Server: { Components: [{ Name: engineName }] } }), stderr: "" };
      }
      if (args.includes("/bin/sh")) return { code: 0, stdout: "/usr/bin/codex\n", stderr: "" };
      if (args.at(-1) === "--version" && args.includes("/usr/bin/codex")) {
        return { code: 0, stdout: "codex 1.0.0\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  return { registry, launches, setEngineName: (name: string) => { engineName = name; } };
}

function restoreEnv(name: "TMPDIR" | "TMP" | "TEMP" | "DOCKER_HOST" | "DOCKER_CONFIG" | "DOCKER_CONTEXT",
  value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function setTempDirectory(value: string): void {
  process.env.TMPDIR = value;
  process.env.TMP = value;
  process.env.TEMP = value;
}

test("Docker target recovers from startup config failure through full readiness on Rediscover", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-docker-recovery-"));
  const saved = {
    TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
  };
  try {
    rmSync(dockerTargetClientConfig(), { recursive: true, force: true });
    setTempDirectory(join(root, "missing"));
    process.env.DOCKER_HOST = localDockerHost;
    process.env.DOCKER_CONFIG = join(root, "operator-config");
    process.env.DOCKER_CONTEXT = "operator-context";
    const { registry, launches } = fixture();
    await registry.initialize();
    assert.equal(registry.definitions()[0]!.available, false);
    assert.equal(registry.definitions()[0]!.unavailableReason,
      "Docker client configuration could not be isolated");
    assert.equal(launches.some(({ args }) => args[0] === "run"), false);

    setTempDirectory(root);
    await registry.refreshInstallations();
    const recovered = registry.definitions()[0]!;
    assert.equal(recovered.available, true);
    assert.equal(recovered.unavailableReason, undefined);
    assert.equal(recovered.harnessInstallations?.length, 1);
    assert.ok(launches.some(({ args }) => args.includes("--entrypoint") && args.includes("git")),
      "startup failure must rerun the setup check before advertising availability");
    assert.equal(launches.some(({ args }) => args[0] === "ps" || args[0] === "rm"), false,
      "Rediscover must not reconcile or remove containers while other targets may have live sessions");
    const probes = launches.filter(({ args }) => args[0] === "run" && args.includes("/bin/sh"));
    assert.ok(probes.length > 0);
    for (const { env } of probes) {
      assert.notEqual(env?.DOCKER_CONFIG, process.env.DOCKER_CONFIG);
      assert.equal(env?.DOCKER_CONTEXT, undefined);
      assert.equal(env?.DOCKER_HOST, localDockerHost);
      assert.equal(readFileSync(join(env!.DOCKER_CONFIG!, "config.json"), "utf8"), "{}\n");
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) restoreEnv(name as keyof typeof saved, value);
    dockerTargetClientConfig();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Docker target stays unavailable while config recreation fails, then recovers on Rediscover", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-docker-recovery-"));
  const saved = {
    TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
  };
  try {
    setTempDirectory(root);
    process.env.DOCKER_HOST = localDockerHost;
    process.env.DOCKER_CONFIG = join(root, "operator-config");
    process.env.DOCKER_CONTEXT = "operator-context";
    const { registry, launches, setEngineName } = fixture();
    await registry.initialize();
    assert.equal(registry.definitions()[0]!.available, true);
    const previousConfig = dockerTargetClientConfig();
    rmSync(previousConfig, { recursive: true, force: true });
    setTempDirectory(join(root, "missing"));
    await registry.refreshInstallations();
    assert.equal(registry.definitions()[0]!.available, false);
    assert.equal(registry.definitions()[0]!.harnessInstallations, undefined);
    assert.equal(registry.definitions()[0]!.unavailableReason,
      "Docker client configuration could not be isolated");
    const callsWhileUnavailable = launches.length;
    await registry.refreshInstallations();
    assert.equal(launches.length, callsWhileUnavailable,
      "failed recreation must not run a setup check or installation probe");

    setTempDirectory(root);
    process.env.DOCKER_HOST = process.platform === "win32"
      ? "npipe:////./pipe/another_engine" : "unix:///var/run/another-docker.sock";
    await registry.refreshInstallations();
    const recovered = registry.definitions()[0]!;
    assert.equal(recovered.available, true);
    assert.equal(recovered.unavailableReason, undefined);
    assert.equal(recovered.harnessInstallations?.length, 1);
    assert.notEqual(dockerTargetClientConfig(), previousConfig);
    const recoveryCalls = launches.slice(callsWhileUnavailable);
    assert.ok(recoveryCalls.some(({ args }) => args.includes("/bin/sh")));
    assert.equal(recoveryCalls.some(({ args }) => args[0] === "ps" || args[0] === "image" ||
      (args[0] === "run" && args.includes("git"))), false,
    "a previously ready target retries only installation discovery");
    for (const { env } of recoveryCalls) {
      assert.equal(env?.DOCKER_HOST, localDockerHost,
        "recovery keeps the endpoint verified before the config was lost");
      assert.notEqual(env?.DOCKER_CONFIG, process.env.DOCKER_CONFIG);
      assert.equal(env?.DOCKER_CONTEXT, undefined);
    }

    setEngineName("Podman Engine");
    await registry.refreshInstallations();
    assert.equal(registry.definitions()[0]!.available, false);
    assert.match(registry.definitions()[0]!.unavailableReason ?? "", /Podman engine/u);
    const callsAfterIdentityFailure = launches.length;
    setEngineName("Engine");
    await registry.refreshInstallations();
    assert.equal(launches.length, callsAfterIdentityFailure,
      "an engine identity failure does not inherit the config recovery permission");
    assert.equal(registry.definitions()[0]!.available, false);
  } finally {
    for (const [name, value] of Object.entries(saved)) restoreEnv(name as keyof typeof saved, value);
    dockerTargetClientConfig();
    rmSync(root, { recursive: true, force: true });
  }
});
