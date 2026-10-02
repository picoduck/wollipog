import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "esbuild";
import type { SessionLaunchSpec } from "@wollipog/protocol";
import { defaultAgentControlHost } from "./agent-control.js";
import { provisionClaudeHooks, provisionCodexGuard } from "./hook-settings.js";
import { defaultRunnerReentryHost, runnerReentryCommand } from "./runner-reentry.js";

const modes = ["--policy-hook", "--agent-control-mcp", "--wollipog-cli", "--managed-worktree-guard"] as const;

function withEntry<T>(entry: string | undefined, fn: () => T): T {
  const original = process.argv;
  process.argv = entry === undefined ? [process.execPath] : [process.execPath, entry];
  try {
    return fn();
  } finally {
    process.argv = original;
  }
}

function assertRefusal(fn: () => unknown, entry: string | undefined): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(JSON.stringify(entry ?? "<missing>")));
    assert.match(error.message, /Pass an explicit host/);
    return true;
  });
}

test("the default host refuses missing and unrelated entries, including dispatcher lookalikes", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-reentry-refusal-"));
  try {
    for (const name of ["measure.ts", "cli.ts", "index.ts"]) {
      writeFileSync(join(dir, name), "// Safe fixture: never executed.\n");
    }
    for (const entry of [undefined, "", join(dir, "missing.ts"), ...["measure.ts", "cli.ts", "index.ts"].map((name) => join(dir, name))]) {
      withEntry(entry, () => assertRefusal(defaultRunnerReentryHost, entry));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source CLI and legacy index dispatch every supported sidecar mode", () => {
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  for (const name of ["cli.ts", "index.ts"]) {
    withEntry(fileURLToPath(new URL(`./${name}`, import.meta.url)), () => {
      const host = defaultRunnerReentryHost();
      assert.equal(host.isSea, false);
      for (const mode of modes) {
        const command = runnerReentryCommand(host, mode);
        assert.equal(command.command, process.execPath);
        assert.deepEqual(command.args.slice(-2), [cli, mode]);
      }
    });
  }
});

test("relative paths and symlinked legacy entries resolve to the absolute CLI", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "runner-reentry-alias-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const alias = join(dir, "measure.ts");
  const entries = [relative(process.cwd(), cli)];
  // Creating file symlinks on Windows requires privileges the test runner may not have.
  if (process.platform !== "win32") {
    symlinkSync(fileURLToPath(new URL("./index.ts", import.meta.url)), alias);
    entries.push(alias);
  }
  for (const entry of entries) {
    withEntry(entry, () => {
      assert.deepEqual(runnerReentryCommand(defaultRunnerReentryHost(), "--policy-hook").args.slice(-2), [cli, "--policy-hook"]);
    });
  }
});

test("built JavaScript uses its own adjacent CLI, without launching a daemon", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "runner-reentry-built-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  // Compile the real modules into the same layout as tsc. Import only the re-entry helper.
  for (const name of ["runner-reentry", "cli", "index"]) {
    const source = readFileSync(new URL(`./${name}.ts`, import.meta.url), "utf8");
    const built = await transform(source, { loader: "ts", format: "esm", target: "node24" });
    writeFileSync(join(dir, `${name}.js`), built.code);
  }
  const built = await import(pathToFileURL(join(dir, "runner-reentry.js")).href) as typeof import("./runner-reentry.js");
  for (const name of ["cli.js", "index.js"]) {
    withEntry(join(dir, name), () => {
      for (const mode of modes) {
        assert.deepEqual(built.runnerReentryCommand(built.defaultRunnerReentryHost(), mode).args.slice(-2), [join(dir, "cli.js"), mode]);
      }
    });
  }
  const sourceCli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  withEntry(sourceCli, () => assertRefusal(built.defaultRunnerReentryHost, sourceCli));
});

test("SEA defaults dispatch through the executable without a script entry", (t) => {
  const sea = createRequire(import.meta.url)("node:sea") as { isSea: () => boolean };
  t.mock.method(sea, "isSea", () => true);
  withEntry(undefined, () => {
    const host = defaultRunnerReentryHost();
    assert.equal(host.isSea, true);
    for (const mode of modes) {
      assert.deepEqual(runnerReentryCommand(host, mode), { command: process.execPath, args: [mode] });
    }
  });
});

test("explicit custom hosts preserve their script and execution flags", () => {
  const host = { isSea: false, execPath: "/custom/node", execArgv: ["--no-warnings"], scriptPath: "/custom/sidecar.mjs" };
  withEntry("/custom/measure.ts", () => {
    for (const mode of modes) {
      assert.deepEqual(runnerReentryCommand(host, mode), {
        command: host.execPath, args: ["--no-warnings", host.scriptPath, mode],
      });
    }
  });
});

test("default provisioning refuses before inspecting launch state or writing files", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "runner-reentry-provision-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const entry = join(dir, "measure.ts");
  const untouchedSpec = new Proxy({} as SessionLaunchSpec, {
    get() { throw new Error("Provisioning inspected launch state before refusing the entry"); },
  });
  withEntry(entry, () => {
    assertRefusal(() => provisionClaudeHooks(untouchedSpec, {
      controlPlaneUrl: "ws://127.0.0.1:4317/runner", controlPlaneProtocolVersion: null, enabled: true,
    }, () => {}), entry);
    assertRefusal(() => defaultAgentControlHost(dir), entry);
  });
  // Default parameters of an async provisioner reject its promise before entering the body.
  const promise = withEntry(entry, () => provisionCodexGuard(untouchedSpec, { protections: [], cwd: dir }, () => {}));
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(JSON.stringify(entry)));
    assert.match(error.message, /Pass an explicit host/);
    return true;
  });
  assert.deepEqual(readdirSync(dir), []);
});
