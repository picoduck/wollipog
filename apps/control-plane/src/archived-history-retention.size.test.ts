import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunnerMetadata, SessionEventPayload } from "@wollipog/protocol";
import { ArchivedHistoryRetention } from "./archived-history-retention.js";
import { ControlPlaneDb } from "./db.js";
import { externalizeSessionEventPayload } from "./event-payloads.js";
import { PERSONAL_ORGANIZATION_ID } from "./identity.js";

/**
 * #2777 acceptance: the database stays the same size over repeated create, archive and prune
 * cycles. Pages freed by a prune are reused by the next session, so after a warm-up the file grows
 * only by what each prune keeps. A control run without pruning grows by a whole transcript a cycle.
 */

const DAY = 24 * 60 * 60_000;
const T0 = Date.UTC(2026, 0, 1);
const RUNNER_ID = "size-runner";
const TURNS = 34; // 59 events a turn: about 2,000 per session.

function runnerMeta(): RunnerMetadata {
  return {
    runnerId: RUNNER_ID, hostname: "host", os: "linux", version: "1.0.0",
    workspaces: [{ id: "ws", name: "Repo", path: "/tmp/size" }],
    agents: [{ id: "agent", name: "Agent", command: "claude", args: [], env: {}, driver: "claude-code",
      available: true, context: { kind: "native" } }],
  };
}

function words(seed: number, count: number): string {
  let out = "";
  for (let index = 0; index < count; index += 1) out += `w${((seed * 7_919 + index * 104_729) % 50_000).toString(36)} `;
  return out;
}

/** One session shaped like the measured mix: streamed messages and thoughts, tool calls with output,
 * file edits with diffs, usage, and one large output stored as payload artifacts. */
function appendSession(db: ControlPlaneDb, sessionId: string, cycle: number, start: number): void {
  let ts = start;
  let runnerSeq = 0;
  const append = (payload: SessionEventPayload, extra: { searchPayload?: SessionEventPayload; artifactIds?: string[] } = {}) => {
    ts += 1;
    runnerSeq += 1;
    db.appendEvent(sessionId, payload, ts, { runnerSeq, historyEpoch: 1, ...extra });
  };
  for (let turn = 0; turn < TURNS; turn += 1) {
    const seed = cycle * 1_000 + turn;
    append({ kind: "user_message", text: `Task ${seed}: ${words(seed, 30)}` });
    for (let chunk = 0; chunk < 20; chunk += 1) {
      append({ kind: "agent_message", text: words(seed + chunk, 3), messageId: `${sessionId}-p-${turn}` });
    }
    append({ kind: "agent_thought", text: words(seed + 7, 60) });
    for (let call = 0; call < 6; call += 1) {
      const toolCallId = `${sessionId}-t-${turn}-${call}`;
      append({ kind: "tool_call", toolCallId, title: "Bash", status: "pending", text: `pnpm test ${seed}-${call}` });
      append({ kind: "tool_call", toolCallId, title: "Bash", status: "completed", text: `pnpm test ${seed}-${call}` });
      append({ kind: "tool_call_update", toolCallId, status: "completed", text: words(seed + call, 20) } as SessionEventPayload);
      append({ kind: "command_output", text: words(seed + call * 3, 90) });
    }
    append({ kind: "file_edit", path: `src/module-${seed}.ts`, diff: `+ ${words(seed, 200)}\n` });
    append({ kind: "token_usage", inputTokens: 1_000 + turn, outputTokens: 100 + turn, cachedInputTokens: 500 });
    for (let chunk = 0; chunk < 10; chunk += 1) {
      append({ kind: "agent_message", text: words(seed + chunk * 5, 4), messageId: `${sessionId}-a-${turn}` });
    }
    append({ kind: "agent_response_completed" });
  }
  const original: SessionEventPayload = { kind: "command_output", text: words(cycle, 6_000) };
  const externalized = externalizeSessionEventPayload(db, sessionId, original, ts);
  append(externalized.payload, { searchPayload: original, artifactIds: [...externalized.artifactIds] });
  db.updateSessionStatus(sessionId, "completed", ts + 1);
}

