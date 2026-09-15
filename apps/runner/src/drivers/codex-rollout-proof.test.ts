import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  parseCodexRolloutCompletedCommand,
  readCodexRolloutCompletedCommand,
} from "./codex-rollout-proof.js";

const THREAD = "01a0a2e5-03a9-73e3-bcf9-bc2c857954e9";
const TURN = "01a0a330-d0e4-7491-b4a2-56196e78efcb";
const OCCURRENCE = "workflow_e80c5fe8343d4c8582e3d3207434ec0f";
const COMMAND = `gh pr merge https://github.com/picoduck/wollipog/pull/1146 --squash --match-head-commit ${"a".repeat(40)}`;

function line(type: string, payload: Record<string, unknown>, timestamp: string): string {
  return JSON.stringify({ timestamp, type, payload });
}

function commandItem(
  id: string,
  script: string,
  timestamp: string,
  status = "completed",
  extra: Record<string, unknown> = {},
): string {
  return line("event_msg", {
    type: "item_completed",
    thread_id: THREAD,
    turn_id: TURN,
    item: {
      type: "CommandExecution",
      id,
      status,
      command: ["/usr/bin/zsh", "-lc", script],
      exit_code: 0,
      ...extra,
    },
  }, timestamp);
}

function historicalRollout(command = COMMAND, commandExtra: Record<string, unknown> = {}): string {
  const admissionScript = `task_token=$(<"$WOLLIPOG_SESSION_TOKEN_FILE")\n` +
    `curl --silent --show-error --fail-with-body -X POST ` +
    `-H "x-wollipog-agent-session: $WOLLIPOG_SESSION_ID" ` +
    `"$WOLLIPOG_CONTROL_PLANE_URL/api/sessions/$WOLLIPOG_SESSION_ID/` +
    `workflow-decisions/${OCCURRENCE}/consume"`;
  return [
    line("session_meta", { id: THREAD }, "2026-09-15T03:50:00.000Z"),
    commandItem("admission-cli", admissionScript, "2026-09-15T03:51:58.716Z", "completed", {
      stdout: JSON.stringify({
        occurrenceId: OCCURRENCE,
        status: "approved",
        authority: "orchestrator",
        action: null,
        consumedAt: null,
      }),
    }),
    commandItem("command-merge", command, "2026-09-15T03:52:38.122Z", "completed", commandExtra),
    line("compacted", {}, "2026-09-15T04:15:56.857Z"),
    line("event_msg", { type: "user_message", message: "resumed after restart" }, "2026-09-15T21:15:00.000Z"),
  ].join("\n");
}

test("historical CLI merge proof survives provider compaction and restart", () => {
  assert.deepEqual(parseCodexRolloutCompletedCommand(
    historicalRollout(), THREAD, OCCURRENCE, COMMAND,
  ), {
    commandDigest: createHash("sha256").update(COMMAND, "utf8").digest("hex"),
    providerThreadId: THREAD,
    providerTurnId: TURN,
    providerAdmissionItemId: "admission-cli",
    providerItemId: "command-merge",
  });
});

test("historical CLI merge proof rejects mismatch, failure, ordering, and replay", () => {
  const base = historicalRollout();
  for (const candidate of [
    base.replace(COMMAND, `${COMMAND} --delete-branch`),
    base.replace('"status":"completed","command":["/usr/bin/zsh","-lc","gh pr merge',
      '"status":"failed","command":["/usr/bin/zsh","-lc","gh pr merge'),
    historicalRollout(COMMAND, { exit_code: 1 }),
    base.split("\n").toReversed().join("\n"),
    `${base}\n${commandItem("command-replay", COMMAND, "2026-09-15T22:00:00.000Z")}`,
  ]) {
    assert.equal(parseCodexRolloutCompletedCommand(candidate, THREAD, OCCURRENCE, COMMAND), null);
  }
});

test("durable runner fence binds the exact rollout command without a legacy admission", () => {
  const content = [
    line("session_meta", { id: THREAD }, "2026-09-15T03:50:00.000Z"),
    commandItem("command-current", COMMAND, "2026-09-15T03:52:38.122Z"),
  ].join("\n");
  assert.equal(parseCodexRolloutCompletedCommand(content, THREAD, OCCURRENCE, COMMAND, {
    providerThreadId: THREAD,
    providerTurnId: TURN,
    providerItemId: "command-other",
  }), null);
  assert.equal(parseCodexRolloutCompletedCommand(`${content}\n${commandItem(
    "command-replay", COMMAND, "2026-09-15T03:53:00.000Z",
  )}`, THREAD, OCCURRENCE, COMMAND, {
    providerThreadId: THREAD,
    providerTurnId: TURN,
    providerItemId: "command-current",
  }), null);
});

test("native rollout lookup recovers the historical child proof after process restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-codex-proof-"));
  try {
    const day = join(home, "sessions", "2026", "09", "15");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, `rollout-2026-09-15T03-50-00-${THREAD}.jsonl`), historicalRollout());
    const proof = await readCodexRolloutCompletedCommand(
      { kind: "native" }, home, THREAD, OCCURRENCE, COMMAND,
    );
    assert.equal(proof?.providerAdmissionItemId, "admission-cli");
    assert.equal(proof?.providerItemId, "command-merge");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
