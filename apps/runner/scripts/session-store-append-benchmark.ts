import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { SessionStore, type SessionMeta } from "../src/session-store.js";

// Per-event append cost must not grow with the number of compacted history segments, and
// compaction must not hold the event loop for long at any one time (#2774).
const SAMPLE_APPENDS = 2_000;
const SEGMENTS = 16;
const MAX_SEGMENTED_TO_FRESH_P50 = 1.5;
const MAX_COMPACTION_BLOCK_MS = 20;
// The debounced metadata flush of several streaming sessions must not hold the event loop (#2833).
const STREAMING_SESSIONS = 8;
const STREAM_MS = 4_000;
const STREAM_INTERVAL_MS = 33; // about 30 events per second per session
const MAX_STREAMING_BLOCK_MS = 5;
const SESSION_ID = "s_benchmark";
const OWNER = "benchmark";

const root = mkdtempSync(join(tmpdir(), "wollipog-session-store-benchmark-"));
const createSession = (store: SessionStore, sessionId: string) => {
  store.create({
    sessionId, agentId: "a", workspaceId: "w", repoPath: root, worktreePath: root,
    driver: "claude-code", command: "x", args: [], env: {}, context: { kind: "native" },
    agentSessionId: "t", status: "idle", title: "benchmark", config: {}, tokensIn: 0, tokensOut: 0,
    costUsd: 0, preview: null, pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1,
  } as SessionMeta);
  if (!store.acquireLock(sessionId, OWNER)) throw new Error("benchmark could not take the writer lock");
};

/** Several sessions stream at once while a 1 ms timer measures how late it runs: the longest gap is
 * the longest main-thread block, which includes every debounced metadata flush that fires. */
const streamConcurrently = async () => {
  const store = new SessionStore(join(root, "streaming"));
  const ids = Array.from({ length: STREAMING_SESSIONS }, (_, i) => `s_stream${i}`);
  for (const id of ids) createSession(store, id);
  const delay = monitorEventLoopDelay({ resolution: 1 });
  let last = performance.now();
  let longestBlockMs = 0;
  const probe = setInterval(() => {
    const now = performance.now();
    longestBlockMs = Math.max(longestBlockMs, now - last - 1);
    last = now;
  }, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  last = performance.now();
  longestBlockMs = 0;
  delay.enable();
  let streamed = 0;
  const stream = setInterval(() => {
    for (const id of ids) {
      store.appendEvent(id, { kind: "agent_message", messageId: "m", text: `streamed token chunk ${streamed++}` });
    }
  }, STREAM_INTERVAL_MS);
  await new Promise((resolve) => setTimeout(resolve, STREAM_MS));
  clearInterval(stream);
  // Let the last debounced flushes run inside the measured window.
  await new Promise((resolve) => setTimeout(resolve, 400));
  delay.disable();
  clearInterval(probe);
  for (const id of ids) store.releaseLock(id, OWNER);
  store.flushAll();
  return {
    sessions: STREAMING_SESSIONS,
    events: streamed,
    longestBlockMs: Number(longestBlockMs.toFixed(2)),
    eventLoopDelayP99Ms: Number((delay.percentile(99) / 1e6).toFixed(2)),
    eventLoopDelayMaxMs: Number((delay.max / 1e6).toFixed(2)),
  };
};

try {
  const store = new SessionStore(root);
  createSession(store, SESSION_ID);

  let streamed = 0;
  const percentile = (sorted: number[], p: number) => Number(sorted[Math.floor(sorted.length * p)]!.toFixed(4));
  const sampleAppends = () => {
    const latencies: number[] = [];
    for (let i = 0; i < SAMPLE_APPENDS; i++) {
      const started = performance.now();
      store.appendEvent(SESSION_ID, { kind: "agent_message", messageId: "m", text: `streamed token chunk ${streamed++}` });
      latencies.push(performance.now() - started);
    }
    latencies.sort((a, b) => a - b);
    return { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99) };
  };
  const toolOutput = (prefix: string, count: number) => {
    for (let i = 0; i < count; i++) {
      store.appendEvent(SESSION_ID, {
        kind: "tool_call_update",
        toolCallId: `${prefix}${i}`,
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "output line\n".repeat(20) } }],
      });
    }
  };

  const appends: Record<string, ReturnType<typeof sampleAppends>> = { fresh: sampleAppends() };
  toolOutput("t", 48_000);
  appends.after50kEvents = sampleAppends();
  const compactions: Array<{ wallMs: number; longestBlockMs: number }> = [];
  for (let segment = 1; segment <= SEGMENTS; segment++) {
    toolOutput(`u${segment}_`, 3_000);
    // Land the debounced metadata flush first: it fsyncs on the append path, not in compaction.
    store.flush(SESSION_ID);
    // A 1 ms timer measures its own lateness: the longest gap is the longest main-thread block.
    let last = performance.now();
    let longestBlockMs = 0;
    const probe = setInterval(() => {
      const now = performance.now();
      longestBlockMs = Math.max(longestBlockMs, now - last - 1);
      last = now;
    }, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    last = performance.now();
    longestBlockMs = 0;
    const started = performance.now();
    const result = await store.compactHistory(SESSION_ID, OWNER, true);
    const wallMs = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 2));
    clearInterval(probe);
    if (!result.compacted) throw new Error("forced compaction did not compact");
    compactions.push({ wallMs: Number(wallMs.toFixed(1)), longestBlockMs: Number(longestBlockMs.toFixed(1)) });
    if (segment === 8 || segment === SEGMENTS) appends[`after${segment}Segments`] = sampleAppends();
  }
  store.releaseLock(SESSION_ID, OWNER);
  store.flushAll();

  const streaming = await streamConcurrently();
  const ratio = appends[`after${SEGMENTS}Segments`]!.p50 / appends.fresh!.p50;
  const longestBlockMs = Math.max(...compactions.map((compaction) => compaction.longestBlockMs));
  console.log(JSON.stringify({
    appends,
    compactions,
    segmentedToFreshP50: Number(ratio.toFixed(2)),
    longestCompactionBlockMs: longestBlockMs,
    streaming,
  }, null, 2));
  if (ratio > MAX_SEGMENTED_TO_FRESH_P50) {
    throw new Error(`append p50 after ${SEGMENTS} segments is ${ratio.toFixed(2)}x a fresh log`);
  }
  if (longestBlockMs > MAX_COMPACTION_BLOCK_MS) {
    throw new Error(`a compaction held the event loop for ${longestBlockMs} ms`);
  }
  if (streaming.longestBlockMs > MAX_STREAMING_BLOCK_MS) {
    throw new Error(`${STREAMING_SESSIONS} streaming sessions held the event loop for ${streaming.longestBlockMs} ms`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
