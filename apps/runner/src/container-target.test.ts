import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ExecutionTargetRef } from "@wollipog/protocol";
import type { RunnerContainerTarget } from "./config.js";
import { CANONICAL_CONTAINER_LABELS, LEGACY_CONTAINER_LABELS } from "./container-identity.js";
import { ContainerTargetRegistry, containerSetupCheckDigest, containerTargetId } from "./container-target.js";

const image = `example/agent@sha256:${"a".repeat(64)}`;
const template: RunnerContainerTarget = {
  id: "offline-tools", name: "Offline tools", revision: 3, runtime: "docker", image, network: "deny",
  agentCommands: { codex: { command: "codex", args: ["app-server"] } },
  setupChecks: [{ name: "git", command: "git", args: ["--version"] }],
};

function runtime() {
  return { path: "/usr/bin/docker", via: "path" as const, launch: { command: "/usr/bin/docker", args: [] } };
}

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
  assert.match(checkCall[3]!, /^wollipog-check-[a-f0-9]{20}-[a-f0-9]{16}$/);
  assert.deepEqual(checkCall.slice(0, 3), ["run", "--rm", "--name"]);
  assert.deepEqual(checkCall.slice(4), [
    "--label", `com.wollipog.runner=${expectedRunnerKey}`,
    "--label", "com.wollipog.template=offline-tools",
    "--label", `com.misko-agent-manager.runner=${expectedRunnerKey}`,
    "--label", "com.misko-agent-manager.template=offline-tools",
    "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--pids-limit", "128",
    "--tmpfs", "/tmp:rw,nosuid,nodev", "--entrypoint", "git", image, "--version",
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
  const failed = new ContainerTargetRegistry("r", "host", [template], {
    resolveRuntime: async () => runtime(),
    run: async (_file, args) => {
      failedCalls.push(args);
      call += 1;
      return args[0] === "run"
        ? { code: 1, stdout: "", stderr: "missing git" }
        : { code: 0, stdout: "", stderr: "" };
    },
  });
  await failed.initialize();
  assert.equal(failed.definitions()[0]!.available, false);
  assert.match(failed.definitions()[0]!.unavailableReason!, /setup check 'git'.*missing git/);
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
  for (const runtimeName of ["docker", "podman"] as const) {
    const calls: Array<{ file: string; args: string[] }> = [];
    const runtimeTemplate = { ...template, runtime: runtimeName };
    const expectedRunnerKey = runnerKey(`runner-${runtimeName}`);
    const registry = new ContainerTargetRegistry(`runner-${runtimeName}`, "host", [runtimeTemplate], {
      resolveRuntime: async () => ({
        path: `/usr/bin/${runtimeName}`,
        via: "path" as const,
        launch: { command: `/usr/bin/${runtimeName}`, args: [] },
      }),
      run: async (file, args) => {
        calls.push({ file, args });
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
    assert.deepEqual(calls[4], {
      file: `/usr/bin/${runtimeName}`,
      args: [
        "run", "--rm", "--name", `wollipog-check-${expectedRunnerKey}-${expectedCheckKey}`,
        "--label", `com.wollipog.runner=${expectedRunnerKey}`,
        "--label", `com.wollipog.template=${template.id}`,
        "--label", `com.misko-agent-manager.runner=${expectedRunnerKey}`,
        "--label", `com.misko-agent-manager.template=${template.id}`,
        "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--pids-limit", "128",
        "--tmpfs", "/tmp:rw,nosuid,nodev", "--entrypoint", "git", image, "--version",
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
    { ...template, id: "podman-tools", runtime: "podman" },
  ], {
    resolveRuntime: async (runtimeName) => ({
      path: `/usr/bin/${runtimeName}`,
      via: "path" as const,
      launch: { command: `/usr/bin/${runtimeName}`, args: [] },
    }),
    run: async (file, args) => {
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
