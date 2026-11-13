/** Inactive #3922 fixed Agent Control child seam. No driver or capability path imports it.
 * File hashes below check supplied bytes before launch; actual mount/import attestation and
 * transitive CP effects remain activation blockers, independently of these checks. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { Transform, type Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolvePiCommandHomePrototypePolicy, type PiCommandHomePrototypeAudit, type PiCommandHomePrototypePolicy } from "./pi-command-home-prototype.js";
import { buildBwrapArgs, killTree, provenProcessTreeExit, spawnAgent } from "./spawn.js";

export const PI_INERT_CONTROL_ENTRYPOINT_SHA256 = "914c8b834df6ec6c1aaf3e0e2bd92269f1070204317a3dc221445a74e0aa97ae";
export const PI_INERT_CONTROL_RPC_LINE_BYTES = 1_048_576;
const REFUSAL = "Pi inert control launcher refused execution.";
export interface PiInertControlPolicy {
  commandPolicy: PiCommandHomePrototypePolicy;
  controlEntrypoint: string;
  /** Fixed runner MCP entrypoint, never selected by a tool request. */
  mcpEntrypoint: string;
  mcpEntrypointSha256: string;
  /** Explicit candidate import closure. Checking these bytes is not proof of completeness. */
  imports: readonly { path: string; sha256: string }[];
  transportEnvironment: Readonly<Record<string, string>>;
}
function checkedFile(path: string, sha256: string, budget: { left: number }): void {
  if (!/^[a-f0-9]{64}$/u.test(sha256) || realpathSync(path) !== path) throw new Error(REFUSAL);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 209_715_200 || stat.size > budget.left ||
      createHash("sha256").update(readFileSync(path)).digest("hex") !== sha256) throw new Error(REFUSAL);
  budget.left -= stat.size;
}
function rpcBound() {
  let lineBytes = 0;
  return new Transform({ transform(chunk: Buffer, _encoding, callback) {
    for (const byte of chunk) {
      if (++lineBytes > PI_INERT_CONTROL_RPC_LINE_BYTES) { callback(new Error(REFUSAL)); return; }
      if (byte === 10) lineBytes = 0;
    }
    callback(null, chunk);
  } });
}
export function createPiInertControlLauncher(policy: PiInertControlPolicy, deps: PiCommandHomePrototypeAudit & Partial<{
  spawn: typeof spawnAgent; kill: typeof killTree; prove: typeof provenProcessTreeExit;
}> = {}) {
  let frame: Buffer;
  let args: string[];
  let launcher: string;
  let cwd: string;
  try {
    const files = [{ path: policy.controlEntrypoint, sha256: PI_INERT_CONTROL_ENTRYPOINT_SHA256 },
      { path: policy.mcpEntrypoint, sha256: policy.mcpEntrypointSha256 }, ...policy.imports];
    if (files.length > 10_000 || new Set(files.map(file => file.path)).size !== files.length) throw new Error(REFUSAL);
    // Reuse the policy validator before opening these candidate MCP code bytes: paths must be
    // outside every writable source/target, including HOME, project, cache and Git grants.
    const { inner, cwdRoot } = resolvePiCommandHomePrototypePolicy({ ...policy.commandPolicy,
      immutablePaths: [...policy.commandPolicy.immutablePaths, ...files.map(file => file.path)] }, deps);
    const budget = { left: 536_870_912 };
    for (const file of files) checkedFile(file.path, file.sha256, budget);
    const env: Record<string, string> = Object.create(null);
    Object.assign(env, { HOME: policy.commandPolicy.providerHome, PATH: "/usr/bin:/bin", LANG: "C" });
    if (Object.keys(policy.transportEnvironment).length > 253) throw new Error(REFUSAL);
    for (const [key, value] of Object.entries(policy.transportEnvironment)) {
      if (key.length > 256 || !/^WOLLIPOG_[A-Z0-9_]+$/u.test(key) || typeof value !== "string" ||
          value.includes("\0") || Buffer.byteLength(value) > 32_768) throw new Error(REFUSAL);
      env[key] = value;
    }
    const payload = Buffer.from(JSON.stringify({ version: 1, env }));
    if (payload.length > 262_144) throw new Error(REFUSAL);
    frame = Buffer.alloc(4 + payload.length); frame.writeUInt32BE(payload.length); payload.copy(frame, 4);
    cwd = cwdRoot;
    launcher = inner.command;
    args = buildBwrapArgs({ command: policy.commandPolicy.nodeRuntime,
      args: ["--no-addons", "--no-global-search-paths", policy.controlEntrypoint,
        policy.commandPolicy.nodeRuntime, policy.mcpEntrypoint, cwd], cwd }, inner);
  } catch { throw new Error(REFUSAL); }
  const spawn = deps.spawn ?? spawnAgent, kill = deps.kill ?? killTree, prove = deps.prove ?? provenProcessTreeExit;
  return Object.freeze({
    /** Owns these three streams for one bounded inert run. Fixed command/policy/env were captured
     * above; no RPC message or per-run argument can supply a command or a wider mount. */
    async run(input: Readable, output: Writable, stderr: Writable, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
      const timeoutMs = options.timeoutMs ?? 60_000;
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error(REFUSAL);
      if (options.signal?.aborted) throw new Error("aborted");
      let child;
      try {
        child = spawn({ command: launcher, args: [...args], cwd, env: { PATH: "/usr/bin:/bin", LANG: "C" },
          scrubInheritedEnv: Object.keys(process.env), context: { kind: "native" }, windowsShell: false });
      } catch { throw new Error(REFUSAL); }
      let closed = false, failed = false, timedOut = false;
      let killResult: Promise<unknown> | undefined;
      let finish = (_code: number | null) => {};
      const fail = () => {
        if (failed) return;
        failed = true;
        if (!closed) killResult = Promise.resolve().then(() => kill(child)).catch(() => {});
        input.destroy(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        output.destroy(); stderr.destroy();
        finish(null);
      };
      const exit = new Promise<number | null>(resolve => {
        finish = resolve;
        child.once("error", fail);
        child.once("close", code => { closed = true; input.destroy(); resolve(code); });
      });
      child.stdin.on("error", () => { if (!closed) fail(); });
      const abort = () => fail();
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      const timer = setTimeout(() => { timedOut = true; fail(); }, timeoutMs);
      const streams = [pipeline(child.stdout, rpcBound(), output).catch(fail), pipeline(child.stderr, rpcBound(), stderr).catch(fail)];
      // Install lifetime/error listeners before writing either the handoff or RPC traffic.
      const incoming = (async () => {
        try {
          await new Promise<void>((resolve, reject) => child.stdin.write(frame, error => error ? reject(error) : resolve()));
          if (!closed && !failed) await pipeline(input, rpcBound(), child.stdin);
        } catch { if (!closed) fail(); }
      })();
      try {
        const exitCode = await exit;
        if (killResult) await killResult;
        if (!await prove(child)) throw new Error("Pi inert control launcher could not prove child-tree exit.");
        // A synthetic or failed spawn seam must not leave stream promises/inputs alive.
        input.destroy(); child.stdin.destroy();
        await Promise.allSettled([...streams, incoming]);
        if (options.signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error("Pi inert control launcher timed out.");
        if (failed) throw new Error(REFUSAL);
        return { exitCode };
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        input.destroy(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        output.destroy(); stderr.destroy();
        await Promise.allSettled([...streams, incoming]);
      }
    },
  });
}
