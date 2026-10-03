import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  approvalControlLabel,
  approvalDeliveryUnverified,
  ApprovalsMenuChoices,
  defaultPermissionModeDisplayLabel,
  modelEffortControlLabel,
  ModelEffortMenuChoices,
  permissionModeOptionDescription,
  serviceTierChoices,
  ServiceTierMenuChoices,
  sessionPermissionModeControls,
  unverifiedDeliveryNote,
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

test("service tier choices expose Standard and provider copy for only the selected model", () => {
  const capabilities = {
    models: [
      {
        id: "gpt-fast",
        default: true,
        serviceTiers: [{ id: "fast", name: "Fast", description: "Uses more credits." }],
        defaultServiceTier: "fast",
      },
      { id: "gpt-standard" },
    ],
    effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: true,
  };
  const state = serviceTierChoices(capabilities, "gpt-fast", undefined);
  assert.deepEqual(state, {
    choices: [
      { id: "default", name: "Standard", description: "Standard response speed. Applies to the next turn." },
      { id: "fast", name: "Fast", description: "Uses more credits. Applies to the next turn." },
    ],
    selected: { id: "fast", name: "Fast", description: "Uses more credits. Applies to the next turn." },
  });
  assert.equal(serviceTierChoices(capabilities, "gpt-standard", "fast"), null);
  const html = renderToStaticMarkup(React.createElement(ServiceTierMenuChoices, {
    state: state!, apply: () => {}, close: () => {},
  }));
  assert.match(html, /role="group" aria-label="Service Tier"/);
  assert.match(html, />Standard</);
  assert.match(html, />Fast</);
  assert.match(html, /Uses more credits\. Applies to the next turn\./);
  assert.equal((html.match(/role="menuitemradio"/g) ?? []).length, 2);
  assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 1);
});

test("a mode's description says what runs and, where Wollipog knows, what happens to approvals", () => {
  assert.equal(
    permissionModeOptionDescription("acceptEdits", "claude-code", "available"),
    "File edits and common file commands run without asking. Matching governance policies can ask you before other actions; otherwise those actions are blocked.",
  );
  assert.equal(
    permissionModeOptionDescription("acceptEdits", "claude-code", "unavailable"),
    "File edits and common file commands run without asking. Actions that need approval are blocked instead of asking you.",
  );
  // Unknown delivery belongs to the menu's one note, never to the row.
  assert.equal(
    permissionModeOptionDescription("acceptEdits", "claude-code", "unknown"),
    "File edits and common file commands run without asking.",
  );
  // Don't Ask and exec Codex block by definition: their meaning already says so, once.
  assert.equal(
    permissionModeOptionDescription("dontAsk", "claude-code", "unavailable"),
    "Only actions your settings already allow run; anything else is blocked instead of asking you.",
  );
  assert.equal(
    permissionModeOptionDescription("workspace-write", "codex", "unavailable"),
    "Reads and writes inside the workspace run automatically; files outside it and network access are blocked.",
  );
  // "No Command Approvals" folds into the Full Access description.
  assert.equal(
    permissionModeOptionDescription("danger-full-access", "codex-app-server", "available", ["app-server"]),
    "Everything runs with no sandbox and no command approvals, but questions can still reach you. Use only in isolated environments.",
  );
  assert.equal(
    permissionModeOptionDescription("bypassPermissions", "claude-code", "available", ["hook"]),
    "Everything runs with no command approvals, but matching governance policies can still ask you before a tool runs. Use only in isolated environments.",
  );
  assert.equal(
    permissionModeOptionDescription("bypassPermissions", "claude-code", "unknown"),
    "Everything runs with no command approvals. Use only in isolated environments.",
  );
  for (const mode of ["default", "acceptEdits", "dontAsk", "bypassPermissions", "auto", "manual", "plan",
    "read-only", "workspace-write", "danger-full-access", "untrusted", "auto-review", "on-request"]) {
    for (const status of ["available", "unavailable", "unknown"] as const) {
      assert.doesNotMatch(
        permissionModeOptionDescription(mode, "codex-app-server", status, ["app-server", "hook"]) ?? "",
        /elicitation|transport/i,
        `${mode} ${status} speaks plainly`,
      );
    }
  }
});

