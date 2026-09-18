import assert from "node:assert/strict";
import { test } from "node:test";
import { PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL } from "@wollipog/protocol";
import { legacyPeerWorktreeRetirement } from "./worktree-retirement.js";

const LEGACY = RUNNER_CAPABILITY_MIN_PROTOCOL.sessionWorktreeRetirement - 1;
const RETENTION_REFUSAL =
  "worktree retained: the worktree is still handling a provider turn or queued input";

test("a peer that cannot record a durable retirement produces an explicit, actionable result", () => {
  const reported = legacyPeerWorktreeRetirement(LEGACY, RETENTION_REFUSAL);
  assert.deepEqual(reported?.retirement, { status: "unsupported", reason: "legacy_runner" });
  assert.equal(reported?.error.startsWith(RETENTION_REFUSAL), true,
    "the peer's own refusal is preserved verbatim rather than replaced");
  assert.match(reported!.error, new RegExp(`v${RUNNER_CAPABILITY_MIN_PROTOCOL.sessionWorktreeRetirement}`),
    "the caller is told exactly which protocol version supplies a durable receipt");
  assert.match(reported!.error, new RegExp(`protocol v${LEGACY}\\b`),
    "the caller is told exactly what this peer reports");
  assert.match(reported!.error, /will not replay on its own/,
    "the caller is told the refusal is terminal, not a pending receipt");
  assert.match(reported!.error, /retry the discard once the session's provider has exited, or update and restart the runner/,
    "the caller is given the recovery action");
});

test("an unreported or malformed peer version is named rather than guessed", () => {
  for (const version of [undefined, null, Number.NaN, 12.5]) {
    const reported = legacyPeerWorktreeRetirement(version as number | null | undefined, RETENTION_REFUSAL);
    assert.deepEqual(reported?.retirement, { status: "unsupported", reason: "legacy_runner" });
    assert.match(reported!.error, /an unknown version \(pre-v15, malformed, or not reported\)/);
  }
});

test("a peer that can record a durable retirement has its refusal relayed unchanged", () => {
  for (const version of [RUNNER_CAPABILITY_MIN_PROTOCOL.sessionWorktreeRetirement, PROTOCOL_VERSION]) {
    assert.equal(
      legacyPeerWorktreeRetirement(version, "worktree retained: the worktree has uncommitted changes"),
      null,
      "a capable peer's safety refusal must never be re-labelled as a version gap",
    );
  }
});
