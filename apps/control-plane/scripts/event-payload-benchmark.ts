// Measures how long externalizing a large session-event payload blocks the control plane's event
// loop (#2794), and how long another session's small events wait behind a stream of large ones.
// Run it on the disk that holds the real database (`--dir <path>`): a tmpfs temporary directory
// makes every flush free and hides the regression this guards against.
//
// SQLite's automatic WAL checkpoint (every 1,000 WAL pages) flushes the database on the event
// loop during whichever commit crosses the threshold, for any event, large or small. The ingest
// measurement suspends them, and collects garbage between payloads, so it isolates what
// externalization adds; the stream measurement keeps both and reports them.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION, type SessionEvent, type SessionEventPayload } from "@wollipog/protocol";
import { ControlPlaneDb } from "../src/db.js";
import { externalizeSessionEventPayload, stageSessionEventPayload } from "../src/event-payloads.js";
import type { Hub } from "../src/hub.js";
import { RunnerFrameQueue } from "../src/runner-frame-queue.js";
import { SessionsService } from "../src/sessions.js";

const SIZES = [16 * 1024 + 1, 64 * 1024, 256 * 1024, 1024 * 1024];
const ITERATIONS = 40;
const STREAM_LARGE_EVENTS = 40;
const STREAM_LARGE_INTERVAL_MS = 25;
const STREAM_SMALL_INTERVAL_MS = 2;
// On a local NVMe SSD, a 16 KiB to 1 MiB payload blocked the event loop for about 20 ms per chunk
// when it was written synchronously, and at most about 1 ms once staged.
const MAX_STALL_P95_MS = 2;

const { values } = parseArgs({ options: { dir: { type: "string" } } });
const root = mkdtempSync(join(values.dir ?? tmpdir(), "wollipog-event-payload-benchmark-"));

const percentile = (samples: number[], fraction: number) => {
  const sorted = [...samples].sort((left, right) => left - right);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!.toFixed(3));
};
const summary = (samples: number[]) =>
  ({ p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95), maxMs: percentile(samples, 1) });

/** The longest the event loop went without running a check: the worst blocking slice. */
function stallProbe(): { stop: () => number } {
  let last = performance.now();
  let worst = 0;
  let running = true;
  const tick = () => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  return { stop: () => { running = false; return Math.max(worst, performance.now() - last); } };
}

function seed(db: ControlPlaneDb, sessionIds: string[]): void {
  db.registerRunner({
    runnerId: "runner-benchmark",
    hostname: "benchmark",
    os: "linux",
    version: "benchmark",
    workspaces: [{ id: "workspace-1", name: "Workspace", path: root }],
    agents: [{
      id: "agent-1", name: "Agent", command: "agent", args: [], env: {},
      driver: "claude-code", available: true, context: { kind: "native" },
    }],
  }, Date.now(), PROTOCOL_VERSION);
  for (const id of sessionIds) {
    db.createSession({
      id, runnerId: "runner-benchmark", workspaceId: "workspace-1", agentId: "agent-1",
      title: id, useWorktree: false, driver: "claude-code", config: {}, now: Date.now(),
    });
  }
}

const uniqueText = (bytes: number) => randomBytes(Math.ceil(bytes / 2)).toString("hex").slice(0, bytes);