test("only a mode that asks or blocks can have unverified approval delivery", () => {
  assert.equal(approvalDeliveryUnverified("default", "unknown"), true);
  assert.equal(approvalDeliveryUnverified(undefined, "unknown"), true, "an unresolved default is unverified");
  assert.equal(approvalDeliveryUnverified("default", "available"), false);
  assert.equal(approvalDeliveryUnverified("default", "unavailable"), false);
  assert.equal(approvalDeliveryUnverified("bypassPermissions", "unknown"), false);
  assert.equal(approvalDeliveryUnverified("danger-full-access", "unknown"), false);
  assert.equal(approvalDeliveryUnverified("plan", "unknown"), false);
});

test("the unverified-delivery note names every affected mode in one sentence", () => {
  assert.equal(unverifiedDeliveryNote(["Manual"]),
    "Wollipog hasn't confirmed that approval prompts from Manual reach you here.");
  assert.equal(unverifiedDeliveryNote(["Default", "Approve for Me"]),
    "Wollipog hasn't confirmed that approval prompts from Default and Approve for Me reach you here.");
  assert.equal(unverifiedDeliveryNote(["Default (Auto-Accept Edits)", "Ask Every Time", "Auto-Accept Edits"]),
    "Wollipog hasn't confirmed that approval prompts from Default (Auto-Accept Edits), Ask Every Time, and Auto-Accept Edits reach you here.");
});

function menuRows(html: string): string[] {
  return html.split(/(?=<button)/).filter((part) => part.startsWith("<button"));
}

test("each permission mode is one two-line menu radio with its meaning, and unknown delivery is one note", () => {
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
  }));
  assert.match(html, />Permission Mode</);
  const rows = menuRows(html);
  assert.equal(rows.length, 7, "every row is exactly one button");
  assert.ok(rows.every((row) => row.includes('role="menuitemradio"')), "and that button is the menu radio");
  assert.doesNotMatch(html, /role="menuitem"/, "no row carries a second control");
  assert.doesNotMatch(html, /Details/);
  assert.equal((html.match(/class="menu-desc"/g) ?? []).length, 7, "every mode shows its meaning");
  assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 1);
  assert.match(html, /role="menuitemradio" aria-checked="true"[^>]*>[\s\S]*?Auto \(AI-Reviewed\)/);
  assert.match(html, /Default \(Auto-Accept Edits\)[\s\S]*?File edits and common file commands run without asking\. Actions that need approval are blocked instead of asking you\./);
  assert.match(html, /Don&#x27;t Ask[\s\S]*?Only actions your settings already allow run/);
  assert.match(html, /Full Access \(No Checks\)[\s\S]*?Everything runs with no command approvals, but matching governance policies/);
  assert.doesNotMatch(html, /Support Unknown|Blocks Requests|No Command Approvals|Approvals Available/);
  // The amber shield marks Full Access only (the stylesheet colours it, §21 item 5).
  assert.equal((html.match(/permission-mode-risk/g) ?? []).length, 1);
  assert.match(rows.find((row) => row.includes("Full Access"))!, /permission-mode-risk/);
  // One note at the bottom names the one unverified mode, and that row points at it.
  assert.equal((html.match(/class="menu-note"/g) ?? []).length, 1);
  assert.match(html, /<div class="menu-note" id="([^"]+)" role="presentation">Wollipog hasn&#x27;t confirmed that approval prompts from Manual reach you here\.<\/div>$/);
  const noteId = /class="menu-note" id="([^"]+)"/.exec(html)![1]!;
  const describedBy = rows.filter((row) => row.includes(noteId));
  assert.equal(describedBy.length, 1);
  assert.match(describedBy[0]!, />Manual</);
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
  }));
  assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 1);
  assert.match(html, /role="menuitemradio" aria-checked="true"[^>]*>[\s\S]*?Plan Only \(Read-Only\)/);
});

