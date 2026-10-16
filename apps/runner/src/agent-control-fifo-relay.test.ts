import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { PROTOCOL_VERSION, type SessionLaunchSpec } from "@wollipog/protocol";
import {
  AGENT_CONTROL_RELAY_FIFO_ENV,
  AgentControlFifoRelays,
  DEFAULT_FIFO_RELAY_LIMITS,
  agentControlFifoRelayFetch,
  sweepAgentControlFifoRelays,
  type FifoRelayLimits,
} from "./agent-control-fifo-relay.js";
import type { AgentControlRelayHandler } from "./agent-control-relay.js";
import { AGENT_CONTROL_RELAY_ENDPOINT_ENV, AGENT_CONTROL_RELAY_KEY_ENV } from "./agent-control-relay.js";
import { runWollipogCli } from "./wollipog-cli.js";
import {
  markAgentControlCredentialReady,
  provisionAgentControl,
  relayAgentControlRequest,
  removeAgentControlFiles,
} from "./agent-control.js";

// The channel is provisioned only on Linux, where it was measured against Codex's sandbox.
const SKIP = process.platform !== "linux" ? "the FIFO relay is provisioned only on Linux" : false;

/** Channel directories are 0300 and cannot be listed, so open each one before removing the tree. */
function removeTree(root: string): void {
  const relax = (directory: string) => {
    try { chmodSync(directory, 0o700); } catch { return; }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) relax(join(directory, entry.name));
    }
  };
  if (existsSync(root)) relax(root);
  rmSync(root, { recursive: true, force: true });
}

const roots: string[] = [];
after(() => {
  for (const root of roots) removeTree(root);
});

function base(): string {
  const root = mkdtempSync(join(tmpdir(), "wollipog-fifo-relay-"));
  roots.push(root);
  return join(root, "fifo-relay");
}

const KEY = "k".repeat(32);

function relays(handler: AgentControlRelayHandler, limits: Partial<FifoRelayLimits> = {}) {
  return new AgentControlFifoRelays(base(), handler, { ...DEFAULT_FIFO_RELAY_LIMITS, ...limits });
}

/** What the runner left in a 0300 directory, read the only way it can be: by its owner relaxing it. */
function entries(directory: string): string[] {
  chmodSync(directory, 0o700);
  try {
    return readdirSync(directory).sort();
  } finally {
    chmodSync(directory, 0o300);
  }
}

