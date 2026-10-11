import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION, type ControlPlaneToRunner, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "../../../control-plane/src/db.js";
import { SessionStore } from "../../../runner/src/session-store.js";
import { LONG_TURN_SESSION_ID } from "./long-turn-opening-seed.js";

export const COLD_SESSION_ID = "cold-history-preview";

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
    return { store, runner: { runnerId: runner.runnerId, hostname: "test-host", os: "linux",
      version: "synthetic", workspaces: [], agents: runner.agents } satisfies RunnerMetadata };
  } finally { db.close(); }
}

export async function connectColdHistoryRunner(base: string, fixture: ReturnType<typeof seedColdHistoryPreview>) {
  const socket = new WebSocket(`${base.replace("http:", "ws:")}/runner`);
  let hydrating = false;
  const held: Array<() => void> = [];
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  await new Promise<void>((done, reject) => {
    socket.addEventListener("error", () => reject(new Error("synthetic runner connection failed")));
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "register", token: "dev-local-token",
      runner: fixture.runner, protocolVersion: PROTOCOL_VERSION,
      liveSessions: [LONG_TURN_SESSION_ID, COLD_SESSION_ID, "opening-welcome"] })));
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data)) as ControlPlaneToRunner;
      if (message.type === "registered") {
        heartbeat = setInterval(() => socket.send(JSON.stringify({ type: "heartbeat", runnerId: fixture.runner.runnerId, ts: Date.now() })), 5_000);
        done();
      }
      if (message.type === "register_rejected") reject(new Error(message.reason));
      if (message.type !== "session_history_page" || message.sessionId !== COLD_SESSION_ID) return;
      const reply = () => {
        const result = message.opening === "current-turn"
          ? fixture.store.readCurrentTurnPageForProtocol(COLD_SESSION_ID, message.limit, PROTOCOL_VERSION, message.maxBytes)
          : fixture.store.readEventPageForProtocol(COLD_SESSION_ID, message, PROTOCOL_VERSION, message.indexedOnly === true);
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "session_history_page_result",
          requestId: message.requestId, sessionId: COLD_SESSION_ID, ...result }));
      };
      if (message.indexedOnly || hydrating) reply(); else held.push(reply);
    });
  });
  return {
    releaseHydration() { hydrating = true; for (const reply of held.splice(0)) reply(); },
    stop() { if (heartbeat) clearInterval(heartbeat); socket.close(); },
  };
}
