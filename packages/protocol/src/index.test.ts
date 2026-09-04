import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTROL_PLANE_API_VERSION,
  CONTROL_PLANE_CAPABILITIES,
  CONTROL_PLANE_SERVICE,
  isControlPlaneService,
  isDurableSessionCommandErrorCode,
  LEGACY_CONTROL_PLANE_SERVICE,
  LEGACY_POLICY_HOOK_POLL_CAPABILITY_HEADER,
  POLICY_HOOK_POLL_CAPABILITY_HEADER,
  PROTOCOL_VERSION,
  providerAuthenticationReceiptCode,
  projectRunnerMessageForProtocol,
  projectSessionEventPayloadForProtocol,
  sessionNamingAgentFailureCode,
  sessionEventWireProjectionRequiredForProtocol,
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  WOLLIPOG_CONTROL_PLANE_SERVICE,
  WOLLIPOG_POLICY_HOOK_POLL_CAPABILITY_HEADER,
  normalizeSourcePath,
  parseSourceLocation,
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  BOARD_COLUMNS,
  archiveRequiresStop,
  scopeAudienceContained,
  columnForStatus,
  isTerminal,
  isSupportedAgentQuestion,
  TERMINAL_STATUSES,
  parseMessage,
  DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH,
  validateQuestionAnswers,
  validateQuestionFreeText,
  validatePromptImageInputs,
  providerSupportsConversationFork,
  mergeSessionCapabilities,
  type SessionStatus,
  type AgentCapabilities,
  type AgentDefinition,
  type AgentSlashCommand,
  type BoardColumn,
  type ControlPlaneToRunner,
  type ControlPlaneToUi,
  type CreateSessionRequest,
  type CreateRunRequest,
  type CreateWorkflowRunRequest,
  type AutomationRunnerTarget,
  type ProjectLocationView,
  type ProjectView,
  type PendingPromptView,
  type ResolveSteeringAttemptMessage,
  type ResolveSteeringAttemptResultMessage,
  type RunnerToControlPlane,
  type SteerRequest,
  type SteerSessionMessage,
  type SteerSessionResultMessage,
  type SessionView,
  type SteeringAttemptView,
  type InvokeSessionCommandMessage,
  type InvokeSessionCommandRequest,
  type SessionCommandInvocationResultMessage,
  type SessionCommandInvocationUpdateMessage,
  type SessionCommandInvocationView,
  type UiSnapshotMessage,
  type ResourceScope,
  type DurableSessionCommandErrorCode,
  type EditQueuedPromptMessage,
  type EditQueuedPromptResultMessage,
  type ReadQueuedPromptMessage,
  type ReadQueuedPromptResultMessage,
} from "./index.js";

const DURABLE_SESSION_COMMAND_ERROR_CODES = [
  "COMMAND_ID_CONFLICT",
  "COMMAND_EXPIRED",
  "INVALID_COMMAND",
  "SESSION_NOT_FOUND",
  "QUEUE_FULL",
  "COMMAND_CANCELLED",
  "PROVIDER_AUTHENTICATION_REQUIRED",
  "RECEIPT_STORE_FULL",
] as const satisfies readonly DurableSessionCommandErrorCode[];

test("durable session command error-code validation accepts protocol values and fails closed", () => {
  for (const code of DURABLE_SESSION_COMMAND_ERROR_CODES) {
    assert.equal(isDurableSessionCommandErrorCode(code), true, code);
  }
  assert.equal(isDurableSessionCommandErrorCode("UNKNOWN_CODE"), false);
  assert.equal(isDurableSessionCommandErrorCode("toString"), false, "prototype properties are not codes");
  assert.equal(isDurableSessionCommandErrorCode(null), false);
});

test("control-plane discovery accepts both service markers while emission uses Wollipog", () => {
  assert.equal(CONTROL_PLANE_API_VERSION, 1);
  assert.equal(CONTROL_PLANE_SERVICE, "wollipog-control-plane");
  assert.equal(CONTROL_PLANE_SERVICE, WOLLIPOG_CONTROL_PLANE_SERVICE);
  assert.equal(LEGACY_CONTROL_PLANE_SERVICE, "misko-agent-manager-control-plane");
  assert.equal(WOLLIPOG_CONTROL_PLANE_SERVICE, "wollipog-control-plane");
  assert.equal(isControlPlaneService(LEGACY_CONTROL_PLANE_SERVICE), true);
  assert.equal(isControlPlaneService(WOLLIPOG_CONTROL_PLANE_SERVICE), true);
  assert.equal(isControlPlaneService("other"), false);
  assert.deepEqual(CONTROL_PLANE_CAPABILITIES, ["remote-instance-v1"]);
});

test("policy-hook producers use the Wollipog header while legacy acceptance remains explicit", () => {
  assert.equal(POLICY_HOOK_POLL_CAPABILITY_HEADER, WOLLIPOG_POLICY_HOOK_POLL_CAPABILITY_HEADER);
  assert.equal(LEGACY_POLICY_HOOK_POLL_CAPABILITY_HEADER, "x-mam-hook-poll-capability");
});

/* All SessionStatus values, kept in sync with the union in index.ts. */
const ALL_STATUSES: SessionStatus[] = [
  "queued",
  "starting",
  "running",
  "input_required",
  "idle",
  "completed",
  "failed",
  "stopped",
];

/* Expected status -> column mapping, per columnForStatus. */
const EXPECTED_COLUMN: Record<SessionStatus, BoardColumn> = {
  queued: "queued",
  starting: "running",
  running: "running",
  input_required: "input_required",
  idle: "review",
  completed: "done",
  failed: "done",
  stopped: "done",
};

