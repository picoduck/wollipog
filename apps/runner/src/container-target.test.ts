import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import type { ExecutionTargetRef } from "@wollipog/protocol";
import type { RunnerContainerTarget } from "./config.js";
import { CANONICAL_CONTAINER_LABELS, LEGACY_CONTAINER_LABELS } from "./container-identity.js";
import { ContainerTargetRegistry, containerSetupCheckDigest, containerTargetId, podmanDefaultsSafeForPaths, resolveContainerRuntime, targetProbeEnvironment } from "./container-target.js";
import { run } from "./discovery/resolve.js";
import { spawnAgent } from "./spawn.js";

const image = `example/agent@sha256:${"a".repeat(64)}`;
const template: RunnerContainerTarget = {
  id: "offline-tools", name: "Offline tools", revision: 3, runtime: "docker", image, network: "deny",
  agentCommands: { codex: { command: "codex", args: ["app-server"] } },
  setupChecks: [{ name: "git", command: "git", args: ["--version"] }],
};
const DOCKER_PROXY_CLEAR_VALUES = [
  "HTTP_PROXY=", "http_proxy=", "HTTPS_PROXY=", "https_proxy=", "FTP_PROXY=", "ftp_proxy=",
  "NO_PROXY=", "no_proxy=", "ALL_PROXY=", "all_proxy=",
];

function containerEnvironmentArguments(args: string[]): string[] {
  return args.flatMap((arg, index) => arg === "--env" ? [args[index + 1]!] : []);
}

const HOST_RUNTIME_ENV = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "CONTAINER_HOST",
  "CONTAINER_CONNECTION", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "CONTAINERS_STORAGE_CONF",
  "CONTAINERS_CONF", "CONTAINERS_CONF_OVERRIDE", "_CONTAINERS_ROOTLESS_UID"] as const;
