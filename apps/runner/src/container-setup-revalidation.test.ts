import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunnerContainerTarget } from "./config.js";
import { ContainerTargetRegistry, resolveContainerRuntime } from "./container-target.js";
import type { ExecResult } from "./discovery/resolve.js";

const image = `example/agent@sha256:${"a".repeat(64)}`;
const template: RunnerContainerTarget = {
  id: "offline-tools", name: "Offline Tools", revision: 1, runtime: "docker",
  image, network: "deny", agentCommands: { codex: { command: "codex" } },
  setupChecks: [
    { name: "first", command: "git", args: ["--version"] },
    { name: "second", command: "node", args: ["--version"] },
  ],
};

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const launch = { path: "/usr/bin/docker", via: "path" as const,
  launch: { command: "/usr/bin/docker", args: [] } };

test("startup checks reject a changed Docker command or engine after image inspection", async (t) => {
  const previousHost = process.env.DOCKER_HOST;
  const pinnedHost = "unix:///run/wollipog-setup-test.sock";
  process.env.DOCKER_HOST = pinnedHost;
  try {
    for (const changed of ["podman-command", "podman-engine", "inaccessible-engine"] as const) {
      await t.test(changed, async () => {
        let state: "docker" | typeof changed = "docker";
        const runs: string[][] = [];
        const identityEnvironments: Array<Record<string, string> | undefined> = [];
        const execute = async (_file: string, args: string[], opts: {
          timeoutMs?: number; maxBuffer?: number; env?: Record<string, string>; replaceEnv?: boolean;
        }): Promise<ExecResult> => {
          if (args[0] === "--version") {
            if (state !== "docker") identityEnvironments.push(opts.env);
            return ok(state === "podman-command" ? "podman version 5.0.0\n" : "Docker version 27.0.0\n");
          }
          if (args[0] === "version") {
            if (state !== "docker") identityEnvironments.push(opts.env);
            if (state === "inaccessible-engine") {
              return { code: null, stdout: "daemon-secret", stderr: "daemon-secret", timedOut: true };
            }
            return ok(JSON.stringify({ Server: { Platform: {
              Name: state === "podman-engine" ? "Podman Engine" : "Docker Engine",
            } } }));
          }
          if (args[0] === "image") { state = changed; return ok(); }
          if (args[0] === "run") { runs.push(args); return ok(); }
          return ok();
        };
        const registry = new ContainerTargetRegistry("runner", "host", [template], {
          resolveRuntime: () => resolveContainerRuntime("docker", async () => launch, execute),
          run: execute,
        });
        await registry.initialize();
        const target = registry.definitions()[0]!;
        assert.equal(target.available, false);
        assert.equal(runs.length, 0, "no setup or installation container may reach the changed engine");
        assert.doesNotMatch(target.unavailableReason ?? "", /daemon-secret/u);
        assert.ok(identityEnvironments.length >= 1, "the setup boundary rechecks Docker identity");
        for (const env of identityEnvironments) {
          assert.equal(env?.DOCKER_HOST, pinnedHost);
          assert.ok(env?.DOCKER_CONFIG);
        }
      });
    }
  } finally {
    if (previousHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previousHost;
  }
});

test("each Docker setup check revalidates immediately before its container starts", async () => {
  const previousHost = process.env.DOCKER_HOST;
  process.env.DOCKER_HOST = "unix:///run/wollipog-setup-test.sock";
  try {
    let changed = false;
    const setupRuns: string[][] = [];
    const execute = async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === "--version") return ok(changed ? "podman version 5.0.0\n" : "Docker version 27.0.0\n");
      if (args[0] === "version") return ok('{"Server":{"Components":[{"Name":"Engine"}]}}');
      if (args[0] === "run") { setupRuns.push(args); changed = true; return ok(); }
      return ok();
    };
    const registry = new ContainerTargetRegistry("runner", "host", [template], {
      resolveRuntime: () => resolveContainerRuntime("docker", async () => launch, execute),
      run: execute,
    });
    await registry.initialize();
    assert.equal(registry.definitions()[0]!.available, false);
    assert.equal(setupRuns.length, 1, "the second check must not start after the first changes the command");
  } finally {
    if (previousHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previousHost;
  }
});

