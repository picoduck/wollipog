import assert from "node:assert/strict";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunnerContainerTarget } from "./config.js";
import { ContainerTargetRegistry } from "./container-target.js";
import { dockerTargetClientConfig } from "./docker-client-config.js";
import { spawnAgent } from "./spawn.js";

const image = `example/agent@sha256:${"a".repeat(64)}`;
const template: RunnerContainerTarget = {
  id: "approved-image-proxy", name: "Approved Image Proxy", revision: 1,
  runtime: "docker", image, network: "deny",
  agentCommands: { codex: { command: "codex", args: ["app-server"] } },
  setupChecks: [{ name: "git", command: "git", args: ["--version"] }],
};

function envArguments(args: string[]): string[] {
  return args.flatMap((arg, index) => arg === "--env" ? [args[index + 1]!] : []);
}

test("Docker probes keep image proxy values without loading operator client defaults", async () => {
  const operatorConfig = mkdtempSync(join(tmpdir(), "wollipog-docker-operator-proxy-"));
  const previous = {
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
    DOCKER_HOST: process.env.DOCKER_HOST,
  };
  const socket = "unix:///run/user/1000/docker.sock";
  writeFileSync(join(operatorConfig, "config.json"), JSON.stringify({
    currentContext: "approved-local",
    proxies: { default: { httpProxy: "http://operator:credential@operator.invalid:8080" } },
  }));
  process.env.DOCKER_CONFIG = operatorConfig;
  process.env.DOCKER_CONTEXT = "approved-local";
  delete process.env.DOCKER_HOST;
  try {
    const launches: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const registry = new ContainerTargetRegistry("runner", "host", [template], {
      resolveRuntime: async () => ({ path: "/usr/bin/docker", via: "path",
        launch: { command: "/usr/bin/docker", args: [] } }),
      run: async (_file, args, opts) => {
        if (args[0] === "context") return { code: 0, stdout: `${JSON.stringify(socket)}\n`, stderr: "" };
        if (args[0] === "run") {
          launches.push({ args, env: opts.env });
          if (args.includes("/bin/sh")) return { code: 0, stdout: "/usr/bin/codex\n", stderr: "" };
          if (args.at(-1) === "--version" && args.includes("/usr/bin/codex")) {
            return { code: 0, stdout: "codex 1.0.0\n", stderr: "" };
          }
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await registry.initialize();
    assert.equal(registry.definitions()[0]!.available, true);
    const checks = launches.filter(({ args }) => args[args.indexOf("--name") + 1]?.startsWith("wollipog-check-"));
    const probes = launches.filter(({ args }) => args[args.indexOf("--name") + 1]?.startsWith("wollipog-probe-"));
    assert.equal(checks.length, 1);
    assert.ok(probes.length >= 2);
    for (const launch of [...checks, ...probes]) {
      assert.deepEqual(envArguments(launch.args), [], "Docker must not override pinned image proxy variables");
    }
    for (const probe of probes) {
      assert.notEqual(probe.env?.DOCKER_CONFIG, operatorConfig);
      assert.equal(probe.env?.DOCKER_HOST, socket);
      assert.equal(probe.env?.DOCKER_CONTEXT, undefined);
      assert.deepEqual(JSON.parse(readFileSync(join(probe.env!.DOCKER_CONFIG!, "config.json"), "utf8")), {},
        "the target client cannot load operator proxy defaults");
    }
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(operatorConfig, { recursive: true, force: true });
  }
});

test("Docker provider clients use the checked socket and private config without proxy overrides", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-docker-spawn-proxy-"));
  const config = join(root, "config.json");
  const script = join(root, "inspect-client.mjs");
  const previous = {
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
    DOCKER_HOST: process.env.DOCKER_HOST,
  };
  const socket = "unix:///run/user/1000/docker.sock";
  try {
    writeFileSync(config, JSON.stringify({ proxies: { default: {
      httpProxy: "http://operator:credential@operator.invalid:8080",
    } } }));
    await writeFile(script, `process.stdout.write(JSON.stringify({
      config: process.env.DOCKER_CONFIG ?? null,
      context: process.env.DOCKER_CONTEXT ?? null,
      host: process.env.DOCKER_HOST ?? null,
      args: process.argv.slice(2),
    }));`);
    process.env.DOCKER_CONFIG = root;
    process.env.DOCKER_CONTEXT = "operator-context";
    process.env.DOCKER_HOST = "tcp://operator.invalid:2375";
    const child = spawnAgent({
      command: "agent", args: [], cwd: root, containerAgentLaunch: true,
      isolation: {
        backend: "container", runtime: "docker", command: process.execPath, args: [script],
        image, network: "deny", templateId: "approved-image-proxy",
        runnerKey: "runner", containerName: "wollipog-test", hostAgentCommand: "agent",
        hostAgentArgs: [], agentCommand: "agent", agentArgs: [], dockerHost: socket,
        verifyRuntimeIdentity: () => {},
      },
    });
    child.stdin.end();
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => (output += text));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => (errors += text));
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`fake Docker client failed: ${errors}`)));
    });
    assert.ok(output, `fake Docker client produced no output: ${JSON.stringify({ args: child.spawnargs, errors })}`);
    const observed = JSON.parse(output) as { config: string | null; context: string | null;
      host: string | null; args: string[] };
    assert.notEqual(observed.config, root);
    assert.deepEqual(JSON.parse(readFileSync(join(observed.config!, "config.json"), "utf8")), {});
    assert.equal(observed.context, null);
    assert.equal(observed.host, socket);
    assert.deepEqual(envArguments(observed.args), [], "a lowercase-preferring client must see no empty proxy override");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Docker client selectors cannot be forwarded as container environment", () => {
  assert.throws(() => spawnAgent({
    command: "agent", args: [], cwd: "/workspace", containerAgentLaunch: true,
    containerEnvironmentKeys: ["DOCKER_CONFIG"],
    isolation: {
      backend: "container", runtime: "docker", command: process.execPath, args: [],
      image, network: "deny", templateId: "approved-image-proxy",
      runnerKey: "runner", containerName: "wollipog-test", hostAgentCommand: "agent",
      hostAgentArgs: [], agentCommand: "agent", agentArgs: [], verifyRuntimeIdentity: () => {},
    },
  }), /Docker client control environment cannot be forwarded/);
});

