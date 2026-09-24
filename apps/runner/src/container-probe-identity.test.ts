import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionTargetRef } from "@wollipog/protocol";
import type { RunnerContainerTarget } from "./config.js";
import { ContainerTargetRegistry } from "./container-target.js";
import type { ExecResult } from "./discovery/resolve.js";

const image = `example/agent@sha256:${"a".repeat(64)}`;
const pinnedHost = "unix:///run/wollipog-test/docker.sock";
const decoyHost = "unix:///run/wollipog-test/decoy.sock";
const template: RunnerContainerTarget = {
  id: "probe-identity", name: "Probe Identity", revision: 1, runtime: "docker",
  image, network: "deny", agentCommands: { synthetic: { command: "synthetic" } },
  setupChecks: [{ name: "ready", command: "true" }],
};

type EngineState = "docker" | "podman-command" | "podman-engine" | "daemon-down" |
  "flip-after-probe" | "flip-after-capability" | "flip-after-setup";

function fixture(probeStatus = false) {
  let state: EngineState = "docker";
  const probes: Array<{ args: string[]; env?: Record<string, string> }> = [];
  const identities: Array<{ args: string[]; env?: Record<string, string>; replaceEnv?: boolean }> = [];
  const success = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
  const configured = probeStatus ? { ...template, agentCommands: { "claude-code": { command: "claude" } } } : template;
  const registry = new ContainerTargetRegistry("runner", "host", [configured], {
    resolveRuntime: async () => ({ path: "/usr/bin/docker", via: "path",
      launch: { command: "/usr/bin/docker", args: [] } }),
    run: async (_file, args, opts) => {
      if (args[0] === "--version" || args[0] === "version") {
        identities.push({ args, env: opts.env, replaceEnv: opts.replaceEnv });
        if (args[0] === "--version") return success(state === "podman-command"
          ? "podman version 5.0.0\n" : "Docker version 27.0.0\n");
        if (state === "daemon-down" && opts.env?.DOCKER_HOST === pinnedHost) {
          return { code: 1, stdout: "", stderr: "synthetic daemon error" };
        }
        const name = state === "podman-engine" && opts.env?.DOCKER_HOST === pinnedHost
          ? "Podman Engine" : "Engine";
        return success(JSON.stringify({ Server: { Components: [{ Name: name }] } }));
      }
      if (args[0] === "run") {
        const name = args[args.indexOf("--name") + 1];
        if (name?.startsWith("wollipog-check-") && state === "flip-after-setup") state = "podman-engine";
        if (name?.startsWith("wollipog-probe-")) {
          probes.push({ args, env: opts.env });
          if (state === "flip-after-probe") state = "podman-engine";
          if (state === "flip-after-capability" && args.at(-1) === "--help") state = "podman-engine";
          if (args.includes("/bin/sh")) return success(probeStatus ? "/usr/bin/claude\n" : "/usr/bin/synthetic\n");
          if (args.at(-1) === "--help") return success("--input-format stream-json\n--output-format stream-json\n--permission-mode (choices: \"acceptEdits\")");
          if (args.at(-1) === "status") return { code: 1, stdout: '{"loggedIn":false}', stderr: "" };
          return success(probeStatus ? "2.1.205 (Claude Code)\n" : "synthetic 1.0.0\n");
        }
      }
      return success();
    },
  });
  return { registry, probes, identities, setState: (next: EngineState) => { state = next; } };
}

test("Docker rediscovery rejects changed commands, changed pinned engines, and inaccessible daemons before probes", async (t) => {
  const previousHost = process.env.DOCKER_HOST;
  process.env.DOCKER_HOST = pinnedHost;
  try {
    for (const changed of ["podman-command", "podman-engine", "daemon-down"] as const) {
      await t.test(changed, async () => {
        const { registry, probes, identities, setState } = fixture();
        await registry.initialize();
        const ready = registry.definitions()[0]!;
        const installation = ready.harnessInstallations?.[0];
        assert.equal(ready.available, true);
        assert.ok(installation?.available);
        const priorProbes = probes.length;
        const priorIdentities = identities.length;

        setState(changed);
        process.env.DOCKER_HOST = decoyHost;
        await registry.refreshInstallations();

        const definition = registry.definitions()[0]!;
        assert.equal(probes.length, priorProbes, "an untrusted daemon must receive no probe container");
        assert.equal(definition.available, false);
        assert.equal(definition.harnessInstallations, undefined, "stale installation evidence must be cleared");
        assert.match(definition.unavailableReason ?? "", /Podman|identity/i);
        assert.doesNotMatch(definition.unavailableReason ?? "", /synthetic daemon error/);
        const ref = { ...ready, harnessInstallationId: installation.id } as ExecutionTargetRef;
        assert.match(registry.validationError(ref, true, { kind: "native" }, "synthetic") ?? "", /unavailable/);
        const checked = identities.slice(priorIdentities);
        assert.ok(checked.length > 0, "rediscovery must recheck the actual runtime");
        assert.ok(checked.every(({ env, replaceEnv }) =>
          replaceEnv === true && env?.DOCKER_HOST === pinnedHost && env.DOCKER_CONFIG),
        "identity checks must use the same pinned, isolated Docker client as probes");
      });
      process.env.DOCKER_HOST = pinnedHost;
    }
  } finally {
    if (previousHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previousHost;
  }
});

test("Docker identity is checked again between installation probes and after setup", async (t) => {
  const previousHost = process.env.DOCKER_HOST;
  process.env.DOCKER_HOST = pinnedHost;
  try {
    await t.test("engine changes after the first probe", async () => {
      const { registry, probes, setState } = fixture();
      await registry.initialize();
      const priorProbes = probes.length;
      setState("flip-after-probe");
      await registry.refreshInstallations();
      assert.equal(probes.length, priorProbes + 1, "the changed engine must not receive the next probe");
      assert.equal(registry.definitions()[0]!.available, false);
      assert.equal(registry.definitions()[0]!.harnessInstallations, undefined);
    });
    await t.test("engine changes after setup", async () => {
      const { registry, probes, setState } = fixture();
      setState("flip-after-setup");
      await registry.initialize();
      assert.equal(probes.length, 0, "startup discovery must recheck after setup before its first probe");
      assert.equal(registry.definitions()[0]!.available, false);
    });
    await t.test("a concurrent status probe cannot enter after the engine changes", async () => {
      const { registry, probes, setState } = fixture(true);
      setState("flip-after-capability");
      await registry.initialize();
      assert.equal(probes.length, 3, "resolve, version, and capability may run before the change");
      assert.equal(probes.some(({ args }) => args.at(-1) === "status"), false,
        "the authentication probe must recheck after capability changes the engine");
      assert.equal(registry.definitions()[0]!.available, false);
    });
  } finally {
    if (previousHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previousHost;
  }
});