test("PROTOCOL_VERSION is 106", () => {
  assert.equal(PROTOCOL_VERSION, 106);
  assert.equal(RUNNER_CAPABILITY_MIN_PROTOCOL.pricedSessionCost, 106);
  assert.equal(runnerSupportsProtocol(105, "pricedSessionCost"), false);
  assert.equal(runnerSupportsProtocol(106, "pricedSessionCost"), true);
  assert.equal(RUNNER_CAPABILITY_MIN_PROTOCOL.usageEventModel, 104);
  assert.equal(runnerSupportsProtocol(103, "usageEventModel"), false);
  assert.equal(runnerSupportsProtocol(104, "usageEventModel"), true);
  assert.equal(RUNNER_CAPABILITY_MIN_PROTOCOL.usageTokenBuckets, 103);
  assert.equal(runnerSupportsProtocol(102, "usageTokenBuckets"), false);
  assert.equal(runnerSupportsProtocol(103, "usageTokenBuckets"), true);
  assert.equal(RUNNER_CAPABILITY_MIN_PROTOCOL.sessionWorktrees, 101);
  assert.equal(runnerSupportsProtocol(100, "sessionWorktrees"), false);
  assert.equal(runnerSupportsProtocol(101, "sessionWorktrees"), true);
  assert.equal(RUNNER_CAPABILITY_MIN_PROTOCOL.sessionWorktreeDiscard, 102);
  assert.equal(runnerSupportsProtocol(101, "sessionWorktreeDiscard"), false);
  assert.equal(runnerSupportsProtocol(102, "sessionWorktreeDiscard"), true);
  assert.equal(RUNNER_CAPABILITY_MIN_PROTOCOL.managedBackgroundInventory, 82);
  assert.equal(runnerSupportsProtocol(81, "managedBackgroundInventory"), false);
  assert.equal(runnerSupportsProtocol(82, "managedBackgroundInventory"), true);
});

test("v99 queued prompt editing messages preserve opaque revisions and attachments", () => {
  assert.equal(RUNNER_CAPABILITY_MIN_PROTOCOL.queuedPromptEditing, 99);
  assert.equal(runnerSupportsProtocol(98, "queuedPromptEditing"), false);
  assert.equal(runnerSupportsProtocol(99, "queuedPromptEditing"), true);

  const read = {
    type: "read_queued_prompt",
    requestId: "request-read-1",
    sessionId: "session-1",
    promptId: "prompt-1",
  } satisfies ReadQueuedPromptMessage;
  const readResult = {
    type: "read_queued_prompt_result",
    requestId: read.requestId,
    sessionId: read.sessionId,
    promptId: read.promptId,
    ok: true,
    prompt: {
      promptId: read.promptId,
      text: "Original prompt",
      images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      editRevision: "qer_opaque-generation-and-content",
    },
  } satisfies ReadQueuedPromptResultMessage;
  const edit = {
    type: "edit_queued_prompt",
    requestId: "request-edit-1",
    submissionId: "submission-edit-1",
    sessionId: read.sessionId,
    promptId: read.promptId,
    expectedRevision: readResult.prompt.editRevision,
    text: "Revised prompt",
    images: [],
  } satisfies EditQueuedPromptMessage;
  const editResult = {
    type: "edit_queued_prompt_result",
    requestId: edit.requestId,
    submissionId: edit.submissionId,
    sessionId: edit.sessionId,
    promptId: edit.promptId,
    applied: false,
    reason: "queue_item_changed",
  } satisfies EditQueuedPromptResultMessage;

  assert.deepEqual(parseMessage<ControlPlaneToRunner>(JSON.stringify(read)), read);
  assert.deepEqual(parseMessage<RunnerToControlPlane>(JSON.stringify(readResult)), readResult);
  assert.deepEqual(parseMessage<ControlPlaneToRunner>(JSON.stringify(edit)), edit);
  assert.deepEqual(parseMessage<RunnerToControlPlane>(JSON.stringify(editResult)), editResult);
});

test("session-naming agent failures distinguish harness capability from account drift", () => {
  const codex = {
    id: "codex",
    name: "Codex",
    command: "codex",
    args: [],
    env: {},
    driver: "codex-app-server",
    available: true,
    authStatus: "authenticated",
    codexAppServer: { status: "supported", appServerAvailable: true, sessionNaming: true },
  } satisfies AgentDefinition;
  const claude = {
    id: "claude-code",
    name: "Claude Code",
    command: "claude",
    args: [],
    env: {},
    driver: "claude-code",
    available: true,
    authStatus: "authenticated",
    claudeCode: {
      status: "ready",
      effortLevels: [],
      permissionModes: [],
      streamJsonInput: true,
      streamJsonImages: true,
      controlProtocol: true,
      forkSession: true,
      replayUserMessages: true,
      sessionNaming: true,
      auth: { status: "authenticated", billingSource: "subscription" },
    },
  } satisfies AgentDefinition;

  assert.equal(sessionNamingAgentFailureCode(codex), null);
  assert.equal(sessionNamingAgentFailureCode({ ...codex, available: false }), "harness_unavailable");
  assert.equal(sessionNamingAgentFailureCode({ ...codex, authStatus: "unauthenticated" }), "account_unavailable");
  assert.equal(sessionNamingAgentFailureCode({
    ...codex,
    codexAppServer: { ...codex.codexAppServer, sessionNaming: false },
  }), "harness_unavailable");
  assert.equal(sessionNamingAgentFailureCode(claude), null);
  assert.equal(sessionNamingAgentFailureCode({
    ...claude,
    claudeCode: {
      ...claude.claudeCode,
      auth: { ...claude.claudeCode.auth, status: "unauthenticated" },
    },
  }), "account_unavailable");
  assert.equal(sessionNamingAgentFailureCode({
    ...claude,
    claudeCode: { ...claude.claudeCode, sessionNaming: false },
  }), "harness_unavailable");
  assert.equal(sessionNamingAgentFailureCode({ ...codex, driver: "acp" }), "harness_unavailable");
  assert.equal(sessionNamingAgentFailureCode(undefined), "harness_unavailable");
});

test("slash-command argument hints remain additive metadata", () => {
  const current = {
    name: "review",
    source: "builtin",
    description: "Review the current changes.",
    argumentHint: "[focus]",
  } satisfies AgentSlashCommand;
  const legacy = {
    name: "compact",
    source: "builtin",
  } satisfies AgentSlashCommand;

  assert.equal(parseMessage<AgentSlashCommand>(JSON.stringify(current))?.argumentHint, "[focus]");
  assert.equal(parseMessage<AgentSlashCommand>(JSON.stringify(legacy))?.argumentHint, undefined);
});

