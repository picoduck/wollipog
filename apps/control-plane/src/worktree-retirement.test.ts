import assert from "node:assert/strict";
import { test } from "node:test";
import { PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL, runnerCapabilityRequirement } from "@wollipog/protocol";
import { legacyPeerWorktreeRetirement } from "./worktree-retirement.js";

const FLOOR = RUNNER_CAPABILITY_MIN_PROTOCOL.sessionWorktreeRetirement;
const LEGACY = FLOOR - 1;
const RETENTION_REFUSAL =
  "worktree retained: the worktree is still handling a provider turn or queued input";
/** Known, missing and malformed reports, each with the structured version it should produce. */
const LEGACY_REPORTS: Array<[number | null | undefined, number | null]> = [
  [LEGACY, LEGACY],
  [undefined, null],
  [null, null],
  [Number.NaN, null],
  [12.5, null],
];

test("a peer that cannot record a durable retirement produces an explicit, actionable result", () => {
  for (const [version, runnerProtocolVersion] of LEGACY_REPORTS) {
    const reported = legacyPeerWorktreeRetirement(version, RETENTION_REFUSAL);
    assert.ok(reported, `version ${String(version)} is below the retirement floor`);
    assert.deepEqual(reported.retirement, { status: "unsupported", reason: "legacy_runner" });
    assert.equal(reported.error.startsWith(RETENTION_REFUSAL), true,
      "the peer's own refusal is preserved verbatim rather than replaced");
    assert.match(reported.error, /no retirement was recorded, so this refusal will not replay on its own/,
      "the caller is told the refusal is terminal, not a pending receipt");
    assert.match(reported.error, /Retry the discard once the session's provider has exited\./,
      "the caller is given the recovery action");
    assert.equal(
      reported.error.endsWith(
        runnerCapabilityRequirement(version, "sessionWorktreeRetirement", "deferred worktree retirement")),
      true,
      "the runner-update step is the shared requirement sentence",
    );
    assert.equal(reported.requiredRunnerProtocolVersion, FLOOR,
      "the version that supplies a durable receipt travels as a structured field");
    assert.equal(reported.runnerProtocolVersion, runnerProtocolVersion,
      "what this peer reports travels as a structured field, null when unreported or malformed");
  }
});

test("the refusal names no protocol numbers and no retired terms for any reported version", () => {
  for (const [version] of LEGACY_REPORTS) {
    const { error } = legacyPeerWorktreeRetirement(version, RETENTION_REFUSAL)!;
    for (const retired of [/protocol/i, /\bv\d+/, /pre-v15/i, /malformed/i]) {
      assert.doesNotMatch(error, retired, `version ${String(version)}: ${String(retired)}`);
    }
    const added = error.slice(RETENTION_REFUSAL.length);
    for (const retired of [/durable/i, /control plane/i, /protocol/i]) {
      assert.doesNotMatch(added, retired,
        `version ${String(version)}: the added copy avoids the docs/design-system.md §17.2 term ${String(retired)}`);
    }
  }
});

test("a peer that can record a durable retirement has its refusal relayed unchanged", () => {
  for (const version of [FLOOR, PROTOCOL_VERSION]) {
    assert.equal(
      legacyPeerWorktreeRetirement(version, "worktree retained: the worktree has uncommitted changes"),
      null,
      "a capable peer's safety refusal must never be re-labelled as a version gap",
    );
  }
});
