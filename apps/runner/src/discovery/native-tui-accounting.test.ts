import assert from "node:assert/strict";
import { test } from "node:test";
import { unavailableNativeTuiAccounting } from "./native-tui-accounting.js";

test("Claude Native TUI remains unavailable despite its separate print-mode stream", () => {
  assert.deepEqual(unavailableNativeTuiAccounting("claude-code", "2.1.261", true), {
    status: "unavailable",
    provider: "claude-code",
    installedVersion: "2.1.261",
    verification: "live-cli-contract",
    nearestStructuredSurface: "print-mode-only",
    missingRequirements: [
      "authoritative_usage_events",
      "stable_event_identity",
      "replay_watermark",
      "gap_detection",
    ],
  });
});

test("Codex Native TUI does not inherit accounting from the separate app-server surface", () => {
  const boundary = unavailableNativeTuiAccounting("codex", "0.153.4", true);
  assert.equal(boundary.status, "unavailable");
  assert.equal(boundary.nearestStructuredSurface, "separate-app-server");
  assert.ok(boundary.missingRequirements.includes("pre_first_turn_binding"));
  assert.ok(boundary.missingRequirements.includes("gap_detection"));
});

test("missing providers expose no inferred structured surface or provider output", () => {
  const boundary = unavailableNativeTuiAccounting("codex", undefined, false);
  assert.equal(boundary.nearestStructuredSurface, "none");
  assert.equal(boundary.verification, "provider-not-installed");
  assert.equal(boundary.installedVersion, undefined);
  assert.equal(JSON.stringify(boundary).includes("command"), false);
  assert.equal(
    unavailableNativeTuiAccounting("codex", "Bash: curl -H Authorization:Bearer-secret", true).installedVersion,
    undefined,
    "untrusted version output is never projected",
  );
});