function ring(directory: string, line: string): void {
  const fd = openSync(join(directory, "doorbell"), constants.O_WRONLY | constants.O_NONBLOCK);
  try { writeSync(fd, line); } finally { closeSync(fd); }
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const isFifo = (path: string) => { try { return lstatSync(path).isFIFO(); } catch { return false; } };

test("a FIFO channel carries relay frames both ways, concurrently, and leaves no names behind", { skip: SKIP }, async () => {
  const seen: Array<{ sessionId: string; path: string; key: string; body?: string }> = [];
  const channel = relays(async (sessionId, request) => {
    seen.push({ sessionId, path: request.path, key: request.key, ...(request.body ? { body: request.body } : {}) });
    return { status: 201, body: JSON.stringify({ path: request.path, length: request.body?.length ?? 0 }) };
  });
  try {
    const directory = await channel.ensure("s_fifo_roundtrip");
    const fetch = agentControlFifoRelayFetch(directory, KEY);
    // Bodies well past the 64 KiB pipe buffer, in both directions at once.
    const results = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
      const response = await fetch(`http://127.0.0.1:1/api/item/${index}?q=${index}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blob: "x".repeat(index * 150_000) }),
      });
      return { status: response.status, ok: response.ok, body: JSON.parse(await response.text()) as Record<string, unknown> };
    }));
    for (const [index, result] of results.entries()) {
      assert.equal(result.status, 201);
      assert.equal(result.ok, true);
      assert.equal(result.body.path, `/api/item/${index}?q=${index}`);
      assert.equal(result.body.length, JSON.stringify({ blob: "x".repeat(index * 150_000) }).length);
    }
    assert.equal(seen.length, 6);
    assert.ok(seen.every((request) => request.sessionId === "s_fifo_roundtrip" && request.key === KEY));
    assert.deepEqual(entries(directory), ["doorbell"], "every per-request FIFO is unlinked");
  } finally {
    await channel.closeAll();
  }
});

test("no other session can find a channel, list its nonces, or read its doorbell", { skip: SKIP }, async () => {
  const channel = relays(async () => ({ status: 200, body: "{}" }));
  try {
    const directory = await channel.ensure("s_fifo_modes");
    // Knowing a session id is not enough to reach its doorbell.
    assert.match(directory, /\/s_fifo_modes\.[0-9a-f]{32}$/u);
    assert.equal(existsSync(join(directory, "..", "s_fifo_modes")), false);
    assert.throws(() => readdirSync(join(directory, "..")), { code: "EACCES" }, "the base cannot be listed");
    assert.equal(statSync(join(directory, "..")).mode & 0o777, 0o300);
    assert.equal(statSync(directory).mode & 0o777, 0o300);
    assert.equal(statSync(join(directory, "doorbell")).mode & 0o777, 0o200);
    assert.ok(statSync(join(directory, "doorbell")).isFIFO());
    assert.throws(() => readdirSync(directory), { code: "EACCES" }, "a nonce cannot be learned by listing");
    assert.throws(() => openSync(join(directory, "doorbell"), constants.O_RDONLY | constants.O_NONBLOCK),
      { code: "EACCES" }, "a nonce cannot be learned by reading the doorbell");
  } finally {
    await channel.closeAll();
  }
});

test("a wrong relay key is refused by the runner without contacting the control plane", { skip: SKIP }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-fifo-relay-key-"));
  roots.push(root);
  const launch: SessionLaunchSpec = {
    sessionId: "s_fifo_key", workspaceId: "ws", workspacePath: "/repo", agentId: "codex", command: "codex",
    args: [], env: {}, useWorktree: false, driver: "codex-app-server", context: { kind: "native" },
  };
  const hashes: string[] = [];
  provisionAgentControl(launch, {
    controlPlaneUrl: "ws://127.0.0.1:4317/runner",
    controlPlaneProtocolVersion: PROTOCOL_VERSION,
    executionIsolationMode: "provider",
    providerRelayEndpoint: "tcp://127.0.0.1:4318",
    registerCredential: (_id, hash) => hashes.push(hash),
  }, () => {}, { isSea: true, execPath: "/opt/wollipog-runner", execArgv: [], configDir: root, platform: "linux" });
  markAgentControlCredentialReady(root, launch.sessionId, hashes[0]!);
  const contacted: string[] = [];
  const channel = relays((sessionId, request, signal) => relayAgentControlRequest(sessionId, request, signal,
    async (input, init) => {
      contacted.push(`${String(input)} ${new Headers(init?.headers).get("authorization")}`);
      return new Response('{"sessions":[]}', { status: 200 });
    }));
  try {
    const directory = await channel.ensure(launch.sessionId);
    for (const key of [`${launch.env[AGENT_CONTROL_RELAY_KEY_ENV]}x`, "z".repeat(43)]) {
      const response = await agentControlFifoRelayFetch(directory, key)("http://127.0.0.1:4317/api/sessions");
      assert.equal(response.status, 503);
      assert.deepEqual(JSON.parse(await response.text()), { error: "Agent Control relay authentication failed" });
    }
    assert.deepEqual(contacted, [], "no request reached the control plane");
    const accepted = await agentControlFifoRelayFetch(directory, launch.env[AGENT_CONTROL_RELAY_KEY_ENV]!)(
      "http://127.0.0.1:4317/api/sessions");
    assert.equal(accepted.status, 200);
    assert.equal(contacted.length, 1);
    assert.match(contacted[0]!, /^http:\/\/127\.0\.0\.1:4317\/api\/sessions Bearer wollipoga_/u,
      "the runner supplies the memory-held bearer; the FIFO frame never carried it");
  } finally {
    await channel.closeAll();
    removeAgentControlFiles(launch.sessionId, root);
  }
});

test("an exchange whose client never arrives is abandoned and its FIFOs removed", { skip: SKIP }, async () => {
  let calls = 0;
  const channel = relays(async () => { calls++; return { status: 200, body: "{}" }; }, { arrivalMs: 100 });
  try {
    const directory = await channel.ensure("s_fifo_arrival");
    const nonce = "a".repeat(32);
    ring(directory, `${JSON.stringify({ nonce })}\n`);
    await until(() => isFifo(join(directory, `${nonce}.req`)));
    assert.ok(isFifo(join(directory, `${nonce}.res`)), "the response FIFO exists before the request FIFO");
    await until(() => !existsSync(join(directory, `${nonce}.req`)) && !existsSync(join(directory, `${nonce}.res`)), 2_000);
    assert.deepEqual(entries(directory), ["doorbell"]);
    assert.equal(calls, 0);
    const response = await agentControlFifoRelayFetch(directory, KEY)("http://127.0.0.1:1/api/after");
    assert.equal(response.status, 200, "the channel keeps serving after an abandoned exchange");
  } finally {
    await channel.closeAll();
  }
});

test("a client that writes without first opening the response FIFO is refused", { skip: SKIP }, async () => {
  let calls = 0;
  const channel = relays(async () => { calls++; return { status: 200, body: "{}" }; });
  try {
    const directory = await channel.ensure("s_fifo_protocol");
    const nonce = "b".repeat(32);
    ring(directory, `${JSON.stringify({ nonce })}\n`);
    const requestPath = join(directory, `${nonce}.req`);
    await until(() => isFifo(requestPath));
    let fd: number | undefined;
    await until(() => {
      try { fd = openSync(requestPath, constants.O_WRONLY | constants.O_NONBLOCK); return true; } catch { return false; }
    });
    writeSync(fd!, `${JSON.stringify({ key: KEY, method: "GET", path: "/api/x" })}\n`);
    await until(() => !existsSync(requestPath) && !existsSync(join(directory, `${nonce}.res`)));
    closeSync(fd!);
    assert.equal(calls, 0);
  } finally {
    await channel.closeAll();
  }
});

test("pending exchanges are capped per session", { skip: SKIP }, async () => {
  const channel = relays(async () => ({ status: 200, body: "{}" }), { maxPendingExchanges: 2, arrivalMs: 300 });
  try {
    const directory = await channel.ensure("s_fifo_cap");
    const nonces = ["c", "d", "e"].map((letter) => letter.repeat(32));
    for (const nonce of nonces) ring(directory, `${JSON.stringify({ nonce })}\n`);
    await until(() => isFifo(join(directory, `${nonces[0]}.req`)) && isFifo(join(directory, `${nonces[1]}.req`)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(join(directory, `${nonces[2]}.req`)), false, "the third nonce gets no FIFOs");
    assert.equal(existsSync(join(directory, `${nonces[2]}.res`)), false);
    // The client of an ignored nonce gives up on its own wait with a named error.
    await assert.rejects(
      () => agentControlFifoRelayFetch(directory, KEY, { channelWaitMs: 100 })("http://127.0.0.1:1/api/busy"),
      /did not open an Agent Control relay channel within 0.1 seconds/);
    await until(() => entries(directory).length === 1, 2_000);
    const response = await agentControlFifoRelayFetch(directory, KEY)("http://127.0.0.1:1/api/after");
    assert.equal(response.status, 200, "freed slots serve again");
  } finally {
    await channel.closeAll();
  }
});

test("an oversize or malformed request frame ends the exchange without calling the handler", { skip: SKIP }, async () => {
  let calls = 0;
  const channel = relays(async () => { calls++; return { status: 200, body: "{}" }; }, { maxRequestFrameBytes: 1_024 });
  try {
    const directory = await channel.ensure("s_fifo_bounds");
    const fetch = agentControlFifoRelayFetch(directory, KEY);
    await assert.rejects(() => fetch("http://127.0.0.1:1/api/big", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blob: "x".repeat(2_000) }),
    }), /closed without a response/);
    await assert.rejects(() => fetch("http://127.0.0.1:1/api/x", { method: "PATCH" }),
      /permits only GET, POST, PUT, and DELETE/, "the client refuses what the relay would");
    // A hand-written frame that is not a relay request.
    const nonce = "f".repeat(32);
    ring(directory, `${JSON.stringify({ nonce })}\n`);
    const requestPath = join(directory, `${nonce}.req`);
    await until(() => isFifo(requestPath));
    const reader = openSync(join(directory, `${nonce}.res`), constants.O_RDONLY | constants.O_NONBLOCK);
    let writer: number | undefined;
    await until(() => {
      try { writer = openSync(requestPath, constants.O_WRONLY | constants.O_NONBLOCK); return true; } catch { return false; }
    });
    writeSync(writer!, `${JSON.stringify({ key: KEY, method: "GET", path: "/api/x", extra: { nested: true }, body: 7 })}\n`);
    await until(() => entries(directory).length === 1);
    closeSync(writer!);
    closeSync(reader);
    assert.equal(calls, 0);
    assert.equal((await fetch("http://127.0.0.1:1/api/ok")).status, 200);
    assert.equal(calls, 1);
  } finally {
    await channel.closeAll();
  }
});

test("the client going away cancels the relayed request, like a closed socket", { skip: SKIP }, async () => {
  let cancelled: (() => void) | undefined;
  const cancellation = new Promise<void>((resolve) => { cancelled = resolve; });
  let started: (() => void) | undefined;
  const handlerStarted = new Promise<void>((resolve) => { started = resolve; });
  const channel = relays(async (_sessionId, _request, signal) => {
    started!();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    cancelled!();
    return { status: 200, body: "{}" };
  });
  try {
    const directory = await channel.ensure("s_fifo_cancel");
    const abort = new AbortController();
    const pending = agentControlFifoRelayFetch(directory, KEY)("http://127.0.0.1:1/api/slow", { signal: abort.signal });
    await handlerStarted;
    abort.abort();
    await assert.rejects(() => pending, /aborted/);
    await cancellation;
    await until(() => entries(directory).length === 1);
  } finally {
    await channel.closeAll();
  }
});

test("an exchange that outlives its deadline is abandoned and its handler cancelled", { skip: SKIP }, async () => {
  let aborted = false;
  const channel = relays(async (_sessionId, _request, signal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    aborted = true;
    return { status: 200, body: "{}" };
  }, { exchangeMs: 200 });
  try {
    const directory = await channel.ensure("s_fifo_deadline");
    await assert.rejects(() => agentControlFifoRelayFetch(directory, KEY)("http://127.0.0.1:1/api/never"),
      /closed without a response/);
    assert.equal(aborted, true);
    await until(() => entries(directory).length === 1);
  } finally {
    await channel.closeAll();
  }
});

test("a response the client never reads is abandoned at the deadline instead of blocking the runner", { skip: SKIP }, async () => {
  // One slot, so whether the stalled exchange still holds it is visible to the next client.
  const channel = relays(async () => ({ status: 200, body: JSON.stringify({ blob: "y".repeat(1_000_000) }) }),
    { exchangeMs: 400, maxPendingExchanges: 1 });
  try {
    const directory = await channel.ensure("s_fifo_stalled");
    const nonce = "9".repeat(32);
    ring(directory, `${JSON.stringify({ nonce })}\n`);
    const requestPath = join(directory, `${nonce}.req`);
    await until(() => isFifo(requestPath));
    // Open the reader, as the protocol requires, but never read from it.
    const reader = openSync(join(directory, `${nonce}.res`), constants.O_RDONLY | constants.O_NONBLOCK);
    let writer: number | undefined;
    await until(() => {
      try { writer = openSync(requestPath, constants.O_WRONLY | constants.O_NONBLOCK); return true; } catch { return false; }
    });
    writeSync(writer!, `${JSON.stringify({ key: KEY, method: "GET", path: "/api/big" })}\n`);
    await until(() => entries(directory).length === 1, 2_000);
    await assert.rejects(
      () => agentControlFifoRelayFetch(directory, KEY, { channelWaitMs: 100 })("http://127.0.0.1:1/api/meanwhile"),
      /did not open an Agent Control relay channel/, "the stalled exchange still holds its slot");
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Abandoned at its deadline, its slot is free and the runner answers the next client.
    assert.equal((await agentControlFifoRelayFetch(directory, KEY)("http://127.0.0.1:1/api/next")).status, 200);
    closeSync(writer!);
    closeSync(reader);
  } finally {
    await channel.closeAll();
  }
});

test("a single request byte does not hold a slot past the request limit", { skip: SKIP }, async () => {
  let calls = 0;
  const channel = relays(async () => { calls++; return { status: 200, body: "{}" }; },
    { maxPendingExchanges: 1, requestMs: 150 });
  try {
    const directory = await channel.ensure("s_fifo_trickle");
    const nonce = "7".repeat(32);
    ring(directory, `${JSON.stringify({ nonce })}\n`);
    const requestPath = join(directory, `${nonce}.req`);
    await until(() => isFifo(requestPath));
    const reader = openSync(join(directory, `${nonce}.res`), constants.O_RDONLY | constants.O_NONBLOCK);
    let writer: number | undefined;
    await until(() => {
      try { writer = openSync(requestPath, constants.O_WRONLY | constants.O_NONBLOCK); return true; } catch { return false; }
    });
    writeSync(writer!, "{");
    // A FIFO without a writer reads as end-of-file, so first see the runner open its writer (an
    // empty pipe with a writer is EAGAIN), then see it close once the frame is overdue.
    const scratch = Buffer.alloc(16);
    await until(() => {
      try { readSync(reader, scratch); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "EAGAIN"; }
    });
    await until(() => {
      try { return readSync(reader, scratch) === 0; } catch { return false; }
    }, 2_000);
    assert.equal(calls, 0);
    assert.equal((await agentControlFifoRelayFetch(directory, KEY)("http://127.0.0.1:1/api/next")).status, 200,
      "the slot is free again");
    closeSync(writer!);
    closeSync(reader);
  } finally {
    await channel.closeAll();
  }
});

test("junk on the doorbell is ignored and valid requests keep being served", { skip: SKIP }, async () => {
  const channel = relays(async () => ({ status: 200, body: '{"ok":true}' }));
  try {
    const directory = await channel.ensure("s_fifo_junk");
    ring(directory, "x".repeat(3_000));
    ring(directory, "\nnot json\n{\"nonce\":\"short\"}\n{\"nonce\":\"../../escape\"}\nnull\n[]\n");
    ring(directory, `${JSON.stringify({ nonce: "G".repeat(32) })}\n`);
    const response = await agentControlFifoRelayFetch(directory, KEY)("http://127.0.0.1:1/api/after-junk");
    assert.deepEqual(JSON.parse(await response.text()), { ok: true });
    await until(() => entries(directory).length === 1);
  } finally {
    await channel.closeAll();
  }
});

test("closing a session removes its directory, ends its exchanges and refuses later calls", { skip: SKIP }, async () => {
  let aborted = false;
  let started: (() => void) | undefined;
  const handlerStarted = new Promise<void>((resolve) => { started = resolve; });
  const channel = relays(async (_sessionId, _request, signal) => {
    started!();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    aborted = true;
    return { status: 200, body: "{}" };
  });
  const directory = await channel.ensure("s_fifo_close");
  const fetch = agentControlFifoRelayFetch(directory, KEY);
  const pending = fetch("http://127.0.0.1:1/api/in-flight");
  await handlerStarted;
  await channel.close("s_fifo_close");
  await assert.rejects(() => pending, /closed without a response/);
  assert.equal(aborted, true);
  assert.equal(existsSync(directory), false);
  await assert.rejects(() => fetch("http://127.0.0.1:1/api/after"), /relay is not running for this session/);
  const again = await channel.ensure("s_fifo_close");
  assert.notEqual(again, directory, "a relaunch gets a fresh, newly random channel");
  assert.match(again, /\/s_fifo_close\.[0-9a-f]{32}$/u);
  await channel.closeAll();
  assert.equal(existsSync(again), false);
});

test("a doorbell nobody reads names the stopped relay instead of hanging", { skip: SKIP }, async () => {
  const directory = join(base(), "s_fifo_stopped");
  mkdirSync(directory, { recursive: true });
  execFileSync("mkfifo", ["-m", "600", join(directory, "doorbell")]);
  await assert.rejects(() => agentControlFifoRelayFetch(directory, KEY)("http://127.0.0.1:1/api/x"),
    /relay is not running for this session/);
  assert.throws(() => agentControlFifoRelayFetch("relative/dir", KEY), /invalid Agent Control FIFO relay directory/);
});

test("startup sweep removes every channel an earlier runner left, unlistable or not", { skip: SKIP }, async () => {
  const relayBase = base();
  for (const name of ["s_old_one", "s_old_two"]) {
    const directory = join(relayBase, name);
    mkdirSync(directory, { recursive: true });
    execFileSync("mkfifo", ["-m", "600", join(directory, "doorbell"), join(directory, `${"1".repeat(32)}.req`)]);
    chmodSync(directory, 0o300);
  }
  const outside = join(relayBase, "..", "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "kept"), "kept");
  symlinkSync(outside, join(relayBase, "s_link"));
  assert.equal(sweepAgentControlFifoRelays(relayBase), 3);
  assert.equal(statSync(relayBase).mode & 0o777, 0o300, "the swept base stays unlistable");
  assert.equal(sweepAgentControlFifoRelays(relayBase), 0, "nothing is left");
  assert.equal(existsSync(join(outside, "kept")), true, "a link is removed, never followed");
  assert.equal(sweepAgentControlFifoRelays(join(relayBase, "missing")), 0);
  // A base a running runner made unlistable is swept just the same.
  const channel = new AgentControlFifoRelays(relayBase, async () => ({ status: 200, body: "{}" }));
  const live = await channel.ensure("s_live");
  assert.equal(sweepAgentControlFifoRelays(relayBase), 1);
  assert.equal(existsSync(live), false);
  await channel.closeAll();
});

test("ensure refuses unsafe session ids and a linked base", { skip: SKIP }, async () => {
  const handler: AgentControlRelayHandler = async () => ({ status: 200, body: "{}" });
  const channel = relays(handler);
  await assert.rejects(() => channel.ensure("../escape"), /unsafe session id/);
  const relayBase = base();
  const target = mkdtempSync(join(tmpdir(), "wollipog-fifo-target-"));
  roots.push(target);
  mkdirSync(join(relayBase, ".."), { recursive: true });
  symlinkSync(target, relayBase);
  await assert.rejects(() => new AgentControlFifoRelays(relayBase, handler).ensure("s_linked"), /not a directory/);
  assert.deepEqual(readdirSync(target), []);
});

test("the injected CLI takes the FIFO channel when the runner injected one", { skip: SKIP }, async () => {
  const channel = relays(async (_sessionId, request) => request.path === "/api/compatibility"
    ? { status: 200, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION }) }
    : { status: 200, body: JSON.stringify({ sessions: [] }) });
  try {
    const directory = await channel.ensure("s_fifo_cli");
    let stdout = "";
    let stderr = "";
    const code = await runWollipogCli(["node", "cli.js", "--wollipog-cli", "session", "list", "--json"], {
      WOLLIPOG_CONTROL_PLANE_URL: "http://127.0.0.1:4317",
      WOLLIPOG_SESSION_ID: "s_fifo_cli",
      // Nothing listens here: the call can only succeed through the FIFO channel.
      [AGENT_CONTROL_RELAY_ENDPOINT_ENV]: "tcp://127.0.0.1:9",
      [AGENT_CONTROL_RELAY_KEY_ENV]: KEY,
      [AGENT_CONTROL_RELAY_FIFO_ENV]: directory,
    }, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } });
    assert.equal(stderr, "");
    assert.equal(code, 0, stdout);
    assert.deepEqual(JSON.parse(stdout), { sessions: [] });
  } finally {
    await channel.closeAll();
  }
});

test("a sandbox's EPERM names the cause and the MCP alternative instead of a bare errno (#3270)", async () => {
  const refusal = (message: string) => Object.assign(new Error(message), { code: "EPERM" });
  for (const thrown of [
    // The loopback relay's own socket error, and fetch's wrapped one for a direct token.
    refusal("connect EPERM 127.0.0.1:39197 - Local (undefined:undefined)"),
    Object.assign(new TypeError("fetch failed"), { cause: refusal("connect EPERM 127.0.0.1:4317") }),
  ]) {
    let stdout = "";
    const code = await runWollipogCli(["node", "cli.js", "--wollipog-cli", "session", "list", "--json"], {
      WOLLIPOG_CONTROL_PLANE_URL: "http://127.0.0.1:4317",
      WOLLIPOG_SESSION_ID: "s_eperm",
      WOLLIPOG_TOKEN: "wollipoga_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    }, { stdout: (text) => { stdout += text; }, stderr: () => {} }, async () => { throw thrown; });
    assert.equal(code, 1);
    const { error } = JSON.parse(stdout) as { error: string };
    assert.match(error, /^control plane compatibility check failed: (connect EPERM|fetch failed)/);
    assert.match(error, /sandbox blocks network and loopback connections/);
    assert.match(error, /use the wollipog MCP tools instead/);
  }
  // Any other failure keeps its own message alone.
  let stdout = "";
  await runWollipogCli(["node", "cli.js", "--wollipog-cli", "session", "list", "--json"], {
    WOLLIPOG_CONTROL_PLANE_URL: "http://127.0.0.1:4317", WOLLIPOG_SESSION_ID: "s_refused",
    WOLLIPOG_TOKEN: "wollipoga_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  }, { stdout: (text) => { stdout += text; }, stderr: () => {} }, async () => {
    throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4317"), { code: "ECONNREFUSED" });
  });
  assert.deepEqual(JSON.parse(stdout), { error: "control plane compatibility check failed: connect ECONNREFUSED 127.0.0.1:4317" });
});
