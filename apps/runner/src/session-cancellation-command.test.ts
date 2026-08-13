import assert from "node:assert/strict";
import test from "node:test";
import { handleSessionCancellationCommand } from "./session-cancellation-command.js";
import { SessionStartFence } from "./session-start-fence.js";

test("interrupt_turn preserves an unsettled session-start fence", async () => {
  const fence = new SessionStartFence();
  let resolveStart!: (ready: boolean) => void;
  const start = new Promise<boolean>((resolve) => {
    resolveStart = resolve;
  });
  fence.track("starting-session", start);

  const interrupted: string[] = [];
  const result = handleSessionCancellationCommand({
    type: "interrupt_turn",
    sessionId: "starting-session",
    turnId: "active-turn",
  }, {
    cancelSessionStart: (sessionId) => fence.cancel(sessionId),
    cancelSession: () => assert.fail("interrupt_turn must not cancel the session"),
    interruptTurn: (sessionId, turnId) => {
      interrupted.push(`${sessionId}:${turnId}`);
      return "applied";
    },
  });
  assert.equal(result, "applied");

  let settled = false;
  const waiting = fence.wait("starting-session").then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(settled, false, "turn interruption must leave the start fence unsettled");

  resolveStart(true);
  assert.equal(await waiting, true, "the fence must preserve the actual start result");
  assert.deepEqual(interrupted, ["starting-session:active-turn"]);
});
