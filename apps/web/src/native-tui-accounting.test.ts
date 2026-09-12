import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDefinition } from "@wollipog/protocol";
import { nativeTuiAccountingDetail } from "./native-tui-accounting.js";

const agent = (nearestStructuredSurface: "print-mode-only" | "separate-app-server" | "none"): AgentDefinition => ({
  id: "provider",
  name: "Provider",
  command: "provider",
  args: [],
  env: {},
  nativeTuiAccounting: {
    status: "unavailable",
    provider: nearestStructuredSurface === "print-mode-only" ? "claude-code" : "codex",
    installedVersion: nearestStructuredSurface === "print-mode-only" ? "2.1.261" : "0.153.4",
    verification: "live-cli-contract",
    nearestStructuredSurface,
    missingRequirements: ["authoritative_usage_events", "gap_detection"],
  },
});

test("Native TUI accounting detail names only fixed provider contract facts", () => {
  assert.match(nativeTuiAccountingDetail(agent("print-mode-only")) ?? "", /Claude Code 2\.1\.261/);
  assert.match(nativeTuiAccountingDetail(agent("separate-app-server")) ?? "", /separate App Server/);
  assert.match(nativeTuiAccountingDetail(agent("none")) ?? "", /No authoritative session-bound/);
  assert.equal(nativeTuiAccountingDetail(undefined), null);
});