const emptyDockerConfig = join(tmpdir(), `wollipog-empty-docker-config-${randomUUID()}`);
let savedHostRuntimeEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedHostRuntimeEnv = Object.fromEntries(HOST_RUNTIME_ENV.map((name) => [name, process.env[name]]));
  for (const name of HOST_RUNTIME_ENV) delete process.env[name];
  process.env.DOCKER_CONFIG = emptyDockerConfig;
});
afterEach(() => {
  for (const name of HOST_RUNTIME_ENV) {
    const value = savedHostRuntimeEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function runtime() {
  return { path: "/usr/bin/docker", via: "path" as const, launch: { command: "/usr/bin/docker", args: [] } };
}

function podmanDefaultsFixture(config: string): () => boolean {
  return () => podmanDefaultsSafeForPaths({
    share: join(config, "share"), system: join(config, "system"), home: join(config, "home"),
    configHome: config, uid: 1000,
  });
}

test("a Docker-named Podman shim cannot advertise a secret-free target", {
  skip: process.platform === "win32",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-docker-podman-shim-"));
  try {
    const shim = join(root, "docker");
    writeFileSync(shim, "#!/bin/sh\nprintf 'podman version 5.4.0\\n'\n", { mode: 0o755 });
    mkdirSync(join(root, "system"), { recursive: true });
    writeFileSync(join(root, "system", "containers.conf"), "[containers]\nenv_host=true\n");
    const defaultsSafe = podmanDefaultsFixture(root);
    assert.equal(defaultsSafe(), false);
    const runtime = await resolveContainerRuntime("docker", async () => ({
      path: shim, via: "path", launch: { command: shim, args: [] },
    }), run);
    assert.match(runtime?.unavailableReason ?? "", /Docker command resolves to Podman/u);
    let containerCalls = 0;
    let podmanGuardCalls = 0;
    const registry = new ContainerTargetRegistry("runner-shim", "host", [template], {
      resolveRuntime: async () => runtime,
      podmanDefaultsSafe: () => { podmanGuardCalls += 1; return defaultsSafe(); },
      run: async () => { containerCalls += 1; return { code: 0, stdout: "", stderr: "" }; },
    });
    await registry.initialize();
    assert.equal(registry.definitions()[0]?.boundaries.secrets, "none");
    assert.equal(registry.definitions()[0]?.available, false);
    assert.equal(podmanGuardCalls, 0, "a Docker label alone never invokes Podman's defaults guard");
    assert.equal(containerCalls, 0, "no setup check or container probe may run through the shim");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production runtime resolution checks a Docker-named Podman shim", {
  skip: process.platform === "win32",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-runtime-path-"));
  const previousPath = process.env.PATH;
  try {
    writeFileSync(join(root, "docker"), "#!/bin/sh\nprintf 'podman version 5.4.0\\n'\n", { mode: 0o755 });
    process.env.PATH = `${root}${delimiter}${previousPath ?? ""}`;
    const registry = new ContainerTargetRegistry("runner-path", "host", [template]);
    await registry.initialize();
    assert.equal(registry.definitions()[0]?.available, false);
    assert.match(registry.definitions()[0]?.unavailableReason ?? "", /Docker command resolves to Podman/u);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Docker CLI version probes distinguish a Podman API engine from Docker Engine", async () => {
  const command = runtime();
  const resolve = async () => command;
  for (const [server, expectedReason] of [
    [{ Components: [{ Name: "Podman Engine" }] }, /Podman engine/u],
    [{ Platform: { Name: "Podman Engine" } }, /Podman engine/u],
    [{ Components: [{ Name: "Engine" }] }, null],
  ] as const) {
    const calls: string[][] = [];
    const checked = await resolveContainerRuntime("docker", resolve, async (_file, args) => {
      calls.push(args);
      return args[0] === "--version"
        ? { code: 0, stdout: "Docker version 29.2.1, build a5c7197\n", stderr: "" }
        : { code: 0, stdout: JSON.stringify({ Server: server }), stderr: "" };
    });
    assert.deepEqual(calls, [["--version"], ["version", "--format", "{{json .}}"]]);
    if (expectedReason) assert.match(checked?.unavailableReason ?? "", expectedReason);
    else assert.equal(checked?.unavailableReason, undefined);
  }
});

test("an unrecognized Docker-compatible command fails closed", async () => {
  const checked = await resolveContainerRuntime("docker", async () => runtime(), async () => ({
    code: 0, stdout: "compatible container tool 1.0\n", stderr: "",
  }));
  assert.match(checked?.unavailableReason ?? "", /identity could not be verified/u);
});

test("Podman mount scanning rejects inherited rootless UID source changes", () => {
  const config = mkdtempSync(join(tmpdir(), "wollipog-podman-uid-"));
  try {
    const differentUidDropin = join(config, "system", "containers.rootless.conf.d", "2000", "bind.conf");
    mkdirSync(join(config, "system", "containers.rootless.conf.d", "2000"), { recursive: true });
    writeFileSync(differentUidDropin, '[containers]\nvolumes = ["/synthetic-host-credentials:/run/secrets/host:ro"]\n');
    const safe = podmanDefaultsFixture(config);
    assert.equal(safe(), true, "actual UID does not load another UID's drop-in");
    process.env._CONTAINERS_ROOTLESS_UID = "2000";
    assert.equal(safe(), false, "a redirected per-UID config source is unavailable");
    process.env._CONTAINERS_ROOTLESS_UID = "invalid";
    assert.equal(safe(), false, "malformed inherited UID fails closed");
    process.env._CONTAINERS_ROOTLESS_UID = "1000";
    assert.equal(safe(), true, "matching inherited UID uses the scanned source");
  } finally {
    delete process.env._CONTAINERS_ROOTLESS_UID;
    rmSync(config, { recursive: true, force: true });
  }
});

function runnerKey(runnerId: string): string {
  return createHash("sha256").update(runnerId).digest("hex").slice(0, 20);
}

test("digest-pinned templates pass argv-native checks and produce an exact immutable target", async () => {
  const calls: string[][] = [];
  const registry = new ContainerTargetRegistry("runner / one", "host", [template], {
    resolveRuntime: async () => runtime(),
    run: async (_file, args) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; },
  });
  await registry.initialize();

  const definition = registry.definitions()[0]!;
  assert.equal(definition.id, containerTargetId("runner / one", template.id));
  assert.equal(definition.available, true);
  assert.deepEqual(definition.compatibleAgentIds, ["codex"]);
  assert.deepEqual(definition.boundaries, { filesystem: "container", network: "deny", secrets: "none", billing: "none" });
  assert.deepEqual(definition.environment, {
    id: template.id, revision: 3, image, setupCheckDigest: containerSetupCheckDigest(template),
  });
  const expectedRunnerKey = runnerKey("runner / one");
  assert.deepEqual(calls[0], ["ps", "-aq", "--filter", `label=${CANONICAL_CONTAINER_LABELS.runner}=${expectedRunnerKey}`]);
  assert.deepEqual(calls[1], ["ps", "-aq", "--filter", `label=${LEGACY_CONTAINER_LABELS.runner}=${expectedRunnerKey}`]);
  assert.deepEqual(calls[2], ["image", "inspect", image]);
  const checkCall = calls[3]!;
  assert.match(checkCall[4]!, /^wollipog-check-[a-f0-9]{20}-[a-f0-9]{16}$/);
  assert.deepEqual(checkCall.slice(0, 4), ["run", "--rm", "--pull=never", "--name"]);
  assert.deepEqual(checkCall.slice(5), [
    "--label", `com.wollipog.runner=${expectedRunnerKey}`,
    "--label", "com.wollipog.template=offline-tools",
    "--label", `com.misko-agent-manager.runner=${expectedRunnerKey}`,
    "--label", "com.misko-agent-manager.template=offline-tools",
    "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--pids-limit", "128",
    "--tmpfs", "/tmp:rw,nosuid,nodev",
    ...DOCKER_PROXY_CLEAR_VALUES.flatMap((value) => ["--env", value]),
    "--entrypoint", "git", image, "--version",
  ]);

  const ref: ExecutionTargetRef = {
    id: definition.id, runnerId: definition.runnerId, kind: definition.kind,
    workspaceStrategy: definition.workspaceStrategy, adapter: definition.adapter,
    boundaries: definition.boundaries, environment: definition.environment,
  };
  assert.equal(registry.validationError(ref, true, { kind: "native" }, "codex"), null);
  assert.match(registry.validationError(ref, true, { kind: "wsl", distro: "Ubuntu" }, "codex")!, /native/);
  assert.match(registry.validationError(ref, true, { kind: "native" }, "claude")!, /does not configure/);
  assert.match(registry.validationError({ ...ref, environment: { ...ref.environment!, revision: 4 } }, true, { kind: "native" }, "codex")!, /stale/);
  const isolation = registry.isolation(ref, "codex", "C:\\host\\codex.cmd", ["--host-only"], "session-1");
  assert.equal(isolation.backend, "container");
  assert.equal(isolation.image, image);
  assert.equal(isolation.agentCommand, "codex");
  assert.deepEqual(isolation.agentArgs, ["app-server"]);
  assert.deepEqual(isolation.hostAgentArgs, ["--host-only"]);
  assert.match(isolation.runnerKey, /^[a-f0-9]{20}$/);
  assert.match(isolation.containerName, /^wollipog-[a-f0-9]{24}$/);
});

test("setup checks launch the runtime without inherited host values or credential configuration", {
  skip: process.platform === "win32",
}, async () => {
  const marker = "WOLLIPOG_SETUP_CHECK_TEST_CREDENTIAL";
  const innocuous = "WOLLIPOG_SETUP_CHECK_TEST_VALUE";
  const previousMarker = process.env[marker];
  const previousInnocuous = process.env[innocuous];
  process.env[marker] = "synthetic-fixture-only";
  process.env[innocuous] = "also-synthetic";
  const script = `
    if [ "$1" = run ]; then
      shift
      while [ "$#" -gt 0 ]; do
        if [ "$1" = --entrypoint ] && [ "$2" = git ]; then
          [ -z "\${WOLLIPOG_SETUP_CHECK_TEST_CREDENTIAL+x}" ] || exit 7
          [ -z "\${WOLLIPOG_SETUP_CHECK_TEST_VALUE+x}" ] || exit 7
          [ "$HOME" = "$DOCKER_CONFIG" ] && [ "$HOME" = "$XDG_CONFIG_HOME" ] || exit 8
          printf CHECK_OK
          exit 0
        fi
        shift
      done
      exit 1
    fi
  `;
  try {
    let checkOutput = "";
    const registry = new ContainerTargetRegistry("runner", "host", [template], {
      resolveRuntime: async () => ({ path: "/bin/sh", via: "path", launch: {
        command: "/bin/sh", args: ["-c", script, "runtime"],
      } }),
      run: async (file, args, opts) => {
        const { run } = await import("./discovery/resolve.js");
        const result = await run(file, args, opts);
        if (args.includes("git")) checkOutput = result.stdout;
        return result;
      },
    });
    await registry.initialize();
    assert.equal(registry.definitions()[0]!.available, true);
    assert.equal(checkOutput, "CHECK_OK");
  } finally {
    if (previousMarker === undefined) delete process.env[marker];
    else process.env[marker] = previousMarker;
    if (previousInnocuous === undefined) delete process.env[innocuous];
    else process.env[innocuous] = previousInnocuous;
  }
});

test("rootless local Podman checks retain storage and runtime paths without host credentials", {
  skip: process.platform !== "linux",
}, async () => {
  const previousData = process.env.XDG_DATA_HOME;
  const previousRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_DATA_HOME = "/tmp/wollipog-fixture-podman-data";
  process.env.XDG_RUNTIME_DIR = "/run/user/1000";
  try {
    let checkEnv: Record<string, string> | undefined;
    let argsFromCheck: string[] | undefined;
    const registry = new ContainerTargetRegistry("runner", "host", [{ ...template, runtime: "podman" }], {
      podmanDefaultsSafe: () => true,
      resolveRuntime: async () => runtime(),
      run: async (_file, args, opts) => {
        if (args[0] === "info") return { code: 0, stdout: "false\n", stderr: "" };
        if (args[0] === "run" && args.includes("git")) {
          checkEnv = opts.env;
          argsFromCheck = args;
          assert.equal(existsSync(opts.env?.CONTAINERS_CONF ?? ""), true);
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await registry.initialize();
    assert.equal(registry.definitions()[0]!.available, true);
    assert.equal(checkEnv?.XDG_DATA_HOME, "/tmp/wollipog-fixture-podman-data");
    assert.equal(checkEnv?.XDG_RUNTIME_DIR, "/run/user/1000");
    assert.equal(checkEnv?.CONTAINER_HOST, undefined);
    assert.ok(argsFromCheck?.includes("--http-proxy=false"));
    assert.equal(existsSync(checkEnv?.CONTAINERS_CONF ?? ""), false, "private config is removed after the check");
    assert.notEqual(checkEnv?.HOME, checkEnv?.XDG_CONFIG_HOME);
    assert.equal(checkEnv?.DOCKER_CONFIG, checkEnv?.XDG_CONFIG_HOME);
    assert.equal(Object.keys(checkEnv ?? {}).some((name) => /TOKEN|SECRET|CREDENTIAL/iu.test(name)), false);
  } finally {
    if (previousData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousData;
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntime;
  }
});

test("Podman socket engines cannot claim a secret-free local mount boundary", {
  skip: process.platform !== "linux",
}, async () => {
  process.env.CONTAINER_HOST = "unix:///run/user/1000/podman/podman.sock";
  const calls: string[][] = [];
  const registry = new ContainerTargetRegistry("runner", "host", [{ ...template, runtime: "podman" }], {
    resolveRuntime: async () => runtime(),
    run: async (_file, args) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; },
  });
  await registry.initialize();
  assert.equal(registry.definitions()[0]!.available, false);
  assert.match(registry.definitions()[0]!.unavailableReason ?? "", /Podman defaults/u);
  assert.equal(calls.length, 0);
});

test("Podman rejects host binds configured in containers.conf", {
  skip: process.platform !== "linux" || process.getuid?.() === 0,
}, async () => {
  const config = mkdtempSync(join(tmpdir(), "wollipog-podman-conf-mount-test-"));
  mkdirSync(join(config, "containers"));
  writeFileSync(join(config, "containers", "containers.conf"),
    '[containers]\nvolumes = ["/synthetic-host-credentials:/run/secrets/host:ro"]\n');
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = config;
  try {
    let setupRan = false;
    const registry = new ContainerTargetRegistry("runner", "host", [{ ...template, runtime: "podman" }], {
      podmanDefaultsSafe: podmanDefaultsFixture(config),
      resolveRuntime: async () => runtime(),
      run: async (_file, args) => {
        if (args[0] === "run") setupRan = true;
        if (args[0] === "info") return { code: 0, stdout: "false\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await registry.initialize();
    assert.equal(registry.definitions()[0]!.available, false);
    assert.equal(setupRan, false);
    assert.match(registry.definitions()[0]!.unavailableReason ?? "", /Podman defaults/u);
    assert.doesNotMatch(JSON.stringify(registry.definitions()), /synthetic-host-credentials/u);
  } finally {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    rmSync(config, { recursive: true, force: true });
  }
});

test("Podman does not advertise or launch a secret-free target when host default mounts are configured", {
  skip: process.platform !== "linux" || process.getuid?.() === 0,
}, async () => {
  const config = mkdtempSync(join(tmpdir(), "wollipog-podman-mounts-test-"));
  const mounts = join(config, "containers", "mounts.conf");
  mkdirSync(join(config, "containers"));
  writeFileSync(mounts, "/synthetic-host-credentials:/run/secrets/host:ro\n");
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = config;
  try {
    const calls: string[][] = [];
    const registry = new ContainerTargetRegistry("runner", "host", [{ ...template, runtime: "podman" }], {
      podmanDefaultsSafe: podmanDefaultsFixture(config),
      resolveRuntime: async () => runtime(),
      run: async (_file, args) => {
        calls.push(args);
        if (args[0] === "info") return { code: 0, stdout: "false\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await registry.initialize();
    const definition = registry.definitions()[0]!;
    assert.equal(definition.available, false);
    assert.match(definition.unavailableReason ?? "", /Podman defaults/u);
    assert.equal(calls.some((args) => args[0] === "run"), false);
    assert.doesNotMatch(JSON.stringify(definition), /synthetic-host-credentials/u);
  } finally {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    rmSync(config, { recursive: true, force: true });
  }
});

test("Podman rejects a default mount added after registration before session launch", {
  skip: process.platform !== "linux" || process.getuid?.() === 0,
}, async () => {
  const config = mkdtempSync(join(tmpdir(), "wollipog-podman-late-mount-test-"));
  const mounts = join(config, "containers", "mounts.conf");
  mkdirSync(join(config, "containers"));
  writeFileSync(mounts, "# no implicit host mounts\n");
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = config;
  try {
    const registry = new ContainerTargetRegistry("runner", "host", [{ ...template, runtime: "podman" }], {
      podmanDefaultsSafe: podmanDefaultsFixture(config),
      resolveRuntime: async () => runtime(),
      run: async (_file, args) => args[0] === "info"
        ? { code: 0, stdout: "false\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    });
    await registry.initialize();
    const definition = registry.definitions()[0]!;
    assert.equal(definition.available, true);
    const ref: ExecutionTargetRef = {
      id: definition.id, runnerId: definition.runnerId, kind: definition.kind,
      workspaceStrategy: definition.workspaceStrategy, adapter: definition.adapter,
      boundaries: definition.boundaries, environment: definition.environment,
    };
    const reusableIsolation = registry.isolation(ref, "codex", "codex", [], "session-1");
    writeFileSync(mounts, "/synthetic-host-credentials:/run/secrets/host:ro\n");
    assert.match(registry.validationError(ref, true, { kind: "native" }, "codex") ?? "", /Podman defaults/u);
    assert.throws(() => registry.isolation(ref, "codex", "codex", [], "session-1"), /Podman defaults/u);
    assert.throws(() => spawnAgent({ command: "git", args: ["--version"], cwd: config,
      isolation: reusableIsolation }), /Podman defaults/u, "later terminal launches recheck mutable defaults");
    writeFileSync(mounts, "# no implicit host mounts\n");
    const defaults = join(config, "containers", "containers.conf");
    for (const value of ['devices = ["/dev/synthetic-host-device"]', 'ipcns = "host"']) {
      writeFileSync(defaults, `[containers]\n${value}\n`);
      assert.match(registry.validationError(ref, true, { kind: "native" }, "codex") ?? "", /Podman defaults/u);
      assert.throws(() => registry.isolation(ref, "codex", "codex", [], "session-2"), /Podman defaults/u);
      assert.throws(() => spawnAgent({ command: "git", args: ["--version"], cwd: config,
        isolation: reusableIsolation }), /Podman defaults/u, "later terminals recheck device and IPC defaults");
    }
    writeFileSync(defaults, "[engine]\nremote = true\n");
    assert.match(registry.validationError(ref, true, { kind: "native" }, "codex") ?? "", /Podman defaults/u);
    assert.throws(() => registry.isolation(ref, "codex", "codex", [], "session-3"), /Podman defaults/u);
    await registry.refreshInstallations();
    assert.equal(registry.definitions()[0]!.available, false);
  } finally {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    rmSync(config, { recursive: true, force: true });
  }
});

test("Podman setup and probes stop if defaults change during readiness", {
  skip: process.platform !== "linux" || process.getuid?.() === 0,
}, async () => {
  const config = mkdtempSync(join(tmpdir(), "wollipog-podman-readiness-mount-test-"));
  const mounts = join(config, "containers", "mounts.conf");
  mkdirSync(join(config, "containers"));
  writeFileSync(mounts, "# initially safe\n");
  try {
    const runs: string[][] = [];
    const registry = new ContainerTargetRegistry("runner", "host", [{ ...template, runtime: "podman" }], {
      podmanDefaultsSafe: podmanDefaultsFixture(config),
      resolveRuntime: async () => runtime(),
      run: async (_file, args) => {
        if (args[0] === "info") return { code: 0, stdout: "false\n", stderr: "" };
        if (args[0] === "run") {
          runs.push(args);
          writeFileSync(mounts, "/synthetic-host-credentials:/run/secrets/host:ro\n");
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await registry.initialize();
    assert.equal(runs.length, 1, "a changed default blocks discovery probes after setup");
    assert.equal(registry.definitions()[0]!.available, false);
    assert.match(registry.definitions()[0]!.unavailableReason ?? "", /Podman defaults/u);
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

test("Podman does not start a setup check after local-mode inspection adds a default mount", {
  skip: process.platform !== "linux" || process.getuid?.() === 0,
}, async () => {
  const config = mkdtempSync(join(tmpdir(), "wollipog-podman-pre-setup-mount-test-"));
  const mounts = join(config, "containers", "mounts.conf");
  mkdirSync(join(config, "containers"));
  writeFileSync(mounts, "# initially safe\n");
  try {
    let setupRan = false;
    const registry = new ContainerTargetRegistry("runner", "host", [{ ...template, runtime: "podman" }], {
      podmanDefaultsSafe: podmanDefaultsFixture(config),
      resolveRuntime: async () => runtime(),
      run: async (_file, args) => {
        if (args[0] === "info") {
          writeFileSync(mounts, "/synthetic-host-credentials:/run/secrets/host:ro\n");
          return { code: 0, stdout: "false\n", stderr: "" };
        }
        if (args[0] === "run") setupRan = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await registry.initialize();
    assert.equal(setupRan, false);
    assert.equal(registry.definitions()[0]!.available, false);
    assert.match(registry.definitions()[0]!.unavailableReason ?? "", /Podman defaults/u);
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

test("Podman mount scanning covers HOME, rootless global defaults, and quoted TOML keys", () => {
  const config = mkdtempSync(join(tmpdir(), "wollipog-podman-source-scan-"));
  const safe = podmanDefaultsFixture(config);
  try {
    assert.equal(safe(), true);
    const systemMounts = join(config, "share", "mounts.conf");
    mkdirSync(join(config, "share"));
    writeFileSync(systemMounts, "/synthetic-host-credentials:/run/secrets/host:ro\n");
    assert.equal(safe(), false, "system mounts.conf applies to setup checks");
    rmSync(systemMounts);

    const homeMounts = join(config, "home", ".config", "containers", "mounts.conf");
    mkdirSync(join(config, "home", ".config", "containers"), { recursive: true });
    writeFileSync(homeMounts, "/synthetic-host-credentials:/run/secrets/host:ro\n");
    assert.equal(safe(), false, "HOME mounts.conf applies even with a different XDG_CONFIG_HOME");
    rmSync(homeMounts);

    const globalRootless = join(config, "system", "containers.rootless.conf");
    mkdirSync(join(config, "system"));
    writeFileSync(globalRootless, '[containers]\nvolumes = ["/synthetic-host-credentials:/run/secrets/host:ro"]\n');
    assert.equal(safe(), false);
    rmSync(globalRootless);

    const uidDropin = join(config, "system", "containers.rootless.d", "1000", "bind.conf");
    mkdirSync(join(config, "system", "containers.rootless.d", "1000"), { recursive: true });
    writeFileSync(uidDropin, '[containers]\nmounts = ["type=bind,src=/synthetic-host-credentials,dst=/run/secrets/host"]\n');
    assert.equal(safe(), false);
    rmSync(uidDropin);

    const rootlessSystemDropin = join(config, "system", "containers.rootless.conf.d", "20-bind.conf");
    mkdirSync(join(config, "system", "containers.rootless.conf.d"), { recursive: true });
    writeFileSync(rootlessSystemDropin, '[containers]\nvolumes = ["/synthetic-host-credentials:/run/secrets/host:ro"]\n');
    assert.equal(safe(), false, "current rootless system drop-ins are scanned");
    rmSync(rootlessSystemDropin);

    const rootlessShareUidDropin = join(config, "share", "containers.rootless.conf.d", "1000", "30-bind.conf");
    mkdirSync(join(config, "share", "containers.rootless.conf.d", "1000"), { recursive: true });
    writeFileSync(rootlessShareUidDropin, '[containers]\nvolumes = ["/synthetic-host-credentials:/run/secrets/host:ro"]\n');
    assert.equal(safe(), false, "current per-UID rootless share drop-ins are scanned");
    rmSync(rootlessShareUidDropin);

    const rootfulShareDropin = join(config, "share", "containers.rootful.conf.d", "40-bind.conf");
    mkdirSync(join(config, "share", "containers.rootful.conf.d"), { recursive: true });
    writeFileSync(rootfulShareDropin, '[containers]\nvolumes = ["/synthetic-host-credentials:/run/secrets/host:ro"]\n');
    assert.equal(podmanDefaultsSafeForPaths({
      share: join(config, "share"), system: join(config, "system"), home: join(config, "home"),
      configHome: config, uid: 0,
    }), false, "current rootful share drop-ins are scanned");
    rmSync(rootfulShareDropin);

    const quotedKey = join(config, "containers", "containers.conf");
    mkdirSync(join(config, "containers"));
    writeFileSync(quotedKey, '[containers]\n"volumes" = ["/synthetic-host-credentials:/run/secrets/host:ro"]\n');
    assert.equal(safe(), false);
    writeFileSync(quotedKey, '[containers]\n"volum\\u0065s" = ["/synthetic-host-credentials:/run/secrets/host:ro"]\n');
    assert.equal(safe(), false, "escaped TOML keys cannot hide a volume default");
    writeFileSync(quotedKey, '[containers]\n"volume\\x73" = ["/synthetic-host-credentials:/run/secrets/host:ro"]\n');
    assert.equal(safe(), false, "TOML 1.1 hex escapes cannot hide a volume default");
    writeFileSync(quotedKey, '[containers]\nVolumes = ["/synthetic-host-credentials:/run/secrets/host:ro"]\n');
    assert.equal(safe(), false, "case-folded TOML keys cannot hide a volume default");
    writeFileSync(quotedKey, '[containers]\n"volumeſ" = ["/synthetic-host-credentials:/run/secrets/host:ro"]\n');
    assert.equal(safe(), false, "Unicode case folding cannot hide a volume default");
    writeFileSync(quotedKey, '[engine]\nremote = true\n');
    assert.equal(safe(), false, "remote mode cannot redirect launch to an unchecked engine");
    writeFileSync(quotedKey, '[engine]\nRemote = true\n');
    assert.equal(safe(), false, "case-folded remote mode cannot redirect launch");
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

test("Podman rejects non-mount defaults that cross the secret-free boundary", () => {
  const config = mkdtempSync(join(tmpdir(), "wollipog-podman-nonmount-"));
  const file = join(config, "containers", "containers.conf");
  const safe = podmanDefaultsFixture(config);
  mkdirSync(join(config, "containers"));
  try {
    for (const [name, value] of [
      ["host environment", "env_host = true"],
      ["named host environment", 'env = ["SYNTHETIC_CREDENTIAL"]'],
      ["mixed host environment", 'env = ["PUBLIC_SETTING=value", "SYNTHETIC_CREDENTIAL"]'],
      ["host file copied into hosts", 'base_hosts_file = "/tmp/synthetic-hosts"'],
      ["host PID namespace", 'pidns = "host"'],
      ["host device", 'devices = ["/dev/synthetic-host-device"]'],
      ["host IPC namespace", 'ipcns = "host"'],
    ]) {
      writeFileSync(file, `[containers]\n${value}\n`);
      assert.equal(safe(), false, `${name} must not reach a container target`);
    }
    writeFileSync(file, 'containers."env_host" = true\n');
    assert.equal(safe(), false, "dotted TOML keys cannot hide host environment forwarding");
    for (const [name, value] of [
      ["inline table", "containers = { env_host = true }"],
      ["spaced dotted key", "containers . env_host = true"],
      ["inline named host environment", 'containers = { env = ["SYNTHETIC_CREDENTIAL"] }'],
      ["inline host file", 'containers = { base_hosts_file = "/tmp/synthetic-hosts" }'],
      ["inline PID namespace", 'containers = { pidns = "host" }'],
      ["inline host device", 'containers = { devices = ["/dev/synthetic-host-device"] }'],
      ["inline host IPC", 'containers = { ipcns = "host" }'],
      ["later unsafe inline value", 'containers = { env_host = false, pidns = "host" }'],
      ["triple-quoted inline value", 'containers = { log_tag = """x"#""", env_host = true }'],
      ["triple-literal inline value", "containers = { log_tag = '''x'#''', pidns = \"host\" }"],
      ["multiline string", '[containers]\nlog_tag = """\n[engine]\n"""\nenv_host = true'],
    ]) {
      writeFileSync(file, `${value}\n`);
      assert.equal(safe(), false, `${name} must not hide an unsafe default`);
    }
    writeFileSync(file, '[containers]\n"env_hoſt" = true\n');
    assert.equal(safe(), false, "Unicode case folding cannot hide host environment forwarding");
    writeFileSync(file, '[containers]\nenv_hoſt = true\n');
    assert.equal(safe(), false, "Unicode bare keys cannot hide host environment forwarding");
    writeFileSync(file, '[engine]\nenv = ["ENGINE_SETTING=value"]\n');
    assert.equal(safe(), true, "engine environment is not a container environment default");
    writeFileSync(file, '[containers]\nenv_host = false # env_host = true is not enabled\n');
    assert.equal(safe(), true, "comments do not turn a safe setting into an unsafe one");
    for (const value of [
      "env_host = false", 'env = ["PUBLIC_SETTING=value"]',
      'base_hosts_file = "image"', 'base_hosts_file = "none"',
      'base_hosts_file = "/etc/hosts"', 'pidns = "private"',
      'devices = []', 'devices = [ ]', 'ipcns = "private"', 'ipcns = "shareable"', 'ipcns = "none"',
    ]) {
      writeFileSync(file, `[containers]\n${value}\n`);
      assert.equal(safe(), true, `${value} preserves safe Podman defaults`);
    }
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

test("a saved local Docker context supplies its Unix socket without exposing client config to the check", async () => {
  const config = mkdtempSync(join(tmpdir(), "wollipog-docker-context-test-"));
  writeFileSync(join(config, "config.json"), '{"currentContext":"local-fixture"}');
  process.env.DOCKER_CONFIG = config;
  try {
    let checkEnv: Record<string, string> | undefined;
    let contextEnv: Record<string, string> | undefined;
    const registry = new ContainerTargetRegistry("runner", "host", [template], {
      resolveRuntime: async () => runtime(),
      run: async (_file, args, opts) => {
        if (args[0] === "context") {
          contextEnv = opts.env;
          return { code: 0, stdout: '"unix:///run/user/1000/docker.sock"\n', stderr: "" };
        }
        if (args[0] === "run" && args.includes("git")) checkEnv = opts.env;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await registry.initialize();
    assert.equal(registry.definitions()[0]!.available, true);
    assert.equal(contextEnv?.DOCKER_CONFIG, config);
    assert.deepEqual(Object.keys(contextEnv ?? {}).sort(),
      (process.platform === "win32" ? ["PATH", "HOME", "DOCKER_CONFIG", "SystemRoot"] :
        ["PATH", "HOME", "DOCKER_CONFIG"]).sort());
    assert.equal(contextEnv?.HOME === config, false);
    assert.equal(checkEnv?.DOCKER_HOST, "unix:///run/user/1000/docker.sock");
    assert.notEqual(checkEnv?.DOCKER_CONFIG, config);
    assert.equal(checkEnv?.DOCKER_CONFIG, checkEnv?.HOME);
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

test("Windows Docker checks retain a local named-pipe endpoint", {
  skip: process.platform !== "win32",
}, async () => {
  process.env.DOCKER_HOST = "npipe:////./pipe/docker_engine";
  let checkEnv: Record<string, string> | undefined;
  const registry = new ContainerTargetRegistry("runner", "host", [template], {
    resolveRuntime: async () => runtime(),
    run: async (_file, args, opts) => {
      if (args[0] === "run" && args.includes("git")) checkEnv = opts.env;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await registry.initialize();
  assert.equal(registry.definitions()[0]!.available, true);
  assert.equal(checkEnv?.DOCKER_HOST, "npipe:////./pipe/docker_engine");
});

test("a remote saved Docker context fails closed without running a setup check", async () => {
  const config = mkdtempSync(join(tmpdir(), "wollipog-docker-remote-test-"));
  writeFileSync(join(config, "config.json"), '{"currentContext":"remote-fixture"}');
  process.env.DOCKER_CONFIG = config;
  try {
    let checkRan = false;
    const registry = new ContainerTargetRegistry("runner", "host", [template], {
      resolveRuntime: async () => runtime(),
      run: async (_file, args) => {
        if (args[0] === "context") return { code: 0, stdout: '"tcp://example.invalid:2376"\n', stderr: "" };
        if (args[0] === "run" && args.includes("git")) checkRan = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await registry.initialize();
    assert.equal(registry.definitions()[0]!.available, false);
    assert.equal(checkRan, false);
    assert.equal(registry.definitions()[0]!.unavailableReason,
      "setup check 'git' could not launch isolated runtime");
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

test("DOCKER_HOST wins over a stale or remote Docker context", async () => {
  for (const [host, available] of [
    ["unix:///run/user/1000/docker.sock", true],
    ["tcp://example.invalid:2376", false],
  ] as const) {
    process.env.DOCKER_HOST = host;
    process.env.DOCKER_CONTEXT = available ? "missing-context" : "local-context";
    let contextInspected = false;
    let checkEnv: Record<string, string> | undefined;
    const registry = new ContainerTargetRegistry("runner", "host", [template], {
      resolveRuntime: async () => runtime(),
      run: async (_file, args, opts) => {
        if (args[0] === "context") contextInspected = true;
        if (args[0] === "run" && args.includes("git")) checkEnv = opts.env;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await registry.initialize();
    assert.equal(contextInspected, false);
    assert.equal(registry.definitions()[0]!.available, available);
    assert.equal(checkEnv?.DOCKER_HOST, available ? host : undefined);
  }
});

test("Podman keeps a configured local storage file without loading general container config", {
  skip: process.platform !== "linux",
}, async () => {
  const config = mkdtempSync(join(tmpdir(), "wollipog-podman-storage-test-"));
  const storage = join(config, "containers", "storage.conf");
  mkdirSync(join(config, "containers"));
  writeFileSync(storage, '[storage]\ngraphroot = "/tmp/wollipog-fixture-store"\n');
  process.env.XDG_CONFIG_HOME = config;
  try {
    let checkEnv: Record<string, string> | undefined;
    let inspectedLocalMode = false;
    const registry = new ContainerTargetRegistry("runner", "host", [{ ...template, runtime: "podman" }], {
      podmanDefaultsSafe: () => true,
      resolveRuntime: async () => runtime(),
      run: async (_file, args, opts) => {
        if (args[0] === "info") {
          inspectedLocalMode = true;
          assert.equal(opts.replaceEnv, true);
          assert.equal(opts.env?.XDG_CONFIG_HOME, config);
          assert.equal(opts.env?.CONTAINERS_CONF, undefined);
          return { code: 0, stdout: "false\n", stderr: "" };
        }
        if (args[0] === "run" && args.includes("git")) checkEnv = opts.env;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await registry.initialize();
    assert.equal(inspectedLocalMode, true);
    assert.equal(registry.definitions()[0]!.available, true);
    assert.equal(checkEnv?.CONTAINERS_STORAGE_CONF, storage);
    assert.equal(checkEnv?.CONTAINERS_CONF?.startsWith(checkEnv?.XDG_CONFIG_HOME ?? ""), true);
    assert.notEqual(checkEnv?.XDG_CONFIG_HOME, config);
    assert.notEqual(checkEnv?.XDG_CONFIG_HOME, checkEnv?.HOME);
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

test("Podman config-selected remote mode cannot certify a local setup check", {
  skip: process.platform !== "linux",
}, async () => {
  const config = mkdtempSync(join(tmpdir(), "wollipog-podman-remote-test-"));
  const file = join(config, "containers", "containers.conf");
  mkdirSync(join(config, "containers"));
  writeFileSync(file, "[engine]\nremote = true\n");
  process.env.XDG_CONFIG_HOME = config;
  try {
    let setupRan = false;
    let infoEnv: Record<string, string> | undefined;
    const registry = new ContainerTargetRegistry("runner", "host", [{ ...template, runtime: "podman" }], {
      podmanDefaultsSafe: () => true,
      resolveRuntime: async () => runtime(),
      run: async (_file, args, opts) => {
        if (args[0] === "info") {
          infoEnv = opts.env;
          return { code: 0, stdout: "true\n", stderr: "" };
        }
        if (args[0] === "run" && args.includes("git")) setupRan = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await registry.initialize();
    assert.equal(infoEnv?.XDG_CONFIG_HOME, config);
    assert.equal(infoEnv?.CONTAINERS_CONF, undefined);
    assert.equal(setupRan, false);
    assert.equal(registry.definitions()[0]!.unavailableReason,
      "setup check 'git' could not launch isolated runtime");
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

test("Podman setup checks fail closed when local mode cannot be confirmed", {
  skip: process.platform !== "linux",
}, async () => {
  for (const info of [
    { code: 1, stdout: "fixture-private-output", stderr: "" },
    { code: 0, stdout: "unexpected", stderr: "" },
    { code: 1, stdout: "", stderr: "", timedOut: true },
  ]) {
    let setupRan = false;
    const registry = new ContainerTargetRegistry("runner", "host", [{ ...template, runtime: "podman" }], {
      podmanDefaultsSafe: () => true,
      resolveRuntime: async () => runtime(),
      run: async (_file, args) => {
        if (args[0] === "info") return info;
        if (args[0] === "run" && args.includes("git")) setupRan = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await registry.initialize();
    assert.equal(setupRan, false);
    assert.equal(registry.definitions()[0]!.unavailableReason,
      "setup check 'git' could not launch isolated runtime");
    assert.doesNotMatch(JSON.stringify(registry.definitions()), /fixture-private-output|unexpected/u);
  }
});

test("unsupported remote container endpoint fails closed before running a setup check", async () => {
  const previous = process.env.DOCKER_HOST;
  process.env.DOCKER_HOST = "tcp://example.invalid:2375";
  try {
    let setupRan = false;
    const registry = new ContainerTargetRegistry("runner", "host", [template], {
      resolveRuntime: async () => runtime(),
      run: async (_file, args) => {
        if (args[0] === "run" && args.includes("git")) setupRan = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await registry.initialize();
    assert.equal(registry.definitions()[0]!.available, false);
    assert.equal(setupRan, false);
    assert.match(registry.definitions()[0]!.unavailableReason!, /could not launch isolated runtime/);
  } finally {
    if (previous === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previous;
  }
});

test("an unavailable private runtime directory leaves only its target unavailable", {
  skip: process.platform === "win32",
}, async () => {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = join(tmpdir(), `wollipog-missing-${randomUUID()}`);
  try {
    let setupRan = false;
    const registry = new ContainerTargetRegistry("runner", "host", [template], {
      resolveRuntime: async () => runtime(),
      run: async (_file, args) => {
        if (args[0] === "run" && args.includes("git")) setupRan = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await registry.initialize();
    assert.equal(registry.definitions()[0]!.available, false);
    assert.equal(setupRan, false);
    assert.equal(registry.definitions()[0]!.unavailableReason,
      "setup check 'git' could not prepare isolated runtime");
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
});

test("setup-check timeout and client errors expose only value-free failure categories", async () => {
  for (const [result, expected] of [
    [{ code: 1, stdout: "fixture-private-output", stderr: "", timedOut: true }, "timed out"],
    [{ code: 1, stdout: "", stderr: "fixture-private-output", errorCode: "ENOENT" }, "runtime client failed"],
  ] as const) {
    const registry = new ContainerTargetRegistry("runner", "host", [template], {
      resolveRuntime: async () => runtime(),
      run: async (_file, args) => args[0] === "run" ? result : { code: 0, stdout: "", stderr: "" },
    });
    await registry.initialize();
    assert.equal(registry.definitions()[0]!.unavailableReason, `setup check 'git' ${expected}`);
    assert.doesNotMatch(JSON.stringify(registry.definitions()), /fixture-private-output|ENOENT/);
  }
});

test("container installations stay target-bound, deduplicate aliases, and fail closed after rediscovery", async () => {
  let missing = false;
  const configurations: RunnerContainerTarget[] = [
    { ...template, id: "alpha", agentCommands: { codex: { command: "codex", args: ["app-server"] } },
      alternateCommands: { codex: [
        { command: "/opt/codex-alias", args: ["app-server"] },
        { command: "/opt/codex-preview", args: ["app-server"] },
      ] } },
    { ...template, id: "beta", agentCommands: { codex: { command: "codex", args: ["app-server"] } } },
  ];
  const registry = new ContainerTargetRegistry("runner", "host", configurations, {
    resolveRuntime: async () => runtime(),
    run: async (_file, args) => {
      if (args.includes("/bin/sh")) {
        const requested = args.at(-1);
        if (missing && requested === "/opt/codex-preview") return { code: 1, stdout: "", stderr: "missing" };
        const path = requested === "/opt/codex-preview" ? "/opt/codex-preview" : "/usr/bin/codex";
        return { code: 0, stdout: `${path}\n`, stderr: "" };
      }
      if (args.includes("--entrypoint") && args.at(-1) === "--version") {
        return { code: 0, stdout: "codex 1.2.3\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await registry.initialize();
  const [alpha, beta] = registry.definitions();
  assert.equal(alpha!.harnessInstallations?.length, 2, "the alias is the same effective launch");
  assert.equal(beta!.harnessInstallations?.length, 1);
  const selected = alpha!.harnessInstallations!.find((item) => item.path === "/opt/codex-preview")!;
  assert.notEqual(alpha!.harnessInstallations![0]!.id, beta!.harnessInstallations![0]!.id,
    "same executable name in distinct targets has a distinct identity");
  const ref = { id: alpha!.id, runnerId: alpha!.runnerId, kind: alpha!.kind,
    adapter: alpha!.adapter, workspaceStrategy: alpha!.workspaceStrategy,
    boundaries: alpha!.boundaries, environment: alpha!.environment,
    harnessInstallationId: selected.id };
  assert.equal(registry.validationError(ref, true, { kind: "native" }, "codex"), null);
  assert.equal(registry.isolation(ref, "codex", "host-codex", [], "session").agentCommand, "/opt/codex-preview");
  const primary = alpha!.harnessInstallations!.find((item) => item.path === "/usr/bin/codex")!;
  assert.equal(registry.isolation({ ...ref, harnessInstallationId: primary.id }, "codex", "host-codex", [], "session")
    .agentCommand, "/usr/bin/codex", "the selected alias launches its resolved executable, not PATH spelling");
  assert.match(registry.validationError({ ...ref, id: beta!.id, environment: beta!.environment }, true,
    { kind: "native" }, "codex")!, /selected container harness installation is unavailable/);
  missing = true;
  await registry.refreshInstallations();
  assert.equal(registry.definitions()[0]!.harnessInstallations?.length, 1);
  assert.match(registry.validationError(ref, true, { kind: "native" }, "codex")!, /unavailable/);
});

test("target-local probes use the selected image executable without mounts, host credentials, or interaction", async () => {
  const calls: Array<{ args: string[]; timeoutMs?: number; maxBuffer?: number;
    env?: Record<string, string>; replaceEnv?: boolean }> = [];
  const configured: RunnerContainerTarget = {
    ...template, agentCommands: { "claude-code": { command: "claude" } },
  };
  const registry = new ContainerTargetRegistry("runner", "host", [configured], {
    resolveRuntime: async () => runtime(),
    run: async (_file, args, opts) => {
      calls.push({ args, ...opts });
      if (args.includes("/bin/sh")) return { code: 0, stdout: "/usr/local/bin/claude\n", stderr: "" };
      if (args.at(-1) === "--version") return { code: 0, stdout: "2.1.205 (Claude Code)\n", stderr: "" };
      if (args.at(-1) === "--help") return { code: 0,
        stdout: "--input-format stream-json\n--output-format stream-json\n--permission-mode (choices: \"acceptEdits\")", stderr: "" };
      if (args.at(-1) === "status") return { code: 1, stdout: '{"loggedIn":false}', stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await registry.initialize();
  const candidate = registry.definitions()[0]!.harnessInstallations![0]!;
  assert.equal(candidate.authentication, "unauthenticated");
  assert.equal(candidate.authenticationEvidence, "claude-auth-status");
  assert.equal(candidate.capability, "verified");
  assert.equal(candidate.capabilityEvidence, "claude-help");
  const probes = calls.filter(({ args }) => args.includes("--entrypoint") &&
    args[args.indexOf("--entrypoint") + 1] === "/usr/local/bin/claude");
  assert.equal(probes.length, 3);
  for (const { args, timeoutMs, maxBuffer, env, replaceEnv } of probes) {
    assert.equal(args[args.indexOf("--workdir") + 1], "/tmp");
    assert.equal(args[args.indexOf("--entrypoint") + 1], candidate.path);
    assert.ok(args.includes("--network") && args.includes("none"));
    assert.equal(args.includes("--mount"), false);
    assert.deepEqual(containerEnvironmentArguments(args), DOCKER_PROXY_CLEAR_VALUES);
    assert.equal(args.includes("--interactive"), false);
    assert.equal(timeoutMs, 5_000);
    assert.equal(maxBuffer, 64 * 1024);
    assert.equal(replaceEnv, true);
    assert.equal(env?.WOLLIPOG_SESSION_ID, undefined);
    assert.equal(Object.keys(env ?? {}).some((name) => /token|secret|api_key|credential/iu.test(name)), false);
  }
});

test("probe client environment strips sensitive host names even when a runtime forwards client env", () => {
  assert.deepEqual(targetProbeEnvironment({
    PATH: "/usr/bin", HOME: "/home/runner", ANTHROPIC_API_KEY: "host-secret",
    OpenAI_Api_Key: "host-secret", WOLLIPOG_SESSION_ID: "host-session",
    RUNNER_TOKEN_FILE: "/secret/path", PODMAN_AUTHORIZATION: "host-secret",
    HTTP_PROXY: "http://proxy.example.invalid:8080",
  }), { PATH: "/usr/bin", HOME: "/home/runner", HTTP_PROXY: "http://proxy.example.invalid:8080" });
});

test("Docker client proxy configuration is cleared for setup checks and installation probes", async () => {
  const config = mkdtempSync(join(tmpdir(), "wollipog-docker-proxy-test-"));
  const previousConfig = process.env.DOCKER_CONFIG;
  writeFileSync(join(config, "config.json"), JSON.stringify({
    proxies: { default: { httpProxy: "http://synthetic-user:synthetic-password@proxy.example.invalid:8080" } },
  }));
  process.env.DOCKER_CONFIG = config;
  try {
    const runs: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const registry = new ContainerTargetRegistry("runner", "host", [template], {
      resolveRuntime: async () => runtime(),
      run: async (_file, args, opts) => {
        if (args[0] === "context") return { code: 0, stdout: '"unix:///var/run/docker.sock"\n', stderr: "" };
        if (args[0] === "run") {
          runs.push({ args, env: opts.env });
          if (args.includes("/bin/sh")) return { code: 0, stdout: "/usr/bin/codex\n", stderr: "" };
          if (args.at(-1) === "--version") return { code: 0, stdout: "codex 1.0.0\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await registry.initialize();
    assert.equal(registry.definitions()[0]!.available, true);
    const setup = runs.filter(({ args }) => args[args.indexOf("--name") + 1]?.startsWith("wollipog-check-"));
    const probes = runs.filter(({ args }) => args[args.indexOf("--name") + 1]?.startsWith("wollipog-probe-"));
    assert.equal(setup.length, 1);
    assert.ok(probes.length >= 2, "resolution and version both create probe containers");
    assert.notEqual(setup[0]!.env?.DOCKER_CONFIG, config, "setup uses its private client config");
    for (const call of [...setup, ...probes]) {
      assert.deepEqual(containerEnvironmentArguments(call.args), DOCKER_PROXY_CLEAR_VALUES);
    }
    for (const probe of probes) {
      assert.equal(probe.env?.DOCKER_CONFIG, config, "the probe client can read operator config");
    }
  } finally {
    if (previousConfig === undefined) delete process.env.DOCKER_CONFIG;
    else process.env.DOCKER_CONFIG = previousConfig;
    rmSync(config, { recursive: true, force: true });
  }
});

test("Podman installation probes disable default forwarding of client proxy variables", {
  skip: process.platform !== "linux",
}, async () => {
  const previousProxy = process.env.HTTP_PROXY;
  process.env.HTTP_PROXY = "http://user:synthetic-password@proxy.example.invalid:8080";
  try {
    const probes: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const registry = new ContainerTargetRegistry("runner", "host", [{ ...template, runtime: "podman" }], {
      podmanDefaultsSafe: () => true,
      resolveRuntime: async () => runtime(),
      run: async (_file, args, opts) => {
        if (args[0] === "info") return { code: 0, stdout: "false\n", stderr: "" };
        if (args[0] === "run" && args[args.indexOf("--name") + 1]?.startsWith("wollipog-probe-")) {
          probes.push({ args, env: opts.env });
          if (args.includes("/bin/sh")) return { code: 0, stdout: "/usr/bin/codex\n", stderr: "" };
          if (args.includes("--version")) return { code: 0, stdout: "codex 1.0.0\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await registry.initialize();
    assert.ok(probes.length >= 2, "resolution and version both launch probe containers");
    for (const probe of probes) {
      assert.equal(probe.env?.HTTP_PROXY, process.env.HTTP_PROXY, "Podman client has the host proxy");
      assert.ok(probe.args.includes("--http-proxy=false"), "the client cannot pass that proxy into the container");
    }
  } finally {
    if (previousProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = previousProxy;
  }
});

test("a timed-out authentication probe is removed and never becomes readiness evidence", async () => {
  const calls: string[][] = [];
  const registry = new ContainerTargetRegistry("runner", "host", [template], {
    resolveRuntime: async () => runtime(),
    run: async (_file, args) => {
      calls.push(args);
      if (args.includes("/bin/sh")) return { code: 0, stdout: "/usr/bin/codex\n", stderr: "" };
      if (args.at(-1) === "--version") return { code: 0, stdout: "codex 0.154.0\n", stderr: "" };
      if (args.at(-1) === "--help") return { code: 0,
        stdout: "Usage: codex app-server [OPTIONS] [COMMAND]\nCommands:\n  generate-json-schema\nOptions:\n  --listen <URL> (default: stdio://)\n", stderr: "" };
      if (args.at(-1) === "status") return { code: null, stdout: "Logged in using ChatGPT",
        stderr: "", timedOut: true };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await registry.initialize();
  const installation = registry.definitions()[0]!.harnessInstallations![0]!;
  assert.equal(installation.authentication, "unknown");
  assert.equal(installation.authenticationEvidence, undefined);
  assert.equal(installation.capability, "verified");
  const auth = calls.find((args) => args.at(-1) === "status")!;
  const name = auth[auth.indexOf("--name") + 1]!;
  assert.deepEqual(calls.find((args) => args[0] === "rm"), ["rm", "-f", name]);
});

test("an output-limit error removes its probe container before returning unknown", async () => {
  const calls: string[][] = [];
  const registry = new ContainerTargetRegistry("runner", "host", [template], {
    resolveRuntime: async () => runtime(),
    run: async (_file, args) => {
      calls.push(args);
      if (args.includes("/bin/sh")) return { code: 0, stdout: "/usr/bin/codex\n", stderr: "" };
      if (args.at(-1) === "--version") return { code: 0, stdout: "codex 0.154.0\n", stderr: "" };
      if (args.at(-1) === "--help") return { code: 0, stdout: "Usage: codex app-server [OPTIONS] [COMMAND]\nCommands:\n  generate-json-schema\nOptions:\n  --listen <URL> (default: stdio://)\n", stderr: "" };
      if (args.at(-1) === "status") return { code: 1, stdout: "Logged in using ChatGPT", stderr: "",
        errorCode: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await registry.initialize();
  assert.equal(registry.definitions()[0]!.harnessInstallations![0]!.authentication, "unknown");
  const auth = calls.find((args) => args.at(-1) === "status")!;
  assert.deepEqual(calls.find((args) => args[0] === "rm"), ["rm", "-f", auth[auth.indexOf("--name") + 1]]);
});

test("a timed-out container version probe is named, labelled, and forcibly removed", async () => {
  const calls: string[][] = [];
  const registry = new ContainerTargetRegistry("runner", "host", [template], {
    resolveRuntime: async () => runtime(),
    run: async (_file, args) => {
      calls.push(args);
      if (args.includes("/bin/sh")) return { code: 0, stdout: "/usr/bin/codex\n", stderr: "" };
      if (args[args.indexOf("--entrypoint") + 1] === "/usr/bin/codex") {
        return { code: null, stdout: "", stderr: "timed out", timedOut: true };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await registry.initialize();
  const versionProbe = calls.find((args) => args[args.indexOf("--entrypoint") + 1] === "/usr/bin/codex")!;
  const name = versionProbe[versionProbe.indexOf("--name") + 1]!;
  assert.match(name, /^wollipog-probe-[a-f0-9]{20}-[a-f0-9]{16}$/);
  assert.ok(versionProbe.includes(`com.wollipog.runner=${runnerKey("runner")}`));
  assert.deepEqual(calls.find((args) => args[0] === "rm"), ["rm", "-f", name]);
  assert.equal(registry.definitions()[0]!.harnessInstallations?.[0]?.available, false);
});

test("container target display names stay within the control-plane registration bound", async () => {
  const registry = new ContainerTargetRegistry(
    "runner",
    "h".repeat(150),
    [{ ...template, name: "n".repeat(100) }],
    { resolveRuntime: async () => runtime(), run: async () => ({ code: 0, stdout: "", stderr: "" }) },
  );
  await registry.initialize();
  assert.equal(registry.definitions()[0]!.name.length, 180);
});

test("missing runtimes and failed checks stay visible but unavailable without fallback", async () => {
  const missing = new ContainerTargetRegistry("r", "host", [template], {
    resolveRuntime: async () => null,
    run: async () => { throw new Error("must not run"); },
  });
  await missing.initialize();
  assert.equal(missing.definitions()[0]!.available, false);
  assert.match(missing.definitions()[0]!.unavailableReason!, /not installed/);

  let call = 0;
  const failedCalls: string[][] = [];
  let setupHome = "";
  const failed = new ContainerTargetRegistry("r", "host", [template], {
    resolveRuntime: async () => runtime(),
    run: async (_file, args, opts) => {
      failedCalls.push(args);
      call += 1;
      if (args[0] === "run" || args[0] === "rm") {
        assert.equal(opts.replaceEnv, true);
        assert.deepEqual(Object.keys(opts.env ?? {}).sort(),
          process.platform === "win32"
            ? ["DOCKER_CONFIG", "HOME", "PATH", "SystemRoot", "XDG_CONFIG_HOME"].sort()
            : ["DOCKER_CONFIG", "HOME", "PATH", "XDG_CONFIG_HOME"].sort());
        setupHome = opts.env!.HOME!;
      }
      return args[0] === "run"
        ? { code: 1, stdout: "", stderr: "fixture-sensitive-check-output" }
        : { code: 0, stdout: "", stderr: "" };
    },
  });
  await failed.initialize();
  assert.equal(failed.definitions()[0]!.available, false);
  assert.equal(failed.definitions()[0]!.unavailableReason, "setup check 'git' exited unsuccessfully");
  assert.doesNotMatch(JSON.stringify(failed.definitions()), /fixture-sensitive-check-output/);
  assert.equal(existsSync(setupHome), false);
  assert.equal(call, 5);
  assert.deepEqual(failedCalls[4]?.slice(0, 2), ["rm", "-f"]);
  assert.match(failedCalls[4]?.[2] ?? "", /^wollipog-check-[a-f0-9]{20}-[a-f0-9]{16}$/);
});

test("canonical and legacy inventories start concurrently within one timeout envelope", async () => {
  const started: string[] = [];
  const timeouts: Array<number | undefined> = [];
  const releases: Array<(result: { code: number; stdout: string; stderr: string }) => void> = [];
  let reportStarted!: (startedTogether: boolean) => void;
  const startedTogether = new Promise<boolean>((resolve) => {
    reportStarted = resolve;
    setImmediate(() => resolve(false));
  });
  const registry = new ContainerTargetRegistry("runner-concurrent", "host", [template], {
    resolveRuntime: async () => runtime(),
    run: async (_file, args, opts) => {
      if (args[0] !== "ps") return { code: 0, stdout: "", stderr: "" };
      started.push(args[3]!);
      timeouts.push(opts.timeoutMs);
      if (started.length === 2) reportStarted(true);
      return await new Promise((resolve) => releases.push(resolve));
    },
  });

  const initializing = registry.initialize();
  assert.equal(await startedTogether, true, "both queries must start before either one resolves");
  assert.deepEqual(started.map((filter) => filter.split("=")[1]), [
    CANONICAL_CONTAINER_LABELS.runner,
    LEGACY_CONTAINER_LABELS.runner,
  ]);
  assert.deepEqual(timeouts, [15_000, 15_000]);
  for (const release of releases) release({ code: 0, stdout: "", stderr: "" });
  await initializing;
  assert.equal(registry.definitions()[0]!.available, true);
});

test("Docker and Podman discover both generations and produce exact dual-label Wollipog identities", async () => {
  const runtimes: Array<"docker" | "podman"> = process.platform === "linux" ? ["docker", "podman"] : ["docker"];
  for (const runtimeName of runtimes) {
    const calls: Array<{ file: string; args: string[] }> = [];
    const runtimeTemplate = { ...template, runtime: runtimeName };
    const expectedRunnerKey = runnerKey(`runner-${runtimeName}`);
    const registry = new ContainerTargetRegistry(`runner-${runtimeName}`, "host", [runtimeTemplate], {
      podmanDefaultsSafe: () => true,
      resolveRuntime: async () => ({
        path: `/usr/bin/${runtimeName}`,
        via: "path" as const,
        launch: { command: `/usr/bin/${runtimeName}`, args: [] },
      }),
      run: async (file, args) => {
        calls.push({ file, args });
        if (args[0] === "info") return { code: 0, stdout: "false\n", stderr: "" };
        if (args[0] === "ps") {
          const canonical = args[3] === `label=${CANONICAL_CONTAINER_LABELS.runner}=${expectedRunnerKey}`;
          return { code: 0, stdout: canonical ? "aaaaaaaaaaaa\nbbbbbbbbbbbb\n" : "bbbbbbbbbbbb\ncccccccccccc\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      warnLegacyContainerLabels: () => {},
    });

    await registry.initialize();

    assert.deepEqual(calls.slice(0, 2), [
      {
        file: `/usr/bin/${runtimeName}`,
        args: ["ps", "-aq", "--filter", `label=${CANONICAL_CONTAINER_LABELS.runner}=${expectedRunnerKey}`],
      },
      {
        file: `/usr/bin/${runtimeName}`,
        args: ["ps", "-aq", "--filter", `label=${LEGACY_CONTAINER_LABELS.runner}=${expectedRunnerKey}`],
      },
    ]);
    assert.deepEqual(calls[2], {
      file: `/usr/bin/${runtimeName}`,
      args: ["rm", "-f", "aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"],
    });
    const expectedCheckKey = createHash("sha256")
      .update(`${template.id}\0${template.setupChecks[0]!.name}`)
      .digest("hex")
      .slice(0, 16);
    if (runtimeName === "podman") {
      assert.deepEqual(calls[4]?.args, ["info", "--format", "{{json .Host.ServiceIsRemote}}"]);
    }
    assert.deepEqual(calls[runtimeName === "podman" ? 5 : 4], {
      file: `/usr/bin/${runtimeName}`,
      args: [
        "run", "--rm", "--pull=never",
        ...(runtimeName === "podman" ? ["--http-proxy=false"] : []),
        "--name", `wollipog-check-${expectedRunnerKey}-${expectedCheckKey}`,
        "--label", `com.wollipog.runner=${expectedRunnerKey}`,
        "--label", `com.wollipog.template=${template.id}`,
        "--label", `com.misko-agent-manager.runner=${expectedRunnerKey}`,
        "--label", `com.misko-agent-manager.template=${template.id}`,
        "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--pids-limit", "128",
        "--tmpfs", "/tmp:rw,nosuid,nodev",
        ...(runtimeName === "docker" ? DOCKER_PROXY_CLEAR_VALUES.flatMap((value) => ["--env", value]) : []),
        "--entrypoint", "git", image, "--version",
      ],
    });
    assert.equal(registry.definitions()[0]!.available, true);
    const definition = registry.definitions()[0]!;
    const ref: ExecutionTargetRef = {
      id: definition.id,
      runnerId: definition.runnerId,
      kind: definition.kind,
      workspaceStrategy: definition.workspaceStrategy,
      adapter: definition.adapter,
      boundaries: definition.boundaries,
      environment: definition.environment,
    };
    const isolation = registry.isolation(ref, "codex", "codex", [], "session-1");
    const expectedSessionKey = createHash("sha256")
      .update(`runner-${runtimeName}\0session-1`)
      .digest("hex")
      .slice(0, 24);
    assert.equal(isolation.command, `/usr/bin/${runtimeName}`);
    assert.equal(isolation.containerName, `wollipog-${expectedSessionKey}`);
  }
});

test("legacy-only container discovery emits one value-free warning across Docker and Podman", async () => {
  const warnings: string[] = [];
  const registry = new ContainerTargetRegistry("runner-warning-secret", "host", [
    { ...template, id: "docker-tools", runtime: "docker" },
    ...(process.platform === "linux" ? [{ ...template, id: "podman-tools", runtime: "podman" as const }] : []),
  ], {
    podmanDefaultsSafe: () => true,
    resolveRuntime: async (runtimeName) => ({
      path: `/usr/bin/${runtimeName}`,
      via: "path" as const,
      launch: { command: `/usr/bin/${runtimeName}`, args: [] },
    }),
    run: async (file, args) => {
      if (args[0] === "info") return { code: 0, stdout: "false\n", stderr: "" };
      if (args[0] !== "ps") return { code: 0, stdout: "", stderr: "" };
      const canonical = args[3]?.includes(CANONICAL_CONTAINER_LABELS.runner) ?? false;
      const legacyOnlyId = file.endsWith("podman") ? "cccccccccccc" : "bbbbbbbbbbbb";
      return {
        code: 0,
        stdout: canonical ? "aaaaaaaaaaaa\n" : `aaaaaaaaaaaa\n${legacyOnlyId}\n`,
        stderr: "",
      };
    },
    warnLegacyContainerLabels: (message) => warnings.push(message),
  });

  await registry.initialize();

  assert.deepEqual(warnings, [
    "legacy-only com.misko-agent-manager.* container state was found during orphan cleanup; " +
    "compatibility remains active for this migration window",
  ]);
  assert.doesNotMatch(warnings[0]!, /runner-warning-secret|docker-tools|podman-tools|a{12}|b{12}|c{12}/u);
});

test("the default production sink emits the bounded compatibility-window notice", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => warnings.push(values.map(String).join(" "));
  try {
    const registry = new ContainerTargetRegistry("runner-default-warning-secret", "host", [template], {
      resolveRuntime: async () => runtime(),
      run: async (_file, args) => {
        if (args[0] !== "ps") return { code: 0, stdout: "", stderr: "" };
        const canonical = args[3]?.includes(CANONICAL_CONTAINER_LABELS.runner) ?? false;
        return { code: 0, stdout: canonical ? "" : "aaaaaaaaaaaa\n", stderr: "" };
      },
    });

    await registry.initialize();
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, [
    "[runner] legacy-only com.misko-agent-manager.* container state was found during orphan cleanup; " +
    "compatibility remains active for this migration window",
  ]);
  assert.doesNotMatch(warnings[0]!, /runner-default-warning-secret|a{12}/u);
});

test("canonical-only and dual-labelled inventories do not emit legacy warnings", async () => {
  for (const mode of ["canonical-only", "dual"] as const) {
    const warnings: string[] = [];
    const registry = new ContainerTargetRegistry(`runner-${mode}`, "host", [template], {
      resolveRuntime: async () => runtime(),
      run: async (_file, args) => {
        if (args[0] !== "ps") return { code: 0, stdout: "", stderr: "" };
        const canonical = args[3]?.includes(CANONICAL_CONTAINER_LABELS.runner) ?? false;
        return {
          code: 0,
          stdout: canonical || mode === "dual" ? "aaaaaaaaaaaa\n" : "",
          stderr: "",
        };
      },
      warnLegacyContainerLabels: (message) => warnings.push(message),
    });

    await registry.initialize();

    assert.deepEqual(warnings, []);
  }
});

test("startup fails closed before removal when either label inventory cannot be trusted", async () => {
  for (const failure of ["canonical-error", "legacy-error", "canonical-invalid", "legacy-invalid"] as const) {
    const calls: string[][] = [];
    const warnings: string[] = [];
    const registry = new ContainerTargetRegistry(`runner-${failure}`, "host", [template], {
      resolveRuntime: async () => runtime(),
      run: async (_file, args) => {
        calls.push(args);
        if (args[0] !== "ps") return { code: 0, stdout: "", stderr: "" };
        const canonical = args[3]?.includes(CANONICAL_CONTAINER_LABELS.runner) ?? false;
        if ((failure === "canonical-error" && canonical) || (failure === "legacy-error" && !canonical)) {
          return { code: 1, stdout: "", stderr: `${failure} list failed` };
        }
        if ((failure === "canonical-invalid" && canonical) || (failure === "legacy-invalid" && !canonical)) {
          return { code: 0, stdout: "not-a-container-id\n", stderr: "" };
        }
        return { code: 0, stdout: "abcdef123456\n", stderr: "" };
      },
      warnLegacyContainerLabels: (message) => warnings.push(message),
    });

    await registry.initialize();

    assert.equal(registry.definitions()[0]!.available, false);
    assert.match(registry.definitions()[0]!.unavailableReason!, /orphan reconciliation failed/u);
    assert.equal(calls.some((args) => args[0] === "rm"), false);
    assert.deepEqual(warnings, []);
  }
});

test("startup bounds the combined canonical and legacy orphan inventory", async () => {
  const canonicalIds = Array.from({ length: 65 }, (_, index) => (0x100000000000 + index).toString(16));
  const legacyIds = Array.from({ length: 64 }, (_, index) => (0x200000000000 + index).toString(16));
  const calls: string[][] = [];
  const warnings: string[] = [];
  const bounded = new ContainerTargetRegistry("r", "host", [template], {
    resolveRuntime: async () => runtime(),
    run: async (_file, args) => {
      calls.push(args);
      if (args[0] === "ps") {
        const canonical = args[3]?.includes(CANONICAL_CONTAINER_LABELS.runner) ?? false;
        return { code: 0, stdout: `${(canonical ? canonicalIds : legacyIds).join("\n")}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    warnLegacyContainerLabels: (message) => warnings.push(message),
  });
  await bounded.initialize();
  assert.equal(bounded.definitions()[0]!.available, false);
  assert.match(bounded.definitions()[0]!.unavailableReason!, /invalid.*inventory/u);
  assert.equal(calls.some((args) => args[0] === "rm"), false);
  assert.deepEqual(warnings, []);
});

test("128 dual-labelled containers deduplicate within the inventory bound", async () => {
  const ids = Array.from({ length: 128 }, (_, index) => (0x400000000000 + index).toString(16));
  const calls: string[][] = [];
  const warnings: string[] = [];
  const registry = new ContainerTargetRegistry("runner-dual-bound", "host", [template], {
    resolveRuntime: async () => runtime(),
    run: async (_file, args) => {
      calls.push(args);
      if (args[0] === "ps") return { code: 0, stdout: `${ids.join("\n")}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    warnLegacyContainerLabels: (message) => warnings.push(message),
  });

  await registry.initialize();

  const removal = calls.find((args) => args[0] === "rm");
  assert.deepEqual(removal, ["rm", "-f", ...ids]);
  assert.equal(registry.definitions()[0]!.available, true);
  assert.deepEqual(warnings, []);
});

test("an over-bound canonical or legacy generation prevents warning and removal", async () => {
  const overBoundIds = Array.from({ length: 129 }, (_, index) => (0x300000000000 + index).toString(16));
  for (const overBoundGeneration of ["canonical", "legacy"] as const) {
    const calls: string[][] = [];
    const warnings: string[] = [];
    const registry = new ContainerTargetRegistry(`runner-over-bound-${overBoundGeneration}`, "host", [template], {
      resolveRuntime: async () => runtime(),
      run: async (_file, args) => {
        calls.push(args);
        if (args[0] !== "ps") return { code: 0, stdout: "", stderr: "" };
        const canonical = args[3]?.includes(CANONICAL_CONTAINER_LABELS.runner) ?? false;
        const overBound = canonical === (overBoundGeneration === "canonical");
        return {
          code: 0,
          stdout: overBound ? `${overBoundIds.join("\n")}\n` : "ffffffffffff\n",
          stderr: "",
        };
      },
      warnLegacyContainerLabels: (message) => warnings.push(message),
    });

    await registry.initialize();

    assert.equal(calls.filter((args) => args[0] === "ps").length, 2);
    assert.equal(calls.some((args) => args[0] === "rm"), false);
    assert.deepEqual(warnings, []);
    assert.equal(registry.definitions()[0]!.available, false);
    assert.match(registry.definitions()[0]!.unavailableReason!, /invalid.*inventory/u);
  }
});

test("orphan removal failure leaves the target unavailable with the existing diagnostic", async () => {
  const calls: string[][] = [];
  const warnings: string[] = [];
  const registry = new ContainerTargetRegistry("runner-remove-failure", "host", [template], {
    resolveRuntime: async () => runtime(),
    run: async (_file, args) => {
      calls.push(args);
      if (args[0] === "ps") {
        const canonical = args[3]?.includes(CANONICAL_CONTAINER_LABELS.runner) ?? false;
        return { code: 0, stdout: canonical ? "" : "aaaaaaaaaaaa\n", stderr: "" };
      }
      if (args[0] === "rm") return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    warnLegacyContainerLabels: (message) => warnings.push(message),
  });

  await registry.initialize();

  assert.equal(registry.definitions()[0]!.available, false);
  assert.equal(
    registry.definitions()[0]!.unavailableReason,
    "orphan reconciliation failed: could not remove orphaned runner containers",
  );
  assert.equal(calls.filter((args) => args[0] === "rm").length, 1);
  assert.equal(calls.some((args) => args[0] === "image"), false);
  assert.equal(warnings.length, 1);
});