test("v75 session commands carry opaque authorization and a distinct durable receipt lane", () => {
  const command = {
    name: "review",
    source: "project",
    description: "Review the current changes.",
    invocation: {
      id: "pci_opaque-runner-coordinate",
      catalogRevision: "pcr_opaque-catalog-revision",
      executionMode: "passthrough",
    },
  } satisfies AgentSlashCommand;
  const request = {
    submissionId: "submission-user-1",
    providerCommandId: command.invocation.id,
    catalogRevision: command.invocation.catalogRevision,
    argumentText: "focus on storage",
  } satisfies InvokeSessionCommandRequest;
  const wire = {
    type: "invoke_session_command",
    requestId: "request-attempt-1",
    invocationId: "ci_control-plane-1",
    submissionId: request.submissionId,
    payloadDigest: "a".repeat(64),
    expiresAt: 86_400_000,
    sessionId: "session-1",
    providerCommandId: request.providerCommandId,
    catalogRevision: request.catalogRevision,
    expectedExecutionMode: command.invocation.executionMode,
    argumentText: request.argumentText,
  } satisfies InvokeSessionCommandMessage;
  const accepted = {
    type: "session_command_invocation_result",
    requestId: wire.requestId,
    invocationId: wire.invocationId,
    submissionId: wire.submissionId,
    sessionId: wire.sessionId,
    state: "accepted",
    revision: 1,
    duplicate: false,
  } satisfies SessionCommandInvocationResultMessage;
  const completed = {
    type: "session_command_invocation_update",
    invocationId: wire.invocationId,
    submissionId: wire.submissionId,
    sessionId: wire.sessionId,
    state: "completed",
    revision: 4,
    userEventSeq: 42,
  } satisfies SessionCommandInvocationUpdateMessage;
  const view = {
    invocationId: wire.invocationId,
    submissionId: wire.submissionId,
    sessionId: wire.sessionId,
    providerCommandId: wire.providerCommandId,
    catalogRevision: wire.catalogRevision,
    commandName: command.name,
    argumentText: wire.argumentText,
    executionMode: wire.expectedExecutionMode,
    state: completed.state,
    revision: completed.revision,
    userEventSeq: completed.userEventSeq,
    createdAt: 1,
    updatedAt: 2,
  } satisfies SessionCommandInvocationView;

  const down: ControlPlaneToRunner = wire;
  const direct: RunnerToControlPlane = accepted;
  const update: RunnerToControlPlane = completed;
  assert.equal(parseMessage<ControlPlaneToRunner>(JSON.stringify(down))?.type, "invoke_session_command");
  assert.equal(parseMessage<RunnerToControlPlane>(JSON.stringify(direct))?.type, "session_command_invocation_result");
  assert.equal(parseMessage<RunnerToControlPlane>(JSON.stringify(update))?.type, "session_command_invocation_update");
  assert.equal(view.providerCommandId, command.invocation.id);
  assert.equal(runnerSupportsProtocol(74, "sessionCommandInvocations"), false);
  assert.equal(runnerSupportsProtocol(75, "sessionCommandInvocations"), true);
  assert.equal(runnerSupportsProtocol(75, "gitVisibility"), false);
  assert.equal(runnerSupportsProtocol(76, "gitVisibility"), true);
  assert.equal(runnerSupportsProtocol(77, "durablePromptQueueIdentity"), false);
  assert.equal(runnerSupportsProtocol(78, "durablePromptQueueIdentity"), true);
});

test("conversation steering types keep old peers optional and preserve correlated identities", () => {
  const request = {
    submissionId: "submission-1",
    turnId: "runner-turn-1",
    text: "change direction",
  } satisfies SteerRequest;
  const wire = {
    type: "steer_session",
    requestId: "request-1",
    sessionId: "session-1",
    ...request,
  } satisfies SteerSessionMessage;
  const result = {
    type: "steer_session_result",
    requestId: wire.requestId,
    submissionId: wire.submissionId,
    sessionId: wire.sessionId,
    turnId: wire.turnId,
    disposition: "accepted",
    reason: "accepted",
    providerTurnId: "provider-turn-1",
  } satisfies SteerSessionResultMessage;
  const attempt = {
    submissionId: wire.submissionId,
    turnId: wire.turnId,
    source: "direct",
    text: wire.text,
    state: result.disposition,
    reason: result.reason,
    createdAt: 1,
    updatedAt: 2,
  } satisfies SteeringAttemptView;

  assert.equal(parseMessage<SteerSessionMessage>(JSON.stringify(wire))?.submissionId, "submission-1");
  assert.equal(parseMessage<SteerSessionResultMessage>(JSON.stringify(result))?.providerTurnId, "provider-turn-1");
  assert.equal(attempt.sourceQueueId, undefined);
});

test("uncertain steering resolution remains a distinct correlated v73 exchange", () => {
  const request = {
    type: "resolve_steering_attempt",
    requestId: "resolve-request-1",
    sessionId: "session-1",
    submissionId: "submission-uncertain-1",
    action: "queue_again",
  } satisfies ResolveSteeringAttemptMessage;
  const result = {
    type: "resolve_steering_attempt_result",
    requestId: request.requestId,
    sessionId: request.sessionId,
    submissionId: request.submissionId,
    action: request.action,
    applied: true,
    queuedPromptId: "queue-new-1",
  } satisfies ResolveSteeringAttemptResultMessage;
  const outbound: ControlPlaneToRunner = request;
  const inbound: RunnerToControlPlane = result;

  assert.equal(parseMessage<ControlPlaneToRunner>(JSON.stringify(outbound))?.type, "resolve_steering_attempt");
  assert.equal(parseMessage<RunnerToControlPlane>(JSON.stringify(inbound))?.type, "resolve_steering_attempt_result");
  assert.equal(result.requestId, request.requestId);
});

test("durable pending prompts retain exact identity, state, and safe actions", () => {
  const view: PendingPromptView = {
    commandId: "prompt-1",
    text: "Run this later",
    state: "uncertain",
    revision: 4,
    attemptCount: 2,
    error: "runner disconnected after acceptance",
    createdAt: 10,
    updatedAt: 20,
    canDismiss: true,
  };
  const session = { pendingPrompts: [view] } satisfies Pick<SessionView, "pendingPrompts">;
  assert.equal(session.pendingPrompts[0]?.commandId, "prompt-1");
  assert.equal(session.pendingPrompts[0]?.state, "uncertain");
  assert.equal(session.pendingPrompts[0]?.canDismiss, true);
});

