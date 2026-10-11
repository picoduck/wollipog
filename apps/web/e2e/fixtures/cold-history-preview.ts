import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION, type ControlPlaneToRunner, type RunnerMetadata, type SessionEventPayload } from "@wollipog/protocol";
import { ControlPlaneDb } from "../../../control-plane/src/db.js";
import { SessionStore } from "../../../runner/src/session-store.js";
import { LONG_TURN_SESSION_ID } from "./long-turn-opening-seed.js";

export const COLD_SESSION_ID = "cold-history-preview";
export const COLD_NAV_SESSION_ID = "cold-history-navigation";
export const COLD_NAV_PROMPT = "Read the first synthetic background-work turn.";

/** Real indexed runner history, with only its first row hydrated in the CP. The websocket
 * deliberately holds ordinary forward hydration; reader RPCs still use the real store. */
export function seedColdHistoryPreview(databasePath: string, root: string) {
  const db = ControlPlaneDb.open(databasePath);
  const store = new SessionStore(root);
  try {
    const runner = db.getRunner("opening-benchmark")!;
    const events = db.listEvents(LONG_TURN_SESSION_ID).map(({ seq, ts, payload }) => ({ seq, ts, payload }));
    store.create({ sessionId: COLD_SESSION_ID, agentId: "fixture", workspaceId: null, repoPath: root,
      worktreePath: null, driver: "codex-app-server", command: "fixture", args: [], env: {},
      context: { kind: "native" }, agentSessionId: null, status: "idle", title: "Synthetic Cold History",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      seq: events.length, createdAt: 1, updatedAt: 1 });
    writeFileSync(join(root, COLD_SESSION_ID, "events.ndjson"), events.map(event => JSON.stringify(event)).join("\n") + "\n");
    const first = store.readEventPageForProtocol(COLD_SESSION_ID, { afterSeq: 0, limit: 1 }, PROTOCOL_VERSION);
    if (!first.ok) throw new Error(first.error);
    store.flush(COLD_SESSION_ID);
    db.raw().prepare("UPDATE sessions SET runner_history_epoch=?, runner_history_tail_seq=1, hydrated_seq=1 WHERE id='opening-welcome'")
      .run(first.page.logEpoch);
    db.createSession({ id: COLD_SESSION_ID, title: "Synthetic Cold History", runnerId: runner.runnerId,
      workspaceId: null, agentId: "fixture", useWorktree: false, driver: "codex-app-server", config: {}, now: 1 });
    db.reconcileRunnerHistory(COLD_SESSION_ID, first.page.logEpoch, first.page.throughSeq);
    db.appendHydratedPage(COLD_SESSION_ID, { afterSeq: 0, historyEpoch: first.page.logEpoch, eventEpoch: 0 }, first.events);
    const navigationEvents: Array<{ seq: number; ts: number; payload: SessionEventPayload }> = [];
    for (let turn = 1; turn <= 3; turn++) {
      const append = (payload: SessionEventPayload) => navigationEvents.push({ seq: navigationEvents.length + 1, ts: 1, payload });
      append({ kind: "user_message", text: turn === 1 ? COLD_NAV_PROMPT : `Synthetic navigation turn ${turn}.`, turnId: `navigation-turn-${turn}` });
      for (let row = 0; row < 399; row++) append({ kind: "agent_message", text: `Synthetic navigation row ${turn}:${row}.`, final: true });
      append({ kind: "conversation_checkpoint", turn });
    }
    store.create({ ...store.readMeta(COLD_SESSION_ID)!, sessionId: COLD_NAV_SESSION_ID,
      title: "Synthetic Cold Navigation", seq: navigationEvents.length, historyTurnAnchor: undefined });
    writeFileSync(join(root, COLD_NAV_SESSION_ID, "events.ndjson"), navigationEvents.map(event => JSON.stringify(event)).join("\n") + "\n");
    const navigationFirst = store.readEventPageForProtocol(COLD_NAV_SESSION_ID, { afterSeq: 0, limit: 1 }, PROTOCOL_VERSION);
    if (!navigationFirst.ok) throw new Error(navigationFirst.error);
    store.flush(COLD_NAV_SESSION_ID);
    db.createSession({ id: COLD_NAV_SESSION_ID, title: "Synthetic Cold Navigation", runnerId: runner.runnerId,
      workspaceId: null, agentId: "fixture", useWorktree: false, driver: "codex-app-server", config: {}, now: 1 });
    db.reconcileRunnerHistory(COLD_NAV_SESSION_ID, navigationFirst.page.logEpoch, navigationFirst.page.throughSeq);
    db.appendHydratedPage(COLD_NAV_SESSION_ID, { afterSeq: 0, historyEpoch: navigationFirst.page.logEpoch, eventEpoch: 0 }, navigationFirst.events);
    db.raw().prepare("UPDATE sessions SET background_work_tracking='managed', background_work_state='running' WHERE id=?").run(COLD_NAV_SESSION_ID);
    db.raw().prepare(`INSERT INTO managed_background_jobs
      (session_id,job_id,parent_turn_id,runner_id,launch_type,registered_at,last_observed_at)
      VALUES(?,?,?,?,?,?,?)`).run(COLD_NAV_SESSION_ID, "navigation-job-turn1", "navigation-turn-1", runner.runnerId, "shell", Date.now() - 60_000, Date.now());
    return { store, runner: { runnerId: runner.runnerId, hostname: "test-host", os: "linux",
      version: "synthetic", workspaces: [], agents: runner.agents } satisfies RunnerMetadata };
  } finally { db.close(); }
}

