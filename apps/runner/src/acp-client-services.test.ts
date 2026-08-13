import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ACP_FILE_BYTE_LIMIT,
  AcpFilesystemService,
  AcpTerminalService,
} from "./acp-client-services.js";
import { terminalOutputDelta } from "./acp.js";
import { waitForPendingKills } from "./spawn.js";

const NATIVE = { kind: "native" } as const;

test("ACP filesystem stays under the canonical session root and bounds text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-acp-fs-root-"));
  const outside = await mkdtemp(join(tmpdir(), "wollipog-acp-fs-outside-"));
  const service = new AcpFilesystemService(root, NATIVE);
  try {
    await writeFile(join(root, "lines.txt"), "one\ntwo\nthree\n", "utf8");
    assert.equal(await service.read(join(root, "lines.txt"), 2, 1), "two");
    await service.write(join(root, "nested", "created.txt"), "safe");
    assert.equal(await readFile(join(root, "nested", "created.txt"), "utf8"), "safe");
    await assert.rejects(service.read(join(outside, "missing.txt")), /outside|ENOENT/);
    await assert.rejects(service.write(join(outside, "escaped.txt"), "no"), /outside/);
    await assert.rejects(service.write(join(root, "huge.txt"), "x".repeat(ACP_FILE_BYTE_LIMIT + 1)), /limited/);

    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    try {
      await symlink(join(outside, "secret.txt"), join(root, "escape.txt"), "file");
      await assert.rejects(service.read(join(root, "escape.txt")), /outside|escape/);
      await assert.rejects(service.write(join(root, "escape.txt"), "overwrite"), /outside|escape/);
      assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "secret");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") t.diagnostic("symlink checks skipped: host disallows symlink creation");
      else throw error;
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("ACP filesystem and terminal accept only explicitly installed additional roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-acp-primary-"));
  const granted = await mkdtemp(join(tmpdir(), "wollipog-acp-granted-"));
  const denied = await mkdtemp(join(tmpdir(), "wollipog-acp-denied-"));
  const service = new AcpFilesystemService(root, NATIVE);
  service.setAdditionalRoots([granted]);
  const terminals = new AcpTerminalService(service, NATIVE);
  try {
    await service.write(join(granted, "context.txt"), "allowed");
    assert.equal(await service.read(join(granted, "context.txt")), "allowed");
    await assert.rejects(service.write(join(denied, "context.txt"), "denied"), /outside the session roots/);
    const { terminalId } = await terminals.create({
      sessionId: "additional-root",
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.cwd())"],
      cwd: granted,
      env: [],
    });
    await terminals.wait("additional-root", terminalId);
    assert.equal(terminals.output("additional-root", terminalId).output, await realpath(granted));
    await assert.rejects(terminals.create({
      sessionId: "additional-root",
      command: process.execPath,
      args: ["-e", ""],
      cwd: denied,
      env: [],
    }), /outside the session roots/);
  } finally {
    terminals.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(granted, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(denied, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("ACP filesystem permits an in-root symlink read but never follows an escaping write", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-acp-fs-link-"));
  const service = new AcpFilesystemService(root, NATIVE);
  try {
    await writeFile(join(root, "target.txt"), "before", "utf8");
    try {
      await symlink(join(root, "target.txt"), join(root, "link.txt"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("host disallows symlink creation");
        return;
      }
      throw error;
    }
    assert.equal(await service.read(join(root, "link.txt")), "before");
    if (process.platform !== "win32") await chmod(join(root, "target.txt"), 0o664);
    await service.write(join(root, "link.txt"), "after");
    assert.equal(await readFile(join(root, "target.txt"), "utf8"), "after");
    if (process.platform !== "win32") {
      assert.equal((await stat(join(root, "target.txt"))).mode & 0o777, 0o664, "existing mode survives umask");
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("ACP terminal implements output/wait/release with UTF-8 byte truncation and env scrubbing", async () => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-acp-terminal-"));
  const fs = new AcpFilesystemService(root, NATIVE);
  const terminals = new AcpTerminalService(fs, NATIVE);
  const oldCurrent = process.env.WOLLIPOG_PLAIN;
  const oldLegacy = process.env.MAM_PLAIN;
  process.env.WOLLIPOG_PLAIN = "must-not-leak-current";
  process.env.MAM_PLAIN = "must-not-leak-legacy";
  try {
    const code = "process.stdout.write([process.cwd(),process.env.ACP_ALLOWED,process.env.WOLLIPOG_PLAIN||'scrubbed',process.env.MAM_PLAIN||'scrubbed','😀tail'].join('|'))";
    const { terminalId } = await terminals.create({
      sessionId: "session-a",
      command: process.execPath,
      args: ["-e", code],
      cwd: root,
      env: [{ name: "ACP_ALLOWED", value: "visible" }],
      outputByteLimit: 40,
    });
    assert.deepEqual(await terminals.wait("session-a", terminalId), { exitCode: 0, signal: null });
    const output = terminals.output("session-a", terminalId);
    assert.equal(output.truncated, true);
    assert.ok(Buffer.byteLength(output.output, "utf8") <= 40);
    assert.doesNotMatch(output.output, /must-not-leak|�/);
    assert.match(output.output, /visible\|scrubbed\|scrubbed\|😀tail$/);
    assert.deepEqual(output.exitStatus, { exitCode: 0, signal: null });
    terminals.release("session-a", terminalId);
    assert.throws(() => terminals.output("session-a", terminalId), /Unknown/);
  } finally {
    terminals.dispose();
    if (oldCurrent === undefined) delete process.env.WOLLIPOG_PLAIN;
    else process.env.WOLLIPOG_PLAIN = oldCurrent;
    if (oldLegacy === undefined) delete process.env.MAM_PLAIN;
    else process.env.MAM_PLAIN = oldLegacy;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("ACP terminal IDs are session-scoped and kill preserves final output until release", async () => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-acp-terminal-kill-"));
  const fs = new AcpFilesystemService(root, NATIVE);
  const terminals = new AcpTerminalService(fs, NATIVE);
  try {
    const { terminalId } = await terminals.create({
      sessionId: "session-a",
      command: process.execPath,
      args: ["-e", "process.stdout.write('started');setInterval(()=>{},1000)"],
      cwd: root,
      outputByteLimit: 1024,
    });
    assert.throws(() => terminals.output("session-b", terminalId), /Unknown/);
    const startedAt = Date.now();
    while (!terminals.output("session-a", terminalId).output.includes("started")) {
      if (Date.now() - startedAt > 10_000) throw new Error("terminal did not produce its startup output");
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    terminals.kill("session-a", terminalId);
    await Promise.race([
      terminals.wait("session-a", terminalId),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("terminal kill timed out")), 10_000);
        timer.unref();
      }),
    ]);
    const output = terminals.output("session-a", terminalId);
    assert.match(output.output, /started/);
    assert.ok(output.exitStatus);
    terminals.release("session-a", terminalId);
  } finally {
    terminals.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("ACP terminal executable arguments keep shell metacharacters as one literal argv value", async () => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-acp-terminal-argv-"));
  const marker = join(root, "must-not-exist.txt");
  const fs = new AcpFilesystemService(root, NATIVE);
  const terminals = new AcpTerminalService(fs, NATIVE);
  try {
    const hostile = `literal & echo injected > ${marker}`;
    const { terminalId } = await terminals.create({
      sessionId: "session-a",
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", hostile],
      cwd: root,
    });
    await terminals.wait("session-a", terminalId);
    assert.equal(terminals.output("session-a", terminalId).output, hostile);
    await assert.rejects(readFile(marker), /ENOENT/);
    terminals.release("session-a", terminalId);
  } finally {
    terminals.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("ACP terminal drains a large burst while retaining only the bounded output tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-acp-terminal-burst-"));
  const fs = new AcpFilesystemService(root, NATIVE);
  const terminals = new AcpTerminalService(fs, NATIVE);
  try {
    const { terminalId } = await terminals.create({
      sessionId: "session-a",
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(2*1024*1024)+'END')"],
      cwd: root,
      outputByteLimit: 257,
    });
    await terminals.wait("session-a", terminalId);
    const output = terminals.output("session-a", terminalId);
    assert.equal(output.truncated, true);
    assert.equal(Buffer.byteLength(output.output, "utf8"), 257);
    assert.match(output.output, /END$/);
    terminals.release("session-a", terminalId);
  } finally {
    terminals.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("ACP terminal reserves its per-session cap across concurrent creates", async () => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-acp-terminal-cap-"));
  const fs = new AcpFilesystemService(root, NATIVE);
  const terminals = new AcpTerminalService(fs, NATIVE);
  try {
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => terminals.create({
      sessionId: "session-a",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: root,
    })));
    const created = attempts
      .filter((result): result is PromiseFulfilledResult<{ terminalId: string }> => result.status === "fulfilled")
      .map((result) => result.value.terminalId);
    assert.equal(created.length, 8);
    assert.equal(attempts.filter((result) => result.status === "rejected").length, 4);
    for (const terminalId of created) terminals.release("session-a", terminalId);
    const replacement = await terminals.create({
      sessionId: "session-a",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: root,
    });
    terminals.release("session-a", replacement.terminalId);
    await waitForPendingKills(5_000);
  } finally {
    terminals.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("ACP terminal session release cancels a create still resolving its cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-acp-terminal-create-race-"));
  let resolveDirectory!: (path: string) => void;
  const directory = new Promise<string>((resolve) => { resolveDirectory = resolve; });
  const fs = {
    directory: () => directory,
    directoryRoot: async () => root,
  } as unknown as AcpFilesystemService;
  const terminals = new AcpTerminalService(fs, NATIVE);
  try {
    const creating = terminals.create({
      sessionId: "session-a",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: root,
    });
    terminals.releaseSession("session-a");
    resolveDirectory(root);
    await assert.rejects(creating, /no longer active/);
  } finally {
    terminals.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("ACP terminal wait is bounded when a descendant keeps inherited output pipes open", async () => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-acp-terminal-drain-"));
  const fs = new AcpFilesystemService(root, NATIVE);
  const terminals = new AcpTerminalService(fs, NATIVE);
  try {
    const code = "const c=require('node:child_process').spawn(process.execPath,['-e',\"setTimeout(()=>process.stdout.write('late'),3000)\"],{stdio:['ignore',1,2]});c.unref()";
    const { terminalId } = await terminals.create({
      sessionId: "session-a",
      command: process.execPath,
      args: ["-e", code],
      cwd: root,
    });
    assert.deepEqual(await terminals.wait("session-a", terminalId), { exitCode: 0, signal: null });
    assert.doesNotMatch(
      terminals.output("session-a", terminalId).output,
      /late/,
      "wait resolves after a bounded drain, before descendant pipe close",
    );
    terminals.release("session-a", terminalId);
    await waitForPendingKills(5_000);
  } finally {
    terminals.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("terminal output cursors emit only unseen UTF-8 tail bytes after truncation", () => {
  assert.equal(
    terminalOutputDelta(undefined, { output: "tail", truncated: true, cursor: 10 }),
    "[terminal output truncated]\ntail",
  );
  assert.equal(
    terminalOutputDelta(5, { output: "BBBBB", truncated: true, cursor: 10 }),
    "[terminal output truncated]\nBBBBB",
  );
  assert.equal(
    terminalOutputDelta(10, { output: "AA😀tail", truncated: true, cursor: 14 }),
    "tail",
  );
  assert.equal(terminalOutputDelta(14, { output: "AA😀tail", truncated: true, cursor: 14 }), null);
});

test("ACP terminal release reaps a still-running process before it can outlive the session", async () => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-acp-terminal-release-"));
  const marker = join(root, "orphan.txt");
  const fs = new AcpFilesystemService(root, NATIVE);
  const terminals = new AcpTerminalService(fs, NATIVE);
  try {
    const { terminalId } = await terminals.create({
      sessionId: "session-a",
      command: process.execPath,
      args: [
        "-e",
        "setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'orphan'),3000);setInterval(()=>{},1000)",
        marker,
      ],
      cwd: root,
    });
    terminals.release("session-a", terminalId);
    await waitForPendingKills(5_000);
    await assert.rejects(readFile(marker), /ENOENT/);
  } finally {
    terminals.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("ACP terminal cwd cannot escape the session filesystem root", async () => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-acp-terminal-root-"));
  const outside = await mkdtemp(join(tmpdir(), "wollipog-acp-terminal-outside-"));
  const fs = new AcpFilesystemService(root, NATIVE);
  const terminals = new AcpTerminalService(fs, NATIVE);
  try {
    await mkdir(join(root, "inside"));
    await assert.rejects(terminals.create({
      sessionId: "session-a",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: outside,
    }), /outside/);
    assert.equal(await fs.directory(join(root, "inside")), await realpath(join(root, "inside")));
  } finally {
    terminals.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