test("elicitation capabilities round-trip while legacy absence remains unknown", () => {
  const legacyCapabilities: AgentCapabilities = {
    models: [],
    effortLevels: [],
    slashCommands: [],
    supportsImages: false,
    supportsApprovals: true,
  };
  const legacy = parseMessage<{ capabilities: AgentCapabilities }>(
    JSON.stringify({ capabilities: legacyCapabilities }),
  );
  assert.equal(legacy?.capabilities.elicitation, undefined);

  const current = parseMessage<{ capabilities: AgentCapabilities }>(
    JSON.stringify({
      capabilities: {
        ...legacyCapabilities,
        elicitation: {
          default: ["stdio-control"],
          acceptEdits: ["none"],
        },
      },
    }),
  );
  assert.deepEqual(current?.capabilities.elicitation, {
    default: ["stdio-control"],
    acceptEdits: ["none"],
  });
});

test("a complete ACP session capability snapshot remains authoritative when its model list is empty", () => {
  const catalog: AgentCapabilities = {
    models: [{ id: "catalog-model", displayName: "Catalog Model", default: true }],
    effortLevels: ["high"],
    slashCommands: [],
    supportsImages: true,
    supportsApprovals: true,
  };
  const acpSession: AgentCapabilities = {
    models: [],
    effortLevels: [],
    slashCommands: [],
    supportsImages: false,
    supportsApprovals: true,
    elicitation: { default: ["acp-permission"] },
  };

  assert.deepEqual(mergeSessionCapabilities(catalog, acpSession), acpSession);
});

test("native session command overlays replace only session-scoped catalog fields", () => {
  const catalog: AgentCapabilities = {
    models: [{ id: "catalog-model", default: true }],
    effortLevels: ["high"],
    slashCommands: [{ name: "catalog", source: "builtin" }],
    supportsImages: true,
    supportsApprovals: true,
    permissionModes: ["default"],
    elicitation: { default: ["stdio-control"] },
  };
  const sessionCommands: AgentSlashCommand[] = [{
    name: "project-review",
    source: "project",
    argumentHint: "<scope>",
  }];

  assert.deepEqual(mergeSessionCapabilities(catalog, { slashCommands: sessionCommands }), {
    ...catalog,
    slashCommands: sessionCommands,
  });
  assert.deepEqual(mergeSessionCapabilities(catalog, { slashCommands: [] }), {
    ...catalog,
    slashCommands: [],
  }, "an explicit empty session list clears stale catalog commands");
  assert.deepEqual(mergeSessionCapabilities(catalog, { elicitation: { default: ["hook"] } }), {
    ...catalog,
    elicitation: { default: ["hook"] },
  }, "an absent command overlay keeps live catalog commands");
  assert.deepEqual(mergeSessionCapabilities({ ...catalog, supportsSteering: true }, { supportsSteering: false }), {
    ...catalog,
    supportsSteering: false,
  }, "an explicit runtime revocation narrows stale catalog steering support");
});

test("durable Project transport is additive to legacy snapshots and session creation", () => {
  const legacyLocation: ProjectLocationView = {
    id: "legacy-location",
    projectId: "project-1",
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    name: "Legacy Checkout",
    path: "/repos/legacy",
    source: "reported",
    availability: "available",
    isDefault: false,
    createdAt: 1,
    updatedAt: 2,
  };
  const project = {
    id: "project-1",
    name: "Project One",
    hidden: false,
    locations: [{
      id: "location-1",
      projectId: "project-1",
      runnerId: "runner-1",
      workspaceId: "workspace-1",
      name: "Checkout",
      path: "/repos/one",
      source: "reported",
      availability: "available",
      isDefault: true,
      activeSessionCount: 1,
      unarchivedSessionCount: 2,
      totalSessionCount: 3,
      createdAt: 1,
      updatedAt: 2,
    }],
    activeSessionCount: 1,
    unarchivedSessionCount: 2,
    totalSessionCount: 3,
    createdAt: 1,
    updatedAt: 2,
  } satisfies ProjectView;
  const legacy: UiSnapshotMessage = {
    type: "snapshot",
    runners: [],
    boxes: [],
    sessions: [],
    runs: [],
  };
  const current = {
    ...legacy,
    capabilities: { projects: true },
    projects: [project],
  } satisfies UiSnapshotMessage;
  const messages: ControlPlaneToUi[] = [
    { type: "project_upsert", project },
    { type: "project_removed", projectId: project.id },
  ];
  const legacyCreate: CreateSessionRequest = {
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    agentId: "agent-1",
  };
  const projectCreate = {
    ...legacyCreate,
    projectId: project.id,
    projectLocationId: project.locations[0]!.id,
  } satisfies CreateSessionRequest;
  const projectRun = {
    runnerId: "runner-1", workspaceId: "workspace-1", projectId: project.id,
    projectLocationId: project.locations[0]!.id, agentIds: ["agent-1"], task: "Build",
  } satisfies CreateRunRequest;
  const projectWorkflow = {
    runnerId: "runner-1", workspaceId: "workspace-1", projectId: project.id,
    projectLocationId: project.locations[0]!.id, workflowId: "workflow-1", task: "Build",
  } satisfies CreateWorkflowRunRequest;
  const alternateTarget = {
    runnerId: "runner-2", workspaceId: "workspace-2", projectId: project.id,
    projectLocationId: "location-2", agentId: "agent-1",
  } satisfies AutomationRunnerTarget;

  assert.equal(legacy.projects, undefined);
  assert.equal(legacyLocation.totalSessionCount, undefined, "older Location payloads remain valid");
  assert.equal(current.projects?.[0]?.id, "project-1");
  assert.deepEqual(current.projects?.[0]?.locations[0] && {
    active: current.projects[0].locations[0].activeSessionCount,
    unarchived: current.projects[0].locations[0].unarchivedSessionCount,
    total: current.projects[0].locations[0].totalSessionCount,
  }, { active: 1, unarchived: 2, total: 3 });
  assert.deepEqual(messages.map((message) => message.type), ["project_upsert", "project_removed"]);
  assert.equal(legacyCreate.projectId, undefined);
  assert.equal(projectCreate.projectLocationId, "location-1");
  assert.equal(projectRun.projectId, "project-1");
  assert.equal(projectWorkflow.projectLocationId, "location-1");
  assert.equal(alternateTarget.projectLocationId, "location-2");
});

