import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  approvalControlLabel,
  ApprovalsMenuChoices,
  defaultPermissionModeDisplayLabel,
  modelEffortControlLabel,
  ModelEffortMenuChoices,
  permissionModeOptionDescription,
  permissionModeOutcome,
} from "./ComposerControls.js";

test("model and reasoning effort are separately labelled menu-radio groups", () => {
  const html = renderToStaticMarkup(React.createElement(ModelEffortMenuChoices, {
    models: [{ id: "gpt", displayName: "GPT", defaultEffort: "medium" }],
    modelSource: "live",
    modelVal: "gpt",
    selectedModel: { id: "gpt", displayName: "GPT", defaultEffort: "medium" },
    modelEfforts: ["low", "high"],
    effortVal: "high",
    apply: () => {},
  }));
  assert.match(html, /role="group" aria-label="Model"/);
  assert.match(html, /role="group" aria-label="Reasoning Effort"/);
  assert.equal((html.match(/role="menuitemradio"/g) ?? []).length, 4);
  assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 2);
});

test("an effort-only control keeps a non-empty Model label when no live catalog is available", () => {
  assert.equal(modelEffortControlLabel(undefined, ""), "Model");
  assert.equal(modelEffortControlLabel(undefined, "opus"), "opus");
  assert.equal(modelEffortControlLabel({ id: "opus", displayName: "Opus 5" }, "opus"), "Opus 5");
});

test("permission outcomes distinguish available, blocked, unrestricted, and unknown modes", () => {
  assert.deepEqual(permissionModeOutcome("default", "available"), {
    label: "Approvals Available", description: "Approval requests raised through this mode reach you in Wollipog.", warning: false,
  });
  assert.equal(permissionModeOutcome("acceptEdits", "unavailable").label, "Blocks Requests");
  assert.equal(permissionModeOutcome("dontAsk", "unavailable").label, "Blocks Requests");
  assert.equal(permissionModeOutcome("bypassPermissions", "unknown").label, "No Command Approvals");
  assert.equal(permissionModeOutcome("bypassPermissions", "available").label, "No Command Approvals");
  assert.equal(permissionModeOutcome("danger-full-access", "available").label, "No Command Approvals");
  assert.deepEqual(permissionModeOutcome("auto", "unknown"), {
    label: "Support Unknown", description: "Wollipog has not verified approval delivery for this mode.", warning: true,
  });
  assert.equal(
    permissionModeOptionDescription(
      "acceptEdits",
      "claude-code",
      "available",
      permissionModeOutcome("acceptEdits", "available"),
    ),
    "File edits and common file commands run without asking. Matching governance policies can ask you before other actions; otherwise those actions are blocked.",
  );
  assert.equal(
    permissionModeOptionDescription(
      "danger-full-access",
      "codex-app-server",
      "available",
      permissionModeOutcome("danger-full-access", "available"),
      ["app-server"],
    ),
    "Questions and MCP elicitations can still reach you. Actions otherwise run without sandbox or approval checks. Use only in isolated environments.",
  );
});

test("permission choices show mode-first copy and only unknown support is a warning", () => {
  const html = renderToStaticMarkup(React.createElement(ApprovalsMenuChoices, {
    capabilities: {
      models: [],
      effortLevels: [],
      slashCommands: [],
      supportsImages: false,
      supportsApprovals: true,
      elicitation: {
        default: ["stdio-control"],
        acceptEdits: ["none"],
        auto: ["stdio-control"],
        dontAsk: ["none"],
        bypassPermissions: ["hook"],
      },
    },
    driver: "claude-code",
    permModes: ["default", "acceptEdits", "dontAsk", "bypassPermissions", "auto", "manual"],
    permVal: "auto",
    apply: () => {},
    close: () => {},
    onDetails: () => {},
  }));
  assert.match(html, />Permission Mode</);
  assert.match(html, /Default \(Auto-Accept Edits\)/);
  assert.match(html, /Don&#x27;t Ask/);
  assert.match(html, />Manual</);
  assert.equal((html.match(/Blocks Requests/g) ?? []).length, 3, "default, acceptEdits, and dontAsk block");
  assert.equal((html.match(/Approvals Available/g) ?? []).length, 2, "default CLI mode and auto can ask");
  assert.equal((html.match(/No Command Approvals/g) ?? []).length, 1, "bypass remains unrestricted despite its hook");
  assert.equal((html.match(/Support Unknown/g) ?? []).length, 1);
  assert.equal((html.match(/cbar-elicitation-state unknown/g) ?? []).length, 1);
  assert.doesNotMatch(html, /Actions requiring approval are blocked/);
  assert.doesNotMatch(html, /Approval requests raised through this mode reach you/);
  assert.doesNotMatch(html, /Matching governance policies can still ask you/);
  assert.doesNotMatch(html, /role="menuitemradio"[^>]*title=/);
  assert.equal((html.match(/role="menuitemradio"/g) ?? []).length, 7);
  assert.equal((html.match(/cbar-permission-details-trigger/g) ?? []).length, 7);
  assert.equal((html.match(/role="menuitem"/g) ?? []).length, 7);
  assert.match(html, /aria-label="Full Access \(No Checks\) Details"/);
});

test("an active Plan mode remains the one checked state while staying outside selectable permission modes", () => {
  const html = renderToStaticMarkup(React.createElement(ApprovalsMenuChoices, {
    capabilities: {
      models: [],
      effortLevels: [],
      slashCommands: [],
      supportsImages: false,
      supportsApprovals: true,
      elicitation: { plan: ["none"] },
    },
    driver: "claude-code",
    permModes: ["default", "acceptEdits", "auto"],
    permVal: "plan",
    apply: () => {},
    close: () => {},
    onDetails: () => {},
  }));
  assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 1);
  assert.match(html, /aria-checked="true" class="cbar-opt permission-mode on"[^>]*>[\s\S]*?Plan Only \(Read-Only\)/);
});

test("the closed permission control identifies the resolved default instead of a transport warning", () => {
  assert.equal(defaultPermissionModeDisplayLabel("claude-code"), "Default (Auto-Accept Edits)");
  assert.equal(
    approvalControlLabel("claude-code", "", "unavailable"),
    "Default (Auto-Accept Edits)",
  );
  assert.equal(
    approvalControlLabel("codex-app-server", "", "available"),
    "Approve for Me",
  );
  assert.equal(
    approvalControlLabel("claude-code", "default", "available"),
    "Ask Every Time",
  );
});

test("legacy approval choices remain unknown rather than unsupported", () => {
  const html = renderToStaticMarkup(React.createElement(ApprovalsMenuChoices, {
    capabilities: {
      models: [],
      effortLevels: [],
      slashCommands: [],
      supportsImages: false,
      supportsApprovals: true,
    },
    driver: "codex",
    permModes: ["workspace-write"],
    permVal: "",
    apply: () => {},
    close: () => {},
    onDetails: () => {},
  }));
  assert.equal((html.match(/Support Unknown/g) ?? []).length, 2);
  assert.doesNotMatch(html, /Approvals Unavailable/);
});