test("a replaced private config path cannot inject proxies into a later Docker launch", async () => {
  const previousPath = dockerTargetClientConfig();
  rmSync(previousPath, { recursive: true, force: true });
  mkdirSync(previousPath, { mode: 0o700 });
  writeFileSync(join(previousPath, "config.json"), JSON.stringify({
    proxies: { default: { httpProxy: "http://operator:credential@operator.invalid:8080" } },
  }));
  try {
    const replacement = dockerTargetClientConfig();
    assert.notEqual(replacement, previousPath);
    assert.deepEqual(JSON.parse(readFileSync(join(replacement, "config.json"), "utf8")), {});
    const child = spawnAgent({
      command: "agent", args: [], cwd: "/workspace", containerAgentLaunch: true,
      isolation: {
        backend: "container", runtime: "docker", command: process.execPath,
        args: ["-e", "process.stdout.write(process.env.DOCKER_CONFIG ?? '')"],
        image, network: "deny", templateId: "approved-image-proxy",
        runnerKey: "runner", containerName: "wollipog-test", hostAgentCommand: "agent",
        hostAgentArgs: [], agentCommand: "agent", agentArgs: [], verifyRuntimeIdentity: () => {},
      },
    });
    child.stdin.end();
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => (output += text));
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`fake Docker client exited ${code}`)));
    });
    assert.equal(output, replacement);
  } finally {
    rmSync(previousPath, { recursive: true, force: true });
  }
});

test("a missing private Docker config with no writable replacement makes only its target unavailable on refresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-docker-config-loss-"));
  const previousTmpdir = process.env.TMPDIR;
  const previousHost = process.env.DOCKER_HOST;
  process.env.DOCKER_HOST = "unix:///var/run/docker.sock";
  try {
    const registry = new ContainerTargetRegistry("runner", "host", [template,
      { ...template, id: "podman-control", runtime: "podman" }], {
      podmanDefaultsSafe: () => true,
      resolveRuntime: async (name) => ({ path: `/usr/bin/${name}`, via: "path",
        launch: { command: `/usr/bin/${name}`, args: [] } }),
      run: async (_file, args) => {
        if (args[0] === "info") return { code: 0, stdout: "false\n", stderr: "" };
        if (args.includes("/bin/sh")) return { code: 0, stdout: "/usr/bin/codex\n", stderr: "" };
        if (args.at(-1) === "--version" && args.includes("/usr/bin/codex")) {
          return { code: 0, stdout: "codex 1.0.0\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await registry.initialize();
    assert.equal(registry.definitions()[0]!.available, true);
    assert.equal(registry.definitions()[0]!.harnessInstallations?.length, 1);
    assert.equal(registry.definitions()[1]!.available, true);

    rmSync(dockerTargetClientConfig(), { recursive: true, force: true });
    process.env.TMPDIR = join(root, "missing");
    await registry.refreshInstallations();
    const definition = registry.definitions()[0]!;
    assert.equal(definition.available, false);
    assert.equal(definition.harnessInstallations?.length ?? 0, 0);
    assert.equal(definition.unavailableReason, "Docker client configuration could not be isolated");
    assert.equal(registry.definitions()[1]!.available, true);
    assert.equal(registry.definitions()[1]!.harnessInstallations?.length, 1);
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    if (previousHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previousHost;
    dockerTargetClientConfig();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Rediscover marks Docker unavailable if its private config disappears after the initial check", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-docker-config-rediscover-"));
  const previousTmpdir = process.env.TMPDIR;
  const previousHost = process.env.DOCKER_HOST;
  process.env.DOCKER_HOST = "unix:///var/run/docker.sock";
  try {
    let removed = false;
    const registry = new ContainerTargetRegistry("runner", "host", [template], {
      resolveRuntime: async () => ({ path: "/usr/bin/docker", via: "path",
        launch: { command: "/usr/bin/docker", args: [] } }),
      run: async (_file, args) => {
        if (args[0] === "run" && args.includes("git") && !removed) {
          rmSync(dockerTargetClientConfig(), { recursive: true, force: true });
          process.env.TMPDIR = join(root, "missing");
          removed = true;
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await registry.initialize();
    assert.equal(removed, true);
    assert.equal(registry.definitions()[0]!.available, false);
    assert.equal(registry.definitions()[0]!.unavailableReason, "Docker client configuration could not be isolated");
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    if (previousHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previousHost;
    dockerTargetClientConfig();
    rmSync(root, { recursive: true, force: true });
  }
});
