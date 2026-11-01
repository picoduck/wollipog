import assert from "node:assert/strict";
import { test } from "node:test";
import { PROTOCOL_VERSION, type ReviewSessionCapability, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { runnerSupportsReviewQuestionPreservation } from "./review-session-capability.js";

test("question preservation requires explicit advertised support even on a later protocol (#3938)", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    for (const value of [undefined, false, "true", 1, {}, [], true]) {
      const metadata: RunnerMetadata = {
        runnerId: "r", hostname: "test", os: "linux", version: "test", agents: [], workspaces: [],
        runtime: {
          dataDir: "/runner", worktreeRoot: "/runner/worktrees", maxConcurrentSessions: 4,
          reviewSession: { reviewers: [], questionPreservation: value } as unknown as ReviewSessionCapability,
        },
      };
      db.registerRunner(metadata, Date.now(), PROTOCOL_VERSION + 100);
      assert.equal(runnerSupportsReviewQuestionPreservation(db.getRunner("r")), value === true);
      assert.equal(db.getRunner("r")?.runtime?.reviewSession?.questionPreservation, value === true ? true : undefined);
    }
    db.updateRunnerReviewSessionCapability("r", { reviewers: [], questionPreservation: true });
    assert.equal(runnerSupportsReviewQuestionPreservation(db.getRunner("r")), true);
    db.updateRunnerReviewSessionCapability("r", { reviewers: [] });
    assert.equal(runnerSupportsReviewQuestionPreservation(db.getRunner("r")), false);
    db.updateRunnerReviewSessionCapability("r", null);
    assert.equal(runnerSupportsReviewQuestionPreservation(db.getRunner("r")), false);
  } finally { db.close(); }
});

test("question preservation also requires the existing review-session transport (#3938)", () => {
  assert.equal(runnerSupportsReviewQuestionPreservation(null), false);
  assert.equal(runnerSupportsReviewQuestionPreservation(undefined), false);
  assert.equal(runnerSupportsReviewQuestionPreservation({ protocolVersion: 225,
    runtime: { reviewSession: { reviewers: [], questionPreservation: true } } }), false);
  assert.equal(runnerSupportsReviewQuestionPreservation({ protocolVersion: 226,
    runtime: { reviewSession: { reviewers: [], questionPreservation: true } } }), true);
});
