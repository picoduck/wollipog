import { PROTOCOL_VERSION, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "../../../control-plane/src/db.js";

export const RETENTION_SESSION_COUNT = 9;
export const retentionSessionId = (index: number) => `retention-${index}`;
export const retentionSessionTitle = (index: number) => `Synthetic Session ${index}`;
export const retentionPrompt = (index: number) => `Synthetic prompt ${index}`;

/** Nine fixed, complete transcripts through the real authorized API, without a live runner or
 * private data. The history coordinates prevent offline recovery from becoming the workload. */
export function seedSessionRetention(databasePath: string) {
  const db = ControlPlaneDb.open(databasePath);
  const now = 1_700_000_000_000;
  try {
    const runner: RunnerMetadata = { runnerId: "retention-fixture", hostname: "synthetic-host",
      os: "linux", version: "synthetic", workspaces: [], agents: [{ id: "fixture", name: "Codex",
        command: "fixture", args: [], env: {}, driver: "codex-app-server", available: true }] };
    db.registerRunner(runner, now, PROTOCOL_VERSION);
    for (let index = 0; index < RETENTION_SESSION_COUNT; index++) {
      const id = retentionSessionId(index);
      db.createSession({ id, title: retentionSessionTitle(index), runnerId: runner.runnerId,
        workspaceId: null, agentId: "fixture", useWorktree: false, driver: "codex-app-server",
        config: {}, now: now + index });
      db.appendEvent(id, { kind: "user_message", text: retentionPrompt(index) }, now + index);
      db.appendEvent(id, { kind: "agent_message", text: `Synthetic reply ${index}\n\n` +
        "A reproducible transcript with **Markdown** and a small list.\n\n- First item\n- Second item",
        final: true, messageId: `reply-${index}` }, now + index);
      db.updateSessionStatus(id, "idle", now + index);
      db.raw().prepare(`UPDATE sessions SET runner_history_epoch=1, runner_history_tail_seq=2,
        hydrated_seq=2 WHERE id=?`).run(id);
    }
  } finally { db.close(); }
}
