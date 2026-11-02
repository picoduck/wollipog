import assert from "node:assert/strict";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localSshSupportsStdinNull, sshLaunchDiagnostic, supervisedSshCommand } from "./ssh-runner-launch.js";
import { buildSshArgs } from "./box-orchestrator.js";

test("owned SSH options preserve the user's portable IgnoreUnknown configuration", async t => {
  if (spawnSync("ssh", ["-V"]).error) { t.skip("OpenSSH client unavailable"); return; }
  const root = mkdtempSync(join(tmpdir(), "ssh-user-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "config");
  writeFileSync(config, "IgnoreUnknown WollipogFixtureUnsupported\nWollipogFixtureUnsupported yes\n");
  const args = buildSshArgs({ sshTarget: "localhost", sshPort: 22, remotePort: 47100, cpPort: 4317, remoteCommand: "runner",
    stdinNullSupported: await localSshSupportsStdinNull() });
  const result = spawnSync("ssh", ["-F", config, "-G", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("SSH diagnostics retain fixed launch evidence without copying stderr content", () => {
  assert.deepEqual(sshLaunchDiagnostic("[runner] ssh_launch mode=process-scan reason=user-manager-unavailable; private details"),
    { event: "ssh_runner_launch", mode: "process-scan" });
  assert.deepEqual(sshLaunchDiagnostic("[runner] provider_process_containment proofStandard=linux-cgroup-v2 reason=available"),
    { event: "ssh_runner_containment", proofStandard: "linux-cgroup-v2", reason: "available" });
  assert.equal(sshLaunchDiagnostic("private provider output"), null);
  assert.equal(sshLaunchDiagnostic("[runner] provider_process_containment proofStandard=linux-cgroup-v2 reason=available secret"), null);
});

test("SSH launch delegates before executing the runner and preserves shell arguments", t => {
  const root = mkdtempSync(join(tmpdir(), "ssh-runner-launch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = (name: string, body: string) => {
    const path = join(root, name);
    writeFileSync(path, "#!/bin/sh\n" + body); chmodSync(path, 0o700);
  };
  executable("uname", "echo Linux\n");
  executable("systemctl", "exit 0\n");
  executable("systemd-run", `if [ "$1" = --help ]; then echo --expand-environment; exit; fi
printf '%s\\n' "$@" > "$CAPTURE"
while [ "$1" != -- ]; do shift; done
shift
exec "$@"
`);
  executable("runner", `printf '%s\\n' "$WOLLIPOG_SSH_SUPERVISED" "$WOLLIPOG_SSH_REQUIRE_CGROUP" "$@"\n`);
  const command = supervisedSshCommand("runner 'workspace:$HOME/a b' 'quote'\\''value'", "wollipog-ssh-test.scope");
  const result = spawnSync("/bin/sh", ["-c", command], {
    env: { ...process.env, PATH: root + ":/usr/bin:/bin", CAPTURE: join(root, "args") }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "1\n1\nworkspace:$HOME/a b\nquote'value\n");
  const args = readFileSync(join(root, "args"), "utf8");
  assert.match(args, /--scope\n/);
  assert.match(args, /--property=Delegate=yes\n/);
  assert.match(args, /--expand-environment=no\n/);
  assert.match(args, /--unit=wollipog-ssh-test.scope\n/);
});

for (const mode of ["unavailable-manager", "scope-failure", "old-systemd", "macos"] as const) {
  test(`SSH launch handles ${mode} without retrying a failed scope as an uncontained runner`, t => {
    const root = mkdtempSync(join(tmpdir(), "ssh-runner-compat-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const executable = (name: string, body: string) => {
      const path = join(root, name);
      writeFileSync(path, "#!/bin/sh\n" + body); chmodSync(path, 0o700);
    };
    executable("uname", mode === "macos" ? "echo Darwin" : "echo Linux");
    executable("systemctl", mode === "unavailable-manager" ? "exit 1" : "exit 0");
    executable("systemd-run", `if [ "$1" = --help ]; then exit; fi
printf '%s\\n' "$@" > "$CAPTURE"
${mode === "scope-failure" ? "exit 42" : 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"'}
`);
    executable("runner", `echo "$WOLLIPOG_SSH_SUPERVISED:$WOLLIPOG_SSH_REQUIRE_CGROUP"\n`);
    const result = spawnSync("/bin/sh", ["-c", supervisedSshCommand("runner", "wollipog-ssh-compat.scope")], {
      env: { ...process.env, WOLLIPOG_SSH_REQUIRE_CGROUP: "inherited", PATH: root + ":/usr/bin:/bin", CAPTURE: join(root, "args") },
      encoding: "utf8",
    });
    if (mode === "scope-failure") {
      assert.equal(result.status, 42);
      assert.equal(result.stdout, "", "no uncontained fallback after scope creation was attempted");
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), mode === "old-systemd" ? "1:1" : "1:");
    }
    if (mode === "old-systemd") assert.doesNotMatch(readFileSync(join(root, "args"), "utf8"), /expand-environment/);
    if (mode === "unavailable-manager") assert.match(result.stderr, /user-manager-unavailable/);
    if (mode === "macos" || mode === "unavailable-manager") assert.equal(existsSync(join(root, "args")), false);
  });
}
