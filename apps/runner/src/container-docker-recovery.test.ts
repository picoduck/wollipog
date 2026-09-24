import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const exitedContainerId = "aaaaaaaaaaaa";
type DockerState = "exited" | "created" | "dead" | "removing" | "running" | "paused" | "restarting";
interface Candidate { id: string; status: DockerState; templateId?: string; labels?: "canonical" | "legacy" | "both" }

function fixture(fixtureOptions: { removalFails?: boolean; removalDisappears?: boolean;
  removalFailsOnce?: boolean; startsDuringRemoval?: boolean; containers?: Candidate[] } = {}) {
  const launches: Array<{ args: string[]; env?: Record<string, string> }> = [];
  let engineName = "Engine";
  let removedByDocker = false;
  let remainingRemovalFailures = fixtureOptions.removalFailsOnce ? 1 : 0;
  const removedByUs = new Set<string>();
  const containers = (fixtureOptions.containers ?? [{ id: exitedContainerId, status: "exited" }]).map((candidate) => ({
    ...candidate, templateId: candidate.templateId ?? template.id, labels: candidate.labels ?? "both",
  }));
  const warnings: string[] = [];
  const registry = new ContainerTargetRegistry("runner", "host", [template], {
    warnLegacyContainerLabels: (message) => warnings.push(message),
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
      if (args[0] === "ps") {
        const status = args.find((arg) => arg.startsWith("status="))?.slice(7);
        const generation = args.some((arg) => arg.startsWith("label=com.wollipog.runner="))
          ? "canonical" : "legacy";
        const templateFilter = args.find((arg) => arg.startsWith(`label=${generation === "canonical"
          ? "com.wollipog" : "com.misko-agent-manager"}.template=`))?.split("=").at(-1);
        const ids = removedByDocker ? [] : containers.filter((candidate) =>
          candidate.status === status && !removedByUs.has(candidate.id)
          && (candidate.labels === generation || candidate.labels === "both")
          && (!templateFilter || candidate.templateId === templateFilter)).map((candidate) => candidate.id);
        return { code: 0, stdout: ids.length ? `${ids.join("\n")}\n` : "", stderr: "" };
      }
      if (args[0] === "rm" && fixtureOptions.startsDuringRemoval) {
        for (const candidate of containers) {
          if (candidate.status === "created" && args.includes(candidate.id)) candidate.status = "running";
        }
        return { code: 1, stdout: "", stderr: "container is running" };
      }
      if (args[0] === "rm" && (fixtureOptions.removalFails || fixtureOptions.removalDisappears ||
          remainingRemovalFailures > 0)) {
        if (fixtureOptions.removalDisappears) removedByDocker = true;
        if (remainingRemovalFailures > 0) remainingRemovalFailures -= 1;
        return { code: 1, stdout: "", stderr: "container unavailable" };
      }
      if (args[0] === "rm") for (const id of args.slice(1)) removedByUs.add(id);
      if (args.includes("/bin/sh")) return { code: 0, stdout: "/usr/bin/codex\n", stderr: "" };
      if (args.at(-1) === "--version" && args.includes("/usr/bin/codex")) {
        return { code: 0, stdout: "codex 1.0.0\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  return { registry, launches, warnings, setEngineName: (name: string) => { engineName = name; } };
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

async function withRecoveredDocker(
  options: Parameters<typeof fixture>[0],
  inspect: (result: ReturnType<typeof fixture>) => Promise<void> | void,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "wollipog-docker-state-recovery-"));
  const saved = {
    TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
  };
  try {
    rmSync(dockerTargetClientConfig(), { recursive: true, force: true });
    setTempDirectory(join(root, "missing"));
    process.env.DOCKER_HOST = localDockerHost;
    const result = fixture(options);
    await result.registry.initialize();
    assert.equal(result.registry.definitions()[0]!.available, false);
    setTempDirectory(root);
    await result.registry.refreshInstallations();
    await inspect(result);
  } finally {
    for (const [name, value] of Object.entries(saved)) restoreEnv(name as keyof typeof saved, value);
    dockerTargetClientConfig();
    rmSync(root, { recursive: true, force: true });
  }
}

test("Docker recovery removes created, dead, and exited orphans across both label generations", async () => {
  await withRecoveredDocker({ containers: [
    { id: "bbbbbbbbbbbb", status: "created", labels: "canonical" },
    { id: "dddddddddddd", status: "created", labels: "legacy" },
    { id: "cccccccccccc", status: "dead", labels: "legacy" },
    { id: exitedContainerId, status: "exited", labels: "both" },
  ] }, ({ registry, launches, warnings }) => {
    assert.equal(registry.definitions()[0]!.available, true);
    const removals = launches.filter(({ args }) => args[0] === "rm");
    assert.equal(removals.length, 1);
    assert.equal(removals[0]!.args[0], "rm");
    assert.deepEqual(removals[0]!.args.slice(1).sort(),
      ["bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd", exitedContainerId].sort());
    assert.equal(removals[0]!.args.includes("-f"), false);
    assert.equal(warnings.length, 1);
    assert.equal(launches.filter(({ args }) => args[0] === "ps").length, 8);
  });
});

test("Docker recovery excludes other templates created during a live launch and all live states", async () => {
  await withRecoveredDocker({ containers: [
    { id: "bbbbbbbbbbbb", status: "created", templateId: "other-template" },
    { id: "cccccccccccc", status: "running" },
    { id: "dddddddddddd", status: "paused" },
    { id: "eeeeeeeeeeee", status: "restarting" },
  ] }, ({ registry, launches }) => {
    assert.equal(registry.definitions()[0]!.available, true);
    assert.equal(launches.some(({ args }) => args[0] === "rm"), false);
    const created = launches.filter(({ args }) => args[0] === "ps" && args.includes("status=created"));
    assert.equal(created.length, 2);
    assert.ok(created.every(({ args }) => args.some((arg) => arg.endsWith(".template=docker-recovery"))));
  });
});

test("Docker recovery does not remove a created container that starts before non-forced removal", async () => {
  await withRecoveredDocker({ startsDuringRemoval: true, containers: [
    { id: "bbbbbbbbbbbb", status: "created" },
  ] }, ({ registry, launches }) => {
    assert.equal(registry.definitions()[0]!.available, true);
    assert.deepEqual(launches.filter(({ args }) => args[0] === "rm").map(({ args }) => args),
      [["rm", "bbbbbbbbbbbb"]]);
    assert.equal(launches.filter(({ args }) => args[0] === "ps").length, 16);
  });
});

test("Docker recovery accepts a removing container that disappears during cleanup", async () => {
  await withRecoveredDocker({ removalDisappears: true, containers: [
    { id: "bbbbbbbbbbbb", status: "removing" },
  ] }, ({ registry, launches }) => {
    assert.equal(registry.definitions()[0]!.available, true);
    assert.deepEqual(launches.filter(({ args }) => args[0] === "rm").map(({ args }) => args),
      [["rm", "bbbbbbbbbbbb"]]);
    assert.equal(launches.filter(({ args }) => args[0] === "ps").length, 16);
  });
});

test("Docker recovery retries a persistent dead container after non-forced removal fails", async () => {
  await withRecoveredDocker({ removalFailsOnce: true, containers: [
    { id: "bbbbbbbbbbbb", status: "dead" },
  ] }, async ({ registry, launches }) => {
    assert.equal(registry.definitions()[0]!.available, false);
    assert.match(registry.definitions()[0]!.unavailableReason ?? "", /orphan reconciliation failed/u);
    await registry.refreshInstallations();
    assert.equal(registry.definitions()[0]!.available, true);
    assert.deepEqual(launches.filter(({ args }) => args[0] === "rm").map(({ args }) => args),
      [["rm", "bbbbbbbbbbbb"], ["rm", "bbbbbbbbbbbb"]]);
  });
});

test("Docker recovery bounds the combined inventory across non-running states", async () => {
  const containers: Candidate[] = Array.from({ length: 129 }, (_, index) => ({
    id: (0x100000000000 + index).toString(16),
    status: index % 2 === 0 ? "created" : "dead",
  }));
  await withRecoveredDocker({ containers }, ({ registry, launches, warnings }) => {
    assert.equal(registry.definitions()[0]!.available, false);
    assert.match(registry.definitions()[0]!.unavailableReason ?? "", /invalid.*inventory/u);
    assert.equal(launches.some(({ args }) => args[0] === "rm"), false);
    assert.deepEqual(warnings, []);
  });
});

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
    const inventories = launches.filter(({ args }) => args[0] === "ps");
    assert.equal(inventories.length, 8, "both label generations and four safe states are checked");
    for (const { args, env } of inventories) {
      assert.ok(args.some((arg) => /^status=(?:exited|created|dead|removing)$/.test(arg)),
        "running sessions must be excluded by Docker");
      if (args.includes("status=created")) {
        assert.ok(args.some((arg) => arg.includes("template=docker-recovery")),
          "created state must be scoped to the recovering template");
      }
      assert.equal(env?.DOCKER_HOST, localDockerHost);
      assert.notEqual(env?.DOCKER_CONFIG, process.env.DOCKER_CONFIG);
      assert.equal(env?.DOCKER_CONTEXT, undefined);
    }
    const removals = launches.filter(({ args }) => args[0] === "rm");
    assert.deepEqual(removals.map(({ args }) => args), [["rm", exitedContainerId]],
      "recovery removes each exited container once, without forcing a running container");
    assert.equal(removals[0]!.env?.DOCKER_HOST, localDockerHost);
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

test("Docker recovery stays unavailable after a persistent non-forced removal failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-docker-recovery-race-"));
  const saved = {
    TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
  };
  try {
    rmSync(dockerTargetClientConfig(), { recursive: true, force: true });
    setTempDirectory(join(root, "missing"));
    process.env.DOCKER_HOST = localDockerHost;
    const { registry, launches } = fixture({ removalFails: true });
    await registry.initialize();
    assert.equal(registry.definitions()[0]!.unavailableReason,
      "Docker client configuration could not be isolated");

    setTempDirectory(root);
    await registry.refreshInstallations();
    assert.equal(registry.definitions()[0]!.available, false);
    assert.match(registry.definitions()[0]!.unavailableReason ?? "", /orphan reconciliation failed/u);
    assert.deepEqual(launches.filter(({ args }) => args[0] === "rm").map(({ args }) => args),
      [["rm", exitedContainerId]], "a failed removal must never become a forced kill");
    assert.equal(launches.some(({ args }) => args[0] === "image" || args[0] === "run"), false,
      "readiness stops when safe reconciliation cannot complete");
  } finally {
    for (const [name, value] of Object.entries(saved)) restoreEnv(name as keyof typeof saved, value);
    dockerTargetClientConfig();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Docker recovery accepts a container already removed by Docker", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-docker-recovery-autoremove-"));
  const saved = {
    TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
  };
  try {
    rmSync(dockerTargetClientConfig(), { recursive: true, force: true });
    setTempDirectory(join(root, "missing"));
    process.env.DOCKER_HOST = localDockerHost;
    const { registry, launches } = fixture({ removalDisappears: true });
    await registry.initialize();
    setTempDirectory(root);
    await registry.refreshInstallations();
    assert.equal(registry.definitions()[0]!.available, true);
    assert.equal(launches.filter(({ args }) => args[0] === "ps").length, 16,
      "all safe states and label generations are rechecked after Docker auto-removes a candidate");
    assert.deepEqual(launches.filter(({ args }) => args[0] === "rm").map(({ args }) => args),
      [["rm", exitedContainerId]]);
  } finally {
    for (const [name, value] of Object.entries(saved)) restoreEnv(name as keyof typeof saved, value);
    dockerTargetClientConfig();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Docker recovery retries a failed non-forced removal on the next Rediscover", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-docker-recovery-retry-"));
  const saved = {
    TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
  };
  try {
    rmSync(dockerTargetClientConfig(), { recursive: true, force: true });
    setTempDirectory(join(root, "missing"));
    process.env.DOCKER_HOST = localDockerHost;
    const { registry, launches } = fixture({ removalFailsOnce: true });
    await registry.initialize();
    setTempDirectory(root);
    await registry.refreshInstallations();
    assert.equal(registry.definitions()[0]!.available, false);
    await registry.refreshInstallations();
    assert.equal(registry.definitions()[0]!.available, true);
    assert.deepEqual(launches.filter(({ args }) => args[0] === "rm").map(({ args }) => args),
      [["rm", exitedContainerId], ["rm", exitedContainerId]]);
  } finally {
    for (const [name, value] of Object.entries(saved)) restoreEnv(name as keyof typeof saved, value);
    dockerTargetClientConfig();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Docker recovers when its private config disappears during startup context inspection", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-docker-context-recovery-"));
  const saved = {
    TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
  };
  const operatorConfig = join(root, "operator");
  mkdirSync(operatorConfig);
  writeFileSync(join(operatorConfig, "config.json"), '{"currentContext":"local"}');
  delete process.env.DOCKER_HOST;
  process.env.DOCKER_CONFIG = operatorConfig;
  process.env.DOCKER_CONTEXT = "local";
  let removeDuringContext = true;
  const calls: string[][] = [];
  try {
    const registry = new ContainerTargetRegistry("runner", "host", [template], {
      resolveRuntime: async () => ({ path: "/usr/bin/docker", via: "path",
        launch: { command: "/usr/bin/docker", args: [] } }),
      run: async (_file, args) => {
        calls.push(args);
        if (args[0] === "context") {
          if (removeDuringContext) {
            removeDuringContext = false;
            rmSync(dockerTargetClientConfig(), { recursive: true, force: true });
            setTempDirectory(join(root, "missing"));
          }
          return { code: 0, stdout: `${JSON.stringify(localDockerHost)}\n`, stderr: "" };
        }
        if (args[0] === "--version") return { code: 0, stdout: "Docker version 29.2.1\n", stderr: "" };
        if (args[0] === "version") return { code: 0,
          stdout: '{"Server":{"Components":[{"Name":"Engine"}]}}', stderr: "" };
        if (args.includes("/bin/sh")) return { code: 0, stdout: "/usr/bin/codex\n", stderr: "" };
        if (args.at(-1) === "--version" && args.includes("/usr/bin/codex")) {
          return { code: 0, stdout: "codex 1.0.0\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await registry.initialize();
    assert.equal(registry.definitions()[0]!.unavailableReason,
      "Docker client configuration could not be isolated");
    assert.equal(calls.some((args) => ["ps", "rm", "image"].includes(args[0]!)), false);

    setTempDirectory(root);
    await registry.refreshInstallations();
    assert.equal(registry.definitions()[0]!.available, true);
    assert.equal(calls.some((args) => args[0] === "image"), true);
    assert.equal(calls.some((args) => args[0] === "run" && args.includes("git")), true);
    const inventories = calls.filter((args) => args[0] === "ps");
    assert.equal(inventories.length, 8);
    assert.ok(inventories.every((args) =>
      args.some((arg) => /^status=(?:exited|created|dead|removing)$/.test(arg))));
    assert.equal(calls.some((args) => args[0] === "rm"), false,
      "an empty exited inventory cannot remove a live session container");
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
