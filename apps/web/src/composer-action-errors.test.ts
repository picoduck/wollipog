import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./api.js";
import { composerActionError, type ComposerAction } from "./composer-action-errors.js";
import { titleCaseLabel } from "./format.js";

const ACTIONS: ComposerAction[] = [
  "cancelMessage", "dismissMessage", "retryMessage", "cancelQueuedMessage", "stopTurn", "rewind", "fork",
  "editInFork", "recoverConversation", "restart", "retrySetup", "restartAfterSetup", "addReference",
  "steerQueuedMessage", "queueAgain", "dismissSteering",
];

test("every action names its failure in Title Case and keeps the server's words for Show Details (#2511)", () => {
  const server = "session is locked by pod reconciliation 'pod-7' until the merge attempt settles";
  for (const action of ACTIONS) {
    const error = composerActionError(action, new ApiError(server, 409));
    assert.equal(error.title, titleCaseLabel(error.title), `${action}: "${error.title}" is Title Case`);
    assert.notEqual(error.title, "Action Failed", action);
    assert.match(error.message, /^[A-Z].*\.$/u, `${action}: one sentence-case sentence`);
    assert.ok(!error.message.includes(server), `${action}: the sentence holds none of the server's words`);
    assert.doesNotMatch(`${error.title} ${error.message}`, /control.plane|runner/iu, action);
    assert.equal(error.detail, server, `${action}: the server's words are its details`);
  }
});

test("an error without words has no details", () => {
  assert.equal(composerActionError("restart", new ApiError("  ", 500)).detail, undefined);
});

test("a machine that is offline or didn't answer in time is named, with nothing behind Show Details", () => {
  assert.deepEqual(composerActionError("restart", new ApiError("runner is offline", 409), "Build Box"), {
    title: "Session Not Restarted",
    message: "Couldn't restart this session. Build Box is offline. Try again once it reconnects.",
  });
  assert.equal(composerActionError("rewind", new ApiError("runner is offline", 409)).message,
    "Couldn't rewind the files to before this turn. The machine is offline. Try again once it reconnects.");
  assert.deepEqual(composerActionError("addReference", new ApiError("runner did not respond in time", 504), "Build Box"), {
    title: "Reference Not Added",
    message: "Couldn't add this reference. Build Box didn't respond in time. Try again.",
  });
});

test("a request that never reached Wollipog says to check the connection; any other client error is generic", () => {
  for (const words of ["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed"]) {
    assert.deepEqual(composerActionError("queueAgain", new TypeError(words)), {
      title: "Message Not Queued",
      message: "Couldn't queue this message again. Wollipog didn't respond. Check your connection and try again.",
    }, words);
  }
  assert.deepEqual(composerActionError("queueAgain", new TypeError("Cannot read properties of undefined")), {
    title: "Message Not Queued",
    message: "Couldn't queue this message again. Try again.",
    detail: "Cannot read properties of undefined",
  });
});

test("known rewind, fork and stop causes have their own sentence", () => {
  const cases: Array<[ComposerAction, string, string]> = [
    ["stopTurn", "the runner reports no active turn to stop", "There's no turn to stop right now."],
    ["rewind", "no checkpoint exists for turn 3",
      "Couldn't rewind the files to before this turn. This turn has no checkpoint to rewind to."],
    ["rewind", "a turn is running — stop or wait before rewinding",
      "Couldn't rewind the files to before this turn. A turn is running. Stop it or wait for it to finish, then try again."],
    ["rewind", "a turn is running or queued — stop or wait before rewinding",
      "Couldn't rewind the files to before this turn. A turn is running. Stop it or wait for it to finish, then try again."],
    ["rewind", "a rewind is already in progress", "Another rewind is still in progress. Wait for it to finish, then try again."],
    ["fork", "the source session is busy — wait before forking",
      "Couldn't fork this conversation. This session is busy. Wait for it to settle, then try again."],
    ["editInFork", "the source session is busy — wait before forking",
      "Couldn't create the fork. This session is busy. Wait for it to settle, then try again."],
  ];
  for (const [action, server, message] of cases) {
    const error = composerActionError(action, new ApiError(server, 409));
    assert.equal(error.message, message, server);
    assert.equal(error.detail, undefined, `${server}: a known cause says all there is to say`);
  }
  // A cause is only known for the action and status it belongs to.
  assert.equal(composerActionError("restart", new ApiError("no checkpoint exists for turn 3", 409)).message,
    "Couldn't restart this session. Try again.");
  assert.equal(composerActionError("stopTurn", new ApiError("the runner reports no active turn to stop", 502)).message,
    "Couldn't stop the turn. Try again or use Stop Session.");
});

test("a steer whose answer was lost doesn't claim the message is still queued", () => {
  const causes = [
    new ApiError("Gateway Timeout", 504),
    new ApiError("runner did not respond in time", 504),
    new ApiError("conversation steering failed: transport closed", 502),
    new TypeError("Failed to fetch"),
  ];
  for (const cause of causes) {
    const error = composerActionError("steerQueuedMessage", cause, "Build Box");
    assert.equal(error.title, "Steer Not Confirmed", cause.message);
    assert.equal(error.message,
      "Couldn't confirm whether the turn took this queued message. Check the transcript and the queue before steering it again.");
    assert.equal(error.detail, cause.message);
  }
  // A definite refusal is checked before the machine takes the message, so it is still queued.
  assert.equal(composerActionError("steerQueuedMessage", new ApiError("the active turn changed before it could be steered", 409)).message,
    "Couldn't steer the turn with this queued message. It's still queued.");
});
