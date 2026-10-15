import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import fc from "fast-check";
import { JsonRpcPeer } from "../jsonrpc.js";
import type { AgentProcess } from "../spawn.js";
import { CodexAppServerDriver } from "./codex-app-server.js";

/** Exercise the real stderr callbacks without spawning a provider or reading an account HOME. */
async function harness() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin, stdout, stderr,
  }) as unknown as AgentProcess;
  const server = new JsonRpcPeer(stdout, stdin);
  server.onRequest("initialize", () => ({ userAgent: "synthetic-fixture" }));
  const diagnostics: string[] = [];
  const events: unknown[] = [];
  let recoveries = 0;
  const driver = new CodexAppServerDriver({
    command: "synthetic-unused-provider", args: [], cwd: "/synthetic-unused-project",
    env: {}, context: { kind: "native" }, config: {},
  }, {
    onEvent: event => events.push(event), onStderr: line => diagnostics.push(line), onExit: () => {},
    onAuthenticationFailure: () => { recoveries++; },
  }, undefined, { spawn: () => child, kill: () => {} });
  await driver.initialize();
  return {
    write: (text: string) => { stderr.write(text); },
    close: () => { child.emit("close", 1); },
    diagnostics, events, recoveries: () => recoveries,
    dispose: () => { driver.dispose(); server.dispose("fixture finished"); },
  };
}

test("suppressed authentication stderr discards its continuation through the next newline", async () => {
  const h = await harness();
  try {
    h.write("401 Unauthorized: bearer token SYNTHETIC_PREFIX");
    h.write("SYNTHETIC_TAIL\nbenign diagnostic\n");
    assert.deepEqual(h.diagnostics, ["benign diagnostic"]);
    assert.deepEqual(h.events, []);
    assert.equal(h.recoveries(), 1);
  } finally { h.dispose(); }
});

test("suppressed authentication stderr never flushes an unterminated continuation on exit", async () => {
  const h = await harness();
  try {
    h.write("authentication_failed SYNTHETIC_PREFIX");
    h.write("SYNTHETIC_TAIL");
    h.close();
    assert.deepEqual(h.diagnostics, []);
    assert.deepEqual(h.events, []);
    assert.equal(h.recoveries(), 1);
  } finally { h.dispose(); }
});

test("authentication-matching continuation is discarded without a second recovery", async () => {
  const h = await harness();
  try {
    h.write("provider rejected request: 401 Unauthorized\n  bearer token SYNTHETIC_PREFIX");
    h.write(" authentication_failed SYNTHETIC_TAIL");
    h.write("\nbenign diagnostic\n");
    h.close();
    assert.deepEqual(h.diagnostics, ["benign diagnostic"]);
    assert.deepEqual(h.events, []);
    assert.equal(h.recoveries(), 1);
  } finally { h.dispose(); }
});

test("complete authentication chunks and ordinary oversized diagnostics retain their behavior", async () => {
  const h = await harness();
  try {
    h.write("authentication_failed SYNTHETIC_MARKER\n");
    h.write("benign diagnostic\n");
    h.write("x".repeat(64 * 1024));
    h.write("overflow\nordinary final diagnostic\n");
    assert.deepEqual(h.diagnostics, ["benign diagnostic",
      JSON.stringify({ event: "codex_diagnostic_discarded", reason: "oversized_line" }),
      "ordinary final diagnostic"]);
    assert.equal(h.recoveries(), 1);
  } finally { h.dispose(); }
});

test("authentication stderr redaction survives every single split and bytewise writes", async () => {
  for (const prefix of [
    "401 Unauthorized: bearer token ", "authentication_failed ", "authentication_error ",
    "OAuth token expired ", "invalid API key supplied ", "credentials were revoked ",
    "You are not logged in. Run codex login. ",
  ]) {
    const message = prefix + "SYNTHETIC_MARKER\r\n";
    const partitions = Array.from({ length: message.length + 1 }, (_, split) => [message.slice(0, split), message.slice(split)]);
    partitions.push([...message]);
    for (const chunks of partitions) {
      const h = await harness();
      try {
        for (const chunk of chunks) h.write(chunk);
        h.write("benign diagnostic\n");
        h.close();
        assert.deepEqual(h.diagnostics, ["benign diagnostic"], `prefix=${JSON.stringify(prefix)}, chunks=${JSON.stringify(chunks)}`);
        assert.deepEqual(h.events, []);
        assert.equal(h.recoveries(), 1);
      } finally { h.dispose(); }
    }
  }
});

test("authentication stderr redaction preserves no marker fragment across generated chunk boundaries", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 0, max: "SYNTHETIC_MARKER".length - 1 }),
    fc.array(fc.boolean(), { minLength: 1, maxLength: 160 }),
    async (split, boundaries) => {
      const marker = "SYNTHETIC_MARKER";
      const message = marker.slice(split) + "\r\n";
      const h = await harness();
      try {
        h.write("401 Unauthorized: bearer token " + marker.slice(0, split));
        let start = 0;
        for (let i = 0; i < message.length; i++) {
          if (boundaries[i % boundaries.length]) {
            h.write(message.slice(start, i + 1));
            start = i + 1;
          }
        }
        h.write(message.slice(start));
        h.write("benign diagnostic\n");
        h.close();
        // Exact output excludes even one-character marker fragments, not just the full token.
        assert.deepEqual(h.diagnostics, ["benign diagnostic"]);
        assert.deepEqual(h.events, []);
        assert.equal(h.recoveries(), 1);
      } finally { h.dispose(); }
    },
  ), { seed: 2466, numRuns: 200 });
});

test("authentication continuation discard remains bounded and resumes in the newline's chunk", async () => {
  const h = await harness();
  try {
    h.write("pending partial diagnostic ");
    h.write("invalid API key SYNTHETIC_PREFIX");
    for (let i = 0; i < 128; i++) h.write("SYNTHETIC_TAIL".repeat(8192));
    h.write("\r");
    h.write("\nbenign diagnostic\n");
    h.write("ordinary complete line\n");
    h.write("benign final tail");
    h.close();
    assert.deepEqual(h.diagnostics, ["benign diagnostic", "ordinary complete line", "benign final tail"]);
    assert.deepEqual(h.events, []);
    assert.equal(h.recoveries(), 1);
  } finally { h.dispose(); }
});