test("Pi presents its default ask mode once while preserving an explicit stored default", () => {
  const html = renderToStaticMarkup(React.createElement(ApprovalsMenuChoices, {
    capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: true,
      permissionModes: ["default", "dontAsk", "bypassPermissions"],
      elicitation: { default: ["stdio-control"], dontAsk: ["none"], bypassPermissions: ["none"] },
    },
    driver: "pi",
    permModes: ["default", "dontAsk", "bypassPermissions"],
    permVal: "default",
    apply: () => {},
    close: () => {},
  }));
  assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 1);
  assert.equal((html.match(/role="menuitemradio"/g) ?? []).length, 3);
  assert.doesNotMatch(html, />Ask Every Time</);
  assert.match(html, />Default</);
  assert.match(html, /You approve each tool call before it runs\./);
  assert.doesNotMatch(html, /menu-note/, "every Pi mode's delivery is verified, so no note renders");
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
  assert.equal(
    approvalControlLabel("pi", "", "available"),
    "Ask Every Time",
  );
});

test("Pi permission controls reflect target support and retain a Full Access recovery path", () => {
  const capabilities = {
    models: [], effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: true,
    permissionModes: ["default", "dontAsk", "bypassPermissions"],
  };
  assert.deepEqual(sessionPermissionModeControls({
    driver: "pi", permissionMode: null,
    executionTarget: {
      id: "container", runnerId: "runner", kind: "container", adapter: "container",
      workspaceStrategy: "worktree",
      boundaries: { filesystem: "container", network: "deny", secrets: "none", billing: "none" },
    },
  }, capabilities), {
    permModes: ["bypassPermissions"],
    permVal: "bypassPermissions",
    showDefaultPermissionMode: false,
  });
  assert.deepEqual(sessionPermissionModeControls({
    driver: "pi", permissionMode: "default",
    executionTarget: {
      id: "host", runnerId: "runner", kind: "local", adapter: "host",
      workspaceStrategy: "worktree",
      boundaries: { filesystem: "host", network: "inherit", secrets: "runner_local", billing: "agent_account" },
    },
  }, undefined), {
    permModes: ["bypassPermissions"],
    permVal: "default",
    showDefaultPermissionMode: true,
  });
  const nonHostMenu = renderToStaticMarkup(React.createElement(ApprovalsMenuChoices, {
    capabilities,
    driver: "pi",
    permModes: ["bypassPermissions"],
    permVal: "bypassPermissions",
    apply: () => {}, close: () => {}, showDefault: false,
  }));
  assert.doesNotMatch(nonHostMenu, />Default</);
  assert.match(nonHostMenu, /Full Access/);
  assert.equal((nonHostMenu.match(/role="menuitemradio"/g) ?? []).length, 1);
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
  }));
  assert.equal((html.match(/class="menu-note"/g) ?? []).length, 1);
  assert.match(html, /approval prompts from Default and Auto \(Workspace Sandbox\) reach you here\./);
  assert.doesNotMatch(html, /blocked instead of asking you/, "unknown is never presented as blocked");
});

test("Codex marks Full Access with the amber shield and no other row", () => {
  const html = renderToStaticMarkup(React.createElement(ApprovalsMenuChoices, {
    capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: true,
      permissionModes: ["read-only", "on-request", "auto-review", "danger-full-access"],
      elicitation: {
        "read-only": ["app-server"],
        "on-request": ["app-server"],
        "auto-review": ["app-server"],
        "danger-full-access": ["app-server"],
      },
    },
    driver: "codex-app-server",
    permModes: ["read-only", "on-request", "auto-review", "danger-full-access"],
    permVal: "danger-full-access",
    apply: () => {},
    close: () => {},
  }));
  const rows = menuRows(html);
  assert.equal(rows.length, 5);
  const risky = rows.filter((row) => row.includes("permission-mode-risk"));
  assert.equal(risky.length, 1);
  assert.match(risky[0]!, /aria-checked="true"/);
  assert.match(risky[0]!, /Full Access \(No Sandbox\)/);
  assert.doesNotMatch(html, /menu-note/, "every Codex mode's delivery is verified");
});