/** Event-loop blocking of one payload: written synchronously (the pre-#2794 path) or staged. */
async function measureIngest(db: ControlPlaneDb, mode: "synchronous" | "staged") {
  const sessionId = `ingest-${mode}`;
  let seq = 0;
  const ingestOnce = async (payload: SessionEventPayload) => {
    const options = { runnerSeq: ++seq, historyEpoch: null, searchPayload: payload };
    if (mode === "synchronous") {
      const externalized = externalizeSessionEventPayload(db, sessionId, payload, Date.now());
      db.appendEvent(sessionId, externalized.payload, Date.now(), { ...options, artifactIds: externalized.artifactIds });
      return;
    }
    const staged = await stageSessionEventPayload(db, sessionId, payload, Date.now());
    try {
      const externalized = staged.commit();
      db.appendEvent(sessionId, externalized.payload, Date.now(), { ...options, artifactIds: externalized.artifactIds });
    } finally {
      staged.release();
    }
  };
  db.raw().exec("PRAGMA wal_autocheckpoint = 0;");
  const results = [];
  for (const size of SIZES) {
    // No checkpoint inside the measured window, and a WAL no longer than one size's run. The
    // first write to a reset WAL also flushes its header, so an unmeasured payload goes first.
    db.raw().exec("PRAGMA wal_checkpoint(TRUNCATE);");
    await ingestOnce({ kind: "command_output", text: uniqueText(size) });
    const stalls: number[] = [];
    const totals: number[] = [];
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      const payload: SessionEventPayload = { kind: "command_output", text: uniqueText(size) };
      // Collect earlier iterations' garbage outside the window (needs --expose-gc, as the package
      // script passes); the stream measurement below keeps collection pauses in.
      (globalThis as { gc?: () => void }).gc?.();
      const probe = stallProbe();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const startedAt = performance.now();
      await ingestOnce(payload);
      totals.push(performance.now() - startedAt);
      await new Promise<void>((resolve) => setImmediate(resolve));
      stalls.push(probe.stop());
    }
    results.push({ sizeBytes: size, eventLoopStall: summary(stalls), ingest: summary(totals) });
  }
  db.raw().exec("PRAGMA wal_autocheckpoint = 1000;");
  return results;
}

/** One session streams large outputs while another streams small messages, through the runner
 * frame queue and SessionsService wired as the runner socket wires them: both sessions on one
 * runner (one frame queue, so the small session waits in arrival order), or on two runners. */