test("provider conversation fork gate preserves Codex compatibility and requires Claude proof", () => {
  assert.equal(providerSupportsConversationFork("codex-app-server"), true);
  assert.equal(providerSupportsConversationFork("codex"), false);
  assert.equal(providerSupportsConversationFork("claude-code"), false);
  const capabilities = {
    models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: false,
    supportsConversationFork: true,
  };
  assert.equal(providerSupportsConversationFork("claude-code", capabilities), true);
  assert.equal(providerSupportsConversationFork("acp", capabilities), false);
});

test("runner command capability gates fail closed for unknown/old protocols", () => {
  assert.equal(RUNNER_CAPABILITY_MIN_PROTOCOL.externalSessions, 6);
  assert.equal(RUNNER_CAPABILITY_MIN_PROTOCOL.sessionFiles, 16);
  assert.equal(runnerSupportsProtocol(11, "richDiff"), false);
  assert.equal(runnerSupportsProtocol(12, "richDiff"), true);
  assert.equal(runnerSupportsProtocol(12, "hunkStaging"), false);
  assert.equal(runnerSupportsProtocol(13, "hunkStaging"), true);
  assert.equal(runnerSupportsProtocol(49, "fineGrainedDiff"), false);
  assert.equal(runnerSupportsProtocol(50, "fineGrainedDiff"), true);
  assert.equal(runnerSupportsProtocol(50, "githubReviewReconciliation"), false);
  assert.equal(runnerSupportsProtocol(51, "githubReviewReconciliation"), true);
  assert.equal(runnerSupportsProtocol(51, "podReconciliation"), false);
  assert.equal(runnerSupportsProtocol(52, "podReconciliation"), true);
  assert.equal(runnerSupportsProtocol(52, "automationCommandReceipts"), false);
  assert.equal(runnerSupportsProtocol(53, "automationCommandReceipts"), true);
  assert.equal(runnerSupportsProtocol(53, "runnerLocalAgentEnv"), false);
  assert.equal(runnerSupportsProtocol(54, "runnerLocalAgentEnv"), true);
  assert.equal(runnerSupportsProtocol(54, "indexedHistory"), false);
  assert.equal(runnerSupportsProtocol(55, "indexedHistory"), true);
  assert.equal(runnerSupportsProtocol(55, "promptImageReferences"), false);
  assert.equal(runnerSupportsProtocol(56, "promptImageReferences"), true);
  assert.equal(runnerSupportsProtocol(56, "durableSessionShells"), false);
  assert.equal(runnerSupportsProtocol(57, "durableSessionShells"), true);
  assert.equal(runnerSupportsProtocol(62, "codexAppServerExternalSessions"), false);
  assert.equal(runnerSupportsProtocol(63, "codexAppServerExternalSessions"), true);
  assert.equal(runnerSupportsProtocol(58, "editorLocations"), false);
  assert.equal(runnerSupportsProtocol(59, "editorLocations"), true);
  assert.equal(RUNNER_CAPABILITY_MIN_PROTOCOL.sessionShells, 17);
  assert.equal(runnerSupportsProtocol(null, "externalSessions"), false);
  assert.equal(runnerSupportsProtocol(5, "externalSessions"), false);
  assert.equal(runnerSupportsProtocol(6, "externalSessions"), true);
  assert.equal(runnerSupportsProtocol(16, "sessionShells"), false);
  assert.equal(runnerSupportsProtocol(17, "sessionShells"), true);
  assert.equal(runnerSupportsProtocol(21, "hostActions"), false);
  assert.equal(runnerSupportsProtocol(22, "hostActions"), true);
  assert.equal(runnerSupportsProtocol(33, "acpLogout"), false);
  assert.equal(runnerSupportsProtocol(34, "acpLogout"), true);
  assert.equal(runnerSupportsProtocol(37, "acpSessionContext"), false);
  assert.equal(runnerSupportsProtocol(38, "acpSessionContext"), true);
  assert.equal(runnerSupportsProtocol(39, "acpRegistryApproval"), false);
  assert.equal(runnerSupportsProtocol(40, "acpRegistryApproval"), true);
  assert.equal(runnerSupportsProtocol(70, "turnInterruption"), false);
  assert.equal(runnerSupportsProtocol(71, "turnInterruption"), true);
  assert.equal(runnerSupportsProtocol(72, "conversationSteering"), false);
  assert.equal(runnerSupportsProtocol(73, "conversationSteering"), true);
  assert.equal(runnerSupportsProtocol(77, "providerAuthenticationReceipts"), false);
  assert.equal(runnerSupportsProtocol(78, "providerAuthenticationReceipts"), false);
  assert.equal(runnerSupportsProtocol(79, "providerAuthenticationReceipts"), true);
  assert.equal(providerAuthenticationReceiptCode(undefined), "COMMAND_CANCELLED");
  assert.equal(providerAuthenticationReceiptCode(77), "COMMAND_CANCELLED");
  assert.equal(providerAuthenticationReceiptCode(78), "COMMAND_CANCELLED");
  assert.equal(providerAuthenticationReceiptCode(79), "PROVIDER_AUTHENTICATION_REQUIRED");
  assert.equal(runnerSupportsProtocol(78, "subscriptionUsage"), false);
  assert.equal(runnerSupportsProtocol(79, "subscriptionUsage"), false);
  assert.equal(runnerSupportsProtocol(80, "subscriptionUsage"), true);
  assert.equal(runnerSupportsProtocol(80, "managedBackgroundDelivery"), false);
  assert.equal(runnerSupportsProtocol(81, "managedBackgroundDelivery"), false);
  assert.equal(runnerSupportsProtocol(82, "managedBackgroundDelivery"), true);
  assert.equal(runnerSupportsProtocol(81, "backgroundWorkTracking"), false);
  assert.equal(runnerSupportsProtocol(82, "backgroundWorkTracking"), false);
  assert.equal(runnerSupportsProtocol(83, "backgroundWorkTracking"), true);
  assert.equal(runnerSupportsProtocol(83, "correlatedRestartEcho"), false);
  assert.equal(runnerSupportsProtocol(84, "correlatedRestartEcho"), true);
  assert.equal(runnerSupportsProtocol(84, "stopFailureRecovery"), false);
  assert.equal(runnerSupportsProtocol(85, "stopFailureRecovery"), true);
  assert.equal(runnerSupportsProtocol(88, "stopAttemptCorrelation"), false);
  assert.equal(runnerSupportsProtocol(89, "stopAttemptCorrelation"), true);
  assert.equal(runnerSupportsProtocol(89, "agentSkills"), false);
  assert.equal(runnerSupportsProtocol(90, "agentSkills"), true);
  assert.equal(runnerSupportsProtocol(92, "sessionAgentNaming"), false);
  assert.equal(runnerSupportsProtocol(93, "sessionAgentNaming"), true);
  assert.equal(runnerSupportsProtocol(93, "sessionCustomModelNaming"), false);
  assert.equal(runnerSupportsProtocol(94, "sessionCustomModelNaming"), true);
  assert.equal(runnerSupportsProtocol(94, "sessionNamingTargets"), false);
  assert.equal(runnerSupportsProtocol(95, "sessionNamingTargets"), true);
  assert.equal(runnerSupportsProtocol(95, "skillLinkRemovalReporting"), false);
  assert.equal(runnerSupportsProtocol(96, "skillLinkRemovalReporting"), true);
  assert.equal(runnerSupportsProtocol(96, "sessionNamingDriftCodes"), false);
  assert.equal(runnerSupportsProtocol(97, "sessionNamingDriftCodes"), true);
  assert.equal(runnerSupportsProtocol(Number.NaN, "externalSessions"), false);
  assert.equal(runnerSupportsProtocol(6.5, "externalSessions"), false);
  assert.match(runnerCapabilityRequirement(null, "sessionFiles", "Files"), /unknown.*requires protocol v16/i);
  assert.match(runnerCapabilityRequirement(15, "sessionFiles", "Files"), /protocol is v15.*v16/i);
  assert.match(runnerCapabilityRequirement(Number.NaN, "sessionFiles", "Files"), /unknown.*v16/i);
});