function pages(db: ControlPlaneDb): number {
  db.raw().exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return (db.raw().prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
}

async function cycles(count: number, prune: boolean): Promise<{ pageCounts: number[]; db: ControlPlaneDb; root: string; blobs: string }> {
  const root = mkdtempSync(join(tmpdir(), "retention-size-"));
  const blobs = join(root, "blobs");
  const db = ControlPlaneDb.open(join(root, "db.sqlite"), { artifactBlobDir: blobs });
  db.registerRunner(runnerMeta(), T0);
  let now = T0;
  const retention = new ArchivedHistoryRetention(db, {
    env: {}, log: { info() {}, warn() {} }, now: () => now, sleep: async () => {},
  });
  if (prune) retention.update(PERSONAL_ORGANIZATION_ID, 7, "user");
  const pageCounts: number[] = [];
  for (let cycle = 0; cycle < count; cycle += 1) {
    const sessionId = `size-${cycle}`;
    db.createSession({ id: sessionId, runnerId: RUNNER_ID, workspaceId: "ws", agentId: "agent", title: sessionId,
      useWorktree: false, driver: "claude-code", config: {}, now });
    appendSession(db, sessionId, cycle, now);
    db.setSessionArchived(sessionId, true, now);
    now += 8 * DAY;
    if (prune) {
      const pass = await retention.runPass();
      assert.equal(pass.sessions, 1, `cycle ${cycle} prunes its session`);
    }
    pageCounts.push(pages(db));
  }
  return { pageCounts, db, root, blobs };
}

test("the database stays the same size over repeated create, archive and prune cycles", { timeout: 600_000 }, async () => {
  const control = await cycles(6, false);
  const perCycle = (control.pageCounts.at(-1)! - control.pageCounts[0]!) / (control.pageCounts.length - 1);
  control.db.close();
  rmSync(control.root, { recursive: true, force: true });
  assert.ok(perCycle > 100, `an unpruned transcript grows the file (${perCycle} pages a cycle)`);

  const { pageCounts, db, root, blobs } = await cycles(40, true);
  try {
    // After two warm-up cycles the first freed pages are back on the free list. Each later cycle
    // adds only what its prune keeps (prompts, the final response, usage and completions): about
    // 5% of an unpruned cycle when measured, asserted under 10%.
    const prunedPerCycle = (pageCounts.at(-1)! - pageCounts[1]!) / (pageCounts.length - 2);
    assert.ok(prunedPerCycle < perCycle * 0.1,
      `a pruned cycle grew ${prunedPerCycle.toFixed(1)} pages, an unpruned one ${perCycle.toFixed(1)}`);
    const free = (db.raw().prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
    assert.ok(free < perCycle * 2, `freed pages are reused rather than accumulating (${free} free)`);

    const leftovers = db.raw().prepare(
      `SELECT
         (SELECT COUNT(*) FROM session_events WHERE kind NOT IN
           ('user_message','agent_message','agent_response_completed','token_usage','artifact_attached')) AS events,
         (SELECT COUNT(*) FROM artifacts WHERE json_extract(metadata, '$.purpose')='session_event_payload') AS payloads,
         (SELECT COUNT(*) FROM session_events_fts) AS search,
         (SELECT COUNT(*) FROM session_events WHERE kind IN ('user_message','agent_message')) AS searchable`,
    ).get() as { events: number; payloads: number; search: number; searchable: number };
    assert.equal(leftovers.events, 0, "only kept kinds remain");
    assert.equal(leftovers.payloads, 0, "payload artifacts of pruned events are gone");
    assert.equal(leftovers.search, leftovers.searchable, "only kept events remain searchable");
    const blobFiles = (dir: string): number => readdirSync(dir).reduce((count, name) => {
      const path = join(dir, name);
      return count + (statSync(path).isDirectory() ? blobFiles(path) : 1);
    }, 0);
    assert.equal(blobFiles(blobs), 0, "their blob files are deleted");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
