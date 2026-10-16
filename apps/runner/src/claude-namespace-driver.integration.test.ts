import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { claudeProjectPathKey } from "./claude-background-work.js";
import { ClaudeCodeDriver } from "./drivers/claude-code.js";
import type { DriverCallbacks, DriverOptions } from "./drivers/driver.js";
import { POLICY_HOOK_RELAY_KEY_ENV } from "./policy-hook-relay.js";
import { waitForPendingKills, type BwrapSpawnIsolation } from "./spawn.js";

const available = process.platform === "linux" && existsSync("/usr/bin/bwrap") && existsSync("/usr/bin/cc");
const root = mkdtempSync(join(tmpdir(), "wollipog-claude-driver-namespace-"));
const worktree = join(root, "worktree");
mkdirSync(worktree);
after(() => rmSync(root, { recursive: true, force: true }));
const gatedStart = join(worktree, "gated-task-started");
const gatedResume = join(worktree, "gated-provider-resumed");
const gatedRelease = join(worktree, "gated-task-release");
const gatedScript = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const output = process.argv[1];",
  "fs.mkdirSync(path.dirname(output), { recursive: true });",
  "fs.writeFileSync(output, '');",
  `fs.writeFileSync(${JSON.stringify(gatedStart)}, 'started');`,
  `const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(gatedRelease)})) return; fs.writeFileSync(output, 'complete'); clearInterval(timer); }, 10);`,
].join("\n");
const fakeProvider = join(worktree, "fake-claude.cjs");
writeFileSync(fakeProvider, [
  "const fs = require('node:fs');",
  "const cp = require('node:child_process');",
  "let input = '';",
  "const reply = (prompt) => {",
  "  const text = String(prompt);",
  "  if (text.includes('gated')) {",
  "    const sessionArg = process.argv.findIndex(arg => arg === '--session-id' || arg === '--resume');",
  "    const sessionId = process.argv[sessionArg + 1];",
  `    const output = '/tmp/claude/${claudeProjectPathKey(worktree)}/' + sessionId + '/tasks/gated-task.output';`,
  "    if (text.includes('first')) {",
  `      cp.spawn(process.execPath, ['-e', ${JSON.stringify(gatedScript)}, output], {detached:true,stdio:'ignore'}).unref();`,
  "      process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'gated-launch',name:'Task',input:{run_in_background:true}}]}})+'\\n');",
  "      process.stdout.write(JSON.stringify({type:'system',subtype:'task_started',task_id:'gated-task',tool_use_id:'gated-launch'})+'\\n');",
  "      process.stdout.write(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'gated-launch',content:JSON.stringify({status:'async_launched',taskId:'gated-task',outputFile:output})}]}})+'\\n');",
  "      process.stdout.write(JSON.stringify({type:'result',subtype:'success'})+'\\n');",
  "      return;",
  "    }",
  "    if (text.includes('next')) {",
  `      fs.writeFileSync(${JSON.stringify(gatedResume)}, process.argv.includes('--resume') ? sessionId : 'missing-resume');`,
  "      const timer = setInterval(() => {",
  "        if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== 'complete') return;",
  "        clearInterval(timer);",
  "        process.stdout.write(JSON.stringify({type:'system',subtype:'task_notification',task_id:'gated-task',status:'completed'})+'\\n');",
  "        process.stdout.write(JSON.stringify({type:'result',subtype:'success'})+'\\n');",
  "      }, 10);",
  "      return;",
  "    }",
  "  }",
  "  if (text.includes('first')) {",
  "    cp.spawn('/bin/sh',['-c','sleep .2; echo complete > /tmp/claude/background-result'],{detached:true,stdio:'ignore'}).unref();",
  "  }",
  "  if (text.includes('next') && !fs.existsSync('/tmp/claude/background-result')) process.exitCode = 9;",
  "  const relay = text.match(/relay:(first|none|second)/);",
  "  if (relay && (process.env.WOLLIPOG_POLICY_HOOK_RELAY_KEY || 'none') !== relay[1]) process.exitCode = 9;",
  "  process.stdout.write(JSON.stringify({type:'result',subtype:process.exitCode ? 'error' : 'success'})+'\\n');",
  "  if (text.includes('retire')) setImmediate(()=>process.exit(process.exitCode || 0));",
  "};",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => {",
  "  input += chunk;",
  "  for (;;) { const newline = input.indexOf('\\n'); if (newline < 0) break;",
  "    const line = input.slice(0,newline); input = input.slice(newline+1); if (line) reply(line);",
  "  }",
  "});",
  "process.stdin.on('end', () => { if (input) reply(input); });",
].join("\n"));

const isolation: BwrapSpawnIsolation = {
  backend: "bwrap", command: "/usr/bin/bwrap", args: [], network: "inherit",
  protectedWorktree: { parent: root, path: worktree, gitWritableRoots: [] },
};

function driver(persistent: boolean): { driver: ClaudeCodeDriver; stderr: string[]; environment: Record<string, string>;
  background: Array<Parameters<NonNullable<DriverCallbacks["onBackgroundWork"]>>[0]> } {
  const stderr: string[] = [];
  const background: Array<Parameters<NonNullable<DriverCallbacks["onBackgroundWork"]>>[0]> = [];
  const callbacks: DriverCallbacks = {
    onEvent: () => {},
    onStderr: (text) => stderr.push(text),
    onExit: () => {},
    onBackgroundWork: (update) => background.push(update),
  };
  const environment: Record<string, string> = { WOLLIPOG_CLAUDE_PERSISTENT: persistent ? "1" : "0" };
  const options: DriverOptions = {
    command: process.execPath,
    args: [fakeProvider],
    cwd: worktree,
    env: environment,
    config: { permissionMode: "acceptEdits" } as DriverOptions["config"],
    context: { kind: "native" },
    isolation,
  };
  return { driver: new ClaudeCodeDriver(options, callbacks), stderr, environment, background };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, `fixture did not reach ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("real bwrap Claude driver completes a held background task only after one-shot resume", {
  skip: !available, timeout: 30_000,
}, async () => {
  const harness = driver(false);
  let resumeDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await harness.driver.newSession(worktree);
    assert.equal(await harness.driver.prompt("first gated"), "end_turn", harness.stderr.join("\n"));
    await waitForFile(gatedStart);
    const pending = harness.background.flatMap(update => update.jobs ?? [])
      .find(job => job.id === "gated-task" && job.outputFile);
    assert.ok(pending?.outputFile, "the driver recorded the provider task output path");
    assert.equal(readFileSync(pending.outputFile, "utf8"), "", "the first provider turn ended before task completion");

    const resumed = harness.driver.prompt("next gated");
    await waitForFile(gatedResume);
    assert.equal(readFileSync(gatedResume, "utf8"), harness.driver.agentSessionId(), "the next provider used --resume");
    assert.equal(readFileSync(pending.outputFile, "utf8"), "", "the resumed provider observed the task still pending");
    writeFileSync(gatedRelease, "release");
    assert.equal(await Promise.race([
      resumed,
      new Promise<never>((_, reject) => {
        resumeDeadline = setTimeout(() => reject(new Error("resumed fixture provider did not complete within 10 seconds")), 10_000);
      }),
    ]), "end_turn", harness.stderr.join("\n"));
    assert.equal(readFileSync(pending.outputFile, "utf8"), "complete");
    assert.ok(harness.background.some(update => update.terminalJobs?.some(job =>
      job.id === "gated-task" && job.status === "completed" && job.outputFile === pending.outputFile)),
    "the driver reported the retained task output as completed after resume");
  } finally {
    if (resumeDeadline) clearTimeout(resumeDeadline);
    // A failed assertion must release the detached fixture before namespace teardown.
    writeFileSync(gatedRelease, "release");
    harness.driver.dispose({ forceImmediate: true });
    assert.equal(await waitForPendingKills(6_000), true);
  }
});

test("real bwrap Claude driver receives each turn's open and recovered hook relay key", {
  skip: !available, timeout: 30_000,
}, async () => {
  const harness = driver(false);
  try {
    harness.environment[POLICY_HOOK_RELAY_KEY_ENV] = "first";
    await harness.driver.newSession(worktree);
    assert.equal(await harness.driver.prompt("relay:first"), "end_turn", harness.stderr.join("\n"));
    delete harness.environment[POLICY_HOOK_RELAY_KEY_ENV];
    assert.equal(await harness.driver.prompt("relay:none"), "end_turn", harness.stderr.join("\n"));
    harness.environment[POLICY_HOOK_RELAY_KEY_ENV] = "second";
    assert.equal(await harness.driver.prompt("relay:second"), "end_turn", harness.stderr.join("\n"));
  } finally {
    harness.driver.dispose({ forceImmediate: true });
    assert.equal(await waitForPendingKills(6_000), true);
  }
});

test("real bwrap Claude driver keeps persistent transport and safely resumes after retirement", {
  skip: !available, timeout: 30_000,
}, async () => {
  const harness = driver(true);
  try {
    await harness.driver.newSession(worktree);
    assert.equal(await harness.driver.prompt("first"), "end_turn", harness.stderr.join("\n"));
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(await harness.driver.prompt("next"), "end_turn", harness.stderr.join("\n"));
    assert.equal(await harness.driver.prompt("retire"), "end_turn", harness.stderr.join("\n"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await harness.driver.prompt("next"), "end_turn", harness.stderr.join("\n"));
  } finally {
    harness.driver.dispose({ forceImmediate: true });
    assert.equal(await waitForPendingKills(6_000), true);
  }
});