test("provider-authentication receipts are projected for the peer only at send time", () => {
  const exact: RunnerToControlPlane = {
    type: "durable_session_command_update",
    commandId: "command-1",
    sessionId: "session-1",
    state: "rejected",
    revision: 2,
    code: "PROVIDER_AUTHENTICATION_REQUIRED",
  };
  const oldPeer = projectRunnerMessageForProtocol(exact, 77);
  const queuedPromptPeer = projectRunnerMessageForProtocol(exact, 78);
  const currentPeer = projectRunnerMessageForProtocol(exact, 79);
  assert.equal(oldPeer.type === "durable_session_command_update" ? oldPeer.code : undefined, "COMMAND_CANCELLED");
  assert.equal(
    queuedPromptPeer.type === "durable_session_command_update" ? queuedPromptPeer.code : undefined,
    "COMMAND_CANCELLED",
  );
  assert.equal(
    currentPeer.type === "durable_session_command_update" ? currentPeer.code : undefined,
    "PROVIDER_AUTHENTICATION_REQUIRED",
  );
  assert.equal(exact.type === "durable_session_command_update" ? exact.code : undefined,
    "PROVIDER_AUTHENTICATION_REQUIRED", "the buffered runner message retains exact local truth");
});

test("additive session-event kinds use explicit older-peer policies without mutating local truth", () => {
  const completion = { kind: "agent_response_completed" } as const;
  assert.equal(projectSessionEventPayloadForProtocol(completion, 86), null);
  assert.equal(projectSessionEventPayloadForProtocol(completion, undefined), null);
  assert.equal(projectSessionEventPayloadForProtocol(completion, 87), completion);
  assert.equal(sessionEventWireProjectionRequiredForProtocol(undefined), true);
  assert.equal(sessionEventWireProjectionRequiredForProtocol(86), true);
  assert.equal(sessionEventWireProjectionRequiredForProtocol(87), false);

  const required = { kind: "error", message: "still required" } as const;
  assert.equal(projectSessionEventPayloadForProtocol(required, 1), required,
    "event kinds without an omission policy fail closed by remaining exact on the wire");
  assert.deepEqual(completion, { kind: "agent_response_completed" },
    "wire projection never rewrites runner-local event history");
});

test("source locations normalize canonical root-relative paths and reject escapes", () => {
  assert.equal(normalizeSourcePath("src\\./components//App.tsx"), "src/components/App.tsx");
  for (const path of ["", "/etc/passwd", "C:\\repo\\a.ts", "../a.ts", "a/../../b", "a\0b", "a\nb"]) {
    assert.equal(normalizeSourcePath(path), null, path);
  }
  assert.equal(normalizeSourcePath("a".repeat(4096)), "a".repeat(4096));
  assert.equal(normalizeSourcePath("a".repeat(4097)), null);
});

test("source location parsing is strict, bounded, and symbol-optional", () => {
  assert.deepEqual(parseSourceLocation({ path: "src\\a.ts", line: 4, column: 2, symbol: "run" }), {
    path: "src/a.ts", line: 4, column: 2, symbol: "run",
  });
  assert.deepEqual(parseSourceLocation({ path: "src/a.ts" }, false), { path: "src/a.ts" });
  for (const value of [
    null,
    { path: "../a" },
    { path: "a", line: 0 },
    { path: "a", line: 1.5 },
    { path: "a", column: 2 },
    { path: "a", symbol: "" },
    { path: "a", symbol: "x".repeat(257) },
    { path: "a", extra: true },
    Object.create({ path: "a", line: 1 }),
  ]) assert.equal(parseSourceLocation(value), null);
  assert.equal(parseSourceLocation({ path: "a", symbol: "run" }, false), null);
});

