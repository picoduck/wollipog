import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { buildSshArgs, posixQuote } from "./box-orchestrator.js";
import { localSshSupportsStdinNull, supervisedSshCommand } from "./ssh-runner-launch.js";

// Opt-in, isolated Linux SSH fixture: requires python3, no runner credential or provider HOME.
// Never replaces or signals a deployed runner. The remote unit and reverse port are attempt-private.
test("real SSH launch inherits the login environment, delegates, and exits after stdin EOF", {
  skip: !process.env.WOLLIPOG_TEST_SSH_TARGET, timeout: 30_000,
}, async t => {
  const unit = `wollipog-ssh-test-${randomUUID()}.scope`;
  const fixture = `
import os, pathlib, subprocess, json, sys
membership = pathlib.Path('/proc/self/cgroup').read_text().strip().split('::')[1]
path = pathlib.Path('/sys/fs/cgroup') / membership.lstrip('/')
leaf = path / 'wollipog-smoke-test'
leaf.mkdir()
leaf.rmdir()
delegation = subprocess.check_output(['systemctl', '--user', 'show', '--property=Delegate', '--value', os.path.basename(membership)], text=True).strip()
print(json.dumps({'unit': os.path.basename(membership), 'delegation': delegation, 'supervised': os.environ.get('WOLLIPOG_SSH_SUPERVISED'), 'required': os.environ.get('WOLLIPOG_SSH_REQUIRE_CGROUP'), 'homePreserved': os.environ.get('HOME') == str(pathlib.Path.home())}), flush=True)
sys.stdin.read()
`;
  const args = buildSshArgs({
    sshTarget: process.env.WOLLIPOG_TEST_SSH_TARGET!, sshPort: 22, remotePort: randomInt(47100, 48000), cpPort: 9,
    remoteCommand: supervisedSshCommand("python3 -c " + posixQuote(fixture), unit),
    stdinNullSupported: await localSshSupportsStdinNull(),
  });
  if (process.env.WOLLIPOG_TEST_SSH_KNOWN_HOSTS) {
    args.unshift("-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + process.env.WOLLIPOG_TEST_SSH_KNOWN_HOSTS);
  }
  const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { child.stdin.end(); if (child.exitCode === null) child.kill(); });
  child.stdin.on("error", () => {});
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  const first = await Promise.race([
    once(lines, "line").then(([line]) => String(line)),
    exited.then(() => { throw new Error("isolated SSH launch exited before readiness: " + stderr); }),
  ]);
  assert.deepEqual(JSON.parse(first), { unit, delegation: "yes", supervised: "1", required: "1", homePreserved: true });
  assert.equal(child.exitCode, null, "the scope remains owned by the live SSH transport");
  child.stdin.end();
  const [code, signal] = await exited;
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  assert.match(stderr, /ssh_launch mode=delegated-scope/);
});