export async function connectColdHistoryRunner(base: string, fixture: ReturnType<typeof seedColdHistoryPreview>) {
  const socket = new WebSocket(`${base.replace("http:", "ws:")}/runner`);
  let hydrating = false;
  const held: Array<{ reply: () => void; fail: () => void }> = [];
  let ordinaryReads = 0;
  let diagnosticReads = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  await new Promise<void>((done, reject) => {
    socket.addEventListener("error", () => reject(new Error("synthetic runner connection failed")));
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "register", token: "dev-local-token",
      runner: fixture.runner, protocolVersion: PROTOCOL_VERSION,
      liveSessions: [LONG_TURN_SESSION_ID, COLD_SESSION_ID, COLD_NAV_SESSION_ID, "opening-welcome"] })));
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data)) as ControlPlaneToRunner;
      if (message.type === "registered") {
        heartbeat = setInterval(() => socket.send(JSON.stringify({ type: "heartbeat", runnerId: fixture.runner.runnerId, ts: Date.now() })), 5_000);
        done();
      }
      if (message.type === "register_rejected") reject(new Error(message.reason));
      if (message.type !== "session_history_page" || ![COLD_SESSION_ID, COLD_NAV_SESSION_ID].includes(message.sessionId)) return;
      const reply = () => {
        const readStarted = performance.now();
        const cpuStarted = process.cpuUsage();
        const result = message.opening === "current-turn"
          ? fixture.store.readCurrentTurnPageForProtocol(message.sessionId, message.limit, PROTOCOL_VERSION, message.maxBytes)
          : fixture.store.readEventPageForProtocol(message.sessionId, message, PROTOCOL_VERSION, message.indexedOnly === true);
        if (message.indexedOnly && diagnosticReads++ < 32) {
          const cpu = process.cpuUsage(cpuStarted);
          console.info(`Runner Read Diagnostic: ${JSON.stringify({ sessionId: message.sessionId,
            opening: message.opening ?? null, wallMs: performance.now() - readStarted, cpuMs: (cpu.user + cpu.system) / 1_000 })}`);
        }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "session_history_page_result",
          requestId: message.requestId, sessionId: message.sessionId, ...result }));
      };
      if (message.indexedOnly) reply(); else {
        ordinaryReads++;
        if (hydrating) reply(); else held.push({ reply, fail: () => socket.send(JSON.stringify({
          type: "session_history_page_result", requestId: message.requestId, sessionId: message.sessionId,
          ok: false, code: "history_cursor_invalid", error: "Synthetic interrupted hydration read" })) });
      }
    });
  });
  return {
    ordinaryReadCount() { return ordinaryReads; },
    interruptHydration() { const pending = held.splice(0); for (const read of pending) read.fail(); return pending.length; },
    releaseHydration() { hydrating = true; for (const read of held.splice(0)) read.reply(); },
    stop() { if (heartbeat) clearInterval(heartbeat); socket.close(); },
  };
}
