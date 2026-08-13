import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatCost,
  formatTokens,
  permissionModeDescription,
  permissionModeEmptyLabel,
  permissionModeForDisplay,
  permissionModeLabel,
  resolvedModelLabel,
  sshErrorHint,
  titleCaseLabel,
} from "./format.js";

test("titleCaseLabel formats trusted compact UI labels while preserving acronyms", () => {
  assert.equal(titleCaseLabel("open exact diff"), "Open Exact Diff");
  assert.equal(titleCaseLabel("connect via SSH"), "Connect via SSH");
  assert.equal(titleCaseLabel("max cost (USD)"), "Max Cost (USD)");
  assert.equal(titleCaseLabel("API and CLI status"), "API and CLI Status");
  assert.equal(titleCaseLabel("out-of-band review"), "Out-of-Band Review");
  assert.equal(titleCaseLabel("chatops and github status"), "Chat-Ops and GitHub Status");
});

test("formatTokens: small counts are exact", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(42), "42");
  assert.equal(formatTokens(999), "999");
});

test("formatTokens: thousands use 'k' (one decimal below 10k)", () => {
  assert.equal(formatTokens(1234), "1.2k");
  assert.equal(formatTokens(9999), "10.0k");
  assert.equal(formatTokens(12_500), "13k");
  assert.equal(formatTokens(250_000), "250k");
});

test("formatTokens: crosses cleanly to 'M' at the 1000k boundary", () => {
  assert.equal(formatTokens(999_499), "999k");
  assert.equal(formatTokens(999_999), "1.0M"); // was "1000k" before the fix
  assert.equal(formatTokens(1_200_000), "1.2M");
});

test("formatCost: blank when zero, precise for small amounts", () => {
  assert.equal(formatCost(0), "");
  assert.equal(formatCost(-1), "");
  assert.equal(formatCost(0.0034), "$0.0034");
  assert.equal(formatCost(0.25), "$0.25");
  assert.equal(formatCost(12.5), "$12.50");
});

test("resolvedModelLabel formats live Claude model ids while preserving unknown ids", () => {
  assert.equal(resolvedModelLabel("claude-opus-5[1m]"), "Opus 5 (1M Context)");
  assert.equal(resolvedModelLabel("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(resolvedModelLabel("claude-opus-4-20250514"), "Opus 4");
  assert.equal(resolvedModelLabel("claude-opus-5-20260701"), "Opus 5");
  assert.equal(resolvedModelLabel("provider-custom-model"), "provider-custom-model");
});

test("Codex permission labels match the CLI/Desktop presets", () => {
  assert.equal(permissionModeLabel("read-only"), "Read-Only");
  assert.equal(permissionModeLabel("on-request"), "Ask for Approval");
  assert.equal(permissionModeLabel("auto-review"), "Approve for Me");
  assert.equal(permissionModeLabel("danger-full-access"), "Full Access (No Sandbox)");
  assert.match(permissionModeDescription("on-request") ?? "", /network access require approval/);
});

test("Claude permission labels cover every installed fixed-rule mode", () => {
  assert.equal(permissionModeLabel("acceptEdits", "claude-code"), "Auto-Accept Edits");
  assert.equal(permissionModeLabel("dontAsk", "claude-code"), "Don't Ask");
  assert.equal(permissionModeLabel("manual", "claude-code"), "Manual");
  assert.equal(permissionModeLabel("bypassPermissions", "claude-code"), "Full Access (No Checks)");
  assert.match(permissionModeDescription("dontAsk", "claude-code") ?? "", /blocked instead of asking you/);
  assert.match(permissionModeDescription("manual", "claude-code") ?? "", /has not verified what this mode permits/);
});

test("exec Codex sandbox copy does not promise an interactive approval", () => {
  assert.equal(permissionModeEmptyLabel("codex"), "Sandbox Policy");
  assert.equal(permissionModeEmptyLabel("codex-app-server"), "Approve for Me");
  assert.equal(permissionModeLabel("workspace-write", "codex"), "Auto (Workspace Sandbox)");
  assert.equal(permissionModeLabel("read-only", "codex"), "Read-Only");
  assert.match(permissionModeDescription("workspace-write", "codex") ?? "", /blocked \(no prompt\)/);
  assert.match(permissionModeDescription("read-only", "codex") ?? "", /blocked \(no prompt\)/);
  assert.equal(permissionModeLabel("workspace-write", "codex-app-server"), "Ask for Approval");
  assert.match(permissionModeDescription("workspace-write", "codex-app-server") ?? "", /require approval/);
});

test("legacy Codex modes keep labels consistent with their effective policies", () => {
  const advertised = ["read-only", "on-request", "auto-review", "danger-full-access"];
  assert.equal(permissionModeForDisplay("workspace-write", advertised), "on-request");
  assert.equal(permissionModeForDisplay("untrusted", advertised), "untrusted");
  assert.equal(permissionModeForDisplay("auto-review", advertised), "auto-review");
  assert.equal(permissionModeForDisplay("plan", advertised, "claude-code"), "plan");
  assert.equal(permissionModeForDisplay("plan", advertised, "codex"), "");
  assert.equal(permissionModeForDisplay("unknown", advertised), "");
  assert.equal(permissionModeForDisplay(null, advertised), "");
});

test("sshErrorHint: connection-blocked errors get the VPN/split-tunneling hint", () => {
  for (const msg of [
    "ssh misko@100.66.169.98: ssh: connect to host 100.66.169.98 port 22: Permission denied",
    "ssh: connect to host devbox port 22: Connection timed out",
    "ssh: connect to host devbox port 22: Network is unreachable",
    "ssh: connect to host devbox port 22: No route to host",
  ]) {
    const hint = sshErrorHint(msg);
    assert.ok(hint, `expected a hint for: ${msg}`);
    assert.match(hint!, /split-tunneling/);
  }
});

test("sshErrorHint: auth/host/other failures get NO hint (avoid misleading on a bad key)", () => {
  assert.equal(sshErrorHint("ssh devbox: Permission denied (publickey,password)."), null);
  assert.equal(sshErrorHint("ssh: connect to host devbox port 22: Connection refused"), null);
  assert.equal(sshErrorHint("unsupported remote platform: SunOS i86pc"), null);
  assert.equal(sshErrorHint("scp failed: No such file or directory"), null);
  assert.equal(sshErrorHint(null), null);
  assert.equal(sshErrorHint(""), null);
});
