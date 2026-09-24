import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunnerContainerTarget } from "./config.js";
import { ContainerTargetRegistry } from "./container-target.js";
import type { ExecResult } from "./discovery/resolve.js";

const pinnedHost = "unix:///run/wollipog-test/docker.sock";
const decoyHost = "unix:///run/wollipog-test/decoy.sock";
const template: RunnerContainerTarget = {
  id: "probe-cleanup", name: "Probe Cleanup", revision: 1, runtime: "docker",
  image: `example/agent@sha256:${"a".repeat(64)}`, network: "deny",
  agentCommands: { synthetic: { command: "synthetic" } },
  setupChecks: [{ name: "ready", command: "true" }],
};

type RunOptions = { timeoutMs?: number; maxBuffer?: number;
  env?: Record<string, string>; replaceEnv?: boolean };
type Call = { file: string; args: string[]; options: RunOptions };

for (const failure of ["timeout", "client error"] as const) {
  test(`failed Docker installation probe cleans up with its pinned client after ${failure}`, async () => {
    const operatorConfig = mkdtempSync(join(tmpdir(), "wollipog-probe-cleanup-"));
    const saved = {
      DOCKER_HOST: process.env.DOCKER_HOST,
      DOCKER_CONFIG: process.env.DOCKER_CONFIG,
      DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
    };
    writeFileSync(join(operatorConfig, "config.json"), JSON.stringify({
      proxies: { default: { httpProxy: "http://operator:secret@decoy.invalid:8080" } },
    }));
    process.env.DOCKER_HOST = pinnedHost;
    process.env.DOCKER_CONFIG = operatorConfig;
    process.env.DOCKER_CONTEXT = "operator-context";
    const calls: Call[] = [];
    try {
      const registry = new ContainerTargetRegistry("runner", "host", [template], {
        resolveRuntime: async () => ({ path: "/usr/bin/docker", via: "path",
          launch: { command: "/usr/bin/docker", args: [] } }),
        run: async (file, args, options): Promise<ExecResult> => {
          calls.push({ file, args, options });
          if (args[0] === "--version") return { code: 0, stdout: "Docker version 27.0.0\n", stderr: "" };
          if (args[0] === "version") return { code: 0, stdout: JSON.stringify({
            Server: { Components: [{ Name: "Engine" }] },
          }), stderr: "" };
          if (args[0] === "run" && args.includes("/bin/sh")) {
            return { code: 0, stdout: "/usr/bin/synthetic\n", stderr: "" };
          }
          if (args[0] === "run" && args.includes("/usr/bin/synthetic")) {
            // The ambient selectors may change while a client is blocked; cleanup must still
            // address the same daemon with the private config captured for this exact probe.
            process.env.DOCKER_HOST = decoyHost;
            process.env.DOCKER_CONFIG = operatorConfig;
            process.env.DOCKER_CONTEXT = "decoy-context";
            return failure === "timeout"
              ? { code: null, stdout: "", stderr: "", timedOut: true }
              : { code: 1, stdout: "", stderr: "", errorCode: "ENOENT" };
          }
          if (args[0] === "rm") return { code: 1, stdout: "", stderr: "cleanup failed" };
          return { code: 0, stdout: "", stderr: "" };
        },
      });
      await registry.initialize();
      const probe = calls.find(({ args }) => args[0] === "run" && args.includes("/usr/bin/synthetic"))!;
      const cleanup = calls.find(({ args }) => args[0] === "rm")!;
      const name = probe.args[probe.args.indexOf("--name") + 1];
      assert.deepEqual(cleanup.args, ["rm", "-f", name]);
      assert.equal(cleanup.file, probe.file);
      assert.equal(cleanup.options.timeoutMs, 5_000);
      assert.equal(cleanup.options.maxBuffer, 64 * 1024);
      assert.equal(cleanup.options.replaceEnv, true);
      assert.deepEqual(cleanup.options.env, probe.options.env);
      assert.equal(cleanup.options.env?.DOCKER_HOST, pinnedHost);
      assert.equal(cleanup.options.env?.DOCKER_CONTEXT, undefined);
      assert.equal(cleanup.options.env?.WOLLIPOG_SESSION_ID, undefined);
      assert.notEqual(cleanup.options.env?.DOCKER_CONFIG, operatorConfig);
      assert.equal(readFileSync(join(cleanup.options.env!.DOCKER_CONFIG!, "config.json"), "utf8"), "{}\n");
      assert.equal(registry.definitions()[0]!.harnessInstallations?.[0]?.available, false,
        "a failed probe and failed cleanup cannot advertise a usable installation");
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(operatorConfig, { recursive: true, force: true });
    }
  });
}