test("prompt image references require bounded canonical integrity metadata", () => {
  const valid = {
    artifactId: "art_123",
    mimeType: "image/png",
    sizeBytes: 42,
    sha256: "a".repeat(64),
  };
  assert.deepEqual(validatePromptImageInputs([valid]), { ok: true });
  assert.match(validatePromptImageInputs([{ ...valid, sha256: "A".repeat(64) }]).error ?? "", /SHA-256/);
  assert.match(validatePromptImageInputs([{ ...valid, sizeBytes: 0 }]).error ?? "", /byte length/);
  assert.match(validatePromptImageInputs([{ ...valid, mimeType: "text/plain" }]).error ?? "", /unsupported MIME/);
  assert.match(validatePromptImageInputs([{ ...valid, data: "hidden-base64" } as never]).error ?? "", /unsupported fields/);
  assert.match(validatePromptImageInputs([null as never]).error ?? "", /malformed/);
});

test("columnForStatus maps every SessionStatus to the expected column", () => {
  for (const status of ALL_STATUSES) {
    assert.equal(
      columnForStatus(status),
      EXPECTED_COLUMN[status],
      `status ${status} should map to ${EXPECTED_COLUMN[status]}`,
    );
  }
});

test("columnForStatus only ever returns columns declared in BOARD_COLUMNS", () => {
  const boardIds = new Set(BOARD_COLUMNS.map((c) => c.id));
  for (const status of ALL_STATUSES) {
    assert.ok(
      boardIds.has(columnForStatus(status)),
      `${columnForStatus(status)} must be a declared board column`,
    );
  }
});

test("starting and running share the running column", () => {
  assert.equal(columnForStatus("starting"), columnForStatus("running"));
  assert.equal(columnForStatus("starting"), "running");
});

test("completed, failed and stopped all collapse into done", () => {
  assert.equal(columnForStatus("completed"), "done");
  assert.equal(columnForStatus("failed"), "done");
  assert.equal(columnForStatus("stopped"), "done");
});

test("TERMINAL_STATUSES is exactly completed/failed/stopped", () => {
  assert.deepEqual([...TERMINAL_STATUSES].sort(), ["completed", "failed", "stopped"]);
});

test("isTerminal agrees with TERMINAL_STATUSES for every status", () => {
  for (const status of ALL_STATUSES) {
    assert.equal(
      isTerminal(status),
      TERMINAL_STATUSES.includes(status),
      `isTerminal(${status}) should match membership in TERMINAL_STATUSES`,
    );
  }
});

test("isTerminal is true for terminal statuses", () => {
  assert.equal(isTerminal("completed"), true);
  assert.equal(isTerminal("failed"), true);
  assert.equal(isTerminal("stopped"), true);
});

test("isTerminal is false for non-terminal statuses", () => {
  for (const status of ["queued", "starting", "running", "input_required", "idle"] as SessionStatus[]) {
    assert.equal(isTerminal(status), false, `${status} should not be terminal`);
  }
});

test("archive requires a confirmed stop for every non-terminal lifecycle", () => {
  for (const status of ALL_STATUSES) {
    assert.equal(
      archiveRequiresStop(status),
      ["queued", "starting", "running", "input_required", "idle"].includes(status),
      status,
    );
  }
});

test("BOARD_COLUMNS covers exactly the set of columns columnForStatus can return", () => {
  const produced = new Set(ALL_STATUSES.map(columnForStatus));
  const declared = new Set(BOARD_COLUMNS.map((c) => c.id));
  // Every column columnForStatus produces must be declared.
  for (const col of produced) {
    assert.ok(declared.has(col), `${col} produced by columnForStatus must be declared`);
  }
  // The declared set is exactly { queued, running, input_required, review, done }.
  assert.deepEqual(
    [...declared].sort(),
    ["done", "input_required", "queued", "review", "running"],
  );
});

test("BOARD_COLUMNS has unique ids and non-empty titles", () => {
  const ids = BOARD_COLUMNS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "column ids must be unique");
  for (const c of BOARD_COLUMNS) {
    assert.ok(c.title.length > 0, `column ${c.id} must have a title`);
  }
});

test("parseMessage returns the parsed object for valid JSON", () => {
  const parsed = parseMessage<{ type: string; n: number }>('{"type":"heartbeat","n":7}');
  assert.deepEqual(parsed, { type: "heartbeat", n: 7 });
});

test("parseMessage parses JSON primitives and arrays", () => {
  assert.equal(parseMessage<number>("42"), 42);
  assert.equal(parseMessage<boolean>("true"), true);
  assert.equal(parseMessage<null>("null"), null);
  assert.deepEqual(parseMessage<number[]>("[1,2,3]"), [1, 2, 3]);
});

test("parseMessage returns null for invalid JSON and never throws", () => {
  for (const bad of ["", "not json", "{", "{type:1}", "undefined", "{ \"a\": }"]) {
    let result: unknown;
    assert.doesNotThrow(() => {
      result = parseMessage(bad);
    });
    assert.equal(result, null, `${JSON.stringify(bad)} should parse to null`);
  }
});

test("validateQuestionAnswers accepts valid, empty (dismiss), rejects unknown/unoffered/wrong-shape", () => {
  const questions = [
    { id: "Lang?", question: "Lang?", options: [{ label: "TS" }, { label: "Py" }] },
    { id: "Feats?", question: "Feats?", multiSelect: true, options: [{ label: "Auth" }, { label: "API" }] },
  ];
  assert.equal(validateQuestionAnswers(questions, {}), null); // dismiss
  assert.equal(validateQuestionAnswers(questions, { "Lang?": "TS", "Feats?": ["Auth", "API"] }), null);
  assert.match(validateQuestionAnswers(questions, { "Nope?": "TS" })!, /unknown question/);
  assert.match(validateQuestionAnswers(questions, { "Lang?": "Rust", "Feats?": ["Auth"] })!, /offered/);
  assert.match(validateQuestionAnswers(questions, { "Lang?": ["TS"], "Feats?": ["Auth"] } as never)!, /offered label/);
  assert.match(validateQuestionAnswers(questions, { "Lang?": "TS", "Feats?": "Auth" } as never)!, /array/);
  assert.match(validateQuestionAnswers(questions, { "Lang?": "TS" })!, /missing answer/);
});

test("the normalized question contract rejects multi-select Other responses but remains dismissible", () => {
  const unsupported = {
    id: "features",
    question: "Choose features or add another",
    multiSelect: true,
    allowOther: true,
    options: [{ label: "Audit" }],
  };

  assert.equal(isSupportedAgentQuestion(unsupported), false);
  assert.match(
    validateQuestionAnswers([unsupported], { features: ["Audit"] }, "submit")!,
    /cannot combine multi-select and Other responses/,
  );
  assert.equal(validateQuestionAnswers([unsupported], {}, "dismiss"), null);
});