async function measureStream(
  db: ControlPlaneDb,
  variant: "sameRunner" | "otherRunner" | "sameRunnerWithoutCheckpoints",
) {
  const automaticCheckpoints = variant !== "sameRunnerWithoutCheckpoints";
  db.raw().exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.raw().exec(`PRAGMA wal_autocheckpoint = ${automaticCheckpoints ? 1_000 : 0};`);
  const delivered = new Map<string, number>();
  const hub = new Proxy({}, {
    get: (_target, property) => property === "sessionEvent"
      ? (event: SessionEvent) => {
          if (event.payload.kind === "agent_message" || event.payload.kind === "command_output") {
            delivered.set(event.payload.kind === "agent_message" ? event.payload.text : event.payload.kind + event.seq,
              performance.now());
          }
        }
      : () => undefined,
  }) as unknown as Hub;
  const noop = () => undefined;
  const svc = new SessionsService(db, hub, { info: noop, warn: noop, error: noop, debug: noop } as never);
  type Frame = { type: "session_event"; sessionId: string; payload: SessionEventPayload; seq: number };
  type Staging = NonNullable<ReturnType<SessionsService["stageLiveSessionEventPayload"]>>;
  const runnerQueue = () => new RunnerFrameQueue<Frame, Staging>(async (frame, staging) => {
    try {
      const prepared = staging ? await svc.awaitStagedLiveSessionEvent(frame.sessionId, staging) : undefined;
      svc.onSessionEvent(frame.sessionId, frame.payload, frame.seq, undefined, "runner-benchmark", prepared);
    } finally {
      if (staging) svc.discardStagedLiveSessionEvent(staging);
    }
  }, () => { throw new Error("the runner frame queue failed"); }, undefined, undefined, undefined, {
    runnerWide: () => false,
    prepare: (frame) => svc.stageLiveSessionEventPayload(frame.sessionId, frame.payload, undefined, "runner-benchmark"),
    discard: (staging) => svc.discardStagedLiveSessionEvent(staging),
  });
  const largeFrames = runnerQueue();
  const smallFrames = variant === "otherRunner" ? runnerQueue() : largeFrames;
  const send = (frames: RunnerFrameQueue<Frame, Staging>, sessionId: string, payload: SessionEventPayload, seq: number) =>
    frames.enqueue({ type: "session_event", sessionId, payload, seq }, Buffer.byteLength(JSON.stringify(payload)));
  const smallSends = new Map<string, number>();
  const largeSends: number[] = [];
  const smallSession = `stream-small-${variant}`;
  const largeSession = `stream-large-${variant}`;
  let smallSeq = 0;
  let largeSeq = 0;
  const probe = stallProbe();
  const startedAt = performance.now();
  const endAt = startedAt + STREAM_LARGE_EVENTS * STREAM_LARGE_INTERVAL_MS;
  await new Promise<void>((resolve) => {
    const tick = () => {
      const now = performance.now();
      // Catch up on every send that fell due while the loop was blocked; its wait counts.
      while (startedAt + smallSeq * STREAM_SMALL_INTERVAL_MS <= now && startedAt + smallSeq * STREAM_SMALL_INTERVAL_MS < endAt) {
        const due = startedAt + smallSeq * STREAM_SMALL_INTERVAL_MS;
        const text = `small-${++smallSeq}`;
        smallSends.set(text, due);
        send(smallFrames, smallSession, { kind: "agent_message", messageId: text, text }, smallSeq);
      }
      while (startedAt + largeSeq * STREAM_LARGE_INTERVAL_MS <= now && largeSeq < STREAM_LARGE_EVENTS) {
        largeSends.push(startedAt + largeSeq * STREAM_LARGE_INTERVAL_MS);
        send(largeFrames, largeSession, { kind: "command_output", text: uniqueText(1024 * 1024) }, ++largeSeq);
      }
      if (now >= endAt && largeSeq >= STREAM_LARGE_EVENTS) resolve();
      else setTimeout(tick, 0);
    };
    tick();
  });
  while (delivered.size < smallSends.size + largeSends.length) await new Promise((resolve) => setTimeout(resolve, 5));
  largeFrames.close();
  smallFrames.close();
  const stall = probe.stop();
  const smallLatency = [...smallSends].map(([text, due]) => delivered.get(text)! - due);
  const largeLatency = largeSends.map((due, index) => delivered.get(`command_output${index + 1}`)! - due);
  assert.ok(smallLatency.every(Number.isFinite) && largeLatency.every(Number.isFinite), "every event was delivered");
  db.raw().exec("PRAGMA wal_autocheckpoint = 1000;");
  return {
    variant,
    automaticCheckpoints,
    largeEvents: STREAM_LARGE_EVENTS,
    largeEventBytes: 1024 * 1024,
    smallEvents: smallSends.size,
    otherSessionDelivery: summary(smallLatency),
    largeEventDelivery: summary(largeLatency),
    worstEventLoopStallMs: Number(stall.toFixed(3)),
  };
}

try {
  const db = ControlPlaneDb.open(join(root, "control-plane.db"));
  const variants = ["sameRunner", "otherRunner", "sameRunnerWithoutCheckpoints"] as const;
  seed(db, [
    "ingest-synchronous", "ingest-staged",
    ...variants.flatMap((variant) => [`stream-small-${variant}`, `stream-large-${variant}`]),
  ]);
  const synchronous = await measureIngest(db, "synchronous");
  const staged = await measureIngest(db, "staged");
  const stream = [];
  for (const variant of variants) stream.push(await measureStream(db, variant));
  db.close();
  console.log(JSON.stringify({
    directory: values.dir ?? tmpdir(), synchronous, staged, stream, maxStallP95Ms: MAX_STALL_P95_MS,
  }, null, 2));
  for (const result of staged) {
    assert.ok(result.eventLoopStall.p95Ms < MAX_STALL_P95_MS,
      `a ${result.sizeBytes}-byte payload blocked the event loop for ${result.eventLoopStall.p95Ms}ms at p95 ` +
      `(limit ${MAX_STALL_P95_MS}ms); is a blob written or flushed on the event loop again?`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
