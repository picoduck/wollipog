import type { RunnerMetadata, SessionEventPayload } from "@wollipog/protocol";
import { ControlPlaneDb } from "../../../control-plane/src/db.js";

export const LONG_TURN_SESSION_ID = "long-turn-opening";
export const LONG_TURN_START_SEQ = 1_503;
export const LONG_TURN_TAIL_SEQ = 10_503;
export const LONG_TURN_PROMPT = "Read this current turn from its beginning.";

/** Deterministic, private synthetic data: 1,502 earlier events, one prompt and 1,500 tool
 * invocations with five updates each. No real prompts, paths, identities or transcript bytes. */
export function seedLongTurnOpening(databasePath: string) {
  const db = ControlPlaneDb.open(databasePath);
  try {
    const runner: RunnerMetadata = { runnerId: "opening-benchmark", hostname: "test-host", os: "linux",
      version: "synthetic", workspaces: [], agents: [{ id: "fixture", name: "Codex", command: "fixture",
        args: [], env: {}, driver: "codex-app-server", available: true }] };
    db.registerRunner(runner, Date.now(), 67);
    const create = (id: string, title: string) => db.createSession({ id, title, runnerId: runner.runnerId,
      workspaceId: null, agentId: "fixture", useWorktree: false, driver: "codex-app-server", config: {}, now: Date.now() });
    create(LONG_TURN_SESSION_ID, "Synthetic Long Turn");
    // Seed in one transaction rather than benchmarking 10,503 durable event-ingest commits.
    // The reader consumes exactly the same stored event rows through the real authorized API.
    let seq = 0;
    const insert = db.raw().prepare("INSERT INTO session_events(session_id, seq, ts, kind, payload) VALUES(?,?,?,?,?)");
    const append = (payload: SessionEventPayload) => insert.run(LONG_TURN_SESSION_ID, ++seq,
      Date.now() - 60_000, payload.kind, JSON.stringify(payload));
    db.raw().exec("BEGIN");
    for (let index = 0; index < 1_502; index++) append({ kind: "stderr", text: `Earlier synthetic event ${index}` });
    append({ kind: "user_message", text: LONG_TURN_PROMPT });
    for (let index = 0; index < 1_500; index++) {
      const toolCallId = `synthetic-tool-${index}`;
      append({ kind: "tool_call", toolCallId, title: `Check synthetic item ${index + 1}`, status: "running",
        toolKind: "read", text: "Synthetic tool input." });
      for (let update = 0; update < 5; update++) append({ kind: "tool_call_update", toolCallId,
        status: update === 4 ? "completed" : "running", text: `Synthetic result update ${update + 1}.` });
    }
    db.raw().exec("COMMIT");
    db.raw().prepare(`UPDATE sessions SET message_count=1, last_event_at=?, runner_history_epoch=1,
      runner_history_tail_seq=?, hydrated_seq=? WHERE id=?`)
      .run(Date.now() - 60_000, seq, seq, LONG_TURN_SESSION_ID);
    create("opening-welcome", "Opening Benchmark Ready");
    db.appendEvent("opening-welcome", { kind: "user_message", text: "Warm the application before measuring navigation." }, Date.now());
    db.updateSessionStatus(LONG_TURN_SESSION_ID, "idle", Date.now());
    db.updateSessionStatus("opening-welcome", "idle", Date.now());
  } finally { db.close(); }
}
