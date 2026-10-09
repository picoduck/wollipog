import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SessionStore, type SessionMeta } from "../src/session-store.js";

// Per-event append cost must not grow with the number of compacted history segments, and
// compaction must not hold the event loop for long at any one time (#2774).
const SAMPLE_APPENDS = 2_000;
const SEGMENTS = 16;
const MAX_SEGMENTED_TO_FRESH_P50 = 1.5;
const MAX_COMPACTION_BLOCK_MS = 20;
const SESSION_ID = "s_benchmark";
const OWNER = "benchmark";

const root = mkdtempSync(join(tmpdir(), "wollipog-session-store-benchmark-"));
try {
  const store = new SessionStore(root);
  store.create({
    sessionId: SESSION_ID, agentId: "a", workspaceId: "w", repoPath: root, worktreePath: root,
    driver: "claude-code", command: "x", args: [], env: {}, context: { kind: "native" },
    agentSessionId: "t", status: "idle", title: "benchmark", config: {}, tokensIn: 0, tokensOut: 0,
    costUsd: 0, preview: null, pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1,
  } as SessionMeta);
  if (!store.acquireLock(SESSION_ID, OWNER)) throw new Error("benchmark could not take the writer lock");

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

  const ratio = appends[`after${SEGMENTS}Segments`]!.p50 / appends.fresh!.p50;
  const longestBlockMs = Math.max(...compactions.map((compaction) => compaction.longestBlockMs));
  console.log(JSON.stringify({
    appends,
    compactions,
    segmentedToFreshP50: Number(ratio.toFixed(2)),
    longestCompactionBlockMs: longestBlockMs,
  }, null, 2));
  if (ratio > MAX_SEGMENTED_TO_FRESH_P50) {
    throw new Error(`append p50 after ${SEGMENTS} segments is ${ratio.toFixed(2)}x a fresh log`);
  }
  if (longestBlockMs > MAX_COMPACTION_BLOCK_MS) {
    throw new Error(`a compaction held the event loop for ${longestBlockMs} ms`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