test("validateQuestionAnswers: duplicate multi-select labels + prototype-chain ids are rejected", () => {
  const multi = [{ id: "Feats?", question: "Feats?", multiSelect: true, options: [{ label: "Auth" }, { label: "API" }] }];
  assert.match(validateQuestionAnswers(multi, { "Feats?": ["Auth", "Auth"] })!, /duplicate/);

  // An agent-controlled id like "constructor" must not satisfy the missing-answer check via
  // the prototype chain.
  const proto = [
    { id: "Lang?", question: "Lang?", options: [{ label: "TS" }] },
    { id: "constructor", question: "constructor", options: [{ label: "X" }] },
  ];
  assert.match(validateQuestionAnswers(proto, { "Lang?": "TS" })!, /missing answer/);
  assert.equal(validateQuestionAnswers(proto, { "Lang?": "TS", constructor: "X" }), null);
});

test("validateQuestionAnswers accepts bounded free text and optional provider form fields", () => {
  const questions = [
    { id: "name", question: "Name", options: [], allowOther: true, minLength: 2, maxLength: 8 },
    { id: "count", question: "Count", options: [], allowOther: true, inputFormat: "integer" as const, minimum: 1, maximum: 4 },
    { id: "note", question: "Note", options: [], allowOther: true, required: false },
  ];
  assert.equal(validateQuestionAnswers(questions, { name: "Ada", count: "3" }), null);
  assert.match(validateQuestionAnswers(questions, {}, "submit")!, /missing answer/);
  assert.equal(validateQuestionAnswers(questions, {}, "dismiss"), null);
  assert.match(validateQuestionAnswers(questions, { name: "Ada", count: "3" }, "dismiss")!, /dismissal/);
  assert.match(validateQuestionAnswers(questions, { name: "A", count: "3" })!, /at least 2/);
  assert.match(validateQuestionAnswers(questions, { name: "Ada", count: "3.5" })!, /valid integer/);
  assert.match(validateQuestionAnswers(questions, { name: "Ada", count: "5" })!, /above its maximum/);
});

test("free-text validation bounds answers when the provider declares no maxLength", () => {
  const question = { id: "note", question: "Note", options: [], allowOther: true };
  const atLimit = "n".repeat(DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH);
  assert.equal(validateQuestionFreeText(question, atLimit), null);
  assert.match(
    validateQuestionFreeText(question, `${atLimit}n`)!,
    new RegExp(`at most ${DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH} character`),
  );
  assert.match(
    validateQuestionAnswers([question], { note: `${atLimit}n` })!,
    new RegExp(`at most ${DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH} character`),
  );
  // A provider-declared bound still wins when it is present.
  const bounded = { ...question, maxLength: 8 };
  assert.match(validateQuestionFreeText(bounded, "n".repeat(9))!, /at most 8 character/);
});

test("validateQuestionAnswers enforces provider primitive formats", () => {
  const question = (id: string, inputFormat: "email" | "url" | "date" | "date-time") => [{
    id,
    question: id,
    options: [],
    allowOther: true,
    inputFormat,
  }];
  assert.equal(validateQuestionAnswers(question("email", "email"), { email: "ada@example.com" }), null);
  assert.match(validateQuestionAnswers(question("email", "email"), { email: "not-an-email" })!, /email address/);
  assert.equal(validateQuestionAnswers(question("url", "url"), { url: "urn:example:wollipog" }), null);
  assert.match(validateQuestionAnswers(question("url", "url"), { url: "not a uri" })!, /valid URI/);
  assert.equal(validateQuestionAnswers(question("date", "date"), { date: "2024-02-29" }), null);
  assert.match(validateQuestionAnswers(question("date", "date"), { date: "2024-02-30" })!, /valid date/);
  assert.equal(validateQuestionAnswers(question("date-time", "date-time"), { "date-time": "2026-08-22T12:30" }), null);
  assert.match(validateQuestionAnswers(question("date-time", "date-time"), { "date-time": "tomorrowish" })!, /date and time/);
});

test("validateQuestionAnswers enforces provider multi-select cardinality", () => {
  const questions = [{
    id: "features",
    question: "Features",
    multiSelect: true,
    options: [{ label: "A" }, { label: "B" }, { label: "C" }],
    minSelections: 2,
    maxSelections: 2,
  }];
  assert.equal(validateQuestionAnswers(questions, { features: ["A", "B"] }), null);
  assert.match(validateQuestionAnswers(questions, { features: ["A"] })!, /at least 2/);
  assert.match(validateQuestionAnswers(questions, { features: ["A", "B", "C"] })!, /at most 2/);
});

const scopeOrganization = (id = "org"): ResourceScope => ({
  organizationId: id,
  owner: { kind: "organization", organizationId: id },
});
const scopeUser = (id: string, organizationId = "org"): ResourceScope => ({
  organizationId,
  owner: { kind: "user", userId: id },
});
const scopeTeam = (id: string, organizationId = "org"): ResourceScope => ({
  organizationId,
  owner: { kind: "team", teamId: id },
});

test("scope audience containment is conservative and organization-bounded", () => {
  const cases: Array<[string, ResourceScope, ResourceScope, boolean]> = [
    ["organization to same organization", scopeOrganization(), scopeOrganization(), true],
    ["user to organization", scopeUser("one"), scopeOrganization(), true],
    ["team to organization", scopeTeam("one"), scopeOrganization(), true],
    ["user to same user", scopeUser("one"), scopeUser("one"), true],
    ["user to different user", scopeUser("one"), scopeUser("two"), false],
    ["team to same team", scopeTeam("one"), scopeTeam("one"), true],
    ["team to different team", scopeTeam("one"), scopeTeam("two"), false],
    ["user to team", scopeUser("one"), scopeTeam("one"), false],
    ["team to user", scopeTeam("one"), scopeUser("one"), false],
    ["different organization", scopeUser("one", "other"), scopeOrganization(), false],
  ];
  for (const [name, narrower, wider, expected] of cases) {
    assert.equal(scopeAudienceContained(narrower, wider), expected, name);
  }
});