test("startup checks still run on a verified, unchanged Docker engine", async () => {
  const previousHost = process.env.DOCKER_HOST;
  process.env.DOCKER_HOST = "unix:///run/wollipog-setup-test.sock";
  try {
    const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const execute = async (_file: string, args: string[], opts: {
      timeoutMs?: number; maxBuffer?: number; env?: Record<string, string>; replaceEnv?: boolean;
    }): Promise<ExecResult> => {
      calls.push({ args, env: opts.env });
      if (args[0] === "--version") return ok("Docker version 27.0.0\n");
      if (args[0] === "version") return ok('{"Server":{"Components":[{"Name":"Engine"}]}}');
      return ok();
    };
    const registry = new ContainerTargetRegistry("runner", "host", [template], {
      resolveRuntime: () => resolveContainerRuntime("docker", async () => launch, execute),
      run: execute,
    });
    await registry.initialize();
    assert.equal(registry.definitions()[0]!.available, true);
    const setupCalls = calls.flatMap((call, index) =>
      call.args[0] === "run" && call.args.includes("--pull=never") ? [index] : []);
    assert.equal(setupCalls.length, 2);
    for (const index of setupCalls) {
      assert.equal(calls[index - 2]?.args[0], "--version");
      assert.equal(calls[index - 1]?.args[0], "version");
      assert.equal(calls[index - 2]?.env, calls[index]?.env,
        "identity and setup launch must use the same pinned client environment");
      assert.equal(calls[index - 1]?.env, calls[index]?.env);
    }
    assert.ok(calls.filter(({ args }) => args[0] === "--version").length >= 3,
      "each of the two setup checks must have an identity probe after startup resolution");
  } finally {
    if (previousHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previousHost;
  }
});

test("setup identity checks use the pinned context endpoint, not an operator decoy", async () => {
  const previousHost = process.env.DOCKER_HOST;
  const previousContext = process.env.DOCKER_CONTEXT;
  const previousConfig = process.env.DOCKER_CONFIG;
  const directory = mkdtempSync(join(tmpdir(), "wollipog-setup-identity-"));
  const pinnedHost = `unix://${join(directory, "pinned.sock")}`;
  delete process.env.DOCKER_HOST;
  process.env.DOCKER_CONTEXT = "pinned";
  process.env.DOCKER_CONFIG = directory;
  writeFileSync(join(directory, "config.json"), "{}");
  try {
    let inspected = false;
    const runs: string[][] = [];
    const identityHosts: Array<string | undefined> = [];
    const execute = async (_file: string, args: string[], opts: {
      timeoutMs?: number; maxBuffer?: number; env?: Record<string, string>; replaceEnv?: boolean;
    }): Promise<ExecResult> => {
      if (args[0] === "--version") return ok("Docker version 27.0.0\n");
      if (args[0] === "version") {
        if (inspected) identityHosts.push(opts.env?.DOCKER_HOST);
        const engine = inspected && opts.env?.DOCKER_HOST === pinnedHost ? "Podman Engine" : "Docker Engine";
        return ok(JSON.stringify({ Server: { Platform: { Name: engine } } }));
      }
      if (args[0] === "context") return ok(`${JSON.stringify(pinnedHost)}\n`);
      if (args[0] === "image") { inspected = true; return ok(); }
      if (args[0] === "run") { runs.push(args); return ok(); }
      return ok();
    };
    const registry = new ContainerTargetRegistry("runner", "host", [template], {
      resolveRuntime: () => resolveContainerRuntime("docker", async () => launch, execute),
      run: execute,
    });
    await registry.initialize();
    assert.equal(registry.definitions()[0]!.available, false);
    assert.deepEqual(runs, []);
    assert.deepEqual(identityHosts, [pinnedHost]);
  } finally {
    if (previousHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previousHost;
    if (previousContext === undefined) delete process.env.DOCKER_CONTEXT;
    else process.env.DOCKER_CONTEXT = previousContext;
    if (previousConfig === undefined) delete process.env.DOCKER_CONFIG;
    else process.env.DOCKER_CONFIG = previousConfig;
    rmSync(directory, { recursive: true, force: true });
  }
});
