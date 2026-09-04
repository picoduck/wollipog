/**
 * Control-plane persistence, backed by `node:sqlite` (built into Node >=22.5).
 * Using the built-in driver means there is no native module to compile — the
 * whole dependency tree stays prebuilt / pure-JS, which matters on Windows ARM64.
 */

import { DatabaseSync } from "node:sqlite";
import { priceUsage, resolveCostSource, type RateTable } from "./usage-pricing.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  FileArtifactBlobStore,
  MemoryArtifactBlobStore,
  artifactBlobSha256,
  assertArtifactBlobKey,
  defaultArtifactBlobRoot,
  type ArtifactBlobStore,
} from "./artifact-blob-store.js";
import {
  cleanupEventPayloadArtifacts,
  externalizeSessionEventPayload,
} from "./event-payloads.js";
import {
  EVENT_PAYLOAD_CHUNK_BYTES,
  EVENT_PAYLOAD_PREVIEW_BYTES,
  columnForStatus,
  isPolicyApproval,
  isTerminal,
  runnerSupportsProtocol,
  scopeAudienceContained,
  validatePromptImageInputs,
  type AutomationAuditEvent,
  type AccessScopeChangePreview,
  type AccessScopeAuditView,
  type ArchiveStatus,
  type ArchiveStopFailureCode,
  type AutomationAuditEventKind,
  type AutomationCommandState,
  type AutomationCommandView,
  type AutomationExecution,
  type AutomationExecutionStatus,
  type AutomationSchedule,
  type AutomationSpec,
  type AutomationTriggerInvocationState,
  type AutomationTriggerInvocationView,
  type AutomationTriggerKind,
  type AutomationTriggerView,
  type AgentCapabilities,
  type AgentHarnessDefaultConfig,
  type AgentHarnessIdentity,
  type BackgroundDeliveryView,
  type BackgroundDeliveryWatchdogState,
  type BackgroundNotificationReceiptState,
  type BackgroundNotificationReceiptView,
  type BackgroundWorkState,
  type BackgroundWorkTracking,
  type ManagedBackgroundJobSnapshot,
  type ManagedBackgroundJobView,
  MANAGED_BACKGROUND_JOB_VIEW_LIMIT,
  type SessionCapabilities,
  type StopOperationView,
  type AcpSessionContextConfig,
  type ApprovalQueueProvenance,
  type DeployedSkillState,
  type SkillFile,
  type SkillInvocationPolicy,
  type SkillLinkRemoval,
  type UnmanagedSkillInfo,
  type AgentContext,
  type AgentDefinition,
  type AgentDriverKind,
  type EditorInfo,
  type ExecutionHandoffRequest,
  type ExecutionHandoffReceipt,
  type ExecutionTargetDefinition,
  type ExecutionTargetRef,
  type GovernanceAuditEntry,
  type GovernanceActor,
  type GovernancePolicy,
  type InvokeSessionCommandMessage,
  type DriverTelemetryMessage,
  type DurableSessionCommandErrorCode,
  type BoardColumn,
  type BoxStatus,
  type BoxView,
  type DeviceView,
  type IdentityAdministrationView,
  type IdentityContextView,
  type MutationAuditView,
  type OrganizationMembershipView,
  type OrganizationRole,
  type OrganizationView,
  type TeamView,
  type TranscriptShareView,
  type UsageAggregationGranularity,
  type UsageAggregationResponse,
  type UsageAmount,
  type SessionModelUsage,
  type UsageDailyBudgetPolicy,
  type UserCostWindows,
  type UsageRetentionPolicy,
  type SubscriptionUsageResponse,
  type SubscriptionUsageSnapshot,
  type UserStatus,
  type OS,
  type PendingApproval,
  type PromptImageReference,
  type PromptSessionMessage,
  type ProjectLocationAvailability,
  type ProjectLocationSource,
  type ProjectLocationView,
  type ProjectView,
  type PodContextEntry,
  type PodMemberRole,
  type PodOrchestrationPolicy,
  type PodOrchestrationStep,
  type PodOrchestrationView,
  type PodReconciliation,
  type PodView,
  type RunnerMetadata,
  type RunnerCredentialView,
  type RunnerStatus,
  type RunnerView,
  type ResourceScope,
  type ReviewFinding,
  type ReviewFindingStatus,
  type ReviewFindingSummary,
  type GitHubReviewReconciliation,
  type GitHubReviewSyncInfo,
  type RunView,
  type SessionConfig,
  type SessionCommandExecutionMode,
  type SessionCommandInvocationErrorCode,
  type SessionCommandInvocationResultMessage,
  type SessionCommandInvocationState,
  type SessionCommandInvocationUpdateMessage,
  type SessionCommandInvocationView,
  type PendingPromptView,
  type SessionEvent,
  type SessionEventPayload,
  type SessionSnapshot,
  type SessionStatus,
  type SessionNamingAccountBoundary,
  type SessionNamingHarnessOption,
  type SessionReminderView,
  type SessionReminderWakePolicy,
  type SessionReminderWakeReason,
  type SessionTitleSource,
  type SessionView,
  type SessionWorktreeView,
  type QueuedPromptView,
  type SteerDisposition,
  type SteerResultReason,
  type SteeringAttemptSource,
  type SteeringAttemptView,
  type SteerSessionResultMessage,
  type ResolveSteeringAttemptMessage,
  type ResolveSteeringAttemptResultMessage,
  type SteerSessionMessage,
  type ShellHistoryPage,
  type ShellKind,
  type ShellOutputChunk,
  type ShellSnapshotMessage,
  type ShellStatus,
  type ShellView,
  type WorkspaceInfo,
  type WorkflowArtifact,
  type WorkflowArtifactView,
  type WorkflowAttemptView,
  type WorkflowAttemptStatus,
  type WorkflowDefinition,
  type WorkflowEventView,
  type WorkflowInstanceDetail,
  type WorkflowInstanceStatus,
  type WorkflowInstanceView,
  type WorkflowNodeState,
  type WorkflowNodeOutcome,
} from "@wollipog/protocol";
import { DEFAULT_POD_ORCHESTRATION_POLICY, type PodContextSelectionWindow } from "./pod-orchestration.js";
import {
  LOCAL_OWNER_USER_ID,
  PERSONAL_ORGANIZATION_ID,
  type AuthPrincipal,
  type HumanPrincipal,
} from "./identity.js";
import {
  ARCHIVE_SESSION_PAGE_SIZE,
  archiveSessionCursorWindow,
  type ArchiveSessionCandidate,
  type ArchiveSessionPageQuery,
} from "./archive-session-page.js";
import type { DurableBackgroundPushDelivery, PushAudience, PushServiceOutcome } from "./web-push.js";
import { matchWorkspaceId, matchWorkspaceIds, workspacePathsEqual } from "./workspace-match.js";
import {
  executionTargetsForHost,
  executionTargetsForRunner,
  validateExecutionHandoffReceipt,
  validateExecutionHandoffRequest,
  validateRunnerCloudTargets,
  validateRunnerContainerTargets,
} from "./execution-targets.js";

export const GOVERNANCE_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60_000;
export const MAX_PROJECTED_STEERING_ATTEMPTS = 50;
export const MAX_UNRESOLVED_STEERING_ATTEMPTS = 50;
export const MAX_PENDING_STEERING_RESOLUTION_REPLAYS = 50;
const SESSION_PROMPT_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
const SESSION_PROMPT_ATTEMPT_RETENTION_LIMIT = 128;

const ARTIFACT_TABLE_SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS artifacts (
  id              TEXT PRIMARY KEY,
  run_id          TEXT,
  session_id      TEXT,
  kind            TEXT NOT NULL,
  name            TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  encoding        TEXT NOT NULL,
  data            TEXT NOT NULL,
  blob_key        TEXT,
  size_bytes      INTEGER NOT NULL,
  sha256          TEXT NOT NULL,
  created_by_kind TEXT NOT NULL,
  created_by_id   TEXT,
  metadata        TEXT,
  created_at      INTEGER NOT NULL,
  CHECK (run_id IS NOT NULL OR session_id IS NOT NULL),
  FOREIGN KEY (run_id) REFERENCES multi_agent_runs(id) ON DELETE CASCADE
);
`;
const ARTIFACT_INDEX_SCHEMA = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, created_at, id);
`;
const STEERING_OWNED_PROMPT_IMAGE_SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS steering_owned_prompt_image_artifacts (
  artifact_id TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
);
`;
const PREPARED_PROMPT_IMAGE_SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS prepared_prompt_image_artifacts (
  artifact_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE,
  UNIQUE (session_id, mime_type, size_bytes, sha256)
);
CREATE INDEX IF NOT EXISTS idx_prepared_prompt_image_expiry
  ON prepared_prompt_image_artifacts(expires_at, artifact_id);
`;
const ARTIFACT_BLOB_SCHEMA = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_artifacts_blob_key ON artifacts(blob_key);
CREATE TABLE IF NOT EXISTS artifact_blob_pending (
  blob_key   TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS artifact_blob_gc (
  blob_key   TEXT PRIMARY KEY,
  queued_at  INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS artifacts_blob_gc_after_delete
AFTER DELETE ON artifacts WHEN OLD.blob_key IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO artifact_blob_gc (blob_key, queued_at)
  VALUES (OLD.blob_key, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;
`;
const WORKFLOW_ATTEMPT_ARTIFACT_COLUMNS = /* sql */ `(
  attempt_id TEXT NOT NULL,
  contract_name TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  PRIMARY KEY (attempt_id, contract_name),
  FOREIGN KEY (attempt_id) REFERENCES workflow_attempts(attempt_id) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id)
)`;
const STEERING_ATTEMPT_ARTIFACT_COLUMNS = /* sql */ `(
  request_id  TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  PRIMARY KEY (request_id, artifact_id),
  FOREIGN KEY (request_id) REFERENCES session_steering_attempts(request_id) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
)`;
const SESSION_EVENT_ARTIFACT_COLUMNS = /* sql */ `(
  event_id    INTEGER NOT NULL,
  artifact_id TEXT NOT NULL,
  PRIMARY KEY (event_id, artifact_id),
  FOREIGN KEY (event_id) REFERENCES session_events(id) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
)`;
const SESSION_EVENT_ARTIFACT_REFERENCE_SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS session_event_artifacts ${SESSION_EVENT_ARTIFACT_COLUMNS};
CREATE INDEX IF NOT EXISTS idx_session_event_artifacts_event
  ON session_event_artifacts(event_id, artifact_id);
CREATE INDEX IF NOT EXISTS idx_session_event_artifacts_artifact
  ON session_event_artifacts(artifact_id, event_id);
CREATE TABLE IF NOT EXISTS session_event_artifact_reference_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  backfilled INTEGER NOT NULL CHECK (backfilled IN (0,1))
);
CREATE TABLE IF NOT EXISTS session_prompt_image_reference_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  backfilled INTEGER NOT NULL CHECK (backfilled IN (0,1))
);
CREATE TABLE IF NOT EXISTS session_event_payload_migration_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  through_id INTEGER NOT NULL CHECK (through_id >= 0)
);
`;

export const TRANSCRIPT_SHARE_TERMINAL_RETENTION_PER_SESSION = 100;
export const RUNNER_CREDENTIAL_REVOKED_HISTORY_LIMIT = 64;

const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS control_plane_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runners (
  runner_id    TEXT PRIMARY KEY,
  hostname     TEXT NOT NULL,
  os           TEXT NOT NULL,
  version      TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'offline',
  connected_at INTEGER,
  last_seen    INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- User-owned Machine metadata must survive runner re-registration and also exist before an SSH
-- box's runner first connects. Keep it outside the runner-authored registration row.
CREATE TABLE IF NOT EXISTS machine_overrides (
  runner_id    TEXT PRIMARY KEY,
  display_name TEXT
);

CREATE TABLE IF NOT EXISTS workspaces (
  runner_id TEXT NOT NULL,
  id        TEXT NOT NULL,
  name      TEXT NOT NULL,
  path      TEXT NOT NULL,
  additional_directory_grants TEXT,
  PRIMARY KEY (runner_id, id),
  FOREIGN KEY (runner_id) REFERENCES runners(runner_id) ON DELETE CASCADE
);

-- Projects are control-plane-owned durable grouping resources. Locations deliberately have no
-- foreign key to runners/workspaces: a disconnected, reconfigured, or deleted runner must not
-- erase the user's project model.
CREATE TABLE IF NOT EXISTS projects (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  name_source         TEXT NOT NULL CHECK (name_source IN ('workspace','user')),
  hidden_at           INTEGER,
  default_location_id TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY (default_location_id) REFERENCES project_locations(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS project_locations (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  runner_id    TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  name         TEXT NOT NULL,
  path         TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('reported','managed','legacy')),
  last_seen_at INTEGER,
  detached_at  INTEGER,
  removed_at   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_project_locations_project
  ON project_locations(project_id, removed_at, created_at, id);
CREATE INDEX IF NOT EXISTS idx_project_locations_active_workspace
  ON project_locations(runner_id, workspace_id)
  WHERE detached_at IS NULL AND removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_locations_active_project_workspace
  ON project_locations(project_id, runner_id, workspace_id)
  WHERE detached_at IS NULL AND removed_at IS NULL;

-- Deleting a Project explicitly unlinks its Locations. Keep that user decision independently of
-- the Project/Location rows themselves so the next runner registration cannot interpret the same
-- advertised workspace as a brand-new Project. Explicit Add Location clears the exact tombstone.
CREATE TABLE IF NOT EXISTS project_location_suppressions (
  runner_id    TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (runner_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS agent_definitions (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runner_agents (
  runner_id    TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  command      TEXT NOT NULL,
  args         TEXT NOT NULL DEFAULT '[]',
  env          TEXT NOT NULL DEFAULT '{}',
  driver       TEXT NOT NULL DEFAULT 'acp',
  context      TEXT,
  capabilities TEXT,
  version      TEXT,
  auth_status  TEXT,
  available    INTEGER,
  source       TEXT,
  codex_app_server TEXT,
  claude_code TEXT,
  acp TEXT,
  registry TEXT,
  acp_transport TEXT,
  PRIMARY KEY (runner_id, agent_id),
  FOREIGN KEY (runner_id) REFERENCES runners(runner_id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agent_definitions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  runner_id      TEXT NOT NULL,
  workspace_id   TEXT,
  project_id     TEXT,
  project_location_id TEXT,
  agent_id       TEXT,
  title          TEXT NOT NULL DEFAULT '',
  title_source   TEXT NOT NULL DEFAULT 'generated',
  semantic_title INTEGER NOT NULL DEFAULT 0,
  provider_updated_at TEXT,
  background_work_state TEXT,
  background_work_tracking TEXT,
  status         TEXT NOT NULL DEFAULT 'queued',
  board_column   TEXT,
  run_id         TEXT,
  use_worktree   INTEGER NOT NULL DEFAULT 0,
  worktree_path  TEXT,
  worktrees      TEXT,
  execution_target TEXT,
  execution_handoff_request TEXT,
  execution_handoff TEXT,
  archived       INTEGER NOT NULL DEFAULT 0,
  preview        TEXT,
  pending_approval TEXT,
  policy_resume_status TEXT,
  driver         TEXT NOT NULL DEFAULT 'acp',
  model          TEXT,
  resolved_model TEXT,
  effort         TEXT,
  permission_mode TEXT,
  agent_capabilities TEXT,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  context_tokens_used INTEGER,
  context_window INTEGER,
  cost_usd       REAL NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  last_event_at  INTEGER,
  hydrated_seq   INTEGER NOT NULL DEFAULT 0,
  event_epoch    INTEGER NOT NULL DEFAULT 0,
  runner_history_epoch INTEGER,
  runner_history_tail_seq INTEGER NOT NULL DEFAULT 0,
  adopted        INTEGER NOT NULL DEFAULT 0,
  acp_session_context TEXT,
  CHECK (policy_resume_status IS NULL OR policy_resume_status='idle'),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY (project_location_id) REFERENCES project_locations(id) ON DELETE SET NULL
);

-- A reminder belongs to one human even when the underlying session is shared. The single row per
-- (session,user) makes replacement atomic, while state+revision make firing and multi-client edits
-- idempotent. Absolute instants drive scheduling; zone/expression retain the user's editing intent.
CREATE TABLE IF NOT EXISTS session_reminders (
  reminder_id         TEXT NOT NULL UNIQUE,
  session_id          TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  scheduled_for       INTEGER NOT NULL,
  time_zone           TEXT NOT NULL,
  original_expression TEXT NOT NULL,
  wake_policy         TEXT NOT NULL CHECK (wake_policy IN ('until_activity','regardless')),
  state               TEXT NOT NULL CHECK (state IN ('pending','fired')),
  revision            INTEGER NOT NULL,
  baseline_event_seq  INTEGER NOT NULL DEFAULT 0,
  wake_reason         TEXT,
  fired_at            INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (session_id, user_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES identity_users(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_reminders_due
  ON session_reminders(state, scheduled_for, session_id, user_id);

-- User-submitted prompts use the runner's durable v53 receipt lane too. Unlike scheduler-owned
-- automation commands these rows belong directly to a session and remain recoverable across a
-- control-plane restart without manufacturing an automation execution.
CREATE TABLE IF NOT EXISTS session_prompt_commands (
  command_id       TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  runner_id        TEXT NOT NULL,
  payload_json     TEXT NOT NULL,
  payload_sha256   TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN
                     ('pending','sent','accepted','queued','started','completed','failed','uncertain')),
  revision         INTEGER NOT NULL DEFAULT 0,
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER,
  expires_at       INTEGER NOT NULL,
  error            TEXT,
  error_code       TEXT,
  user_event_seq   INTEGER,
  dismissed_at     INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_prompt_commands_due
  ON session_prompt_commands(next_attempt_at, created_at, command_id)
  WHERE state IN ('pending','sent','accepted','queued','started');
CREATE INDEX IF NOT EXISTS idx_session_prompt_commands_session
  ON session_prompt_commands(session_id, created_at, command_id);
CREATE TABLE IF NOT EXISTS session_prompt_command_attempts (
  request_id    TEXT PRIMARY KEY,
  command_id    TEXT NOT NULL,
  runner_id     TEXT NOT NULL,
  sent_at       INTEGER NOT NULL,
  FOREIGN KEY (command_id) REFERENCES session_prompt_commands(command_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_prompt_command_attempts_command
  ON session_prompt_command_attempts(command_id, sent_at DESC);

-- Runner facts and control-plane delivery stages are separate so reconnect snapshots can update
-- provider-owned progress without regressing projection/observation acknowledgements.
CREATE TABLE IF NOT EXISTS managed_background_jobs (
  session_id                 TEXT NOT NULL,
  job_id                     TEXT NOT NULL,
  parent_turn_id             TEXT NOT NULL,
  runner_id                  TEXT NOT NULL,
  workspace_id               TEXT,
  project_location_id        TEXT,
  launch_type                TEXT NOT NULL,
  registered_at              INTEGER NOT NULL,
  terminal_status            TEXT,
  terminal_observed_at       INTEGER,
  continuation_required      INTEGER,
  continuation_id            TEXT,
  continuation_queued_at     INTEGER,
  continuation_submitted_at  INTEGER,
  continuation_accepted_at   INTEGER,
  assistant_result_persisted_at INTEGER,
  source_present             INTEGER NOT NULL DEFAULT 1 CHECK (source_present IN (0, 1)),
  last_observed_at           INTEGER NOT NULL,
  PRIMARY KEY (session_id, job_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_managed_background_jobs_continuation
  ON managed_background_jobs(session_id, continuation_id);

CREATE TABLE IF NOT EXISTS managed_background_deliveries (
  session_id                 TEXT NOT NULL,
  continuation_id            TEXT NOT NULL,
  parent_turn_id             TEXT NOT NULL,
  queued_at                  INTEGER,
  submitted_at               INTEGER,
  accepted_at                INTEGER,
  runner_result_persisted_at INTEGER,
  transcript_projected_at    INTEGER,
  projected_event_epoch      INTEGER,
  projected_event_seq        INTEGER,
  notification_queued_at     INTEGER,
  dashboard_observed_at      INTEGER,
  status_settlement_pending_at INTEGER,
  status_settled_at           INTEGER,
  updated_at                 INTEGER NOT NULL,
  PRIMARY KEY (session_id, continuation_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Durable per-subscription push outbox. Push-service acceptance, browser display, and user click
-- are distinct receipts; none of them claims exactly-once execution of provider side effects.
CREATE TABLE IF NOT EXISTS background_push_receipt_secret (
  id     INTEGER PRIMARY KEY CHECK (id = 1),
  secret TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS background_push_deliveries (
  delivery_id        TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  continuation_id    TEXT NOT NULL,
  endpoint           TEXT,
  endpoint_key       TEXT NOT NULL,
  payload_json       TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN
    ('pending','retry','service_accepted','shown','clicked','permanent_failure','expired')),
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    INTEGER,
  lease_expires_at   INTEGER,
  last_status        INTEGER,
  last_error         TEXT,
  service_accepted_at INTEGER,
  shown_at           INTEGER,
  clicked_at         INTEGER,
  expires_at         INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (session_id, continuation_id, endpoint_key),
  FOREIGN KEY (session_id, continuation_id)
    REFERENCES managed_background_deliveries(session_id, continuation_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_background_push_due
  ON background_push_deliveries(next_attempt_at, lease_expires_at)
  WHERE state IN ('pending','retry');

-- Steering is intentionally a control-plane-owned outbox/receipt. The request snapshot is
-- inserted before dispatch and retained while delivery is unresolved; terminal content is
-- compacted later while the identity/hash tombstone remains for session-lifetime idempotency.
CREATE TABLE IF NOT EXISTS session_steering_attempts (
  request_id       TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  submission_id    TEXT NOT NULL,
  turn_id          TEXT NOT NULL,
  source           TEXT NOT NULL CHECK (source IN ('direct','queued')),
  source_queue_id  TEXT,
  request_sha256   TEXT NOT NULL,
  text_snapshot    TEXT,
  images_json      TEXT,
  config_json      TEXT,
  disposition      TEXT NOT NULL CHECK (disposition IN
    ('pending','accepted','converted_to_queue','rejected','uncertain')),
  reason           TEXT,
  queued_prompt_id TEXT,
  receipt_json     TEXT,
  resolution_action TEXT CHECK (resolution_action IN ('queue_again','dismiss')),
  resolution_request_id TEXT,
  resolution_receipt_json TEXT,
  resolution_requested_at INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  terminal_at      INTEGER,
  resolved_at      INTEGER,
  queue_revision_at_create INTEGER NOT NULL DEFAULT 0,
  queue_absent_at  INTEGER,
  compacted_at     INTEGER,
  UNIQUE (session_id, submission_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_steering_attempts_session
  ON session_steering_attempts(session_id, created_at DESC, request_id);
CREATE INDEX IF NOT EXISTS idx_session_steering_attempts_pending
  ON session_steering_attempts(session_id, updated_at, request_id)
  WHERE disposition='pending';
CREATE TABLE IF NOT EXISTS session_steering_attempt_artifacts ${STEERING_ATTEMPT_ARTIFACT_COLUMNS};
CREATE INDEX IF NOT EXISTS idx_session_steering_attempt_artifacts_artifact
  ON session_steering_attempt_artifacts(artifact_id, request_id);
CREATE TABLE IF NOT EXISTS session_steering_queue_snapshots (
  session_id      TEXT PRIMARY KEY,
  revision        INTEGER NOT NULL CHECK (revision >= 0),
  prompt_ids_json TEXT NOT NULL CHECK (json_valid(prompt_ids_json)),
  observed_at     INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Manual provider commands use a distinct durable outbox and receipt projection. Keeping these
-- rows separate from automation commands prevents interactive volume from consuming workflow
-- capacity or aliasing automation identities.
CREATE TABLE IF NOT EXISTS session_command_invocations (
  invocation_id       TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  runner_id           TEXT NOT NULL,
  submission_id       TEXT NOT NULL,
  provider_command_id TEXT NOT NULL,
  catalog_revision    TEXT NOT NULL,
  command_name        TEXT NOT NULL,
  argument_text       TEXT NOT NULL,
  execution_mode      TEXT NOT NULL CHECK (execution_mode IN ('passthrough','structured')),
  payload_digest      TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN
    ('pending','sent','accepted','queued','started','completed','rejected','uncertain')),
  revision            INTEGER NOT NULL DEFAULT 0,
  error               TEXT,
  error_code          TEXT,
  user_event_seq      INTEGER,
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     INTEGER,
  expires_at          INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  terminal_at         INTEGER,
  UNIQUE (session_id, submission_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_command_invocations_session
  ON session_command_invocations(session_id, created_at DESC, invocation_id);
CREATE INDEX IF NOT EXISTS idx_session_command_invocations_outbox
  ON session_command_invocations(runner_id, state, updated_at, invocation_id)
  WHERE state IN ('pending','sent');
CREATE TABLE IF NOT EXISTS session_command_invocation_attempts (
  request_id    TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL,
  runner_id     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  sent_at       INTEGER,
  FOREIGN KEY (invocation_id) REFERENCES session_command_invocations(invocation_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_command_invocation_attempts_invocation
  ON session_command_invocation_attempts(invocation_id, created_at DESC, request_id);

CREATE TABLE IF NOT EXISTS policy_hook_credentials (
  session_id TEXT PRIMARY KEY,
  runner_id  TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_policy_hook_credentials_runner
  ON policy_hook_credentials(runner_id, session_id);

-- General agent control uses an independently revocable token per exact live session. Only the
-- digest crosses the runner boundary; deletion cascades revocation with the session.
CREATE TABLE IF NOT EXISTS agent_control_credentials (
  session_id TEXT PRIMARY KEY,
  runner_id  TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_control_credentials_runner
  ON agent_control_credentials(runner_id, session_id);

-- A hook ask must outlive a control-plane restart while the SAME Claude hook process polls.
-- Tool input is deliberately absent: request_fingerprint binds only the minimized hook envelope.
CREATE TABLE IF NOT EXISTS policy_hook_approvals (
  request_id         TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  governance_policy_id TEXT NOT NULL,
  approval_json      TEXT,
  status             TEXT NOT NULL DEFAULT 'queued',
  expires_at         INTEGER,
  last_polled_at     INTEGER NOT NULL,
  resume_status      TEXT,
  created_at         INTEGER NOT NULL,
  resolved_at        INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  CHECK (status IN ('queued','pending','allowed','denied','timed_out')),
  CHECK (resume_status IS NULL OR resume_status='idle')
);
CREATE INDEX IF NOT EXISTS idx_policy_hook_approvals_session
  ON policy_hook_approvals(session_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_policy_hook_approvals_status_expiry
  ON policy_hook_approvals(status, expires_at, session_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_hook_approvals_one_pending
  ON policy_hook_approvals(session_id) WHERE status='pending';

CREATE TABLE IF NOT EXISTS session_forks (
  target_session_id TEXT PRIMARY KEY,
  source_session_id TEXT NOT NULL,
  source_turn       INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (target_session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_forks_source ON session_forks(source_session_id, target_session_id);

-- Side chats are ordinary isolated sessions with a durable UI relationship. Keep this separate
-- from session_forks: a side chat must never inherit transcript checkpoints or artifact access.
CREATE TABLE IF NOT EXISTS session_side_chats (
  parent_session_id TEXT PRIMARY KEY,
  child_session_id  TEXT NOT NULL UNIQUE,
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (parent_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (child_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  CHECK (parent_session_id <> child_session_id)
);
CREATE INDEX IF NOT EXISTS idx_session_side_chats_child ON session_side_chats(child_session_id);

-- Durable terminal metadata is separate from the session event log: terminal output can be
-- noisy and has independent bounded retention/replay semantics.
CREATE TABLE IF NOT EXISTS session_shells (
  shell_id         TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  runner_id        TEXT NOT NULL,
  name             TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  pty              INTEGER NOT NULL DEFAULT 0,
  kind             TEXT NOT NULL DEFAULT 'shell',
  status           TEXT NOT NULL DEFAULT 'running',
  exit_code        INTEGER,
  updated_at       INTEGER NOT NULL,
  output_start_seq INTEGER NOT NULL DEFAULT 1,
  output_end_seq   INTEGER NOT NULL DEFAULT 0,
  output_truncated INTEGER NOT NULL DEFAULT 0,
  output_chars     INTEGER NOT NULL DEFAULT 0,
  output_chunks    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_shells_session ON session_shells(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_shells_runner ON session_shells(runner_id, status);

CREATE TABLE IF NOT EXISTS session_shell_name_seq (
  session_id TEXT PRIMARY KEY,
  value      INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_shell_output (
  shell_id TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  stream   TEXT NOT NULL,
  data     TEXT NOT NULL,
  PRIMARY KEY (shell_id, seq),
  FOREIGN KEY (shell_id) REFERENCES session_shells(shell_id) ON DELETE CASCADE
);

-- A close can race a reconnect snapshot already in flight. Tombstones prevent resurrection.
CREATE TABLE IF NOT EXISTS session_shell_tombstones (
  shell_id   TEXT PRIMARY KEY,
  runner_id  TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  FOREIGN KEY (runner_id) REFERENCES runners(runner_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  runner_seq INTEGER,
  ts         INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id, seq);

CREATE TABLE IF NOT EXISTS review_findings (
  finding_id  TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  scope       TEXT NOT NULL,
  diff_hash   TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  side        TEXT NOT NULL,
  line        INTEGER NOT NULL,
  body        TEXT NOT NULL,
  severity    TEXT NOT NULL,
  required    INTEGER NOT NULL,
  status      TEXT NOT NULL,
  source      TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  author_id   TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  sent_at     INTEGER,
  resolved_at INTEGER,
  resolved_by_kind TEXT,
  resolved_by_id TEXT,
  remote_provider TEXT,
  remote_repository TEXT,
  remote_pr_number INTEGER,
  remote_thread_id TEXT,
  remote_comment_id INTEGER,
  remote_url TEXT,
  remote_commit_id TEXT,
  remote_outdated INTEGER,
  remote_subject_type TEXT,
  remote_synchronized_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  CHECK (scope IN ('uncommitted','all_branch','last_turn')),
  CHECK (side IN ('left','right')),
  CHECK (line > 0),
  CHECK (severity IN ('blocker','major','minor','nit')),
  CHECK (required IN (0,1)),
  CHECK (status IN ('open','sent','resolved','dismissed')),
  CHECK (source IN ('local','github'))
);
CREATE INDEX IF NOT EXISTS idx_review_findings_session
  ON review_findings(session_id, status, created_at, finding_id);

-- Retained governance provenance intentionally has no session foreign key: deleting a chat must
-- not immediately erase who requested/decided an approval. Raw tool input and answers never enter
-- this table; bounded maintenance removes rows only after the documented retention horizon.
CREATE TABLE IF NOT EXISTS governance_audit (
  row_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id       TEXT NOT NULL UNIQUE,
  session_id     TEXT NOT NULL,
  request_id     TEXT NOT NULL,
  approval_kind  TEXT NOT NULL,
  stage          TEXT NOT NULL,
  outcome        TEXT NOT NULL,
  actor_kind     TEXT NOT NULL,
  actor_id       TEXT,
  scope          TEXT NOT NULL,
  content_digest TEXT,
  policy_rule    TEXT,
  governance_policy_id TEXT,
  option_id      TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_governance_audit_session
  ON governance_audit(session_id, created_at, row_id);
CREATE INDEX IF NOT EXISTS idx_governance_audit_request
  ON governance_audit(request_id, created_at, row_id);
CREATE INDEX IF NOT EXISTS idx_governance_audit_created
  ON governance_audit(created_at, row_id);

CREATE TABLE IF NOT EXISTS governance_policies (
  policy_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  effect      TEXT NOT NULL,
  priority    INTEGER NOT NULL,
  enabled     INTEGER NOT NULL,
  scope       TEXT NOT NULL,
  conditions  TEXT,
  ask_timeout INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_governance_policies_precedence
  ON governance_policies(enabled, priority DESC, policy_id);
-- Reconcile/hydrate/delete paths filter sessions by owner constantly; without this every
-- runner reconnect pays O(sessions) scans per lookup.
CREATE INDEX IF NOT EXISTS idx_sessions_runner ON sessions(runner_id);
-- Run detail filters members by run id (partial: most sessions have none).
CREATE INDEX IF NOT EXISTS idx_sessions_run ON sessions(run_id) WHERE run_id IS NOT NULL;
-- Phase 8: countToolCalls runs on every sessionView broadcast for guardrailed sessions — a partial
-- covering expression index keeps it index-only instead of an O(all events) row scan per event.
-- The expression text must match the query byte-for-byte.
CREATE INDEX IF NOT EXISTS idx_session_events_tool_call
  ON session_events(session_id, json_extract(payload,'$.toolCallId')) WHERE kind='tool_call';

CREATE TABLE IF NOT EXISTS multi_agent_runs (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL DEFAULT '',
  prompt       TEXT NOT NULL DEFAULT '',
  workspace_id TEXT,
  runner_id    TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS multi_agent_run_members (
  run_id     TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent_id   TEXT,
  PRIMARY KEY (run_id, session_id),
  FOREIGN KEY (run_id) REFERENCES multi_agent_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pods (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  objective  TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pod_members (
  pod_id               TEXT NOT NULL,
  session_id           TEXT NOT NULL,
  joined_at            INTEGER NOT NULL,
  role                 TEXT NOT NULL DEFAULT 'worker' CHECK (role IN ('lead', 'worker', 'reviewer')),
  context_token_budget INTEGER,
  last_context_seq     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pod_id, session_id),
  FOREIGN KEY (pod_id) REFERENCES pods(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pod_members_pod ON pod_members(pod_id, joined_at, session_id);

CREATE TABLE IF NOT EXISTS pod_orchestration (
  pod_id                 TEXT PRIMARY KEY,
  mode                   TEXT NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual', 'round_robin', 'lead_driven', 'event_triggered')),
  context_token_budget   INTEGER NOT NULL DEFAULT 4096,
  summary_token_budget   INTEGER NOT NULL DEFAULT 512,
  max_turns              INTEGER NOT NULL DEFAULT 12,
  max_repeated_outputs   INTEGER NOT NULL DEFAULT 2,
  status                 TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'paused', 'stopped')),
  run_id                 TEXT,
  turns_used             INTEGER NOT NULL DEFAULT 0,
  current_session_id     TEXT,
  last_session_id        TEXT,
  stop_reason            TEXT,
  started_at             INTEGER,
  updated_at             INTEGER NOT NULL,
  FOREIGN KEY (pod_id) REFERENCES pods(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pod_orchestration_steps (
  step_id              TEXT PRIMARY KEY,
  pod_id               TEXT NOT NULL,
  run_id               TEXT NOT NULL,
  turn                 INTEGER NOT NULL,
  target_session_id    TEXT NOT NULL,
  trigger_session_id   TEXT,
  selected_entry_ids   TEXT NOT NULL,
  summarized_from_seq  INTEGER,
  summarized_to_seq    INTEGER,
  estimated_tokens     INTEGER NOT NULL,
  output_entry_id      TEXT,
  output_hash          TEXT,
  status               TEXT NOT NULL CHECK (status IN ('dispatching', 'running', 'settled', 'failed')),
  error                TEXT,
  created_at           INTEGER NOT NULL,
  settled_at           INTEGER,
  UNIQUE (pod_id, run_id, turn),
  FOREIGN KEY (pod_id) REFERENCES pods(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pod_orchestration_steps_run
  ON pod_orchestration_steps(pod_id, run_id, turn DESC);

CREATE TABLE IF NOT EXISTS pod_reconciliations (
  reconciliation_id TEXT PRIMARY KEY,
  pod_id             TEXT NOT NULL,
  source_session_id  TEXT NOT NULL,
  target_session_id  TEXT NOT NULL,
  actor_id           TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('running', 'applied', 'already_applied', 'conflicted', 'failed')),
  source_head        TEXT,
  target_head        TEXT,
  merge_base         TEXT,
  result_head        TEXT,
  conflict_paths     TEXT,
  error              TEXT,
  created_at         INTEGER NOT NULL,
  completed_at       INTEGER,
  FOREIGN KEY (pod_id) REFERENCES pods(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pod_reconciliations_pod
  ON pod_reconciliations(pod_id, created_at DESC, reconciliation_id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pod_reconciliations_running
  ON pod_reconciliations(pod_id) WHERE status='running';

CREATE TABLE IF NOT EXISTS pod_context_entries (
  id              TEXT PRIMARY KEY,
  pod_id          TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  ts              INTEGER NOT NULL,
  source_kind     TEXT NOT NULL CHECK (source_kind IN ('human', 'session')),
  source          TEXT NOT NULL,
  source_session_id TEXT,
  source_from_seq INTEGER,
  source_to_seq   INTEGER,
  content         TEXT NOT NULL,
  UNIQUE (pod_id, seq),
  FOREIGN KEY (pod_id) REFERENCES pods(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pod_context_entries_pod ON pod_context_entries(pod_id, seq DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pod_context_member_output
  ON pod_context_entries(pod_id, source_session_id, source_from_seq, source_to_seq)
  WHERE source_kind='session';

${ARTIFACT_TABLE_SCHEMA}

CREATE TABLE IF NOT EXISTS workflow_definitions (
  workflow_id TEXT NOT NULL,
  version     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  max_transitions INTEGER NOT NULL,
  graph       TEXT NOT NULL,
  source      TEXT NOT NULL,
  created_by_kind TEXT NOT NULL,
  created_by_id TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, version)
);
CREATE INDEX IF NOT EXISTS idx_workflow_definitions_created
  ON workflow_definitions(created_at DESC, workflow_id, version);

CREATE TABLE IF NOT EXISTS workflow_instances (
  instance_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  transition_count INTEGER NOT NULL DEFAULT 0,
  created_by_kind TEXT NOT NULL,
  created_by_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (workflow_id, workflow_version) REFERENCES workflow_definitions(workflow_id, version),
  FOREIGN KEY (run_id) REFERENCES multi_agent_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workflow_instances_run ON workflow_instances(run_id, created_at, instance_id);
CREATE INDEX IF NOT EXISTS idx_workflow_instances_workflow ON workflow_instances(workflow_id, workflow_version, created_at);

CREATE TABLE IF NOT EXISTS workflow_node_states (
  instance_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  error TEXT,
  ready_at INTEGER,
  outcome TEXT,
  PRIMARY KEY (instance_id, node_id),
  FOREIGN KEY (instance_id) REFERENCES workflow_instances(instance_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workflow_attempts (
  attempt_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  dispatch_key TEXT NOT NULL UNIQUE,
  session_id TEXT,
  started_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT,
  UNIQUE (instance_id, node_id, attempt),
  FOREIGN KEY (instance_id, node_id) REFERENCES workflow_node_states(instance_id, node_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workflow_attempts_instance ON workflow_attempts(instance_id, started_at, attempt_id);

CREATE TABLE IF NOT EXISTS workflow_attempt_artifacts ${WORKFLOW_ATTEMPT_ARTIFACT_COLUMNS};

CREATE TABLE IF NOT EXISTS workflow_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  node_id TEXT,
  attempt_id TEXT,
  actor_kind TEXT NOT NULL,
  actor_id TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (instance_id, seq),
  FOREIGN KEY (instance_id) REFERENCES workflow_instances(instance_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workflow_events_instance ON workflow_events(instance_id, seq);

-- Durable schedules are soft-deleted so actor-attributed audit and execution history survives.
-- Action/config JSON is secret-free and validated at the service boundary before insertion.
CREATE TABLE IF NOT EXISTS automations (
  automation_id      TEXT PRIMARY KEY,
  revision           INTEGER NOT NULL DEFAULT 1,
  name               TEXT NOT NULL,
  cron_expression    TEXT NOT NULL,
  timezone           TEXT NOT NULL,
  enabled            INTEGER NOT NULL CHECK (enabled IN (0,1)),
  next_fire_at       INTEGER,
  last_fired_at      INTEGER,
  misfire_policy     TEXT NOT NULL,
  runner_policy      TEXT NOT NULL,
  concurrency_policy TEXT NOT NULL CHECK (concurrency_policy IN ('wait','skip','parallel')),
  limits_json        TEXT NOT NULL,
  notifications_json TEXT NOT NULL,
  action_json        TEXT NOT NULL,
  created_by_kind    TEXT NOT NULL,
  created_by_id      TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  deleted_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_automations_due
  ON automations(enabled, next_fire_at) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS automation_executions (
  execution_id       TEXT PRIMARY KEY,
  automation_id      TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL UNIQUE,
  scheduled_for      INTEGER NOT NULL,
  automation_revision INTEGER NOT NULL DEFAULT 1,
  spec_json          TEXT,
  delivery_mode      TEXT NOT NULL DEFAULT 'legacy_at_most_once',
  delivery_plan_json TEXT,
  action_kind        TEXT NOT NULL CHECK (action_kind IN ('create_session','prompt_session','workflow_run')),
  status             TEXT NOT NULL CHECK (status IN ('dispatching','running','succeeded','failed','skipped','expired')),
  actor_kind         TEXT NOT NULL,
  actor_id           TEXT,
  runner_id          TEXT,
  session_id         TEXT,
  run_id             TEXT,
  workflow_instance_id TEXT,
  error              TEXT,
  created_at         INTEGER NOT NULL,
  started_at         INTEGER,
  completed_at       INTEGER,
  UNIQUE (automation_id, scheduled_for),
  FOREIGN KEY (automation_id) REFERENCES automations(automation_id)
);
CREATE INDEX IF NOT EXISTS idx_automation_executions_history
  ON automation_executions(automation_id, scheduled_for DESC, execution_id DESC);
CREATE INDEX IF NOT EXISTS idx_automation_executions_active
  ON automation_executions(status, automation_id) WHERE status IN ('dispatching','running');

CREATE TABLE IF NOT EXISTS automation_commands (
  command_id            TEXT PRIMARY KEY,
  execution_id          TEXT NOT NULL,
  ordinal               INTEGER NOT NULL,
  runner_id             TEXT NOT NULL,
  session_id            TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('start_session','prompt_session')),
  payload_json          TEXT NOT NULL,
  payload_sha256        TEXT NOT NULL,
  expires_at            INTEGER,
  dependency_command_id TEXT,
  state                 TEXT NOT NULL CHECK (state IN
    ('staged','pending','sent','accepted','started','completed','rejected','uncertain')),
  revision              INTEGER NOT NULL DEFAULT 0,
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at       INTEGER,
  last_error            TEXT,
  error_code            TEXT,
  duplicate             INTEGER,
  user_event_seq        INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  last_sent_at          INTEGER,
  accepted_at           INTEGER,
  started_at            INTEGER,
  completed_at          INTEGER,
  UNIQUE (execution_id, ordinal),
  FOREIGN KEY (execution_id) REFERENCES automation_executions(execution_id),
  FOREIGN KEY (dependency_command_id) REFERENCES automation_commands(command_id)
);
CREATE INDEX IF NOT EXISTS idx_automation_commands_due
  ON automation_commands(runner_id, next_attempt_at, ordinal)
  WHERE state IN ('pending','sent');
CREATE INDEX IF NOT EXISTS idx_automation_commands_retry
  ON automation_commands(next_attempt_at, runner_id, ordinal)
  WHERE state IN ('pending','sent','accepted','started');
CREATE INDEX IF NOT EXISTS idx_automation_commands_execution
  ON automation_commands(execution_id, ordinal, command_id);

CREATE TABLE IF NOT EXISTS automation_command_attempts (
  request_id     TEXT PRIMARY KEY,
  command_id     TEXT NOT NULL,
  runner_id      TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  sent_at        INTEGER NOT NULL,
  FOREIGN KEY (command_id) REFERENCES automation_commands(command_id)
);
CREATE INDEX IF NOT EXISTS idx_automation_command_attempts_command
  ON automation_command_attempts(command_id, attempt_number);

CREATE TABLE IF NOT EXISTS automation_events (
  event_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id  TEXT NOT NULL,
  execution_id   TEXT,
  kind           TEXT NOT NULL,
  actor_kind     TEXT NOT NULL,
  actor_id       TEXT,
  detail         TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_automation_events_history
  ON automation_events(automation_id, created_at DESC, event_id DESC);

-- Operator-created ingress bindings. The symmetric signing key is intentionally confined to the
-- same sensitive SQLite boundary as VAPID/private runner configuration and is never projected.
CREATE TABLE IF NOT EXISTS automation_triggers (
  trigger_id       TEXT PRIMARY KEY,
  automation_id    TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('webhook','chatops')),
  name             TEXT NOT NULL,
  secret_key       TEXT NOT NULL,
  generation       INTEGER NOT NULL DEFAULT 1,
  invocation_count INTEGER NOT NULL DEFAULT 0,
  last_invoked_at  INTEGER,
  created_by_kind  TEXT NOT NULL,
  created_by_id    TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  FOREIGN KEY (automation_id) REFERENCES automations(automation_id)
);
CREATE INDEX IF NOT EXISTS idx_automation_triggers_automation
  ON automation_triggers(automation_id, created_at, trigger_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS automation_trigger_invocations (
  invocation_id TEXT PRIMARY KEY,
  trigger_id    TEXT NOT NULL,
  automation_id TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  body_sha256   TEXT NOT NULL,
  sender_hash   TEXT,
  automation_revision INTEGER NOT NULL,
  spec_json     TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('pending','dispatched','skipped','expired','rejected')),
  execution_id  TEXT,
  received_at   INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (trigger_id, event_id),
  FOREIGN KEY (trigger_id) REFERENCES automation_triggers(trigger_id),
  FOREIGN KEY (automation_id) REFERENCES automations(automation_id),
  FOREIGN KEY (execution_id) REFERENCES automation_executions(execution_id)
);
CREATE INDEX IF NOT EXISTS idx_automation_trigger_invocations_pending
  ON automation_trigger_invocations(received_at, invocation_id) WHERE state='pending';
CREATE INDEX IF NOT EXISTS idx_automation_trigger_invocations_trigger
  ON automation_trigger_invocations(trigger_id, received_at DESC, invocation_id DESC);

-- Legacy CP-owned workspace display-name overrides. The workspaces table is wiped and re-filled
-- from runner config on every register, so a compatibility rename must live here and be applied
-- at read time.
CREATE TABLE IF NOT EXISTS workspace_overrides (
  runner_id    TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  display_name TEXT,
  PRIMARY KEY (runner_id, workspace_id)
);

-- CP-owned workspace definitions created through the legacy workspace adapter. The runner-reported
-- workspaces table is wiped on every register, so these definitions live here and are merged into
-- the runner view. Cleaned up only when the runner/box is explicitly deleted (like overrides).
CREATE TABLE IF NOT EXISTS workspace_extras (
  runner_id  TEXT NOT NULL,
  id         TEXT NOT NULL,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (runner_id, id)
);

-- A "box" is a remote machine reached over SSH; the orchestrator bootstraps a runner there
-- (through a reverse tunnel) and keeps it alive. runner_id is the id the runner registers with;
-- there is no FK to runners since the box row is created BEFORE its runner first connects.
CREATE TABLE IF NOT EXISTS boxes (
  box_id           TEXT PRIMARY KEY,
  runner_id        TEXT NOT NULL,
  ssh_target       TEXT NOT NULL,
  ssh_port         INTEGER NOT NULL DEFAULT 22,
  workspaces       TEXT NOT NULL DEFAULT '[]',
  status           TEXT NOT NULL DEFAULT 'offline',
  last_error       TEXT,
  auto_reconnect   INTEGER NOT NULL DEFAULT 1,
  deployed_version TEXT,
  triple           TEXT,
  runner_data_dir  TEXT,
  legacy_adoption_epoch TEXT,
  legacy_adoption_pending INTEGER NOT NULL DEFAULT 0,
  legacy_adoption_authorized_by TEXT,
  legacy_adoption_authorized_role TEXT,
  legacy_adoption_authorized_at INTEGER,
  legacy_adoption_completed_at INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- Canonical legacy-root ownership audit is keyed by the persisted SSH connection identity, not a
-- box FK: deleting the adopter must not make surviving/future legacy siblings forget remote owner
-- bytes that remain on disk. The boxes legacy_* columns are retained as a rollback-compatible
-- per-box mirror, but all account admission/projection reads this table.
CREATE TABLE IF NOT EXISTS legacy_ssh_account_adoptions (
  ssh_target                TEXT NOT NULL,
  ssh_port                  INTEGER NOT NULL,
  epoch                     TEXT NOT NULL,
  status                    TEXT NOT NULL CHECK (status IN ('pending','completed')),
  adopter_box_id            TEXT NOT NULL,
  authorized_by             TEXT NOT NULL,
  authorized_role           TEXT NOT NULL CHECK (authorized_role IN ('owner','admin')),
  authorized_at             INTEGER NOT NULL,
  completed_at              INTEGER,
  completed_credential_id   TEXT,
  completed_binary_identity TEXT,
  PRIMARY KEY (ssh_target, ssh_port)
);

-- Paired devices: revocable bearer tokens for REST + /ui access. token_hash is sha256(token)
-- (the plaintext exists only in the pairing response). Revocation = row deletion.
CREATE TABLE IF NOT EXISTS identity_users (
  user_id      TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_organizations (
  organization_id TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_memberships (
  organization_id TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('owner','admin','operator','viewer')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (organization_id, user_id),
  FOREIGN KEY (organization_id) REFERENCES identity_organizations(organization_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES identity_users(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_identity_memberships_user
  ON identity_memberships(user_id, organization_id);

CREATE TABLE IF NOT EXISTS identity_teams (
  team_id         TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES identity_organizations(organization_id) ON DELETE CASCADE,
  UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS identity_team_members (
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id),
  FOREIGN KEY (team_id) REFERENCES identity_teams(team_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES identity_users(user_id) ON DELETE CASCADE
);

-- Runner/workspace ownership is stored outside runner-discovered rows because registration
-- replaces the workspaces table wholesale. Missing scope fails closed at authorization.
CREATE TABLE IF NOT EXISTS runner_ownership (
  runner_id       TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  owner_kind      TEXT NOT NULL CHECK (owner_kind IN ('organization','user','team')),
  owner_id        TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Runner registration credentials are scoped to one exact runner id and organization. Only the
-- SHA-256 digest is persisted; plaintext is returned once at issuance. Historical revoked rows
-- retain rotation/audit metadata without retaining a usable credential.
CREATE TABLE IF NOT EXISTS runner_credentials (
  credential_id      TEXT PRIMARY KEY,
  runner_id           TEXT NOT NULL,
  organization_id     TEXT NOT NULL,
  owner_kind          TEXT NOT NULL CHECK (owner_kind IN ('organization','user','team')),
  owner_id            TEXT NOT NULL,
  label               TEXT NOT NULL,
  token_hash          TEXT NOT NULL,
  created_by_user_id  TEXT,
  status              TEXT NOT NULL CHECK (status IN ('pending','active','revoked')),
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER,
  activated_at        INTEGER,
  last_used_at        INTEGER,
  revoked_at          INTEGER,
  replaced_by_id      TEXT,
  legacy              INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1)),
  CHECK (LENGTH(token_hash) = 64),
  CHECK (status != 'pending' OR (expires_at IS NOT NULL AND expires_at > created_at)),
  FOREIGN KEY (organization_id) REFERENCES identity_organizations(organization_id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES identity_users(user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runner_credentials_one_active
  ON runner_credentials(runner_id) WHERE status='active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_runner_credentials_one_pending
  ON runner_credentials(runner_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_runner_credentials_org
  ON runner_credentials(organization_id, runner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runner_credentials_auth
  ON runner_credentials(runner_id, token_hash) WHERE status IN ('pending','active');

CREATE TABLE IF NOT EXISTS workspace_ownership (
  runner_id       TEXT NOT NULL,
  workspace_id    TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  owner_kind      TEXT NOT NULL CHECK (owner_kind IN ('organization','user','team')),
  owner_id        TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (runner_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS project_ownership (
  project_id      TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  owner_kind      TEXT NOT NULL CHECK (owner_kind IN ('organization','user','team')),
  owner_id        TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_project_ownership_scope
  ON project_ownership(organization_id, owner_kind, owner_id, project_id);

CREATE TABLE IF NOT EXISTS session_ownership (
  session_id      TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  owner_kind      TEXT NOT NULL CHECK (owner_kind IN ('organization','user','team')),
  owner_id        TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_ownership_scope
  ON session_ownership(organization_id, owner_kind, owner_id, session_id);

-- Immutable, least-data transcript snapshots addressed by hashed bearer capabilities. Revocation
-- and expiry erase projection_json while retaining small management/audit metadata.
CREATE TABLE IF NOT EXISTS transcript_shares (
  share_id           TEXT PRIMARY KEY,
  token_hash         TEXT NOT NULL UNIQUE,
  session_id         TEXT NOT NULL,
  organization_id    TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  projection_json    TEXT,
  projection_bytes   INTEGER NOT NULL CHECK (projection_bytes >= 0 AND projection_bytes <= 8388608),
  snapshot_through_seq INTEGER NOT NULL,
  schema_version     INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  revoked_at         INTEGER,
  CHECK (LENGTH(token_hash) = 64),
  CHECK (schema_version >= 1),
  CHECK (expires_at > created_at),
  CHECK (projection_json IS NULL OR LENGTH(CAST(projection_json AS BLOB)) = projection_bytes),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES identity_organizations(organization_id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES identity_users(user_id)
);
CREATE INDEX IF NOT EXISTS idx_transcript_shares_session
  ON transcript_shares(session_id, created_at DESC, share_id);
CREATE INDEX IF NOT EXISTS idx_transcript_shares_expiry
  ON transcript_shares(expires_at) WHERE projection_json IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transcript_shares_org_active
  ON transcript_shares(organization_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS mutation_audit (
  row_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id        TEXT NOT NULL UNIQUE,
  actor_kind      TEXT NOT NULL CHECK (actor_kind IN ('human','agent','anonymous')),
  actor_id        TEXT,
  user_id         TEXT,
  device_id       TEXT,
  organization_id TEXT,
  method          TEXT NOT NULL,
  route           TEXT NOT NULL,
  target_id       TEXT,
  status_code     INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mutation_audit_org
  ON mutation_audit(organization_id, created_at DESC, row_id DESC);

-- Completed mutation rows age out of the hot attribution window into this append-only archive.
-- The archive deliberately has no foreign keys: actor/resource deletion must not erase provenance.
CREATE TABLE IF NOT EXISTS mutation_audit_archive (
  row_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id        TEXT NOT NULL UNIQUE,
  actor_kind      TEXT NOT NULL CHECK (actor_kind IN ('human','agent','anonymous')),
  actor_id        TEXT,
  user_id         TEXT,
  device_id       TEXT,
  organization_id TEXT,
  method          TEXT NOT NULL,
  route           TEXT NOT NULL,
  target_id       TEXT,
  status_code     INTEGER NOT NULL CHECK (status_code != 0),
  created_at      INTEGER NOT NULL,
  archived_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mutation_audit_archive_org
  ON mutation_audit_archive(organization_id, created_at DESC, row_id DESC);

-- Scope transitions need enough content-safe evidence to reconstruct the exact privacy change.
-- No names, request bodies, credentials, paths, or confirmation tokens are retained.
CREATE TABLE IF NOT EXISTS access_scope_audit (
  row_id                INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_change_id       TEXT NOT NULL UNIQUE,
  mutation_audit_id     TEXT,
  actor_id               TEXT NOT NULL,
  user_id                TEXT NOT NULL,
  device_id              TEXT,
  organization_id        TEXT NOT NULL,
  resource               TEXT NOT NULL CHECK (resource IN ('project','workspace')),
  resource_id            TEXT NOT NULL,
  runner_id              TEXT,
  old_organization_id    TEXT NOT NULL,
  old_owner_kind         TEXT NOT NULL CHECK (old_owner_kind IN ('organization','user','team')),
  old_owner_id           TEXT NOT NULL,
  new_organization_id    TEXT NOT NULL,
  new_owner_kind         TEXT NOT NULL CHECK (new_owner_kind IN ('organization','user','team')),
  new_owner_id           TEXT NOT NULL,
  affected_project_ids   TEXT NOT NULL,
  active_session_ids     TEXT NOT NULL,
  session_ids            TEXT NOT NULL,
  narrowed_session_ids   TEXT NOT NULL,
  created_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_scope_audit_org
  ON access_scope_audit(organization_id, created_at DESC, row_id DESC);

CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  user_id      TEXT,
  organization_id TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);

-- Web Push subscriptions (RFC 8030). endpoint is the push service's per-subscription URL
-- (itself a capability - never logged whole); p256dh/auth are the browser's public encryption
-- parameters (not secrets: payloads are encrypted TO them). device_id ties a subscription to
-- the paired device that created it so revocation also silences its pushes; NULL = the
-- authenticated local-bootstrap dashboard.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  device_id  TEXT,
  created_at INTEGER NOT NULL
);

-- The server's VAPID keypair (RFC 8292), one row. The private JWK signs short-lived push
-- JWTs; server-side only, like agent env blocks. Regenerating it orphans every subscription
-- (browsers bind subscriptions to the applicationServerKey), hence persisted, not ephemeral.
CREATE TABLE IF NOT EXISTS push_vapid (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  public_key  TEXT NOT NULL,
  private_jwk TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Privacy-safe operational telemetry: hourly aggregates only. Deliberately no session id,
-- prompt/tool/path/env/auth fields, and no raw per-observation rows.
CREATE TABLE IF NOT EXISTS driver_telemetry_hourly (
  bucket_ts  INTEGER NOT NULL,
  driver     TEXT NOT NULL,
  version    TEXT NOT NULL DEFAULT '',
  context    TEXT NOT NULL,
  remote     INTEGER NOT NULL DEFAULT 0,
  metric     TEXT NOT NULL,
  outcome    TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  count      INTEGER NOT NULL DEFAULT 0,
  total_ms   INTEGER NOT NULL DEFAULT 0,
  max_ms     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_ts, driver, version, context, remote, metric, outcome, reason)
);

-- Replay-safe usage accounting. The contribution ledger contains only bounded dimensions and
-- numeric usage; no prompt, path, event body, tool input, auth value, or environment value.
CREATE TABLE IF NOT EXISTS usage_session_state (
  session_id          TEXT PRIMARY KEY,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cost_microusd       INTEGER NOT NULL DEFAULT 0,
  cost_remainder_picousd INTEGER NOT NULL DEFAULT 0,
  uncached_input_tokens       INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens       INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens            INTEGER NOT NULL DEFAULT 0,
  cache_savings_microusd      INTEGER NOT NULL DEFAULT 0,
  provider_reported_records   INTEGER NOT NULL DEFAULT 0,
  model_priced_records        INTEGER NOT NULL DEFAULT 0,
  unpriced_records            INTEGER NOT NULL DEFAULT 0,
  runner_history_epoch INTEGER,
  covered_through_seq INTEGER NOT NULL DEFAULT 0,
  revision            INTEGER NOT NULL DEFAULT 0,
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS usage_daily_budget (
  organization_id TEXT PRIMARY KEY,
  per_user_usd    REAL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_session_models (
  session_id          TEXT NOT NULL,
  model               TEXT NOT NULL,
  driver              TEXT NOT NULL,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cost_microusd       INTEGER NOT NULL DEFAULT 0,
  uncached_input_tokens       INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens       INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens            INTEGER NOT NULL DEFAULT 0,
  cache_savings_microusd      INTEGER NOT NULL DEFAULT 0,
  provider_reported_records   INTEGER NOT NULL DEFAULT 0,
  model_priced_records        INTEGER NOT NULL DEFAULT 0,
  unpriced_records            INTEGER NOT NULL DEFAULT 0,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (session_id, model),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS usage_hourly (
  bucket_ts           INTEGER NOT NULL,
  organization_id     TEXT NOT NULL,
  owner_kind          TEXT NOT NULL,
  owner_id            TEXT NOT NULL,
  runner_id           TEXT NOT NULL,
  workspace_id        TEXT NOT NULL DEFAULT '',
  agent_id            TEXT NOT NULL DEFAULT '',
  driver              TEXT NOT NULL,
  model               TEXT NOT NULL DEFAULT '',
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cost_microusd       INTEGER NOT NULL DEFAULT 0,
  uncached_input_tokens       INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens       INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens            INTEGER NOT NULL DEFAULT 0,
  cache_savings_microusd      INTEGER NOT NULL DEFAULT 0,
  provider_reported_records   INTEGER NOT NULL DEFAULT 0,
  model_priced_records        INTEGER NOT NULL DEFAULT 0,
  unpriced_records            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_ts, organization_id, owner_kind, owner_id, runner_id, workspace_id, agent_id, driver, model)
);
CREATE INDEX IF NOT EXISTS idx_usage_hourly_scope ON usage_hourly(organization_id, bucket_ts);
CREATE INDEX IF NOT EXISTS idx_usage_hourly_owner_scope ON usage_hourly(organization_id, owner_kind, owner_id, bucket_ts);

CREATE TABLE IF NOT EXISTS usage_daily (
  bucket_ts           INTEGER NOT NULL,
  organization_id     TEXT NOT NULL,
  owner_kind          TEXT NOT NULL,
  owner_id            TEXT NOT NULL,
  runner_id           TEXT NOT NULL,
  workspace_id        TEXT NOT NULL DEFAULT '',
  agent_id            TEXT NOT NULL DEFAULT '',
  driver              TEXT NOT NULL,
  model               TEXT NOT NULL DEFAULT '',
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cost_microusd       INTEGER NOT NULL DEFAULT 0,
  uncached_input_tokens       INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens       INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens            INTEGER NOT NULL DEFAULT 0,
  cache_savings_microusd      INTEGER NOT NULL DEFAULT 0,
  provider_reported_records   INTEGER NOT NULL DEFAULT 0,
  model_priced_records        INTEGER NOT NULL DEFAULT 0,
  unpriced_records            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_ts, organization_id, owner_kind, owner_id, runner_id, workspace_id, agent_id, driver, model)
);
CREATE INDEX IF NOT EXISTS idx_usage_daily_scope ON usage_daily(organization_id, bucket_ts);
CREATE INDEX IF NOT EXISTS idx_usage_daily_owner_scope ON usage_daily(organization_id, owner_kind, owner_id, bucket_ts);

CREATE TABLE IF NOT EXISTS usage_retention_policy (
  organization_id     TEXT PRIMARY KEY,
  hourly_days         INTEGER NOT NULL,
  daily_days          INTEGER NOT NULL,
  coverage_started_at INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_naming_preferences (
  organization_id TEXT PRIMARY KEY,
  mode            TEXT NOT NULL CHECK (mode IN ('prompt_text_only','session_agent_account','custom_model_endpoint')),
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES identity_organizations(organization_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_naming_harness_targets (
  organization_id TEXT PRIMARY KEY,
  runner_id       TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  driver          TEXT NOT NULL CHECK (driver IN ('codex','codex-app-server','claude-code')),
  context_kind    TEXT CHECK (context_kind IN ('native','wsl')),
  context_distro  TEXT,
  provider        TEXT CHECK (provider IN ('codex','claude')),
  billing_source  TEXT CHECK (billing_source IN ('subscription','api','bedrock','vertex','gateway','provider_account','unknown')),
  model           TEXT NOT NULL,
  effort          TEXT NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES identity_organizations(organization_id) ON DELETE CASCADE
);

-- Per-user ordinary-session defaults. Harness identity is deliberately runner-independent so the
-- same preference follows a user across their devices and Machines. Empty context_distro avoids
-- SQLite's nullable-composite-key duplicate semantics for native harnesses.
CREATE TABLE IF NOT EXISTS agent_harness_defaults (
  user_id          TEXT NOT NULL,
  agent_id         TEXT NOT NULL,
  driver           TEXT NOT NULL CHECK (driver IN ('acp','codex','codex-app-server','claude-code')),
  context_kind     TEXT NOT NULL CHECK (context_kind IN ('native','wsl')),
  context_distro   TEXT NOT NULL DEFAULT '',
  model            TEXT,
  effort           TEXT,
  permission_mode  TEXT,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (user_id, agent_id, driver, context_kind, context_distro),
  CHECK (context_kind='wsl' OR context_distro=''),
  CHECK (model IS NOT NULL OR effort IS NOT NULL OR permission_mode IS NOT NULL),
  FOREIGN KEY (user_id) REFERENCES identity_users(user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_naming_custom_models (
  organization_id    TEXT PRIMARY KEY,
  runner_id          TEXT NOT NULL,
  endpoint           TEXT NOT NULL,
  model              TEXT NOT NULL,
  timeout_ms         INTEGER NOT NULL,
  runner_configured  INTEGER NOT NULL DEFAULT 0 CHECK (runner_configured IN (0, 1)),
  api_key_configured INTEGER NOT NULL DEFAULT 0 CHECK (api_key_configured IN (0, 1)),
  updated_at         INTEGER NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES identity_organizations(organization_id) ON DELETE CASCADE,
  FOREIGN KEY (runner_id) REFERENCES runners(runner_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS usage_aggregation_meta (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  baseline_seeded_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscription_usage_snapshots (
  runner_id           TEXT NOT NULL,
  source_id           TEXT NOT NULL,
  agent_id            TEXT NOT NULL,
  provider            TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
  snapshot             TEXT NOT NULL,
  fetched_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (runner_id, source_id),
  FOREIGN KEY (runner_id) REFERENCES runners(runner_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_subscription_usage_runner
  ON subscription_usage_snapshots(runner_id, provider, agent_id);

-- Managed agent skills (protocol v90). Version files are stored inline as JSON for MVP; the
-- canonical manifest (path/sha256/size list) is what the version digest commits to.
CREATE TABLE IF NOT EXISTS skill_groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  description       TEXT,
  group_id          TEXT,
  source            TEXT NOT NULL DEFAULT 'library',
  latest_version_id TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_versions (
  id         TEXT PRIMARY KEY,
  skill_id   TEXT NOT NULL,
  digest     TEXT NOT NULL,
  manifest   TEXT NOT NULL,
  files      TEXT NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skill_versions_skill ON skill_versions(skill_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS skill_assignments (
  id             TEXT PRIMARY KEY,
  skill_id       TEXT NOT NULL,
  scope_kind     TEXT NOT NULL,
  runner_id      TEXT,
  agent_selector TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  invocation     TEXT NOT NULL DEFAULT 'agent',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skill_assignments_skill ON skill_assignments(skill_id, id);

CREATE TABLE IF NOT EXISTS runner_skill_state (
  runner_id  TEXT PRIMARY KEY,
  state      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_ownership (
  skill_id        TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  owner_kind      TEXT NOT NULL CHECK (owner_kind IN ('organization','user','team')),
  owner_id        TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_skill_ownership_scope
  ON skill_ownership(organization_id, owner_kind, owner_id, skill_id);
`;

/**
 * The ONE search-text policy (Cmd+K transcript FTS): which visible transcript text is
 * indexed, used identically by the live appendEvent path and the open-time catch-up so the
 * index can never depend on WHICH path ingested an event. Bounded per document — a multi-MB
 * diff/output would bloat the index for text nobody searches whole.
 *
 * Known limitation (deliberate, documented in the PR): streamed agent_message CHUNKS are
 * indexed as separate documents, so a phrase split across a chunk boundary won't match a
 * phrase query. Coalescing per-turn documents needs an update-in-place FTS strategy — future.
 */
export function searchTextForEvent(payload: SessionEventPayload): string | null {
  const cap = (s: string) => (s.length > 8192 ? s.slice(0, 8192) : s);
  switch (payload.kind) {
    case "user_message":
    case "agent_message":
    case "agent_thought":
    case "command_output":
    case "stderr":
      return payload.text.trim() ? cap(payload.text) : null;
    case "review_decision":
      return payload.rationale?.trim() ? cap(payload.rationale) : null;
    case "error":
      return payload.message.trim() ? cap(payload.message) : null;
    case "tool_call": {
      const t = [payload.title, payload.text].filter(Boolean).join("\n");
      return t.trim() ? cap(t) : null;
    }
    case "tool_call_update":
      return payload.text?.trim() ? cap(payload.text) : null;
    case "file_edit":
      // Path only — diffs are visible but indexing full diff bodies would dominate the index.
      return payload.path || null;
    default:
      return null;
  }
}

interface RunnerRow {
  runner_id: string;
  hostname: string;
  os: string;
  version: string;
  status: string;
  connected_at: number | null;
  last_seen: number | null;
  protocol_version: number | null;
  agents_refreshed_at: number | null;
  editors: string | null;
  runtime: string | null;
  container_targets: string | null;
}

interface RunnerCredentialRow {
  credential_id: string;
  runner_id: string;
  organization_id: string;
  owner_kind: "organization" | "user" | "team";
  owner_id: string;
  label: string;
  token_hash: string;
  created_by_user_id: string | null;
  status: "pending" | "active" | "revoked";
  created_at: number;
  expires_at: number | null;
  activated_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  replaced_by_id: string | null;
  legacy: number;
}

interface SessionRow {
  id: string;
  runner_id: string;
  workspace_id: string | null;
  project_id: string | null;
  project_location_id: string | null;
  agent_id: string | null;
  title: string;
  title_source: string | null;
  semantic_title: number;
  provider_updated_at: string | null;
  background_work_state: string | null;
  background_work_tracking: string | null;
  status: string;
  board_column: string | null;
  run_id: string | null;
  use_worktree: number;
  worktree_path: string | null;
  worktrees: string | null;
  execution_target: string | null;
  execution_handoff_request: string | null;
  execution_handoff: string | null;
  archived: number;
  preview: string | null;
  pending_approval: string | null;
  driver: string;
  model: string | null;
  resolved_model: string | null;
  effort: string | null;
  permission_mode: string | null;
  agent_capabilities: string | null;
  input_tokens: number;
  output_tokens: number;
  context_tokens_used: number | null;
  context_window: number | null;
  cost_usd: number;
  adopted: number;
  cost_budget_usd: number | null;
  cost_budget_step_usd: number | null;
  cost_checkpoints_usd: string | null;
  cost_checkpoint_approved_usd: number | null;
  cost_unpriced_ack: number | null;
  max_tool_calls: number | null;
  max_tool_calls_step: number | null;
  workspace_path: string | null;
  acp_session_context: string | null;
  message_count: number | null;
  created_at: number;
  updated_at: number;
  last_event_at: number | null;
  hydrated_seq: number;
  event_epoch: number;
  runner_history_epoch: number | null;
  runner_history_tail_seq: number;
}

interface SessionStopIntentRow {
  session_id: string;
  runner_id: string;
  created_at: number;
  restart_launch_id: string | null;
  archive_after_stop: number;
  operation_id: string;
  delivery_attempt_id: string;
  last_attempt_at: number;
  attempt_count: number;
  accepted_at: number | null;
  failed_at: number | null;
  failure_code: string | null;
  failure_message: string | null;
}

export interface SessionStopIntentRecord {
  sessionId: string;
  runnerId: string;
  restartLaunchId: string | null;
  deliveryAttemptId: string;
  archiveAfterStop: boolean;
  operation: StopOperationView;
}

interface SessionReminderRow {
  reminder_id: string;
  session_id: string;
  user_id: string;
  scheduled_for: number;
  time_zone: string;
  original_expression: string;
  wake_policy: SessionReminderWakePolicy;
  state: "pending" | "fired";
  revision: number;
  baseline_event_seq: number;
  wake_reason: SessionReminderWakeReason | null;
  fired_at: number | null;
  created_at: number;
  updated_at: number;
}

export type SessionReminderMutationResult =
  | { kind: "updated"; reminder: SessionReminderView }
  | { kind: "conflict"; reminder: SessionReminderView }
  | { kind: "missing" };

export type RemoveSessionReminderResult =
  | { kind: "removed" }
  | { kind: "conflict"; reminder: SessionReminderView }
  | { kind: "missing" };

interface SteeringAttemptRow {
  request_id: string;
  session_id: string;
  submission_id: string;
  turn_id: string;
  source: SteeringAttemptSource;
  source_queue_id: string | null;
  request_sha256: string;
  text_snapshot: string | null;
  images_json: string | null;
  config_json: string | null;
  disposition: "pending" | SteerDisposition;
  reason: SteerResultReason | null;
  queued_prompt_id: string | null;
  receipt_json: string | null;
  resolution_action: "queue_again" | "dismiss" | null;
  resolution_request_id: string | null;
  resolution_receipt_json: string | null;
  resolution_requested_at: number | null;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
  resolved_at: number | null;
  queue_revision_at_create: number;
  queue_absent_at: number | null;
  compacted_at: number | null;
}

interface SessionCommandInvocationRow {
  invocation_id: string;
  session_id: string;
  runner_id: string;
  submission_id: string;
  provider_command_id: string;
  catalog_revision: string;
  command_name: string;
  argument_text: string;
  execution_mode: SessionCommandExecutionMode;
  payload_digest: string;
  state: SessionCommandInvocationState;
  revision: number;
  error: string | null;
  error_code: SessionCommandInvocationErrorCode | null;
  user_event_seq: number | null;
  attempt_count: number;
  next_attempt_at: number | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
}

interface SessionPromptCommandRow {
  command_id: string;
  session_id: string;
  runner_id: string;
  payload_json: string;
  payload_sha256: string;
  state: SessionPromptCommandState;
  revision: number;
  attempt_count: number;
  next_attempt_at: number | null;
  expires_at: number;
  error: string | null;
  error_code: DurableSessionCommandErrorCode | null;
  user_event_seq: number | null;
  dismissed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface StageSessionCommandInvocationInput {
  invocationId: string;
  requestId: string;
  sessionId: string;
  runnerId: string;
  submissionId: string;
  providerCommandId: string;
  catalogRevision: string;
  commandName: string;
  argumentText: string;
  executionMode: SessionCommandExecutionMode;
  payloadDigest: string;
  expiresAt: number;
  now: number;
}

export interface CreateSteeringAttemptInput {
  requestId: string;
  sessionId: string;
  submissionId: string;
  turnId: string;
  source: SteeringAttemptSource;
  sourceQueueId?: string;
  requestSha256: string;
  text?: string;
  images?: unknown[];
  /** Artifacts created solely while externalizing this request. Borrowed PromptImageReferences are
   * deliberately excluded so compaction never deletes a reusable upload. */
  ownedArtifactIds?: string[];
  config?: SessionConfig;
  now: number;
}

export type CreateSteeringAttemptResult =
  | { kind: "inserted" | "duplicate"; requestId: string; attempt: SteeringAttemptView }
  | { kind: "conflict"; requestId: string; attempt: SteeringAttemptView };

export type StageSteeringResolutionResult =
  | { kind: "staged" | "existing"; requestId: string; attempt: SteeringAttemptView }
  | { kind: "not_found" | "not_uncertain" | "conflict"; attempt?: SteeringAttemptView };

const STEER_RESULT_REASONS = new Set<SteerResultReason>([
  "accepted", "stale_turn", "unsupported_protocol", "unsupported_driver", "no_active_provider_turn",
  "policy_blocked", "governance_blocked", "queue_item_absent", "queue_item_started",
  "configuration_mismatch", "queue_capacity_exceeded", "provider_rejected", "transport_uncertain",
  "history_integrity_failure",
]);

function boundedSteeringString(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function sessionCommandTerminal(state: SessionCommandInvocationState): boolean {
  return state === "completed" || state === "rejected" || state === "uncertain";
}

function sessionCommandReceiptAdvances(
  current: SessionCommandInvocationState,
  next: SessionCommandInvocationState,
  currentRevision: number,
  nextRevision: number,
): boolean {
  if (sessionCommandTerminal(current) || next === "pending" || next === "sent") return false;
  // Pre-fix or rolling-compatible runners can report a claim failure at revision 0 before creating
  // a durable journal row. Accept only that exact first-terminal boundary; current runners mint
  // revision 1, every nonterminal transition still requires a strictly newer revision, and
  // terminal rows remain immutable above.
  const firstClaimRejection = (current === "pending" || current === "sent") &&
    currentRevision === 0 && next === "rejected" && nextRevision === 0;
  if (!firstClaimRejection && nextRevision <= currentRevision) return false;
  if (sessionCommandTerminal(next)) return true;
  if (current === "pending" || current === "sent") {
    return next === "accepted" || next === "queued" || next === "started";
  }
  if (current === "accepted") return next === "queued" || next === "started";
  // A restarted runner reclaims journaled queued work by rotating ownership and publishing a
  // higher-revision accepted receipt before it queues the command again.
  if (current === "queued") return next === "accepted" || next === "started";
  return false;
}

function validSteeringResult(value: unknown): value is SteerSessionResultMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Partial<SteerSessionResultMessage> & Record<string, unknown>;
  const allowedKeys = new Set([
    "type", "requestId", "sessionId", "submissionId", "turnId", "disposition", "reason",
    "message", "providerTurnId", "queuedPromptId",
  ]);
  if (Object.keys(result).some((key) => !allowedKeys.has(key))) return false;
  if (result.type !== "steer_session_result" ||
      !boundedSteeringString(result.requestId) || !boundedSteeringString(result.sessionId) ||
      !boundedSteeringString(result.submissionId) || !boundedSteeringString(result.turnId) ||
      !["accepted", "converted_to_queue", "rejected", "uncertain"].includes(String(result.disposition)) ||
      !STEER_RESULT_REASONS.has(result.reason as SteerResultReason)) return false;
  if (result.message !== undefined && (typeof result.message !== "string" || result.message.length > 4_096)) return false;
  if (result.providerTurnId !== undefined && !boundedSteeringString(result.providerTurnId)) return false;
  if (result.queuedPromptId !== undefined && !boundedSteeringString(result.queuedPromptId)) return false;
  if (result.disposition === "accepted") {
    return result.reason === "accepted" && result.queuedPromptId === undefined;
  }
  if (result.disposition === "converted_to_queue") {
    return ["stale_turn", "no_active_provider_turn", "provider_rejected"].includes(result.reason as string) &&
      boundedSteeringString(result.queuedPromptId) && result.providerTurnId === undefined;
  }
  if (result.disposition === "uncertain") {
    return ["transport_uncertain", "history_integrity_failure"].includes(result.reason as string) &&
      result.queuedPromptId === undefined && result.providerTurnId === undefined;
  }
  return result.reason !== "accepted" && result.reason !== "transport_uncertain" &&
    result.queuedPromptId === undefined && result.providerTurnId === undefined;
}

function validSteeringResolutionResult(value: unknown): value is ResolveSteeringAttemptResultMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Partial<ResolveSteeringAttemptResultMessage> & Record<string, unknown>;
  const allowedKeys = new Set([
    "type", "requestId", "sessionId", "submissionId", "action", "applied", "reason", "queuedPromptId",
  ]);
  if (Object.keys(result).some((key) => !allowedKeys.has(key)) ||
      result.type !== "resolve_steering_attempt_result" || !boundedSteeringString(result.requestId) ||
      !boundedSteeringString(result.sessionId) || !boundedSteeringString(result.submissionId) ||
      (result.action !== "queue_again" && result.action !== "dismiss") ||
      typeof result.applied !== "boolean") return false;
  if (result.reason !== undefined && !boundedSteeringString(result.reason, 1_024)) return false;
  if (result.queuedPromptId !== undefined && !boundedSteeringString(result.queuedPromptId)) return false;
  if (result.applied) {
    return result.reason === undefined &&
      (result.action === "queue_again" ? boundedSteeringString(result.queuedPromptId) : result.queuedPromptId === undefined);
  }
  return result.reason !== undefined && result.queuedPromptId === undefined;
}

function userMessagePromptImageReferences(payload: SessionEventPayload): PromptImageReference[] {
  if (payload.kind !== "user_message" || !Array.isArray(payload.images)) return [];
  const validation = validatePromptImageInputs(payload.images);
  // Runner history is authoritative even when a stale or malformed attachment reference cannot
  // be associated locally. Keep the event/cursor and fail closed only on artifact reachability.
  if (!validation.ok) return [];
  return payload.images.filter((image): image is PromptImageReference => "artifactId" in image);
}

type ProjectNameSource = "workspace" | "user";

interface ProjectRow {
  id: string;
  name: string;
  name_source: ProjectNameSource;
  hidden_at: number | null;
  default_location_id: string | null;
  created_at: number;
  updated_at: number;
}

interface ProjectLocationRow {
  id: string;
  project_id: string;
  runner_id: string;
  workspace_id: string;
  name: string;
  path: string;
  source: ProjectLocationSource;
  last_seen_at: number | null;
  detached_at: number | null;
  removed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface RunnerHistoryState {
  historyEpoch: number | null;
  tailSeq: number;
  hydratedSeq: number;
  eventEpoch: number;
  complete: boolean;
}

export interface RunnerHistoryReconciliation extends RunnerHistoryState {
  reset: boolean;
}

export interface HydratedRunnerEvent {
  seq: number;
  ts: number;
  payload: SessionEventPayload;
  /** Optional pre-externalization shape used only to preserve transcript search coverage. */
  searchPayload?: SessionEventPayload;
  /** Event-only artifact chunks committed atomically with this cached event row. */
  artifactIds?: readonly string[];
}

export type AppendHydratedPageResult =
  | { applied: true; events: SessionEvent[] }
  | { applied: false; events: [] };

export interface CachedEventPage {
  events: SessionEvent[];
  nextAfterSeq: number;
  hasMore: boolean;
}

/** One bounded page read backwards from the cached tail. `events` stay ascending by seq so a
 * client merges them exactly like a forward page; only the cursor direction differs. */
export interface CachedEventTailPage {
  events: SessionEvent[];
  /** Oldest returned seq — the cursor for the next older page. Undefined when the page is empty. */
  nextBeforeSeq?: number;
  /** Older cached rows exist below `nextBeforeSeq`. */
  hasMoreOlder: boolean;
  /** The page begins at a user-anchored turn start rather than mid-turn. False when no anchor was
   * requested, none exists below the page, or reaching one would have exceeded the extension cap;
   * it describes the page's leading edge, not necessarily the newest response. */
  turnAligned?: boolean;
}

/** How far below a count-bounded window the tail read may reach to include the whole turn it
 * started inside. A turn is a semantic unit — splitting one orphans its tool updates from the
 * invocation that explains them — but a single verbose turn is unbounded, so alignment stops here
 * and the page keeps its count boundary rather than growing without limit. */
export const TAIL_TURN_ALIGNMENT_MAX_EVENTS = 2_000;
/** Serialized event-payload budget for the complete aligned opening page. The ordinary 200-row
 * window remains available even if it is already large; alignment never amplifies it past this
 * ceiling while reaching for a semantic turn boundary. */
export const TAIL_TURN_ALIGNMENT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

interface ReviewFindingRow {
  finding_id: string;
  session_id: string;
  scope: ReviewFinding["scope"];
  diff_hash: string;
  file_path: string;
  side: ReviewFinding["side"];
  line: number;
  body: string;
  severity: ReviewFinding["severity"];
  required: number;
  status: ReviewFindingStatus;
  source: ReviewFinding["source"];
  author_kind: ReviewFinding["author"]["kind"];
  author_id: string | null;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
  resolved_at: number | null;
  resolved_by_kind: ReviewFinding["author"]["kind"] | null;
  resolved_by_id: string | null;
  remote_provider: "github" | null;
  remote_repository: string | null;
  remote_pr_number: number | null;
  remote_thread_id: string | null;
  remote_comment_id: number | null;
  remote_url: string | null;
  remote_commit_id: string | null;
  remote_outdated: number | null;
  remote_subject_type: "line" | "file" | null;
  remote_synchronized_at: number | null;
}

interface RunRow {
  id: string;
  title: string;
  prompt: string;
  workspace_id: string | null;
  runner_id: string | null;
  created_at: number;
  updated_at: number;
}

interface PodRow {
  id: string;
  title: string;
  objective: string;
  status: PodView["status"];
  created_at: number;
  updated_at: number;
}

interface PodContextEntryRow {
  id: string;
  pod_id: string;
  seq: number;
  ts: number;
  source: string;
  content: string;
}

interface PodOrchestrationRow {
  pod_id: string;
  mode: PodOrchestrationPolicy["mode"];
  context_token_budget: number;
  summary_token_budget: number;
  max_turns: number;
  max_repeated_outputs: number;
  status: PodOrchestrationView["state"]["status"];
  run_id: string | null;
  turns_used: number;
  current_session_id: string | null;
  last_session_id: string | null;
  stop_reason: string | null;
  started_at: number | null;
  updated_at: number;
}

interface PodOrchestrationStepRow {
  step_id: string;
  pod_id: string;
  run_id: string;
  turn: number;
  target_session_id: string;
  trigger_session_id: string | null;
  selected_entry_ids: string;
  summarized_from_seq: number | null;
  summarized_to_seq: number | null;
  estimated_tokens: number;
  output_entry_id: string | null;
  output_hash: string | null;
  status: PodOrchestrationStep["status"];
  error: string | null;
  created_at: number;
  settled_at: number | null;
}

interface PodReconciliationRow {
  reconciliation_id: string;
  pod_id: string;
  source_session_id: string;
  target_session_id: string;
  actor_id: string;
  status: PodReconciliation["status"];
  source_head: string | null;
  target_head: string | null;
  merge_base: string | null;
  result_head: string | null;
  conflict_paths: string | null;
  error: string | null;
  created_at: number;
  completed_at: number | null;
}

interface WorkflowArtifactRow {
  id: string;
  run_id: string | null;
  session_id: string | null;
  kind: WorkflowArtifact["kind"];
  name: string;
  mime_type: string;
  encoding: WorkflowArtifact["encoding"];
  data?: string;
  blob_key?: string | null;
  size_bytes: number;
  sha256: string;
  created_by_kind: WorkflowArtifact["createdBy"]["kind"];
  created_by_id: string | null;
  metadata: string | null;
  created_at: number;
}

const MAX_WORKFLOW_ARTIFACT_BLOB_BYTES = EVENT_PAYLOAD_CHUNK_BYTES;
const MAX_WORKFLOW_ARTIFACT_INLINE_BYTES = 11 * 1024 * 1024;

function workflowArtifactBytes(input: {
  encoding: WorkflowArtifact["encoding"];
  data: string;
  sizeBytes: number;
  sha256: string;
}): Buffer {
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > MAX_WORKFLOW_ARTIFACT_BLOB_BYTES) {
    throw new Error("workflow artifact size is invalid");
  }
  assertArtifactBlobKey(input.sha256);
  let bytes: Buffer;
  if (input.encoding === "base64") {
    if (input.data.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) {
      throw new Error("workflow artifact base64 is not canonical");
    }
    bytes = Buffer.from(input.data, "base64");
    if (bytes.toString("base64") !== input.data) throw new Error("workflow artifact base64 is not canonical");
  } else if (input.encoding === "utf8" || input.encoding === "json") {
    bytes = Buffer.from(input.data, "utf8");
  } else {
    throw new Error("workflow artifact encoding is invalid");
  }
  if (bytes.byteLength !== input.sizeBytes || artifactBlobSha256(bytes) !== input.sha256) {
    throw new Error("workflow artifact bytes do not match metadata");
  }
  return bytes;
}

interface WorkflowDefinitionRow {
  workflow_id: string; version: number; name: string; description: string | null;
  max_transitions: number; graph: string; source: WorkflowDefinition["source"];
  created_by_kind: WorkflowDefinition["createdBy"]["kind"]; created_by_id: string | null; created_at: number;
}

interface WorkflowInstanceRow {
  instance_id: string; workflow_id: string; workflow_version: number; run_id: string;
  status: WorkflowInstanceStatus; transition_count: number;
  created_by_kind: WorkflowInstanceView["createdBy"]["kind"]; created_by_id: string | null;
  created_at: number; updated_at: number; completed_at: number | null;
}

interface WorkflowNodeStateRow {
  node_id: string; status: WorkflowNodeState["status"]; attempt_count: number; session_id: string | null;
  started_at: number | null; completed_at: number | null; error: string | null;
  ready_at: number | null; outcome: WorkflowNodeState["outcome"] | null;
}

interface WorkflowAttemptRow {
  attempt_id: string; instance_id: string; node_id: string; attempt: number;
  status: WorkflowAttemptView["status"]; dispatch_key: string; session_id: string | null;
  started_at: number; deadline_at: number; completed_at: number | null; error: string | null;
}

interface WorkflowEventRow {
  event_id: number; instance_id: string; seq: number; kind: WorkflowEventView["kind"];
  node_id: string | null; attempt_id: string | null;
  actor_kind: WorkflowEventView["actor"]["kind"]; actor_id: string | null;
  detail: string | null; created_at: number;
}

interface AutomationRow {
  automation_id: string; revision: number; name: string; cron_expression: string; timezone: string; enabled: number;
  next_fire_at: number | null; last_fired_at: number | null; misfire_policy: string; runner_policy: string;
  concurrency_policy: AutomationSchedule["concurrencyPolicy"]; limits_json: string;
  notifications_json: string; action_json: string; created_by_kind: AutomationSchedule["createdBy"]["kind"];
  created_by_id: string | null; created_at: number; updated_at: number; deleted_at: number | null;
}

interface AutomationExecutionRow {
  execution_id: string; automation_id: string; idempotency_key: string; scheduled_for: number;
  automation_revision: number; spec_json: string | null; delivery_mode: string; delivery_plan_json: string | null;
  action_kind: AutomationExecution["actionKind"]; status: AutomationExecutionStatus;
  actor_kind: AutomationExecution["actor"]["kind"]; actor_id: string | null; runner_id: string | null;
  session_id: string | null; run_id: string | null; workflow_instance_id: string | null; error: string | null;
  created_at: number; started_at: number | null; completed_at: number | null;
}

interface AutomationCommandRow {
  command_id: string; execution_id: string; ordinal: number; runner_id: string; session_id: string;
  kind: AutomationCommandView["kind"]; payload_json: string; payload_sha256: string; expires_at: number | null;
  dependency_command_id: string | null; state: AutomationCommandState; revision: number; attempt_count: number;
  next_attempt_at: number | null; last_error: string | null; error_code: string | null; duplicate: number | null;
  user_event_seq: number | null; created_at: number; updated_at: number; last_sent_at: number | null;
  accepted_at: number | null; started_at: number | null; completed_at: number | null;
}

interface AutomationEventRow {
  event_id: number; automation_id: string; execution_id: string | null; kind: AutomationAuditEventKind;
  actor_kind: AutomationAuditEvent["actor"]["kind"]; actor_id: string | null; detail: string | null; created_at: number;
}

interface AutomationTriggerRow {
  trigger_id: string; automation_id: string; kind: AutomationTriggerKind; name: string; secret_key: string;
  generation: number; invocation_count: number; last_invoked_at: number | null;
  created_by_kind: GovernanceActor["kind"]; created_by_id: string | null;
  created_at: number; updated_at: number; deleted_at: number | null;
}

interface AutomationTriggerInvocationRow {
  invocation_id: string; trigger_id: string; automation_id: string; event_id: string; body_sha256: string;
  sender_hash: string | null; automation_revision: number; spec_json: string;
  state: AutomationTriggerInvocationState; execution_id: string | null; received_at: number; updated_at: number;
}

interface BoxRow {
  box_id: string;
  runner_id: string;
  ssh_target: string;
  ssh_port: number;
  workspaces: string;
  status: string;
  last_error: string | null;
  auto_reconnect: number;
  deployed_version: string | null;
  triple: string | null;
  runner_data_dir: string | null;
  legacy_adoption_epoch: string | null;
  legacy_adoption_pending: number;
  legacy_adoption_authorized_by: string | null;
  legacy_adoption_authorized_role: string | null;
  legacy_adoption_authorized_at: number | null;
  legacy_adoption_completed_at: number | null;
  created_at: number;
}

interface LegacySshAccountAdoptionRow {
  ssh_target: string;
  ssh_port: number;
  epoch: string;
  status: "pending" | "completed";
  adopter_box_id: string;
  authorized_by: string;
  authorized_role: "owner" | "admin";
  authorized_at: number;
  completed_at: number | null;
  completed_credential_id: string | null;
  completed_binary_identity: string | null;
}

/** Data the control plane needs to tell a runner how to launch a session. */
export interface AgentLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  driver: AgentDriverKind;
  context: AgentContext;
  version?: string;
  capabilities?: AgentCapabilities;
}

/* --------------------------- Managed agent skills --------------------------- */

/** Which of a runner's agents a skill assignment addresses. Groups are organizational only in
 * MVP, so the selector is the complete assignable-unit vocabulary. */
export type SkillAgentSelector =
  | { kind: "all" }
  | { kind: "driver"; driver: AgentDriverKind }
  | { kind: "agent"; agentId: string };

export type SkillAssignmentScopeKind = "instance" | "runner";

export interface SkillVersionSummary {
  id: string;
  digest: string;
  createdAt: number;
}

export interface SkillView {
  id: string;
  name: string;
  description: string | null;
  groupId: string | null;
  source: string;
  latestVersion: SkillVersionSummary | null;
  assignmentCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SkillVersionView extends SkillVersionSummary {
  skillId: string;
  /** Canonical manifest JSON (`{"files":[{"path","sha256","size"},...]}`) the digest commits to. */
  manifest: string;
  files: SkillFile[];
  note: string | null;
}

export interface SkillGroupView {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface SkillAssignmentView {
  id: string;
  skillId: string;
  scopeKind: SkillAssignmentScopeKind;
  runnerId: string | null;
  agentSelector: SkillAgentSelector;
  enabled: boolean;
  invocation: SkillInvocationPolicy;
  createdAt: number;
  updatedAt: number;
}

const RUNNER_SKILL_REMOVAL_LIMIT = 256;
const RUNNER_SKILL_REMOVAL_TEXT_LIMIT = 2_048;

function normalizeSkillLinkRemovals(value: unknown): SkillLinkRemoval[] {
  if (!Array.isArray(value)) return [];
  const normalized: SkillLinkRemoval[] = [];
  for (const candidate of value.slice(0, RUNNER_SKILL_REMOVAL_LIMIT)) {
    const entry = candidate as { path?: unknown; reason?: unknown };
    if (typeof entry?.path !== "string" || !entry.path.startsWith("~/") ||
        entry.path.length > RUNNER_SKILL_REMOVAL_TEXT_LIMIT || typeof entry.reason !== "string" ||
        entry.reason.length < 1 || entry.reason.length > RUNNER_SKILL_REMOVAL_TEXT_LIMIT) continue;
    normalized.push({ path: entry.path, reason: entry.reason });
  }
  return normalized;
}

/** The runner-reported deployment state for one machine plus a bounded latest-removal event. */
export interface RunnerSkillStateRecord {
  runnerId: string;
  deployed: DeployedSkillState[];
  unmanaged: UnmanagedSkillInfo[];
  removals: SkillLinkRemoval[];
  removalsUpdatedAt?: number;
  error?: string;
  updatedAt: number;
}

interface SkillRow {
  id: string;
  name: string;
  description: string | null;
  group_id: string | null;
  source: string;
  latest_version_id: string | null;
  created_at: number;
  updated_at: number;
}

interface SkillVersionRow {
  id: string;
  skill_id: string;
  digest: string;
  manifest: string;
  files: string;
  note: string | null;
  created_at: number;
}

interface SkillAssignmentRow {
  id: string;
  skill_id: string;
  scope_kind: string;
  runner_id: string | null;
  agent_selector: string;
  enabled: number;
  invocation: string;
  created_at: number;
  updated_at: number;
}

export interface DriverTelemetryAggregate {
  bucketTs: number;
  driver: AgentDriverKind;
  version: string | null;
  context: "native" | "wsl";
  remote: boolean;
  metric: DriverTelemetryMessage["metric"];
  outcome: DriverTelemetryMessage["outcome"];
  reason: DriverTelemetryMessage["reason"] | null;
  count: number;
  totalMs: number;
  maxMs: number;
}

export type DriverTelemetrySummary = Omit<DriverTelemetryAggregate, "bucketTs">;

/** v103 ledger measures shared by `usage_session_state`, `usage_hourly`, and `usage_daily`. */
const USAGE_LEDGER_V103_COLUMNS = [
  "uncached_input_tokens", "cached_input_tokens", "cache_creation_tokens", "reasoning_tokens",
  "cache_savings_microusd", "provider_reported_records", "model_priced_records", "unpriced_records",
] as const;
const USAGE_LEDGER_ACCUMULATE_SQL = USAGE_LEDGER_V103_COLUMNS
  .map((column) => `${column}=${column}+excluded.${column}`).join(",\n                     ");
/** Drivers whose reported `inputTokens` already include the cached portion. */
const CODEX_DRIVERS: ReadonlySet<string> = new Set<AgentDriverKind>(["codex", "codex-app-server"]);

interface UsageLedgerDelta {
  inputTokens: number;
  outputTokens: number;
  costMicrousd: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  cacheSavingsMicrousd: number;
  providerReportedRecords: number;
  modelPricedRecords: number;
  unpricedRecords: number;
}

type UsageDimensions = {
  eventEpoch: number;
  scope: ResourceScope;
  runnerId: string;
  workspaceId: string;
  agentId: string;
  driver: AgentDriverKind;
  model: string;
};

export interface UsageAggregationQuery {
  since: number;
  through: number;
  granularity: UsageAggregationGranularity;
  runnerId?: string;
  workspaceId?: string;
  agentId?: string;
  driver?: AgentDriverKind;
}

export interface NewSessionInput {
  id: string;
  runnerId: string;
  workspaceId: string | null;
  /** CP-owned grouping. Omitted callers are inferred from the exact active runner/workspace link. */
  projectId?: string | null;
  projectLocationId?: string | null;
  agentId: string | null;
  title: string;
  titleSource?: SessionTitleSource;
  useWorktree: boolean;
  executionTarget?: ExecutionTargetRef;
  executionHandoffRequest?: ExecutionHandoffRequest;
  /** Internal auxiliary sessions may be hidden from ordinary lists at first publication. */
  archived?: boolean;
  runId?: string | null;
  driver: AgentDriverKind;
  config: SessionConfig;
  /** Ad-hoc browsed directory (when workspaceId is null); lets restart re-launch from it. */
  workspacePath?: string | null;
  acpSessionContext?: AcpSessionContextConfig;
  /** Server-derived ownership; callers must never copy this from an untrusted request body. */
  scope?: ResourceScope;
  now: number;
}

/** Full box record the SSH orchestrator needs to (re)bootstrap a box's runner. */
export interface BoxConfig {
  boxId: string;
  runnerId: string;
  sshTarget: string;
  sshPort: number;
  workspaces: { id: string; name: string; path: string }[];
  autoReconnect: boolean;
  deployedVersion: string | null;
  /** Target triple detected on a previous bootstrap; null until first detection. */
  triple: string | null;
  /** Server-derived home-relative root for new managed boxes; null preserves the legacy default. */
  runnerDataDir: string | null;
  /** Durable one-time authorization carried across CP restarts until exact registration. */
  pendingLegacyDataAdoptionEpoch: string | null;
  /** Latest authorization, including completed rows; non-null makes authorization create-once. */
  legacyDataAdoptionEpoch: string | null;
  /** Canonical durable state for the legacy root shared by this exact SSH target and port. */
  legacyDataAccountStatus: "unclaimed" | "pending" | "adopted";
}

export interface NewBoxInput {
  boxId: string;
  runnerId: string;
  sshTarget: string;
  sshPort: number;
  workspaces: { id: string; name: string; path: string }[];
  autoReconnect: boolean;
  /** Server-derived home-relative runner root. Null is reserved for migrated legacy rows. */
  runnerDataDir?: string | null;
  /** Server-derived ownership reserved before the runner's first registration. */
  scope?: ResourceScope;
  now: number;
}

export interface AutomationCommandRecord extends AutomationCommandView {
  payloadJson: string;
  payloadSha256: string;
  expiresAt: number;
  dependencyCommandId?: string;
  nextAttemptAt?: number;
  errorCode?: DurableSessionCommandErrorCode;
  duplicate?: boolean;
  userEventSeq?: number;
}

export type SessionPromptCommandState = "pending" | "sent" |
  "accepted" | "queued" | "started" | "completed" | "failed" | "uncertain";

export interface SessionPromptCommandRecord {
  commandId: string;
  sessionId: string;
  runnerId: string;
  payloadJson: string;
  payloadSha256: string;
  state: SessionPromptCommandState;
  revision: number;
  attemptCount: number;
  nextAttemptAt: number | null;
  expiresAt: number;
  error?: string;
  errorCode?: DurableSessionCommandErrorCode;
  userEventSeq?: number;
  dismissedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationTriggerRecord extends AutomationTriggerView {
  secret: string;
}

export interface AutomationTriggerInvocationRecord extends AutomationTriggerInvocationView {
  automationId: string;
  automationRevision: number;
  specJson: string;
  bodySha256: string;
  senderHash?: string;
}

interface LegacyProjectLocationCandidate {
  runnerId: string;
  workspaceId: string;
  name: string;
  path: string;
  source: ProjectLocationSource;
}

/** One-time, exact-identity migration from the workspace-shaped legacy model. It deliberately does
 * not merge equal names: runner/workspace is the only legacy identity strong enough to trust. */
function backfillLegacyProjects(db: DatabaseSync, now: number): void {
  const marker = db.prepare("SELECT value FROM control_plane_metadata WHERE key='project_domain_v1_backfilled'")
    .get() as unknown as { value: string } | undefined;
  if (marker?.value === "1") return;

  db.exec("BEGIN IMMEDIATE");
  try {
    const candidates = new Map<string, LegacyProjectLocationCandidate>();
    const keyFor = (runnerId: string, workspaceId: string) => JSON.stringify([runnerId, workspaceId]);
    const add = (candidate: LegacyProjectLocationCandidate) => {
      const key = keyFor(candidate.runnerId, candidate.workspaceId);
      if (!candidates.has(key)) candidates.set(key, candidate);
    };

    const reported = db.prepare("SELECT runner_id, id, name, path FROM workspaces ORDER BY runner_id, id")
      .all() as unknown as Array<{ runner_id: string; id: string; name: string; path: string }>;
    for (const row of reported) add({
      runnerId: row.runner_id, workspaceId: row.id, name: row.name, path: row.path, source: "reported",
    });
    const managed = db.prepare("SELECT runner_id, id, name, path FROM workspace_extras ORDER BY runner_id, id")
      .all() as unknown as Array<{ runner_id: string; id: string; name: string; path: string }>;
    for (const row of managed) add({
      runnerId: row.runner_id, workspaceId: row.id, name: row.name, path: row.path, source: "managed",
    });
    const sessionLocations = db.prepare(
      `SELECT runner_id, workspace_id, MAX(CASE WHEN workspace_path IS NOT NULL AND workspace_path<>'' THEN workspace_path END) AS path
       FROM sessions WHERE workspace_id IS NOT NULL GROUP BY runner_id, workspace_id
       ORDER BY runner_id, workspace_id`,
    ).all() as unknown as Array<{ runner_id: string; workspace_id: string; path: string | null }>;
    for (const row of sessionLocations) add({
      runnerId: row.runner_id,
      workspaceId: row.workspace_id,
      name: row.workspace_id,
      path: row.path ?? "",
      source: "legacy",
    });

    const overrideRows = db.prepare("SELECT runner_id, workspace_id, display_name FROM workspace_overrides")
      .all() as unknown as Array<{ runner_id: string; workspace_id: string; display_name: string | null }>;
    const overrides = new Map(overrideRows
      .filter((row) => Boolean(row.display_name?.trim()))
      .map((row) => [keyFor(row.runner_id, row.workspace_id), row.display_name!.trim()]));

    const findExisting = db.prepare(
      "SELECT id FROM project_locations WHERE runner_id=? AND workspace_id=? LIMIT 1",
    );
    const insertProject = db.prepare(
      `INSERT INTO projects (id, name, name_source, hidden_at, default_location_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?)`,
    );
    const insertOwnership = db.prepare(
      `INSERT INTO project_ownership
       (project_id, organization_id, owner_kind, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertLocation = db.prepare(
      `INSERT INTO project_locations
       (id, project_id, runner_id, workspace_id, name, path, source, last_seen_at,
        detached_at, removed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    );
    const updateDefault = db.prepare("UPDATE projects SET default_location_id=? WHERE id=?");
    const workspaceScope = db.prepare(
      `SELECT organization_id, owner_kind, owner_id FROM workspace_ownership
       WHERE runner_id=? AND workspace_id=?`,
    );
    const runnerScope = db.prepare(
      "SELECT organization_id, owner_kind, owner_id FROM runner_ownership WHERE runner_id=?",
    );
    const sessionScope = db.prepare(
      `SELECT ownership.organization_id, ownership.owner_kind, ownership.owner_id
       FROM sessions session JOIN session_ownership ownership ON ownership.session_id=session.id
       WHERE session.runner_id=? AND session.workspace_id=? ORDER BY session.created_at, session.id LIMIT 1`,
    );
    type ScopeRow = { organization_id: string; owner_kind: "organization" | "user" | "team"; owner_id: string };

    for (const [key, candidate] of candidates) {
      if (findExisting.get(candidate.runnerId, candidate.workspaceId)) continue;
      const name = overrides.get(key) ?? candidate.name;
      const nameSource: ProjectNameSource = overrides.has(key) ? "user" : "workspace";
      const projectId = `prj_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const locationId = `loc_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const scope = (workspaceScope.get(candidate.runnerId, candidate.workspaceId) ??
        runnerScope.get(candidate.runnerId) ??
        sessionScope.get(candidate.runnerId, candidate.workspaceId)) as unknown as ScopeRow | undefined;
      const fallback: ScopeRow = {
        organization_id: PERSONAL_ORGANIZATION_ID,
        owner_kind: "organization",
        owner_id: PERSONAL_ORGANIZATION_ID,
      };
      const resolvedScope = scope ?? fallback;
      insertProject.run(projectId, name, nameSource, now, now);
      insertOwnership.run(
        projectId,
        resolvedScope.organization_id,
        resolvedScope.owner_kind,
        resolvedScope.owner_id,
        now,
        now,
      );
      insertLocation.run(
        locationId,
        projectId,
        candidate.runnerId,
        candidate.workspaceId,
        candidate.name,
        candidate.path,
        candidate.source,
        candidate.source === "legacy" ? null : now,
        now,
        now,
      );
      updateDefault.run(locationId, projectId);
    }

    db.exec(
      `UPDATE sessions SET
         project_location_id=(SELECT location.id FROM project_locations location
           WHERE location.runner_id=sessions.runner_id AND location.workspace_id=sessions.workspace_id
             AND location.detached_at IS NULL AND location.removed_at IS NULL LIMIT 1),
         project_id=(SELECT location.project_id FROM project_locations location
           WHERE location.runner_id=sessions.runner_id AND location.workspace_id=sessions.workspace_id
             AND location.detached_at IS NULL AND location.removed_at IS NULL LIMIT 1)
       WHERE workspace_id IS NOT NULL AND project_id IS NULL`,
    );
    db.exec(
      `UPDATE sessions SET project_id=NULL, project_location_id=NULL
       WHERE project_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM project_ownership project_owner
         JOIN session_ownership session_owner ON session_owner.session_id=sessions.id
         WHERE project_owner.project_id=sessions.project_id
           AND project_owner.organization_id=session_owner.organization_id
           AND (project_owner.owner_kind='organization' OR
                (project_owner.owner_kind=session_owner.owner_kind AND project_owner.owner_id=session_owner.owner_id))
       )`,
    );
    db.prepare(
      "INSERT OR REPLACE INTO control_plane_metadata (key, value) VALUES ('project_domain_v1_backfilled', '1')",
    ).run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export interface StageAutomationDeliveryPlanInput {
  executionId: string;
  runnerId: string;
  sessionId?: string;
  runId?: string;
  workflowInstanceId?: string;
  planJson: string;
  commands: Array<{
    commandId: string;
    ordinal: number;
    runnerId: string;
    sessionId: string;
    kind: AutomationCommandView["kind"];
    payloadJson: string;
    payloadSha256: string;
    expiresAt?: number;
    dependencyCommandId?: string;
  }>;
  now: number;
}

export interface RecordAutomationCommandReceiptInput {
  commandId: string;
  runnerId: string;
  sessionId?: string;
  requestId?: string;
  state: AutomationCommandState;
  revision: number;
  error?: string;
  code?: DurableSessionCommandErrorCode;
  duplicate?: boolean;
  userEventSeq?: number;
  now: number;
}

export type PolicyHookApprovalStatus = "queued" | "pending" | "allowed" | "denied" | "timed_out";

export interface PolicyHookApprovalRecord {
  requestId: string;
  sessionId: string;
  requestFingerprint: string;
  governancePolicyId: string;
  approval?: PendingApproval;
  status: PolicyHookApprovalStatus;
  expiresAt?: number;
  lastPolledAt: number;
  resumeStatus?: "idle";
  createdAt: number;
  resolvedAt?: number;
}

export type BeginPolicyHookApprovalResult =
  | { kind: "created"; approval: PolicyHookApprovalRecord }
  | { kind: "existing"; approval: PolicyHookApprovalRecord }
  | { kind: "conflict"; occupiedBy?: string };

export interface CreateTranscriptShareRecordInput {
  shareId: string;
  tokenHash: string;
  sessionId: string;
  organizationId: string;
  createdByUserId: string;
  projectionJson: string;
  projectionBytes: number;
  snapshotThroughSeq: number;
  schemaVersion: number;
  createdAt: number;
  expiresAt: number;
}

export interface SessionNamingHarnessTargetRecord {
  runnerId: string;
  agentId: string;
  driver: SessionNamingHarnessOption["driver"];
  context?: AgentContext;
  provider?: SessionNamingAccountBoundary["provider"];
  billingSource?: SessionNamingAccountBoundary["billingSource"];
  model: string;
  effort: string;
  updatedAt: number;
}

export interface AgentHarnessDefaultRecord extends AgentHarnessIdentity {
  config: AgentHarnessDefaultConfig;
  updatedAt: number;
}

type SessionNamingHarnessTargetWrite = Omit<SessionNamingHarnessTargetRecord, "updatedAt">;
type ConfirmedSessionNamingHarnessTargetWrite = SessionNamingHarnessTargetWrite & Required<
  Pick<SessionNamingHarnessTargetWrite, "context" | "provider" | "billingSource">
>;

export class ControlPlaneDb {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly artifactBlobs: ArtifactBlobStore,
    private readonly controlPlaneInstanceId: string,
  ) {}

  /** Compiled-statement cache. Every hot path (one appendEvent + two sessionViews per streamed
   * delta) was re-`prepare()`ing its SQL from text on each call; SQL strings here are static
   * (two listSessions variants), so the cache is small and lives as long as the DB. */
  private readonly stmts = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  private lastTelemetryPrune = 0;
  private lastUsageMaintenance = 0;
  /** Model rate table used to price parentless usage the provider did not cost. Injected by the
   * rate-table service; `null` leaves such records unpriced (tokens counted, cost a lower bound). */
  private usageRateTable: RateTable | null = null;

  setUsageRateTable(table: RateTable | null): void {
    this.usageRateTable = table;
  }
  private lastMutationAuditArchive = 0;
  private mutationAuditWritesSinceArchive = 0;
  private stmt(sql: string): ReturnType<DatabaseSync["prepare"]> {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private atomic<T>(work: () => T): T {
    if ((this.db as DatabaseSync & { isTransaction?: boolean }).isTransaction) return work();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  static open(location: string, options: { artifactBlobDir?: string } = {}): ControlPlaneDb {
    if (location !== ":memory:") mkdirSync(dirname(location), { recursive: true });
    const artifactBlobs = location === ":memory:" && !options.artifactBlobDir
      ? new MemoryArtifactBlobStore()
      : new FileArtifactBlobStore(options.artifactBlobDir ?? defaultArtifactBlobRoot(location));
    const db = new DatabaseSync(location);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA secure_delete = ON;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    const namingPreferenceSchema = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_naming_preferences'",
    ).get() as { sql?: string } | undefined;
    if (!namingPreferenceSchema?.sql?.includes("session_agent_account")) {
      db.exec("PRAGMA foreign_keys = OFF;");
      try {
        db.exec(`
          BEGIN;
          CREATE TABLE session_naming_preferences_v2 (
            organization_id TEXT PRIMARY KEY,
            mode TEXT NOT NULL CHECK (mode IN ('prompt_text_only','session_agent_account','custom_model_endpoint')),
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (organization_id) REFERENCES identity_organizations(organization_id) ON DELETE CASCADE
          );
          INSERT INTO session_naming_preferences_v2 (organization_id, mode, updated_at)
            SELECT organization_id, mode, updated_at FROM session_naming_preferences;
          DROP TABLE session_naming_preferences;
          ALTER TABLE session_naming_preferences_v2 RENAME TO session_naming_preferences;
          COMMIT;
        `);
      } catch (error) {
        try { db.exec("ROLLBACK;"); } catch { /* no active transaction */ }
        throw error;
      } finally {
        db.exec("PRAGMA foreign_keys = ON;");
      }
    }
    for (const column of [
      "context_kind TEXT CHECK (context_kind IN ('native','wsl'))",
      "context_distro TEXT",
      "provider TEXT CHECK (provider IN ('codex','claude'))",
      "billing_source TEXT CHECK (billing_source IN ('subscription','api','bedrock','vertex','gateway','provider_account','unknown'))",
    ]) {
      try {
        db.exec(`ALTER TABLE session_naming_harness_targets ADD COLUMN ${column}`);
      } catch {
        /* column already present */
      }
    }
    db.prepare("INSERT OR IGNORE INTO background_push_receipt_secret (id, secret) VALUES (1, ?)")
      .run(randomBytes(32).toString("base64url"));
    try {
      db.exec(
        "ALTER TABLE managed_background_jobs ADD COLUMN source_present INTEGER NOT NULL DEFAULT 1 CHECK (source_present IN (0, 1))",
      );
    } catch {
      /* column already present */
    }
    for (const column of [
      "status_settlement_pending_at INTEGER",
      "status_settled_at INTEGER",
    ]) {
      try {
        db.exec(`ALTER TABLE managed_background_deliveries ADD COLUMN ${column}`);
      } catch {
        /* column already present */
      }
    }
    for (const column of [
      "attempt_count INTEGER NOT NULL DEFAULT 0",
      "next_attempt_at INTEGER",
    ]) {
      try {
        db.exec(`ALTER TABLE session_command_invocations ADD COLUMN ${column}`);
      } catch {
        /* column already present */
      }
    }
    db.exec(
      `UPDATE session_command_invocations SET next_attempt_at=updated_at
       WHERE next_attempt_at IS NULL AND state IN ('pending','sent')`,
    );
    try {
      db.exec("ALTER TABLE session_prompt_commands ADD COLUMN dismissed_at INTEGER");
    } catch {
      /* column already present */
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_session_command_invocations_due
       ON session_command_invocations(next_attempt_at,runner_id)
       WHERE state IN ('pending','sent')`,
    );
    for (const column of [
      "queue_revision_at_create INTEGER NOT NULL DEFAULT 0",
      "queue_absent_at INTEGER",
      "resolution_action TEXT CHECK (resolution_action IN ('queue_again','dismiss'))",
      "resolution_request_id TEXT",
      "resolution_receipt_json TEXT",
      "resolution_requested_at INTEGER",
    ]) {
      try {
        db.exec(`ALTER TABLE session_steering_attempts ADD COLUMN ${column}`);
      } catch {
        /* column already present */
      }
    }
    // Poller liveness is separate from the optional human approval deadline. A pre-column open
    // row gets one full grace horizon after upgrade: its sidecar could have polled moments before
    // this process reopened the database, and creation time cannot prove abandonment.
    try {
      db.exec("ALTER TABLE policy_hook_approvals ADD COLUMN last_polled_at INTEGER");
    } catch {
      /* column already present */
    }
    db.prepare(
      `UPDATE policy_hook_approvals
       SET last_polled_at=CASE WHEN status IN ('queued','pending') THEN ? ELSE created_at END
       WHERE last_polled_at IS NULL`,
    ).run(Date.now());
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_policy_hook_approvals_status_polled
       ON policy_hook_approvals(status, last_polled_at, session_id)`,
    );
    try {
      db.exec("ALTER TABLE policy_hook_approvals ADD COLUMN resume_status TEXT");
    } catch {
      /* column already present */
    }
    try {
      db.exec("ALTER TABLE sessions ADD COLUMN policy_resume_status TEXT");
    } catch {
      /* column already present */
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_governance_audit_created
       ON governance_audit(created_at, row_id)`,
    );
    // Shared Locations: the original Project domain made one active runner/workspace globally
    // unique. Preserve every existing link row while changing that constraint to one active link
    // per Project. The non-unique physical lookup supports ambiguity-aware legacy inference.
    db.exec(`
      DROP INDEX IF EXISTS idx_project_locations_active_workspace;
      CREATE INDEX idx_project_locations_active_workspace
        ON project_locations(runner_id, workspace_id)
        WHERE detached_at IS NULL AND removed_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_project_locations_active_project_workspace
        ON project_locations(project_id, runner_id, workspace_id)
        WHERE detached_at IS NULL AND removed_at IS NULL;
    `);
    // The installation identity belongs to the database, not the process or network endpoint.
    // INSERT OR IGNORE makes first-open initialization idempotent; a moved/reopened database
    // remains the same control plane while independent databases always receive distinct ids.
    db.prepare("INSERT OR IGNORE INTO control_plane_metadata (key, value) VALUES ('instance_id', ?)")
      .run(randomUUID());
    const instanceId = (
      db.prepare("SELECT value FROM control_plane_metadata WHERE key='instance_id'").get() as
        unknown as { value?: unknown } | undefined
    )?.value;
    if (typeof instanceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(instanceId)) {
      db.close();
      throw new Error("control-plane database has an invalid instance identity");
    }
    // v58 terminal-retention accounting. Keep schema addition, backfill, and trigger creation in
    // one migration transaction so a crash cannot strand pre-existing rows at zero forever.
    db.exec("BEGIN IMMEDIATE");
    try {
      let addedShellOutputCounters = false;
      for (const column of [
        "output_chars INTEGER NOT NULL DEFAULT 0",
        "output_chunks INTEGER NOT NULL DEFAULT 0",
      ]) {
        try {
          db.exec(`ALTER TABLE session_shells ADD COLUMN ${column}`);
          addedShellOutputCounters = true;
        } catch {
          /* column already present */
        }
      }
      const incompleteBackfill = db.prepare(
        `SELECT 1 AS present FROM session_shells shell
         WHERE shell.output_chunks=0 AND EXISTS (
           SELECT 1 FROM session_shell_output output WHERE output.shell_id=shell.shell_id
         ) LIMIT 1`,
      ).get();
      if (addedShellOutputCounters || incompleteBackfill) {
        db.exec(
          `UPDATE session_shells SET
             output_chars=COALESCE((SELECT SUM(LENGTH(data)) FROM session_shell_output output
               WHERE output.shell_id=session_shells.shell_id), 0),
             output_chunks=(SELECT COUNT(*) FROM session_shell_output output
               WHERE output.shell_id=session_shells.shell_id)`,
        );
      }
      db.exec(
        `CREATE TRIGGER IF NOT EXISTS session_shell_output_insert_stats
         AFTER INSERT ON session_shell_output BEGIN
           UPDATE session_shells SET output_chars=output_chars+LENGTH(NEW.data),
             output_chunks=output_chunks+1 WHERE shell_id=NEW.shell_id;
         END;
         CREATE TRIGGER IF NOT EXISTS session_shell_output_delete_stats
         AFTER DELETE ON session_shell_output BEGIN
           UPDATE session_shells SET output_chars=MAX(0, output_chars-LENGTH(OLD.data)),
             output_chunks=MAX(0, output_chunks-1) WHERE shell_id=OLD.shell_id;
         END;`,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    try {
      db.exec("ALTER TABLE usage_session_state ADD COLUMN cost_remainder_picousd INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* column already present */
    }
    // v103 usage ledger: the five token buckets, cache savings, and cost provenance counters.
    // Additive with zero defaults so pre-existing buckets keep aggregating unchanged.
    for (const table of ["usage_session_state", "usage_hourly", "usage_daily"]) {
      for (const column of USAGE_LEDGER_V103_COLUMNS) {
        try {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
        } catch {
          /* column already present */
        }
      }
    }
    // Item 11 identity foundation. Existing personal deployments gain one stable bootstrap
    // organization/owner, and every pre-identity device is scoped to it. The additive device
    // columns keep old databases readable without replacing the token-bearing table.
    for (const column of ["user_id TEXT", "organization_id TEXT"]) {
      try {
        db.exec(`ALTER TABLE devices ADD COLUMN ${column}`);
      } catch {
        /* column already present */
      }
    }
    {
      const now = Date.now();
      db.exec("BEGIN");
      try {
        db.prepare(
          `INSERT OR IGNORE INTO identity_users
           (user_id, display_name, status, created_at, updated_at) VALUES (?, 'Local owner', 'active', ?, ?)`,
        ).run(LOCAL_OWNER_USER_ID, now, now);
        db.prepare(
          `INSERT OR IGNORE INTO identity_organizations
           (organization_id, name, created_at, updated_at) VALUES (?, 'Personal organization', ?, ?)`,
        ).run(PERSONAL_ORGANIZATION_ID, now, now);
        db.prepare(
          `INSERT OR IGNORE INTO identity_memberships
           (organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?)`,
        ).run(PERSONAL_ORGANIZATION_ID, LOCAL_OWNER_USER_ID, now, now);
        db.prepare(
          "UPDATE devices SET user_id=COALESCE(user_id, ?), organization_id=COALESCE(organization_id, ?)",
        ).run(LOCAL_OWNER_USER_ID, PERSONAL_ORGANIZATION_ID);
        db.prepare(
          `INSERT OR IGNORE INTO runner_ownership
           (runner_id, organization_id, owner_kind, owner_id, created_at, updated_at)
           SELECT runner_id, ?, 'organization', ?, ?, ? FROM runners`,
        ).run(PERSONAL_ORGANIZATION_ID, PERSONAL_ORGANIZATION_ID, now, now);
        db.prepare(
          `INSERT OR IGNORE INTO workspace_ownership
           (runner_id, workspace_id, organization_id, owner_kind, owner_id, created_at, updated_at)
           SELECT runner_id, id, ?, 'organization', ?, ?, ? FROM workspaces`,
        ).run(PERSONAL_ORGANIZATION_ID, PERSONAL_ORGANIZATION_ID, now, now);
        db.prepare(
          `INSERT OR IGNORE INTO session_ownership
           (session_id, organization_id, owner_kind, owner_id, created_at, updated_at)
           SELECT id, ?, 'organization', ?, ?, ? FROM sessions`,
        ).run(PERSONAL_ORGANIZATION_ID, PERSONAL_ORGANIZATION_ID, now, now);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    const sharePruneNow = Date.now();
    db.prepare(
      "UPDATE transcript_shares SET projection_json=NULL WHERE projection_json IS NOT NULL AND (revoked_at IS NOT NULL OR expires_at<=?)",
    ).run(sharePruneNow);
    db.prepare(
      `DELETE FROM transcript_shares WHERE share_id IN (
         SELECT share_id FROM (
           SELECT share_id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at DESC, share_id DESC) AS ordinal
           FROM transcript_shares WHERE revoked_at IS NOT NULL OR expires_at<=?
         ) WHERE ordinal>?
       )`,
    ).run(sharePruneNow, TRANSCRIPT_SHARE_TERMINAL_RETENTION_PER_SESSION);
    // Additive prerelease migration for databases that saw the scheduler before immutable
    // execution provenance was added. Old executions remain readable without a snapshot.
    for (const [table, column] of [
      ["automations", "revision INTEGER NOT NULL DEFAULT 1"],
      ["automation_executions", "automation_revision INTEGER NOT NULL DEFAULT 1"],
      ["automation_executions", "spec_json TEXT"],
      ["automation_executions", "delivery_mode TEXT NOT NULL DEFAULT 'legacy_at_most_once'"],
      ["automation_executions", "delivery_plan_json TEXT"],
    ] as const) {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
      } catch {
        /* column already present */
      }
    }
    let addedTriggerCounters = false;
    for (const column of [
      "invocation_count INTEGER NOT NULL DEFAULT 0",
      "last_invoked_at INTEGER",
    ]) {
      try {
        db.exec(`ALTER TABLE automation_triggers ADD COLUMN ${column}`);
        addedTriggerCounters = true;
      } catch {
        /* column already present */
      }
    }
    if (addedTriggerCounters) {
      db.exec(
        `UPDATE automation_triggers SET
           invocation_count=(SELECT COUNT(*) FROM automation_trigger_invocations invocation
             WHERE invocation.trigger_id=automation_triggers.trigger_id),
           last_invoked_at=(SELECT MAX(received_at) FROM automation_trigger_invocations invocation
             WHERE invocation.trigger_id=automation_triggers.trigger_id)`,
      );
    }
    let addedPodRoleColumn = false;
    for (const column of [
      "role TEXT NOT NULL DEFAULT 'worker'",
      "context_token_budget INTEGER",
      "last_context_seq INTEGER NOT NULL DEFAULT 0",
    ]) {
      try {
        db.exec(`ALTER TABLE pod_members ADD COLUMN ${column}`);
        if (column.startsWith("role ")) addedPodRoleColumn = true;
      } catch {
        /* column already present */
      }
    }
    if (addedPodRoleColumn) {
      // Only legacy pods need a deterministic initial lead. Re-running this backfill on every open
      // would overwrite an operator's intentional lead-less role configuration after restart.
      db.exec(
        `UPDATE pod_members AS member SET role='lead'
         WHERE member.session_id=(
           SELECT first.session_id FROM pod_members AS first
           WHERE first.pod_id=member.pod_id ORDER BY first.joined_at, first.session_id LIMIT 1
         ) AND NOT EXISTS (
           SELECT 1 FROM pod_members AS existing WHERE existing.pod_id=member.pod_id AND existing.role='lead'
         )`,
      );
    }
    db.exec(
      `INSERT OR IGNORE INTO pod_orchestration
       (pod_id, mode, context_token_budget, summary_token_budget, max_turns, max_repeated_outputs,
        status, turns_used, updated_at)
       SELECT id, 'manual', 4096, 512, 12, 2, 'idle', 0, updated_at FROM pods`,
    );
    const workflowArtifactParent = () => (
      db.prepare("PRAGMA foreign_key_list(workflow_attempt_artifacts)").all() as unknown as Array<{
        table: string;
        from: string;
      }>
    ).find((foreignKey) => foreignKey.from === "artifact_id")?.table;
    const rebuildWorkflowArtifactAssociations = () => {
      db.exec(`CREATE TABLE workflow_attempt_artifacts_repaired ${WORKFLOW_ATTEMPT_ARTIFACT_COLUMNS}`);
      db.exec(
        `INSERT INTO workflow_attempt_artifacts_repaired (attempt_id, contract_name, artifact_id)
         SELECT attempt_id, contract_name, artifact_id FROM workflow_attempt_artifacts`,
      );
      db.exec("DROP TABLE workflow_attempt_artifacts");
      db.exec("ALTER TABLE workflow_attempt_artifacts_repaired RENAME TO workflow_attempt_artifacts");
    };
    const steeringArtifactParent = () => (
      db.prepare("PRAGMA foreign_key_list(session_steering_attempt_artifacts)").all() as unknown as Array<{
        table: string;
        from: string;
      }>
    ).find((foreignKey) => foreignKey.from === "artifact_id")?.table;
    const rebuildSteeringArtifactAssociations = () => {
      db.exec(`CREATE TABLE session_steering_attempt_artifacts_repaired ${STEERING_ATTEMPT_ARTIFACT_COLUMNS}`);
      db.exec(
        `INSERT INTO session_steering_attempt_artifacts_repaired (request_id, artifact_id)
         SELECT request_id, artifact_id FROM session_steering_attempt_artifacts`,
      );
      db.exec("DROP TABLE session_steering_attempt_artifacts");
      db.exec("ALTER TABLE session_steering_attempt_artifacts_repaired RENAME TO session_steering_attempt_artifacts");
      db.exec(
        `CREATE INDEX idx_session_steering_attempt_artifacts_artifact
         ON session_steering_attempt_artifacts(artifact_id, request_id)`,
      );
    };
    const sessionEventArtifactTableExists = () => Boolean(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_event_artifacts'",
    ).get());
    const sessionEventArtifactNeedsRepair = () => {
      if (!sessionEventArtifactTableExists()) return false;
      const columns = db.prepare("PRAGMA table_info(session_event_artifacts)").all() as unknown as Array<{
        name: string;
        pk: number;
      }>;
      const foreignKeys = db.prepare("PRAGMA foreign_key_list(session_event_artifacts)").all() as unknown as Array<{
        table: string;
        from: string;
      }>;
      return columns.find((column) => column.name === "event_id")?.pk !== 1 ||
        columns.find((column) => column.name === "artifact_id")?.pk !== 2 ||
        foreignKeys.find((foreignKey) => foreignKey.from === "artifact_id")?.table !== "artifacts";
    };
    const rebuildSessionEventArtifactAssociations = () => {
      db.exec(`CREATE TABLE session_event_artifacts_repaired ${SESSION_EVENT_ARTIFACT_COLUMNS}`);
      db.exec(
        `INSERT OR IGNORE INTO session_event_artifacts_repaired (event_id,artifact_id)
         SELECT event_id,artifact_id FROM session_event_artifacts`,
      );
      db.exec("DROP TABLE session_event_artifacts");
      db.exec("ALTER TABLE session_event_artifacts_repaired RENAME TO session_event_artifacts");
      db.exec(
        `CREATE INDEX idx_session_event_artifacts_event
           ON session_event_artifacts(event_id,artifact_id);
         CREATE INDEX idx_session_event_artifacts_artifact
           ON session_event_artifacts(artifact_id,event_id);`,
      );
    };
    const artifactColumns = db.prepare("PRAGMA table_info(artifacts)").all() as unknown as Array<{ name: string }>;
    if (!artifactColumns.some((column) => column.name === "run_id")) {
      const legacy = db.prepare("SELECT id, session_id, kind, path, data, created_at FROM artifacts").all() as unknown as Array<{
        id: string;
        session_id: string;
        kind: string;
        path: string | null;
        data: string | null;
        created_at: number;
      }>;
      db.exec("BEGIN");
      try {
        db.exec("ALTER TABLE artifacts RENAME TO artifacts_legacy_v1");
        db.exec(ARTIFACT_TABLE_SCHEMA);
        const insert = db.prepare(
          `INSERT INTO artifacts
           (id, run_id, session_id, kind, name, mime_type, encoding, data, size_bytes, sha256,
            created_by_kind, created_by_id, metadata, created_at)
           VALUES (?, NULL, ?, ?, ?, ?, 'utf8', ?, ?, ?, 'system', 'legacy-migration', NULL, ?)`,
        );
        for (const row of legacy) {
          const data = row.data ?? "";
          const bytes = Buffer.from(data, "utf8");
          const kind = (["patch", "review_report", "test_log", "verdict"] as string[]).includes(row.kind)
            ? row.kind
            : "test_log";
          const mimeType = kind === "patch" ? "text/x-diff" : kind === "review_report" ? "text/markdown" : kind === "verdict" ? "application/json" : "text/plain";
          insert.run(
            row.id,
            row.session_id,
            kind,
            (row.path?.split(/[\\/]/).pop() || `legacy-${row.id}`).slice(0, 160),
            mimeType,
            data,
            bytes.length,
            createHash("sha256").update(bytes).digest("hex"),
            row.created_at,
          );
        }
        // ALTER TABLE rewrites child foreign keys to the temporary legacy table. Rebuild the
        // association before dropping that table so data-bearing prerelease databases migrate
        // without tripping foreign-key enforcement or losing workflow outputs.
        if (workflowArtifactParent() !== "artifacts") rebuildWorkflowArtifactAssociations();
        if (steeringArtifactParent() !== "artifacts") rebuildSteeringArtifactAssociations();
        if (sessionEventArtifactNeedsRepair()) rebuildSessionEventArtifactAssociations();
        db.exec("DROP TABLE artifacts_legacy_v1");
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    // SQLite rewrites foreign-key targets when a referenced table is renamed. Older databases
    // therefore had workflow_attempt_artifacts.artifact_id retargeted to artifacts_legacy_v1 by
    // the artifact-table migration above, immediately before that temporary table was dropped.
    // Rebuild the association table so upgraded databases can validate cascades (including box
    // and runner removal) and continue recording workflow outputs.
    if (workflowArtifactParent() !== "artifacts") {
      db.exec("BEGIN");
      try {
        rebuildWorkflowArtifactAssociations();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    if (steeringArtifactParent() !== "artifacts") {
      db.exec("BEGIN");
      try {
        rebuildSteeringArtifactAssociations();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    if (sessionEventArtifactNeedsRepair()) {
      db.exec("BEGIN");
      try {
        rebuildSessionEventArtifactAssociations();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    db.exec(ARTIFACT_INDEX_SCHEMA);
    db.exec(STEERING_OWNED_PROMPT_IMAGE_SCHEMA);
    db.exec(PREPARED_PROMPT_IMAGE_SCHEMA);
    db.exec(SESSION_EVENT_ARTIFACT_REFERENCE_SCHEMA);
    if (sessionEventArtifactNeedsRepair()) {
      db.exec("BEGIN");
      try {
        rebuildSessionEventArtifactAssociations();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    if (!artifactColumns.some((column) => column.name === "blob_key")) {
      try {
        db.exec("ALTER TABLE artifacts ADD COLUMN blob_key TEXT");
      } catch {
        /* A legacy-table rebuild above may already have created the column. */
      }
    }
    db.exec(ARTIFACT_BLOB_SCHEMA);
    // Phase 7.3 execution columns are additive because Phase 7.2 may already have created these
    // durable tables in a user database.
    for (const [table, column] of [
      ["workflow_node_states", "ready_at INTEGER"],
      ["workflow_node_states", "outcome TEXT"],
      ["workflow_attempts", "deadline_at INTEGER NOT NULL DEFAULT 0"],
    ] as const) {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
      } catch {
        /* column already present */
      }
    }
    try {
      db.exec("ALTER TABLE governance_audit ADD COLUMN governance_policy_id TEXT");
    } catch {
      /* column already present */
    }
    try {
      db.exec("ALTER TABLE governance_policies ADD COLUMN ask_timeout INTEGER");
    } catch {
      /* column already present */
    }
    for (const column of [
      "remote_provider TEXT",
      "remote_repository TEXT",
      "remote_pr_number INTEGER",
      "remote_thread_id TEXT",
      "remote_comment_id INTEGER",
      "remote_url TEXT",
      "remote_commit_id TEXT",
      "remote_outdated INTEGER",
      "remote_subject_type TEXT",
      "remote_synchronized_at INTEGER",
    ]) {
      try {
        db.exec(`ALTER TABLE review_findings ADD COLUMN ${column}`);
      } catch {
        /* column already present */
      }
    }
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_review_findings_remote
       ON review_findings(session_id, remote_provider, remote_repository, remote_pr_number, remote_thread_id)
       WHERE remote_thread_id IS NOT NULL`,
    );
    db.prepare("DELETE FROM driver_telemetry_hourly WHERE bucket_ts < ?").run(Date.now() - 180 * 86_400_000);
    // Additive migrations for DBs created before discovery columns existed.
    for (const col of ["version TEXT", "auth_status TEXT", "available INTEGER", "source TEXT", "codex_app_server TEXT", "claude_code TEXT", "acp TEXT", "registry TEXT", "acp_transport TEXT"]) {
      try {
        db.exec(`ALTER TABLE runner_agents ADD COLUMN ${col}`);
      } catch {
        /* column already present */
      }
    }
    for (const col of [
      // PROTOCOL_VERSION the runner registered with (version-skew badge). NULL ⇒ unknown — a
      // pre-v15 runner that never reported one.
      "protocol_version INTEGER",
      // When the runner last pushed a discovery result (agents_updated) since its register. NULL ⇒
      // discovery hasn't reported yet, so an empty agent list means "still probing", not "none
      // installed" — the UI must not show install guidance off it.
      "agents_refreshed_at INTEGER",
      // Editor CLIs discovery found on the host (JSON EditorInfo[]) — the "Open in …" control.
      "editors TEXT",
      // External storage root + box process admission ceiling (v32 diagnostics).
      "runtime TEXT",
      // Protocol v61 runner-checked, digest-pinned container target definitions.
      "container_targets TEXT",
    ]) {
      try {
        db.exec(`ALTER TABLE runners ADD COLUMN ${col}`);
      } catch {
        /* column already present */
      }
    }
    try {
      db.exec("ALTER TABLE workspaces ADD COLUMN additional_directory_grants TEXT");
    } catch {
      /* column already present */
    }
    for (const col of [
      "input_tokens INTEGER NOT NULL DEFAULT 0",
      "output_tokens INTEGER NOT NULL DEFAULT 0",
      "context_tokens_used INTEGER",
      "context_window INTEGER",
      "cost_usd REAL NOT NULL DEFAULT 0",
      // Phase 2: highest runner-owned event seq the cache has ingested (incremental hydration).
      "hydrated_seq INTEGER NOT NULL DEFAULT 0",
      // CP-owned event-log generation. Reprocess increments it so reconnecting dashboards can
      // distinguish a replacement timeline from an append-only history gap.
      "event_epoch INTEGER NOT NULL DEFAULT 0",
      // Protocol v54 runner-owned log generation. NULL means a migrated/pre-v54 row whose current
      // cached events may be adopted into the first known epoch without destructive replacement.
      "runner_history_epoch INTEGER",
      // Last durable runner tail advertised for the current history epoch.
      "runner_history_tail_seq INTEGER NOT NULL DEFAULT 0",
      // adopted-from-CLI marker (gates the reprocess action).
      "adopted INTEGER NOT NULL DEFAULT 0",
      // Phase 7 (cost-budget gating): accumulated-cost ceiling (USD). NULL ⇒ unlimited. CP-only —
      // never overwritten by a runner snapshot (like board_column/archived).
      "cost_budget_usd REAL",
      // Fixed allowance retained while Continue advances the absolute threshold.
      "cost_budget_step_usd REAL",
      // v105 cost governance: ascending soft checkpoints (JSON array of USD), the highest one the
      // user approved, and whether they chose to continue a budgeted session that cannot be priced.
      "cost_checkpoints_usd TEXT",
      "cost_checkpoint_approved_usd REAL",
      "cost_unpriced_ack INTEGER NOT NULL DEFAULT 0",
      // Phase 8 (guardrails): max distinct tool calls. NULL ⇒ unlimited. CP-only, never
      // overwritten by a runner snapshot.
      "max_tool_calls INTEGER",
      "max_tool_calls_step INTEGER",
      // Ad-hoc browsed workspace path (workspace_id is null for these) so restart re-launches from the
      // browsed directory instead of an old configured workspace.
      "workspace_path TEXT",
      // Maintained event counter: sessionView was running COUNT(*) over session_events per view
      // build — twice per streamed delta at the worst. NULL means "not yet counted" (backfilled
      // below; new sessions start NULL and the first appendEvent COALESCEs from 0).
      "message_count INTEGER",
      // Session-scoped live ACP models/modes/commands. Runner-agent capabilities remain the
      // fallback for native and pre-v36 sessions.
      "agent_capabilities TEXT",
      // Exact provider model resolved from a selected alias by a live native session.
      "resolved_model TEXT",
      // Nullable additive form lets the backfill below distinguish legacy rows. Fresh databases
      // use the CREATE TABLE default (`generated`). Existing names are preserved as user-owned.
      "title_source TEXT",
      "semantic_title INTEGER NOT NULL DEFAULT 0",
      "provider_updated_at TEXT",
      "background_work_state TEXT",
      "background_work_tracking TEXT",
      // Secret-free ACP MCP environment references and explicit directory selections.
      "acp_session_context TEXT",
      // Protocol v60 immutable launch placement. NULL identifies legacy sessions.
      "execution_target TEXT",
      // Protocol v62 pre-acceptance source/artifact input and content-safe adapter proof.
      "execution_handoff_request TEXT",
      "execution_handoff TEXT",
      // Durable control-plane project grouping. These never travel to or get overwritten by the
      // runner; workspace_id/workspace_path remain launch-placement metadata.
      "project_id TEXT REFERENCES projects(id) ON DELETE SET NULL",
      "project_location_id TEXT REFERENCES project_locations(id) ON DELETE SET NULL",
      // Runner-authoritative multi-worktree inventory; worktree_path stays the active legacy
      // projection for rolling peers and existing queries.
      "worktrees TEXT",
    ]) {
      try {
        db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`);
      } catch {
        /* column already present */
      }
    }
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, archived, updated_at DESC, id)",
    );
    backfillLegacyProjects(db, Date.now());
    db.exec("UPDATE sessions SET cost_budget_step_usd=cost_budget_usd WHERE cost_budget_step_usd IS NULL AND cost_budget_usd IS NOT NULL");
    db.exec("UPDATE sessions SET max_tool_calls_step=max_tool_calls WHERE max_tool_calls_step IS NULL AND max_tool_calls IS NOT NULL");
    db.exec("UPDATE sessions SET title_source='user' WHERE title_source IS NULL");
    try {
      db.exec("ALTER TABLE session_events ADD COLUMN runner_seq INTEGER");
    } catch {
      /* column already present */
    }
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_session_events_runner_seq
       ON session_events(session_id, runner_seq) WHERE runner_seq IS NOT NULL`,
    );
    // Additive migration for boxes created before the target triple was persisted (the
    // orchestrator re-detects + backfills it on the next bootstrap).
    try {
      db.exec("ALTER TABLE boxes ADD COLUMN triple TEXT");
    } catch {
      /* column already present */
    }
    for (const column of [
      "runner_data_dir TEXT",
      "legacy_adoption_epoch TEXT",
      "legacy_adoption_pending INTEGER NOT NULL DEFAULT 0",
      "legacy_adoption_authorized_by TEXT",
      "legacy_adoption_authorized_role TEXT",
      "legacy_adoption_authorized_at INTEGER",
      "legacy_adoption_completed_at INTEGER",
    ]) {
      try {
        db.exec(`ALTER TABLE boxes ADD COLUMN ${column}`);
      } catch {
        /* column already present */
      }
    }
    // Older databases must receive the rollback-compatible box mirror columns before this
    // backfill is prepared. CREATE TABLE IF NOT EXISTS does not upgrade an existing boxes table,
    // and SQLite resolves SELECT columns even when boxes has no rows.
    db.exec(
      `CREATE TABLE IF NOT EXISTS legacy_ssh_account_adoptions (
         ssh_target TEXT NOT NULL,
         ssh_port INTEGER NOT NULL,
         epoch TEXT NOT NULL,
         status TEXT NOT NULL CHECK (status IN ('pending','completed')),
         adopter_box_id TEXT NOT NULL,
         authorized_by TEXT NOT NULL,
         authorized_role TEXT NOT NULL CHECK (authorized_role IN ('owner','admin')),
         authorized_at INTEGER NOT NULL,
         completed_at INTEGER,
         completed_credential_id TEXT,
         completed_binary_identity TEXT,
         PRIMARY KEY (ssh_target, ssh_port)
       )`,
    );
    db.exec(
      `INSERT OR IGNORE INTO legacy_ssh_account_adoptions
         (ssh_target, ssh_port, epoch, status, adopter_box_id, authorized_by, authorized_role,
          authorized_at, completed_at, completed_binary_identity)
       SELECT trim(ssh_target), ssh_port, legacy_adoption_epoch,
              CASE WHEN legacy_adoption_pending=1 THEN 'pending' ELSE 'completed' END,
              box_id, legacy_adoption_authorized_by, legacy_adoption_authorized_role,
              legacy_adoption_authorized_at, legacy_adoption_completed_at, deployed_version
         FROM boxes
        WHERE legacy_adoption_epoch IS NOT NULL
          AND legacy_adoption_authorized_by IS NOT NULL
          AND legacy_adoption_authorized_role IN ('owner','admin')
          AND legacy_adoption_authorized_at IS NOT NULL
        ORDER BY legacy_adoption_pending DESC, legacy_adoption_authorized_at ASC, box_id ASC`,
    );
    // One-time backfill for rows that predate message_count (and any row that somehow lost it):
    // cheap at open (one scan), and keeps sessionView free of per-row COUNT(*) forever after.
    db.exec(
      `UPDATE sessions SET message_count =
         (SELECT COUNT(*) FROM session_events e WHERE e.session_id = sessions.id)
       WHERE message_count IS NULL`,
    );
    // Full-text transcript search (Cmd+K). A regular FTS5 table (not contentless — those can't
    // delete rows, and session deletion must drop its hits). appendEvent maintains it live;
    // fts_state.last_rowid is the IDEMPOTENT catch-up cursor: any events written past it (an
    // older build without FTS maintenance, a crash between builds) are indexed at the next
    // open — an only-when-empty backfill would leave such drift permanently unsearchable.
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS session_events_fts USING fts5(text, session_id UNINDEXED, seq UNINDEXED)",
    );
    db.exec("CREATE TABLE IF NOT EXISTS fts_state (id INTEGER PRIMARY KEY CHECK (id = 1), last_rowid INTEGER NOT NULL)");
    {
      // First run WITH the cursor: if the FTS table already has rows (populated by a build
      // that predates fts_state), a cursor starting at 0 would re-insert every one of them as
      // a duplicate — rebuild from scratch instead so the transition is deterministic.
      const init = db.prepare("INSERT OR IGNORE INTO fts_state (id, last_rowid) VALUES (1, 0)").run();
      if (Number(init.changes) > 0) db.exec("DELETE FROM session_events_fts");
    }
    {
      const lastRowid =
        (db.prepare("SELECT last_rowid AS v FROM fts_state WHERE id=1").get() as unknown as { v: number }).v;
      const rows = db
        .prepare("SELECT id, session_id, seq, payload FROM session_events WHERE id > ? ORDER BY id")
        .all(lastRowid) as unknown as { id: number; session_id: string; seq: number; payload: string }[];
      if (rows.length) {
        const ins = db.prepare("INSERT INTO session_events_fts(text, session_id, seq) VALUES (?, ?, ?)");
        let max = lastRowid;
        db.exec("BEGIN");
        try {
          for (const r of rows) {
            max = Math.max(max, r.id);
            try {
              const text = searchTextForEvent(JSON.parse(r.payload) as SessionEventPayload);
              if (text) ins.run(text, r.session_id, r.seq);
            } catch {
              /* unparseable payload — skip */
            }
          }
          db.prepare("UPDATE fts_state SET last_rowid=? WHERE id=1").run(max);
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      }
    }
    // Phase 2: tombstones for sessions deleted in the UI, so a runner's later sessionSnapshots
    // (the runner store is the source of truth) can't resurrect them. Ordinary user-delete
    // tombstones clear once the box stops reporting the id. Fork-cleanup tombstones are retained:
    // a timed-out fork may not appear until a later reconnect.
    db.exec(
      `CREATE TABLE IF NOT EXISTS session_tombstones (
         session_id TEXT PRIMARY KEY,
         runner_id  TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         prune_when_absent INTEGER NOT NULL DEFAULT 1 CHECK (prune_when_absent IN (0, 1))
       )`,
    );
    const sessionTombstoneColumns = db.prepare("PRAGMA table_info(session_tombstones)")
      .all() as unknown as Array<{ name: string }>;
    if (!sessionTombstoneColumns.some((column) => column.name === "prune_when_absent")) {
      db.exec(
        "ALTER TABLE session_tombstones ADD COLUMN prune_when_absent INTEGER NOT NULL DEFAULT 1 CHECK (prune_when_absent IN (0, 1))",
      );
    }
    // User stops are durable commands: a socket write is not delivery proof, so retain the
    // intent until runner inventory or status proves that the provider session is terminal/gone.
    db.exec(
      `CREATE TABLE IF NOT EXISTS session_stop_intents (
         session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
         runner_id  TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         restart_launch_id TEXT,
         archive_after_stop INTEGER NOT NULL DEFAULT 0 CHECK (archive_after_stop IN (0, 1)),
         operation_id TEXT,
         last_attempt_at INTEGER,
         attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
         delivery_attempt_id TEXT,
         accepted_at INTEGER,
         failed_at INTEGER,
         failure_code TEXT,
         failure_message TEXT
       )`,
    );
    const stopIntentColumns = db.prepare("PRAGMA table_info(session_stop_intents)")
      .all() as unknown as Array<{ name: string }>;
    if (!stopIntentColumns.some((column) => column.name === "restart_launch_id")) {
      db.exec("ALTER TABLE session_stop_intents ADD COLUMN restart_launch_id TEXT");
    }
    if (!stopIntentColumns.some((column) => column.name === "archive_after_stop")) {
      db.exec("ALTER TABLE session_stop_intents ADD COLUMN archive_after_stop INTEGER NOT NULL DEFAULT 0 CHECK (archive_after_stop IN (0, 1))");
    }
    if (!stopIntentColumns.some((column) => column.name === "operation_id")) {
      db.exec("ALTER TABLE session_stop_intents ADD COLUMN operation_id TEXT");
    }
    if (!stopIntentColumns.some((column) => column.name === "last_attempt_at")) {
      db.exec("ALTER TABLE session_stop_intents ADD COLUMN last_attempt_at INTEGER");
    }
    if (!stopIntentColumns.some((column) => column.name === "delivery_attempt_id")) {
      db.exec("ALTER TABLE session_stop_intents ADD COLUMN delivery_attempt_id TEXT");
    }
    if (!stopIntentColumns.some((column) => column.name === "attempt_count")) {
      db.exec("ALTER TABLE session_stop_intents ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1)");
    }
    if (!stopIntentColumns.some((column) => column.name === "accepted_at")) {
      db.exec("ALTER TABLE session_stop_intents ADD COLUMN accepted_at INTEGER");
    }
    if (!stopIntentColumns.some((column) => column.name === "failed_at")) {
      db.exec("ALTER TABLE session_stop_intents ADD COLUMN failed_at INTEGER");
    }
    if (!stopIntentColumns.some((column) => column.name === "failure_code")) {
      db.exec("ALTER TABLE session_stop_intents ADD COLUMN failure_code TEXT");
    }
    if (!stopIntentColumns.some((column) => column.name === "failure_message")) {
      db.exec("ALTER TABLE session_stop_intents ADD COLUMN failure_message TEXT");
    }
    db.exec(
      `UPDATE session_stop_intents
       SET operation_id=COALESCE(operation_id, 'stop_' || lower(hex(randomblob(16)))),
           delivery_attempt_id=COALESCE(delivery_attempt_id, 'stop_delivery_' || lower(hex(randomblob(16)))),
           last_attempt_at=COALESCE(last_attempt_at, created_at)`,
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_session_stop_intents_runner ON session_stop_intents(runner_id, created_at, session_id)",
    );
    const controlPlane = new ControlPlaneDb(db, artifactBlobs, instanceId);
    try {
      controlPlane.recoverPendingArtifactBlobs();
      controlPlane.migrateInlineWorkflowArtifacts();
      controlPlane.backfillSessionEventArtifactReferences();
      controlPlane.collectExpiredPreparedPromptImages(Date.now());
      controlPlane.collectOrphanedEventPayloadArtifacts();
      controlPlane.migrateInlineSessionEventPayloads();
      controlPlane.collectWorkflowArtifactBlobs();
      controlPlane.seedUsageAggregationBaseline(Date.now());
      controlPlane.maintainUsageAggregation(Date.now());
      return controlPlane;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /** Stable identity of this database-backed control-plane installation. */
  instanceId(): string {
    return this.controlPlaneInstanceId;
  }

  /* ----------------------------- Startup -------------------------------- */

  /** Settle connection-owned state only after the HTTP server has successfully acquired its
   * listening socket. Opening a shared database is not proof that this process owns the instance:
   * a duplicate process can open SQLite before its listen fails with EADDRINUSE. */
  settleStartupState(now = Date.now()): void {
    this.atomic(() => {
      // Nothing is connected at startup — reset stale online flags.
      this.stmt("UPDATE runners SET status = 'offline', connected_at = NULL").run();
      // Boxes likewise start offline; the orchestrator re-bootstraps auto_reconnect ones.
      this.stmt("UPDATE boxes SET status = 'offline'").run();
      // Sessions that were mid-flight when the control plane stopped are orphaned
      // (we no longer have a live runner link to them) — mark them stopped, not
      // failed: an interrupted connection isn't an agent error.
      const midFlight = this.stmt(
        `SELECT id FROM sessions
         WHERE status IN ('queued','starting','running','input_required','idle')`,
      ).all() as Array<{ id: string }>;
      this.stmt(
        `UPDATE sessions SET status = 'stopped', updated_at = ?
         WHERE status IN ('queued','starting','running','input_required','idle')`,
      ).run(now);
      // Terminality is the retry fence on every path: a runner disconnect already fences these
      // commands, and a control-plane restart is no less disruptive — without this the outbox
      // re-delivers into sessions this settlement just stopped.
      for (const { id } of midFlight) {
        this.cancelSessionPromptCommands(
          id,
          "session became stopped before durable prompt delivery completed",
          now,
        );
      }
    });
  }

  /* ----------------------------- Runners --------------------------------- */

  /** `protocolVersion` is what the runner reported in its register frame; null (an older runner
   * omits it) overwrites any prior value so a downgrade can't leave a stale "current" number. */
  registerRunner(
    meta: RunnerMetadata,
    now: number,
    protocolVersion: number | null = null,
    scope: ResourceScope = {
      organizationId: PERSONAL_ORGANIZATION_ID,
      owner: { kind: "organization", organizationId: PERSONAL_ORGANIZATION_ID },
    },
    manageTransaction = true,
  ): void {
    if (manageTransaction) this.db.exec("BEGIN");
    try {
      const exists = this.stmt("SELECT 1 FROM runners WHERE runner_id = ?")
        .get(meta.runnerId);
      const existingOwnership = this.stmt(
        "SELECT organization_id, owner_kind, owner_id FROM runner_ownership WHERE runner_id=?",
      ).get(meta.runnerId) as
        | { organization_id: string; owner_kind: "organization" | "user" | "team"; owner_id: string }
        | undefined;
      const expectedOwnerId = scope.owner.kind === "organization"
        ? scope.owner.organizationId
        : scope.owner.kind === "user"
          ? scope.owner.userId
          : scope.owner.teamId;
      if (existingOwnership && (existingOwnership.organization_id !== scope.organizationId ||
          existingOwnership.owner_kind !== scope.owner.kind || existingOwnership.owner_id !== expectedOwnerId)) {
        throw new Error("runner credential scope does not match runner ownership");
      }

      const editors = meta.editors ? JSON.stringify(meta.editors) : null;
      const runtime = meta.runtime ? JSON.stringify(meta.runtime) : null;
      let containerTargets: string | null = null;
      if (runnerSupportsProtocol(protocolVersion, "containerExecutionTargets")) {
        const advertised = meta.executionTargets ?? [];
        if (!Array.isArray(advertised) || advertised.some((target) => target?.adapter !== "container" && target?.adapter !== "cloud") ||
            (!runnerSupportsProtocol(protocolVersion, "cloudExecutionHandoffs") && advertised.some((target) => target.adapter === "cloud"))) {
          throw new Error("runner advertised an unsupported execution target adapter");
        }
        const validated = [
          ...validateRunnerContainerTargets(meta.runnerId, advertised.filter((target) => target.adapter === "container")),
          ...(runnerSupportsProtocol(protocolVersion, "cloudExecutionHandoffs")
            ? validateRunnerCloudTargets(meta.runnerId, advertised.filter((target) => target.adapter === "cloud"))
            : []),
        ];
        containerTargets = JSON.stringify(validated);
      }
      if (exists) {
        // agents_refreshed_at resets on every register: the frame's agent list is the pre-discovery
        // baseline, and only a subsequent agents_updated proves a discovery pass has reported.
        // editors persist unless the frame carries a fresh list (pre-discovery registers omit it).
        this.stmt(
            `UPDATE runners SET hostname=?, os=?, version=?, protocol_version=?, status='online',
                connected_at=?, last_seen=?, updated_at=?, agents_refreshed_at=NULL,
                editors=COALESCE(?, editors), runtime=?, container_targets=? WHERE runner_id=?`,
          )
          .run(meta.hostname, meta.os, meta.version, protocolVersion, now, now, now, editors, runtime, containerTargets, meta.runnerId);
      } else {
        this.stmt(
            `INSERT INTO runners
               (runner_id, hostname, os, version, protocol_version, status, connected_at, last_seen, created_at, updated_at, editors, runtime, container_targets)
             VALUES (?, ?, ?, ?, ?, 'online', ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(meta.runnerId, meta.hostname, meta.os, meta.version, protocolVersion, now, now, now, now, editors, runtime, containerTargets);
      }

      const ownerKind = scope.owner.kind;
      const ownerId = ownerKind === "organization"
        ? scope.owner.organizationId
        : ownerKind === "user"
          ? scope.owner.userId
          : scope.owner.teamId;
      this.stmt(
        `INSERT OR IGNORE INTO runner_ownership
         (runner_id, organization_id, owner_kind, owner_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(meta.runnerId, scope.organizationId, ownerKind, ownerId, now, now);

      const previousWorkspaceIds = this.stmt("SELECT id FROM workspaces WHERE runner_id=?")
        .all(meta.runnerId) as unknown as Array<{ id: string }>;
      const reportedWorkspaceIds = new Set(meta.workspaces.map((workspace) => workspace.id));
      for (const previous of previousWorkspaceIds) {
        if (!reportedWorkspaceIds.has(previous.id)) {
          this.stmt("DELETE FROM workspace_ownership WHERE runner_id=? AND workspace_id=?")
            .run(meta.runnerId, previous.id);
        }
      }
      this.stmt("DELETE FROM workspaces WHERE runner_id = ?").run(meta.runnerId);

      const insWs = this.stmt(
        "INSERT INTO workspaces (runner_id, id, name, path, additional_directory_grants) VALUES (?, ?, ?, ?, ?)",
      );
      for (const ws of meta.workspaces) {
        insWs.run(meta.runnerId, ws.id, ws.name, ws.path, ws.additionalDirectoryGrants?.length ? JSON.stringify(ws.additionalDirectoryGrants) : null);
        this.stmt(
          `INSERT OR IGNORE INTO workspace_ownership
           (runner_id, workspace_id, organization_id, owner_kind, owner_id, created_at, updated_at)
           SELECT ?, ?, organization_id, owner_kind, owner_id, ?, ? FROM runner_ownership WHERE runner_id=?`,
        ).run(meta.runnerId, ws.id, now, now, meta.runnerId);
        this.reconcileWorkspaceProjectLocation(meta.runnerId, ws, "reported", now);
      }

      this.replaceAgents(
        meta.runnerId,
        meta.agents,
        now,
        !runnerSupportsProtocol(protocolVersion, "runnerLocalAgentEnv"),
      );
      if (manageTransaction) this.db.exec("COMMIT");
    } catch (err) {
      if (manageTransaction) this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Replace a runner's agent rows (used by registerRunner + discovery updates). */
  private replaceAgents(runnerId: string, agents: AgentDefinition[], now: number, persistEnvironment: boolean): void {
    this.stmt("DELETE FROM runner_agents WHERE runner_id = ?").run(runnerId);
    const upAgent = this.stmt(
      `INSERT INTO agent_definitions (id, name, created_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
    );
    const insRa = this.stmt(
      `INSERT INTO runner_agents
         (runner_id, agent_id, command, args, env, driver, context, capabilities, version, auth_status, available, source, codex_app_server, claude_code, acp, registry, acp_transport)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const a of agents) {
      upAgent.run(a.id, a.name, now);
      insRa.run(
        runnerId,
        a.id,
        a.command,
        JSON.stringify(a.args ?? []),
        JSON.stringify(persistEnvironment ? (a.env ?? {}) : {}),
        a.driver ?? "acp",
        a.context ? JSON.stringify(a.context) : null,
        a.capabilities ? JSON.stringify(a.capabilities) : null,
        a.version ?? null,
        a.authStatus ?? null,
        a.available == null ? null : a.available ? 1 : 0,
        a.source ?? null,
        a.codexAppServer ? JSON.stringify(a.codexAppServer) : null,
        a.claudeCode ? JSON.stringify(a.claudeCode) : null,
        a.acp ? JSON.stringify(a.acp) : null,
        a.registry ? JSON.stringify(a.registry) : null,
        a.acpTransport ?? null,
      );
    }
  }

  /** Replace a runner's advertised agents (e.g. after a discovery re-probe). Also stamps
   * agents_refreshed_at — agents_updated only ever carries a COMPLETED discovery result, so from
   * here on an empty list truthfully means "no agent CLIs found", not "still probing". */
  updateRunnerAgents(runnerId: string, agents: AgentDefinition[], now: number, editors?: EditorInfo[]): void {
    this.db.exec("BEGIN");
    try {
      const protocol = this.stmt("SELECT protocol_version FROM runners WHERE runner_id=?")
        .get(runnerId) as { protocol_version: number | null } | undefined;
      this.replaceAgents(
        runnerId,
        agents,
        now,
        !runnerSupportsProtocol(protocol?.protocol_version, "runnerLocalAgentEnv"),
      );
      this.stmt(
          "UPDATE runners SET agents_refreshed_at=?, updated_at=?, editors=COALESCE(?, editors) WHERE runner_id=?",
        )
        .run(now, now, editors ? JSON.stringify(editors) : null, runnerId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Set (or clear, with an empty name) a workspace's display-name override. */
  renameWorkspace(runnerId: string, workspaceId: string, name: string): void {
    const trimmed = name.trim();
    const priorOverride = this.workspaceOverride(runnerId, workspaceId);
    if (!trimmed) {
      this.stmt("DELETE FROM workspace_overrides WHERE runner_id=? AND workspace_id=?").run(runnerId, workspaceId);
    } else {
      this.stmt(
          `INSERT INTO workspace_overrides (runner_id, workspace_id, display_name) VALUES (?, ?, ?)
             ON CONFLICT(runner_id, workspace_id) DO UPDATE SET display_name = excluded.display_name`,
        )
        .run(runnerId, workspaceId, trimmed);
    }
    const generatedName = this.workspaceLocationDefinition(runnerId, workspaceId)?.name ?? workspaceId;
    const now = Date.now();
    for (const projectId of this.projectIdsForWorkspace(runnerId, workspaceId)) {
      this.stmt(
        `UPDATE projects SET name=?, name_source=?, updated_at=?
         WHERE id=? AND (name_source='workspace' OR name=?) AND
           (SELECT COUNT(*) FROM project_locations
            WHERE project_id=? AND detached_at IS NULL AND removed_at IS NULL)=1`,
      ).run(
        trimmed || generatedName,
        trimmed ? "user" : "workspace",
        now,
        projectId,
        priorOverride ?? generatedName,
        projectId,
      );
    }
  }

  /** Legacy adapter: create a CP-owned workspace definition on a runner. It persists in
   * workspace_extras so it survives the register-time wipe of runner-reported workspaces. */
  createWorkspace(runnerId: string, input: { name: string; path: string }, scope?: ResourceScope): WorkspaceInfo {
    const id = `ws_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const name = input.name.trim();
    const path = input.path.trim();
    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      this.stmt("INSERT INTO workspace_extras (runner_id, id, name, path, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(runnerId, id, name, path, now);
      if (scope) {
        const ownerId = scope.owner.kind === "organization" ? scope.owner.organizationId
          : scope.owner.kind === "user" ? scope.owner.userId : scope.owner.teamId;
        this.stmt(
          `INSERT INTO workspace_ownership
           (runner_id, workspace_id, organization_id, owner_kind, owner_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(runnerId, id, scope.organizationId, scope.owner.kind, ownerId, now, now);
      } else {
        this.stmt(
          `INSERT INTO workspace_ownership
           (runner_id, workspace_id, organization_id, owner_kind, owner_id, created_at, updated_at)
           SELECT ?, ?, organization_id, owner_kind, owner_id, ?, ? FROM runner_ownership WHERE runner_id=?`,
        ).run(runnerId, id, now, now, runnerId);
      }
      this.reconcileWorkspaceProjectLocation(runnerId, { id, name, path }, "managed", now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { id, name, path };
  }

  /** Register a CP-owned Workspace on a Machine without implicitly creating or joining a Project. */
  registerMachineWorkspace(
    runnerId: string,
    input: { name: string; path: string },
    scope?: ResourceScope,
    now = Date.now(),
  ): WorkspaceInfo {
    const name = input.name.trim();
    const path = input.path.trim();
    if (!name || !path) throw new Error("name and path are required");
    const existing = this.stmt(
      `SELECT id FROM workspaces WHERE runner_id=? AND path=?
       UNION ALL
       SELECT id FROM workspace_extras WHERE runner_id=? AND path=?
       LIMIT 1`,
    ).get(runnerId, path, runnerId, path) as { id: string } | undefined;
    if (existing) throw new Error("This folder is already registered as a Workspace");

    const id = `ws_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.atomic(() => {
      this.stmt("INSERT INTO workspace_extras (runner_id, id, name, path, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(runnerId, id, name, path, now);
      if (scope) {
        const ownerId = scope.owner.kind === "organization" ? scope.owner.organizationId
          : scope.owner.kind === "user" ? scope.owner.userId : scope.owner.teamId;
        this.stmt(
          `INSERT INTO workspace_ownership
           (runner_id, workspace_id, organization_id, owner_kind, owner_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(runnerId, id, scope.organizationId, scope.owner.kind, ownerId, now, now);
      } else {
        this.stmt(
          `INSERT INTO workspace_ownership
           (runner_id, workspace_id, organization_id, owner_kind, owner_id, created_at, updated_at)
           SELECT ?, ?, organization_id, owner_kind, owner_id, ?, ? FROM runner_ownership WHERE runner_id=?`,
        ).run(runnerId, id, now, now, runnerId);
      }
    });
    return { id, name, path };
  }

  setMachineDisplayName(runnerId: string, displayName: string): void {
    const trimmed = displayName.trim();
    if (!trimmed) {
      this.stmt("DELETE FROM machine_overrides WHERE runner_id=?").run(runnerId);
      return;
    }
    this.stmt(
      `INSERT INTO machine_overrides (runner_id, display_name) VALUES (?, ?)
       ON CONFLICT(runner_id) DO UPDATE SET display_name=excluded.display_name`,
    ).run(runnerId, trimmed);
  }

  private machineDisplayName(runnerId: string): string | undefined {
    const row = this.stmt("SELECT display_name FROM machine_overrides WHERE runner_id=?")
      .get(runnerId) as { display_name: string | null } | undefined;
    return row?.display_name?.trim() || undefined;
  }

  /** Register a CP-owned workspace and attach it to an existing Project in one transaction.
   * Unlike the legacy createWorkspace adapter, this must not materialize an intermediate Project. */
  createProjectWorkspace(
    projectId: string,
    runnerId: string,
    input: { name: string; path: string },
    now = Date.now(),
    requestedScope?: ResourceScope,
  ): WorkspaceInfo {
    const name = input.name.trim();
    const path = input.path.trim();
    if (!name || !path) throw new Error("name and path are required");
    const projectScope = this.projectScope(projectId);
    if (!projectScope) throw new Error("project not found");
    const runnerScope = this.runnerScope(runnerId);
    if (!runnerScope) throw new Error("runner not found");
    if (!this.scopeAudienceContainedWithMembership(projectScope, runnerScope)) {
      throw new Error("project access must not expose a private runner");
    }
    const workspaceScope = requestedScope ?? projectScope;
    if (workspaceScope.organizationId !== projectScope.organizationId ||
        !this.scopeAudienceContainedWithMembership(projectScope, workspaceScope)) {
      throw new Error("project access must not expose a private workspace");
    }
    if (!this.scopeAudienceContainedWithMembership(workspaceScope, runnerScope)) {
      throw new Error("location access must not expose a private runner");
    }
    const existing = this.stmt(
      `SELECT id FROM workspaces WHERE runner_id=? AND path=?
       UNION ALL
       SELECT id FROM workspace_extras WHERE runner_id=? AND path=?
       LIMIT 1`,
    ).get(runnerId, path, runnerId, path) as { id: string } | undefined;
    if (existing) throw new Error("This folder is already registered as a Location");

    const id = `ws_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.atomic(() => {
      this.stmt("INSERT INTO workspace_extras (runner_id, id, name, path, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(runnerId, id, name, path, now);
      const ownerId = workspaceScope.owner.kind === "organization" ? workspaceScope.owner.organizationId
        : workspaceScope.owner.kind === "user" ? workspaceScope.owner.userId : workspaceScope.owner.teamId;
      this.stmt(
        `INSERT INTO workspace_ownership
         (runner_id, workspace_id, organization_id, owner_kind, owner_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(runnerId, id, workspaceScope.organizationId, workspaceScope.owner.kind, ownerId, now, now);
      this.addProjectLocation(projectId, { runnerId, workspaceId: id }, now);
    });
    return { id, name, path };
  }

  /** A runner's CP-created workspaces (workspace_extras), oldest first. */
  private workspaceExtras(runnerId: string): WorkspaceInfo[] {
    return (
      this.stmt("SELECT id, name, path FROM workspace_extras WHERE runner_id=? ORDER BY created_at")
        .all(runnerId) as unknown as { id: string; name: string; path: string }[]
    ).map((w) => ({ id: w.id, name: w.name, path: w.path }));
  }

  /** The display-name override for a workspace, or null. */
  private workspaceOverride(runnerId: string, workspaceId: string): string | null {
    return (
      (
        this.stmt("SELECT display_name FROM workspace_overrides WHERE runner_id=? AND workspace_id=?")
          .get(runnerId, workspaceId) as { display_name: string | null } | undefined
      )?.display_name ?? null
    );
  }

  /** Resolve the display name for either a runner-advertised or CP-created project. */
  private workspaceDisplayName(runnerId: string, workspaceId: string): string {
    const override = this.workspaceOverride(runnerId, workspaceId);
    if (override) return override;
    const reported = this.stmt("SELECT name FROM workspaces WHERE runner_id=? AND id=?")
      .get(runnerId, workspaceId) as { name: string } | undefined;
    if (reported) return reported.name;
    const extra = this.stmt("SELECT name FROM workspace_extras WHERE runner_id=? AND id=?")
      .get(runnerId, workspaceId) as { name: string } | undefined;
    return extra?.name ?? workspaceId;
  }

  /** Session ids in a runner's workspace (rename fan-out: re-broadcast their views). */
  sessionIdsForWorkspace(runnerId: string, workspaceId: string): string[] {
    return (
      this.stmt("SELECT id FROM sessions WHERE runner_id=? AND workspace_id=?").all(runnerId, workspaceId) as {
        id: string;
      }[]
    ).map((r) => r.id);
  }

  /* ----------------------------- Projects -------------------------------- */

  private insertProjectOwnership(projectId: string, scope: ResourceScope, now: number): void {
    const ownerId = scope.owner.kind === "organization" ? scope.owner.organizationId
      : scope.owner.kind === "user" ? scope.owner.userId : scope.owner.teamId;
    this.stmt(
      `INSERT INTO project_ownership
       (project_id, organization_id, owner_kind, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(projectId, scope.organizationId, scope.owner.kind, ownerId, now, now);
  }

  private projectLocationAvailability(row: ProjectLocationRow): ProjectLocationAvailability {
    if (row.detached_at !== null) return "runner_removed";
    const runner = this.stmt("SELECT status FROM runners WHERE runner_id=?").get(row.runner_id) as
      | { status: string }
      | undefined;
    if (!runner) return "runner_removed";
    if (runner.status !== "online") return "runner_offline";
    const exists = row.source === "managed"
      ? this.stmt("SELECT 1 FROM workspace_extras WHERE runner_id=? AND id=?").get(row.runner_id, row.workspace_id)
      : row.source === "reported"
        ? this.stmt("SELECT 1 FROM workspaces WHERE runner_id=? AND id=?").get(row.runner_id, row.workspace_id)
        : this.stmt(
          `SELECT 1 FROM workspaces WHERE runner_id=? AND id=?
           UNION ALL SELECT 1 FROM workspace_extras WHERE runner_id=? AND id=? LIMIT 1`,
        ).get(row.runner_id, row.workspace_id, row.runner_id, row.workspace_id);
    return exists ? "available" : "workspace_missing";
  }

  private projectView(row: ProjectRow, principal?: AuthPrincipal): ProjectView {
    const projectScope = this.projectScope(row.id);
    const locationRows = this.stmt(
      `SELECT id, project_id, runner_id, workspace_id, name, path, source, last_seen_at,
              detached_at, removed_at, created_at, updated_at
       FROM project_locations WHERE project_id=? AND removed_at IS NULL
       ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END, created_at, id`,
    ).all(row.id, row.default_location_id ?? "") as unknown as ProjectLocationRow[];
    const sessionRows = this.stmt(
      "SELECT id, project_location_id, archived, status FROM sessions WHERE project_id=?",
    ).all(row.id) as unknown as Array<{
      id: string;
      project_location_id: string | null;
      archived: number;
      status: SessionStatus;
    }>;
    const visibleSessions = principal
      ? sessionRows.filter((session) => this.canAccessSession(principal, session.id))
      : sessionRows;
    const isActiveSession = (session: { archived: number; status: SessionStatus }): boolean =>
      session.archived === 0 && ["queued", "starting", "running", "input_required"].includes(session.status);
    const locationSessionCounts = new Map<string, {
      activeSessionCount: number;
      unarchivedSessionCount: number;
      totalSessionCount: number;
    }>();
    for (const session of visibleSessions) {
      if (session.project_location_id === null) continue;
      const counts = locationSessionCounts.get(session.project_location_id) ?? {
        activeSessionCount: 0,
        unarchivedSessionCount: 0,
        totalSessionCount: 0,
      };
      counts.totalSessionCount += 1;
      if (session.archived === 0) counts.unarchivedSessionCount += 1;
      if (isActiveSession(session)) counts.activeSessionCount += 1;
      locationSessionCounts.set(session.project_location_id, counts);
    }
    return {
      id: row.id,
      name: row.name,
      hidden: row.hidden_at !== null,
      audience: projectScope?.owner.kind,
      ...(projectScope ? { scope: projectScope } : {}),
      canManage: principal ? this.canManageProject(principal, row.id) : true,
      locations: locationRows.map((location) => ({
        id: location.id,
        projectId: location.project_id,
        runnerId: location.runner_id,
        workspaceId: location.workspace_id,
        name: location.name,
        path: location.path,
        source: location.source,
        availability: this.projectLocationAvailability(location),
        isDefault: location.id === row.default_location_id,
        ...(() => {
          const scope = this.workspaceScope(location.runner_id, location.workspace_id) ?? projectScope;
          return scope ? {
            scope,
            canManage: principal ? this.canManageWorkspace(principal, location.runner_id, location.workspace_id) : true,
          } : {};
        })(),
        activeSessionCount: locationSessionCounts.get(location.id)?.activeSessionCount ?? 0,
        unarchivedSessionCount: locationSessionCounts.get(location.id)?.unarchivedSessionCount ?? 0,
        totalSessionCount: locationSessionCounts.get(location.id)?.totalSessionCount ?? 0,
        createdAt: location.created_at,
        updatedAt: location.updated_at,
      })),
      activeSessionCount: visibleSessions.filter(isActiveSession).length,
      unarchivedSessionCount: visibleSessions.filter((session) => session.archived === 0).length,
      totalSessionCount: visibleSessions.length,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getProject(projectId: string): ProjectView | null {
    const row = this.stmt(
      "SELECT id, name, name_source, hidden_at, default_location_id, created_at, updated_at FROM projects WHERE id=?",
    ).get(projectId) as unknown as ProjectRow | undefined;
    return row ? this.projectView(row) : null;
  }

  getProjectForPrincipal(principal: AuthPrincipal, projectId: string): ProjectView | null {
    if (!this.canAccessProject(principal, projectId)) return null;
    const row = this.stmt(
      "SELECT id, name, name_source, hidden_at, default_location_id, created_at, updated_at FROM projects WHERE id=?",
    ).get(projectId) as unknown as ProjectRow | undefined;
    return row ? this.projectView(row, principal) : null;
  }

  listProjects(includeHidden = false): ProjectView[] {
    const rows = this.stmt(
      `SELECT id, name, name_source, hidden_at, default_location_id, created_at, updated_at
       FROM projects WHERE hidden_at IS NULL OR ?=1 ORDER BY LOWER(name), created_at, id`,
    ).all(includeHidden ? 1 : 0) as unknown as ProjectRow[];
    return rows.map((row) => this.projectView(row));
  }

  listProjectsForPrincipal(principal: AuthPrincipal, includeHidden = false): ProjectView[] {
    const rows = this.stmt(
      `SELECT id, name, name_source, hidden_at, default_location_id, created_at, updated_at
       FROM projects WHERE hidden_at IS NULL OR ?=1 ORDER BY LOWER(name), created_at, id`,
    ).all(includeHidden ? 1 : 0) as unknown as ProjectRow[];
    return rows
      .filter((row) => this.canAccessProject(principal, row.id))
      .map((row) => this.projectView(row, principal));
  }

  projectIdsForRunner(runnerId: string): string[] {
    return (this.stmt(
      "SELECT DISTINCT project_id FROM project_locations WHERE runner_id=? AND removed_at IS NULL ORDER BY project_id",
    ).all(runnerId) as unknown as Array<{ project_id: string }>).map((row) => row.project_id);
  }

  projectIdsForWorkspace(runnerId: string, workspaceId: string): string[] {
    return (this.stmt(
      `SELECT DISTINCT project_id FROM project_locations
       WHERE runner_id=? AND workspace_id=? AND detached_at IS NULL AND removed_at IS NULL
       ORDER BY project_id`,
    ).all(runnerId, workspaceId) as unknown as Array<{ project_id: string }>).map((row) => row.project_id);
  }

  sessionIdsForProject(projectId: string): string[] {
    return (this.stmt("SELECT id FROM sessions WHERE project_id=? ORDER BY id").all(projectId) as
      unknown as Array<{ id: string }>).map((row) => row.id);
  }

  projectScope(projectId: string): ResourceScope | null {
    const row = this.stmt(
      "SELECT organization_id, owner_kind, owner_id FROM project_ownership WHERE project_id=?",
    ).get(projectId) as
      | { organization_id: string; owner_kind: "organization" | "user" | "team"; owner_id: string }
      | undefined;
    return row ? this.scopeFromRow(row) : null;
  }

  canAccessProject(principal: AuthPrincipal, projectId: string): boolean {
    const scope = this.projectScope(projectId);
    return scope ? this.principalCanAccessScope(principal, scope) : false;
  }

  canManageProject(principal: AuthPrincipal, projectId: string): boolean {
    if (principal.kind !== "human") return false;
    const scope = this.projectScope(projectId);
    if (!scope || principal.organizationId !== scope.organizationId) return false;
    if (principal.role === "owner" || principal.role === "admin") return true;
    if (scope.owner.kind === "organization") return false;
    if (scope.owner.kind === "user") return scope.owner.userId === principal.userId;
    return this.principalCanAccessScope(principal, scope);
  }

  createProject(input: { name: string; scope?: ResourceScope; hidden?: boolean; now?: number }): ProjectView {
    const name = input.name.trim();
    if (!name) throw new Error("project name is required");
    const now = input.now ?? Date.now();
    const projectId = `prj_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const scope = input.scope ?? {
      organizationId: PERSONAL_ORGANIZATION_ID,
      owner: { kind: "organization" as const, organizationId: PERSONAL_ORGANIZATION_ID },
    };
    this.atomic(() => {
      this.stmt(
        `INSERT INTO projects (id, name, name_source, hidden_at, default_location_id, created_at, updated_at)
         VALUES (?, ?, 'user', ?, NULL, ?, ?)`,
      ).run(projectId, name, input.hidden ? now : null, now, now);
      this.insertProjectOwnership(projectId, scope, now);
    });
    return this.getProject(projectId)!;
  }

  renameProject(projectId: string, name: string, now = Date.now()): ProjectView | null {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("project name is required");
    const changed = this.stmt(
      "UPDATE projects SET name=?, name_source='user', updated_at=? WHERE id=?",
    ).run(trimmed, now, projectId).changes;
    return Number(changed) > 0 ? this.getProject(projectId) : null;
  }

  setProjectHidden(projectId: string, hidden: boolean, now = Date.now()): ProjectView | null {
    const changed = this.stmt("UPDATE projects SET hidden_at=?, updated_at=? WHERE id=?")
      .run(hidden ? now : null, now, projectId).changes;
    return Number(changed) > 0 ? this.getProject(projectId) : null;
  }

  updateProject(
    projectId: string,
    input: { name?: string; hidden?: boolean },
    now = Date.now(),
  ): ProjectView | null {
    const current = this.stmt(
      "SELECT name, name_source, hidden_at FROM projects WHERE id=?",
    ).get(projectId) as { name: string; name_source: ProjectNameSource; hidden_at: number | null } | undefined;
    if (!current) return null;
    const name = input.name?.trim();
    if (input.name !== undefined && !name) throw new Error("project name is required");
    this.atomic(() => {
      this.stmt(
        `UPDATE projects SET name=?, name_source=?, hidden_at=?, updated_at=? WHERE id=?`,
      ).run(
        name ?? current.name,
        name === undefined ? current.name_source : "user",
        input.hidden === undefined ? current.hidden_at : input.hidden ? now : null,
        now,
        projectId,
      );
    });
    return this.getProject(projectId);
  }

  /** Reconcile discovery without reviving a user-removed or runner-deletion tombstone. */
  private reconcileWorkspaceProjectLocation(
    runnerId: string,
    workspace: { id: string; name: string; path: string },
    source: "reported" | "managed",
    now: number,
  ): ProjectLocationView | null {
    const rows = this.stmt(
      `SELECT id, project_id, detached_at, removed_at FROM project_locations
       WHERE runner_id=? AND workspace_id=? ORDER BY created_at DESC, id DESC`,
    ).all(runnerId, workspace.id) as unknown as Array<{
      id: string;
      project_id: string;
      detached_at: number | null;
      removed_at: number | null;
    }>;
    const active = rows.filter((row) => row.detached_at === null && row.removed_at === null);
    if (active.length > 0) {
      const override = this.workspaceOverride(runnerId, workspace.id);
      this.stmt(
        `UPDATE project_locations SET name=?, path=?, source=?, last_seen_at=?, updated_at=?
         WHERE runner_id=? AND workspace_id=? AND detached_at IS NULL AND removed_at IS NULL`,
      ).run(workspace.name, workspace.path, source, now, now, runnerId, workspace.id);
      for (const link of active) {
        this.stmt(
          `UPDATE projects SET name=?, name_source=?, updated_at=?
           WHERE id=? AND name_source='workspace' AND
             (SELECT COUNT(*) FROM project_locations
              WHERE project_id=? AND detached_at IS NULL AND removed_at IS NULL)=1`,
        ).run(override ?? workspace.name, override ? "user" : "workspace", now, link.project_id, link.project_id);
      }
      return active.length === 1 ? this.projectLocation(active[0]!.id) : null;
    }
    if (rows.length > 0) return null;
    const suppressed = this.stmt(
      "SELECT 1 FROM project_location_suppressions WHERE runner_id=? AND workspace_id=?",
    ).get(runnerId, workspace.id);
    if (suppressed) return null;

    const scope = this.workspaceScope(runnerId, workspace.id) ?? this.runnerScope(runnerId);
    if (!scope) throw new Error(`ownership is unavailable for workspace '${runnerId}/${workspace.id}'`);
    const override = this.workspaceOverride(runnerId, workspace.id);
    const projectId = `prj_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const locationId = `loc_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    this.stmt(
      `INSERT INTO projects (id, name, name_source, hidden_at, default_location_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?)`,
    ).run(projectId, override ?? workspace.name, override ? "user" : "workspace", now, now);
    this.insertProjectOwnership(projectId, scope, now);
    this.stmt(
      `INSERT INTO project_locations
       (id, project_id, runner_id, workspace_id, name, path, source, last_seen_at,
        detached_at, removed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    ).run(locationId, projectId, runnerId, workspace.id, workspace.name, workspace.path, source, now, now, now);
    this.stmt("UPDATE projects SET default_location_id=? WHERE id=?").run(locationId, projectId);
    return this.projectLocation(locationId);
  }

  private workspaceLocationDefinition(runnerId: string, workspaceId: string): {
    name: string;
    path: string;
    source: "reported" | "managed";
  } | null {
    const reported = this.stmt("SELECT name, path FROM workspaces WHERE runner_id=? AND id=?")
      .get(runnerId, workspaceId) as { name: string; path: string } | undefined;
    if (reported) return { ...reported, source: "reported" };
    const managed = this.stmt("SELECT name, path FROM workspace_extras WHERE runner_id=? AND id=?")
      .get(runnerId, workspaceId) as { name: string; path: string } | undefined;
    return managed ? { ...managed, source: "managed" } : null;
  }

  projectLocation(locationId: string, includeRemoved = false): ProjectLocationView | null {
    const row = this.stmt(
      `SELECT id, project_id, runner_id, workspace_id, name, path, source, last_seen_at,
              detached_at, removed_at, created_at, updated_at
       FROM project_locations WHERE id=? AND (removed_at IS NULL OR ?=1)`,
    ).get(locationId, includeRemoved ? 1 : 0) as unknown as ProjectLocationRow | undefined;
    if (!row) return null;
    const project = this.stmt("SELECT default_location_id FROM projects WHERE id=?").get(row.project_id) as
      | { default_location_id: string | null }
      | undefined;
    return {
      id: row.id,
      projectId: row.project_id,
      runnerId: row.runner_id,
      workspaceId: row.workspace_id,
      name: row.name,
      path: row.path,
      source: row.source,
      availability: this.projectLocationAvailability(row),
      isDefault: project?.default_location_id === row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getProjectLocation(locationId: string): ProjectLocationView | null {
    return this.projectLocation(locationId);
  }

  projectLocationsForWorkspace(runnerId: string, workspaceId: string): ProjectLocationView[] {
    const rows = this.stmt(
      `SELECT id FROM project_locations WHERE runner_id=? AND workspace_id=?
       AND detached_at IS NULL AND removed_at IS NULL ORDER BY project_id, created_at, id`,
    ).all(runnerId, workspaceId) as unknown as Array<{ id: string }>;
    return rows.map((row) => this.projectLocation(row.id)).filter((row): row is ProjectLocationView => row !== null);
  }

  findProjectLocationForProject(
    projectId: string,
    runnerId: string,
    workspaceId: string,
  ): ProjectLocationView | null {
    const row = this.stmt(
      `SELECT id FROM project_locations WHERE project_id=? AND runner_id=? AND workspace_id=?
       AND detached_at IS NULL AND removed_at IS NULL LIMIT 1`,
    ).get(projectId, runnerId, workspaceId) as { id: string } | undefined;
    return row ? this.projectLocation(row.id) : null;
  }

  /** Legacy inference is safe only while one physical Location has exactly one active Project
   * link. New callers must send explicit Project and Project Location identities. */
  findProjectLocation(runnerId: string, workspaceId: string): ProjectLocationView | null {
    const rows = this.stmt(
      `SELECT id FROM project_locations WHERE runner_id=? AND workspace_id=?
       AND detached_at IS NULL AND removed_at IS NULL ORDER BY project_id, id LIMIT 2`,
    ).all(runnerId, workspaceId) as unknown as Array<{ id: string }>;
    return rows.length === 1 ? this.projectLocation(rows[0]!.id) : null;
  }

  /** Resolve an imported provider cwd against the combined durable Project Location and Machine
   * Workspace catalog. An exact physical Location may be shared by several Projects, in which case
   * we retain its Workspace identity but decline Project inference; tied Workspace identities fail
   * closed because there is no authoritative durable owner. */
  resolveImportedSessionLocation(
    runnerId: string,
    path: string,
  ): { workspaceId: string | null; projectLocation: ProjectLocationView | null } {
    const rows = this.stmt(
      `SELECT workspace_id AS id, path FROM project_locations WHERE runner_id=?
       AND detached_at IS NULL AND removed_at IS NULL ORDER BY workspace_id, id`,
    ).all(runnerId) as unknown as Array<{ id: string; path: string }>;
    // Project Location rows carry durable identities that may no longer be in the latest runner
    // report, while Machine Workspaces may intentionally have no Project link. Compare the union so
    // a more-specific managed Workspace cannot lose to a broad reported Project parent.
    const physical = [...new Map([
      ...rows,
      ...this.listKnownRunnerWorkspaces(runnerId),
    ].map((row) => [row.id, row])).values()];
    const workspaceMatches = matchWorkspaceIds(physical, path);
    // Two durable workspace ids at the same most-specific path may carry different ownership.
    // Decline both identity and Project inference instead of selecting by query order.
    const workspaceId = workspaceMatches.length === 1 ? workspaceMatches[0]! : null;
    return {
      workspaceId,
      projectLocation: workspaceId ? this.findProjectLocation(runnerId, workspaceId) : null,
    };
  }

  inferProjectLocation(runnerId: string, path: string): ProjectLocationView | null {
    return this.resolveImportedSessionLocation(runnerId, path).projectLocation;
  }

  addProjectLocation(
    projectId: string,
    input: { runnerId: string; workspaceId: string },
    now = Date.now(),
  ): ProjectLocationView {
    const project = this.getProject(projectId);
    if (!project) throw new Error("project not found");
    const existing = this.findProjectLocationForProject(projectId, input.runnerId, input.workspaceId);
    if (existing) return existing;
    const detached = this.stmt(
      `SELECT id, project_id FROM project_locations
       WHERE project_id=? AND runner_id=? AND workspace_id=?
         AND detached_at IS NOT NULL AND removed_at IS NULL
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(projectId, input.runnerId, input.workspaceId) as { id: string; project_id: string } | undefined;
    const workspace = this.workspaceLocationDefinition(input.runnerId, input.workspaceId);
    if (!workspace) throw new Error("workspace not found");
    const projectScope = this.projectScope(projectId);
    const locationScope = this.workspaceScope(input.runnerId, input.workspaceId) ?? this.runnerScope(input.runnerId);
    if (!projectScope || !locationScope ||
        !this.scopeAudienceContainedWithMembership(projectScope, locationScope)) {
      throw new Error("project access must not expose a private workspace");
    }
    const locationId = detached?.id ?? `loc_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    this.atomic(() => {
      this.stmt("DELETE FROM project_location_suppressions WHERE runner_id=? AND workspace_id=?")
        .run(input.runnerId, input.workspaceId);
      if (detached) {
        this.stmt(
          `UPDATE project_locations
           SET name=?, path=?, source=?, last_seen_at=?, detached_at=NULL, updated_at=?
           WHERE id=? AND detached_at IS NOT NULL AND removed_at IS NULL`,
        ).run(workspace.name, workspace.path, workspace.source, now, now, locationId);
      } else {
        this.stmt(
          `INSERT INTO project_locations
           (id, project_id, runner_id, workspace_id, name, path, source, last_seen_at,
            detached_at, removed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        ).run(
          locationId,
          projectId,
          input.runnerId,
          input.workspaceId,
          workspace.name,
          workspace.path,
          workspace.source,
          now,
          now,
          now,
        );
      }
      this.stmt(
        `UPDATE projects SET default_location_id=COALESCE(default_location_id, ?), updated_at=? WHERE id=?`,
      ).run(locationId, now, projectId);
      this.stmt("UPDATE projects SET name_source='user' WHERE id=?").run(projectId);
    });
    return this.projectLocation(locationId)!;
  }

  moveProjectLocation(locationId: string, targetProjectId: string, now = Date.now()): ProjectLocationView | null {
    const location = this.projectLocation(locationId);
    const target = this.getProject(targetProjectId);
    if (!location || !target) return null;
    if (location.projectId === targetProjectId) return location;
    const sourceScope = this.projectScope(location.projectId);
    const targetScope = this.projectScope(targetProjectId);
    const locationScope = this.workspaceScope(location.runnerId, location.workspaceId) ?? sourceScope;
    if (!sourceScope || !targetScope || !locationScope ||
        !this.scopeAudienceContainedWithMembership(targetScope, locationScope)) {
      throw new Error("target project access must not expose a private workspace");
    }
    const workspace = this.workspaceLocationDefinition(location.runnerId, location.workspaceId);
    const targetLocation = this.findProjectLocationForProject(
      targetProjectId,
      location.runnerId,
      location.workspaceId,
    );
    const sourceProjectId = location.projectId;
    for (const sessionId of (this.stmt(
      "SELECT id FROM sessions WHERE project_location_id=?",
    ).all(locationId) as unknown as Array<{ id: string }>).map((row) => row.id)) {
      const sessionScope = this.sessionScope(sessionId);
      if (!sessionScope || !this.scopeAudienceContainedWithMembership(sessionScope, targetScope)) {
        throw new Error("target project cannot contain every session at this location");
      }
    }
    this.atomic(() => {
      if (targetLocation) {
        this.stmt(
          `UPDATE sessions SET project_id=?, project_location_id=?, updated_at=?
           WHERE project_location_id=?`,
        ).run(targetProjectId, targetLocation.id, now, locationId);
        this.stmt(
          "UPDATE project_locations SET removed_at=?, updated_at=? WHERE id=? AND removed_at IS NULL",
        ).run(now, now, locationId);
      } else if (workspace) {
        this.stmt("DELETE FROM project_location_suppressions WHERE runner_id=? AND workspace_id=?")
          .run(location.runnerId, location.workspaceId);
        this.stmt(
          `UPDATE project_locations
           SET project_id=?, name=?, path=?, source=?, last_seen_at=?, detached_at=NULL, updated_at=?
           WHERE id=? AND removed_at IS NULL`,
        ).run(
          targetProjectId,
          workspace.name,
          workspace.path,
          workspace.source,
          now,
          now,
          locationId,
        );
      } else {
        this.stmt("UPDATE project_locations SET project_id=?, updated_at=? WHERE id=? AND removed_at IS NULL")
          .run(targetProjectId, now, locationId);
      }
      if (!targetLocation) {
        this.stmt(
          "UPDATE sessions SET project_id=?, updated_at=? WHERE project_location_id=?",
        ).run(targetProjectId, now, locationId);
      }
      this.stmt(
        `UPDATE projects SET default_location_id=(
           SELECT id FROM project_locations WHERE project_id=? AND removed_at IS NULL AND detached_at IS NULL
           ORDER BY created_at, id LIMIT 1
         ), updated_at=? WHERE id=? AND default_location_id=?`,
      ).run(sourceProjectId, now, sourceProjectId, locationId);
      this.stmt(
        `UPDATE projects SET default_location_id=COALESCE(default_location_id, (
           SELECT id FROM project_locations WHERE project_id=? AND removed_at IS NULL AND detached_at IS NULL
           ORDER BY created_at, id LIMIT 1
         )), updated_at=? WHERE id=?`,
      ).run(targetProjectId, now, targetProjectId);
      this.stmt("UPDATE projects SET name_source='user' WHERE id IN (?, ?)")
        .run(sourceProjectId, targetProjectId);
    });
    return targetLocation ? this.projectLocation(targetLocation.id) : this.projectLocation(locationId);
  }

  removeProjectLocation(locationId: string, now = Date.now()): ProjectLocationView | null {
    const location = this.projectLocation(locationId);
    if (!location) return null;
    this.atomic(() => {
      this.stmt("UPDATE project_locations SET removed_at=?, updated_at=? WHERE id=? AND removed_at IS NULL")
        .run(now, now, locationId);
      this.stmt(
        `UPDATE projects SET default_location_id=(
           SELECT id FROM project_locations WHERE project_id=? AND removed_at IS NULL AND detached_at IS NULL
           ORDER BY created_at, id LIMIT 1
         ), updated_at=? WHERE id=?`,
      ).run(location.projectId, now, location.projectId);
    });
    return this.projectLocation(locationId, true);
  }

  setProjectDefaultLocation(
    projectId: string,
    locationId: string | null,
    now = Date.now(),
  ): ProjectView | null {
    if (!this.getProject(projectId)) return null;
    if (locationId !== null) {
      const location = this.projectLocation(locationId);
      if (!location || location.projectId !== projectId || location.availability === "runner_removed") {
        throw new Error("default location must be an active location in this project");
      }
    }
    this.stmt("UPDATE projects SET default_location_id=?, updated_at=? WHERE id=?")
      .run(locationId, now, projectId);
    return this.getProject(projectId);
  }

  setSessionProject(
    sessionId: string,
    projectId: string | null,
    projectLocationId: string | null = null,
    now = Date.now(),
    adoptTeamProjectForUserId?: string,
  ): SessionView | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    if (projectId === null && projectLocationId !== null) throw new Error("a project location requires a project");
    if (projectId !== null && !this.getProject(projectId)) throw new Error("project not found");
    const projectScope = projectId === null ? null : this.projectScope(projectId);
    if (projectId !== null && !projectScope) throw new Error("project ownership is unavailable");
    if (projectLocationId !== null) {
      const location = this.projectLocation(projectLocationId);
      if (!location || location.projectId !== projectId) throw new Error("project location does not belong to project");
      if (location.runnerId !== session.runnerId || location.workspaceId !== session.workspaceId) {
        throw new Error("project location does not match session runner/workspace");
      }
    }
    const executionScope = session.workspaceId
      ? this.workspaceScope(session.runnerId, session.workspaceId) ?? this.runnerScope(session.runnerId)
      : this.runnerScope(session.runnerId);
    if (projectScope &&
        (!executionScope || !this.scopeAudienceContainedWithMembership(projectScope, executionScope))) {
      throw new Error("project access would expose the execution Location");
    }
    const sessionScope = this.sessionScope(sessionId);
    if (!sessionScope) throw new Error("session ownership is unavailable");
    // Explicitly filing a personal session into its team Project is a deliberate share and retains
    // the established behavior of adopting the team scope, even though membership also proves that
    // keeping the personal scope would satisfy containment.
    const adoptProjectScope = Boolean(projectScope && adoptTeamProjectForUserId &&
      sessionScope.owner.kind === "user" && sessionScope.owner.userId === adoptTeamProjectForUserId &&
      projectScope.owner.kind === "team");
    if (projectScope && !adoptProjectScope &&
        !this.scopeAudienceContainedWithMembership(sessionScope, projectScope)) {
      throw new Error("session access is broader than project access");
    }
    this.atomic(() => {
      // A deliberate personal-to-team share adopts the team audience atomically. Safe filing into
      // a wider/equal Project and removing Project organization preserve the existing audience.
      if (projectScope && adoptProjectScope) {
        const ownerId = projectScope.owner.kind === "organization" ? projectScope.owner.organizationId
          : projectScope.owner.kind === "user" ? projectScope.owner.userId : projectScope.owner.teamId;
        this.stmt(
          `UPDATE session_ownership SET organization_id=?, owner_kind=?, owner_id=?, updated_at=?
           WHERE session_id=?`,
        ).run(projectScope.organizationId, projectScope.owner.kind, ownerId, now, sessionId);
      }
      this.stmt("UPDATE sessions SET project_id=?, project_location_id=?, updated_at=? WHERE id=?")
        .run(projectId, projectLocationId, now, sessionId);
    });
    return this.getSession(sessionId);
  }

  /** Atomically link an adopted session's exact authoritative cwd to a Project and file the session
   * there. A workspace-less import gets a managed workspace at its authoritative cwd; no
   * path translation or filesystem move is attempted. Authorization is enforced by the route,
   * while addProjectLocation/setSessionProject retain the audience-containment invariants. */
  linkAdoptedSessionProject(
    sessionId: string,
    projectId: string,
    now = Date.now(),
    adoptingUserId?: string,
  ): SessionView | null {
    return this.atomic(() => {
      const session = this.getSession(sessionId);
      if (!session) return null;
      if (!session.adopted) throw new Error("only adopted sessions can link a new Project Location while moving");
      const project = this.getProject(projectId);
      if (!project) throw new Error("project not found");

      const resolution = this.resolveAdoptedSessionLinkWorkspace(sessionId);
      const path = resolution?.path;
      if (!path) throw new Error("the imported session has no authoritative working directory");
      let workspaceId = resolution.workspaceId;
      if (resolution.ambiguous) {
        throw new Error("the imported working directory matches multiple Workspace identities");
      }
      if (!workspaceId) {
        workspaceId = this.createProjectWorkspace(
          projectId,
          session.runnerId,
          { name: project.name, path },
          now,
        ).id;
      }
      this.stmt("UPDATE sessions SET workspace_id=?, updated_at=? WHERE id=?")
        .run(workspaceId, now, sessionId);

      const location = this.findProjectLocationForProject(projectId, session.runnerId, workspaceId)
        ?? this.addProjectLocation(projectId, { runnerId: session.runnerId, workspaceId }, now);
      return this.setSessionProject(sessionId, projectId, location.id, now, adoptingUserId);
    });
  }

  /** Resolve the pre-existing Workspace identity that link-and-move will reuse. The route uses the
   * same result for authorization so it never checks an accessible parent while the transaction
   * later selects a different exact private Workspace. */
  resolveAdoptedSessionLinkWorkspace(sessionId: string): {
    path: string | null;
    workspaceId: string | null;
    ambiguous: boolean;
  } | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    const path = this.getAdHocWorkspacePath(sessionId)?.trim() || null;
    if (!path) return { path: null, workspaceId: null, ambiguous: false };
    const known = this.listKnownRunnerWorkspaces(session.runnerId);
    const currentPath = session.workspaceId
      ? known.find((workspace) => workspace.id === session.workspaceId)?.path
      : null;
    const exactIds = [...new Set(known
      .filter((workspace) => workspacePathsEqual(workspace.path, path))
      .map((workspace) => workspace.id))];
    const workspaceId = currentPath && workspacePathsEqual(currentPath, path)
      ? session.workspaceId
      : exactIds.length === 1 ? exactIds[0]! : null;
    return { path, workspaceId, ambiguous: exactIds.length > 1 && !workspaceId };
  }

  archiveProjectSessions(projectId: string, archived: boolean, now = Date.now()): SessionView[] {
    const value = archived ? 1 : 0;
    return this.atomic(() => {
      const ids = (this.stmt(
        "SELECT id FROM sessions WHERE project_id=? AND archived<>? ORDER BY id",
      ).all(projectId, value) as unknown as Array<{ id: string }>).map((row) => row.id);
      if (ids.length === 0) return [];
      this.stmt("UPDATE sessions SET archived=?, updated_at=? WHERE project_id=? AND archived<>?")
        .run(value, now, projectId, value);
      return ids.map((id) => this.getSession(id)!);
    });
  }

  deleteProject(projectId: string, now = Date.now()): { sessionIds: string[] } | null {
    if (!this.getProject(projectId)) return null;
    const sessionIds = (this.stmt("SELECT id FROM sessions WHERE project_id=? ORDER BY id").all(projectId) as
      unknown as Array<{ id: string }>).map((row) => row.id);
    this.atomic(() => {
      this.stmt(
        `INSERT OR IGNORE INTO project_location_suppressions (runner_id, workspace_id, created_at)
       SELECT location.runner_id, location.workspace_id, ?
       FROM project_locations location
       WHERE location.project_id=?
         AND NOT EXISTS (
             SELECT 1 FROM project_locations other
             WHERE other.runner_id=location.runner_id
               AND other.workspace_id=location.workspace_id
               AND other.project_id<>location.project_id
               AND other.removed_at IS NULL
           )`,
      ).run(now, projectId);
      this.stmt(
        "UPDATE sessions SET project_id=NULL, project_location_id=NULL, updated_at=? WHERE project_id=?",
      ).run(now, projectId);
      this.stmt("DELETE FROM projects WHERE id=?").run(projectId);
    });
    return { sessionIds };
  }

  private detachRunnerProjectLocations(runnerId: string, now: number): void {
    this.stmt(
      `UPDATE project_locations SET detached_at=COALESCE(detached_at, ?), updated_at=?
       WHERE runner_id=? AND removed_at IS NULL`,
    ).run(now, now, runnerId);
    this.stmt(
      `UPDATE projects SET default_location_id=NULL, updated_at=?
       WHERE default_location_id IN (
         SELECT id FROM project_locations WHERE runner_id=? AND detached_at IS NOT NULL
       )`,
    ).run(now, runnerId);
  }

  touch(runnerId: string, now: number): void {
    this.stmt("UPDATE runners SET last_seen=?, updated_at=? WHERE runner_id=?")
      .run(now, now, runnerId);
  }

  markOffline(runnerId: string, now: number): void {
    this.stmt(
        "UPDATE runners SET status='offline', connected_at=NULL, last_seen=?, updated_at=? WHERE runner_id=?",
      )
      .run(now, now, runnerId);
  }

  getRunner(runnerId: string): RunnerView | null {
    const row = this.stmt(
        "SELECT runner_id, hostname, os, version, status, connected_at, last_seen, protocol_version, agents_refreshed_at, editors, runtime, container_targets FROM runners WHERE runner_id=?",
      )
      .get(runnerId) as unknown as RunnerRow | undefined;
    return row ? this.runnerView(row) : null;
  }

  listRunners(): RunnerView[] {
    const rows = this.stmt(
        "SELECT runner_id, hostname, os, version, status, connected_at, last_seen, protocol_version, agents_refreshed_at, editors, runtime, container_targets FROM runners ORDER BY runner_id",
      )
      .all() as unknown as RunnerRow[];
    return rows.map((r) => this.runnerView(r));
  }

  /* --------------------------- Managed agent skills --------------------------- */

  private skillView(row: SkillRow): SkillView {
    const latest = row.latest_version_id
      ? (this.stmt("SELECT id, digest, created_at FROM skill_versions WHERE id=?")
        .get(row.latest_version_id) as { id: string; digest: string; created_at: number } | undefined)
      : undefined;
    const assignments = this.stmt("SELECT COUNT(*) AS n FROM skill_assignments WHERE skill_id=?")
      .get(row.id) as { n: number };
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      groupId: row.group_id,
      source: row.source,
      latestVersion: latest
        ? { id: latest.id, digest: latest.digest, createdAt: latest.created_at }
        : null,
      assignmentCount: Number(assignments.n),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private skillVersionView(row: SkillVersionRow): SkillVersionView {
    return {
      id: row.id,
      skillId: row.skill_id,
      digest: row.digest,
      manifest: row.manifest,
      files: parseJson<SkillFile[]>(row.files) ?? [],
      note: row.note,
      createdAt: row.created_at,
    };
  }

  private skillAssignmentView(row: SkillAssignmentRow): SkillAssignmentView {
    return {
      id: row.id,
      skillId: row.skill_id,
      scopeKind: row.scope_kind === "runner" ? "runner" : "instance",
      runnerId: row.runner_id,
      agentSelector: parseJson<SkillAgentSelector>(row.agent_selector) ?? { kind: "all" },
      enabled: row.enabled === 1,
      invocation: row.invocation === "manual" ? "manual" : "agent",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private insertSkillOwnership(skillId: string, scope: ResourceScope, now: number): void {
    const ownerId = scope.owner.kind === "organization" ? scope.owner.organizationId
      : scope.owner.kind === "user" ? scope.owner.userId : scope.owner.teamId;
    this.stmt(
      `INSERT INTO skill_ownership
       (skill_id, organization_id, owner_kind, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(skillId, scope.organizationId, scope.owner.kind, ownerId, now, now);
  }

  skillScope(skillId: string): ResourceScope | null {
    const row = this.stmt(
      "SELECT organization_id, owner_kind, owner_id FROM skill_ownership WHERE skill_id=?",
    ).get(skillId) as
      | { organization_id: string; owner_kind: "organization" | "user" | "team"; owner_id: string }
      | undefined;
    return row ? this.scopeFromRow(row) : null;
  }

  /** Per-resource skill authorization, exactly like canAccessProject: a missing ownership row
   * fails closed. */
  canAccessSkill(principal: AuthPrincipal, skillId: string): boolean {
    const scope = this.skillScope(skillId);
    return scope ? this.principalCanAccessScope(principal, scope) : false;
  }

  listSkillsForPrincipal(principal: AuthPrincipal): SkillView[] {
    return this.listSkills().filter((skill) => this.canAccessSkill(principal, skill.id));
  }

  /** Create a skill together with its first version. Throws on a duplicate name (the caller maps
   * that to 409); validation of names/files/digest happens in skills.ts before this call. */
  createSkill(input: {
    name: string;
    description?: string | null;
    groupId?: string | null;
    files: SkillFile[];
    manifest: string;
    digest: string;
    note?: string | null;
    scope?: ResourceScope;
    now?: number;
  }): SkillView {
    const now = input.now ?? Date.now();
    const skillId = `skill_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const versionId = `skillv_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const scope = input.scope ?? {
      organizationId: PERSONAL_ORGANIZATION_ID,
      owner: { kind: "organization" as const, organizationId: PERSONAL_ORGANIZATION_ID },
    };
    this.atomic(() => {
      const existing = this.stmt("SELECT 1 FROM skills WHERE name=?").get(input.name);
      if (existing) throw new Error("a skill with this name already exists");
      if (input.groupId && !this.stmt("SELECT 1 FROM skill_groups WHERE id=?").get(input.groupId)) {
        throw new Error("skill group not found");
      }
      this.stmt(
        `INSERT INTO skills (id, name, description, group_id, source, latest_version_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'library', ?, ?, ?)`,
      ).run(skillId, input.name, input.description ?? null, input.groupId ?? null, versionId, now, now);
      this.stmt(
        `INSERT INTO skill_versions (id, skill_id, digest, manifest, files, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(versionId, skillId, input.digest, input.manifest, JSON.stringify(input.files), input.note ?? null, now);
      this.insertSkillOwnership(skillId, scope, now);
    });
    return this.getSkill(skillId)!;
  }

  getSkill(skillId: string): SkillView | null {
    const row = this.stmt(
      "SELECT id, name, description, group_id, source, latest_version_id, created_at, updated_at FROM skills WHERE id=?",
    ).get(skillId) as unknown as SkillRow | undefined;
    return row ? this.skillView(row) : null;
  }

  getSkillByName(name: string): SkillView | null {
    const row = this.stmt(
      "SELECT id, name, description, group_id, source, latest_version_id, created_at, updated_at FROM skills WHERE name=?",
    ).get(name) as unknown as SkillRow | undefined;
    return row ? this.skillView(row) : null;
  }

  listSkills(): SkillView[] {
    const rows = this.stmt(
      "SELECT id, name, description, group_id, source, latest_version_id, created_at, updated_at FROM skills ORDER BY name",
    ).all() as unknown as SkillRow[];
    return rows.map((row) => this.skillView(row));
  }

  updateSkill(
    skillId: string,
    input: { description?: string | null; groupId?: string | null },
    now = Date.now(),
  ): SkillView | null {
    return this.atomic(() => {
      const current = this.stmt("SELECT description, group_id FROM skills WHERE id=?")
        .get(skillId) as { description: string | null; group_id: string | null } | undefined;
      if (!current) return null;
      if (input.groupId && !this.stmt("SELECT 1 FROM skill_groups WHERE id=?").get(input.groupId)) {
        throw new Error("skill group not found");
      }
      this.stmt("UPDATE skills SET description=?, group_id=?, updated_at=? WHERE id=?").run(
        input.description === undefined ? current.description : input.description,
        input.groupId === undefined ? current.group_id : input.groupId,
        now,
        skillId,
      );
      return this.getSkill(skillId);
    });
  }

  /** Append a new version and make it the latest (track-latest only in MVP). */
  addSkillVersion(
    skillId: string,
    input: { files: SkillFile[]; manifest: string; digest: string; note?: string | null },
    now = Date.now(),
  ): SkillVersionView | null {
    const versionId = `skillv_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    return this.atomic(() => {
      if (!this.stmt("SELECT 1 FROM skills WHERE id=?").get(skillId)) return null;
      this.stmt(
        `INSERT INTO skill_versions (id, skill_id, digest, manifest, files, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(versionId, skillId, input.digest, input.manifest, JSON.stringify(input.files), input.note ?? null, now);
      this.stmt("UPDATE skills SET latest_version_id=?, updated_at=? WHERE id=?").run(versionId, now, skillId);
      return this.getSkillVersion(versionId);
    });
  }

  getSkillVersion(versionId: string): SkillVersionView | null {
    const row = this.stmt(
      "SELECT id, skill_id, digest, manifest, files, note, created_at FROM skill_versions WHERE id=?",
    ).get(versionId) as unknown as SkillVersionRow | undefined;
    return row ? this.skillVersionView(row) : null;
  }

  deleteSkill(skillId: string): boolean {
    return this.atomic(() => {
      if (!this.stmt("SELECT 1 FROM skills WHERE id=?").get(skillId)) return false;
      this.stmt("DELETE FROM skill_assignments WHERE skill_id=?").run(skillId);
      this.stmt("DELETE FROM skill_versions WHERE skill_id=?").run(skillId);
      // skill_ownership cascades from the skills row.
      this.stmt("DELETE FROM skills WHERE id=?").run(skillId);
      return true;
    });
  }

  listSkillGroups(): SkillGroupView[] {
    const rows = this.stmt(
      "SELECT id, name, sort_order, created_at, updated_at FROM skill_groups ORDER BY sort_order, name",
    ).all() as unknown as Array<{ id: string; name: string; sort_order: number; created_at: number; updated_at: number }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  createSkillGroup(name: string, now = Date.now()): SkillGroupView {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("skill group name is required");
    const id = `skillg_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const order = this.stmt("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM skill_groups")
      .get() as { next: number };
    this.stmt(
      "INSERT INTO skill_groups (id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, trimmed, Number(order.next), now, now);
    return { id, name: trimmed, sortOrder: Number(order.next), createdAt: now, updatedAt: now };
  }

  /** Deleting a group only detaches its member skills (groups organize, never gate deployment). */
  deleteSkillGroup(groupId: string, now = Date.now()): boolean {
    return this.atomic(() => {
      if (!this.stmt("SELECT 1 FROM skill_groups WHERE id=?").get(groupId)) return false;
      this.stmt("UPDATE skills SET group_id=NULL, updated_at=? WHERE group_id=?").run(now, groupId);
      this.stmt("DELETE FROM skill_groups WHERE id=?").run(groupId);
      return true;
    });
  }

  listSkillAssignments(skillId?: string): SkillAssignmentView[] {
    const rows = (skillId
      ? this.stmt(
        `SELECT id, skill_id, scope_kind, runner_id, agent_selector, enabled, invocation, created_at, updated_at
         FROM skill_assignments WHERE skill_id=? ORDER BY created_at, id`,
      ).all(skillId)
      : this.stmt(
        `SELECT id, skill_id, scope_kind, runner_id, agent_selector, enabled, invocation, created_at, updated_at
         FROM skill_assignments ORDER BY created_at, id`,
      ).all()) as unknown as SkillAssignmentRow[];
    return rows.map((row) => this.skillAssignmentView(row));
  }

  /** Every assignment (including disabled overrides) whose scope covers this machine. */
  listSkillAssignmentsForRunner(runnerId: string): SkillAssignmentView[] {
    const rows = this.stmt(
      `SELECT id, skill_id, scope_kind, runner_id, agent_selector, enabled, invocation, created_at, updated_at
       FROM skill_assignments
       WHERE scope_kind='instance' OR (scope_kind='runner' AND runner_id=?)
       ORDER BY created_at, id`,
    ).all(runnerId) as unknown as SkillAssignmentRow[];
    return rows.map((row) => this.skillAssignmentView(row));
  }

  createSkillAssignment(input: {
    skillId: string;
    scopeKind: SkillAssignmentScopeKind;
    runnerId?: string | null;
    agentSelector: SkillAgentSelector;
    invocation?: SkillInvocationPolicy;
    enabled?: boolean;
    now?: number;
  }): SkillAssignmentView {
    const now = input.now ?? Date.now();
    const id = `skilla_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    return this.atomic(() => {
      if (!this.stmt("SELECT 1 FROM skills WHERE id=?").get(input.skillId)) {
        throw new Error("skill not found");
      }
      this.stmt(
        `INSERT INTO skill_assignments
         (id, skill_id, scope_kind, runner_id, agent_selector, enabled, invocation, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.skillId,
        input.scopeKind,
        input.scopeKind === "runner" ? input.runnerId ?? null : null,
        JSON.stringify(input.agentSelector),
        input.enabled === false ? 0 : 1,
        input.invocation ?? "agent",
        now,
        now,
      );
      return this.getSkillAssignment(id)!;
    });
  }

  getSkillAssignment(assignmentId: string): SkillAssignmentView | null {
    const row = this.stmt(
      `SELECT id, skill_id, scope_kind, runner_id, agent_selector, enabled, invocation, created_at, updated_at
       FROM skill_assignments WHERE id=?`,
    ).get(assignmentId) as unknown as SkillAssignmentRow | undefined;
    return row ? this.skillAssignmentView(row) : null;
  }

  updateSkillAssignment(
    assignmentId: string,
    input: { enabled?: boolean; invocation?: SkillInvocationPolicy },
    now = Date.now(),
  ): SkillAssignmentView | null {
    return this.atomic(() => {
      const current = this.getSkillAssignment(assignmentId);
      if (!current) return null;
      this.stmt("UPDATE skill_assignments SET enabled=?, invocation=?, updated_at=? WHERE id=?").run(
        (input.enabled ?? current.enabled) ? 1 : 0,
        input.invocation ?? current.invocation,
        now,
        assignmentId,
      );
      return this.getSkillAssignment(assignmentId);
    });
  }

  /** Returns the removed assignment so the caller knows which machines to re-sync. */
  deleteSkillAssignment(assignmentId: string): SkillAssignmentView | null {
    return this.atomic(() => {
      const current = this.getSkillAssignment(assignmentId);
      if (!current) return null;
      this.stmt("DELETE FROM skill_assignments WHERE id=?").run(assignmentId);
      return current;
    });
  }

  /** Persist a runner report. Deployment, unmanaged inventory, and error are full replacement;
   * removals are a bounded latest-event projection. A non-empty event replaces and timestamps
   * history, while an empty or omitted field retains the prior event for operator visibility. */
  setRunnerSkillState(
    runnerId: string,
    state: {
      deployed: DeployedSkillState[];
      unmanaged: UnmanagedSkillInfo[];
      removals?: SkillLinkRemoval[];
      error?: string;
    },
    now = Date.now(),
  ): void {
    const previous = this.getRunnerSkillState(runnerId);
    const incomingRemovals = normalizeSkillLinkRemovals(state.removals);
    const removals = incomingRemovals.length > 0 ? incomingRemovals : previous?.removals ?? [];
    const removalsUpdatedAt = incomingRemovals.length > 0
      ? now
      : previous?.removalsUpdatedAt;
    this.stmt(
      `INSERT INTO runner_skill_state (runner_id, state, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(runner_id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at`,
    ).run(runnerId, JSON.stringify({
      deployed: state.deployed,
      unmanaged: state.unmanaged,
      ...(removals.length === 0 ? {} : { removals }),
      ...(removalsUpdatedAt === undefined ? {} : { removalsUpdatedAt }),
      ...(state.error === undefined ? {} : { error: state.error }),
    }), now);
  }

  /** Read both current inventory and the independent latest-removal event. Legacy blobs without
   * removals read as an empty history with no event timestamp. */
  getRunnerSkillState(runnerId: string): RunnerSkillStateRecord | null {
    const row = this.stmt("SELECT state, updated_at FROM runner_skill_state WHERE runner_id=?")
      .get(runnerId) as { state: string; updated_at: number } | undefined;
    if (!row) return null;
    const parsed = parseJson<{
      deployed?: DeployedSkillState[];
      unmanaged?: UnmanagedSkillInfo[];
      removals?: SkillLinkRemoval[];
      removalsUpdatedAt?: number;
      error?: string;
    }>(row.state);
    const removals = normalizeSkillLinkRemovals(parsed?.removals);
    const removalsUpdatedAt = removals.length === 0
      ? undefined
      : parsed?.removalsUpdatedAt ?? row.updated_at;
    return {
      runnerId,
      deployed: parsed?.deployed ?? [],
      unmanaged: parsed?.unmanaged ?? [],
      removals,
      ...(removalsUpdatedAt === undefined ? {} : { removalsUpdatedAt }),
      ...(parsed?.error === undefined ? {} : { error: parsed.error }),
      updatedAt: row.updated_at,
    };
  }

  /* ------------------------- Runner credentials ------------------------- */

  private runnerCredentialView(row: RunnerCredentialRow): RunnerCredentialView {
    return {
      credentialId: row.credential_id,
      runnerId: row.runner_id,
      organizationId: row.organization_id,
      scope: this.scopeFromRow(row),
      label: row.label,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      activatedAt: row.activated_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
      legacy: row.legacy === 1,
    };
  }

  listRunnerCredentials(organizationId: string): RunnerCredentialView[] {
    const rows = this.stmt(
      `SELECT credential_id, runner_id, organization_id, owner_kind, owner_id, label, token_hash, created_by_user_id,
              status, created_at, expires_at, activated_at, last_used_at, revoked_at, replaced_by_id, legacy
       FROM runner_credentials WHERE organization_id=?
       ORDER BY runner_id, created_at DESC,
                CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
                credential_id DESC`,
    ).all(organizationId) as unknown as RunnerCredentialRow[];
    return rows.map((row) => this.runnerCredentialView(row));
  }

  activeRunnerCredential(runnerId: string): RunnerCredentialView | null {
    const row = this.stmt(
      `SELECT credential_id, runner_id, organization_id, owner_kind, owner_id, label, token_hash, created_by_user_id,
              status, created_at, expires_at, activated_at, last_used_at, revoked_at, replaced_by_id, legacy
       FROM runner_credentials WHERE runner_id=? AND status='active'`,
    ).get(runnerId) as unknown as RunnerCredentialRow | undefined;
    return row ? this.runnerCredentialView(row) : null;
  }

  runnerCredentialScope(runnerId: string): ResourceScope | null {
    const row = this.stmt(
      `SELECT organization_id, owner_kind, owner_id FROM runner_credentials
       WHERE runner_id=? ORDER BY created_at DESC, credential_id DESC LIMIT 1`,
    ).get(runnerId) as
      | { organization_id: string; owner_kind: "organization" | "user" | "team"; owner_id: string }
      | undefined;
    return row ? this.scopeFromRow(row) : null;
  }

  /** Revoked hashes cannot authenticate. Retain a bounded recent operational history while the
   * immutable mutation audit remains the long-lived attribution record. The one legacy migration
   * row is kept separately so upgrade provenance cannot be erased by ordinary rotations. */
  private pruneRevokedRunnerCredentials(runnerId: string): void {
    this.stmt(
      `DELETE FROM runner_credentials
       WHERE runner_id=? AND status='revoked' AND legacy=0 AND credential_id NOT IN (
         SELECT credential_id FROM runner_credentials
         WHERE runner_id=? AND status='revoked' AND legacy=0
         ORDER BY COALESCE(revoked_at, created_at) DESC, created_at DESC, credential_id DESC
         LIMIT ?
       )`,
    ).run(runnerId, runnerId, RUNNER_CREDENTIAL_REVOKED_HISTORY_LIMIT);
  }

  issueRunnerCredential(input: {
    credentialId: string;
    runnerId: string;
    organizationId: string;
    ownerKind: "organization" | "user" | "team";
    ownerId: string;
    label: string;
    tokenHash: string;
    createdByUserId?: string;
    now: number;
    expiresAt: number;
  }): RunnerCredentialView {
    const scope = this.runnerScope(input.runnerId);
    const requestedOwnerId = input.ownerKind === "organization"
      ? input.organizationId
      : input.ownerId;
    if (scope && (scope.organizationId !== input.organizationId || scope.owner.kind !== input.ownerKind ||
        (scope.owner.kind === "organization" ? scope.owner.organizationId
          : scope.owner.kind === "user" ? scope.owner.userId : scope.owner.teamId) !== requestedOwnerId)) {
      throw new Error("runner belongs to another owner");
    }
    const reserved = this.stmt(
      "SELECT organization_id, owner_kind, owner_id FROM runner_credentials WHERE runner_id=? LIMIT 1",
    ).get(input.runnerId) as
      | { organization_id: string; owner_kind: string; owner_id: string }
      | undefined;
    if (reserved && (reserved.organization_id !== input.organizationId ||
        reserved.owner_kind !== input.ownerKind || reserved.owner_id !== input.ownerId)) {
      throw new Error("runner id is reserved by another owner");
    }
    this.db.exec("BEGIN");
    try {
      this.stmt(
        `UPDATE runner_credentials SET status='revoked', revoked_at=?, replaced_by_id=?
         WHERE runner_id=? AND organization_id=? AND status='pending'`,
      ).run(input.now, input.credentialId, input.runnerId, input.organizationId);
      this.stmt(
        `INSERT INTO runner_credentials
           (credential_id, runner_id, organization_id, owner_kind, owner_id, label, token_hash, created_by_user_id,
            status, created_at, expires_at, legacy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0)`,
      ).run(
        input.credentialId,
        input.runnerId,
        input.organizationId,
        input.ownerKind,
        input.ownerId,
        input.label,
        input.tokenHash,
        input.createdByUserId ?? null,
        input.now,
        input.expiresAt,
      );
      this.pruneRevokedRunnerCredentials(input.runnerId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const row = this.stmt(
      `SELECT credential_id, runner_id, organization_id, owner_kind, owner_id, label, token_hash, created_by_user_id,
              status, created_at, expires_at, activated_at, last_used_at, revoked_at, replaced_by_id, legacy
       FROM runner_credentials WHERE credential_id=?`,
    ).get(input.credentialId) as unknown as RunnerCredentialRow;
    return this.runnerCredentialView(row);
  }

  authenticateRunnerCredential(
    runnerId: string,
    tokenHash: string,
    now: number,
    manageTransaction = true,
  ): { credentialId: string; scope: ResourceScope; legacy: boolean; activated: boolean } | null {
    const row = this.stmt(
      `SELECT credential_id, organization_id, owner_kind, owner_id, status, expires_at, legacy FROM runner_credentials
       WHERE runner_id=? AND token_hash=? AND status IN ('pending','active')`,
    ).get(runnerId, tokenHash) as
      | { credential_id: string; organization_id: string; owner_kind: "organization" | "user" | "team";
          owner_id: string; status: "pending" | "active"; expires_at: number | null; legacy: number }
      | undefined;
    if (!row) return null;
    if (row.status === "pending" && (row.expires_at === null || row.expires_at <= now)) {
      this.stmt(
        "UPDATE runner_credentials SET status='revoked', revoked_at=? WHERE credential_id=? AND status='pending'",
      ).run(now, row.credential_id);
      this.pruneRevokedRunnerCredentials(runnerId);
      return null;
    }
    if (row.status === "active") {
      this.stmt("UPDATE runner_credentials SET last_used_at=? WHERE credential_id=?")
        .run(now, row.credential_id);
      return {
        credentialId: row.credential_id,
        scope: this.scopeFromRow(row),
        legacy: row.legacy === 1,
        activated: false,
      };
    }
    if (manageTransaction) this.db.exec("BEGIN");
    try {
      this.stmt(
        `UPDATE runner_credentials SET status='revoked', revoked_at=?, replaced_by_id=?
         WHERE runner_id=? AND status='active'`,
      ).run(now, row.credential_id, runnerId);
      const promoted = this.stmt(
        `UPDATE runner_credentials
         SET status='active', activated_at=?, expires_at=NULL, last_used_at=?
         WHERE credential_id=? AND runner_id=? AND status='pending' AND expires_at>?`,
      ).run(now, now, row.credential_id, runnerId, now);
      if (promoted.changes !== 1) throw new Error("runner credential activation raced or expired");
      this.pruneRevokedRunnerCredentials(runnerId);
      if (manageTransaction) this.db.exec("COMMIT");
    } catch (error) {
      if (manageTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      credentialId: row.credential_id,
      scope: this.scopeFromRow(row),
      legacy: false,
      activated: true,
    };
  }

  /** Registration and pending-credential activation share one SQLite transaction. Invalid runner
   * metadata cannot strand the replacement active while revoking the last working credential. */
  registerRunnerWithCredential(
    meta: RunnerMetadata,
    tokenHash: string,
    now: number,
    protocolVersion: number | null = null,
  ): { credentialId: string; scope: ResourceScope; legacy: boolean; activated: boolean } | null {
    this.db.exec("BEGIN");
    try {
      const credential = this.authenticateRunnerCredential(meta.runnerId, tokenHash, now, false);
      if (!credential) {
        this.db.exec("COMMIT");
        return null;
      }
      this.registerRunner(meta, now, protocolVersion, credential.scope, false);
      this.db.exec("COMMIT");
      return credential;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  isRunnerCredentialActive(runnerId: string, credentialId: string): boolean {
    return Boolean(this.stmt(
      "SELECT 1 FROM runner_credentials WHERE runner_id=? AND credential_id=? AND status='active'",
    ).get(runnerId, credentialId));
  }

  /** Read-only active-token verification for conductor REST claims. Pending credentials may be
   * promoted only by the runner registration channel. */
  verifyActiveRunnerCredential(runnerId: string, tokenHash: string): boolean {
    return Boolean(this.stmt(
      "SELECT 1 FROM runner_credentials WHERE runner_id=? AND token_hash=? AND status='active'",
    ).get(runnerId, tokenHash));
  }

  /** Read-only pre-registration verification. Attestation must not activate a pending token,
   * revoke the previous active token, or update last-used timestamps before the runner has safely
   * acquired its local stores. */
  verifyRunnerCredentialForAttestation(runnerId: string, tokenHash: string, now: number): boolean {
    return Boolean(this.stmt(
      `SELECT 1 FROM runner_credentials
       WHERE runner_id=? AND token_hash=? AND (
         status='active' OR (status='pending' AND expires_at IS NOT NULL AND expires_at>?)
       )`,
    ).get(runnerId, tokenHash, now));
  }

  revokeRunnerCredential(runnerId: string, organizationId: string, now: number): boolean {
    const changed = this.stmt(
      `UPDATE runner_credentials SET status='revoked', revoked_at=?
       WHERE runner_id=? AND organization_id=? AND status IN ('pending','active')`,
    ).run(now, runnerId, organizationId).changes > 0;
    if (changed) this.pruneRevokedRunnerCredentials(runnerId);
    return changed;
  }

  /** One-time upgrade bridge for a single-runner installation. A fleet token cannot safely be
   * materialized as multiple exact-runner credentials: every holder could still impersonate every
   * migrated runner. Multi-runner installations therefore fail closed and require explicit
   * runner-specific credential issuance. A revoked/rotated runner is never re-seeded. */
  backfillLegacyRunnerCredentials(tokenHash: string, now: number): { migrated: number; blocked: number } {
    const rows = this.stmt(
      `SELECT runner.runner_id, COALESCE(ownership.organization_id, ?) AS organization_id,
              COALESCE(ownership.owner_kind, 'organization') AS owner_kind,
              COALESCE(ownership.owner_id, ?) AS owner_id
       FROM runners runner
       LEFT JOIN runner_ownership ownership ON ownership.runner_id=runner.runner_id
       WHERE NOT EXISTS (
         SELECT 1 FROM runner_credentials credential WHERE credential.runner_id=runner.runner_id
       )`,
    ).all(PERSONAL_ORGANIZATION_ID, PERSONAL_ORGANIZATION_ID) as unknown as Array<{
      runner_id: string;
      organization_id: string;
      owner_kind: "organization" | "user" | "team";
      owner_id: string;
    }>;
    const runnerCount = Number((this.stmt("SELECT COUNT(*) AS count FROM runners").get() as { count: number }).count);
    if (runnerCount !== 1 || rows.length !== 1) {
      return { migrated: 0, blocked: rows.length };
    }
    for (const row of rows) {
      this.stmt(
        `INSERT INTO runner_credentials
           (credential_id, runner_id, organization_id, owner_kind, owner_id, label, token_hash, status,
            created_at, activated_at, legacy)
         VALUES (?, ?, ?, ?, ?, 'Migrated legacy runner token', ?, 'active', ?, ?, 1)`,
      ).run(
        `rcred_${randomUUID().replace(/-/g, "")}`,
        row.runner_id,
        row.organization_id,
        row.owner_kind,
        row.owner_id,
        tokenHash,
        now,
        now,
      );
    }
    return { migrated: rows.length, blocked: 0 };
  }

  /** One-way v54 startup scrub. New runners never advertise env values; legacy agent rows are
   * cleared, and any durable start command that still embeds values is settled before dispatch. */
  scrubLegacyAgentSecrets(now: number): { agentRows: number; commands: number } {
    const agentRows = Number(this.stmt("UPDATE runner_agents SET env='{}' WHERE env IS NOT NULL AND env != '{}'").run().changes);
    const rows = this.stmt(
      "SELECT command_id, state, payload_json FROM automation_commands WHERE payload_json != 'null'",
    ).all() as unknown as Array<{ command_id: string; state: AutomationCommandState; payload_json: string }>;
    let commands = 0;
    for (const row of rows) {
      let containsEnvironment = false;
      try {
        const command = JSON.parse(row.payload_json) as { type?: unknown; spec?: { env?: unknown } };
        containsEnvironment = command.type === "start_session" && Boolean(
          command.spec?.env && typeof command.spec.env === "object" && Object.keys(command.spec.env).length,
        );
      } catch {
        continue;
      }
      if (!containsEnvironment) continue;
      const nextState: AutomationCommandState = row.state === "accepted" || row.state === "started"
        ? "uncertain"
        : ["staged", "pending", "sent"].includes(row.state)
          ? "rejected"
          : row.state;
      this.stmt(
        `UPDATE automation_commands
         SET state=?, revision=revision+1, payload_json='null',
             last_error=COALESCE(last_error, 'legacy command rejected because it contained agent environment values'),
             error_code=COALESCE(error_code, 'INVALID_COMMAND'), updated_at=?,
             completed_at=CASE WHEN ? IN ('rejected','uncertain') THEN COALESCE(completed_at, ?) ELSE completed_at END
         WHERE command_id=?`,
      ).run(nextState, now, nextState, now, row.command_id);
      commands++;
    }
    try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* another connection may be reading */ }
    return { agentRows, commands };
  }

  deleteRunnerCredentials(runnerId: string): void {
    this.stmt("DELETE FROM runner_credentials WHERE runner_id=?").run(runnerId);
  }

  /* ------------------------------ Devices -------------------------------- */

  createDevice(input: {
    id: string;
    name: string;
    tokenHash: string;
    userId?: string;
    organizationId?: string;
    now: number;
  }): void {
    const userId = input.userId ?? LOCAL_OWNER_USER_ID;
    const organizationId = input.organizationId ?? PERSONAL_ORGANIZATION_ID;
    const membership = this.stmt(
      `SELECT 1 FROM identity_memberships membership
       JOIN identity_users user ON user.user_id=membership.user_id
       WHERE membership.organization_id=? AND membership.user_id=? AND user.status='active'`,
    ).get(organizationId, userId);
    if (!membership) throw new Error("device identity must be an active organization member");
    this.stmt(
      "INSERT INTO devices (id, name, token_hash, user_id, organization_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(input.id, input.name, input.tokenHash, userId, organizationId, input.now);
  }

  /** Auth lookup — returns the device a presented token belongs to, or null. */
  deviceByTokenHash(tokenHash: string): ({ id: string; name: string; lastSeenAt: number | null } & IdentityContextView) | null {
    const row = this.stmt(
      `SELECT device.id, device.name, device.last_seen_at,
              user.user_id, user.display_name AS user_name,
              organization.organization_id, organization.name AS organization_name,
              membership.role
       FROM devices device
       JOIN identity_users user ON user.user_id=device.user_id AND user.status='active'
       JOIN identity_organizations organization ON organization.organization_id=device.organization_id
       JOIN identity_memberships membership
         ON membership.user_id=device.user_id AND membership.organization_id=device.organization_id
       WHERE device.token_hash=?`,
    ).get(tokenHash) as
      | { id: string; name: string; last_seen_at: number | null; user_id: string; user_name: string;
          organization_id: string; organization_name: string; role: OrganizationRole }
      | undefined;
    return row ? {
      id: row.id,
      name: row.name,
      lastSeenAt: row.last_seen_at,
      userId: row.user_id,
      userName: row.user_name,
      organizationId: row.organization_id,
      organizationName: row.organization_name,
      role: row.role,
      deviceId: row.id,
      localBootstrap: false,
    } : null;
  }

  listDevices(): DeviceView[] {
    return (
      this.stmt(
        `SELECT device.id, device.name, device.created_at, device.last_seen_at,
                user.user_id, user.display_name AS user_name,
                organization.organization_id, organization.name AS organization_name,
                membership.role
         FROM devices device
         JOIN identity_users user ON user.user_id=device.user_id
         JOIN identity_organizations organization ON organization.organization_id=device.organization_id
         JOIN identity_memberships membership
           ON membership.user_id=device.user_id AND membership.organization_id=device.organization_id
         ORDER BY device.created_at, device.id`,
      ).all() as unknown as Array<{ id: string; name: string; created_at: number; last_seen_at: number | null;
        user_id: string; user_name: string; organization_id: string; organization_name: string; role: OrganizationRole }>
    ).map((r) => ({
      deviceId: r.id,
      name: r.name,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      userId: r.user_id,
      userName: r.user_name,
      organizationId: r.organization_id,
      organizationName: r.organization_name,
      role: r.role,
    }));
  }

  listDevicesForOrganization(organizationId: string): DeviceView[] {
    return this.listDevices().filter((device) => device.organizationId === organizationId);
  }

  deviceIdsForUser(userId: string): string[] {
    return (this.stmt("SELECT id FROM devices WHERE user_id=?").all(userId) as unknown as Array<{ id: string }>)
      .map((row) => row.id);
  }

  touchDevice(id: string, now: number): void {
    this.stmt("UPDATE devices SET last_seen_at=? WHERE id=?").run(now, id);
  }

  /** Revoke a device (its token stops working on the next request). Its push subscriptions
   * go with it — a revoked phone must stop receiving session notifications too. */
  deleteDevice(id: string): boolean {
    this.stmt("DELETE FROM push_subscriptions WHERE device_id=?").run(id);
    return Number(this.stmt("DELETE FROM devices WHERE id=?").run(id).changes) > 0;
  }

  /* ----------------------- Identity and mutation audit ------------------- */

  localIdentityContext(): IdentityContextView {
    const row = this.stmt(
      `SELECT user.display_name AS user_name, organization.name AS organization_name
       FROM identity_users user, identity_organizations organization
       WHERE user.user_id=? AND organization.organization_id=?`,
    ).get(LOCAL_OWNER_USER_ID, PERSONAL_ORGANIZATION_ID) as unknown as {
      user_name: string;
      organization_name: string;
    };
    return {
      userId: LOCAL_OWNER_USER_ID,
      userName: row.user_name,
      organizationId: PERSONAL_ORGANIZATION_ID,
      organizationName: row.organization_name,
      role: "owner",
      deviceId: null,
      localBootstrap: true,
    };
  }

  identityAdministration(context: IdentityContextView): IdentityAdministrationView {
    const organizations = this.stmt(
      `SELECT organization.organization_id, organization.name, organization.created_at
       FROM identity_organizations organization
       JOIN identity_memberships membership ON membership.organization_id=organization.organization_id
       WHERE membership.user_id=? ORDER BY organization.created_at, organization.organization_id`,
    ).all(context.userId) as unknown as Array<{ organization_id: string; name: string; created_at: number }>;
    const memberships = this.stmt(
      `SELECT membership.organization_id, organization.name AS organization_name,
              membership.user_id, user.display_name AS user_name, user.status,
              membership.role, membership.created_at
       FROM identity_memberships membership
       JOIN identity_users user ON user.user_id=membership.user_id
       JOIN identity_organizations organization ON organization.organization_id=membership.organization_id
       WHERE membership.organization_id=?
       ORDER BY CASE membership.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END,
                lower(user.display_name), user.user_id`,
    ).all(context.organizationId) as unknown as Array<{
      organization_id: string; organization_name: string; user_id: string; user_name: string;
      status: UserStatus; role: OrganizationRole; created_at: number;
    }>;
    const teams = this.stmt(
      `SELECT team.team_id, team.organization_id, team.name, team.created_at,
              COALESCE(json_group_array(member.user_id) FILTER (WHERE member.user_id IS NOT NULL), '[]') AS members
       FROM identity_teams team
       LEFT JOIN identity_team_members member ON member.team_id=team.team_id
       WHERE team.organization_id=?
       GROUP BY team.team_id ORDER BY lower(team.name), team.team_id`,
    ).all(context.organizationId) as unknown as Array<{
      team_id: string; organization_id: string; name: string; created_at: number; members: string;
    }>;
    return {
      context,
      organizations: organizations.map((row): OrganizationView => ({
        organizationId: row.organization_id, name: row.name, createdAt: row.created_at,
      })),
      memberships: memberships.map((row): OrganizationMembershipView => ({
        organizationId: row.organization_id,
        organizationName: row.organization_name,
        userId: row.user_id,
        userName: row.user_name,
        userStatus: row.status,
        role: row.role,
        createdAt: row.created_at,
      })),
      teams: teams.map((row): TeamView => ({
        teamId: row.team_id,
        organizationId: row.organization_id,
        name: row.name,
        memberUserIds: JSON.parse(row.members) as string[],
        createdAt: row.created_at,
      })),
    };
  }

  createIdentityMember(input: {
    userId: string;
    displayName: string;
    organizationId: string;
    role: OrganizationRole;
    now: number;
  }): OrganizationMembershipView {
    this.db.exec("BEGIN");
    try {
      this.stmt(
        `INSERT INTO identity_users (user_id, display_name, status, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?)`,
      ).run(input.userId, input.displayName, input.now, input.now);
      this.stmt(
        `INSERT INTO identity_memberships (organization_id, user_id, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(input.organizationId, input.userId, input.role, input.now, input.now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const context = { ...this.localIdentityContext(), organizationId: input.organizationId };
    return this.identityAdministration(context).memberships.find((item) => item.userId === input.userId)!;
  }

  updateIdentityMember(input: {
    organizationId: string;
    userId: string;
    displayName: string;
    role: OrganizationRole;
    status: UserStatus;
    now: number;
  }): OrganizationMembershipView | null {
    const current = this.stmt(
      "SELECT role FROM identity_memberships WHERE organization_id=? AND user_id=?",
    ).get(input.organizationId, input.userId) as { role: OrganizationRole } | undefined;
    if (!current) return null;
    if (current.role === "owner" && (input.role !== "owner" || input.status !== "active")) {
      const owners = this.stmt(
        `SELECT COUNT(*) AS n FROM identity_memberships membership
         JOIN identity_users user ON user.user_id=membership.user_id
         WHERE membership.organization_id=? AND membership.role='owner' AND user.status='active'`,
      ).get(input.organizationId) as { n: number };
      if (Number(owners.n) <= 1) throw new Error("an organization must retain an active owner");
    }
    this.db.exec("BEGIN");
    try {
      this.stmt("UPDATE identity_users SET display_name=?, status=?, updated_at=? WHERE user_id=?")
        .run(input.displayName, input.status, input.now, input.userId);
      this.stmt("UPDATE identity_memberships SET role=?, updated_at=? WHERE organization_id=? AND user_id=?")
        .run(input.role, input.now, input.organizationId, input.userId);
      if (input.status === "suspended") {
        this.stmt("DELETE FROM push_subscriptions WHERE device_id IN (SELECT id FROM devices WHERE user_id=?)")
          .run(input.userId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const context = { ...this.localIdentityContext(), organizationId: input.organizationId };
    return this.identityAdministration(context).memberships.find((item) => item.userId === input.userId)!;
  }

  createIdentityTeam(input: {
    teamId: string;
    organizationId: string;
    name: string;
    memberUserIds: string[];
    now: number;
  }): TeamView {
    this.db.exec("BEGIN");
    try {
      this.stmt(
        "INSERT INTO identity_teams (team_id, organization_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(input.teamId, input.organizationId, input.name, input.now, input.now);
      this.insertIdentityTeamMembers(input.teamId, input.organizationId, input.memberUserIds, input.now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const context = { ...this.localIdentityContext(), organizationId: input.organizationId };
    return this.identityAdministration(context).teams.find((team) => team.teamId === input.teamId)!;
  }

  updateIdentityTeamMembers(input: {
    teamId: string;
    organizationId: string;
    memberUserIds: string[];
    now: number;
  }): TeamView | null {
    const team = this.stmt("SELECT 1 FROM identity_teams WHERE team_id=? AND organization_id=?")
      .get(input.teamId, input.organizationId);
    if (!team) return null;
    this.db.exec("BEGIN");
    try {
      const proposedMemberIds = new Set(input.memberUserIds);
      const removedMemberIds = new Set((this.stmt(
        "SELECT user_id FROM identity_team_members WHERE team_id=?",
      ).all(input.teamId) as unknown as Array<{ user_id: string }>)
        .map((row) => row.user_id)
        .filter((userId) => !proposedMemberIds.has(userId)));
      this.assertTeamMemberRemovalPreservesResourceContainment(
        input.teamId,
        input.organizationId,
        removedMemberIds,
      );
      this.stmt("DELETE FROM identity_team_members WHERE team_id=?").run(input.teamId);
      this.insertIdentityTeamMembers(input.teamId, input.organizationId, input.memberUserIds, input.now);
      this.stmt("UPDATE identity_teams SET updated_at=? WHERE team_id=?").run(input.now, input.teamId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const context = { ...this.localIdentityContext(), organizationId: input.organizationId };
    return this.identityAdministration(context).teams.find((item) => item.teamId === input.teamId)!;
  }

  /** Membership can be part of a persisted privacy invariant: a user-owned resource is safely
   * nested inside a team-owned parent only while that user remains a member of the team. */
  private assertTeamMemberRemovalPreservesResourceContainment(
    teamId: string,
    organizationId: string,
    removedMemberIds: ReadonlySet<string>,
  ): void {
    if (removedMemberIds.size === 0) return;
    const dependency = (
      narrower: ResourceScope | null,
      wider: ResourceScope | null,
      relationship: string,
    ): void => {
      if (!narrower || !wider || narrower.organizationId !== organizationId ||
          wider.organizationId !== organizationId || narrower.owner.kind !== "user" ||
          wider.owner.kind !== "team" || wider.owner.teamId !== teamId ||
          !removedMemberIds.has(narrower.owner.userId)) return;
      throw new Error(
        `cannot remove user '${narrower.owner.userId}' from this team because ${relationship} ` +
        "relies on that membership; change the related access scopes first",
      );
    };
    const locations = this.stmt(
      `SELECT id, project_id, runner_id, workspace_id FROM project_locations
       WHERE removed_at IS NULL`,
    ).all() as unknown as Array<{
      id: string;
      project_id: string;
      runner_id: string;
      workspace_id: string;
    }>;
    for (const location of locations) {
      const projectScope = this.projectScope(location.project_id);
      const runnerScope = this.runnerScope(location.runner_id);
      const locationScope = this.workspaceScope(location.runner_id, location.workspace_id) ?? runnerScope;
      dependency(projectScope, locationScope,
        `Project '${location.project_id}' containment in Location '${location.id}'`);
    }
    const workspaces = this.stmt(
      "SELECT runner_id, workspace_id FROM workspace_ownership WHERE organization_id=?",
    ).all(organizationId) as unknown as Array<{ runner_id: string; workspace_id: string }>;
    for (const workspace of workspaces) {
      dependency(
        this.workspaceScope(workspace.runner_id, workspace.workspace_id),
        this.runnerScope(workspace.runner_id),
        `Location '${workspace.workspace_id}' containment in Machine '${workspace.runner_id}'`,
      );
    }
    const sessions = this.stmt(
      "SELECT id, project_id, runner_id, workspace_id FROM sessions",
    ).all() as unknown as Array<{
      id: string;
      project_id: string | null;
      runner_id: string;
      workspace_id: string | null;
    }>;
    for (const session of sessions) {
      const sessionScope = this.sessionScope(session.id);
      const projectScope = session.project_id ? this.projectScope(session.project_id) : null;
      const runnerScope = this.runnerScope(session.runner_id);
      const executionScope = session.workspace_id
        ? this.workspaceScope(session.runner_id, session.workspace_id) ?? runnerScope
        : runnerScope;
      dependency(sessionScope, projectScope,
        `Session '${session.id}' containment in Project '${session.project_id ?? "unknown"}'`);
      dependency(sessionScope, executionScope,
        `Session '${session.id}' containment in its execution Location or Machine`);
    }
  }

  private insertIdentityTeamMembers(teamId: string, organizationId: string, userIds: string[], now: number): void {
    const insert = this.stmt(
      `INSERT INTO identity_team_members (team_id, user_id, created_at)
       SELECT ?, membership.user_id, ? FROM identity_memberships membership
       WHERE membership.organization_id=? AND membership.user_id=?`,
    );
    for (const userId of userIds) {
      if (Number(insert.run(teamId, now, organizationId, userId).changes) !== 1) {
        throw new Error("team members must belong to the same organization");
      }
    }
  }

  deleteIdentityTeam(teamId: string, organizationId: string): boolean {
    const owned = this.stmt(
      `SELECT 1 FROM runner_ownership WHERE organization_id=? AND owner_kind='team' AND owner_id=?
       UNION ALL SELECT 1 FROM workspace_ownership WHERE organization_id=? AND owner_kind='team' AND owner_id=?
       UNION ALL SELECT 1 FROM project_ownership WHERE organization_id=? AND owner_kind='team' AND owner_id=?
       UNION ALL SELECT 1 FROM session_ownership WHERE organization_id=? AND owner_kind='team' AND owner_id=?
       LIMIT 1`,
    ).get(organizationId, teamId, organizationId, teamId, organizationId, teamId, organizationId, teamId);
    if (owned) throw new Error("reassign resources owned by this team before deleting it");
    const retainedUsage = this.stmt(
      `SELECT 1 FROM usage_hourly WHERE organization_id=? AND owner_kind='team' AND owner_id=?
       UNION ALL SELECT 1 FROM usage_daily WHERE organization_id=? AND owner_kind='team' AND owner_id=?
       LIMIT 1`,
    ).get(organizationId, teamId, organizationId, teamId);
    if (retainedUsage) throw new Error("retained usage for this team must expire before deleting it");
    return Number(this.stmt("DELETE FROM identity_teams WHERE team_id=? AND organization_id=?")
      .run(teamId, organizationId).changes) > 0;
  }

  private archiveMutationAudit(now: number): void {
    this.db.exec("BEGIN");
    try {
      const insert = this.stmt(
        `INSERT OR IGNORE INTO mutation_audit_archive
         (audit_id, actor_kind, actor_id, user_id, device_id, organization_id,
          method, route, target_id, status_code, created_at, archived_at)
         SELECT audit_id, actor_kind, actor_id, user_id, device_id, organization_id,
                method, route, target_id, status_code, created_at, ?
         FROM mutation_audit WHERE status_code != 0 AND created_at < ?`,
      );
      insert.run(now, now - 180 * 86_400_000);
      this.stmt(
        `INSERT OR IGNORE INTO mutation_audit_archive
         (audit_id, actor_kind, actor_id, user_id, device_id, organization_id,
          method, route, target_id, status_code, created_at, archived_at)
         SELECT audit_id, actor_kind, actor_id, user_id, device_id, organization_id,
                method, route, target_id, status_code, created_at, ?
         FROM mutation_audit WHERE row_id IN
           (SELECT row_id FROM mutation_audit WHERE status_code != 0
            ORDER BY row_id DESC LIMIT -1 OFFSET 100000)`,
      ).run(now);
      this.db.exec(
        `DELETE FROM mutation_audit
         WHERE status_code != 0 AND audit_id IN (SELECT audit_id FROM mutation_audit_archive)`,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordMutationAudit(input: {
    auditId: string;
    principal: AuthPrincipal | null;
    method: string;
    route: string;
    targetId?: string;
    statusCode: number;
    now: number;
  }): void {
    if (input.now - this.lastMutationAuditArchive >= 3_600_000) {
      this.lastMutationAuditArchive = input.now;
      this.archiveMutationAudit(input.now);
    }
    this.stmt(
      `INSERT INTO mutation_audit
       (audit_id, actor_kind, actor_id, user_id, device_id, organization_id,
        method, route, target_id, status_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.auditId,
      input.principal?.kind ?? "anonymous",
      input.principal?.actorId ?? null,
      input.principal?.userId ?? null,
      input.principal?.deviceId ?? null,
      input.principal?.organizationId ?? null,
      input.method.slice(0, 16),
      input.route.slice(0, 256),
      input.targetId?.slice(0, 256) ?? null,
      input.statusCode,
      input.now,
    );
    this.mutationAuditWritesSinceArchive += 1;
    if (this.mutationAuditWritesSinceArchive >= 256) {
      this.mutationAuditWritesSinceArchive = 0;
      this.archiveMutationAudit(input.now);
    }
  }

  completeMutationAudit(auditId: string, statusCode: number): boolean {
    return Number(this.stmt("UPDATE mutation_audit SET status_code=? WHERE audit_id=?")
      .run(statusCode, auditId).changes) > 0;
  }

  listMutationAudit(organizationId: string, limit = 100): MutationAuditView[] {
    const rows = this.stmt(
      `SELECT audit_id, actor_kind, actor_id, user_id, device_id, organization_id,
              method, route, target_id, status_code, created_at
       FROM (
         SELECT audit_id, actor_kind, actor_id, user_id, device_id, organization_id,
                method, route, target_id, status_code, created_at FROM mutation_audit
         UNION ALL
         SELECT audit_id, actor_kind, actor_id, user_id, device_id, organization_id,
                method, route, target_id, status_code, created_at FROM mutation_audit_archive
       ) WHERE organization_id=? OR organization_id IS NULL
       ORDER BY created_at DESC, audit_id DESC LIMIT ?`,
    ).all(organizationId, Math.max(1, Math.min(250, Math.floor(limit)))) as unknown as Array<{
      audit_id: string; actor_kind: MutationAuditView["actorKind"]; actor_id: string | null;
      user_id: string | null; device_id: string | null; organization_id: string | null;
      method: string; route: string; target_id: string | null; status_code: number; created_at: number;
    }>;
    return rows.map((row) => ({
      auditId: row.audit_id,
      actorKind: row.actor_kind,
      ...(row.actor_id ? { actorId: row.actor_id } : {}),
      ...(row.user_id ? { userId: row.user_id } : {}),
      ...(row.device_id ? { deviceId: row.device_id } : {}),
      ...(row.organization_id ? { organizationId: row.organization_id } : {}),
      method: row.method,
      route: row.route,
      ...(row.target_id ? { targetId: row.target_id } : {}),
      statusCode: row.status_code,
      createdAt: row.created_at,
    }));
  }

  private scopeFromRow(row: {
    organization_id: string;
    owner_kind: "organization" | "user" | "team";
    owner_id: string;
  }): ResourceScope {
    return {
      organizationId: row.organization_id,
      owner: row.owner_kind === "organization"
        ? { kind: "organization", organizationId: row.owner_id }
        : row.owner_kind === "user"
          ? { kind: "user", userId: row.owner_id }
          : { kind: "team", teamId: row.owner_id },
    };
  }

  runnerScope(runnerId: string): ResourceScope | null {
    const row = this.stmt(
      "SELECT organization_id, owner_kind, owner_id FROM runner_ownership WHERE runner_id=?",
    ).get(runnerId) as { organization_id: string; owner_kind: "organization" | "user" | "team"; owner_id: string } | undefined;
    return row ? this.scopeFromRow(row) : null;
  }

  workspaceScope(runnerId: string, workspaceId: string): ResourceScope | null {
    const row = this.stmt(
      `SELECT organization_id, owner_kind, owner_id FROM workspace_ownership
       WHERE runner_id=? AND workspace_id=?`,
    ).get(runnerId, workspaceId) as { organization_id: string; owner_kind: "organization" | "user" | "team"; owner_id: string } | undefined;
    return row ? this.scopeFromRow(row) : null;
  }

  sessionScope(sessionId: string): ResourceScope | null {
    const row = this.stmt(
      "SELECT organization_id, owner_kind, owner_id FROM session_ownership WHERE session_id=?",
    ).get(sessionId) as { organization_id: string; owner_kind: "organization" | "user" | "team"; owner_id: string } | undefined;
    return row ? this.scopeFromRow(row) : null;
  }

  getSessionNamingPreference(
    organizationId: string,
  ): { mode: "prompt_text_only" | "session_agent_account" | "custom_model_endpoint"; updatedAt: number } | null {
    const row = this.stmt(
      "SELECT mode, updated_at FROM session_naming_preferences WHERE organization_id=?",
    ).get(organizationId) as { mode: "prompt_text_only" | "session_agent_account" | "custom_model_endpoint"; updated_at: number } | undefined;
    return row ? { mode: row.mode, updatedAt: row.updated_at } : null;
  }

  setSessionNamingPreference(
    organizationId: string,
    mode: "prompt_text_only" | "session_agent_account" | "custom_model_endpoint",
    now: number,
  ): void {
    this.stmt(
      `INSERT INTO session_naming_preferences (organization_id, mode, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(organization_id) DO UPDATE SET mode=excluded.mode, updated_at=excluded.updated_at`,
    ).run(organizationId, mode, now);
  }

  getAgentHarnessDefault(userId: string, identity: AgentHarnessIdentity): AgentHarnessDefaultRecord | null {
    const contextKind = identity.context.kind;
    const contextDistro = identity.context.kind === "wsl" ? identity.context.distro : "";
    const row = this.stmt(
      `SELECT model, effort, permission_mode, updated_at FROM agent_harness_defaults
       WHERE user_id=? AND agent_id=? AND driver=? AND context_kind=? AND context_distro=?`,
    ).get(userId, identity.agentId, identity.driver, contextKind, contextDistro) as {
      model: string | null;
      effort: string | null;
      permission_mode: string | null;
      updated_at: number;
    } | undefined;
    return row ? {
      ...identity,
      config: {
        ...(row.model ? { model: row.model } : {}),
        ...(row.effort ? { effort: row.effort } : {}),
        ...(row.permission_mode ? { permissionMode: row.permission_mode } : {}),
      },
      updatedAt: row.updated_at,
    } : null;
  }

  listAgentHarnessDefaults(userId: string): AgentHarnessDefaultRecord[] {
    const rows = this.stmt(
      `SELECT agent_id, driver, context_kind, context_distro, model, effort, permission_mode, updated_at
       FROM agent_harness_defaults WHERE user_id=?
       ORDER BY agent_id, driver, context_kind, context_distro`,
    ).all(userId) as unknown as Array<{
      agent_id: string;
      driver: AgentDriverKind;
      context_kind: "native" | "wsl";
      context_distro: string;
      model: string | null;
      effort: string | null;
      permission_mode: string | null;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      agentId: row.agent_id,
      driver: row.driver,
      context: row.context_kind === "wsl"
        ? { kind: "wsl", distro: row.context_distro }
        : { kind: "native" },
      config: {
        ...(row.model ? { model: row.model } : {}),
        ...(row.effort ? { effort: row.effort } : {}),
        ...(row.permission_mode ? { permissionMode: row.permission_mode } : {}),
      },
      updatedAt: row.updated_at,
    }));
  }

  setAgentHarnessDefault(
    userId: string,
    identity: AgentHarnessIdentity,
    config: AgentHarnessDefaultConfig,
    now = Date.now(),
  ): void {
    const contextKind = identity.context.kind;
    const contextDistro = identity.context.kind === "wsl" ? identity.context.distro : "";
    this.stmt(
      `INSERT INTO agent_harness_defaults
         (user_id, agent_id, driver, context_kind, context_distro, model, effort, permission_mode, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, agent_id, driver, context_kind, context_distro) DO UPDATE SET
         model=excluded.model, effort=excluded.effort,
         permission_mode=excluded.permission_mode, updated_at=excluded.updated_at`,
    ).run(
      userId,
      identity.agentId,
      identity.driver,
      contextKind,
      contextDistro,
      config.model ?? null,
      config.effort ?? null,
      config.permissionMode ?? null,
      now,
    );
  }

  deleteAgentHarnessDefault(userId: string, identity: AgentHarnessIdentity): boolean {
    const contextDistro = identity.context.kind === "wsl" ? identity.context.distro : "";
    return Number(this.stmt(
      `DELETE FROM agent_harness_defaults
       WHERE user_id=? AND agent_id=? AND driver=? AND context_kind=? AND context_distro=?`,
    ).run(userId, identity.agentId, identity.driver, identity.context.kind, contextDistro).changes) > 0;
  }

  getSessionNamingHarnessTarget(organizationId: string): SessionNamingHarnessTargetRecord | null {
    const row = this.stmt(
      `SELECT runner_id, agent_id, driver, context_kind, context_distro, provider, billing_source,
              model, effort, updated_at
       FROM session_naming_harness_targets WHERE organization_id=?`,
    ).get(organizationId) as {
      runner_id: string;
      agent_id: string;
      driver: SessionNamingHarnessOption["driver"];
      context_kind: "native" | "wsl" | null;
      context_distro: string | null;
      provider: SessionNamingAccountBoundary["provider"] | null;
      billing_source: SessionNamingAccountBoundary["billingSource"] | null;
      model: string;
      effort: string;
      updated_at: number;
    } | undefined;
    return row ? {
      runnerId: row.runner_id,
      agentId: row.agent_id,
      driver: row.driver,
      ...(row.context_kind === "native"
        ? { context: { kind: "native" as const } }
        : row.context_kind === "wsl" && row.context_distro
          ? { context: { kind: "wsl" as const, distro: row.context_distro } }
          : {}),
      ...(row.provider ? { provider: row.provider } : {}),
      ...(row.billing_source ? { billingSource: row.billing_source } : {}),
      model: row.model,
      effort: row.effort,
      updatedAt: row.updated_at,
    } : null;
  }

  private clearSessionNamingHarnessTargetsForRunner(runnerId: string, now: number): void {
    this.atomic(() => {
      this.stmt(
        `UPDATE session_naming_preferences
         SET mode='prompt_text_only', updated_at=?
         WHERE mode='session_agent_account'
           AND organization_id IN (
             SELECT organization_id FROM session_naming_harness_targets WHERE runner_id=?
           )`,
      ).run(now, runnerId);
      this.stmt("DELETE FROM session_naming_harness_targets WHERE runner_id=?").run(runnerId);
    });
  }

  setSessionNamingHarnessTarget(
    organizationId: string,
    target: SessionNamingHarnessTargetWrite,
    now: number,
  ): void {
    if (target.context?.kind === "wsl" && (
      !target.context.distro || target.context.distro !== target.context.distro.trim() ||
      target.context.distro.length > 256 || /[\p{Cc}\p{Cf}]/u.test(target.context.distro)
    )) throw new Error("a valid WSL distribution is required");
    this.stmt(
      `INSERT INTO session_naming_harness_targets
         (organization_id, runner_id, agent_id, driver, context_kind, context_distro,
          provider, billing_source, model, effort, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id) DO UPDATE SET
         runner_id=excluded.runner_id, agent_id=excluded.agent_id, driver=excluded.driver,
         context_kind=excluded.context_kind, context_distro=excluded.context_distro,
         provider=excluded.provider, billing_source=excluded.billing_source,
         model=excluded.model, effort=excluded.effort, updated_at=excluded.updated_at`,
    ).run(
      organizationId,
      target.runnerId,
      target.agentId,
      target.driver,
      target.context?.kind ?? null,
      target.context?.kind === "wsl" ? target.context.distro : null,
      target.provider ?? null,
      target.billingSource ?? null,
      target.model,
      target.effort,
      now,
    );
  }

  configureSessionNamingHarnessTarget(
    organizationId: string,
    target: ConfirmedSessionNamingHarnessTargetWrite,
    now: number,
  ): number {
    return this.atomic(() => {
      const previousTarget = this.getSessionNamingHarnessTarget(organizationId)?.updatedAt ?? 0;
      const previousPreference = this.getSessionNamingPreference(organizationId)?.updatedAt ?? 0;
      const revision = Math.max(now, previousTarget + 1, previousPreference + 1);
      this.setSessionNamingHarnessTarget(organizationId, target, revision);
      this.setSessionNamingPreference(organizationId, "session_agent_account", revision);
      return revision;
    });
  }

  getSessionNamingCustomModel(organizationId: string): {
    runnerId: string;
    endpoint: string;
    model: string;
    timeoutMs: number;
    runnerConfigured: boolean;
    apiKeyConfigured: boolean;
    updatedAt: number;
  } | null {
    const row = this.stmt(
      `SELECT runner_id, endpoint, model, timeout_ms, runner_configured, api_key_configured, updated_at
       FROM session_naming_custom_models WHERE organization_id=?`,
    ).get(organizationId) as {
      runner_id: string;
      endpoint: string;
      model: string;
      timeout_ms: number;
      runner_configured: number;
      api_key_configured: number;
      updated_at: number;
    } | undefined;
    return row ? {
      runnerId: row.runner_id,
      endpoint: row.endpoint,
      model: row.model,
      timeoutMs: row.timeout_ms,
      runnerConfigured: row.runner_configured === 1,
      apiKeyConfigured: row.api_key_configured === 1,
      updatedAt: row.updated_at,
    } : null;
  }

  setSessionNamingCustomModel(
    organizationId: string,
    value: {
      runnerId: string;
      endpoint: string;
      model: string;
      timeoutMs: number;
      runnerConfigured: boolean;
      apiKeyConfigured: boolean;
    },
    now: number,
  ): void {
    this.stmt(
      `INSERT INTO session_naming_custom_models
         (organization_id, runner_id, endpoint, model, timeout_ms, runner_configured, api_key_configured, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id) DO UPDATE SET
         runner_id=excluded.runner_id, endpoint=excluded.endpoint, model=excluded.model,
         timeout_ms=excluded.timeout_ms, runner_configured=excluded.runner_configured,
         api_key_configured=excluded.api_key_configured,
         updated_at=excluded.updated_at`,
    ).run(
      organizationId,
      value.runnerId,
      value.endpoint,
      value.model,
      value.timeoutMs,
      value.runnerConfigured ? 1 : 0,
      value.apiKeyConfigured ? 1 : 0,
      now,
    );
  }

  reconcileSessionNamingCustomModelRunnerStatus(
    runnerId: string,
    configured: boolean,
    apiKeyConfigured: boolean,
    now: number,
  ): boolean {
    const result = this.stmt(
      `UPDATE session_naming_custom_models
       SET runner_configured=?, api_key_configured=?, updated_at=? WHERE runner_id=?`,
    ).run(configured ? 1 : 0, apiKeyConfigured ? 1 : 0, now, runnerId);
    return Number(result.changes) > 0;
  }

  private principalCanAccessScope(principal: AuthPrincipal, scope: ResourceScope): boolean {
    if (principal.kind === "agent") {
      if (principal.organizationId !== scope.organizationId) return false;
      const delegated = principal.delegatedScope.owner;
      if (delegated.kind === "organization") return delegated.organizationId === scope.organizationId;
      if (delegated.kind !== scope.owner.kind) return false;
      return delegated.kind === "user"
        ? delegated.userId === (scope.owner.kind === "user" ? scope.owner.userId : "")
        : delegated.teamId === (scope.owner.kind === "team" ? scope.owner.teamId : "");
    }
    if (principal.organizationId !== scope.organizationId) return false;
    if (principal.role === "owner" || principal.role === "admin") return true;
    if (scope.owner.kind === "organization") return scope.owner.organizationId === principal.organizationId;
    if (scope.owner.kind === "user") return scope.owner.userId === principal.userId;
    return this.stmt(
      `SELECT 1 FROM identity_teams team
       JOIN identity_team_members member ON member.team_id=team.team_id
       WHERE team.team_id=? AND team.organization_id=? AND member.user_id=?`,
    ).get(scope.owner.teamId, principal.organizationId, principal.userId) !== undefined;
  }

  canAccessRunner(principal: AuthPrincipal, runnerId: string): boolean {
    const scope = this.runnerScope(runnerId);
    return scope ? this.principalCanAccessScope(principal, scope) : false;
  }

  canAccessWorkspace(principal: AuthPrincipal, runnerId: string, workspaceId: string): boolean {
    const scope = this.workspaceScope(runnerId, workspaceId);
    return scope ? this.principalCanAccessScope(principal, scope) : false;
  }

  canManageWorkspace(principal: AuthPrincipal, runnerId: string, workspaceId: string): boolean {
    if (principal.kind !== "human") return false;
    const scope = this.workspaceScope(runnerId, workspaceId);
    if (!scope || principal.organizationId !== scope.organizationId) return false;
    if (principal.role === "owner" || principal.role === "admin") return true;
    if (scope.owner.kind === "organization") return false;
    if (scope.owner.kind === "user") return scope.owner.userId === principal.userId;
    return this.principalCanAccessScope(principal, scope);
  }

  canAccessSession(principal: AuthPrincipal, sessionId: string): boolean {
    const scope = this.sessionScope(sessionId);
    return scope ? this.principalCanAccessScope(principal, scope) : false;
  }

  listRunnersForPrincipal(principal: AuthPrincipal): RunnerView[] {
    const administers = principal.kind === "human" && (principal.role === "owner" || principal.role === "admin");
    return this.listRunners()
      .filter((runner) => this.canAccessRunner(principal, runner.runnerId))
      .map((runner) => ({
        ...runner,
        ...(() => {
          const scope = this.runnerScope(runner.runnerId);
          return scope ? { scope } : {};
        })(),
        workspaces: runner.workspaces
          .filter((workspace) => this.canAccessWorkspace(principal, runner.runnerId, workspace.id))
          .map((workspace) => {
            const scope = this.workspaceScope(runner.runnerId, workspace.id);
            return {
              ...workspace,
              ...(scope ? { scope, canManage: this.canManageWorkspace(principal, runner.runnerId, workspace.id) } : {}),
            };
          }),
        agents: administers ? runner.agents : runner.agents.map((agent) => ({ ...agent, env: {} })),
        runtime: administers ? runner.runtime : undefined,
      }));
  }

  listSessionsForPrincipal(principal: AuthPrincipal, includeArchived = false): SessionView[] {
    return this.listSessions({ includeArchived }).filter((session) => this.canAccessSession(principal, session.id));
  }

  private sessionAuthorizationSql(principal: AuthPrincipal): { sql: string; params: string[] } {
    if (principal.kind === "human") {
      if (principal.role === "owner" || principal.role === "admin") {
        return { sql: "ownership.organization_id=?", params: [principal.organizationId] };
      }
      return {
        sql: `ownership.organization_id=? AND (
          (ownership.owner_kind='organization' AND ownership.owner_id=?) OR
          (ownership.owner_kind='user' AND ownership.owner_id=?) OR
          (ownership.owner_kind='team' AND EXISTS (
            SELECT 1 FROM identity_teams team
            JOIN identity_team_members member ON member.team_id=team.team_id
            WHERE team.team_id=ownership.owner_id AND team.organization_id=ownership.organization_id
              AND member.user_id=?
          ))
        )`,
        params: [principal.organizationId, principal.organizationId, principal.userId, principal.userId],
      };
    }
    if (principal.delegatedScope.organizationId !== principal.organizationId) {
      return { sql: "0", params: [] };
    }
    const delegated = principal.delegatedScope.owner;
    if (delegated.kind === "organization") {
      return { sql: "ownership.organization_id=?", params: [principal.organizationId] };
    }
    return {
      sql: "ownership.organization_id=? AND ownership.owner_kind=? AND ownership.owner_id=?",
      params: [
        principal.organizationId,
        delegated.kind,
        delegated.kind === "user" ? delegated.userId : delegated.teamId,
      ],
    };
  }

  /** Principal-scoped archive page candidates. Authorization, filters, transcript matching,
   * cursor fences, and the page-plus-one bound all execute in SQLite before rows are hydrated. */
  archiveSessionCandidatePageForPrincipal(
    principal: AuthPrincipal,
    query: ArchiveSessionPageQuery,
  ): {
    sessions: ArchiveSessionCandidate[];
    transcriptSessionIds: string[];
    facets: { projects: string[]; locations: string[]; agents: string[] };
  } | { error: string } {
    const window = archiveSessionCursorWindow(query);
    if ("error" in window) return window;
    const authorization = this.sessionAuthorizationSql(principal);
    const projectSql = "COALESCE(project.name, CASE WHEN session.project_id IS NOT NULL THEN 'Unknown Project' ELSE 'No Project' END)";
    const locationSql = `COALESCE(location.name, workspace_override.display_name, workspace.name,
      workspace_extra.name, session.workspace_id, 'No Location')`;
    const agentSql = `CASE
      WHEN session.agent_id='conductor' OR COALESCE(agent.name, session.agent_id, '') IN
        ('Conductor (Wollipog)', 'Conductor (Agent Manager)') THEN 'Conductor (Wollipog)'
      WHEN session.driver='codex-app-server' THEN 'Codex App Server'
      WHEN session.driver='codex' THEN 'Codex — Non-Interactive (codex exec)'
      ELSE COALESCE(agent.name, session.agent_id, session.driver)
    END`;
    const pendingArchiveSql = `EXISTS(SELECT 1 FROM session_stop_intents intent
      WHERE intent.session_id=session.id AND intent.archive_after_stop=1)`;
    const stopFailedSql = `EXISTS(SELECT 1 FROM session_stop_intents intent
      WHERE intent.session_id=session.id AND intent.archive_after_stop=1 AND intent.failed_at IS NOT NULL)`;
    const joins = `FROM sessions session
      JOIN session_ownership ownership ON ownership.session_id=session.id
      LEFT JOIN projects project ON project.id=session.project_id
      LEFT JOIN project_locations location ON location.id=session.project_location_id
      LEFT JOIN workspace_overrides workspace_override
        ON workspace_override.runner_id=session.runner_id
       AND workspace_override.workspace_id=session.workspace_id
      LEFT JOIN workspaces workspace
        ON workspace.runner_id=session.runner_id AND workspace.id=session.workspace_id
      LEFT JOIN workspace_extras workspace_extra
        ON workspace_extra.runner_id=session.runner_id AND workspace_extra.id=session.workspace_id
      LEFT JOIN agent_definitions agent ON agent.id=session.agent_id`;
    const where = [authorization.sql];
    const params: Array<string | number> = [...authorization.params];
    if (window.archive === "archived") where.push(`(session.archived=1 OR ${pendingArchiveSql})`);
    else if (window.archive === "unarchived") where.push(`session.archived=0 AND NOT ${pendingArchiveSql}`);
    if (window.lifecycle !== "all") {
      where.push("session.status=?");
      params.push(window.lifecycle);
    }
    for (const [value, sql] of [[query.project, projectSql], [query.location, locationSql], [query.agent, agentSql]] as const) {
      if (value) {
        where.push(`${sql}=?`);
        params.push(value);
      }
    }
    if (window.cursor) {
      where.push("(session.created_at<? OR (session.created_at=? AND session.id>?))");
      params.push(window.cursor.afterCreatedAt, window.cursor.afterCreatedAt, window.cursor.afterId);
      where.push("(session.created_at<? OR (session.created_at=? AND session.id>=?))");
      params.push(window.cursor.anchorCreatedAt, window.cursor.anchorCreatedAt, window.cursor.anchorId);
    }
    const q = (query.q ?? "").trim().toLocaleLowerCase();
    const match = q.length >= 2
      ? q.split(/\s+/).filter(Boolean).slice(0, 16).map((term) => `"${term.replace(/"/g, '""')}"`).join(" ")
      : "";
    const transcriptSql = "session.id IN (SELECT session_id FROM session_events_fts WHERE session_events_fts MATCH ?)";
    if (q) {
      const escaped = `%${q.replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_")}%`;
      const localSql = `LOWER(session.id || char(10) || session.title || char(10) || ${projectSql} || char(10) ||
        ${locationSql} || char(10) || ${agentSql} || char(10) ||
        CASE WHEN session.status='input_required' THEN 'Input Required'
             ELSE UPPER(SUBSTR(session.status, 1, 1)) || SUBSTR(session.status, 2) END || char(10) ||
        CASE WHEN session.archived=1 THEN 'Archived' ELSE 'Not Archived' END) LIKE ? ESCAPE '!'`;
      where.push(match ? `(${localSql} OR ${transcriptSql})` : localSql);
      params.push(escaped);
      if (match) params.push(match);
    }
    const rows = this.stmt(
      `SELECT session.id, session.title, session.project_id, project.name AS project_name,
              session.workspace_id, ${locationSql} AS location_name,
              session.agent_id, agent.name AS agent_name, session.driver, session.archived,
              session.status, session.created_at, ${pendingArchiveSql} AS pending_archive,
              ${stopFailedSql} AS stop_failed,
              ${match ? transcriptSql : "0"} AS transcript_match
       ${joins}
       WHERE ${where.join(" AND ")}
       ORDER BY session.created_at DESC, session.id ASC
       LIMIT ${ARCHIVE_SESSION_PAGE_SIZE + 1}`,
    ).all(...(match ? [match, ...params] : params)) as unknown as Array<{
      id: string; title: string; project_id: string | null; project_name: string | null;
      workspace_id: string | null; location_name: string | null; agent_id: string | null;
      agent_name: string | null; driver: SessionView["driver"]; archived: number;
      status: SessionStatus; created_at: number; pending_archive: number; stop_failed: number;
      transcript_match: number;
    }>;
    const sessions = rows.map((row) => ({
      id: row.id,
      title: row.title,
      projectId: row.project_id,
      projectName: row.project_name,
      workspaceId: row.workspace_id,
      locationName: row.location_name,
      agentId: row.agent_id,
      agentName: row.agent_name ?? row.agent_id,
      driver: row.driver,
      archived: row.archived === 1,
      ...(row.pending_archive === 1
        ? { archiveStatus: row.stop_failed === 1 ? "stop_failed" as const : "stop_pending" as const }
        : {}),
      status: row.status,
      createdAt: row.created_at,
    }));
    const facetValues = (expression: string): string[] => (this.stmt(
      `SELECT DISTINCT ${expression} AS value ${joins}
       WHERE ${authorization.sql} ORDER BY value LIMIT 500`,
    ).all(...authorization.params) as unknown as Array<{ value: string }>).map((row) => row.value);
    return {
      sessions,
      transcriptSessionIds: rows.filter((row) => row.transcript_match === 1).map((row) => row.id),
      facets: {
        projects: facetValues(projectSql),
        locations: facetValues(locationSql),
        agents: facetValues(agentSql),
      },
    };
  }

  private accessScopeChangeToken(input: Omit<AccessScopeChangePreview, "confirmationToken">, evidence: unknown): string {
    return createHash("sha256").update(JSON.stringify({ input, evidence })).digest("hex");
  }

  /** Server-only containment that can prove a user's audience is inside a team they actively belong to. */
  scopeAudienceContainedWithMembership(narrower: ResourceScope, wider: ResourceScope): boolean {
    if (scopeAudienceContained(narrower, wider)) return true;
    if (narrower.organizationId !== wider.organizationId ||
        narrower.owner.kind !== "user" || wider.owner.kind !== "team") return false;
    return this.stmt(
      `SELECT 1 FROM identity_team_members member
       JOIN identity_teams team ON team.team_id=member.team_id
       JOIN identity_memberships membership
         ON membership.organization_id=team.organization_id AND membership.user_id=member.user_id
       WHERE team.organization_id=? AND team.team_id=? AND member.user_id=?`,
    ).get(narrower.organizationId, wider.owner.teamId, narrower.owner.userId) !== undefined;
  }

  private accessScopeSessionRows(where: string, args: string[]): Array<{
    id: string;
    status: SessionStatus;
    scope: ResourceScope;
  }> {
    const rows = this.stmt(
      `SELECT sessions.id, sessions.status, ownership.organization_id, ownership.owner_kind, ownership.owner_id
       FROM sessions JOIN session_ownership ownership ON ownership.session_id=sessions.id
       WHERE ${where} ORDER BY sessions.id`,
    ).all(...args) as unknown as Array<{
      id: string;
      status: SessionStatus;
      organization_id: string;
      owner_kind: "organization" | "user" | "team";
      owner_id: string;
    }>;
    return rows.map((row) => ({ id: row.id, status: row.status, scope: this.scopeFromRow(row) }));
  }

  private scopeChangeSessionImpact(
    sessions: Array<{ id: string; status: SessionStatus; scope: ResourceScope }>,
    targetScope: ResourceScope,
  ): { activeSessionCount: number; sessionsToNarrow: string[]; incompatibleSessionId?: string } {
    const activeSessionCount = sessions.filter((session) =>
      ["queued", "starting", "running", "input_required"].includes(session.status)).length;
    const sessionsToNarrow: string[] = [];
    for (const session of sessions) {
      if (this.scopeAudienceContainedWithMembership(session.scope, targetScope)) continue;
      if (this.scopeAudienceContainedWithMembership(targetScope, session.scope)) sessionsToNarrow.push(session.id);
      else return { activeSessionCount, sessionsToNarrow, incompatibleSessionId: session.id };
    }
    return { activeSessionCount, sessionsToNarrow };
  }

  previewProjectAccessScope(projectId: string, targetScope: ResourceScope): AccessScopeChangePreview | null {
    const project = this.getProject(projectId);
    const currentScope = this.projectScope(projectId);
    if (!project || !currentScope || currentScope.organizationId !== targetScope.organizationId) return null;
    const affectedProjects = [{ projectId, name: project.name }];
    const sessions = this.accessScopeSessionRows("sessions.project_id=?", [projectId]);
    const sessionImpact = this.scopeChangeSessionImpact(sessions, targetScope);
    let reason: string | undefined;
    const locationEvidence = project.locations.map((location) => ({
      runnerId: location.runnerId,
      workspaceId: location.workspaceId,
      scope: this.workspaceScope(location.runnerId, location.workspaceId) ?? currentScope,
    }));
    const incompatibleLocation = locationEvidence.find((location) =>
      !this.scopeAudienceContainedWithMembership(targetScope, location.scope));
    if (incompatibleLocation) {
      reason = "The requested Project access would expose a narrower Location. Change that Location first or choose a narrower Project scope.";
    } else if (sessionImpact.incompatibleSessionId) {
      reason = "A session in this Project has an incompatible private owner and cannot be transferred by a Project access change.";
    }
    const preview: AccessScopeChangePreview = {
      resource: "project",
      resourceId: projectId,
      currentScope,
      targetScope,
      affectedProjects,
      activeSessionCount: sessionImpact.activeSessionCount,
      totalSessionCount: sessions.length,
      sessionsToNarrow: sessionImpact.sessionsToNarrow.length,
      compatible: reason === undefined,
      ...(reason ? { reason } : {}),
    };
    return preview.compatible ? {
      ...preview,
      confirmationToken: this.accessScopeChangeToken(preview, { locationEvidence, sessions }),
    } : preview;
  }

  previewWorkspaceAccessScope(
    runnerId: string,
    workspaceId: string,
    targetScope: ResourceScope,
  ): AccessScopeChangePreview | null {
    const workspace = this.workspaceLocationDefinition(runnerId, workspaceId);
    const currentScope = this.workspaceScope(runnerId, workspaceId);
    const runnerScope = this.runnerScope(runnerId);
    if (!workspace || !currentScope || !runnerScope || currentScope.organizationId !== targetScope.organizationId) return null;
    const affectedProjects = this.projectIdsForWorkspace(runnerId, workspaceId).map((projectId) => {
      const project = this.getProject(projectId)!;
      return { projectId, name: project.name };
    });
    const projectEvidence = affectedProjects.map(({ projectId }) => ({
      projectId,
      scope: this.projectScope(projectId),
    }));
    const sessions = this.accessScopeSessionRows(
      "sessions.runner_id=? AND sessions.workspace_id=?",
      [runnerId, workspaceId],
    );
    const sessionImpact = this.scopeChangeSessionImpact(sessions, targetScope);
    let reason: string | undefined;
    if (!this.scopeAudienceContainedWithMembership(targetScope, runnerScope)) {
      reason = "The requested Location access would be broader than its Machine access.";
    } else if (projectEvidence.some((project) =>
      !project.scope || !this.scopeAudienceContainedWithMembership(project.scope, targetScope))) {
      reason = "The requested Location access is narrower than an attached Project. Narrow those Projects first or choose a broader Location scope.";
    } else if (sessionImpact.incompatibleSessionId) {
      reason = "A session in this Location has an incompatible private owner and cannot be transferred by a Location access change.";
    }
    const preview: AccessScopeChangePreview = {
      resource: "workspace",
      resourceId: workspaceId,
      runnerId,
      currentScope,
      targetScope,
      affectedProjects,
      activeSessionCount: sessionImpact.activeSessionCount,
      totalSessionCount: sessions.length,
      sessionsToNarrow: sessionImpact.sessionsToNarrow.length,
      compatible: reason === undefined,
      ...(reason ? { reason } : {}),
    };
    return preview.compatible ? {
      ...preview,
      confirmationToken: this.accessScopeChangeToken(preview, { runnerScope, projectEvidence, sessions }),
    } : preview;
  }

  applyProjectAccessScope(
    projectId: string,
    targetScope: ResourceScope,
    confirmationToken: string,
    now: number,
    audit: { principal: HumanPrincipal; mutationAuditId?: string },
  ): AccessScopeChangePreview | null {
    const preview = this.previewProjectAccessScope(projectId, targetScope);
    if (!preview) return null;
    if (audit.principal.organizationId !== preview.currentScope.organizationId) {
      throw new Error("access-scope audit actor must belong to the resource organization");
    }
    if (!preview.compatible || !preview.confirmationToken) throw new Error(preview.reason ?? "project access change is incompatible");
    if (preview.confirmationToken !== confirmationToken) throw new Error("access scope changed after preview; review the current impact and try again");
    const sessions = this.accessScopeSessionRows("sessions.project_id=?", [projectId]);
    const narrowedSessionIds = sessions
      .filter((session) => !this.scopeAudienceContainedWithMembership(session.scope, targetScope))
      .map((session) => session.id);
    const ownerId = targetScope.owner.kind === "organization" ? targetScope.owner.organizationId
      : targetScope.owner.kind === "user" ? targetScope.owner.userId : targetScope.owner.teamId;
    this.atomic(() => {
      this.stmt(
        "UPDATE project_ownership SET organization_id=?, owner_kind=?, owner_id=?, updated_at=? WHERE project_id=?",
      ).run(targetScope.organizationId, targetScope.owner.kind, ownerId, now, projectId);
      this.stmt("UPDATE projects SET updated_at=? WHERE id=?").run(now, projectId);
      for (const session of sessions) {
        if (this.scopeAudienceContainedWithMembership(session.scope, targetScope)) continue;
        this.stmt(
          "UPDATE session_ownership SET organization_id=?, owner_kind=?, owner_id=?, updated_at=? WHERE session_id=?",
        ).run(targetScope.organizationId, targetScope.owner.kind, ownerId, now, session.id);
      }
      this.insertAccessScopeAudit({
        mutationAuditId: audit.mutationAuditId,
        principal: audit.principal,
        resource: "project",
        resourceId: projectId,
        currentScope: preview.currentScope,
        targetScope,
        affectedProjectIds: preview.affectedProjects.map((project) => project.projectId),
        sessions,
        narrowedSessionIds,
        now,
      });
    });
    return preview;
  }

  applyWorkspaceAccessScope(
    runnerId: string,
    workspaceId: string,
    targetScope: ResourceScope,
    confirmationToken: string,
    now: number,
    audit: { principal: HumanPrincipal; mutationAuditId?: string },
  ): AccessScopeChangePreview | null {
    const preview = this.previewWorkspaceAccessScope(runnerId, workspaceId, targetScope);
    if (!preview) return null;
    if (audit.principal.organizationId !== preview.currentScope.organizationId) {
      throw new Error("access-scope audit actor must belong to the resource organization");
    }
    if (!preview.compatible || !preview.confirmationToken) throw new Error(preview.reason ?? "location access change is incompatible");
    if (preview.confirmationToken !== confirmationToken) throw new Error("access scope changed after preview; review the current impact and try again");
    const sessions = this.accessScopeSessionRows(
      "sessions.runner_id=? AND sessions.workspace_id=?",
      [runnerId, workspaceId],
    );
    const narrowedSessionIds = sessions
      .filter((session) => !this.scopeAudienceContainedWithMembership(session.scope, targetScope))
      .map((session) => session.id);
    const ownerId = targetScope.owner.kind === "organization" ? targetScope.owner.organizationId
      : targetScope.owner.kind === "user" ? targetScope.owner.userId : targetScope.owner.teamId;
    this.atomic(() => {
      this.stmt(
        `UPDATE workspace_ownership SET organization_id=?, owner_kind=?, owner_id=?, updated_at=?
         WHERE runner_id=? AND workspace_id=?`,
      ).run(targetScope.organizationId, targetScope.owner.kind, ownerId, now, runnerId, workspaceId);
      for (const session of sessions) {
        if (this.scopeAudienceContainedWithMembership(session.scope, targetScope)) continue;
        this.stmt(
          "UPDATE session_ownership SET organization_id=?, owner_kind=?, owner_id=?, updated_at=? WHERE session_id=?",
        ).run(targetScope.organizationId, targetScope.owner.kind, ownerId, now, session.id);
      }
      for (const project of preview.affectedProjects) {
        this.stmt("UPDATE projects SET updated_at=? WHERE id=?").run(now, project.projectId);
      }
      this.insertAccessScopeAudit({
        mutationAuditId: audit.mutationAuditId,
        principal: audit.principal,
        resource: "workspace",
        resourceId: workspaceId,
        runnerId,
        currentScope: preview.currentScope,
        targetScope,
        affectedProjectIds: preview.affectedProjects.map((project) => project.projectId),
        sessions,
        narrowedSessionIds,
        now,
      });
    });
    return preview;
  }

  private insertAccessScopeAudit(input: {
    mutationAuditId?: string;
    principal: HumanPrincipal;
    resource: "project" | "workspace";
    resourceId: string;
    runnerId?: string;
    currentScope: ResourceScope;
    targetScope: ResourceScope;
    affectedProjectIds: string[];
    sessions: Array<{ id: string; status: SessionStatus }>;
    narrowedSessionIds: string[];
    now: number;
  }): void {
    const ownerId = (scope: ResourceScope) => scope.owner.kind === "organization"
      ? scope.owner.organizationId : scope.owner.kind === "user" ? scope.owner.userId : scope.owner.teamId;
    const activeSessionIds = input.sessions
      .filter((session) => ["queued", "starting", "running", "input_required"].includes(session.status))
      .map((session) => session.id);
    this.stmt(
      `INSERT INTO access_scope_audit
       (scope_change_id, mutation_audit_id, actor_id, user_id, device_id, organization_id,
        resource, resource_id, runner_id,
        old_organization_id, old_owner_kind, old_owner_id,
        new_organization_id, new_owner_kind, new_owner_id,
        affected_project_ids, active_session_ids, session_ids, narrowed_session_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `scope_${randomUUID().replace(/-/g, "")}`,
      input.mutationAuditId ?? null,
      input.principal.actorId,
      input.principal.userId,
      input.principal.deviceId,
      input.principal.organizationId,
      input.resource,
      input.resourceId,
      input.runnerId ?? null,
      input.currentScope.organizationId,
      input.currentScope.owner.kind,
      ownerId(input.currentScope),
      input.targetScope.organizationId,
      input.targetScope.owner.kind,
      ownerId(input.targetScope),
      JSON.stringify(input.affectedProjectIds),
      JSON.stringify(activeSessionIds),
      JSON.stringify(input.sessions.map((session) => session.id)),
      JSON.stringify(input.narrowedSessionIds),
      input.now,
    );
  }

  listAccessScopeAudit(organizationId: string, limit = 100): AccessScopeAuditView[] {
    const rows = this.stmt(
      `SELECT * FROM access_scope_audit WHERE organization_id=?
       ORDER BY created_at DESC, row_id DESC LIMIT ?`,
    ).all(organizationId, Math.max(1, Math.min(250, Math.floor(limit)))) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const scope = (prefix: "old" | "new"): ResourceScope => {
        const kind = row[`${prefix}_owner_kind`] as "organization" | "user" | "team";
        const ownerId = row[`${prefix}_owner_id`] as string;
        return {
          organizationId: row[`${prefix}_organization_id`] as string,
          owner: kind === "organization" ? { kind, organizationId: ownerId }
            : kind === "user" ? { kind, userId: ownerId } : { kind, teamId: ownerId },
        };
      };
      return {
        scopeChangeId: row.scope_change_id as string,
        ...(row.mutation_audit_id ? { mutationAuditId: row.mutation_audit_id as string } : {}),
        actorId: row.actor_id as string,
        userId: row.user_id as string,
        ...(row.device_id ? { deviceId: row.device_id as string } : {}),
        organizationId: row.organization_id as string,
        resource: row.resource as "project" | "workspace",
        resourceId: row.resource_id as string,
        ...(row.runner_id ? { runnerId: row.runner_id as string } : {}),
        currentScope: scope("old"),
        targetScope: scope("new"),
        affectedProjectIds: JSON.parse(row.affected_project_ids as string) as string[],
        activeSessionIds: JSON.parse(row.active_session_ids as string) as string[],
        sessionIds: JSON.parse(row.session_ids as string) as string[],
        narrowedSessionIds: JSON.parse(row.narrowed_session_ids as string) as string[],
        createdAt: row.created_at as number,
      };
    });
  }

  setResourceScope(input: {
    resource: "runner" | "workspace" | "project" | "session";
    resourceId: string;
    runnerId?: string;
    scope: ResourceScope;
    now: number;
  }): boolean {
    const currentScope = input.resource === "runner" ? this.runnerScope(input.resourceId)
      : input.resource === "workspace" && input.runnerId
        ? this.workspaceScope(input.runnerId, input.resourceId)
        : input.resource === "project" ? this.projectScope(input.resourceId)
        : input.resource === "session" ? this.sessionScope(input.resourceId) : null;
    if (!currentScope || currentScope.organizationId !== input.scope.organizationId) return false;
    const ownerId = input.scope.owner.kind === "organization" ? input.scope.owner.organizationId
      : input.scope.owner.kind === "user" ? input.scope.owner.userId : input.scope.owner.teamId;
    const ownerValid = input.scope.owner.kind === "organization"
      ? ownerId === input.scope.organizationId && this.stmt("SELECT 1 FROM identity_organizations WHERE organization_id=?")
        .get(input.scope.organizationId) !== undefined
      : input.scope.owner.kind === "user"
        ? this.stmt("SELECT 1 FROM identity_memberships WHERE organization_id=? AND user_id=?")
          .get(input.scope.organizationId, ownerId) !== undefined
        : this.stmt("SELECT 1 FROM identity_teams WHERE organization_id=? AND team_id=?")
          .get(input.scope.organizationId, ownerId) !== undefined;
    if (!ownerValid) throw new Error("resource owner must belong to the same organization");
    const cascadedProjectIds: string[] = [];
    let clearSessionProject = false;
    if (input.resource === "workspace" && input.runnerId) {
      for (const projectId of this.projectIdsForWorkspace(input.runnerId, input.resourceId)) {
        const projectScope = this.projectScope(projectId);
        if (!projectScope || this.scopeAudienceContainedWithMembership(projectScope, input.scope)) continue;
        const projectFollowedWorkspaceScope =
          this.scopeAudienceContainedWithMembership(projectScope, currentScope) &&
          this.scopeAudienceContainedWithMembership(currentScope, projectScope);
        if (!projectFollowedWorkspaceScope) return false;
        const activeLocationCount = this.stmt(
          `SELECT COUNT(*) AS count FROM project_locations
           WHERE project_id=? AND detached_at IS NULL AND removed_at IS NULL`,
        ).get(projectId) as unknown as { count: number };
        if (activeLocationCount.count !== 1) return false;
        cascadedProjectIds.push(projectId);
      }
    }
    if (input.resource === "project") {
      const project = this.getProject(input.resourceId);
      if (!project) return false;
      for (const location of project.locations) {
        const locationScope = this.workspaceScope(location.runnerId, location.workspaceId) ?? currentScope;
        if (!this.scopeAudienceContainedWithMembership(input.scope, locationScope)) return false;
      }
      for (const sessionId of this.sessionIdsForProject(input.resourceId)) {
        const scope = this.sessionScope(sessionId);
        if (!scope || !this.scopeAudienceContainedWithMembership(scope, input.scope)) return false;
      }
    }
    if (input.resource === "session") {
      const session = this.getSession(input.resourceId);
      const projectScope = session?.projectId ? this.projectScope(session.projectId) : null;
      clearSessionProject = Boolean(projectScope &&
        !this.scopeAudienceContainedWithMembership(input.scope, projectScope));
    }
    const table = input.resource === "runner" ? "runner_ownership"
      : input.resource === "workspace" ? "workspace_ownership"
        : input.resource === "project" ? "project_ownership" : "session_ownership";
    const where = input.resource === "workspace" ? "runner_id=? AND workspace_id=?"
      : input.resource === "runner" ? "runner_id=?"
        : input.resource === "project" ? "project_id=?" : "session_id=?";
    if (input.resource === "workspace" && !input.runnerId) throw new Error("workspace scope requires a runner id");
    const args: string[] = input.resource === "workspace" ? [input.runnerId!, input.resourceId] : [input.resourceId];
    let changed = false;
    this.atomic(() => {
      changed = Number(this.stmt(
        `UPDATE ${table} SET organization_id=?, owner_kind=?, owner_id=?, updated_at=? WHERE ${where}`,
      ).run(input.scope.organizationId, input.scope.owner.kind, ownerId, input.now, ...args).changes) > 0;
      for (const cascadedProjectId of cascadedProjectIds) {
        this.stmt(
          `UPDATE project_ownership SET organization_id=?, owner_kind=?, owner_id=?, updated_at=? WHERE project_id=?`,
        ).run(input.scope.organizationId, input.scope.owner.kind, ownerId, input.now, cascadedProjectId);
        for (const sessionId of this.sessionIdsForProject(cascadedProjectId)) {
          const scope = this.sessionScope(sessionId);
          if (!scope || !this.scopeAudienceContainedWithMembership(scope, input.scope)) {
            this.stmt(
              "UPDATE sessions SET project_id=NULL, project_location_id=NULL, updated_at=? WHERE id=?",
            ).run(input.now, sessionId);
          }
        }
      }
      if (clearSessionProject) {
        this.stmt(
          "UPDATE sessions SET project_id=NULL, project_location_id=NULL, updated_at=? WHERE id=?",
        ).run(input.now, input.resourceId);
      }
    });
    return changed;
  }

  /* ------------------------------ Web Push -------------------------------- */

  /** Insert-or-refresh: browsers rotate endpoints (pushsubscriptionchange), and a re-subscribe
   * from the same endpoint just updates its keys/owner. */
  upsertPushSubscription(input: { endpoint: string; p256dh: string; auth: string; deviceId: string | null; now: number }): void {
    this.stmt(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, device_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, device_id=excluded.device_id`,
    ).run(input.endpoint, input.p256dh, input.auth, input.deviceId, input.now);
  }

  deletePushSubscription(endpoint: string): boolean {
    return Number(this.stmt("DELETE FROM push_subscriptions WHERE endpoint=?").run(endpoint).changes) > 0;
  }

  deletePushSubscriptionForDevice(endpoint: string, deviceId: string): boolean {
    return Number(this.stmt("DELETE FROM push_subscriptions WHERE endpoint=? AND device_id=?")
      .run(endpoint, deviceId).changes) > 0;
  }

  /** Sender-side prune: delete only if the row still holds the keys the (possibly slow) send
   * used — a browser can refresh the same endpoint with new keys while a request is in
   * flight, and its stale 404/410 must not take the fresh row with it. */
  deletePushSubscriptionMatching(sub: { endpoint: string; p256dh: string; auth: string }): boolean {
    return (
      Number(
        this.stmt("DELETE FROM push_subscriptions WHERE endpoint=? AND p256dh=? AND auth=?").run(
          sub.endpoint,
          sub.p256dh,
          sub.auth,
        ).changes,
      ) > 0
    );
  }

  hasPushSubscription(endpoint: string): boolean {
    return this.stmt("SELECT 1 FROM push_subscriptions WHERE endpoint=?").get(endpoint) !== undefined;
  }

  /** Sender liveness re-check: does this exact row (endpoint + keys) still exist? */
  hasPushSubscriptionMatching(sub: { endpoint: string; p256dh: string; auth: string }): boolean {
    return (
      this.stmt("SELECT 1 FROM push_subscriptions WHERE endpoint=? AND p256dh=? AND auth=?").get(
        sub.endpoint,
        sub.p256dh,
        sub.auth,
      ) !== undefined
    );
  }

  /** Sender delivery-time read: the endpoint's CURRENT row (its keys may be newer than a
   * queued snapshot's), or null when revoked/unsubscribed. */
  private humanPrincipalForDeviceId(deviceId: string): HumanPrincipal | null {
    const row = this.stmt(
      `SELECT device.id, user.user_id, user.display_name AS user_name,
              organization.organization_id, organization.name AS organization_name, membership.role
       FROM devices device
       JOIN identity_users user ON user.user_id=device.user_id AND user.status='active'
       JOIN identity_organizations organization ON organization.organization_id=device.organization_id
       JOIN identity_memberships membership
         ON membership.user_id=device.user_id AND membership.organization_id=device.organization_id
       WHERE device.id=?`,
    ).get(deviceId) as { id: string; user_id: string; user_name: string; organization_id: string;
      organization_name: string; role: OrganizationRole } | undefined;
    return row ? {
      kind: "human",
      actorId: row.user_id,
      userId: row.user_id,
      userName: row.user_name,
      organizationId: row.organization_id,
      organizationName: row.organization_name,
      role: row.role,
      deviceId: row.id,
      localBootstrap: false,
    } : null;
  }

  private pushAudienceAllows(deviceId: string | null, audience?: PushAudience): boolean {
    if (!audience || deviceId === null) return true;
    const principal = this.humanPrincipalForDeviceId(deviceId);
    if (!principal) return false;
    return audience.kind === "session"
      ? this.canAccessSession(principal, audience.sessionId)
      : principal.organizationId === audience.organizationId &&
        (principal.role === "owner" || principal.role === "admin");
  }

  getPushSubscription(endpoint: string, audience?: PushAudience): { endpoint: string; p256dh: string; auth: string } | null {
    const row = this.stmt("SELECT endpoint, p256dh, auth, device_id FROM push_subscriptions WHERE endpoint=?").get(endpoint) as
      | { endpoint: string; p256dh: string; auth: string; device_id: string | null }
      | undefined;
    return row && this.pushAudienceAllows(row.device_id, audience)
      ? { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }
      : null;
  }

  listPushSubscriptions(audience?: PushAudience): { endpoint: string; p256dh: string; auth: string }[] {
    const rows = this.stmt("SELECT endpoint, p256dh, auth, device_id FROM push_subscriptions").all() as unknown as Array<{
      endpoint: string; p256dh: string; auth: string; device_id: string | null;
    }>;
    return rows.filter((row) => this.pushAudienceAllows(row.device_id, audience))
      .map(({ endpoint, p256dh, auth }) => ({ endpoint, p256dh, auth }));
  }

  countPushSubscriptions(): number {
    return Number((this.stmt("SELECT COUNT(*) AS n FROM push_subscriptions").get() as { n: number }).n);
  }

  getVapidKeys(): { publicKey: string; privateJwk: string } | null {
    const row = this.stmt("SELECT public_key, private_jwk FROM push_vapid WHERE id=1").get() as
      | { public_key: string; private_jwk: string }
      | undefined;
    return row ? { publicKey: row.public_key, privateJwk: row.private_jwk } : null;
  }

  setVapidKeys(keys: { publicKey: string; privateJwk: string }, now: number): void {
    this.stmt(
      "INSERT INTO push_vapid (id, public_key, private_jwk, created_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    ).run(keys.publicKey, keys.privateJwk, now);
  }

  private backgroundPushReceiptToken(deliveryId: string): string {
    const row = this.stmt("SELECT secret FROM background_push_receipt_secret WHERE id=1").get() as
      | { secret: string }
      | undefined;
    if (!row) throw new Error("background push receipt secret is unavailable");
    return createHmac("sha256", row.secret).update(deliveryId).digest("base64url");
  }

  claimDueBackgroundPushDeliveries(now: number, limit = 16): DurableBackgroundPushDelivery[] {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isInteger(limit) || limit < 1 || limit > 64) return [];
    return this.atomic(() => {
      this.stmt(
        `UPDATE background_push_deliveries
            SET state='expired', endpoint=NULL, next_attempt_at=NULL, lease_expires_at=NULL, updated_at=?
          WHERE state IN ('pending','retry') AND expires_at<=?`,
      ).run(now, now);
      const rows = this.stmt(
        `SELECT delivery_id, session_id, continuation_id, endpoint, payload_json, attempt_count
           FROM background_push_deliveries
          WHERE state IN ('pending','retry') AND endpoint IS NOT NULL
            AND next_attempt_at<=? AND expires_at>?
            AND (lease_expires_at IS NULL OR lease_expires_at<=?)
          ORDER BY next_attempt_at, created_at, delivery_id LIMIT ?`,
      ).all(now, now, now, limit) as unknown as Array<{
        delivery_id: string; session_id: string; continuation_id: string; endpoint: string;
        payload_json: string; attempt_count: number;
      }>;
      const lease = this.stmt(
        `UPDATE background_push_deliveries SET lease_expires_at=?, updated_at=?
          WHERE delivery_id=? AND state IN ('pending','retry')
            AND (lease_expires_at IS NULL OR lease_expires_at<=?)`,
      );
      const claimed: DurableBackgroundPushDelivery[] = [];
      for (const row of rows) {
        if (Number(lease.run(now + 30_000, now, row.delivery_id, now).changes) !== 1) continue;
        const message = parseJson<import("./web-push.js").PushMessage>(row.payload_json);
        if (!message) {
          this.settleBackgroundPushDelivery(row.delivery_id, { kind: "permanent_failure", error: "invalid_payload" }, now);
          continue;
        }
        claimed.push({
          deliveryId: row.delivery_id,
          sessionId: row.session_id,
          continuationId: row.continuation_id,
          endpoint: row.endpoint,
          message,
          ackToken: this.backgroundPushReceiptToken(row.delivery_id),
          attemptCount: row.attempt_count,
        });
      }
      return claimed;
    });
  }

  settleBackgroundPushDelivery(deliveryId: string, outcome: PushServiceOutcome, now: number): boolean {
    if (!validBackgroundIdentity(deliveryId) || !Number.isSafeInteger(now) || now < 0) return false;
    if (outcome.kind === "service_accepted") {
      return Number(this.stmt(
        `UPDATE background_push_deliveries
            SET state=CASE WHEN clicked_at IS NOT NULL THEN 'clicked'
                           WHEN shown_at IS NOT NULL THEN 'shown' ELSE 'service_accepted' END,
                attempt_count=attempt_count+1, last_status=?, last_error=NULL,
                service_accepted_at=COALESCE(service_accepted_at, ?), next_attempt_at=NULL,
                endpoint=NULL, lease_expires_at=NULL, updated_at=?
          WHERE delivery_id=? AND state IN ('pending','retry')`,
      ).run(outcome.status, now, now, deliveryId).changes) > 0;
    }
    if (outcome.kind === "permanent_failure") {
      return Number(this.stmt(
        `UPDATE background_push_deliveries SET
            state=CASE WHEN clicked_at IS NOT NULL THEN 'clicked'
                       WHEN shown_at IS NOT NULL THEN 'shown' ELSE 'permanent_failure' END,
            attempt_count=attempt_count+1,
            last_status=?, last_error=?, endpoint=NULL, next_attempt_at=NULL, lease_expires_at=NULL, updated_at=?
          WHERE delivery_id=? AND state IN ('pending','retry')`,
      ).run(outcome.status ?? null, (outcome.error ?? "permanent_failure").slice(0, 120), now, deliveryId).changes) > 0;
    }
    const row = this.stmt("SELECT attempt_count, expires_at FROM background_push_deliveries WHERE delivery_id=?")
      .get(deliveryId) as { attempt_count: number; expires_at: number } | undefined;
    if (!row) return false;
    const attempts = row.attempt_count + 1;
    const next = Math.min(row.expires_at, now + Math.min(60 * 60_000, 5_000 * 2 ** Math.min(attempts - 1, 8)));
    return Number(this.stmt(
      `UPDATE background_push_deliveries SET
          state=CASE WHEN service_accepted_at IS NOT NULL THEN 'service_accepted'
                     WHEN clicked_at IS NOT NULL THEN 'clicked'
                     WHEN shown_at IS NOT NULL THEN 'shown'
                     WHEN expires_at<=? THEN 'expired' ELSE 'retry' END,
          attempt_count=?, last_status=?, last_error=?,
          next_attempt_at=CASE WHEN service_accepted_at IS NOT NULL OR shown_at IS NOT NULL OR clicked_at IS NOT NULL OR expires_at<=?
                               THEN NULL ELSE ? END,
          endpoint=CASE WHEN service_accepted_at IS NOT NULL OR shown_at IS NOT NULL OR clicked_at IS NOT NULL OR expires_at<=?
                        THEN NULL ELSE endpoint END,
          lease_expires_at=NULL, updated_at=?
        WHERE delivery_id=? AND state IN ('pending','retry')`,
    ).run(now, attempts, outcome.status ?? null, (outcome.error ?? "transient_failure").slice(0, 120),
      now, next, now, now, deliveryId).changes) > 0;
  }

  acknowledgeBackgroundPushReceipt(
    deliveryId: string,
    token: string,
    stage: "shown" | "clicked",
    now: number,
  ): boolean {
    if (!validBackgroundIdentity(deliveryId) || typeof token !== "string" || token.length > 128 ||
        !Number.isSafeInteger(now) || now < 0) return false;
    const expected = Buffer.from(this.backgroundPushReceiptToken(deliveryId));
    const presented = Buffer.from(token);
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return false;
    const result = stage === "shown"
      ? this.stmt(
        `UPDATE background_push_deliveries SET shown_at=COALESCE(shown_at, ?),
            state=CASE WHEN clicked_at IS NOT NULL THEN 'clicked' ELSE 'shown' END,
            endpoint=NULL, next_attempt_at=NULL, lease_expires_at=NULL, updated_at=MAX(updated_at, ?) WHERE delivery_id=?`,
      ).run(now, now, deliveryId)
      : this.stmt(
        `UPDATE background_push_deliveries SET shown_at=COALESCE(shown_at, ?),
            clicked_at=COALESCE(clicked_at, ?), state='clicked', endpoint=NULL, next_attempt_at=NULL,
            lease_expires_at=NULL, updated_at=MAX(updated_at, ?) WHERE delivery_id=?`,
      ).run(now, now, now, deliveryId);
    return Number(result.changes) > 0;
  }

  private listBackgroundNotificationReceipts(
    sessionId: string,
    continuationIds: string[],
  ): Map<string, BackgroundNotificationReceiptView[]> {
    const grouped = new Map<string, BackgroundNotificationReceiptView[]>();
    if (continuationIds.length === 0) return grouped;
    const placeholders = continuationIds.map(() => "?").join(",");
    const rows = this.stmt(
      `SELECT continuation_id, delivery_id, endpoint_key, state, attempt_count, service_accepted_at,
              shown_at, clicked_at, last_status, last_error
         FROM background_push_deliveries
        WHERE session_id=? AND continuation_id IN (${placeholders})
        ORDER BY continuation_id, endpoint_key LIMIT 2048`,
    ).all(sessionId, ...continuationIds) as unknown as Array<{
      continuation_id: string; delivery_id: string; endpoint_key: string;
      state: BackgroundNotificationReceiptState;
      attempt_count: number; service_accepted_at: number | null; shown_at: number | null;
      clicked_at: number | null; last_status: number | null; last_error: string | null;
    }>;
    for (const row of rows) {
      const receipts = grouped.get(row.continuation_id) ?? [];
      if (receipts.length >= 64) continue;
      receipts.push({
        deliveryId: row.delivery_id,
        endpointKey: row.endpoint_key.slice(0, 16),
        state: row.state,
        attemptCount: row.attempt_count,
        ...(row.service_accepted_at != null ? { serviceAcceptedAt: row.service_accepted_at } : {}),
        ...(row.shown_at != null ? { shownAt: row.shown_at } : {}),
        ...(row.clicked_at != null ? { clickedAt: row.clicked_at } : {}),
        ...(row.last_status != null ? { lastStatus: row.last_status } : {}),
        ...(row.last_error ? { lastError: row.last_error } : {}),
      });
      grouped.set(row.continuation_id, receipts);
    }
    return grouped;
  }

  /* ------------------------------- Boxes --------------------------------- */

  createBox(input: NewBoxInput): void {
    const scope = input.scope ?? {
      organizationId: PERSONAL_ORGANIZATION_ID,
      owner: { kind: "organization" as const, organizationId: PERSONAL_ORGANIZATION_ID },
    };
    const ownerId = scope.owner.kind === "organization"
      ? scope.owner.organizationId
      : scope.owner.kind === "user"
        ? scope.owner.userId
        : scope.owner.teamId;
    this.db.exec("BEGIN");
    try {
      this.stmt(
        `INSERT INTO boxes
           (box_id, runner_id, ssh_target, ssh_port, workspaces, status, auto_reconnect,
            runner_data_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'bootstrapping', ?, ?, ?, ?)`,
      )
      .run(
        input.boxId,
        input.runnerId,
        input.sshTarget,
        input.sshPort,
        JSON.stringify(input.workspaces),
        input.autoReconnect ? 1 : 0,
        input.runnerDataDir ?? null,
        input.now,
        input.now,
      );
      this.stmt(
        `INSERT INTO runner_ownership
           (runner_id, organization_id, owner_kind, owner_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(input.runnerId, scope.organizationId, scope.owner.kind, ownerId, input.now, input.now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setBoxStatus(boxId: string, status: BoxStatus, now: number, lastError: string | null = null): void {
    this.stmt("UPDATE boxes SET status=?, last_error=?, updated_at=? WHERE box_id=?")
      .run(status, lastError, now, boxId);
  }

  authorizeBoxLegacyDataAdoption(input: {
    boxId: string;
    epoch: string;
    authorizedBy: string;
    authorizedRole: "owner" | "admin";
    now: number;
  }): boolean {
    this.db.exec("BEGIN");
    try {
      const account = this.stmt(
        `INSERT INTO legacy_ssh_account_adoptions
           (ssh_target, ssh_port, epoch, status, adopter_box_id, authorized_by, authorized_role, authorized_at)
         SELECT trim(ssh_target), ssh_port, ?, 'pending', box_id, ?, ?, ?
           FROM boxes
          WHERE box_id=? AND runner_data_dir IS NULL AND legacy_adoption_epoch IS NULL
         ON CONFLICT(ssh_target, ssh_port) DO NOTHING`,
      ).run(input.epoch, input.authorizedBy, input.authorizedRole, input.now, input.boxId);
      if (account.changes !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const mirror = this.stmt(
        `UPDATE boxes
            SET legacy_adoption_epoch=?, legacy_adoption_pending=1,
                legacy_adoption_authorized_by=?, legacy_adoption_authorized_role=?,
                legacy_adoption_authorized_at=?, legacy_adoption_completed_at=NULL, updated_at=?
          WHERE box_id=? AND runner_data_dir IS NULL AND legacy_adoption_epoch IS NULL`,
      ).run(input.epoch, input.authorizedBy, input.authorizedRole, input.now, input.now, input.boxId);
      if (mirror.changes !== 1) throw new Error("legacy SSH account adoption mirror raced");
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  completeBoxLegacyDataAdoption(
    boxId: string,
    epoch: string,
    now: number,
    credentialId?: string,
    binarySha256?: string,
  ): boolean {
    this.db.exec("BEGIN");
    try {
      const account = this.stmt(
        `UPDATE legacy_ssh_account_adoptions
            SET status='completed', completed_at=?, completed_credential_id=?,
                completed_binary_identity=?
          WHERE adopter_box_id=? AND epoch=? AND status='pending'`,
      ).run(now, credentialId ?? null, binarySha256 ?? null, boxId, epoch);
      if (account.changes !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const mirror = this.stmt(
        `UPDATE boxes
            SET legacy_adoption_pending=0, legacy_adoption_completed_at=?, updated_at=?
          WHERE box_id=? AND legacy_adoption_pending=1 AND legacy_adoption_epoch=?`,
      ).run(now, now, boxId, epoch);
      if (mirror.changes !== 1) throw new Error("legacy SSH account adoption completion mirror raced");
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  boxHasPendingLegacyDataAdoption(boxId: string): boolean {
    return Boolean(this.stmt(
      "SELECT 1 FROM legacy_ssh_account_adoptions WHERE adopter_box_id=? AND status='pending'",
    ).get(boxId));
  }

  setBoxDeployedVersion(boxId: string, version: string, now: number): void {
    this.stmt("UPDATE boxes SET deployed_version=?, updated_at=? WHERE box_id=?").run(version, now, boxId);
  }

  setBoxTriple(boxId: string, triple: string, now: number): void {
    this.stmt("UPDATE boxes SET triple=?, updated_at=? WHERE box_id=?").run(triple, now, boxId);
  }

  /** Delete a box together with its runner row AND that runner's sessions/runs. The `sessions`
   * table has NO foreign key to `runners`, so its rows must be removed explicitly (deleting
   * `sessions`/`runs` cascades their events/members). Returns the runner id + the removed session
   * ids so the caller can broadcast their removal to the UI. */
  deleteBox(boxId: string): { runnerId: string; sessionIds: string[]; runIds: string[]; podIds: string[] } | null {
    if (this.boxHasPendingLegacyDataAdoption(boxId)) {
      throw new Error("cannot delete the Machine while its legacy SSH account adoption is pending");
    }
    const row = this.stmt("SELECT runner_id FROM boxes WHERE box_id=?").get(boxId) as
      | { runner_id: string }
      | undefined;
    if (!row) return null;
    const sessionIds = (
      this.stmt("SELECT id FROM sessions WHERE runner_id=?").all(row.runner_id) as unknown as { id: string }[]
    ).map((s) => s.id);
    const runIds = (
      this.stmt("SELECT id FROM multi_agent_runs WHERE runner_id=?").all(row.runner_id) as unknown as { id: string }[]
    ).map((r) => r.id);
    const podIds = (
      this.stmt(
        "SELECT DISTINCT m.pod_id AS id FROM pod_members m JOIN sessions s ON s.id=m.session_id WHERE s.runner_id=?",
      ).all(row.runner_id) as unknown as { id: string }[]
    ).map((pod) => pod.id);
    this.db.exec("BEGIN");
    try {
      this.detachRunnerProjectLocations(row.runner_id, Date.now());
      this.stmt("DELETE FROM session_events_fts WHERE session_id IN (SELECT id FROM sessions WHERE runner_id=?)").run(row.runner_id);
      this.stmt("DELETE FROM artifacts WHERE run_id IS NULL AND session_id IN (SELECT id FROM sessions WHERE runner_id=?)").run(row.runner_id);
      this.stmt("DELETE FROM sessions WHERE runner_id=?").run(row.runner_id); // cascades session_events
      this.stmt("DELETE FROM multi_agent_runs WHERE runner_id=?").run(row.runner_id); // cascades members
      this.stmt("DELETE FROM boxes WHERE box_id=?").run(boxId);
      // No FK ties overrides/extras to runners — clean up explicitly, or a later runner reusing
      // this id would inherit a stale display name / project for a matching workspace id.
      this.stmt("DELETE FROM machine_overrides WHERE runner_id=?").run(row.runner_id);
      this.stmt("DELETE FROM workspace_overrides WHERE runner_id=?").run(row.runner_id);
      this.stmt("DELETE FROM workspace_extras WHERE runner_id=?").run(row.runner_id);
      this.stmt("DELETE FROM workspace_ownership WHERE runner_id=?").run(row.runner_id);
      this.stmt("DELETE FROM runner_ownership WHERE runner_id=?").run(row.runner_id);
      this.stmt("DELETE FROM runner_credentials WHERE runner_id=?").run(row.runner_id);
      this.clearSessionNamingHarnessTargetsForRunner(row.runner_id, Date.now());
      this.stmt("DELETE FROM runners WHERE runner_id=?").run(row.runner_id); // cascades workspaces, agents
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.collectWorkflowArtifactBlobs();
    return { runnerId: row.runner_id, sessionIds, runIds, podIds };
  }

  /** Delete a runner record and everything tied to it (agents, workspaces, sessions, runs, and its
   * box row if it was one). Used to drop a stale/offline runner from the dashboard. */
  deleteRunner(runnerId: string): { sessionIds: string[]; runIds: string[]; podIds: string[] } | null {
    const exists = this.stmt("SELECT 1 FROM runners WHERE runner_id=?").get(runnerId);
    if (!exists) return null;
    const managedBox = this.stmt("SELECT box_id FROM boxes WHERE runner_id=?").get(runnerId) as
      | { box_id: string }
      | undefined;
    if (managedBox && this.boxHasPendingLegacyDataAdoption(managedBox.box_id)) {
      throw new Error("cannot delete the Machine runner while its legacy SSH account adoption is pending");
    }
    const sessionIds = (
      this.stmt("SELECT id FROM sessions WHERE runner_id=?").all(runnerId) as unknown as { id: string }[]
    ).map((s) => s.id);
    const runIds = (
      this.stmt("SELECT id FROM multi_agent_runs WHERE runner_id=?").all(runnerId) as unknown as { id: string }[]
    ).map((r) => r.id);
    const podIds = (
      this.stmt(
        "SELECT DISTINCT m.pod_id AS id FROM pod_members m JOIN sessions s ON s.id=m.session_id WHERE s.runner_id=?",
      ).all(runnerId) as unknown as { id: string }[]
    ).map((pod) => pod.id);
    this.db.exec("BEGIN");
    try {
      this.detachRunnerProjectLocations(runnerId, Date.now());
      this.stmt("DELETE FROM session_events_fts WHERE session_id IN (SELECT id FROM sessions WHERE runner_id=?)").run(runnerId);
      this.stmt("DELETE FROM artifacts WHERE run_id IS NULL AND session_id IN (SELECT id FROM sessions WHERE runner_id=?)").run(runnerId);
      this.stmt("DELETE FROM sessions WHERE runner_id=?").run(runnerId); // cascades session_events
      this.stmt("DELETE FROM multi_agent_runs WHERE runner_id=?").run(runnerId); // cascades members
      this.stmt("DELETE FROM boxes WHERE runner_id=?").run(runnerId); // if it was a box
      // No FK ties overrides/extras to runners — clean up explicitly (see deleteBox).
      this.stmt("DELETE FROM machine_overrides WHERE runner_id=?").run(runnerId);
      this.stmt("DELETE FROM workspace_overrides WHERE runner_id=?").run(runnerId);
      this.stmt("DELETE FROM workspace_extras WHERE runner_id=?").run(runnerId);
      this.stmt("DELETE FROM workspace_ownership WHERE runner_id=?").run(runnerId);
      this.stmt("DELETE FROM runner_ownership WHERE runner_id=?").run(runnerId);
      this.stmt("DELETE FROM runner_credentials WHERE runner_id=?").run(runnerId);
      this.stmt("DELETE FROM runner_skill_state WHERE runner_id=?").run(runnerId);
      this.stmt("DELETE FROM skill_assignments WHERE scope_kind='runner' AND runner_id=?").run(runnerId);
      this.clearSessionNamingHarnessTargetsForRunner(runnerId, Date.now());
      this.stmt("DELETE FROM runners WHERE runner_id=?").run(runnerId); // cascades workspaces, agents
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.collectWorkflowArtifactBlobs();
    return { sessionIds, runIds, podIds };
  }

  getBox(boxId: string): BoxView | null {
    const row = this.boxRow(boxId);
    return row ? this.boxView(row) : null;
  }

  listBoxes(): BoxView[] {
    return this.allBoxRows().map((r) => this.boxView(r));
  }

  /** The box id whose runner registers with `runnerId` (for correlating on register), or null. */
  boxIdForRunner(runnerId: string): string | null {
    const row = this.stmt("SELECT box_id FROM boxes WHERE runner_id=?").get(runnerId) as
      | { box_id: string }
      | undefined;
    return row?.box_id ?? null;
  }

  getBoxConfig(boxId: string): BoxConfig | null {
    const row = this.boxRow(boxId);
    return row ? this.boxConfig(row) : null;
  }

  listBoxConfigs(): BoxConfig[] {
    return this.allBoxRows().map((r) => this.boxConfig(r));
  }

  private boxRow(boxId: string): BoxRow | null {
    return (this.stmt("SELECT * FROM boxes WHERE box_id=?").get(boxId) as unknown as BoxRow | undefined) ?? null;
  }

  private allBoxRows(): BoxRow[] {
    return this.stmt("SELECT * FROM boxes ORDER BY created_at").all() as unknown as BoxRow[];
  }

  private boxView(row: BoxRow): BoxView {
    const accountAdoption = this.legacySshAccountAdoption(row.ssh_target, row.ssh_port);
    return {
      boxId: row.box_id,
      displayName: this.machineDisplayName(row.runner_id),
      sshTarget: row.ssh_target,
      runnerId: row.runner_id,
      status: row.status as BoxStatus,
      lastError: row.last_error,
      createdAt: row.created_at,
      deployedVersion: row.deployed_version,
      triple: row.triple,
      runnerDataLayout: row.runner_data_dir === null ? "legacy" : "isolated-v1",
      legacyDataAdoption: row.legacy_adoption_epoch && row.legacy_adoption_authorized_at !== null
        ? {
            status: row.legacy_adoption_pending === 1 ? "pending" : "completed",
            authorizedAt: row.legacy_adoption_authorized_at,
            ...(row.legacy_adoption_completed_at === null ? {} : { completedAt: row.legacy_adoption_completed_at }),
          }
        : null,
      legacyDataAccountStatus: accountAdoption
        ? accountAdoption.status === "pending" ? "pending" : "adopted"
        : "unclaimed",
    };
  }

  private boxConfig(row: BoxRow): BoxConfig {
    let workspaces: { id: string; name: string; path: string }[] = [];
    try {
      workspaces = JSON.parse(row.workspaces) as { id: string; name: string; path: string }[];
    } catch {
      /* malformed; treat as none */
    }
    const accountAdoption = this.legacySshAccountAdoption(row.ssh_target, row.ssh_port);
    return {
      boxId: row.box_id,
      runnerId: row.runner_id,
      sshTarget: row.ssh_target,
      sshPort: row.ssh_port,
      workspaces,
      autoReconnect: row.auto_reconnect === 1,
      deployedVersion: row.deployed_version,
      triple: row.triple,
      runnerDataDir: row.runner_data_dir,
      pendingLegacyDataAdoptionEpoch: row.legacy_adoption_pending === 1
        ? row.legacy_adoption_epoch
        : null,
      legacyDataAdoptionEpoch: row.legacy_adoption_epoch,
      legacyDataAccountStatus: accountAdoption
        ? accountAdoption.status === "pending" ? "pending" : "adopted"
        : "unclaimed",
    };
  }

  private legacySshAccountAdoption(sshTarget: string, sshPort: number): LegacySshAccountAdoptionRow | null {
    return (this.stmt(
      "SELECT * FROM legacy_ssh_account_adoptions WHERE ssh_target=? AND ssh_port=?",
    ).get(sshTarget.trim(), sshPort) as unknown as LegacySshAccountAdoptionRow | undefined) ?? null;
  }

  private runnerView(row: RunnerRow): RunnerView {
    // "Rename project" overrides win over the runner-reported names.
    const overrides = new Map(
      (
        this.stmt("SELECT workspace_id, display_name FROM workspace_overrides WHERE runner_id=?")
          .all(row.runner_id) as { workspace_id: string; display_name: string | null }[]
      ).map((o) => [o.workspace_id, o.display_name]),
    );
    const reported = (
      this.stmt("SELECT id, name, path, additional_directory_grants FROM workspaces WHERE runner_id=? ORDER BY id")
        .all(row.runner_id) as unknown as { id: string; name: string; path: string; additional_directory_grants: string | null }[]
    ).map<WorkspaceInfo>((w) => {
      const grants = parseJson<string[]>(w.additional_directory_grants);
      return {
        id: w.id,
        name: overrides.get(w.id) ?? w.name,
        path: w.path,
        ...(grants?.length ? { additionalDirectoryGrants: grants } : {}),
      };
    });
    // CP-created projects (workspace_extras) are appended after the runner-reported ones; a
    // reported workspace wins on id collision (the runner is authoritative for ids it advertises).
    const reportedIds = new Set(reported.map((w) => w.id));
    const extras = this.workspaceExtras(row.runner_id)
      .filter((w) => !reportedIds.has(w.id))
      .map<WorkspaceInfo>((w) => ({ id: w.id, name: overrides.get(w.id) ?? w.name, path: w.path }));
    const workspaces = [...reported, ...extras];

    const agents = (
      this.stmt(
          `SELECT ra.agent_id AS agent_id, ad.name AS name, ra.command AS command, ra.args AS args, ra.env AS env,
                  ra.driver AS driver, ra.context AS context, ra.capabilities AS capabilities,
                  ra.version AS version, ra.auth_status AS auth_status, ra.available AS available, ra.source AS source,
                  ra.codex_app_server AS codex_app_server, ra.claude_code AS claude_code,
                  ra.acp AS acp, ra.registry AS registry, ra.acp_transport AS acp_transport
             FROM runner_agents ra JOIN agent_definitions ad ON ad.id = ra.agent_id
            WHERE ra.runner_id=? ORDER BY ra.agent_id`,
        )
        .all(row.runner_id) as unknown as {
        agent_id: string;
        name: string;
        command: string;
        args: string;
        env: string;
        driver: string;
        context: string | null;
        capabilities: string | null;
        version: string | null;
        auth_status: string | null;
        available: number | null;
        source: string | null;
        codex_app_server: string | null;
        claude_code: string | null;
        acp: string | null;
        registry: string | null;
        acp_transport: string | null;
      }[]
    ).map<AgentDefinition>((a) => ({
      id: a.agent_id,
      name: a.name,
      command: a.command,
      args: jsonArray(a.args),
      // Launch environment is never part of reusable REST/WS metadata. Pre-v54 values may remain
      // internally only long enough to launch an old runner compatibility path.
      env: {},
      driver: (a.driver as AgentDriverKind) ?? "acp",
      context: parseJson<AgentContext>(a.context) ?? { kind: "native" },
      capabilities: parseJson<AgentCapabilities>(a.capabilities) ?? undefined,
      version: a.version ?? undefined,
      authStatus: (a.auth_status as AgentDefinition["authStatus"]) ?? undefined,
      available: a.available == null ? undefined : a.available === 1,
      source: (a.source as AgentDefinition["source"] | null) ?? "config",
      codexAppServer: parseJson<AgentDefinition["codexAppServer"]>(a.codex_app_server) ?? undefined,
      claudeCode: parseJson<AgentDefinition["claudeCode"]>(a.claude_code) ?? undefined,
      acp: parseJson<AgentDefinition["acp"]>(a.acp) ?? undefined,
      registry: parseJson<AgentDefinition["registry"]>(a.registry) ?? undefined,
      acpTransport: a.acp_transport === "stdio" ? "stdio" : undefined,
    }));

    const view: RunnerView = {
      runnerId: row.runner_id,
      displayName: this.machineDisplayName(row.runner_id),
      hostname: row.hostname,
      os: row.os as OS,
      version: row.version,
      status: row.status as RunnerStatus,
      connectedAt: row.connected_at,
      lastSeen: row.last_seen,
      protocolVersion: row.protocol_version ?? null,
      agentsRefreshed: row.agents_refreshed_at != null,
      agents,
      workspaces,
      // The editors COLUMN survives re-registers by design (COALESCE), so gate the VIEW on
      // the registered protocol version: a downgraded runner (or an old runner reusing this
      // id) would otherwise advertise editors it can never open — the dashboard would show
      // the button and every click would dead-end in the host-action timeout.
      editors: runnerSupportsProtocol(row.protocol_version, "hostActions")
        ? (parseJson<EditorInfo[]>(row.editors) ?? undefined)
        : undefined,
      runtime: runnerSupportsProtocol(row.protocol_version, "runtimeDiagnostics")
        ? (parseJson<RunnerView["runtime"]>(row.runtime) ?? undefined)
        : undefined,
    };
    if (runnerSupportsProtocol(row.protocol_version, "executionTargets")) {
      const hostTargets = executionTargetsForRunner(view, this.boxIdForRunner(row.runner_id) !== null);
      let runnerTargets: ExecutionTargetDefinition[] = [];
      if (runnerSupportsProtocol(row.protocol_version, "containerExecutionTargets")) {
        try {
          const persisted = parseJson<ExecutionTargetDefinition[]>(row.container_targets) ?? [];
          runnerTargets = [
            ...validateRunnerContainerTargets(row.runner_id, persisted.filter((target) => target.adapter === "container"), row.status === "online"),
            ...(runnerSupportsProtocol(row.protocol_version, "cloudExecutionHandoffs")
              ? validateRunnerCloudTargets(row.runner_id, persisted.filter((target) => target.adapter === "cloud"), row.status === "online")
              : []),
          ];
        } catch {
          runnerTargets = [];
        }
      }
      view.executionTargets = [...hostTargets, ...runnerTargets];
    }
    return view;
  }

  /** Resolve a runner+agent to its launch command/args/env + driver/context. */
  getAgentLaunch(runnerId: string, agentId: string): AgentLaunch | null {
    // NULL is the backwards-compatible state advertised by older runners. Only an explicit
    // discovery result of `available: false` makes a definition non-launchable.
    const row = this.stmt(
      "SELECT command, args, env, driver, context, version, capabilities FROM runner_agents WHERE runner_id=? AND agent_id=? AND available IS NOT 0",
    )
      .get(runnerId, agentId) as unknown as
      | { command: string; args: string; env: string; driver: string; context: string | null; version: string | null; capabilities: string | null }
      | undefined;
    if (!row) return null;
    return {
      command: row.command,
      args: jsonArray(row.args),
      env: jsonObject(row.env),
      driver: (row.driver as AgentDriverKind) ?? "acp",
      context: parseJson<AgentContext>(row.context) ?? { kind: "native" },
      version: row.version ?? undefined,
      capabilities: parseJson<AgentCapabilities>(row.capabilities) ?? undefined,
    };
  }

  /** Upsert one content-free observation into an hourly aggregate bucket. */
  recordDriverTelemetry(event: DriverTelemetryMessage, remote: boolean, now = Date.now()): void {
    if (now - this.lastTelemetryPrune >= 6 * 3_600_000) {
      this.stmt("DELETE FROM driver_telemetry_hourly WHERE bucket_ts < ?").run(now - 180 * 86_400_000);
      this.lastTelemetryPrune = now;
    }
    const bucketTs = Math.floor(now / 3_600_000) * 3_600_000;
    const rawDuration = event.durationMs ?? 0;
    const durationMs = Number.isFinite(rawDuration)
      ? Math.max(0, Math.min(Math.floor(rawDuration), 86_400_000))
      : 0;
    this.stmt(
      `INSERT INTO driver_telemetry_hourly
         (bucket_ts, driver, version, context, remote, metric, outcome, reason, count, total_ms, max_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(bucket_ts, driver, version, context, remote, metric, outcome, reason)
       DO UPDATE SET count=count+1, total_ms=total_ms+excluded.total_ms, max_ms=MAX(max_ms, excluded.max_ms)`,
    ).run(
      bucketTs,
      event.driver,
      (event.version ?? "").slice(0, 80),
      event.context,
      remote ? 1 : 0,
      event.metric,
      event.outcome,
      event.reason ?? "",
      durationMs,
      durationMs,
    );
  }

  listDriverTelemetry(since: number): DriverTelemetryAggregate[] {
    const rows = this.stmt(
      `SELECT bucket_ts, driver, version, context, remote, metric, outcome, reason,
              count, total_ms, max_ms
         FROM driver_telemetry_hourly WHERE bucket_ts >= ? ORDER BY bucket_ts, driver, metric`,
    ).all(since) as unknown as Array<{
      bucket_ts: number; driver: string; version: string; context: string; remote: number;
      metric: string; outcome: string; reason: string; count: number; total_ms: number; max_ms: number;
    }>;
    return rows.map((row) => ({
      bucketTs: row.bucket_ts,
      driver: row.driver as AgentDriverKind,
      version: row.version || null,
      context: row.context as "native" | "wsl",
      remote: row.remote === 1,
      metric: row.metric as DriverTelemetryMessage["metric"],
      outcome: row.outcome as DriverTelemetryMessage["outcome"],
      reason: (row.reason || null) as DriverTelemetryMessage["reason"] | null,
      count: row.count,
      totalMs: row.total_ms,
      maxMs: row.max_ms,
    }));
  }

  /** Roll hourly storage up across the requested window so the API response is independent of
   * bucket count (90 days does not multiply rows by 2160). */
  summarizeDriverTelemetry(since: number): DriverTelemetrySummary[] {
    const rows = this.stmt(
      `SELECT driver, version, context, remote, metric, outcome, reason,
              SUM(count) AS count, SUM(total_ms) AS total_ms, MAX(max_ms) AS max_ms
         FROM driver_telemetry_hourly WHERE bucket_ts >= ?
        GROUP BY driver, version, context, remote, metric, outcome, reason
        ORDER BY driver, version, context, remote, metric, outcome, reason`,
    ).all(since) as unknown as Array<{
      driver: string; version: string; context: string; remote: number; metric: string;
      outcome: string; reason: string; count: number; total_ms: number; max_ms: number;
    }>;
    return rows.map((row) => ({
      driver: row.driver as AgentDriverKind,
      version: row.version || null,
      context: row.context as "native" | "wsl",
      remote: row.remote === 1,
      metric: row.metric as DriverTelemetryMessage["metric"],
      outcome: row.outcome as DriverTelemetryMessage["outcome"],
      reason: (row.reason || null) as DriverTelemetryMessage["reason"] | null,
      count: row.count,
      totalMs: row.total_ms,
      maxMs: row.max_ms,
    }));
  }

  /* ---------------------- Usage/cost aggregation ----------------------- */

  private static usageToken(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.min(Math.floor(value), 1_000_000_000_000)
      : 0;
  }

  private static usageMicroUsd(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
    return Math.min(Math.round(value * 1_000_000), 1_000_000_000_000);
  }

  private static usageCostParts(value: unknown): { microusd: number; remainderPicousd: number } {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return { microusd: 0, remainderPicousd: 0 };
    }
    const scaledMicrousd = Math.min(value * 1_000_000, 1_000_000_000_000);
    let microusd = Math.floor(scaledMicrousd);
    let remainderPicousd = Math.round((scaledMicrousd - microusd) * 1_000_000);
    if (remainderPicousd >= 1_000_000) {
      microusd += 1;
      remainderPicousd = 0;
    }
    return { microusd, remainderPicousd };
  }

  /** Upgrade cutover: retain existing lifetime totals as an absolute watermark without inventing
   * historical buckets. Only usage observed after coverageStartedAt appears in the dashboard. */
  private seedUsageAggregationBaseline(now: number): void {
    this.db.exec("BEGIN");
    try {
      const seeded = this.stmt("SELECT baseline_seeded_at FROM usage_aggregation_meta WHERE id=1").get();
      this.stmt(
        `INSERT OR IGNORE INTO usage_retention_policy
           (organization_id, hourly_days, daily_days, coverage_started_at, updated_at)
         SELECT organization_id, 30, 365, ?, ? FROM identity_organizations`,
      ).run(now, now);
      if (!seeded) {
        this.stmt(
          `INSERT INTO usage_session_state
             (session_id, input_tokens, output_tokens, cost_microusd, runner_history_epoch,
              covered_through_seq, revision, updated_at)
           SELECT id,
                  CASE WHEN input_tokens >= 0 THEN input_tokens ELSE 0 END,
                  CASE WHEN output_tokens >= 0 THEN output_tokens ELSE 0 END,
                  CAST(ROUND(CASE WHEN cost_usd >= 0 THEN cost_usd ELSE 0 END * 1000000.0) AS INTEGER),
                  runner_history_epoch, runner_history_tail_seq, 0, ?
             FROM sessions`,
        ).run(now);
        this.stmt("INSERT INTO usage_aggregation_meta (id, baseline_seeded_at) VALUES (1, ?)").run(now);
      }
      // v104: the per-session per-model ledger starts from the lifetime state already recorded,
      // attributed to the session's resolved model, so an upgraded deployment shows existing
      // sessions' usage in the popover instead of nothing until their next turn. Idempotent: a
      // session already present in the ledger is left alone.
      this.stmt(
        `INSERT OR IGNORE INTO usage_session_models
           (session_id, model, driver, input_tokens, output_tokens, cost_microusd,
            ${USAGE_LEDGER_V103_COLUMNS.join(", ")}, updated_at)
         SELECT state.session_id, COALESCE(NULLIF(s.resolved_model, ''), s.model, ''), s.driver,
                state.input_tokens, state.output_tokens, state.cost_microusd,
                ${USAGE_LEDGER_V103_COLUMNS.map((column) => `state.${column}`).join(", ")}, ?
           FROM usage_session_state state JOIN sessions s ON s.id=state.session_id
          WHERE NOT EXISTS (SELECT 1 FROM usage_session_models m WHERE m.session_id=state.session_id)
            AND (state.input_tokens > 0 OR state.output_tokens > 0 OR state.cost_microusd > 0
                 OR ${USAGE_LEDGER_V103_COLUMNS.map((column) => `state.${column} > 0`).join(" OR ")})`,
      ).run(now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private ensureUsageRetentionPolicy(organizationId: string, now = Date.now()): UsageRetentionPolicy {
    this.stmt(
      `INSERT OR IGNORE INTO usage_retention_policy
         (organization_id, hourly_days, daily_days, coverage_started_at, updated_at)
       VALUES (?, 30, 365, ?, ?)`,
    ).run(organizationId, now, now);
    const row = this.stmt(
      `SELECT hourly_days, daily_days, coverage_started_at
         FROM usage_retention_policy WHERE organization_id=?`,
    ).get(organizationId) as { hourly_days: number; daily_days: number; coverage_started_at: number };
    return {
      hourlyDays: row.hourly_days,
      dailyDays: row.daily_days,
      coverageStartedAt: row.coverage_started_at,
    };
  }

  getUsageRetentionPolicy(organizationId: string): UsageRetentionPolicy {
    return this.ensureUsageRetentionPolicy(organizationId);
  }

  setUsageRetentionPolicy(
    organizationId: string,
    input: { hourlyDays: number; dailyDays: number },
    now = Date.now(),
  ): UsageRetentionPolicy {
    const hourlyDays = input.hourlyDays;
    const dailyDays = input.dailyDays;
    if (!Number.isFinite(hourlyDays) || !Number.isInteger(hourlyDays) || hourlyDays < 1 || hourlyDays > 90) {
      throw new RangeError("hourlyDays must be between 1 and 90");
    }
    if (!Number.isFinite(dailyDays) || !Number.isInteger(dailyDays) || dailyDays < Math.max(hourlyDays, 30) || dailyDays > 3650) {
      throw new RangeError("dailyDays must be between max(hourlyDays, 30) and 3650");
    }
    this.ensureUsageRetentionPolicy(organizationId, now);
    this.stmt(
      `UPDATE usage_retention_policy SET hourly_days=?, daily_days=?, updated_at=?
       WHERE organization_id=?`,
    ).run(hourlyDays, dailyDays, now, organizationId);
    this.maintainUsageAggregation(now, organizationId);
    return this.getUsageRetentionPolicy(organizationId);
  }

  /** Roll old hourly buckets into UTC days and prune only after the rollup commits. A late write to
   * an already-rolled day lands in hourly and is added by the next idempotent rollup transaction. */
  maintainUsageAggregation(now = Date.now(), onlyOrganizationId?: string): void {
    const policies = this.stmt(
      `SELECT organization_id, hourly_days, daily_days FROM usage_retention_policy
       WHERE (? IS NULL OR organization_id=?)`,
    ).all(onlyOrganizationId ?? null, onlyOrganizationId ?? null) as unknown as Array<{
      organization_id: string; hourly_days: number; daily_days: number;
    }>;
    this.db.exec("BEGIN");
    try {
      for (const policy of policies) {
        const hourlyCutoff = Math.floor((now - policy.hourly_days * 86_400_000) / 3_600_000) * 3_600_000;
        const dailyCutoff = Math.floor((now - policy.daily_days * 86_400_000) / 86_400_000) * 86_400_000;
        this.stmt(
          `INSERT INTO usage_daily
             (bucket_ts, organization_id, owner_kind, owner_id, runner_id, workspace_id, agent_id, driver, model,
              input_tokens, output_tokens, cost_microusd, ${USAGE_LEDGER_V103_COLUMNS.join(", ")})
           SELECT (bucket_ts / 86400000) * 86400000, organization_id, owner_kind, owner_id,
                  runner_id, workspace_id, agent_id, driver, model,
                  SUM(input_tokens), SUM(output_tokens), SUM(cost_microusd),
                  ${USAGE_LEDGER_V103_COLUMNS.map((column) => `SUM(${column})`).join(", ")}
             FROM usage_hourly
            WHERE organization_id=? AND bucket_ts < ?
            GROUP BY (bucket_ts / 86400000) * 86400000, organization_id, owner_kind, owner_id,
                     runner_id, workspace_id, agent_id, driver, model
           ON CONFLICT(bucket_ts, organization_id, owner_kind, owner_id, runner_id, workspace_id, agent_id, driver, model)
           DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens,
                         output_tokens=output_tokens+excluded.output_tokens,
                         cost_microusd=cost_microusd+excluded.cost_microusd,
                         ${USAGE_LEDGER_ACCUMULATE_SQL}`,
        ).run(policy.organization_id, hourlyCutoff);
        this.stmt("DELETE FROM usage_hourly WHERE organization_id=? AND bucket_ts < ?")
          .run(policy.organization_id, hourlyCutoff);
        this.stmt("DELETE FROM usage_daily WHERE organization_id=? AND bucket_ts < ?")
          .run(policy.organization_id, dailyCutoff);
        this.stmt(
          `UPDATE usage_retention_policy
              SET coverage_started_at=MAX(coverage_started_at, ?), updated_at=MAX(updated_at, ?)
            WHERE organization_id=?`,
        ).run(dailyCutoff, now, policy.organization_id);
      }
      this.db.exec("COMMIT");
      if (!onlyOrganizationId) this.lastUsageMaintenance = now;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private maybeMaintainUsageAggregation(): void {
    const now = Date.now();
    if (now - this.lastUsageMaintenance >= 6 * 3_600_000) this.maintainUsageAggregation(now);
  }

  private usageDimensions(sessionId: string): UsageDimensions | null {
    const row = this.stmt(
      `SELECT s.event_epoch, s.runner_id, s.workspace_id, s.agent_id, s.driver,
              COALESCE(NULLIF(s.resolved_model, ''), s.model) AS model,
              o.organization_id, o.owner_kind, o.owner_id
         FROM sessions s JOIN session_ownership o ON o.session_id=s.id WHERE s.id=?`,
    ).get(sessionId) as {
      event_epoch: number; runner_id: string; workspace_id: string | null; agent_id: string | null;
      driver: string; model: string | null; organization_id: string;
      owner_kind: "organization" | "user" | "team"; owner_id: string;
    } | undefined;
    if (!row) return null;
    return {
      eventEpoch: row.event_epoch,
      scope: this.scopeFromRow(row),
      runnerId: row.runner_id.slice(0, 256),
      workspaceId: (row.workspace_id ?? "").slice(0, 256),
      agentId: (row.agent_id ?? "").slice(0, 256),
      driver: row.driver as AgentDriverKind,
      model: (row.model ?? "").slice(0, 128),
    };
  }

  /** Called only inside an existing write transaction after the owning event/snapshot is accepted. */
  /** The settled session cost after ledger pricing; cheaper than a full session view. */
  sessionCostUsd(sessionId: string): number {
    const row = this.stmt("SELECT cost_usd FROM sessions WHERE id=?").get(sessionId) as { cost_usd: number } | undefined;
    return Number(row?.cost_usd ?? 0);
  }

  private recordUsageDeltaInTransaction(
    sessionId: string,
    amount: UsageLedgerDelta,
    occurredAt: number,
    updateSessionTotals: boolean,
    knownDimensions?: UsageDimensions | null,
  ): void {
    if (amount.inputTokens === 0 && amount.outputTokens === 0 && amount.costMicrousd === 0 &&
        amount.providerReportedRecords === 0 && amount.modelPricedRecords === 0 && amount.unpricedRecords === 0) return;
    const dimensions = knownDimensions === undefined ? this.usageDimensions(sessionId) : knownDimensions;
    if (!dimensions) return; // Missing ownership fails closed rather than leaking into a global row.
    this.ensureUsageRetentionPolicy(dimensions.scope.organizationId, occurredAt);
    const bucketTs = Math.floor(Math.max(0, occurredAt) / 3_600_000) * 3_600_000;
    const ownerId = dimensions.scope.owner.kind === "organization"
      ? dimensions.scope.owner.organizationId
      : dimensions.scope.owner.kind === "user" ? dimensions.scope.owner.userId : dimensions.scope.owner.teamId;
    const ledgerValues = [
      amount.inputTokens, amount.outputTokens, amount.costMicrousd,
      amount.uncachedInputTokens, amount.cachedInputTokens, amount.cacheCreationTokens, amount.reasoningTokens,
      amount.cacheSavingsMicrousd, amount.providerReportedRecords, amount.modelPricedRecords, amount.unpricedRecords,
    ];
    this.stmt(
      `INSERT INTO usage_hourly
         (bucket_ts, organization_id, owner_kind, owner_id, runner_id, workspace_id, agent_id, driver, model,
          input_tokens, output_tokens, cost_microusd, ${USAGE_LEDGER_V103_COLUMNS.join(", ")})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bucket_ts, organization_id, owner_kind, owner_id, runner_id, workspace_id, agent_id, driver, model)
       DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens,
                     output_tokens=output_tokens+excluded.output_tokens,
                     cost_microusd=cost_microusd+excluded.cost_microusd,
                     ${USAGE_LEDGER_ACCUMULATE_SQL}`,
    ).run(
      bucketTs,
      dimensions.scope.organizationId,
      dimensions.scope.owner.kind,
      ownerId,
      dimensions.runnerId,
      dimensions.workspaceId,
      dimensions.agentId,
      dimensions.driver,
      dimensions.model,
      ...ledgerValues,
    );
    this.stmt(
      `INSERT INTO usage_session_state
         (session_id, input_tokens, output_tokens, cost_microusd, ${USAGE_LEDGER_V103_COLUMNS.join(", ")}, revision, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         input_tokens=input_tokens+excluded.input_tokens,
         output_tokens=output_tokens+excluded.output_tokens,
         cost_microusd=cost_microusd+excluded.cost_microusd,
         ${USAGE_LEDGER_ACCUMULATE_SQL},
         revision=revision+1, updated_at=excluded.updated_at`,
    ).run(sessionId, ...ledgerValues, occurredAt);
    // The per-session per-model ledger is what the session view's breakdown reads; it follows the
    // same delta so a session that switches models attributes each turn to the model that ran it.
    this.stmt(
      `INSERT INTO usage_session_models
         (session_id, model, driver, input_tokens, output_tokens, cost_microusd, ${USAGE_LEDGER_V103_COLUMNS.join(", ")}, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, model) DO UPDATE SET
         driver=excluded.driver,
         input_tokens=input_tokens+excluded.input_tokens,
         output_tokens=output_tokens+excluded.output_tokens,
         cost_microusd=cost_microusd+excluded.cost_microusd,
         ${USAGE_LEDGER_ACCUMULATE_SQL},
         updated_at=excluded.updated_at`,
    ).run(sessionId, dimensions.model, dimensions.driver, ...ledgerValues, occurredAt);
    if (updateSessionTotals) {
      this.stmt(
        `UPDATE sessions SET
             input_tokens=(SELECT input_tokens FROM usage_session_state WHERE session_id=?),
             output_tokens=(SELECT output_tokens FROM usage_session_state WHERE session_id=?),
             cost_usd=(SELECT (cost_microusd + cost_remainder_picousd / 1000000.0) / 1000000.0
                         FROM usage_session_state WHERE session_id=?),
             updated_at=? WHERE id=?`,
      ).run(sessionId, sessionId, sessionId, occurredAt, sessionId);
    }
  }

  private recordUsageEventInTransaction(
    sessionId: string,
    payload: SessionEventPayload,
    occurredAt: number,
    source?: { historyEpoch: number | null; runnerSeq: number },
  ): void {
    if (source) {
      let state = this.stmt(
        `SELECT runner_history_epoch, covered_through_seq FROM usage_session_state WHERE session_id=?`,
      ).get(sessionId) as { runner_history_epoch: number | null; covered_through_seq: number } | undefined;
      if (!state) {
        this.stmt(
          `INSERT INTO usage_session_state
             (session_id, input_tokens, output_tokens, cost_microusd, runner_history_epoch,
              covered_through_seq, revision, updated_at)
           VALUES (?, 0, 0, 0, ?, 0, 0, ?)`,
        ).run(sessionId, source.historyEpoch, occurredAt);
        state = { runner_history_epoch: source.historyEpoch, covered_through_seq: 0 };
      }
      if (state.runner_history_epoch !== source.historyEpoch) {
        if (source.historyEpoch === null) {
          // A legacy page has no generation proof. Preserve the known epoch and coverage instead
          // of treating a runner downgrade as evidence that history was replaced.
        } else if (state.runner_history_epoch === null) {
          // The first indexed epoch adopts legacy unknown history in place. Coverage remains valid,
          // and an uncovered event in that first known epoch must still contribute.
          this.stmt(
            `UPDATE usage_session_state SET runner_history_epoch=?, updated_at=? WHERE session_id=?`,
          ).run(source.historyEpoch, occurredAt, sessionId);
          state = { ...state, runner_history_epoch: source.historyEpoch };
        } else {
        // A snapshot normally establishes the new generation first. If skew violates that order,
        // advance coverage without charging a possibly replayed historical event; the next
        // authoritative snapshot contributes only any missing positive residual.
          this.stmt(
            `UPDATE usage_session_state SET runner_history_epoch=?, covered_through_seq=?, updated_at=?
             WHERE session_id=?`,
          ).run(source.historyEpoch, source.runnerSeq, occurredAt, sessionId);
          return;
        }
      }
      if (source.runnerSeq <= state.covered_through_seq) return;
    }
    if (payload.kind === "token_usage" && !payload.parentToolUseId) {
      const sessionDimensions = this.usageDimensions(sessionId);
      // A v104 runner names the model that produced the record; that beats the session's current
      // model, which may already have moved on by the time a late usage event lands.
      const eventModel = typeof payload.model === "string" ? payload.model.trim().slice(0, 128) : "";
      const dimensions = sessionDimensions && eventModel ? { ...sessionDimensions, model: eventModel } : sessionDimensions;
      const inputTokens = ControlPlaneDb.usageToken(payload.inputTokens);
      const outputTokens = ControlPlaneDb.usageToken(payload.outputTokens);
      const cachedInputTokens = ControlPlaneDb.usageToken(payload.cachedInputTokens);
      const cacheCreationTokens = ControlPlaneDb.usageToken(payload.cacheCreationInputTokens);
      const reasoningTokens = Math.min(outputTokens, ControlPlaneDb.usageToken(payload.reasoningOutputTokens));
      const buckets = {
        // Codex reports input inclusive of the cached portion; Anthropic reports the uncached part.
        uncachedInputTokens: dimensions && CODEX_DRIVERS.has(dimensions.driver)
          ? Math.max(0, inputTokens - cachedInputTokens)
          : inputTokens,
        cachedInputTokens,
        cacheCreationTokens,
        outputTokens,
      };
      const hasTokens = inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0 || cacheCreationTokens > 0;
      const reported = typeof payload.costUsd === "number" && Number.isFinite(payload.costUsd) && payload.costUsd >= 0
        ? payload.costUsd
        : null;
      const priced = priceUsage(this.usageRateTable, dimensions?.model, buckets, reported);
      const cost = ControlPlaneDb.usageCostParts(priced.costUsd);
      const remainderRow = this.stmt(
        "SELECT cost_remainder_picousd FROM usage_session_state WHERE session_id=?",
      ).get(sessionId) as { cost_remainder_picousd: number } | undefined;
      const combinedRemainder = (remainderRow?.cost_remainder_picousd ?? 0) + cost.remainderPicousd;
      const carryMicrousd = Math.round(combinedRemainder / 1_000_000);
      const counted = hasTokens || reported !== null;
      this.recordUsageDeltaInTransaction(sessionId, {
        inputTokens,
        costMicrousd: cost.microusd + carryMicrousd,
        ...buckets,
        reasoningTokens,
        cacheSavingsMicrousd: ControlPlaneDb.usageMicroUsd(priced.cacheSavingsUsd),
        providerReportedRecords: counted && priced.costSource === "providerReported" ? 1 : 0,
        modelPricedRecords: counted && priced.costSource === "modelPriced" ? 1 : 0,
        unpricedRecords: counted && priced.costSource === "unpriced" ? 1 : 0,
      }, occurredAt, true, dimensions);
      this.stmt(
        `INSERT INTO usage_session_state
           (session_id, input_tokens, output_tokens, cost_microusd, cost_remainder_picousd, revision, updated_at)
         VALUES (?, 0, 0, 0, ?, 0, ?)
         ON CONFLICT(session_id) DO UPDATE SET cost_remainder_picousd=excluded.cost_remainder_picousd`,
      ).run(sessionId, combinedRemainder - carryMicrousd * 1_000_000, occurredAt);
      this.stmt(
        `UPDATE sessions SET
           cost_usd=(SELECT (cost_microusd + cost_remainder_picousd / 1000000.0) / 1000000.0
                       FROM usage_session_state WHERE session_id=?),
           updated_at=? WHERE id=?`,
      ).run(sessionId, occurredAt, sessionId);
    }
    if (source) {
      this.stmt(
        `UPDATE usage_session_state SET covered_through_seq=?, updated_at=? WHERE session_id=?`,
      ).run(source.runnerSeq, occurredAt, sessionId);
    }
  }

  /** Reconcile a runner-authoritative cumulative snapshot. Identical, reordered, or stale lower
   * snapshots add nothing; only positive per-metric deltas enter the current observation bucket. */
  private reconcileUsageSnapshotInTransaction(sessionId: string, snapshot: SessionSnapshot, now: number): void {
    const row = this.stmt(
      `SELECT input_tokens, output_tokens, cost_microusd, cost_remainder_picousd,
              runner_history_epoch, covered_through_seq
         FROM usage_session_state WHERE session_id=?`,
    ).get(sessionId) as {
      input_tokens: number; output_tokens: number; cost_microusd: number; cost_remainder_picousd: number;
      runner_history_epoch: number | null; covered_through_seq: number;
    } | undefined;
    const current = row ?? { input_tokens: 0, output_tokens: 0, cost_microusd: 0, cost_remainder_picousd: 0 };
    const target = {
      inputTokens: ControlPlaneDb.usageToken(snapshot.tokensIn),
      outputTokens: ControlPlaneDb.usageToken(snapshot.tokensOut),
      costMicrousd: ControlPlaneDb.usageMicroUsd(snapshot.costUsd),
    };
    const parts = ControlPlaneDb.usageCostParts(snapshot.costUsd);
    const snapshotRemainder = (parts.microusd - target.costMicrousd) * 1_000_000 + parts.remainderPicousd;
    const adoptsSnapshotCost = target.costMicrousd > current.cost_microusd ||
      (target.costMicrousd === current.cost_microusd && snapshotRemainder >= current.cost_remainder_picousd);
    const residual = {
      inputTokens: Math.max(0, target.inputTokens - current.input_tokens),
      outputTokens: Math.max(0, target.outputTokens - current.output_tokens),
      costMicrousd: Math.max(0, target.costMicrousd - current.cost_microusd),
    };
    // A runner snapshot carries flat totals: no cache breakdown and, for opaque-billing providers,
    // no cost. When the provider's cumulative cost grew (even by a sub-micro fraction) that growth
    // is authoritative; otherwise a positive token residual is priced from the session's model so
    // the catch-up is not silently free, carrying its sub-micro remainder like the event path.
    const dimensions = this.usageDimensions(sessionId);
    const residualTokens = residual.inputTokens > 0 || residual.outputTokens > 0;
    const providerCostGrew = target.costMicrousd > current.cost_microusd ||
      (target.costMicrousd === current.cost_microusd && snapshotRemainder > current.cost_remainder_picousd);
    let pricedRemainderPicousd: number | null = null;
    const residualPriced = providerCostGrew
      ? { costSource: "providerReported" as const, costMicrousd: residual.costMicrousd }
      : residualTokens
        ? (() => {
            const priced = priceUsage(this.usageRateTable, dimensions?.model, {
              uncachedInputTokens: residual.inputTokens, cachedInputTokens: 0, cacheCreationTokens: 0,
              outputTokens: residual.outputTokens,
            }, null);
            const parts = ControlPlaneDb.usageCostParts(priced.costUsd);
            const combinedRemainder = current.cost_remainder_picousd + parts.remainderPicousd;
            const carryMicrousd = Math.round(combinedRemainder / 1_000_000);
            pricedRemainderPicousd = combinedRemainder - carryMicrousd * 1_000_000;
            return { costSource: priced.costSource, costMicrousd: parts.microusd + carryMicrousd };
          })()
        : null;
    const delta: UsageLedgerDelta = {
      inputTokens: residual.inputTokens,
      outputTokens: residual.outputTokens,
      costMicrousd: residualPriced?.costMicrousd ?? 0,
      uncachedInputTokens: residual.inputTokens,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      cacheSavingsMicrousd: 0,
      providerReportedRecords: residualPriced?.costSource === "providerReported" ? 1 : 0,
      modelPricedRecords: residualPriced?.costSource === "modelPriced" ? 1 : 0,
      unpricedRecords: residualPriced?.costSource === "unpriced" ? 1 : 0,
    };
    if (!row) {
      this.stmt(
        `INSERT INTO usage_session_state
           (session_id, input_tokens, output_tokens, cost_microusd, runner_history_epoch,
            covered_through_seq, revision, updated_at)
         VALUES (?, 0, 0, 0, ?, 0, 0, ?)`,
      ).run(sessionId, snapshot.historyEpoch ?? null, now);
    }
    // A cumulative snapshot tells us the amount, not when its unseen prefix accrued. Attribute the
    // positive catch-up at observation time instead of fabricating historical precision.
    this.recordUsageDeltaInTransaction(sessionId, delta, now, false, dimensions);
    if (pricedRemainderPicousd !== null) {
      this.stmt("UPDATE usage_session_state SET cost_remainder_picousd=? WHERE session_id=?")
        .run(pricedRemainderPicousd, sessionId);
    } else if (adoptsSnapshotCost) {
      // Preserve the authoritative fractional baseline around the rounded micro-USD watermark so
      // later sub-micro events can cross the next rounding boundary exactly once.
      this.stmt("UPDATE usage_session_state SET cost_remainder_picousd=? WHERE session_id=?")
        .run(snapshotRemainder, sessionId);
    }
    const nextCovered = row?.runner_history_epoch === (snapshot.historyEpoch ?? null)
      ? Math.max(row.covered_through_seq, snapshot.seq)
      : snapshot.seq;
    this.stmt(
      `UPDATE usage_session_state SET runner_history_epoch=?, covered_through_seq=?, updated_at=?
       WHERE session_id=?`,
    ).run(snapshot.historyEpoch ?? null, nextCovered, now, sessionId);
    const settled = this.stmt(
      `SELECT input_tokens, output_tokens, cost_microusd, cost_remainder_picousd
         FROM usage_session_state WHERE session_id=?`,
    ).get(sessionId) as {
      input_tokens: number; output_tokens: number; cost_microusd: number; cost_remainder_picousd: number;
    };
    this.stmt(
      `UPDATE sessions SET input_tokens=MAX(input_tokens, ?), output_tokens=MAX(output_tokens, ?),
         cost_usd=MAX(cost_usd, (? + ? / 1000000.0) / 1000000.0) WHERE id=?`,
    ).run(settled.input_tokens, settled.output_tokens, settled.cost_microusd, settled.cost_remainder_picousd, sessionId);
  }

  /** A session's usage split by the model that produced it, most processed tokens first. The
   * session totals come from the same ledger so the two views agree. */
  sessionUsageByModel(sessionId: string): { totals: UsageAmount; byModel: SessionModelUsage[] } {
    const measure = `input_tokens, output_tokens, cost_microusd, ${USAGE_LEDGER_V103_COLUMNS.join(", ")}`;
    const processed = `CASE WHEN driver IN ('codex', 'codex-app-server')
                         THEN input_tokens + cache_creation_tokens + output_tokens
                         ELSE input_tokens + cached_input_tokens + cache_creation_tokens + output_tokens END`;
    type Row = {
      model: string; input_tokens: number; output_tokens: number; cost_microusd: number;
      uncached_input_tokens: number; cached_input_tokens: number; cache_creation_tokens: number; reasoning_tokens: number;
      cache_savings_microusd: number; provider_reported_records: number; model_priced_records: number; unpriced_records: number;
      processed_tokens: number;
    };
    const rows = this.stmt(
      `SELECT model, ${measure}, ${processed} AS processed_tokens FROM usage_session_models
        WHERE session_id=? ORDER BY processed_tokens DESC, cost_microusd DESC, model ASC`,
    ).all(sessionId) as unknown as Row[];
    const amount = (row: Omit<Row, "model">): UsageAmount => ({
      inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), costUsd: Number(row.cost_microusd) / 1_000_000,
      uncachedInputTokens: Number(row.uncached_input_tokens), cachedInputTokens: Number(row.cached_input_tokens),
      cacheCreationTokens: Number(row.cache_creation_tokens), reasoningTokens: Number(row.reasoning_tokens),
      cacheSavingsUsd: Number(row.cache_savings_microusd) / 1_000_000,
      costSource: resolveCostSource({
        providerReported: Number(row.provider_reported_records), modelPriced: Number(row.model_priced_records), unpriced: Number(row.unpriced_records),
      }),
      unpricedRecords: Number(row.unpriced_records),
      processedTokens: Number(row.processed_tokens),
    });
    const byModel = rows.map((row) => ({ model: row.model === "" ? "unknown" : row.model, ...amount(row) }));
    const totals = rows.reduce<Omit<Row, "model">>((sum, row) => ({
      input_tokens: sum.input_tokens + Number(row.input_tokens), output_tokens: sum.output_tokens + Number(row.output_tokens),
      cost_microusd: sum.cost_microusd + Number(row.cost_microusd),
      uncached_input_tokens: sum.uncached_input_tokens + Number(row.uncached_input_tokens),
      cached_input_tokens: sum.cached_input_tokens + Number(row.cached_input_tokens),
      cache_creation_tokens: sum.cache_creation_tokens + Number(row.cache_creation_tokens),
      reasoning_tokens: sum.reasoning_tokens + Number(row.reasoning_tokens),
      cache_savings_microusd: sum.cache_savings_microusd + Number(row.cache_savings_microusd),
      provider_reported_records: sum.provider_reported_records + Number(row.provider_reported_records),
      model_priced_records: sum.model_priced_records + Number(row.model_priced_records),
      unpriced_records: sum.unpriced_records + Number(row.unpriced_records),
      processed_tokens: sum.processed_tokens + Number(row.processed_tokens),
    }), {
      input_tokens: 0, output_tokens: 0, cost_microusd: 0, uncached_input_tokens: 0, cached_input_tokens: 0,
      cache_creation_tokens: 0, reasoning_tokens: 0, cache_savings_microusd: 0, provider_reported_records: 0,
      model_priced_records: 0, unpriced_records: 0, processed_tokens: 0,
    });
    return { totals: amount(totals), byModel };
  }

  queryUsageAggregation(principal: AuthPrincipal, query: UsageAggregationQuery): UsageAggregationResponse {
    if (principal.kind !== "human") throw new Error("usage aggregation requires a human principal");
    const policy = this.ensureUsageRetentionPolicy(principal.organizationId);
    const isAdministrator = principal.role === "owner" || principal.role === "admin";
    const measureColumns = `input_tokens, output_tokens, cost_microusd, ${USAGE_LEDGER_V103_COLUMNS.join(", ")}`;
    const sourceFor = (granularity: UsageAggregationGranularity, whereSql: string) => granularity === "hour"
      ? `SELECT bucket_ts, organization_id, owner_kind, owner_id, runner_id, workspace_id, agent_id,
                driver, model, ${measureColumns}
           FROM usage_hourly u WHERE ${whereSql}`
      : `SELECT bucket_ts, organization_id, owner_kind, owner_id, runner_id, workspace_id, agent_id,
                driver, model, ${measureColumns}
           FROM usage_daily u WHERE ${whereSql}
         UNION ALL
         SELECT (bucket_ts / 86400000) * 86400000, organization_id, owner_kind, owner_id,
                 runner_id, workspace_id, agent_id, driver, model, ${measureColumns}
           FROM usage_hourly u WHERE ${whereSql}`;
    const whereFor = (since: number) => {
      const clauses = ["u.organization_id=?", "u.bucket_ts>=?", "u.bucket_ts<?"];
      const params: Array<string | number> = [principal.organizationId, since, query.through];
      if (!isAdministrator) {
        clauses.push(`(
          (u.owner_kind='organization' AND u.owner_id=u.organization_id) OR
          (u.owner_kind='user' AND u.owner_id=?) OR
          (u.owner_kind='team' AND EXISTS (
             SELECT 1 FROM identity_teams team
             JOIN identity_team_members member ON member.team_id=team.team_id
             WHERE team.team_id=u.owner_id AND team.organization_id=u.organization_id AND member.user_id=?
          ))
        )`);
        params.push(principal.userId, principal.userId);
      }
      for (const [column, value] of [
        ["runner_id", query.runnerId],
        ["workspace_id", query.workspaceId],
        ["agent_id", query.agentId],
        ["driver", query.driver],
      ] as const) {
        if (value) {
          clauses.push(`u.${column}=?`);
          params.push(value);
        }
      }
      return { sql: clauses.join(" AND "), params };
    };

    // Once hours have been rolled up, expanding hourly retention cannot recreate them. If any
    // authorized rolled bucket overlaps the requested window, serve a complete daily result rather
    // than silently undercounting with the remaining hourly rows.
    const daySince = Math.floor(query.since / 86_400_000) * 86_400_000;
    const rolledWhere = whereFor(daySince);
    const hasRolledRows = query.granularity === "hour" && this.stmt(
      `SELECT 1 FROM usage_daily u WHERE ${rolledWhere.sql} LIMIT 1`,
    ).get(...rolledWhere.params) !== undefined;
    const granularity: UsageAggregationGranularity = hasRolledRows ? "day" : query.granularity;
    const since = granularity === "day" ? daySince : query.since;
    const where = whereFor(since);
    const source = sourceFor(granularity, where.sql);
    const sourceParams = granularity === "day" ? [...where.params, ...where.params] : where.params;
    const withSource = `WITH usage_source AS MATERIALIZED (${source})`;
    type AggregateRow = {
      input_tokens: number | null; output_tokens: number | null; cost_microusd: number | null;
      uncached_input_tokens: number | null; cached_input_tokens: number | null;
      cache_creation_tokens: number | null; reasoning_tokens: number | null;
      cache_savings_microusd: number | null; provider_reported_records: number | null;
      model_priced_records: number | null; unpriced_records: number | null;
      processed_tokens: number | null;
    };
    const amountFrom = (row: AggregateRow | undefined): UsageAmount => ({
      inputTokens: Number(row?.input_tokens ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0),
      costUsd: Number(row?.cost_microusd ?? 0) / 1_000_000,
      uncachedInputTokens: Number(row?.uncached_input_tokens ?? 0),
      cachedInputTokens: Number(row?.cached_input_tokens ?? 0),
      cacheCreationTokens: Number(row?.cache_creation_tokens ?? 0),
      reasoningTokens: Number(row?.reasoning_tokens ?? 0),
      cacheSavingsUsd: Number(row?.cache_savings_microusd ?? 0) / 1_000_000,
      costSource: resolveCostSource({
        providerReported: Number(row?.provider_reported_records ?? 0),
        modelPriced: Number(row?.model_priced_records ?? 0),
        unpriced: Number(row?.unpriced_records ?? 0),
      }),
      unpricedRecords: Number(row?.unpriced_records ?? 0),
      processedTokens: Number(row?.processed_tokens ?? 0),
    });
    // Processed tokens are derived PER ROW, where the driver is known, so the figure is additive:
    // Codex reports input inclusive of its cache reads, Anthropic reports the uncached part only.
    // Summing a driver-aware expression is exact at every grouping level; deriving it from summed
    // buckets after the fact is not, because a mixed aggregate cannot tell the two apart.
    const processedSql = `SUM(CASE WHEN driver IN ('codex', 'codex-app-server')
                               THEN input_tokens + cache_creation_tokens + output_tokens
                               ELSE input_tokens + cached_input_tokens + cache_creation_tokens + output_tokens END) AS processed_tokens`;
    const sums = `SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                  SUM(cost_microusd) AS cost_microusd,
                  ${USAGE_LEDGER_V103_COLUMNS.map((column) => `SUM(${column}) AS ${column}`).join(", ")},
                  ${processedSql}`;
    const measures = `input_tokens, output_tokens, cost_microusd, ${USAGE_LEDGER_V103_COLUMNS.join(", ")}, processed_tokens`;
    const inputCount = this.stmt(
      `SELECT COUNT(*) AS count FROM (SELECT 1 FROM (${source}) AS bounded_source LIMIT 100001)`,
    ).get(...sourceParams) as { count: number };
    if (inputCount.count > 100_000) {
      throw new RangeError("usage query is too broad; shorten the range or add runner, workspace, agent, or driver filters");
    }
    const agentKey = "CASE WHEN agent_id='' THEN 'unassigned' ELSE agent_id || CASE WHEN model='' THEN '' ELSE ' / ' || model END END";
    const modelKey = "CASE WHEN model='' THEN 'unknown' ELSE model END";
    const aggregateRows = this.stmt(
      `${withSource},
       totals AS (
         SELECT ${sums} FROM usage_source
       ),
       series_rows AS (
         SELECT bucket_ts, ${sums}
           FROM usage_source GROUP BY bucket_ts ORDER BY bucket_ts DESC LIMIT 4001
       ),
       series_driver_rows AS (
         SELECT bucket_ts, driver AS key, ${sums}
           FROM usage_source GROUP BY bucket_ts, driver ORDER BY bucket_ts DESC, driver ASC LIMIT 16004
       ),
       driver_rows AS (
         SELECT driver AS key, ${sums}
           FROM usage_source GROUP BY driver
          ORDER BY SUM(cost_microusd) DESC, (SUM(input_tokens) + SUM(output_tokens)) DESC, key ASC LIMIT 20
       ),
       agent_rows AS (
         SELECT ${agentKey} AS key, ${sums}
           FROM usage_source GROUP BY key
          ORDER BY SUM(cost_microusd) DESC, (SUM(input_tokens) + SUM(output_tokens)) DESC, key ASC LIMIT 20
       ),
       runner_rows AS (
         SELECT runner_id AS key, ${sums}
           FROM usage_source GROUP BY runner_id
          ORDER BY SUM(cost_microusd) DESC, (SUM(input_tokens) + SUM(output_tokens)) DESC, key ASC LIMIT 20
       ),
       model_rows AS (
         SELECT ${modelKey} AS key, ${sums}
           FROM usage_source GROUP BY key
          ORDER BY SUM(cost_microusd) DESC, (SUM(input_tokens) + SUM(output_tokens)) DESC, key ASC LIMIT 20
       )
       SELECT 'total' AS kind, '' AS key, NULL AS bucket_ts, ${measures} FROM totals
       UNION ALL SELECT 'series', '', bucket_ts, ${measures} FROM series_rows
       UNION ALL SELECT 'series_driver', key, bucket_ts, ${measures} FROM series_driver_rows
       UNION ALL SELECT 'driver', key, NULL, ${measures} FROM driver_rows
       UNION ALL SELECT 'agent', key, NULL, ${measures} FROM agent_rows
       UNION ALL SELECT 'runner', key, NULL, ${measures} FROM runner_rows
       UNION ALL SELECT 'model', key, NULL, ${measures} FROM model_rows`,
    ).all(...sourceParams) as unknown as Array<AggregateRow & {
      kind: "total" | "series" | "series_driver" | "driver" | "agent" | "runner" | "model";
      key: string;
      bucket_ts: number | null;
    }>;
    const totals = amountFrom(aggregateRows.find((row) => row.kind === "total"));
    const seriesRows = aggregateRows.filter((row) => row.kind === "series" && row.bucket_ts !== null);
    if (seriesRows.length > 4000) throw new RangeError("usage query exceeds the supported bucket cardinality");
    const series = seriesRows
      .map((row) => ({ bucketTs: row.bucket_ts!, ...amountFrom(row) }))
      .sort((a, b) => b.bucketTs - a.bucketTs);
    const seriesByDriver = aggregateRows
      .filter((row) => row.kind === "series_driver" && row.bucket_ts !== null)
      .map((row) => ({ bucketTs: row.bucket_ts!, driver: row.key as AgentDriverKind, ...amountFrom(row) }))
      .sort((a, b) => b.bucketTs - a.bucketTs || a.driver.localeCompare(b.driver));
    const totalRow = aggregateRows.find((row) => row.kind === "total");
    const measureKeys = [
      "input_tokens", "output_tokens", "cost_microusd", ...USAGE_LEDGER_V103_COLUMNS, "processed_tokens",
    ] as const satisfies ReadonlyArray<keyof AggregateRow>;
    const breakdown = (kind: "driver" | "agent" | "runner" | "model") => {
      const rows = aggregateRows.filter((row) => row.kind === kind);
      const result = rows.map((row) => ({ key: row.key, ...amountFrom(row) }));
      // Whatever the top-20 cut left out is reported as one honest remainder row.
      const other = Object.fromEntries(measureKeys.map((column) => [
        column,
        Number(totalRow?.[column] ?? 0) - rows.reduce((sum, row) => sum + Number(row[column] ?? 0), 0),
      ])) as AggregateRow;
      if (measureKeys.some((column) => Number(other[column] ?? 0) !== 0)) {
        result.push({ key: "Other", ...amountFrom(other) });
      }
      return result;
    };
    return {
      granularity,
      since,
      through: query.through,
      retention: policy,
      canManageRetention: principal.kind === "human" && (principal.role === "owner" || principal.role === "admin"),
      privacy: "content-free aggregates only; no session ids, prompts, paths, tool inputs, event bodies, environment values, or auth data",
      totals,
      series,
      seriesByDriver,
      byDriver: breakdown("driver"),
      byAgent: breakdown("agent"),
      byRunner: breakdown("runner"),
      byModel: breakdown("model"),
    };
  }

  private subscriptionUsageSnapshotForStorage(
    snapshot: SubscriptionUsageSnapshot,
    prior: SubscriptionUsageSnapshot | undefined,
  ): SubscriptionUsageSnapshot {
    if (snapshot.state !== "unavailable" || snapshot.buckets.length > 0 ||
        !Array.isArray(prior?.buckets) || prior.buckets.length === 0 ||
        prior.provider !== snapshot.provider || prior.agentId !== snapshot.agentId) {
      return snapshot;
    }
    return {
      ...prior,
      detail: snapshot.detail ?? "The latest provider refresh was unavailable; showing the last provider snapshot.",
    };
  }

  private writeSubscriptionUsageSnapshot(snapshot: SubscriptionUsageSnapshot, now: number): void {
    this.stmt(
      `INSERT INTO subscription_usage_snapshots
         (runner_id, source_id, agent_id, provider, snapshot, fetched_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(runner_id, source_id) DO UPDATE SET
         agent_id=excluded.agent_id,
         provider=excluded.provider,
         snapshot=excluded.snapshot,
         fetched_at=excluded.fetched_at,
         updated_at=excluded.updated_at`,
    ).run(
      snapshot.runnerId,
      snapshot.sourceId,
      snapshot.agentId,
      snapshot.provider,
      JSON.stringify(snapshot),
      snapshot.fetchedAt,
      now,
    );
  }

  upsertSubscriptionUsageSnapshot(snapshot: SubscriptionUsageSnapshot, now = Date.now()): void {
    const row = this.stmt(
      "SELECT snapshot FROM subscription_usage_snapshots WHERE runner_id=? AND source_id=?",
    ).get(snapshot.runnerId, snapshot.sourceId) as { snapshot: string } | undefined;
    let prior: SubscriptionUsageSnapshot | undefined;
    try {
      prior = row ? JSON.parse(row.snapshot) as SubscriptionUsageSnapshot : undefined;
    } catch {
      prior = undefined;
    }
    this.writeSubscriptionUsageSnapshot(this.subscriptionUsageSnapshotForStorage(snapshot, prior), now);
  }

  /** Replace the inventory for one authenticated runner without affecting another runner's data. */
  replaceSubscriptionUsageSnapshots(
    runnerId: string,
    snapshots: SubscriptionUsageSnapshot[],
    now = Date.now(),
  ): void {
    this.atomic(() => {
      const existingRows = this.stmt(
        "SELECT source_id, snapshot FROM subscription_usage_snapshots WHERE runner_id=?",
      ).all(runnerId) as unknown as Array<{ source_id: string; snapshot: string }>;
      const existing = new Map<string, SubscriptionUsageSnapshot>();
      for (const row of existingRows) {
        try {
          existing.set(row.source_id, JSON.parse(row.snapshot) as SubscriptionUsageSnapshot);
        } catch {
          // A corrupt row is intentionally replaced, never retained as last-known state.
        }
      }
      this.stmt("DELETE FROM subscription_usage_snapshots WHERE runner_id=?").run(runnerId);
      for (const snapshot of snapshots) {
        if (snapshot.runnerId !== runnerId) throw new Error("subscription usage inventory runner mismatch");
        this.writeSubscriptionUsageSnapshot(
          this.subscriptionUsageSnapshotForStorage(snapshot, existing.get(snapshot.sourceId)),
          now,
        );
      }
    });
  }

  /** Principal-scoped provider allowance projection. It is deliberately separate from historical
   * token/cost aggregation: these snapshots are account-level provider state, not session usage. */
  subscriptionUsageForPrincipal(
    principal: AuthPrincipal,
    now = Date.now(),
    staleAfterMs = 10 * 60_000,
  ): SubscriptionUsageResponse {
    if (principal.kind !== "human") throw new Error("subscription usage requires a human principal");
    const runners = this.listRunnersForPrincipal(principal);
    const visibleRunnerIds = new Set(runners.map((runner) => runner.runnerId));
    const rows = this.stmt(
      `SELECT runner_id, source_id, snapshot
       FROM subscription_usage_snapshots ORDER BY runner_id, provider, agent_id, source_id`,
    ).all() as unknown as Array<{ runner_id: string; source_id: string; snapshot: string }>;
    const stored = new Map<string, SubscriptionUsageSnapshot>();
    for (const row of rows) {
      if (!visibleRunnerIds.has(row.runner_id)) continue;
      try {
        const snapshot = JSON.parse(row.snapshot) as SubscriptionUsageSnapshot;
        if (snapshot && typeof snapshot === "object" &&
            snapshot.runnerId === row.runner_id && snapshot.sourceId === row.source_id &&
            Array.isArray(snapshot.buckets)) {
          stored.set(`${row.runner_id}:${row.source_id}`, snapshot);
        }
      } catch {
        // Ignore a corrupt local row. The next authoritative runner inventory replaces it.
      }
    }

    const sources: SubscriptionUsageResponse["sources"] = [];
    for (const runner of runners) {
      for (const agent of runner.agents) {
        const provider = agent.driver === "codex-app-server"
          ? "codex" as const
          : agent.driver === "claude-code"
            ? "claude" as const
            : null;
        if (!provider || agent.id === "conductor") continue;
        const context = agent.context?.kind === "wsl" ? `wsl:${agent.context.distro}` : "native";
        const sourceId = createHash("sha256")
          .update(JSON.stringify({ runnerId: runner.runnerId, agentId: agent.id, provider, context }))
          .digest("hex")
          .slice(0, 32);
        const persisted = stored.get(`${runner.runnerId}:${sourceId}`);
        const fetchedAt = persisted?.fetchedAt ?? runner.lastSeen ?? now;
        const snapshot: SubscriptionUsageSnapshot = persisted ?? {
          sourceId,
          runnerId: runner.runnerId,
          agentId: agent.id,
          provider,
          state: runnerSupportsProtocol(runner.protocolVersion, "subscriptionUsage")
            ? "unavailable"
            : "unsupported",
          detail: runnerSupportsProtocol(runner.protocolVersion, "subscriptionUsage")
            ? "This provider has not reported subscription usage yet."
            : "Update this runner to view subscription usage.",
          fetchedAt,
          buckets: [],
        };
        sources.push({
          ...snapshot,
          runnerName: runner.displayName ?? runner.hostname ?? runner.runnerId,
          agentName: agent.name,
          runnerStatus: runner.status,
          freshness: runner.status === "offline" || now - fetchedAt > staleAfterMs ? "stale" : "fresh",
        });
      }
    }
    sources.sort((left, right) =>
      left.provider.localeCompare(right.provider) ||
      left.runnerName.localeCompare(right.runnerName) ||
      left.agentName.localeCompare(right.agentName));
    return { sources, staleAfterMs, generatedAt: now };
  }

  getWorkspacePath(runnerId: string, workspaceId: string): string | null {
    const row = this.stmt("SELECT path FROM workspaces WHERE runner_id=? AND id=?")
      .get(runnerId, workspaceId) as unknown as { path: string } | undefined;
    if (row) return row.path;
    // Fall back to workspace definitions created by the legacy compatibility adapter.
    const extra = this.stmt("SELECT path FROM workspace_extras WHERE runner_id=? AND id=?")
      .get(runnerId, workspaceId) as unknown as { path: string } | undefined;
    return extra ? extra.path : null;
  }

  /** A runner's configured workspaces for exact cwd-to-workspace matching. */
  listRunnerWorkspaces(runnerId: string): { id: string; path: string }[] {
    return this.stmt("SELECT id, path FROM workspaces WHERE runner_id=? ORDER BY id")
      .all(runnerId) as unknown as { id: string; path: string }[];
  }

  /** Every current Workspace identity known to the control plane, reported or CP-managed. */
  listKnownRunnerWorkspaces(runnerId: string): { id: string; path: string }[] {
    const reported = this.listRunnerWorkspaces(runnerId);
    const managed = this.stmt("SELECT id, path FROM workspace_extras WHERE runner_id=? ORDER BY id")
      .all(runnerId) as unknown as Array<{ id: string; path: string }>;
    return [...new Map([...reported, ...managed].map((workspace) => [workspace.id, workspace])).values()];
  }

  /** The ad-hoc browsed directory a session was created in (null for workspace-backed sessions). */
  getAdHocWorkspacePath(id: string): string | null {
    const row = this.stmt("SELECT workspace_path FROM sessions WHERE id=?").get(id) as
      | { workspace_path: string | null }
      | undefined;
    return row?.workspace_path ?? null;
  }

  getAcpSessionContext(id: string): AcpSessionContextConfig | undefined {
    const row = this.stmt("SELECT acp_session_context FROM sessions WHERE id=?").get(id) as
      | { acp_session_context: string | null }
      | undefined;
    return parseJson<AcpSessionContextConfig>(row?.acp_session_context ?? null) ?? undefined;
  }

  getExecutionHandoffRequest(id: string): ExecutionHandoffRequest | undefined {
    const row = this.stmt("SELECT execution_handoff_request FROM sessions WHERE id=?").get(id) as
      | { execution_handoff_request: string | null }
      | undefined;
    if (!row?.execution_handoff_request) return undefined;
    const parsed = parseJson<ExecutionHandoffRequest>(row.execution_handoff_request);
    if (!parsed) throw new Error("stored cloud handoff request is invalid");
    return validateExecutionHandoffRequest(parsed);
  }

  /* ----------------------------- Sessions -------------------------------- */

  /** The scope a new session will carry: the explicit one, else what the workspace or runner
   * confers. Exposed so admission checks can look at the owner BEFORE the session exists. */
  effectiveSessionScope(runnerId: string, workspaceId: string | null, explicit?: ResourceScope): ResourceScope | null {
    if (explicit) return explicit;
    try {
      return this.inheritedSessionScope(runnerId, workspaceId);
    } catch {
      return null;
    }
  }

  private inheritedSessionScope(runnerId: string, workspaceId: string | null): ResourceScope {
    const runnerScope = this.runnerScope(runnerId);
    const scope = workspaceId ? this.workspaceScope(runnerId, workspaceId) ?? runnerScope : runnerScope;
    if (!scope) throw new Error(`ownership is unavailable for runner '${runnerId}'`);
    return scope;
  }

  private insertSessionOwnership(sessionId: string, scope: ResourceScope, now: number): void {
    const ownerId = scope.owner.kind === "organization" ? scope.owner.organizationId
      : scope.owner.kind === "user" ? scope.owner.userId : scope.owner.teamId;
    this.stmt(
      `INSERT INTO session_ownership
       (session_id, organization_id, owner_kind, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, scope.organizationId, scope.owner.kind, ownerId, now, now);
  }

  createSession(input: NewSessionInput): SessionView {
    const scope = input.scope ?? this.inheritedSessionScope(input.runnerId, input.workspaceId);
    const inferredLocation = input.workspaceId ? this.findProjectLocation(input.runnerId, input.workspaceId) : null;
    let projectLocationId = input.projectLocationId !== undefined
      ? input.projectLocationId
      : input.projectId !== undefined ? null : inferredLocation?.id ?? null;
    let projectId = input.projectId !== undefined
      ? input.projectId
      : projectLocationId ? this.projectLocation(projectLocationId)?.projectId ?? null : inferredLocation?.projectId ?? null;
    if (projectId) {
      const projectScope = this.projectScope(projectId);
      if (!projectScope || !this.scopeAudienceContainedWithMembership(scope, projectScope)) {
        if (input.projectId !== undefined || input.projectLocationId !== undefined) {
          throw new Error("session access is broader than project access");
        }
        projectId = null;
        projectLocationId = null;
      }
    }
    if (projectLocationId) {
      const location = this.projectLocation(projectLocationId);
      if (!location || location.projectId !== projectId) throw new Error("session project location does not belong to project");
      if (location.availability === "runner_removed") throw new Error("session project location is no longer available");
      if (location.runnerId !== input.runnerId || location.workspaceId !== input.workspaceId) {
        throw new Error("session project location does not match runner/workspace");
      }
    }
    if (projectId && !this.getProject(projectId)) throw new Error("session project does not exist");
    this.db.exec("BEGIN");
    try {
      this.stmt(
         `INSERT INTO sessions
           (id, runner_id, workspace_id, project_id, project_location_id, agent_id, title, title_source, status, run_id, use_worktree, archived,
             driver, model, effort, permission_mode, workspace_path, acp_session_context, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.runnerId,
        input.workspaceId,
        projectId,
        projectLocationId,
        input.agentId,
        input.title,
        input.titleSource ?? "generated",
        input.runId ?? null,
        input.useWorktree ? 1 : 0,
        input.archived ? 1 : 0,
        input.driver,
        input.config.model ?? null,
        input.config.effort ?? null,
        input.config.permissionMode ?? null,
        input.workspacePath ?? null,
        input.acpSessionContext ? JSON.stringify(input.acpSessionContext) : null,
        input.now,
        input.now,
      );
      if (input.executionTarget) {
        this.stmt("UPDATE sessions SET execution_target=? WHERE id=?")
          .run(JSON.stringify(input.executionTarget), input.id);
      }
      const handoffRequest = validateExecutionHandoffRequest(input.executionHandoffRequest);
      if (handoffRequest) {
        this.stmt("UPDATE sessions SET execution_handoff_request=? WHERE id=?")
          .run(JSON.stringify(handoffRequest), input.id);
      }
      this.insertSessionOwnership(input.id, scope, input.now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getSession(input.id)!;
  }

  /* ---- Phase 2: hydrate a session the runner (box) owns into the CP cache ---- */

  /** Insert a session from a runner snapshot (the box is the source of truth). */
  createSessionFromSnapshot(
    snap: SessionSnapshot,
    runnerId: string,
    now: number,
    explicitScope?: ResourceScope,
    explicitProject?: { projectId: string | null; projectLocationId: string | null },
    fork?: { sourceSessionId: string; sourceTurn: number },
  ): SessionView {
    // An adopted session's snapshot carries no workspaceId (CLI sessions know nothing of our
    // workspaces) — resolve the exact workspace whose path contains its cwd, then infer the stable
    // Project Location. This covers a session adopted from another dashboard and the
    // delete-then-rehydrate path. Non-adopted null stays null: an ad-hoc browsed directory was a
    // deliberate "no workspace" choice.
    const importedLocation = snap.adopted && snap.workspacePath
      ? this.resolveImportedSessionLocation(runnerId, snap.workspacePath)
      : null;
    const workspaceId = snap.workspaceId ?? importedLocation?.workspaceId ?? null;
    const scope = explicitScope ?? this.inheritedSessionScope(runnerId, workspaceId);
    const inferredProjectLocation = importedLocation?.workspaceId === workspaceId
      ? importedLocation.projectLocation
      : workspaceId ? this.findProjectLocation(runnerId, workspaceId) : null;
    const inferredProject = inferredProjectLocation && this.projectScope(inferredProjectLocation.projectId) &&
      this.scopeAudienceContainedWithMembership(scope, this.projectScope(inferredProjectLocation.projectId)!)
      ? inferredProjectLocation
      : null;
    const projectId = explicitProject ? explicitProject.projectId : inferredProject?.projectId ?? null;
    const projectLocationId = explicitProject ? explicitProject.projectLocationId : inferredProject?.id ?? null;
    if (projectId === null && projectLocationId !== null) throw new Error("a project location requires a project");
    if (projectId !== null) {
      const projectScope = this.projectScope(projectId);
      if (!projectScope || !this.scopeAudienceContainedWithMembership(scope, projectScope)) {
        throw new Error("session access is broader than project access");
      }
    }
    if (projectLocationId !== null) {
      const location = this.projectLocation(projectLocationId);
      if (!location || location.projectId !== projectId) throw new Error("project location does not belong to project");
      if (location.availability === "runner_removed") throw new Error("project location is no longer available");
      if (location.runnerId !== runnerId || location.workspaceId !== workspaceId) {
        throw new Error("project location does not match session runner/workspace");
      }
    }
    if (fork && (!fork.sourceSessionId || fork.sourceSessionId === snap.id ||
        !Number.isSafeInteger(fork.sourceTurn) || fork.sourceTurn < 1)) {
      throw new Error("session fork provenance is invalid");
    }
    this.db.exec("BEGIN");
    try {
      this.stmt(
         `INSERT INTO sessions
           (id, runner_id, workspace_id, project_id, project_location_id, agent_id, title, title_source, provider_updated_at, background_work_state, background_work_tracking, status, use_worktree, worktree_path, workspace_path, archived,
             driver, model, resolved_model, effort, permission_mode, agent_capabilities, preview, pending_approval, input_tokens, output_tokens, context_tokens_used, context_window, cost_usd,
              acp_session_context, created_at, updated_at, last_event_at, hydrated_seq, runner_history_epoch, runner_history_tail_seq, adopted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        snap.id,
        runnerId,
        workspaceId,
        projectId,
        projectLocationId,
        snap.agentId,
        snap.title,
        snap.titleSource ?? "generated",
        snap.providerUpdatedAt ?? null,
        backgroundWorkStateForStorage(snap.backgroundWorkState),
        snap.backgroundWorkTracking ?? null,
        snap.status,
        snap.useWorktree ? 1 : 0,
        snap.worktreePath,
        snap.workspacePath ?? null,
        snap.driver,
        snap.config.model ?? null,
        snap.resolvedModel ?? null,
        snap.config.effort ?? null,
        snap.config.permissionMode ?? null,
        snap.agentCapabilities ? JSON.stringify(snap.agentCapabilities) : null,
        snap.preview,
        snap.pendingApproval ? JSON.stringify(snap.pendingApproval) : null,
        snap.tokensIn,
        snap.tokensOut,
        snap.contextTokensUsed ?? null,
        snap.contextWindow ?? null,
        snap.costUsd,
        snap.acpSessionContext ? JSON.stringify(snap.acpSessionContext) : null,
        snap.createdAt,
        snap.updatedAt,
        snap.updatedAt,
        snap.historyEpoch ?? null,
        snap.seq,
        snap.adopted ? 1 : 0,
      );
      if (snap.executionTarget) {
        this.stmt("UPDATE sessions SET execution_target=? WHERE id=?")
          .run(JSON.stringify(snap.executionTarget), snap.id);
      }
      if (snap.worktrees) {
        this.stmt("UPDATE sessions SET worktrees=? WHERE id=?")
          .run(JSON.stringify(snap.worktrees), snap.id);
      }
      const handoff = validateExecutionHandoffReceipt(snap.executionHandoff, snap.executionTarget);
      if (handoff) {
        this.stmt("UPDATE sessions SET execution_handoff_request=?, execution_handoff=? WHERE id=?")
          .run(JSON.stringify({
            ...(handoff.sourceSessionId ? { sourceSessionId: handoff.sourceSessionId } : {}),
            artifacts: handoff.artifacts,
          }), JSON.stringify(handoff), snap.id);
      }
      this.insertSessionOwnership(snap.id, scope, now);
      if (fork) {
        this.stmt(
          `INSERT INTO session_forks (target_session_id, source_session_id, source_turn, created_at)
           VALUES (?, ?, ?, ?)`,
        ).run(snap.id, fork.sourceSessionId, fork.sourceTurn, now);
      }
      this.reconcileUsageSnapshotInTransaction(snap.id, snap, now);
      this.upsertManagedBackgroundJobsInTransaction(snap.id, snap.backgroundJobs, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.maybeMaintainUsageAggregation();
    return this.getSession(snap.id)!;
  }

  /** Update an existing session's runner-authoritative fields from a snapshot. Keeps the CP-only
   * board_column + archived (the user's view state) and a CP-only cost-budget pause. workspace_id
   * is normally retained as CP-owned grouping; the sole exception is a legacy adopted placeholder
   * whose first authoritative runner snapshot supplies the cwd that was intentionally not trusted. */
  updateSessionFromSnapshot(id: string, snap: SessionSnapshot, now: number): void {
    // Reconcile the runner-owned generation before applying its metadata. A migrated unknown epoch
    // adopts the first v54 epoch in place; only a change between two known epochs replaces cache.
    this.reconcileRunnerHistory(id, snap.historyEpoch, snap.seq);
    // A guardrail pause (cost budget / tool-call limit) is set entirely control-plane-side; the
    // runner's snapshot knows nothing of it, so we must not let it revert status→idle +
    // pending→null and resume over-limit work.
    const existing = this.stmt(
      `SELECT runner_id, workspace_id, project_id, pending_approval, title, title_source, semantic_title,
              cost_budget_usd, execution_handoff, adopted, workspace_path
       FROM sessions WHERE id=?`,
    ).get(id) as
      | {
          runner_id: string;
          workspace_id: string | null;
          project_id: string | null;
          pending_approval: string | null;
          title: string;
          title_source: string | null;
          semantic_title: number;
          cost_budget_usd: number | null;
          execution_handoff: string | null;
          adopted: number;
          workspace_path: string | null;
        }
      | undefined;
    const authoritativeImportPath = existing?.adopted === 1 && existing.workspace_id === null &&
      existing.project_id === null && existing.workspace_path === null && snap.adopted && snap.workspacePath?.trim()
      ? snap.workspacePath.trim()
      : null;
    const authoritativeImport = authoritativeImportPath && existing
      ? this.resolveImportedSessionLocation(existing.runner_id, authoritativeImportPath)
      : null;
    const authoritativeWorkspaceId = authoritativeImport
      ? snap.workspaceId ?? authoritativeImport.workspaceId
      : null;
    const authoritativeScope = authoritativeImport && existing
      ? this.inheritedSessionScope(existing.runner_id, authoritativeWorkspaceId)
      : null;
    const authoritativeProjectCandidate = authoritativeImport && authoritativeWorkspaceId
      ? authoritativeImport.workspaceId === authoritativeWorkspaceId
        ? authoritativeImport.projectLocation
        : this.findProjectLocation(existing!.runner_id, authoritativeWorkspaceId)
      : null;
    const authoritativeProjectLocation = authoritativeProjectCandidate && authoritativeScope &&
      this.projectScope(authoritativeProjectCandidate.projectId) &&
      this.scopeAudienceContainedWithMembership(
        authoritativeScope,
        this.projectScope(authoritativeProjectCandidate.projectId)!,
      )
      ? authoritativeProjectCandidate
      : null;
    const expectedHandoffRequest = this.getExecutionHandoffRequest(id);
    const acceptedHandoff = parseJson<ExecutionHandoffReceipt>(existing?.execution_handoff ?? null);
    const expectedHandoffBudgetUsd = typeof acceptedHandoff?.budgetUsd === "number"
      ? acceptedHandoff.budgetUsd
      : existing?.cost_budget_usd ?? undefined;
    let keepPolicyPause = false;
    try {
      const cur = existing?.pending_approval ? (JSON.parse(existing.pending_approval) as PendingApproval) : null;
      keepPolicyPause = isPolicyApproval(cur) && !isTerminal(snap.status);
    } catch {
      /* malformed cached approval — fall through to the snapshot */
    }
    const status = keepPolicyPause ? "input_required" : snap.status;
    const pendingJson = keepPolicyPause
      ? existing!.pending_approval
      : snap.pendingApproval
        ? JSON.stringify(snap.pendingApproval)
        : null;
    const snapshotTitleSource = snap.titleSource ?? "generated";
    // The control plane owns explicit rename order. A runner snapshot can carry an OLDER user
    // title (the runner learned the launch-time title but not a later CP-only rename), so even an
    // incoming `user` source must not replace the existing local user override.
    const keepControlPlaneTitle = existing?.title_source === "user" ||
      (existing?.semantic_title === 1 && snapshotTitleSource !== "provider");
    const title = keepControlPlaneTitle ? existing!.title : snap.title;
    const titleSource = keepControlPlaneTitle ? existing!.title_source ?? "generated" : snapshotTitleSource;
    const semanticTitle = keepControlPlaneTitle && existing?.semantic_title === 1 ? 1 : 0;
    this.db.exec("BEGIN");
    try {
      if (authoritativeImportPath && authoritativeScope) {
        const ownerId = authoritativeScope.owner.kind === "organization"
          ? authoritativeScope.owner.organizationId
          : authoritativeScope.owner.kind === "user"
            ? authoritativeScope.owner.userId
            : authoritativeScope.owner.teamId;
        this.stmt(
          `UPDATE session_ownership SET organization_id=?, owner_kind=?, owner_id=?, updated_at=?
           WHERE session_id=?`,
        ).run(
          authoritativeScope.organizationId,
          authoritativeScope.owner.kind,
          ownerId,
          now,
          id,
        );
        this.stmt(
          `UPDATE sessions SET workspace_id=?, project_id=?, project_location_id=? WHERE id=?`,
        ).run(
          authoritativeWorkspaceId,
          authoritativeProjectLocation?.projectId ?? null,
          authoritativeProjectLocation?.id ?? null,
          id,
        );
      }
      this.stmt(
        `UPDATE sessions SET status=?, title=?, title_source=?, semantic_title=?, provider_updated_at=?, background_work_state=?, background_work_tracking=COALESCE(?, background_work_tracking), preview=?, pending_approval=?, worktree_path=?, worktrees=?, workspace_path=?, use_worktree=?,
            model=?, resolved_model=?, effort=?, permission_mode=?, agent_capabilities=?, input_tokens=?, output_tokens=?, context_tokens_used=?, context_window=?, cost_usd=?, adopted=?,
            acp_session_context=COALESCE(?, acp_session_context),
            updated_at=? WHERE id=?`,
      )
      .run(
        status,
        title,
        titleSource,
        semanticTitle,
        snap.providerUpdatedAt ?? null,
        backgroundWorkStateForStorage(snap.backgroundWorkState),
        snap.backgroundWorkTracking ?? null,
        snap.preview,
        pendingJson,
        snap.worktreePath,
        snap.worktrees ? JSON.stringify(snap.worktrees) : null,
        snap.workspacePath ?? null,
        snap.useWorktree ? 1 : 0,
        snap.config.model ?? null,
        snap.resolvedModel ?? null,
        snap.config.effort ?? null,
        snap.config.permissionMode ?? null,
        snap.agentCapabilities ? JSON.stringify(snap.agentCapabilities) : null,
        snap.tokensIn,
        snap.tokensOut,
        snap.contextTokensUsed ?? null,
        snap.contextWindow ?? null,
        snap.costUsd,
        snap.adopted ? 1 : 0,
        snap.acpSessionContext ? JSON.stringify(snap.acpSessionContext) : null,
        now,
        id,
      );
      if (snap.executionTarget) {
        this.stmt("UPDATE sessions SET execution_target=? WHERE id=?")
          .run(JSON.stringify(snap.executionTarget), id);
      }
      const handoff = validateExecutionHandoffReceipt(
        snap.executionHandoff,
        snap.executionTarget,
        expectedHandoffRequest,
        expectedHandoffBudgetUsd,
      );
      if (handoff) {
        const request = expectedHandoffRequest ?? {
          ...(handoff.sourceSessionId ? { sourceSessionId: handoff.sourceSessionId } : {}),
          artifacts: handoff.artifacts,
        };
        this.stmt("UPDATE sessions SET execution_handoff_request=?, execution_handoff=? WHERE id=?")
          .run(JSON.stringify(request), JSON.stringify(handoff), id);
      }
      this.reconcileUsageSnapshotInTransaction(id, snap, now);
      this.upsertManagedBackgroundJobsInTransaction(id, snap.backgroundJobs, now);
      // Session terminality is the retry fence regardless of which service path observed it;
      // snapshots (hydration and runtime updates) must fence in the same transaction so a pending
      // durable prompt can never be re-delivered into a session this snapshot terminalized.
      // The same authority orphans any armed settlement marker: a post-restart hydration of a
      // dead run must not leave it to suppress a later run's Ready.
      if (isTerminal(status)) {
        this.cancelSessionPromptCommands(
          id,
          `session became ${status} before durable prompt delivery completed`,
          now,
        );
        this.stmt(
          `UPDATE managed_background_deliveries
              SET status_settlement_pending_at=NULL, updated_at=MAX(updated_at, ?)
            WHERE session_id=? AND status_settlement_pending_at IS NOT NULL
              AND status_settled_at IS NULL`,
        ).run(now, id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.maybeMaintainUsageAggregation();
  }

  /** Monotonic mirror of projection-safe runner facts. Absence means a pre-v82 runner and leaves
   * prior evidence intact; a present array is authoritative, so missing jobs become inactive
   * tombstones while their audit and delivery evidence remains durable. */
  private upsertManagedBackgroundJobsInTransaction(
    sessionId: string,
    jobs: readonly ManagedBackgroundJobSnapshot[] | undefined,
    now: number,
  ): void {
    if (!Array.isArray(jobs)) return;
    this.stmt(
      "UPDATE managed_background_jobs SET source_present=0, last_observed_at=MAX(last_observed_at, ?) WHERE session_id=?",
    ).run(now, sessionId);
    if (jobs.length === 0) return;
    const placement = this.stmt(
      "SELECT runner_id, project_location_id FROM sessions WHERE id=?",
    ).get(sessionId) as {
      runner_id: string;
      project_location_id: string | null;
    } | undefined;
    if (!placement) return;
    const upsertJob = this.stmt(
      `INSERT INTO managed_background_jobs
        (session_id, job_id, parent_turn_id, runner_id, workspace_id, project_location_id,
         launch_type, registered_at, terminal_status,
         terminal_observed_at, continuation_required, continuation_id, continuation_queued_at,
         continuation_submitted_at, continuation_accepted_at, assistant_result_persisted_at,
         source_present, last_observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, job_id) DO UPDATE SET
         parent_turn_id=managed_background_jobs.parent_turn_id,
         runner_id=managed_background_jobs.runner_id,
         workspace_id=managed_background_jobs.workspace_id,
         project_location_id=COALESCE(managed_background_jobs.project_location_id, excluded.project_location_id),
         launch_type=CASE WHEN managed_background_jobs.launch_type='unknown'
                          THEN excluded.launch_type ELSE managed_background_jobs.launch_type END,
         registered_at=MIN(managed_background_jobs.registered_at, excluded.registered_at),
         terminal_status=COALESCE(managed_background_jobs.terminal_status, excluded.terminal_status),
         terminal_observed_at=COALESCE(managed_background_jobs.terminal_observed_at, excluded.terminal_observed_at),
         continuation_required=CASE
           WHEN managed_background_jobs.continuation_required=1 OR excluded.continuation_required=1 THEN 1
           WHEN managed_background_jobs.continuation_required=0 OR excluded.continuation_required=0 THEN 0
           ELSE NULL END,
         continuation_id=COALESCE(managed_background_jobs.continuation_id, excluded.continuation_id),
         continuation_queued_at=COALESCE(managed_background_jobs.continuation_queued_at, excluded.continuation_queued_at),
         continuation_submitted_at=COALESCE(managed_background_jobs.continuation_submitted_at, excluded.continuation_submitted_at),
         continuation_accepted_at=COALESCE(managed_background_jobs.continuation_accepted_at, excluded.continuation_accepted_at),
         assistant_result_persisted_at=COALESCE(managed_background_jobs.assistant_result_persisted_at, excluded.assistant_result_persisted_at),
         source_present=1,
         last_observed_at=MAX(managed_background_jobs.last_observed_at, excluded.last_observed_at)`,
    );
    const upsertDelivery = this.stmt(
      `INSERT INTO managed_background_deliveries
        (session_id, continuation_id, parent_turn_id, queued_at, submitted_at, accepted_at,
         runner_result_persisted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, continuation_id) DO UPDATE SET
         parent_turn_id=managed_background_deliveries.parent_turn_id,
         queued_at=COALESCE(managed_background_deliveries.queued_at, excluded.queued_at),
         submitted_at=COALESCE(managed_background_deliveries.submitted_at, excluded.submitted_at),
         accepted_at=COALESCE(managed_background_deliveries.accepted_at, excluded.accepted_at),
         runner_result_persisted_at=COALESCE(managed_background_deliveries.runner_result_persisted_at, excluded.runner_result_persisted_at),
         updated_at=MAX(managed_background_deliveries.updated_at, excluded.updated_at)`,
    );
    for (const candidate of jobs.slice(0, 512) as readonly unknown[]) {
      if (!candidate || typeof candidate !== "object") continue;
      const job = candidate as Partial<ManagedBackgroundJobSnapshot>;
      if (!validBackgroundIdentity(job.id) || !validBackgroundIdentity(job.parentTurnId) ||
          job.runnerId !== placement.runner_id ||
          (job.workspaceId !== null && !validBackgroundIdentity(job.workspaceId)) ||
          !validBackgroundLaunchType(job.launchType) ||
          !validBackgroundTerminalStatus(job.terminalStatus) ||
          !validOptionalBackgroundBoolean(job.continuationRequired) ||
          !validOptionalBackgroundIdentity(job.continuationId) ||
          !validBackgroundTimestamp(job.registeredAt) ||
          !validOptionalBackgroundTimestamp(job.terminalObservedAt) ||
          !validOptionalBackgroundTimestamp(job.continuationQueuedAt) ||
          !validOptionalBackgroundTimestamp(job.continuationSubmittedAt) ||
          !validOptionalBackgroundTimestamp(job.continuationAcceptedAt) ||
          !validOptionalBackgroundTimestamp(job.assistantResultPersistedAt)) continue;
      upsertJob.run(
        sessionId,
        job.id,
        job.parentTurnId,
        placement.runner_id,
        job.workspaceId,
        placement.project_location_id,
        job.launchType,
        job.registeredAt,
        job.terminalStatus ?? null,
        job.terminalObservedAt ?? null,
        job.continuationRequired === undefined ? null : job.continuationRequired ? 1 : 0,
        job.continuationId && validBackgroundIdentity(job.continuationId) ? job.continuationId : null,
        job.continuationQueuedAt ?? null,
        job.continuationSubmittedAt ?? null,
        job.continuationAcceptedAt ?? null,
        job.assistantResultPersistedAt ?? null,
        1,
        now,
      );
      if (job.continuationId && validBackgroundIdentity(job.continuationId)) {
        upsertDelivery.run(
          sessionId,
          job.continuationId,
          job.parentTurnId,
          job.continuationQueuedAt ?? null,
          job.continuationSubmittedAt ?? null,
          job.continuationAcceptedAt ?? null,
          job.assistantResultPersistedAt ?? null,
          now,
        );
      }
    }
  }

  /** Commit the structured runner proof and every control-plane-owned downstream stage in the
   * same transaction as the transcript event. Replays converge on the same continuation key. */
  private projectBackgroundContinuationInTransaction(
    sessionId: string,
    payload: SessionEventPayload,
    ts: number,
    eventEpoch: number,
    eventSeq: number,
    armStatusSettlement: boolean,
  ): void {
    if (payload.kind !== "background_continuation_delivered" ||
        !validBackgroundIdentity(payload.continuationId) ||
        !validBackgroundIdentity(payload.parentTurnId)) return;
    this.stmt(
      `INSERT INTO managed_background_deliveries
        (session_id, continuation_id, parent_turn_id, runner_result_persisted_at,
         transcript_projected_at, projected_event_epoch, projected_event_seq,
         notification_queued_at, status_settlement_pending_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, continuation_id) DO UPDATE SET
         parent_turn_id=managed_background_deliveries.parent_turn_id,
         runner_result_persisted_at=COALESCE(managed_background_deliveries.runner_result_persisted_at, excluded.runner_result_persisted_at),
         transcript_projected_at=COALESCE(managed_background_deliveries.transcript_projected_at, excluded.transcript_projected_at),
         projected_event_epoch=COALESCE(managed_background_deliveries.projected_event_epoch, excluded.projected_event_epoch),
         projected_event_seq=COALESCE(managed_background_deliveries.projected_event_seq, excluded.projected_event_seq),
         notification_queued_at=COALESCE(managed_background_deliveries.notification_queued_at, excluded.notification_queued_at),
         status_settlement_pending_at=CASE
           WHEN managed_background_deliveries.status_settled_at IS NULL
             THEN COALESCE(managed_background_deliveries.status_settlement_pending_at, excluded.status_settlement_pending_at)
           ELSE managed_background_deliveries.status_settlement_pending_at
         END,
         updated_at=MAX(managed_background_deliveries.updated_at, excluded.updated_at)`,
    ).run(
      sessionId,
      payload.continuationId,
      payload.parentTurnId,
      ts,
      ts,
      eventEpoch,
      eventSeq,
      ts,
      armStatusSettlement &&
        ["queued", "starting", "running"].includes(
          (this.stmt("SELECT status FROM sessions WHERE id=?").get(sessionId) as
            | { status: SessionStatus }
            | undefined)?.status ?? "",
        ) ? ts : null,
      ts,
    );
    this.stageBackgroundPushDeliveriesInTransaction(
      sessionId,
      payload.continuationId,
      ts,
      Date.now(),
    );
  }

  private stageBackgroundPushDeliveriesInTransaction(
    sessionId: string,
    continuationId: string,
    eventTs: number,
    observedAt: number,
  ): void {
    const message = JSON.stringify({
      title: "Managed Background Work Completed",
      body: "The parent session resumed and its result is ready.",
      sessionId,
      notificationKey: `background-continuation:${continuationId}`,
      urgency: "normal",
      ts: eventTs,
    });
    const insert = this.stmt(
      `INSERT OR IGNORE INTO background_push_deliveries
        (delivery_id, session_id, continuation_id, endpoint, endpoint_key, payload_json,
         state, next_attempt_at, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    );
    for (const sub of this.listPushSubscriptions({ kind: "session", sessionId })) {
      const endpointHash = createHash("sha256").update(sub.endpoint).digest("hex");
      const deliveryId = `bgpush_${createHash("sha256")
        .update(`${sessionId}\0${continuationId}\0${endpointHash}`)
        .digest("hex")}`;
      insert.run(
        deliveryId,
        sessionId,
        continuationId,
        sub.endpoint,
        endpointHash,
        message,
        observedAt,
        observedAt + 7 * 24 * 60 * 60_000,
        observedAt,
        observedAt,
      );
    }
  }

  acknowledgeBackgroundDelivery(sessionId: string, continuationId: string, now: number): boolean {
    if (!validBackgroundIdentity(sessionId) || !validBackgroundIdentity(continuationId) ||
        !Number.isSafeInteger(now) || now < 0) return false;
    return Number(this.stmt(
      `UPDATE managed_background_deliveries
          SET dashboard_observed_at=COALESCE(dashboard_observed_at, ?), updated_at=MAX(updated_at, ?)
        WHERE session_id=? AND continuation_id=? AND notification_queued_at IS NOT NULL
          AND dashboard_observed_at IS NULL`,
    ).run(now, now, sessionId, continuationId).changes) > 0;
  }

  /** A live delivery frame diverted through catch-up hydration by a sequence gap must arm its
   * settlement BEFORE the hydration round-trip: the runner's trailing idle can arrive first, and
   * once the session is idle the projection-time arming would refuse. Creates the durable row
   * early with only identity and the pending marker; the later projection fills every other
   * stage via its COALESCE upsert. */
  armBackgroundDeliverySettlementEarly(
    sessionId: string,
    continuationId: string,
    parentTurnId: string,
    now: number,
  ): void {
    if (!validBackgroundIdentity(continuationId) || !validBackgroundIdentity(parentTurnId)) return;
    const busy = ["queued", "starting", "running"].includes(
      (this.stmt("SELECT status FROM sessions WHERE id=?").get(sessionId) as
        | { status: SessionStatus }
        | undefined)?.status ?? "",
    );
    if (!busy) return;
    this.stmt(
      `INSERT INTO managed_background_deliveries
        (session_id, continuation_id, parent_turn_id, status_settlement_pending_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, continuation_id) DO UPDATE SET
         status_settlement_pending_at=CASE
           WHEN managed_background_deliveries.status_settled_at IS NULL
             THEN COALESCE(managed_background_deliveries.status_settlement_pending_at, excluded.status_settlement_pending_at)
           ELSE managed_background_deliveries.status_settlement_pending_at
         END,
         updated_at=MAX(managed_background_deliveries.updated_at, excluded.updated_at)`,
    ).run(sessionId, continuationId, parentTurnId, now, now);
  }

  /** Consume live-event provenance for exactly one semantic busy-to-idle completion. Historical
   * replay never arms this marker, even when the session happens to be running during hydration. */
  settleManagedBackgroundDeliveryStatus(sessionId: string, now: number): boolean {
    const result = this.stmt(
      `UPDATE managed_background_deliveries
          SET status_settled_at=COALESCE(status_settled_at, ?),
              status_settlement_pending_at=NULL,
              updated_at=MAX(updated_at, ?)
        WHERE session_id=? AND status_settlement_pending_at IS NOT NULL
          AND status_settled_at IS NULL`,
    ).run(now, now, sessionId);
    return Number(result.changes) > 0;
  }

  listBackgroundDeliveries(sessionId: string, status?: SessionStatus): BackgroundDeliveryView[] {
    const rows = this.stmt(
      `SELECT delivery.continuation_id, delivery.parent_turn_id, delivery.queued_at,
              delivery.submitted_at, delivery.accepted_at, delivery.runner_result_persisted_at,
              delivery.transcript_projected_at, delivery.notification_queued_at,
              delivery.dashboard_observed_at, delivery.status_settled_at,
              COUNT(job.job_id) AS job_count,
              COALESCE(SUM(CASE WHEN job.terminal_observed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS terminal_count,
              COALESCE(SUM(job.source_present), 0) AS active_job_count
         FROM managed_background_deliveries delivery
         LEFT JOIN managed_background_jobs job
           ON job.session_id=delivery.session_id AND job.continuation_id=delivery.continuation_id
        WHERE delivery.session_id=?
        GROUP BY delivery.session_id, delivery.continuation_id
        ORDER BY CASE
                   WHEN COALESCE(SUM(job.source_present), 0) > 0
                     AND delivery.accepted_at IS NOT NULL AND delivery.runner_result_persisted_at IS NULL THEN 0
                   WHEN COALESCE(SUM(job.source_present), 0) > 0
                     AND delivery.runner_result_persisted_at IS NOT NULL AND delivery.transcript_projected_at IS NULL THEN 0
                   WHEN delivery.notification_queued_at IS NOT NULL AND delivery.dashboard_observed_at IS NULL THEN 0
                   ELSE 1
                 END,
                 COALESCE(delivery.notification_queued_at, delivery.updated_at) DESC,
                 delivery.continuation_id
        LIMIT 32`,
    ).all(sessionId) as unknown as Array<{
      continuation_id: string;
      parent_turn_id: string;
      queued_at: number | null;
      submitted_at: number | null;
      accepted_at: number | null;
      runner_result_persisted_at: number | null;
      transcript_projected_at: number | null;
      notification_queued_at: number | null;
      dashboard_observed_at: number | null;
      status_settled_at: number | null;
      job_count: number;
      terminal_count: number;
      active_job_count: number;
    }>;
    const notificationsByContinuation = this.listBackgroundNotificationReceipts(
      sessionId,
      rows.map((row) => row.continuation_id),
    );
    const views = rows.map((row): BackgroundDeliveryView => {
      let watchdogState: BackgroundDeliveryWatchdogState | undefined;
      if (status !== "stopped" && row.active_job_count > 0 &&
          row.accepted_at != null && row.runner_result_persisted_at == null) {
        watchdogState = "accepted_without_result";
      } else if (status !== "stopped" && row.active_job_count > 0 &&
                 row.runner_result_persisted_at != null && row.transcript_projected_at == null) {
        watchdogState = "result_not_projected";
      } else if (status !== "stopped" && row.notification_queued_at != null && row.dashboard_observed_at == null) {
        watchdogState = "dashboard_observation_pending";
      }
      return {
        continuationId: row.continuation_id,
        parentTurnId: row.parent_turn_id,
        jobCount: row.job_count,
        terminalCount: row.terminal_count,
        ...(row.queued_at != null ? { queuedAt: row.queued_at } : {}),
        ...(row.submitted_at != null ? { submittedAt: row.submitted_at } : {}),
        ...(row.accepted_at != null ? { acceptedAt: row.accepted_at } : {}),
        ...(row.runner_result_persisted_at != null ? { runnerResultPersistedAt: row.runner_result_persisted_at } : {}),
        ...(row.transcript_projected_at != null ? { transcriptProjectedAt: row.transcript_projected_at } : {}),
        ...(row.notification_queued_at != null ? { notificationQueuedAt: row.notification_queued_at } : {}),
        ...(row.dashboard_observed_at != null ? { dashboardObservedAt: row.dashboard_observed_at } : {}),
        ...(row.status_settled_at != null ? { statusSettledAt: row.status_settled_at } : {}),
        ...(notificationsByContinuation.get(row.continuation_id)?.length
          ? { notifications: notificationsByContinuation.get(row.continuation_id)! }
          : {}),
        ...(watchdogState ? { watchdogState } : {}),
      };
    });
    const pending = status === "stopped" ? [] : this.stmt(
      `SELECT parent_turn_id, COUNT(*) AS job_count,
              SUM(CASE WHEN terminal_observed_at IS NOT NULL THEN 1 ELSE 0 END) AS terminal_count
         FROM managed_background_jobs
        WHERE session_id=? AND source_present=1
          AND continuation_required=1 AND terminal_observed_at IS NOT NULL
          AND continuation_id IS NULL
        GROUP BY parent_turn_id ORDER BY parent_turn_id
        LIMIT 32`,
    ).all(sessionId) as unknown as Array<{
      parent_turn_id: string;
      job_count: number;
      terminal_count: number;
    }>;
    return views.concat(pending.map((row) => ({
      parentTurnId: row.parent_turn_id,
      jobCount: row.job_count,
      terminalCount: row.terminal_count,
      watchdogState: "terminal_without_continuation" as const,
    })));
  }

  /** Active and recent terminal jobs, bounded for session-list broadcasts. Provider-local fields
   * never enter this table and therefore cannot cross the dashboard privacy boundary here. */
  listManagedBackgroundJobs(sessionId: string): ManagedBackgroundJobView[] {
    const rows = this.stmt(
      `SELECT job_id, parent_turn_id, launch_type, registered_at, last_observed_at,
              source_present, terminal_status, terminal_observed_at, continuation_required,
              continuation_id, continuation_queued_at, continuation_submitted_at,
              continuation_accepted_at, assistant_result_persisted_at
         FROM managed_background_jobs
        WHERE session_id=?
        ORDER BY CASE
                   WHEN source_present=1 AND assistant_result_persisted_at IS NULL THEN 0
                   ELSE 1
                 END,
                 COALESCE(terminal_observed_at, registered_at) DESC,
                 job_id
        LIMIT ${MANAGED_BACKGROUND_JOB_VIEW_LIMIT}`,
    ).all(sessionId) as unknown as Array<{
      job_id: string;
      parent_turn_id: string;
      launch_type: ManagedBackgroundJobView["launchType"];
      registered_at: number;
      last_observed_at: number;
      source_present: number;
      terminal_status: ManagedBackgroundJobView["terminalStatus"] | null;
      terminal_observed_at: number | null;
      continuation_required: number | null;
      continuation_id: string | null;
      continuation_queued_at: number | null;
      continuation_submitted_at: number | null;
      continuation_accepted_at: number | null;
      assistant_result_persisted_at: number | null;
    }>;
    return rows.map((row) => ({
      id: row.job_id,
      parentTurnId: row.parent_turn_id,
      launchType: row.launch_type,
      registeredAt: row.registered_at,
      lastObservedAt: row.last_observed_at,
      sourcePresent: row.source_present === 1,
      ...(row.terminal_status ? { terminalStatus: row.terminal_status } : {}),
      ...(row.terminal_observed_at != null ? { terminalObservedAt: row.terminal_observed_at } : {}),
      ...(row.continuation_required != null ? { continuationRequired: row.continuation_required === 1 } : {}),
      ...(row.continuation_id ? { continuationId: row.continuation_id } : {}),
      ...(row.continuation_queued_at != null ? { continuationQueuedAt: row.continuation_queued_at } : {}),
      ...(row.continuation_submitted_at != null ? { continuationSubmittedAt: row.continuation_submitted_at } : {}),
      ...(row.continuation_accepted_at != null ? { continuationAcceptedAt: row.continuation_accepted_at } : {}),
      ...(row.assistant_result_persisted_at != null
        ? { assistantResultPersistedAt: row.assistant_result_persisted_at }
        : {}),
    }));
  }

  private managedBackgroundJobsTruncated(sessionId: string): boolean {
    return Boolean(this.stmt(
      `SELECT 1 AS present FROM managed_background_jobs WHERE session_id=?
        LIMIT 1 OFFSET ${MANAGED_BACKGROUND_JOB_VIEW_LIMIT}`,
    ).get(sessionId));
  }

  /** Highest runner-owned event seq this cache has ingested for a session. */
  getHydratedSeq(id: string): number {
    const row = this.stmt("SELECT hydrated_seq FROM sessions WHERE id=?").get(id) as
      | { hydrated_seq: number }
      | undefined;
    return row?.hydrated_seq ?? 0;
  }

  /** Advance the hydration high-water (only ever increases). */
  setHydratedSeq(id: string, seq: number): void {
    this.stmt("UPDATE sessions SET hydrated_seq=? WHERE id=? AND hydrated_seq < ?").run(seq, id, seq);
  }

  /** Persist the runner's durable history generation/tail. The first known epoch on a migrated row
   * adopts the existing cache; only a change between two known epochs proves replacement. */
  reconcileRunnerHistory(
    id: string,
    historyEpoch: number | undefined,
    tailSeq: number,
  ): RunnerHistoryReconciliation | null {
    if (!Number.isSafeInteger(tailSeq) || tailSeq < 0) {
      throw new RangeError("tailSeq must be a non-negative safe integer");
    }
    if (historyEpoch !== undefined && (!Number.isSafeInteger(historyEpoch) || historyEpoch < 0)) {
      throw new RangeError("historyEpoch must be a non-negative safe integer when present");
    }
    this.db.exec("BEGIN");
    try {
      const before = this.stmt(
        `SELECT runner_history_epoch, runner_history_tail_seq, hydrated_seq, event_epoch
           FROM sessions WHERE id=?`,
      ).get(id) as {
        runner_history_epoch: number | null;
        runner_history_tail_seq: number;
        hydrated_seq: number;
        event_epoch: number;
      } | undefined;
      if (!before) {
        this.db.exec("ROLLBACK");
        return null;
      }
      const reset = historyEpoch !== undefined && before.runner_history_epoch !== null &&
        before.runner_history_epoch !== historyEpoch;
      // A same-generation runner tail is monotonic. Preserve a newer snapshot/cursor if a delayed
      // runtime snapshot arrives after it; a newly adopted epoch must also cover migrated cache.
      const settledTail = reset
        ? tailSeq
        : Math.max(tailSeq, before.runner_history_tail_seq, before.hydrated_seq);
      if (reset) {
        this.stmt(
          `DELETE FROM artifacts WHERE session_id=? AND run_id IS NULL
             AND CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.purpose') END='session_event_payload'`,
        ).run(id);
        this.stmt("DELETE FROM session_events WHERE session_id=?").run(id);
        this.stmt("DELETE FROM session_events_fts WHERE session_id=?").run(id);
        this.stmt(
          `UPDATE managed_background_deliveries
              SET transcript_projected_at=NULL, projected_event_epoch=NULL, projected_event_seq=NULL
            WHERE session_id=? AND transcript_projected_at IS NOT NULL`,
        ).run(id);
        this.stmt(
          `UPDATE sessions
              SET runner_history_epoch=?, runner_history_tail_seq=?, hydrated_seq=0,
                  message_count=0, last_event_at=NULL, preview=NULL, event_epoch=event_epoch+1
            WHERE id=?`,
        ).run(historyEpoch, settledTail, id);
      } else if (historyEpoch !== undefined) {
        this.stmt(
          "UPDATE sessions SET runner_history_epoch=?, runner_history_tail_seq=? WHERE id=?",
        ).run(historyEpoch, settledTail, id);
      } else {
        // A pre-v54 snapshot cannot prove a generation. Preserve any epoch learned earlier, but its
        // advertised tail is still useful to legacy completeness diagnostics.
        this.stmt("UPDATE sessions SET runner_history_tail_seq=? WHERE id=?").run(settledTail, id);
      }
      const after = this.stmt(
        `SELECT runner_history_epoch, runner_history_tail_seq, hydrated_seq, event_epoch
           FROM sessions WHERE id=?`,
      ).get(id) as {
        runner_history_epoch: number | null;
        runner_history_tail_seq: number;
        hydrated_seq: number;
        event_epoch: number;
      };
      this.db.exec("COMMIT");
      if (reset) this.collectWorkflowArtifactBlobs();
      return {
        reset,
        historyEpoch: after.runner_history_epoch,
        tailSeq: after.runner_history_tail_seq,
        hydratedSeq: after.hydrated_seq,
        eventEpoch: after.event_epoch,
        complete: after.runner_history_epoch !== null &&
          after.hydrated_seq >= after.runner_history_tail_seq,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getRunnerHistoryState(id: string): RunnerHistoryState | null {
    const row = this.stmt(
      `SELECT runner_history_epoch, runner_history_tail_seq, hydrated_seq, event_epoch
         FROM sessions WHERE id=?`,
    ).get(id) as {
      runner_history_epoch: number | null;
      runner_history_tail_seq: number;
      hydrated_seq: number;
      event_epoch: number;
    } | undefined;
    return row
      ? {
          historyEpoch: row.runner_history_epoch,
          tailSeq: row.runner_history_tail_seq,
          hydratedSeq: row.hydrated_seq,
          eventEpoch: row.event_epoch,
          complete: row.runner_history_epoch !== null &&
            row.hydrated_seq >= row.runner_history_tail_seq,
        }
      : null;
  }

  /** Drop a session's cached event log and reset its hydration high-water to 0, so the next
   * hydrateHistory() re-pulls the whole timeline from the box (used by reprocess/re-import).
   * One transaction: a crash between the DELETE and the counter/high-water reset would leave
   * message_count permanently overstating an empty table (the open-time backfill only repairs
   * NULL counters, not drifted ones). */
  clearSessionEvents(id: string): void {
    this.db.exec("BEGIN");
    try {
      this.stmt(
        `DELETE FROM artifacts WHERE session_id=? AND run_id IS NULL
           AND CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.purpose') END='session_event_payload'`,
      ).run(id);
      this.stmt("DELETE FROM session_events WHERE session_id=?").run(id);
      this.stmt("DELETE FROM session_events_fts WHERE session_id=?").run(id);
      this.stmt(
        `UPDATE managed_background_deliveries
            SET transcript_projected_at=NULL, projected_event_epoch=NULL, projected_event_seq=NULL
          WHERE session_id=? AND transcript_projected_at IS NOT NULL`,
      ).run(id);
      this.stmt(
        `UPDATE sessions SET hydrated_seq=0, message_count=0, last_event_at=NULL, preview=NULL,
            runner_history_epoch=NULL, runner_history_tail_seq=0, event_epoch=event_epoch+1 WHERE id=?`,
      ).run(id);
      this.db.exec("COMMIT");
      this.collectWorkflowArtifactBlobs();
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  updateSessionStatus(id: string, status: SessionStatus, now: number, provisionalStop = false): void {
    // Terminality couples the status write to its fences below; commit them together so a crash
    // between statements cannot persist a terminal status with a stale armed marker.
    this.atomic(() => {
    this.stmt("UPDATE sessions SET status=?, updated_at=? WHERE id=?")
      .run(status, now, id);
    if (status === "completed" || status === "failed" || status === "stopped") {
      // Session terminality is the retry fence, regardless of which service path observed it.
      // A never-sent prompt is definitely failed; anything marked before send may have reached
      // the runner and is conservatively uncertain until a later receipt narrows the outcome.
      this.cancelSessionPromptCommands(id, `session became ${status} before durable prompt delivery completed`, now);
      // An authoritative terminal transition orphans any armed-but-unsettled delivery marker: the
      // trailing idle it awaited will never belong to this run, and leaving it pending would
      // suppress the Ready of an unrelated later run. Provisional stops (runner disconnect,
      // startup settlement) deliberately do NOT clear it — the delivery's idle still arrives
      // after reconnect, and that restart survival is the feature's core case.
      if (!provisionalStop) {
        this.stmt(
          `UPDATE managed_background_deliveries
              SET status_settlement_pending_at=NULL, updated_at=MAX(updated_at, ?)
            WHERE session_id=? AND status_settlement_pending_at IS NOT NULL
              AND status_settled_at IS NULL`,
        ).run(now, id);
      }
    }
    // Swallowed idle belongs only to the CP-owned pause that observed it. Any local or runner
    // transition back into execution (or into a terminal state) invalidates that settle proof,
    // including callers such as prompt/restart/stop that do not pass through onSessionStatus().
    if (status !== "idle" && status !== "input_required") {
      this.stmt(
        "UPDATE sessions SET policy_resume_status=NULL WHERE id=? AND policy_resume_status IS NOT NULL",
      ).run(id);
      this.stmt(
        `UPDATE policy_hook_approvals SET resume_status=NULL
         WHERE session_id=? AND status IN ('queued','pending') AND resume_status IS NOT NULL`,
      ).run(id);
    }
    // Clear a pending approval whenever we leave the input_required state.
    if (status !== "input_required") {
      this.stmt("UPDATE sessions SET pending_approval=NULL WHERE id=?").run(id);
    }
    });
  }

  setSessionColumn(id: string, column: BoardColumn | null, now: number): void {
    this.stmt("UPDATE sessions SET board_column=?, updated_at=? WHERE id=?")
      .run(column, now, id);
  }

  /** Pin a session's resolved launch directory before the legacy workspace-group adapter changes
   * workspace_id. The grouping must never change where the agent relaunches. */
  setSessionWorkspacePath(id: string, path: string): void {
    this.stmt("UPDATE sessions SET workspace_path=? WHERE id=?").run(path, id);
  }

  /** Legacy compatibility grouping by workspace identity. Durable Project clients use
   * setSessionProject; runner snapshots never overwrite either CP-owned assignment. */
  setSessionWorkspace(id: string, workspaceId: string | null, now: number): void {
    const session = this.stmt("SELECT runner_id FROM sessions WHERE id=?").get(id) as
      | { runner_id: string }
      | undefined;
    const inferred = session && workspaceId ? this.findProjectLocation(session.runner_id, workspaceId) : null;
    const sessionScope = this.sessionScope(id);
    const projectScope = inferred ? this.projectScope(inferred.projectId) : null;
    const location = inferred && sessionScope && projectScope &&
      this.scopeAudienceContainedWithMembership(sessionScope, projectScope)
      ? inferred
      : null;
    this.stmt(
      "UPDATE sessions SET workspace_id=?, project_id=?, project_location_id=?, updated_at=? WHERE id=?",
    ).run(workspaceId, location?.projectId ?? null, location?.id ?? null, now, id);
  }

  setSessionTitle(id: string, title: string, now: number, source: SessionTitleSource = "generated"): void {
    this.stmt("UPDATE sessions SET title=?, title_source=?, semantic_title=0, updated_at=? WHERE id=?").run(title, source, now, id);
  }

  /** CP task-model result. It remains generated-owned but survives stale non-provider runner state. */
  setSemanticSessionTitle(id: string, title: string, now: number, source: SessionTitleSource): void {
    this.stmt("UPDATE sessions SET title=?, title_source=?, semantic_title=1, updated_at=? WHERE id=?")
      .run(title, source, now, id);
  }

  private sessionReminderView(row: SessionReminderRow): SessionReminderView {
    return {
      reminderId: row.reminder_id,
      sessionId: row.session_id,
      scheduledFor: row.scheduled_for,
      timeZone: row.time_zone,
      originalExpression: row.original_expression,
      wakePolicy: row.wake_policy,
      state: row.state,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.fired_at == null ? {} : { firedAt: row.fired_at }),
      ...(row.wake_reason == null ? {} : { wakeReason: row.wake_reason }),
    };
  }

  getSessionReminder(sessionId: string, userId: string): SessionReminderView | null {
    const row = this.stmt(
      "SELECT * FROM session_reminders WHERE session_id=? AND user_id=?",
    ).get(sessionId, userId) as unknown as SessionReminderRow | undefined;
    return row ? this.sessionReminderView(row) : null;
  }

  listSessionReminders(userId: string): SessionReminderView[] {
    const rows = this.stmt(
      `SELECT * FROM session_reminders WHERE user_id=?
       ORDER BY CASE state WHEN 'pending' THEN 0 ELSE 1 END, scheduled_for, session_id`,
    ).all(userId) as unknown as SessionReminderRow[];
    return rows.map((row) => this.sessionReminderView(row));
  }

  setSessionReminder(input: {
    sessionId: string;
    userId: string;
    scheduledFor: number;
    timeZone: string;
    originalExpression: string;
    wakePolicy: SessionReminderWakePolicy;
    expectedRevision?: number;
    expectedReminderId?: string;
    restoreFired?: { firedAt: number; wakeReason: SessionReminderWakeReason };
    now: number;
  }): SessionReminderMutationResult {
    return this.atomic(() => {
      const current = this.stmt(
        "SELECT * FROM session_reminders WHERE session_id=? AND user_id=?",
      ).get(input.sessionId, input.userId) as unknown as SessionReminderRow | undefined;
      if (current && (
        (input.expectedReminderId !== undefined && input.expectedReminderId !== current.reminder_id) ||
        (input.expectedRevision !== undefined && input.expectedRevision !== current.revision)
      )) {
        return { kind: "conflict", reminder: this.sessionReminderView(current) };
      }
      if (!current && (
        input.expectedReminderId !== undefined ||
        (input.expectedRevision !== undefined && input.expectedRevision !== 0)
      )) return { kind: "missing" };
      const session = this.stmt("SELECT 1 AS found FROM sessions WHERE id=?").get(input.sessionId) as
        | { found: number } | undefined;
      if (!session) return { kind: "missing" };
      // Activity wake compares against the control-plane session_events sequence, not the
      // runner-owned hydration sequence. Capture this baseline in the same transaction as write.
      const baseline = this.stmt(
        "SELECT COALESCE(MAX(seq),0) AS seq FROM session_events WHERE session_id=?",
      ).get(input.sessionId) as { seq: number };

      if (current) {
        const preservesObservedFiredState = input.restoreFired === undefined &&
          current.state === "fired" && input.scheduledFor === current.scheduled_for;
        if (preservesObservedFiredState) {
          this.stmt(
            `UPDATE session_reminders SET time_zone=?, original_expression=?, wake_policy=?,
               revision=revision+1, baseline_event_seq=?, updated_at=?
             WHERE session_id=? AND user_id=?`,
          ).run(input.timeZone, input.originalExpression, input.wakePolicy,
            baseline.seq, input.now, input.sessionId, input.userId);
        } else {
          this.stmt(
            `UPDATE session_reminders SET scheduled_for=?, time_zone=?, original_expression=?,
               wake_policy=?, state='pending', revision=revision+1, baseline_event_seq=?,
               wake_reason=NULL, fired_at=NULL, updated_at=? WHERE session_id=? AND user_id=?`,
          ).run(input.scheduledFor, input.timeZone, input.originalExpression, input.wakePolicy,
            baseline.seq, input.now, input.sessionId, input.userId);
        }
      } else {
        this.stmt(
          `INSERT INTO session_reminders
           (reminder_id,session_id,user_id,scheduled_for,time_zone,original_expression,wake_policy,
            state,revision,baseline_event_seq,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,'pending',1,?,?,?)`,
        ).run(`rem_${randomUUID().replace(/-/g, "")}`, input.sessionId, input.userId,
          input.scheduledFor, input.timeZone, input.originalExpression, input.wakePolicy,
          baseline.seq, input.now, input.now);
      }
      if (input.restoreFired) {
        this.stmt(
          `UPDATE session_reminders SET state='fired', wake_reason=?, fired_at=?
           WHERE session_id=? AND user_id=?`,
        ).run(input.restoreFired.wakeReason, input.restoreFired.firedAt, input.sessionId, input.userId);
      }
      return { kind: "updated", reminder: this.getSessionReminder(input.sessionId, input.userId)! };
    });
  }

  removeSessionReminder(
    sessionId: string,
    userId: string,
    expectedRevision?: number,
    expectedReminderId?: string,
  ): RemoveSessionReminderResult {
    return this.atomic(() => {
      const current = this.stmt(
        "SELECT * FROM session_reminders WHERE session_id=? AND user_id=?",
      ).get(sessionId, userId) as unknown as SessionReminderRow | undefined;
      if (!current) return { kind: "missing" };
      if ((expectedReminderId !== undefined && expectedReminderId !== current.reminder_id) ||
          (expectedRevision !== undefined && expectedRevision !== current.revision)) {
        return { kind: "conflict", reminder: this.sessionReminderView(current) };
      }
      this.stmt("DELETE FROM session_reminders WHERE session_id=? AND user_id=?").run(sessionId, userId);
      return { kind: "removed" };
    });
  }

  private fireSessionReminderRows(
    rows: SessionReminderRow[],
    reason: SessionReminderWakeReason,
    now: number,
  ): Array<{ userId: string; reminder: SessionReminderView }> {
    const fired: Array<{ userId: string; reminder: SessionReminderView }> = [];
    for (const row of rows) {
      const changed = this.stmt(
        `UPDATE session_reminders SET state='fired', wake_reason=?, fired_at=?, updated_at=?, revision=revision+1
         WHERE session_id=? AND user_id=? AND state='pending' AND revision=?`,
      ).run(reason, now, now, row.session_id, row.user_id, row.revision);
      if (!changed.changes) continue;
      const reminder = this.getSessionReminder(row.session_id, row.user_id);
      if (reminder) fired.push({ userId: row.user_id, reminder });
    }
    return fired;
  }

  fireDueSessionReminders(now: number): Array<{ userId: string; reminder: SessionReminderView }> {
    return this.atomic(() => {
      const rows = this.stmt(
        `SELECT r.* FROM session_reminders r JOIN sessions s ON s.id=r.session_id
         WHERE r.state='pending' AND r.scheduled_for<=? AND s.archived=0
         ORDER BY r.scheduled_for,r.session_id,r.user_id`,
      ).all(now) as unknown as SessionReminderRow[];
      return this.fireSessionReminderRows(rows, "scheduled", now);
    });
  }

  fireSessionRemindersForActivity(
    sessionId: string,
    eventSeq: number,
    reason: Exclude<SessionReminderWakeReason, "scheduled">,
    now: number,
  ): Array<{ userId: string; reminder: SessionReminderView }> {
    // Avoid a write transaction on the session-event hot path when there is no eligible reminder.
    const eligible = this.stmt(
      `SELECT 1 AS found FROM session_reminders r JOIN sessions s ON s.id=r.session_id
       WHERE r.session_id=? AND r.state='pending' AND r.wake_policy='until_activity' AND s.archived=0 LIMIT 1`,
    ).get(sessionId) as { found: number } | undefined;
    if (!eligible) return [];
    return this.atomic(() => {
      const rows = this.stmt(
        `SELECT r.* FROM session_reminders r JOIN sessions s ON s.id=r.session_id
         WHERE r.session_id=? AND r.state='pending' AND r.wake_policy='until_activity'
           AND r.baseline_event_seq<? AND s.archived=0`,
      ).all(sessionId, eventSeq) as unknown as SessionReminderRow[];
      return this.fireSessionReminderRows(rows, reason, now);
    });
  }

  setSessionArchived(id: string, archived: boolean, now: number): void {
    this.stmt("UPDATE sessions SET archived=?, updated_at=? WHERE id=?")
      .run(archived ? 1 : 0, now, id);
  }

  setWorktreePath(id: string, path: string | null): void {
    this.stmt("UPDATE sessions SET worktree_path=? WHERE id=?").run(path, id);
  }

  /** Cost budget lives in its own column so prompt()/createSession config writes never clobber it. */
  private static parseCheckpoints(raw: string | null): number[] | null {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return null;
      const values = parsed.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
      return values.length > 0 ? values : null;
    } catch {
      return null;
    }
  }

  /** Soft cost checkpoints. `null` clears them and forgets the approved level with them. */
  updateSessionCostCheckpoints(id: string, checkpointsUsd: number[] | null, now: number): void {
    this.stmt(
      `UPDATE sessions SET cost_checkpoints_usd=?, cost_checkpoint_approved_usd=CASE WHEN ? IS NULL THEN NULL ELSE cost_checkpoint_approved_usd END, updated_at=? WHERE id=?`,
    ).run(checkpointsUsd ? JSON.stringify(checkpointsUsd) : null, checkpointsUsd ? 1 : null, now, id);
  }

  /** Remembers the highest checkpoint the user approved so it never asks again. */
  approveSessionCostCheckpoint(id: string, checkpointUsd: number, now: number): void {
    this.stmt(
      `UPDATE sessions SET cost_checkpoint_approved_usd=MAX(COALESCE(cost_checkpoint_approved_usd, 0), ?), updated_at=? WHERE id=?`,
    ).run(checkpointUsd, now, id);
  }

  acknowledgeSessionCostUnpriced(id: string, now: number): void {
    this.stmt("UPDATE sessions SET cost_unpriced_ack=1, updated_at=? WHERE id=?").run(now, id);
  }

  /** True when the session has recorded tokens but no record could be priced: a budget on such a
   * session would compare against zero forever. */
  sessionUsageUnpriced(id: string): boolean {
    const row = this.stmt(
      `SELECT input_tokens + output_tokens AS tokens, cost_microusd, cost_remainder_picousd, unpriced_records
         FROM usage_session_state WHERE session_id=?`,
    ).get(id) as { tokens: number; cost_microusd: number; cost_remainder_picousd: number; unpriced_records: number } | undefined;
    if (!row) return false;
    return Number(row.tokens) > 0 && Number(row.unpriced_records) > 0 && Number(row.cost_microusd) === 0 && Number(row.cost_remainder_picousd) === 0;
  }

  getUsageDailyBudget(organizationId: string): UsageDailyBudgetPolicy {
    const row = this.stmt("SELECT per_user_usd, updated_at FROM usage_daily_budget WHERE organization_id=?")
      .get(organizationId) as { per_user_usd: number | null; updated_at: number } | undefined;
    return { perUserUsd: row?.per_user_usd ?? null, updatedAt: row?.updated_at ?? null };
  }

  setUsageDailyBudget(organizationId: string, perUserUsd: number | null, now: number): UsageDailyBudgetPolicy {
    this.stmt(
      `INSERT INTO usage_daily_budget (organization_id, per_user_usd, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(organization_id) DO UPDATE SET per_user_usd=excluded.per_user_usd, updated_at=excluded.updated_at`,
    ).run(organizationId, perUserUsd, now);
    return { perUserUsd, updatedAt: now };
  }

  /** Live, unparked sessions a user owns in an organization: what a daily-budget breach parks. */
  listOpenSessionIdsForOwner(organizationId: string, userId: string): string[] {
    const rows = this.stmt(
      `SELECT s.id FROM sessions s JOIN session_ownership o ON o.session_id=s.id
        WHERE o.organization_id=? AND o.owner_kind='user' AND o.owner_id=?
          AND s.status NOT IN ('completed','failed','stopped') AND s.pending_approval IS NULL
        ORDER BY s.updated_at DESC LIMIT 200`,
    ).all(organizationId, userId) as unknown as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /** The user who owns a session, when it is user-owned; organization and team sessions have no
   * personal daily allowance. */
  sessionOwnerUser(sessionId: string): { organizationId: string; userId: string } | null {
    const row = this.stmt(
      "SELECT organization_id, owner_kind, owner_id FROM session_ownership WHERE session_id=?",
    ).get(sessionId) as { organization_id: string; owner_kind: string; owner_id: string } | undefined;
    return row && row.owner_kind === "user" ? { organizationId: row.organization_id, userId: row.owner_id } : null;
  }

  /** A user's cost since a UTC instant, summed from the owner-scoped buckets (hourly rows plus any
   * daily rollups that start inside the window). Cost only; the ledger is content-free. */
  private userCostSinceMicrousd(organizationId: string, userId: string, since: number): number {
    const row = this.stmt(
      `SELECT COALESCE((SELECT SUM(cost_microusd) FROM usage_hourly
                         WHERE organization_id=? AND owner_kind='user' AND owner_id=? AND bucket_ts>=?), 0)
            + COALESCE((SELECT SUM(cost_microusd) FROM usage_daily
                         WHERE organization_id=? AND owner_kind='user' AND owner_id=? AND bucket_ts>=?), 0) AS microusd`,
    ).get(organizationId, userId, since, organizationId, userId, since) as { microusd: number };
    return Number(row.microusd ?? 0);
  }

  /** One user's cost since the start of the current UTC day: the single figure the daily-budget
   * gate needs on the ingestion path. */
  userCostTodayUsd(organizationId: string, userId: string, now = Date.now()): number {
    return this.userCostSinceMicrousd(organizationId, userId, Math.floor(now / 86_400_000) * 86_400_000) / 1_000_000;
  }

  /** Restores a checkpoint list AND its approved level together, for a failed re-arm rollback. */
  restoreSessionCostCheckpoints(id: string, checkpointsUsd: number[] | null, approvedUsd: number | null, now: number): void {
    this.stmt("UPDATE sessions SET cost_checkpoints_usd=?, cost_checkpoint_approved_usd=?, updated_at=? WHERE id=?")
      .run(checkpointsUsd ? JSON.stringify(checkpointsUsd) : null, checkpointsUsd ? approvedUsd : null, now, id);
  }

  /** The provider status a control-plane card swallowed when it took the slot, if any. */
  policyResumeStatus(id: string): "idle" | null {
    const row = this.stmt("SELECT policy_resume_status FROM sessions WHERE id=?").get(id) as { policy_resume_status: string | null } | undefined;
    return row?.policy_resume_status === "idle" ? "idle" : null;
  }

  /** Today, the last 7 days, and the last 30 days for one user, in UTC days. */
  userCostWindows(organizationId: string, userId: string, now = Date.now()): UserCostWindows {
    const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
    const name = (this.stmt("SELECT display_name FROM identity_users WHERE user_id=?").get(userId) as { display_name: string } | undefined)?.display_name;
    return {
      userId,
      userName: name ?? userId,
      todayUsd: this.userCostSinceMicrousd(organizationId, userId, dayStart) / 1_000_000,
      last7DaysUsd: this.userCostSinceMicrousd(organizationId, userId, dayStart - 6 * 86_400_000) / 1_000_000,
      last30DaysUsd: this.userCostSinceMicrousd(organizationId, userId, dayStart - 29 * 86_400_000) / 1_000_000,
      dailyBudgetUsd: this.getUsageDailyBudget(organizationId).perUserUsd,
    };
  }

  /** Every user with usage in the last 30 days, most spend today first. One aggregate pass with
   * the windows as CASE sums; the bound applies AFTER ordering, so the biggest spenders and anyone
   * paused today are never the rows a cap drops. */
  listUserCostWindows(organizationId: string, now = Date.now()): UserCostWindows[] {
    const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
    const since7 = dayStart - 6 * 86_400_000;
    const since30 = dayStart - 29 * 86_400_000;
    const budget = this.getUsageDailyBudget(organizationId).perUserUsd;
    const rows = this.stmt(
      `SELECT owner_id,
              SUM(CASE WHEN bucket_ts >= ? THEN cost_microusd ELSE 0 END) AS today,
              SUM(CASE WHEN bucket_ts >= ? THEN cost_microusd ELSE 0 END) AS week,
              SUM(cost_microusd) AS month
         FROM (
           SELECT owner_id, bucket_ts, cost_microusd FROM usage_hourly WHERE organization_id=? AND owner_kind='user' AND bucket_ts>=?
           UNION ALL
           SELECT owner_id, bucket_ts, cost_microusd FROM usage_daily WHERE organization_id=? AND owner_kind='user' AND bucket_ts>=?
         )
        GROUP BY owner_id
        ORDER BY today DESC, month DESC, owner_id ASC
        LIMIT 500`,
    ).all(dayStart, since7, organizationId, since30, organizationId, since30) as unknown as Array<{
      owner_id: string; today: number; week: number; month: number;
    }>;
    const nameOf = this.stmt("SELECT display_name FROM identity_users WHERE user_id=?");
    return rows.map((row) => ({
      userId: row.owner_id,
      userName: (nameOf.get(row.owner_id) as { display_name: string } | undefined)?.display_name ?? row.owner_id,
      todayUsd: Number(row.today) / 1_000_000,
      last7DaysUsd: Number(row.week) / 1_000_000,
      last30DaysUsd: Number(row.month) / 1_000_000,
      dailyBudgetUsd: budget,
    }));
  }

  updateSessionCostBudget(id: string, budgetUsd: number | null, now: number, stepUsd = budgetUsd): void {
    this.stmt("UPDATE sessions SET cost_budget_usd=?, cost_budget_step_usd=?, updated_at=? WHERE id=?")
      .run(budgetUsd, stepUsd, now, id);
  }

  /** Tool-call limit — same dedicated-column treatment as the cost budget. NULL ⇒ unlimited. */
  updateSessionMaxToolCalls(id: string, max: number | null, now: number, step = max): void {
    this.stmt("UPDATE sessions SET max_tool_calls=?, max_tool_calls_step=?, updated_at=? WHERE id=?")
      .run(max, step, now, id);
  }

  /** Advance the absolute cost threshold by its original fixed allowance window. */
  rearmSessionCostBudget(id: string, observedCostUsd: number, now: number): number | null {
    const row = this.stmt(
      "SELECT cost_budget_usd AS threshold, cost_budget_step_usd AS step FROM sessions WHERE id=?",
    ).get(id) as { threshold: number | null; step: number | null } | undefined;
    const step = row?.step ?? row?.threshold;
    if (!row?.threshold || !step) return null;
    const next = Math.max(row.threshold, observedCostUsd) + step;
    this.stmt("UPDATE sessions SET cost_budget_usd=?, updated_at=? WHERE id=?").run(next, now, id);
    return next;
  }

  /** Advance the absolute tool threshold by its original fixed allowance window. */
  rearmSessionMaxToolCalls(id: string, observedCalls: number, now: number): number | null {
    const row = this.stmt(
      "SELECT max_tool_calls AS threshold, max_tool_calls_step AS step FROM sessions WHERE id=?",
    ).get(id) as { threshold: number | null; step: number | null } | undefined;
    const step = row?.step ?? row?.threshold;
    if (!row?.threshold || !step) return null;
    const next = Math.max(row.threshold, observedCalls) + step;
    this.stmt("UPDATE sessions SET max_tool_calls=?, updated_at=? WHERE id=?").run(next, now, id);
    return next;
  }

  /**
   * Distinct tool invocations recorded for a session — derived from the event log so it is
   * restart-safe, immune to reprocess/clear drift, and includes hydrated/backfilled history
   * (those tool calls happened). DISTINCT because claude-code emits a tool_call frame per status
   * change of the same invocation (same toolCallId); codex drivers emit one.
   */
  countToolCalls(id: string): number {
    const row = this.stmt(
        "SELECT COUNT(DISTINCT json_extract(payload,'$.toolCallId')) AS c FROM session_events WHERE session_id=? AND kind='tool_call'",
      )
      .get(id) as { c: number };
    return row.c ?? 0;
  }

  updateSessionConfig(id: string, config: SessionConfig, now: number): void {
    const model = config.model ?? null;
    this.stmt("UPDATE sessions SET model=?, resolved_model=CASE WHEN model IS ? THEN resolved_model ELSE NULL END, effort=?, permission_mode=?, updated_at=? WHERE id=?")
      .run(model, model, config.effort ?? null, config.permissionMode ?? null, now, id);
  }

  /** Accumulate a turn's token/cost usage into the session totals. */
  addSessionUsage(
    id: string,
    usage: { inputTokens?: number; outputTokens?: number; costUsd?: number },
    now: number,
  ): void {
    this.stmt(
        `UPDATE sessions
            SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
                cost_usd = cost_usd + ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(usage.inputTokens ?? 0, usage.outputTokens ?? 0, usage.costUsd ?? 0, now, id);
  }

  setPendingApproval(id: string, approval: PendingApproval | null): void {
    this.stmt("UPDATE sessions SET pending_approval=? WHERE id=?")
      .run(approval ? JSON.stringify(approval) : null, id);
  }

  getPolicyHookApproval(sessionId: string, requestId: string): PolicyHookApprovalRecord | null {
    const row = this.stmt(
      `SELECT request_id, session_id, request_fingerprint, governance_policy_id, approval_json, status,
              expires_at, last_polled_at, resume_status, created_at, resolved_at
       FROM policy_hook_approvals WHERE session_id=? AND request_id=?`,
    ).get(sessionId, requestId) as {
      request_id: string;
      session_id: string;
      request_fingerprint: string;
      governance_policy_id: string;
      approval_json: string | null;
      status: PolicyHookApprovalStatus;
      expires_at: number | null;
      last_polled_at: number;
      resume_status: "idle" | null;
      created_at: number;
      resolved_at: number | null;
    } | undefined;
    return row ? {
      requestId: row.request_id,
      sessionId: row.session_id,
      requestFingerprint: row.request_fingerprint,
      governancePolicyId: row.governance_policy_id,
      ...(row.approval_json ? { approval: JSON.parse(row.approval_json) as PendingApproval } : {}),
      status: row.status,
      ...(row.expires_at != null ? { expiresAt: row.expires_at } : {}),
      lastPolledAt: row.last_polled_at,
      ...(row.resume_status ? { resumeStatus: row.resume_status } : {}),
      createdAt: row.created_at,
      ...(row.resolved_at != null ? { resolvedAt: row.resolved_at } : {}),
    } : null;
  }

  /** Atomically claim the session's sole approval slot. Identical retries are idempotent. */
  beginPolicyHookApproval(input: {
    sessionId: string;
    requestId: string;
    requestFingerprint: string;
    governancePolicyId: string;
    approval: PendingApproval;
    expiresAt?: number;
    audits?: Array<Omit<GovernanceAuditEntry, "auditId">>;
    now: number;
  }): BeginPolicyHookApprovalResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getPolicyHookApproval(input.sessionId, input.requestId);
      if (existing) {
        this.db.exec("COMMIT");
        return existing.requestFingerprint === input.requestFingerprint &&
          existing.governancePolicyId === input.governancePolicyId
          ? { kind: "existing", approval: existing }
          : { kind: "conflict", occupiedBy: existing.requestId };
      }
      const session = this.stmt(
        "SELECT pending_approval, policy_resume_status FROM sessions WHERE id=?",
      ).get(input.sessionId) as {
        pending_approval: string | null;
        policy_resume_status: "idle" | null;
      } | undefined;
      if (!session) {
        this.db.exec("COMMIT");
        return { kind: "conflict" };
      }
      const repaired = !session.pending_approval
        ? this.repairPendingPolicyHookCardInTransaction(input.sessionId, input.now)
        : null;
      const status: PolicyHookApprovalStatus = session.pending_approval || repaired ? "queued" : "pending";
      this.stmt(
        `INSERT INTO policy_hook_approvals
         (request_id, session_id, request_fingerprint, governance_policy_id, approval_json, status,
          expires_at, last_polled_at, resume_status, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        input.requestId,
        input.sessionId,
        input.requestFingerprint,
        input.governancePolicyId,
        JSON.stringify(input.approval),
        status,
        input.expiresAt ?? null,
        input.now,
        session.policy_resume_status,
        input.now,
      );
      if (status === "pending") {
        this.stmt(
          "UPDATE sessions SET pending_approval=?, status='input_required', updated_at=? WHERE id=?",
        ).run(JSON.stringify(input.approval), input.now, input.sessionId);
      }
      for (const audit of input.audits ?? []) this.appendGovernanceAudit(audit);
      const created = this.getPolicyHookApproval(input.sessionId, input.requestId)!;
      this.db.exec("COMMIT");
      return { kind: "created", approval: created };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Idempotently persist a non-pausing hook decision (including slot-conflict fail-closed). */
  recordTerminalPolicyHookDecision(input: {
    sessionId: string;
    requestId: string;
    requestFingerprint: string;
    governancePolicyId: string;
    status: "allowed" | "denied";
    approval: PendingApproval;
    audits?: Array<Omit<GovernanceAuditEntry, "auditId">>;
    now: number;
  }): { created: boolean; approval: PolicyHookApprovalRecord } | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.stmt(
        `INSERT INTO policy_hook_approvals
         (request_id, session_id, request_fingerprint, governance_policy_id, approval_json, status,
          expires_at, last_polled_at, resume_status, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)
         ON CONFLICT(request_id) DO NOTHING`,
      ).run(
        input.requestId,
        input.sessionId,
        input.requestFingerprint,
        input.governancePolicyId,
        JSON.stringify(input.approval),
        input.status,
        input.now,
        input.now,
        input.now,
      );
      const approval = this.getPolicyHookApproval(input.sessionId, input.requestId);
      if (!approval || approval.requestFingerprint !== input.requestFingerprint ||
          approval.governancePolicyId !== input.governancePolicyId) {
        this.db.exec("COMMIT");
        return null;
      }
      const created = Number(inserted.changes) === 1;
      if (created) {
        for (const audit of input.audits ?? []) this.appendGovernanceAudit(audit);
      }
      this.db.exec("COMMIT");
      return { created, approval };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Promote the oldest queued hook ask only when the CP-owned/session approval slot is empty. */
  promoteNextPolicyHookApproval(sessionId: string, now: number): PolicyHookApprovalRecord | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const session = this.stmt("SELECT pending_approval, status FROM sessions WHERE id=?")
        .get(sessionId) as { pending_approval: string | null; status: string } | undefined;
      if (!session || !["idle", "starting", "running", "input_required"].includes(session.status)) {
        this.db.exec("COMMIT");
        return null;
      }
      if (session.pending_approval) {
        this.db.exec("COMMIT");
        return null;
      }
      const repaired = this.repairPendingPolicyHookCardInTransaction(sessionId, now);
      if (repaired) {
        this.db.exec("COMMIT");
        return repaired;
      }
      const next = this.stmt(
        `SELECT request_id FROM policy_hook_approvals
         WHERE session_id=? AND status='queued' AND (expires_at IS NULL OR expires_at>?)
         ORDER BY created_at, request_id LIMIT 1`,
      ).get(sessionId, now) as { request_id: string } | undefined;
      if (!next) {
        this.db.exec("COMMIT");
        return null;
      }
      const approval = this.getPolicyHookApproval(sessionId, next.request_id);
      if (!approval?.approval) {
        throw new Error("queued policy-hook approval has no durable card");
      }
      this.stmt(
        "UPDATE policy_hook_approvals SET status='pending' WHERE session_id=? AND request_id=? AND status='queued'",
      ).run(sessionId, next.request_id);
      this.stmt(
        "UPDATE sessions SET pending_approval=?, status='input_required', updated_at=? WHERE id=?",
      ).run(JSON.stringify(approval.approval), now, sessionId);
      const promoted = this.getPolicyHookApproval(sessionId, next.request_id)!;
      this.db.exec("COMMIT");
      return promoted;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Restore a durable pending row whose visible card was cleared by a transient status frame.
   * The caller owns the surrounding IMMEDIATE transaction. */
  private repairPendingPolicyHookCardInTransaction(
    sessionId: string,
    now: number,
  ): PolicyHookApprovalRecord | null {
    const row = this.stmt(
      `SELECT request_id FROM policy_hook_approvals
       WHERE session_id=? AND status='pending' ORDER BY created_at, request_id LIMIT 1`,
    ).get(sessionId) as { request_id: string } | undefined;
    if (!row) return null;
    const pending = this.getPolicyHookApproval(sessionId, row.request_id);
    if (!pending?.approval) throw new Error("pending policy-hook approval has no durable card");
    this.stmt(
      "UPDATE sessions SET pending_approval=?, status='input_required', updated_at=? WHERE id=?",
    ).run(JSON.stringify(pending.approval), now, sessionId);
    return pending;
  }

  touchPolicyHookApproval(sessionId: string, requestId: string, now: number): boolean {
    return Number(this.stmt(
      `UPDATE policy_hook_approvals SET last_polled_at=MAX(last_polled_at, ?)
       WHERE session_id=? AND request_id=? AND status IN ('queued','pending')`,
    ).run(now, sessionId, requestId).changes) === 1;
  }

  /** Remember a runner settle frame swallowed while any CP-owned policy card holds the visible
   * slot. The session marker lets hook rows created later inherit the same provider state. */
  notePolicyResumeStatus(sessionId: string, status: "idle"): number {
    return this.atomic(() => {
      const sessionChange = Number(this.stmt(
        "UPDATE sessions SET policy_resume_status=? WHERE id=?",
      ).run(status, sessionId).changes);
      const rowChanges = Number(this.stmt(
        `UPDATE policy_hook_approvals SET resume_status=?
         WHERE session_id=? AND status IN ('queued','pending')`,
      ).run(status, sessionId).changes);
      return sessionChange + rowChanges;
    });
  }

  /** A later live execution frame invalidates every previously swallowed settle marker. */
  clearPolicyResumeStatus(sessionId: string): number {
    return this.atomic(() => {
      const sessionChange = Number(this.stmt(
        "UPDATE sessions SET policy_resume_status=NULL WHERE id=? AND policy_resume_status IS NOT NULL",
      ).run(sessionId).changes);
      const rowChanges = Number(this.stmt(
        `UPDATE policy_hook_approvals SET resume_status=NULL
         WHERE session_id=? AND status IN ('queued','pending') AND resume_status IS NOT NULL`,
      ).run(sessionId).changes);
      return sessionChange + rowChanges;
    });
  }

  /** Preserve a live ask if another CP-owned card legitimately retakes the visible slot. */
  requeuePolicyHookApproval(sessionId: string, requestId: string): boolean {
    return Number(this.stmt(
      `UPDATE policy_hook_approvals SET status='queued'
       WHERE session_id=? AND request_id=? AND status='pending'`,
    ).run(sessionId, requestId).changes) === 1;
  }

  listExpiredPolicyHookApprovals(now: number, sessionId?: string): PolicyHookApprovalRecord[] {
    const rows = (sessionId
      ? this.stmt(
          `SELECT request_id, session_id FROM policy_hook_approvals
           WHERE session_id=? AND status IN ('queued','pending')
             AND expires_at IS NOT NULL AND expires_at<=?
           ORDER BY expires_at, created_at, request_id`,
        ).all(sessionId, now)
      : this.stmt(
          `SELECT request_id, session_id FROM policy_hook_approvals
           WHERE status IN ('queued','pending') AND expires_at IS NOT NULL AND expires_at<=?
           ORDER BY expires_at, created_at, request_id`,
        ).all(now)) as unknown as Array<{
      request_id: string;
      session_id: string;
    }>;
    return rows.flatMap((row) => {
      const approval = this.getPolicyHookApproval(row.session_id, row.request_id);
      return approval ? [approval] : [];
    });
  }

  listAbandonedPolicyHookApprovals(cutoff: number, sessionId?: string): PolicyHookApprovalRecord[] {
    const rows = (sessionId
      ? this.stmt(
          `SELECT request_id, session_id FROM policy_hook_approvals
           WHERE session_id=? AND status IN ('queued','pending') AND last_polled_at<=?
           ORDER BY last_polled_at, created_at, request_id`,
        ).all(sessionId, cutoff)
      : this.stmt(
          `SELECT request_id, session_id FROM policy_hook_approvals
           WHERE status IN ('queued','pending') AND last_polled_at<=?
           ORDER BY last_polled_at, created_at, request_id`,
        ).all(cutoff)) as unknown as Array<{ request_id: string; session_id: string }>;
    return rows.flatMap((row) => {
      const approval = this.getPolicyHookApproval(row.session_id, row.request_id);
      return approval ? [approval] : [];
    });
  }

  listOpenPolicyHookApprovals(sessionId: string): PolicyHookApprovalRecord[] {
    const rows = this.stmt(
      `SELECT request_id FROM policy_hook_approvals
       WHERE session_id=? AND status IN ('queued','pending') ORDER BY created_at, request_id`,
    ).all(sessionId) as unknown as Array<{ request_id: string }>;
    return rows.flatMap((row) => {
      const approval = this.getPolicyHookApproval(sessionId, row.request_id);
      return approval ? [approval] : [];
    });
  }

  policyHookQueuedSessionIds(sessionId?: string): string[] {
    const rows = sessionId
      ? this.stmt(
          `SELECT DISTINCT session_id FROM policy_hook_approvals
           WHERE session_id=? AND status='queued' ORDER BY session_id`,
        ).all(sessionId)
      : this.stmt(
          `SELECT DISTINCT session_id FROM policy_hook_approvals
           WHERE status='queued' ORDER BY session_id`,
        ).all();
    return (rows as unknown as Array<{ session_id: string }>)
      .map((row) => row.session_id);
  }

  prunePolicyHookDecisions(resolvedBefore: number, limit = 1_000): number {
    const bounded = Math.max(1, Math.min(10_000, Math.trunc(limit)));
    return Number(this.stmt(
      `DELETE FROM policy_hook_approvals WHERE request_id IN (
         SELECT request_id FROM policy_hook_approvals
         WHERE status IN ('allowed','denied','timed_out') AND resolved_at<?
         ORDER BY resolved_at, request_id LIMIT ?
       )`,
    ).run(resolvedBefore, bounded).changes);
  }

  /** Store a terminal hook decision before clearing the dashboard card. */
  resolvePolicyHookApproval(
    sessionId: string,
    requestId: string,
    status: "allowed" | "denied" | "timed_out",
    now: number,
    audit?: Omit<GovernanceAuditEntry, "auditId">,
  ): { changed: boolean; approval: PolicyHookApprovalRecord } | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getPolicyHookApproval(sessionId, requestId);
      if (!existing) {
        this.db.exec("COMMIT");
        return null;
      }
      if (existing.status !== "pending" && existing.status !== "queued") {
        this.db.exec("COMMIT");
        return { changed: false, approval: existing };
      }
      this.stmt(
        `UPDATE policy_hook_approvals SET status=?, resolved_at=?
         WHERE session_id=? AND request_id=? AND status IN ('queued','pending')`,
      ).run(status, now, sessionId, requestId);
      this.stmt(
        `UPDATE sessions
         SET pending_approval=NULL,
             status=CASE WHEN status='input_required' THEN ? ELSE status END,
             updated_at=?
         WHERE id=? AND json_extract(pending_approval, '$.requestId')=?`,
      ).run(existing.resumeStatus ?? "running", now, sessionId, requestId);
      if (audit) this.appendGovernanceAudit(audit);
      const resolved = this.getPolicyHookApproval(sessionId, requestId)!;
      this.db.exec("COMMIT");
      return { changed: true, approval: resolved };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  appendGovernanceAudit(input: Omit<GovernanceAuditEntry, "auditId">): GovernanceAuditEntry {
    const entry: GovernanceAuditEntry = { ...input, auditId: randomUUID() };
    this.stmt(
      `INSERT INTO governance_audit
       (audit_id, session_id, request_id, approval_kind, stage, outcome, actor_kind, actor_id,
        scope, content_digest, policy_rule, governance_policy_id, option_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.auditId,
      entry.scope.sessionId,
      entry.requestId,
      entry.approvalKind,
      entry.stage,
      entry.outcome,
      entry.actor.kind,
      entry.actor.id ?? null,
      JSON.stringify(entry.scope),
      entry.contentDigest ?? null,
      entry.policyRule ? JSON.stringify(entry.policyRule) : null,
      entry.governancePolicyId ?? null,
      entry.optionId ?? null,
      entry.timestamp,
    );
    return entry;
  }

  hasGovernanceAuditEntry(
    sessionId: string,
    requestId: string,
    stage: GovernanceAuditEntry["stage"],
    outcome: GovernanceAuditEntry["outcome"],
  ): boolean {
    return Boolean(this.stmt(
      `SELECT 1 FROM governance_audit
       WHERE session_id=? AND request_id=? AND stage=? AND outcome=? LIMIT 1`,
    ).get(sessionId, requestId, stage, outcome));
  }

  pruneGovernanceAudit(createdBefore: number, limit = 1_000): number {
    const bounded = Math.max(1, Math.min(10_000, Math.trunc(limit)));
    return Number(this.stmt(
      `DELETE FROM governance_audit WHERE row_id IN (
         SELECT row_id FROM governance_audit
         WHERE created_at<?
         ORDER BY created_at, row_id LIMIT ?
       )`,
    ).run(createdBefore, bounded).changes);
  }

  /** Latest bounded audit window returned oldest-first for a stable timeline. */
  listGovernanceAudit(sessionId: string, limit = 200): GovernanceAuditEntry[] {
    const normalized = Number.isFinite(limit) ? Math.trunc(limit) : 200;
    const bounded = Math.max(1, Math.min(500, normalized));
    const rows = this.stmt(
      `SELECT audit_id, request_id, approval_kind, stage, outcome, actor_kind, actor_id,
              scope, content_digest, policy_rule, governance_policy_id, option_id, created_at
       FROM governance_audit WHERE session_id=?
       ORDER BY created_at DESC, row_id DESC LIMIT ?`,
    ).all(sessionId, bounded) as unknown as Array<{
      audit_id: string;
      request_id: string;
      approval_kind: GovernanceAuditEntry["approvalKind"];
      stage: GovernanceAuditEntry["stage"];
      outcome: GovernanceAuditEntry["outcome"];
      actor_kind: GovernanceAuditEntry["actor"]["kind"];
      actor_id: string | null;
      scope: string;
      content_digest: string | null;
      policy_rule: string | null;
      governance_policy_id: string | null;
      option_id: string | null;
      created_at: number;
    }>;
    return rows.reverse().map((row) => ({
      auditId: row.audit_id,
      requestId: row.request_id,
      approvalKind: row.approval_kind,
      stage: row.stage,
      outcome: row.outcome,
      actor: { kind: row.actor_kind, ...(row.actor_id ? { id: row.actor_id } : {}) },
      scope: JSON.parse(row.scope) as GovernanceAuditEntry["scope"],
      ...(row.content_digest ? { contentDigest: row.content_digest } : {}),
      ...(row.policy_rule ? { policyRule: JSON.parse(row.policy_rule) as GovernanceAuditEntry["policyRule"] } : {}),
      ...(row.governance_policy_id ? { governancePolicyId: row.governance_policy_id } : {}),
      ...(row.option_id ? { optionId: row.option_id } : {}),
      timestamp: row.created_at,
    }));
  }

  governanceRequestProvenance(sessionId: string, requestId: string): ApprovalQueueProvenance | null {
    const row = this.stmt(
      `SELECT audit_id, actor_kind, actor_id, scope, content_digest, governance_policy_id, created_at
       FROM governance_audit
       WHERE session_id=? AND request_id=? AND stage='request'
       ORDER BY created_at DESC, row_id DESC LIMIT 1`,
    ).get(sessionId, requestId) as unknown as {
      audit_id: string;
      actor_kind: ApprovalQueueProvenance["actor"]["kind"];
      actor_id: string | null;
      scope: string;
      content_digest: string | null;
      governance_policy_id: string | null;
      created_at: number;
    } | undefined;
    if (!row) return null;
    return {
      source: "audit",
      requestedAt: row.created_at,
      actor: { kind: row.actor_kind, ...(row.actor_id ? { id: row.actor_id } : {}) },
      scope: JSON.parse(row.scope) as ApprovalQueueProvenance["scope"],
      auditId: row.audit_id,
      ...(row.content_digest ? { contentDigest: row.content_digest } : {}),
      ...(row.governance_policy_id ? { governancePolicyId: row.governance_policy_id } : {}),
    };
  }

  listGovernancePolicies(): GovernancePolicy[] {
    const rows = this.stmt(
      `SELECT policy_id, name, effect, priority, enabled, scope, conditions, ask_timeout,
              created_at, updated_at
       FROM governance_policies ORDER BY priority DESC, policy_id`,
    ).all() as unknown as Array<{
      policy_id: string;
      name: string;
      effect: GovernancePolicy["effect"];
      priority: number;
      enabled: number;
      scope: string;
      conditions: string | null;
      ask_timeout: number | null;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      policyId: row.policy_id,
      name: row.name,
      effect: row.effect,
      priority: row.priority,
      enabled: row.enabled === 1,
      scope: JSON.parse(row.scope) as GovernancePolicy["scope"],
      ...(row.conditions ? { conditions: JSON.parse(row.conditions) as GovernancePolicy["conditions"] } : {}),
      ...(row.ask_timeout != null ? { askTimeout: row.ask_timeout } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  upsertGovernancePolicy(
    input: Omit<GovernancePolicy, "createdAt" | "updatedAt" | "builtin">,
    now: number,
  ): GovernancePolicy {
    this.stmt(
      `INSERT INTO governance_policies
       (policy_id, name, effect, priority, enabled, scope, conditions, ask_timeout, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(policy_id) DO UPDATE SET
         name=excluded.name, effect=excluded.effect, priority=excluded.priority,
         enabled=excluded.enabled, scope=excluded.scope, conditions=excluded.conditions,
         ask_timeout=excluded.ask_timeout,
         updated_at=excluded.updated_at`,
    ).run(
      input.policyId,
      input.name,
      input.effect,
      input.priority,
      input.enabled ? 1 : 0,
      JSON.stringify(input.scope),
      input.conditions ? JSON.stringify(input.conditions) : null,
      input.askTimeout ?? null,
      now,
      now,
    );
    return this.listGovernancePolicies().find((policy) => policy.policyId === input.policyId)!;
  }

  deleteGovernancePolicy(policyId: string): boolean {
    return Number(this.stmt("DELETE FROM governance_policies WHERE policy_id=?").run(policyId).changes) > 0;
  }

  nextShellName(sessionId: string): string {
    const row = this.stmt(
      `INSERT INTO session_shell_name_seq (session_id, value) VALUES (?, 1)
       ON CONFLICT(session_id) DO UPDATE SET value=value+1 RETURNING value`,
    ).get(sessionId) as { value: number };
    return `Shell ${row.value}`;
  }

  createShell(input: {
    shellId: string;
    sessionId: string;
    runnerId: string;
    name: string;
    createdAt: number;
    pty?: boolean;
    kind?: ShellKind;
  }): ShellView {
    this.stmt(
      `INSERT INTO session_shells
       (shell_id, session_id, runner_id, name, created_at, pty, kind, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
    ).run(
      input.shellId,
      input.sessionId,
      input.runnerId,
      input.name,
      input.createdAt,
      input.pty ? 1 : 0,
      input.kind ?? "shell",
      input.createdAt,
    );
    return this.getShell(input.shellId)!;
  }

  setShellPty(shellId: string, pty: boolean, now: number): ShellView | null {
    this.stmt("UPDATE session_shells SET pty=?, updated_at=? WHERE shell_id=?").run(pty ? 1 : 0, now, shellId);
    return this.getShell(shellId);
  }

  getShell(shellId: string): (ShellView & { runnerId: string }) | null {
    const row = this.stmt("SELECT * FROM session_shells WHERE shell_id=?").get(shellId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.shellView(row) : null;
  }

  listShells(sessionId: string): ShellView[] {
    const rows = this.stmt(
      "SELECT * FROM session_shells WHERE session_id=? ORDER BY created_at, shell_id",
    ).all(sessionId) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => this.shellView(row));
  }

  appendShellOutput(
    runnerId: string,
    shellId: string,
    chunk: Omit<ShellOutputChunk, "seq"> & { seq?: number },
    now: number,
  ): ShellOutputChunk | null {
    const shell = this.getShell(shellId);
    if (!shell || shell.runnerId !== runnerId || shell.status === "exited") return null;
    const seq = chunk.seq ?? (shell.outputEndSeq ?? 0) + 1;
    if (!Number.isSafeInteger(seq) || seq < 1) return null;
    return this.atomic(() => {
      const inserted = this.stmt(
        "INSERT OR IGNORE INTO session_shell_output (shell_id, seq, stream, data) VALUES (?, ?, ?, ?)",
      ).run(shellId, seq, chunk.stream, chunk.data);
      if (Number(inserted.changes) === 0) return null;
      this.stmt(
        `UPDATE session_shells SET status='running', updated_at=?,
         output_end_seq=MAX(output_end_seq, ?) WHERE shell_id=?`,
      ).run(now, seq, shellId);
      this.pruneShellOutput(shellId);
      return { seq, stream: chunk.stream, data: chunk.data };
    });
  }

  shellHistory(shellId: string, after: number, limit: number): ShellHistoryPage | null {
    const shell = this.getShell(shellId);
    if (!shell) return null;
    const rows = this.stmt(
      `SELECT seq, stream, data FROM session_shell_output
       WHERE shell_id=? AND seq>? ORDER BY seq LIMIT ?`,
    ).all(shellId, after, limit + 1) as unknown as Array<{ seq: number; stream: "stdout" | "stderr"; data: string }>;
    const chunks = rows.slice(0, limit).map((row) => ({ seq: row.seq, stream: row.stream, data: row.data }));
    const nextAfter = chunks.at(-1)?.seq ?? after;
    return {
      shellId,
      chunks,
      nextAfter,
      hasMore: rows.length > limit,
      truncatedBefore: Boolean(shell.outputTruncated && after < (shell.outputStartSeq ?? 1) - 1),
    };
  }

  applyShellSnapshot(runnerId: string, snapshot: ShellSnapshotMessage, now: number): ShellView | null {
    const tombstone = this.stmt("SELECT 1 AS present FROM session_shell_tombstones WHERE shell_id=?").get(snapshot.shellId);
    if (tombstone) return null;
    const session = this.stmt("SELECT runner_id FROM sessions WHERE id=?").get(snapshot.sessionId) as
      | { runner_id: string }
      | undefined;
    if (!session || session.runner_id !== runnerId) return null;
    return this.atomic(() => {
      this.stmt(
        `INSERT INTO session_shells
         (shell_id, session_id, runner_id, name, created_at, pty, kind, status, exit_code,
          updated_at, output_start_seq, output_end_seq, output_truncated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shell_id) DO UPDATE SET
           session_id=excluded.session_id, runner_id=excluded.runner_id, name=excluded.name,
           created_at=excluded.created_at, pty=excluded.pty, kind=excluded.kind,
           status=excluded.status, exit_code=excluded.exit_code, updated_at=excluded.updated_at,
           output_start_seq=MIN(session_shells.output_start_seq, excluded.output_start_seq),
           output_end_seq=MAX(session_shells.output_end_seq, excluded.output_end_seq),
           output_truncated=MAX(session_shells.output_truncated, excluded.output_truncated)`,
      ).run(
        snapshot.shellId,
        snapshot.sessionId,
        runnerId,
        snapshot.name,
        snapshot.createdAt,
        snapshot.pty ? 1 : 0,
        snapshot.kind,
        snapshot.status,
        snapshot.exitCode,
        now,
        snapshot.outputStartSeq,
        snapshot.outputEndSeq,
        snapshot.outputTruncated ? 1 : 0,
      );
      for (const chunk of snapshot.chunks) {
        this.stmt(
          "INSERT OR IGNORE INTO session_shell_output (shell_id, seq, stream, data) VALUES (?, ?, ?, ?)",
        ).run(snapshot.shellId, chunk.seq, chunk.stream, chunk.data);
      }
      this.pruneShellOutput(snapshot.shellId, true);
      return this.getShell(snapshot.shellId);
    });
  }

  markRunnerShellsReconnecting(runnerId: string, now: number): ShellView[] {
    this.stmt(
      "UPDATE session_shells SET status='reconnecting', updated_at=? WHERE runner_id=? AND status='running'",
    ).run(now, runnerId);
    return this.listRunnerShells(runnerId, "reconnecting");
  }

  markAllRunningShellsReconnecting(now: number): number {
    return Number(this.stmt(
      "UPDATE session_shells SET status='reconnecting', updated_at=? WHERE status='running'",
    ).run(now).changes);
  }

  completeShellInventory(runnerId: string, shellIds: string[], now: number): ShellView[] {
    const retained = new Set(shellIds);
    const missing = this.listRunnerShells(runnerId).filter(
      // The inventory is a point-in-time reconnect fence. A shell opened after the runner built
      // that snapshot is already `running` and must not be mistaken for a missing old process.
      (shell) => shell.status === "reconnecting" && !retained.has(shell.shellId),
    );
    for (const shell of missing) {
      this.stmt(
        "UPDATE session_shells SET status='exited', exit_code=NULL, updated_at=? WHERE shell_id=?",
      ).run(now, shell.shellId);
    }
    for (const shellId of this.pendingShellCloseIds(runnerId)) {
      if (!retained.has(shellId)) {
        this.stmt("DELETE FROM session_shell_tombstones WHERE shell_id=? AND runner_id=?").run(shellId, runnerId);
      }
    }
    return missing.map((shell) => ({ ...shell, status: "exited", exitCode: null, updatedAt: now }));
  }

  exitShell(runnerId: string, shellId: string, code: number | null, outputSeq: number | undefined, now: number): ShellView | null {
    const shell = this.getShell(shellId);
    if (!shell || shell.runnerId !== runnerId) {
      this.stmt("DELETE FROM session_shell_tombstones WHERE shell_id=? AND runner_id=?").run(shellId, runnerId);
      return null;
    }
    this.stmt(
      `UPDATE session_shells SET status='exited', exit_code=?, updated_at=?,
       output_end_seq=MAX(output_end_seq, ?) WHERE shell_id=?`,
    ).run(code, now, outputSeq ?? shell.outputEndSeq ?? 0, shellId);
    return this.getShell(shellId);
  }

  deleteShell(shellId: string, runnerId: string, now: number): boolean {
    this.stmt(
      "INSERT OR REPLACE INTO session_shell_tombstones (shell_id, runner_id, deleted_at) VALUES (?, ?, ?)",
    ).run(shellId, runnerId, now);
    return Number(this.stmt("DELETE FROM session_shells WHERE shell_id=?").run(shellId).changes) > 0;
  }

  /** A definitive shell_open_result(ok:false) proves no runner process exists. Remove the
   * optimistic row without a resurrection tombstone; timeouts and malformed replies still use
   * deleteShell because their runner-side outcome is ambiguous. */
  discardUnopenedShell(shellId: string, runnerId: string): boolean {
    return Number(this.stmt(
      "DELETE FROM session_shells WHERE shell_id=? AND runner_id=?",
    ).run(shellId, runnerId).changes) > 0;
  }

  pendingShellCloseIds(runnerId: string): string[] {
    const rows = this.stmt(
      "SELECT shell_id FROM session_shell_tombstones WHERE runner_id=? ORDER BY deleted_at, shell_id",
    ).all(runnerId) as unknown as Array<{ shell_id: string }>;
    return rows.map((row) => row.shell_id);
  }

  deleteShellsForSession(sessionId: string): void {
    const rows = this.stmt("SELECT shell_id, runner_id FROM session_shells WHERE session_id=?").all(sessionId) as unknown as
      Array<{ shell_id: string; runner_id: string }>;
    const now = Date.now();
    for (const row of rows) {
      this.stmt(
        "INSERT OR REPLACE INTO session_shell_tombstones (shell_id, runner_id, deleted_at) VALUES (?, ?, ?)",
      ).run(row.shell_id, row.runner_id, now);
    }
    this.stmt("DELETE FROM session_shells WHERE session_id=?").run(sessionId);
  }

  private listRunnerShells(runnerId: string, status?: ShellStatus): Array<ShellView & { runnerId: string }> {
    const rows = (status
      ? this.stmt("SELECT * FROM session_shells WHERE runner_id=? AND status=?").all(runnerId, status)
      : this.stmt("SELECT * FROM session_shells WHERE runner_id=?").all(runnerId)) as unknown as
      Array<Record<string, unknown>>;
    return rows.map((row) => this.shellView(row));
  }

  private pruneShellOutput(shellId: string, bulk = false): void {
    let stats = this.stmt(
      "SELECT output_chars AS chars, output_chunks AS chunks, output_end_seq AS endSeq FROM session_shells WHERE shell_id=?",
    ).get(shellId) as { chars: number; chunks: number; endSeq: number } | undefined;
    if (!stats) return;
    if (stats.chars <= 200_000 && stats.chunks <= 2048) return;
    let pruned = false;
    if (bulk) {
      // Snapshot replay can introduce thousands of over-cap chunks at once. Find the earliest
      // suffix satisfying both limits with one window scan, then prune the whole prefix in one
      // statement. Live appends retain the incremental one-row fast path below.
      const firstKept = this.stmt(
        `SELECT seq FROM (
           SELECT seq,
             COUNT(*) OVER (ORDER BY seq DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS kept_chunks,
             SUM(LENGTH(data)) OVER (ORDER BY seq DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS kept_chars
           FROM session_shell_output WHERE shell_id=?
         ) retained
         WHERE kept_chunks<=2048 AND kept_chars<=200000
         ORDER BY seq LIMIT 1`,
      ).get(shellId) as { seq: number } | undefined;
      const deleted = firstKept
        ? this.stmt("DELETE FROM session_shell_output WHERE shell_id=? AND seq<?").run(shellId, firstKept.seq)
        : this.stmt("DELETE FROM session_shell_output WHERE shell_id=?").run(shellId);
      pruned = Number(deleted.changes) > 0;
      stats = this.stmt(
        "SELECT output_chars AS chars, output_chunks AS chunks, output_end_seq AS endSeq FROM session_shells WHERE shell_id=?",
      ).get(shellId) as { chars: number; chunks: number; endSeq: number };
    } else {
      while (stats.chars > 200_000 || stats.chunks > 2048) {
        const oldest = this.stmt(
          "SELECT seq FROM session_shell_output WHERE shell_id=? ORDER BY seq LIMIT 1",
        ).get(shellId) as { seq: number } | undefined;
        if (!oldest) break;
        this.stmt("DELETE FROM session_shell_output WHERE shell_id=? AND seq=?").run(shellId, oldest.seq);
        pruned = true;
        stats = this.stmt(
          "SELECT output_chars AS chars, output_chunks AS chunks, output_end_seq AS endSeq FROM session_shells WHERE shell_id=?",
        ).get(shellId) as { chars: number; chunks: number; endSeq: number };
      }
    }
    const first = this.stmt(
      "SELECT seq FROM session_shell_output WHERE shell_id=? ORDER BY seq LIMIT 1",
    ).get(shellId) as { seq: number } | undefined;
    this.stmt(
      `UPDATE session_shells SET output_start_seq=?,
       output_truncated=MAX(output_truncated, ?) WHERE shell_id=?`,
    ).run(first?.seq ?? stats.endSeq + 1, pruned ? 1 : 0, shellId);
  }

  private shellView(row: Record<string, unknown>): ShellView & { runnerId: string } {
    return {
      shellId: String(row.shell_id),
      sessionId: String(row.session_id),
      runnerId: String(row.runner_id),
      name: String(row.name),
      createdAt: Number(row.created_at),
      pty: Number(row.pty) === 1,
      kind: row.kind === "agent_tui" ? "agent_tui" : "shell",
      status: row.status as ShellStatus,
      exitCode: row.exit_code == null ? null : Number(row.exit_code),
      updatedAt: Number(row.updated_at),
      outputStartSeq: Number(row.output_start_seq),
      outputEndSeq: Number(row.output_end_seq),
      outputTruncated: Number(row.output_truncated) === 1,
    };
  }

  deleteSession(id: string): void {
    // multi_agent_run_members has no FK to sessions, so clean its rows up too,
    // otherwise a run keeps a dangling member id. Same for the FTS index (virtual
    // tables have no FKs — stale hits would surface deleted sessions in search).
    this.stmt("DELETE FROM multi_agent_run_members WHERE session_id=?").run(id);
    this.stmt("DELETE FROM session_forks WHERE target_session_id=?").run(id);
    this.stmt("DELETE FROM session_side_chats WHERE parent_session_id=? OR child_session_id=?").run(id, id);
    this.deleteShellsForSession(id);
    // Session-only artifacts follow an explicit session deletion. Run-owned artifacts retain the
    // session id as provenance and live until their durable workflow run is deleted.
    this.stmt("DELETE FROM artifacts WHERE session_id=? AND run_id IS NULL").run(id);
    this.stmt("DELETE FROM session_events_fts WHERE session_id=?").run(id);
    this.stmt("DELETE FROM sessions WHERE id=?").run(id);
    this.collectWorkflowArtifactBlobs();
  }

  /** Replace the hash-only credential accepted for one exact session's policy-hook route. */
  setPolicyHookCredential(sessionId: string, runnerId: string, tokenHash: string, now: number): boolean {
    if (!/^[0-9a-f]{64}$/u.test(tokenHash)) return false;
    const owned = this.stmt("SELECT 1 FROM sessions WHERE id=? AND runner_id=?")
      .get(sessionId, runnerId);
    if (!owned) return false;
    this.stmt(
      `INSERT INTO policy_hook_credentials (session_id, runner_id, token_hash, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         runner_id=excluded.runner_id,
         token_hash=excluded.token_hash,
         updated_at=excluded.updated_at`,
    ).run(sessionId, runnerId, tokenHash, now);
    return true;
  }

  policyHookCredentialValid(sessionId: string, runnerId: string, tokenHash: string): boolean {
    if (!/^[0-9a-f]{64}$/u.test(tokenHash)) return false;
    return Boolean(this.stmt(
      `SELECT 1 FROM policy_hook_credentials
       WHERE session_id=? AND runner_id=? AND token_hash=?`,
    ).get(sessionId, runnerId, tokenHash));
  }

  /** Replace the hash-only credential accepted for one exact session's CLI/MCP surface. */
  setAgentControlCredential(sessionId: string, runnerId: string, tokenHash: string, now: number): boolean {
    if (!/^[0-9a-f]{64}$/u.test(tokenHash)) return false;
    const owned = this.stmt("SELECT 1 FROM sessions WHERE id=? AND runner_id=?").get(sessionId, runnerId);
    if (!owned) return false;
    this.stmt(
      `INSERT INTO agent_control_credentials (session_id, runner_id, token_hash, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         runner_id=excluded.runner_id,
         token_hash=excluded.token_hash,
         updated_at=excluded.updated_at`,
    ).run(sessionId, runnerId, tokenHash, now);
    return true;
  }

  agentControlCredentialValid(sessionId: string, runnerId: string, tokenHash: string): boolean {
    if (!/^[0-9a-f]{64}$/u.test(tokenHash)) return false;
    return Boolean(this.stmt(
      `SELECT 1 FROM agent_control_credentials
       WHERE session_id=? AND runner_id=? AND token_hash=?`,
    ).get(sessionId, runnerId, tokenHash));
  }

  /** Full-text transcript search across all sessions (Cmd+K). The raw query is normalized
   * into quoted FTS terms so user input can never hit FTS5 syntax errors or operators.
   * Results are grouped to DISTINCT sessions (best-ranked hit each) by overfetching raw
   * rows — one chatty session would otherwise consume the whole row budget and collapse to
   * a single visible result, hiding every other matching session. */
  searchEvents(q: string, limit = 20, authorizedSessionIds?: readonly string[]): { sessionId: string; seq: number; snippet: string }[] {
    const match = q
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 16)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(" ");
    if (!match) return [];
    if (authorizedSessionIds?.length === 0) return [];
    const authorization = authorizedSessionIds
      ? " AND session_id IN (SELECT value FROM json_each(?))"
      : "";
    const rows = this.stmt(
      `SELECT session_id, seq, snippet(session_events_fts, 0, '⟪', '⟫', '…', 10) AS snip
         FROM session_events_fts WHERE session_events_fts MATCH ?${authorization} ORDER BY rank LIMIT ?`,
    ).all(...(authorizedSessionIds ? [match, JSON.stringify(authorizedSessionIds), limit * 10] : [match, limit * 10])) as unknown as { session_id: string; seq: number; snip: string }[];
    const out: { sessionId: string; seq: number; snippet: string }[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.session_id)) continue;
      seen.add(r.session_id);
      out.push({ sessionId: r.session_id, seq: r.seq, snippet: r.snip });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Bounded transcript search with principal authorization inside the ranked FTS query. */
  searchEventsForPrincipal(
    q: string,
    limit: number,
    principal: AuthPrincipal,
  ): { sessionId: string; seq: number; snippet: string }[] {
    const match = q
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 16)
      .map((term) => `"${term.replace(/"/g, '""')}"`)
      .join(" ");
    if (!match) return [];
    const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    const authorization = this.sessionAuthorizationSql(principal);
    const rows = this.stmt(
      `SELECT session_events_fts.session_id, session_events_fts.seq,
              snippet(session_events_fts, 0, '⟪', '⟫', '…', 10) AS snip
       FROM session_events_fts
       JOIN session_ownership ownership ON ownership.session_id=session_events_fts.session_id
       WHERE session_events_fts MATCH ? AND ${authorization.sql}
       ORDER BY rank LIMIT ?`,
    ).all(match, ...authorization.params, boundedLimit * 10) as unknown as Array<{
      session_id: string; seq: number; snip: string;
    }>;
    const results: { sessionId: string; seq: number; snippet: string }[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.session_id)) continue;
      seen.add(row.session_id);
      results.push({ sessionId: row.session_id, seq: row.seq, snippet: row.snip });
      if (results.length >= boundedLimit) break;
    }
    return results;
  }

  /* ---- Phase 2: tombstones so the runner store can't resurrect a UI-deleted session ---- */


  private sessionStopIntentRecord(row: SessionStopIntentRow): SessionStopIntentRecord {
    const failed = row.failed_at !== null;
    const code = row.failure_code as ArchiveStopFailureCode | null;
    const status: ArchiveStatus = failed ? "stop_failed" : "stop_pending";
    return {
      sessionId: row.session_id,
      runnerId: row.runner_id,
      restartLaunchId: row.restart_launch_id,
      archiveAfterStop: row.archive_after_stop === 1,
      deliveryAttemptId: row.delivery_attempt_id,
      operation: {
        operationId: row.operation_id,
        status,
        requestedAt: row.created_at,
        lastAttemptAt: row.last_attempt_at,
        attemptCount: row.attempt_count,
        ...(row.accepted_at !== null ? { acceptedAt: row.accepted_at } : {}),
        capacityReleased: false,
        ...(failed && code && row.failure_message
          ? { failure: { code, message: row.failure_message, failedAt: row.failed_at! } }
          : {}),
      },
    };
  }

  sessionStopIntent(sessionId: string): SessionStopIntentRecord | undefined {
    const row = this.stmt("SELECT * FROM session_stop_intents WHERE session_id=?")
      .get(sessionId) as unknown as SessionStopIntentRow | undefined;
    return row ? this.sessionStopIntentRecord(row) : undefined;
  }

  addSessionStopIntent(
    sessionId: string,
    runnerId: string,
    now: number,
    archiveAfterStop = false,
  ): SessionStopIntentRecord {
    const operationId = "stop_" + randomUUID();
    const deliveryAttemptId = "stop_delivery_" + randomUUID();
    this.stmt(
      "INSERT INTO session_stop_intents " +
      "(session_id, runner_id, created_at, archive_after_stop, operation_id, last_attempt_at, attempt_count, delivery_attempt_id) " +
      "VALUES (?, ?, ?, ?, ?, ?, 1, ?) " +
      "ON CONFLICT(session_id) DO UPDATE SET " +
      "runner_id=excluded.runner_id, restart_launch_id=NULL, " +
      "created_at=CASE WHEN session_stop_intents.archive_after_stop=0 " +
        "AND excluded.archive_after_stop=1 AND session_stop_intents.failed_at IS NULL " +
        "THEN excluded.created_at ELSE session_stop_intents.created_at END, " +
      "last_attempt_at=CASE WHEN session_stop_intents.archive_after_stop=0 " +
        "AND excluded.archive_after_stop=1 AND session_stop_intents.failed_at IS NULL " +
        "THEN excluded.last_attempt_at ELSE session_stop_intents.last_attempt_at END, " +
      "attempt_count=CASE WHEN session_stop_intents.archive_after_stop=0 " +
        "AND excluded.archive_after_stop=1 AND session_stop_intents.failed_at IS NULL " +
        "THEN 1 ELSE session_stop_intents.attempt_count END, " +
      "delivery_attempt_id=CASE WHEN session_stop_intents.archive_after_stop=0 " +
        "AND excluded.archive_after_stop=1 AND session_stop_intents.failed_at IS NULL " +
        "THEN excluded.delivery_attempt_id ELSE session_stop_intents.delivery_attempt_id END, " +
      "accepted_at=CASE WHEN session_stop_intents.archive_after_stop=0 " +
        "AND excluded.archive_after_stop=1 AND session_stop_intents.failed_at IS NULL " +
        "THEN NULL ELSE session_stop_intents.accepted_at END, " +
      "archive_after_stop=MAX(session_stop_intents.archive_after_stop, excluded.archive_after_stop)",
    ).run(sessionId, runnerId, now, archiveAfterStop ? 1 : 0, operationId, now, deliveryAttemptId);
    return this.sessionStopIntent(sessionId)!;
  }

  hasSessionStopIntent(sessionId: string): boolean {
    return this.stmt("SELECT 1 FROM session_stop_intents WHERE session_id=?").get(sessionId) != null;
  }

  removeSessionStopIntent(sessionId: string): void {
    this.stmt("DELETE FROM session_stop_intents WHERE session_id=?").run(sessionId);
  }

  sessionArchiveOperation(sessionId: string): StopOperationView | undefined {
    const intent = this.sessionStopIntent(sessionId);
    return intent?.archiveAfterStop ? intent.operation : undefined;
  }

  private sessionStopIntents(): Map<string, SessionStopIntentRecord> {
    const rows = this.stmt(
      "SELECT * FROM session_stop_intents",
    ).all() as unknown as SessionStopIntentRow[];
    return new Map(rows.map((row) => [row.session_id, this.sessionStopIntentRecord(row)]));
  }

  sessionArchiveStatus(sessionId: string): ArchiveStatus | undefined {
    return this.sessionArchiveOperation(sessionId)?.status;
  }

  /** Re-arm one failed operation without changing its durable identity. Duplicate requests that
   * observe it pending are no-ops, so concurrent clients cannot multiply attempts. */
  retrySessionStopIntent(sessionId: string, now: number): SessionStopIntentRecord | undefined {
    return this.atomic(() => {
      const existing = this.sessionStopIntent(sessionId);
      if (!existing) return undefined;
      if (existing.operation.status === "stop_failed") {
        const deliveryAttemptId = "stop_delivery_" + randomUUID();
        this.stmt(
          "UPDATE session_stop_intents " +
          "SET created_at=?, failed_at=NULL, failure_code=NULL, failure_message=NULL, delivery_attempt_id=?, " +
          "last_attempt_at=?, attempt_count=1, accepted_at=NULL, restart_launch_id=NULL " +
          "WHERE session_id=? AND failed_at IS NOT NULL",
        ).run(now, deliveryAttemptId, now, sessionId);
      }
      return this.sessionStopIntent(sessionId);
    });
  }

  recordSessionStopAttempt(sessionId: string, now: number): SessionStopIntentRecord | undefined {
    const deliveryAttemptId = "stop_delivery_" + randomUUID();
    this.stmt(
      "UPDATE session_stop_intents " +
      "SET last_attempt_at=?, attempt_count=attempt_count+1, delivery_attempt_id=? " +
      "WHERE session_id=? AND failed_at IS NULL AND accepted_at IS NULL",
    ).run(now, deliveryAttemptId, sessionId);
    return this.sessionStopIntent(sessionId);
  }

  /** Open a new attempt-correlated delivery boundary for an automatic recovery replay while
   * retaining the visible failure. Only timeout and retry-exhausted failures are recoverable;
   * an explicit runner rejection is never eligible for invisible replay. */
  recordSessionStopRecoveryAttempt(sessionId: string, now: number): SessionStopIntentRecord | undefined {
    const deliveryAttemptId = "stop_delivery_" + randomUUID();
    const changed = this.stmt(
      "UPDATE session_stop_intents " +
      "SET last_attempt_at=?, attempt_count=attempt_count+1, delivery_attempt_id=?, accepted_at=NULL " +
      "WHERE session_id=? AND failed_at IS NOT NULL AND last_attempt_at<=failed_at " +
      "AND failure_code IN ('timeout', 'retry_exhausted')",
    ).run(now, deliveryAttemptId, sessionId);
    return Number(changed.changes) === 1 ? this.sessionStopIntent(sessionId) : undefined;
  }

  /** Persist correlated runner acceptance for the current delivery. A late acceptance may repair
   * a local timeout/exhaustion projection, but never overrides an explicit runner rejection. */
  recordSessionStopAcceptance(
    sessionId: string,
    operationId: string,
    deliveryAttemptId: string,
    now: number,
  ): boolean {
    const changed = this.stmt(
      "UPDATE session_stop_intents " +
      "SET accepted_at=?, failed_at=NULL, failure_code=NULL, failure_message=NULL " +
      "WHERE session_id=? AND operation_id=? AND delivery_attempt_id=? AND accepted_at IS NULL AND " +
      "(failed_at IS NULL OR failure_code IN ('timeout', 'retry_exhausted'))",
    ).run(now, sessionId, operationId, deliveryAttemptId);
    return Number(changed.changes) === 1;
  }

  failSessionStopIntent(
    sessionId: string,
    operationId: string,
    deliveryAttemptId: string,
    code: ArchiveStopFailureCode,
    message: string,
    now: number,
  ): boolean {
    if (!["timeout", "retry_exhausted", "runner_rejected"].includes(code)) return false;
    const bounded = message.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 240);
    const changed = this.stmt(
      "UPDATE session_stop_intents " +
      "SET failed_at=?, failure_code=?, failure_message=? " +
      "WHERE session_id=? AND operation_id=? AND delivery_attempt_id=? AND " +
      "(failed_at IS NULL OR (?='runner_rejected' AND failure_code IN ('timeout', 'retry_exhausted')))",
    ).run(
      now,
      code,
      bounded || "The runner could not confirm that the session stopped.",
      sessionId,
      operationId,
      deliveryAttemptId,
      code,
    );
    return Number(changed.changes) === 1;
  }

  pendingSessionStopIntents(): SessionStopIntentRecord[] {
    const rows = this.stmt(
      "SELECT * FROM session_stop_intents " +
      "WHERE archive_after_stop=1 AND failed_at IS NULL " +
      "ORDER BY last_attempt_at, session_id",
    ).all() as unknown as SessionStopIntentRow[];
    return rows.map((row) => this.sessionStopIntentRecord(row));
  }

  /** Undo/unarchive cancels only the follow-up filing action. The durable Stop remains armed and
   * cannot silently restart runtime work. */
  cancelSessionArchiveAfterStop(sessionId: string): void {
    this.stmt("UPDATE session_stop_intents SET archive_after_stop=0 WHERE session_id=?").run(sessionId);
  }

  /** Terminal/absence evidence settles the stop fence and, in the same transaction, performs the
   * requested archive mutation. This is the only path that hides an active archive request. */
  settleSessionStopIntent(sessionId: string, now: number): { archived: boolean } {
    return this.atomic(() => {
      const row = this.stmt(
        "SELECT archive_after_stop FROM session_stop_intents WHERE session_id=?",
      ).get(sessionId) as { archive_after_stop: number } | undefined;
      if (!row) return { archived: false };
      this.stmt("DELETE FROM session_stop_intents WHERE session_id=?").run(sessionId);
      if (row.archive_after_stop === 1) {
        this.stmt("UPDATE sessions SET archived=1, updated_at=? WHERE id=?").run(now, sessionId);
        return { archived: true };
      }
      return { archived: false };
    });
  }

  setSessionStopRestartLaunchId(sessionId: string, launchId: string): void {
    this.stmt("UPDATE session_stop_intents SET restart_launch_id=? WHERE session_id=?")
      .run(launchId, sessionId);
  }

  clearSessionStopRestartLaunchId(sessionId: string): void {
    this.stmt("UPDATE session_stop_intents SET restart_launch_id=NULL WHERE session_id=?")
      .run(sessionId);
  }

  sessionStopRestartLaunchId(sessionId: string): string | null {
    return this.sessionStopIntent(sessionId)?.restartLaunchId ?? null;
  }

  sessionStopIntentIds(runnerId: string): string[] {
    const rows = this.stmt(
      "SELECT session_id FROM session_stop_intents WHERE runner_id=? ORDER BY created_at, session_id",
    ).all(runnerId) as unknown as Array<{ session_id: string }>;
    return rows.map((row) => row.session_id);
  }

  addTombstone(
    sessionId: string,
    runnerId: string,
    now: number,
    pruningPolicy: "when-absent" | "retain" = "when-absent",
  ): void {
    this.stmt(
        `INSERT INTO session_tombstones
           (session_id, runner_id, created_at, prune_when_absent) VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             runner_id=excluded.runner_id,
             prune_when_absent=MIN(session_tombstones.prune_when_absent, excluded.prune_when_absent)`,
      )
      .run(sessionId, runnerId, now, pruningPolicy === "when-absent" ? 1 : 0);
  }

  isTombstoned(sessionId: string): boolean {
    return this.stmt("SELECT 1 FROM session_tombstones WHERE session_id=?").get(sessionId) != null;
  }

  removeTombstone(sessionId: string): void {
    this.stmt("DELETE FROM session_tombstones WHERE session_id=?").run(sessionId);
  }

  /** Tombstoned session ids for a runner (used to re-issue deletes + prune on register). */
  tombstoneIds(runnerId: string): string[] {
    const rows = this.stmt("SELECT session_id FROM session_tombstones WHERE runner_id=?")
      .all(runnerId) as unknown as { session_id: string }[];
    return rows.map((r) => r.session_id);
  }

  /** Ordinary user-delete tombstones that can clear once a runner no longer reports the id. */
  prunableTombstoneIds(runnerId: string): string[] {
    const rows = this.stmt(
      "SELECT session_id FROM session_tombstones WHERE runner_id=? AND prune_when_absent=1",
    ).all(runnerId) as unknown as { session_id: string }[];
    return rows.map((r) => r.session_id);
  }

  private steeringAttemptView(row: SteeringAttemptRow): SteeringAttemptView {
    let hasImages = false;
    if (row.images_json) {
      try {
        hasImages = (JSON.parse(row.images_json) as unknown[]).length > 0;
      } catch {
        hasImages = false;
      }
    }
    const resolutionReceipt = parseJson<ResolveSteeringAttemptResultMessage>(row.resolution_receipt_json);
    return {
      submissionId: row.submission_id,
      turnId: row.turn_id,
      source: row.source,
      ...(row.source_queue_id ? { sourceQueueId: row.source_queue_id } : {}),
      text: row.text_snapshot?.slice(0, 240) ?? "",
      ...(hasImages ? { hasImages: true } : {}),
      state: row.disposition,
      ...(row.reason ? { reason: row.reason } : {}),
      ...(row.queued_prompt_id ? { queuedPromptId: row.queued_prompt_id } : {}),
      ...(row.resolution_action ? {
        resolution: {
          action: row.resolution_action,
          state: row.resolved_at === null ? "pending" as const : "applied" as const,
          ...(resolutionReceipt?.queuedPromptId ? { queuedPromptId: resolutionReceipt.queuedPromptId } : {}),
        },
      } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  createSteeringAttempt(input: CreateSteeringAttemptInput): CreateSteeringAttemptResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.stmt(
        "SELECT * FROM session_steering_attempts WHERE session_id=? AND submission_id=?",
      ).get(input.sessionId, input.submissionId) as unknown as SteeringAttemptRow | undefined;
      if (existing) {
        this.db.exec("COMMIT");
        return {
          kind: existing.request_sha256 === input.requestSha256 ? "duplicate" : "conflict",
          requestId: existing.request_id,
          attempt: this.steeringAttemptView(existing),
        };
      }
      const queueRevision = (this.stmt(
        "SELECT revision FROM session_steering_queue_snapshots WHERE session_id=?",
      ).get(input.sessionId) as { revision: number } | undefined)?.revision ?? 0;
      this.stmt(
        `INSERT INTO session_steering_attempts
         (request_id,session_id,submission_id,turn_id,source,source_queue_id,request_sha256,
          text_snapshot,images_json,config_json,disposition,queue_revision_at_create,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`,
      ).run(
        input.requestId,
        input.sessionId,
        input.submissionId,
        input.turnId,
        input.source,
        input.sourceQueueId ?? null,
        input.requestSha256,
        input.text ?? null,
        input.images?.length ? JSON.stringify(input.images) : null,
        input.config ? JSON.stringify(input.config) : null,
        queueRevision,
        input.now,
        input.now,
      );
      for (const artifactId of new Set(input.ownedArtifactIds ?? [])) {
        const linked = this.stmt(
          `INSERT INTO session_steering_attempt_artifacts (request_id,artifact_id)
           SELECT ?,id FROM artifacts WHERE id=? AND session_id=? AND run_id IS NULL
             AND CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.purpose') END='prompt_image'`,
        ).run(input.requestId, artifactId, input.sessionId);
        if (Number(linked.changes) !== 1) throw new Error("steering image artifact ownership is invalid");
        this.stmt(
          `INSERT OR IGNORE INTO steering_owned_prompt_image_artifacts (artifact_id,created_at)
           VALUES (?,?)`,
        ).run(artifactId, input.now);
      }
      const row = this.stmt("SELECT * FROM session_steering_attempts WHERE request_id=?")
        .get(input.requestId) as unknown as SteeringAttemptRow;
      this.db.exec("COMMIT");
      return { kind: "inserted", requestId: row.request_id, attempt: this.steeringAttemptView(row) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getSteeringAttemptByRequestId(requestId: string): SteeringAttemptView | null {
    const row = this.stmt("SELECT * FROM session_steering_attempts WHERE request_id=?")
      .get(requestId) as unknown as SteeringAttemptRow | undefined;
    return row ? this.steeringAttemptView(row) : null;
  }

  findSteeringAttemptBySubmission(sessionId: string, submissionId: string): {
    requestId: string;
    requestSha256: string;
    attempt: SteeringAttemptView;
  } | null {
    const row = this.stmt(
      "SELECT * FROM session_steering_attempts WHERE session_id=? AND submission_id=?",
    ).get(sessionId, submissionId) as unknown as SteeringAttemptRow | undefined;
    return row ? {
      requestId: row.request_id,
      requestSha256: row.request_sha256,
      attempt: this.steeringAttemptView(row),
    } : null;
  }

  steeringCommandSnapshot(requestId: string): SteerSessionMessage | null {
    const row = this.stmt(
      `SELECT * FROM session_steering_attempts
       WHERE request_id=? AND disposition='pending' AND compacted_at IS NULL`,
    ).get(requestId) as unknown as SteeringAttemptRow | undefined;
    if (!row) return null;
    const images = parseJson<SteerSessionMessage["images"]>(row.images_json) ?? undefined;
    return {
      type: "steer_session",
      requestId: row.request_id,
      submissionId: row.submission_id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      ...(row.source_queue_id ? { promotePromptId: row.source_queue_id } : {
        ...(row.text_snapshot ? { text: row.text_snapshot } : {}),
        ...(images?.length ? { images } : {}),
      }),
    };
  }

  stageSteeringResolution(
    sessionId: string,
    submissionId: string,
    action: ResolveSteeringAttemptMessage["action"],
    requestId: string,
    now: number,
  ): StageSteeringResolutionResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.stmt(
        "SELECT * FROM session_steering_attempts WHERE session_id=? AND submission_id=?",
      ).get(sessionId, submissionId) as unknown as SteeringAttemptRow | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return { kind: "not_found" };
      }
      if (row.resolution_action) {
        if (row.resolution_action !== action) {
          this.db.exec("COMMIT");
          return { kind: "conflict", attempt: this.steeringAttemptView(row) };
        }
        this.db.exec("COMMIT");
        return {
          kind: "existing",
          requestId: row.resolution_request_id!,
          attempt: this.steeringAttemptView(row),
        };
      }
      // Rejection is already terminal, so dismissing it is a durable acknowledgement rather than
      // a runner-side recovery operation. Persist the same resolution shape locally: it survives
      // snapshot refreshes without asking an older runner to resolve a disposition it never
      // treated as uncertain. A compacted rejection remains eligible, but its acknowledgement
      // must keep the retention tombstone content-free instead of recreating receipt payload.
      if (action === "dismiss" && row.disposition === "rejected" && row.resolved_at === null) {
        const receipt: ResolveSteeringAttemptResultMessage | null = row.compacted_at === null ? {
          type: "resolve_steering_attempt_result", requestId, sessionId, submissionId, action,
          applied: true,
        } : null;
        this.stmt(
          `UPDATE session_steering_attempts SET resolution_action=?,resolution_request_id=?,
           resolution_receipt_json=?,resolution_requested_at=?,resolved_at=?,updated_at=?
           WHERE request_id=? AND resolution_action IS NULL`,
        ).run(action, requestId, receipt ? JSON.stringify(receipt) : null, now, now, now, row.request_id);
        const dismissed = this.stmt("SELECT * FROM session_steering_attempts WHERE request_id=?")
          .get(row.request_id) as unknown as SteeringAttemptRow;
        this.db.exec("COMMIT");
        return { kind: "staged", requestId, attempt: this.steeringAttemptView(dismissed) };
      }
      if (row.disposition !== "uncertain" || row.resolved_at !== null || row.compacted_at !== null) {
        this.db.exec("COMMIT");
        return { kind: "not_uncertain", attempt: this.steeringAttemptView(row) };
      }
      this.stmt(
        `UPDATE session_steering_attempts SET resolution_action=?,resolution_request_id=?,
         resolution_requested_at=?,updated_at=? WHERE request_id=? AND resolution_action IS NULL`,
      ).run(action, requestId, now, now, row.request_id);
      const staged = this.stmt("SELECT * FROM session_steering_attempts WHERE request_id=?")
        .get(row.request_id) as unknown as SteeringAttemptRow;
      this.db.exec("COMMIT");
      return { kind: "staged", requestId, attempt: this.steeringAttemptView(staged) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  clearRejectedSteeringResolution(requestId: string): boolean {
    const cleared = this.stmt(
      `UPDATE session_steering_attempts SET resolution_action=NULL,resolution_request_id=NULL,
       resolution_receipt_json=NULL,resolution_requested_at=NULL,updated_at=updated_at+1
       WHERE resolution_request_id=? AND resolved_at IS NULL
         AND json_extract(resolution_receipt_json,'$.applied')=0`,
    ).run(requestId);
    return Number(cleared.changes) > 0;
  }

  pendingSteeringResolutionMessages(
    runnerId: string,
    limit = MAX_PENDING_STEERING_RESOLUTION_REPLAYS,
  ): ResolveSteeringAttemptMessage[] {
    const bounded = Number.isSafeInteger(limit)
      ? Math.max(1, Math.min(MAX_PENDING_STEERING_RESOLUTION_REPLAYS, limit))
      : MAX_PENDING_STEERING_RESOLUTION_REPLAYS;
    const rows = this.stmt(
      `SELECT attempt.resolution_request_id AS request_id,attempt.session_id,
              attempt.submission_id,attempt.resolution_action AS action
         FROM session_steering_attempts attempt
         JOIN sessions session ON session.id=attempt.session_id
        WHERE session.runner_id=? AND attempt.disposition='uncertain'
          AND attempt.resolved_at IS NULL AND attempt.compacted_at IS NULL
          AND attempt.resolution_request_id IS NOT NULL AND attempt.resolution_action IS NOT NULL
        ORDER BY attempt.resolution_requested_at,attempt.request_id LIMIT ?`,
    ).all(runnerId, bounded) as unknown as Array<{
      request_id: string;
      session_id: string;
      submission_id: string;
      action: ResolveSteeringAttemptMessage["action"];
    }>;
    return rows.map((row) => ({
      type: "resolve_steering_attempt",
      requestId: row.request_id,
      sessionId: row.session_id,
      submissionId: row.submission_id,
      action: row.action,
    }));
  }

  recordSteeringResolutionResult(
    runnerId: string,
    result: ResolveSteeringAttemptResultMessage,
    now: number,
  ): SteeringAttemptView | null {
    if (!validSteeringResolutionResult(result)) return null;
    const correlated = this.stmt(
      `SELECT 1 FROM session_steering_attempts attempt
       JOIN sessions session ON session.id=attempt.session_id
       WHERE attempt.resolution_request_id=? AND attempt.session_id=? AND attempt.submission_id=?
         AND attempt.resolution_action=? AND session.runner_id=?`,
    ).get(result.requestId, result.sessionId, result.submissionId, result.action, runnerId);
    if (!correlated) return null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.stmt(
        `SELECT attempt.* FROM session_steering_attempts attempt
         JOIN sessions session ON session.id=attempt.session_id
         WHERE attempt.resolution_request_id=? AND attempt.session_id=? AND attempt.submission_id=?
           AND attempt.resolution_action=? AND session.runner_id=?`,
      ).get(result.requestId, result.sessionId, result.submissionId, result.action, runnerId) as
        unknown as SteeringAttemptRow | undefined;
      if (!row) {
        this.db.exec("ROLLBACK");
        return null;
      }
      if (row.resolved_at !== null) {
        this.db.exec("COMMIT");
        return this.steeringAttemptView(row);
      }
      if (result.applied) {
        this.stmt(
          `UPDATE session_steering_attempts SET resolution_receipt_json=?,resolved_at=?,updated_at=?
           WHERE request_id=? AND resolved_at IS NULL`,
        ).run(JSON.stringify(result), now, now, row.request_id);
      } else {
        this.stmt(
          `UPDATE session_steering_attempts SET resolution_receipt_json=?,updated_at=? WHERE request_id=?`,
        ).run(JSON.stringify(result), now, row.request_id);
      }
      const updated = this.stmt("SELECT * FROM session_steering_attempts WHERE request_id=?")
        .get(row.request_id) as unknown as SteeringAttemptRow;
      this.db.exec("COMMIT");
      return this.steeringAttemptView(updated);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listSteeringAttempts(sessionId: string, limit = MAX_PROJECTED_STEERING_ATTEMPTS): SteeringAttemptView[] {
    const bounded = Number.isSafeInteger(limit)
      ? Math.max(1, Math.min(MAX_PROJECTED_STEERING_ATTEMPTS, limit))
      : MAX_PROJECTED_STEERING_ATTEMPTS;
    const rows = this.stmt(
      `SELECT * FROM session_steering_attempts WHERE session_id=?
       ORDER BY CASE
         WHEN disposition='pending' OR (disposition='uncertain' AND resolved_at IS NULL) THEN 0
         ELSE 1 END,
       created_at DESC, request_id DESC LIMIT ?`,
    ).all(sessionId, bounded) as unknown as SteeringAttemptRow[];
    return rows.map((row) => this.steeringAttemptView(row));
  }

  steeringRecoveryAdmissionCount(sessionId: string): number {
    const row = this.stmt(
      `SELECT COUNT(*) AS count FROM session_steering_attempts
       WHERE session_id=? AND (disposition='pending' OR
         (disposition='uncertain' AND resolved_at IS NULL))`,
    ).get(sessionId) as unknown as { count: number };
    return Number(row.count);
  }

  /** Persist only queue identities and ordering, never prompt content. An observation newer than
   * an attempt is authoritative for whether a converted prompt is still reachable from the live
   * runner queue; this also covers a queue frame that arrives before its correlated receipt. */
  recordSteeringQueueSnapshot(sessionId: string, promptIds: readonly string[], now: number): boolean {
    if (!Number.isSafeInteger(now) || now < 0 || promptIds.length > 100 ||
        promptIds.some((id) => typeof id !== "string" || !id || id.length > 256 || /[\0-\x1f\x7f]/.test(id)) ||
        new Set(promptIds).size !== promptIds.length || !this.getSession(sessionId)) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.stmt(
        "SELECT revision FROM session_steering_queue_snapshots WHERE session_id=?",
      ).get(sessionId) as { revision: number } | undefined;
      const revision = (previous?.revision ?? 0) + 1;
      const promptIdsJson = JSON.stringify(promptIds);
      this.stmt(
        `INSERT INTO session_steering_queue_snapshots (session_id,revision,prompt_ids_json,observed_at)
         VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
           revision=excluded.revision,prompt_ids_json=excluded.prompt_ids_json,observed_at=excluded.observed_at`,
      ).run(sessionId, revision, promptIdsJson, now);
      this.stmt(
        `UPDATE session_steering_attempts SET
           queue_absent_at=CASE WHEN EXISTS (
             SELECT 1 FROM json_each(?) queued WHERE queued.value=queued_prompt_id
           ) THEN NULL ELSE ? END,
           updated_at=MAX(updated_at,?)
         WHERE session_id=? AND disposition='converted_to_queue' AND queued_prompt_id IS NOT NULL
           AND queue_revision_at_create<? AND compacted_at IS NULL`,
      ).run(promptIdsJson, now, now, sessionId, revision);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordSteeringResult(runnerId: string, result: SteerSessionResultMessage, now: number): SteeringAttemptView | null {
    if (!validSteeringResult(result)) return null;
    const correlated = this.stmt(
      `SELECT 1 FROM session_steering_attempts attempt
       JOIN sessions session ON session.id=attempt.session_id
       WHERE attempt.request_id=? AND attempt.session_id=? AND attempt.submission_id=?
         AND attempt.turn_id=? AND session.runner_id=?`,
    ).get(result.requestId, result.sessionId, result.submissionId, result.turnId, runnerId);
    if (!correlated) return null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.stmt(
        `SELECT attempt.* FROM session_steering_attempts attempt
         JOIN sessions session ON session.id=attempt.session_id
         WHERE attempt.request_id=? AND attempt.session_id=? AND attempt.submission_id=?
           AND attempt.turn_id=? AND session.runner_id=?`,
      ).get(result.requestId, result.sessionId, result.submissionId, result.turnId, runnerId) as
        unknown as SteeringAttemptRow | undefined;
      if (!row) {
        this.db.exec("ROLLBACK");
        return null;
      }
      // A CP timeout/disconnect is only local uncertainty and carries no runner receipt. A late,
      // authoritative receipt may reconcile it once. A persisted runner receipt is immutable.
      const mayReconcileEvidence = row.compacted_at === null && row.receipt_json === null && (
        row.disposition === "uncertain" ||
        (row.disposition === "accepted" && result.disposition === "accepted")
      );
      if (row.disposition !== "pending" && !mayReconcileEvidence) {
        this.db.exec("COMMIT");
        return this.steeringAttemptView(row);
      }
      const queueSnapshot = result.disposition === "converted_to_queue"
        ? this.stmt(
          "SELECT revision,prompt_ids_json FROM session_steering_queue_snapshots WHERE session_id=?",
        ).get(result.sessionId) as { revision: number; prompt_ids_json: string } | undefined
        : undefined;
      const queueAbsentAt = queueSnapshot && queueSnapshot.revision > row.queue_revision_at_create &&
          !(parseJson<string[]>(queueSnapshot.prompt_ids_json) ?? []).includes(result.queuedPromptId!)
        ? now
        : null;
      this.stmt(
        `UPDATE session_steering_attempts SET disposition=?,reason=?,queued_prompt_id=?,receipt_json=?,
           queue_absent_at=?,updated_at=?,terminal_at=?
         WHERE request_id=? AND (disposition='pending' OR
           (receipt_json IS NULL AND (disposition='uncertain' OR
             (disposition='accepted' AND ?='accepted'))))`,
      ).run(
        result.disposition,
        result.reason,
        result.queuedPromptId ?? null,
        JSON.stringify(result),
        queueAbsentAt,
        now,
        now,
        result.requestId,
        result.disposition,
      );
      const updated = this.stmt("SELECT * FROM session_steering_attempts WHERE request_id=?")
        .get(result.requestId) as unknown as SteeringAttemptRow;
      this.db.exec("COMMIT");
      return this.steeringAttemptView(updated);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markSteeringAttemptUncertain(requestId: string, now: number): SteeringAttemptView | null {
    this.stmt(
      `UPDATE session_steering_attempts SET disposition='uncertain',reason='transport_uncertain',
       updated_at=?,terminal_at=? WHERE request_id=? AND disposition='pending'`,
    ).run(now, now, requestId);
    return this.getSteeringAttemptByRequestId(requestId);
  }

  markSteeringAttemptNotSent(requestId: string, now: number): SteeringAttemptView | null {
    this.stmt(
      `UPDATE session_steering_attempts SET disposition='rejected',reason='provider_rejected',
       updated_at=?,terminal_at=? WHERE request_id=? AND disposition='pending'`,
    ).run(now, now, requestId);
    return this.getSteeringAttemptByRequestId(requestId);
  }

  settleInterruptedSteeringAttempts(now: number): number {
    return Number(this.stmt(
      `UPDATE session_steering_attempts SET disposition='uncertain',reason='transport_uncertain',
       updated_at=?,terminal_at=? WHERE disposition='pending'`,
    ).run(now, now).changes);
  }

  /** A durable accepted user message is stronger evidence than a CP-local timeout. This also
   * removes the recovery action if the correlated result was lost after history committed. */
  resolveSteeringAttemptFromUserMessage(
    sessionId: string,
    submissionId: string,
    turnId: string,
    now: number,
  ): boolean {
    const updated = this.stmt(
      `UPDATE session_steering_attempts SET disposition='accepted',reason='accepted',updated_at=?,
       terminal_at=?
       WHERE session_id=? AND submission_id=? AND turn_id=?
         AND compacted_at IS NULL
         AND (disposition='pending' OR (disposition='uncertain' AND receipt_json IS NULL))`,
    ).run(now, now, sessionId, submissionId, turnId);
    return Number(updated.changes) > 0;
  }

  /** Deliberate recovery/dismissal from the UI resolves uncertainty without inventing a delivery
   * outcome. The compact tombstone remains `uncertain`; this timestamp only starts retention. */
  resolveUncertainSteeringAttempt(sessionId: string, submissionId: string, now: number): boolean {
    const updated = this.stmt(
      `UPDATE session_steering_attempts SET resolved_at=COALESCE(resolved_at,?),updated_at=?
       WHERE session_id=? AND submission_id=? AND disposition='uncertain' AND compacted_at IS NULL`,
    ).run(now, now, sessionId, submissionId);
    return Number(updated.changes) > 0;
  }

  private sessionPromptCommand(row: SessionPromptCommandRow): SessionPromptCommandRecord {
    return {
      commandId: row.command_id,
      sessionId: row.session_id,
      runnerId: row.runner_id,
      payloadJson: row.payload_json,
      payloadSha256: row.payload_sha256,
      state: row.state,
      revision: row.revision,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at,
      expiresAt: row.expires_at,
      ...(row.error ? { error: row.error } : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      ...(row.user_event_seq != null ? { userEventSeq: row.user_event_seq } : {}),
      ...(row.dismissed_at != null ? { dismissedAt: row.dismissed_at } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  stageSessionPromptCommand(input: {
    commandId: string;
    sessionId: string;
    runnerId: string;
    payloadJson: string;
    payloadSha256: string;
    expiresAt: number;
    now: number;
  }): SessionPromptCommandRecord {
    JSON.parse(input.payloadJson);
    this.stmt(
      `INSERT INTO session_prompt_commands
       (command_id,session_id,runner_id,payload_json,payload_sha256,state,revision,attempt_count,
        next_attempt_at,expires_at,created_at,updated_at)
       VALUES (?,?,?,?,?,'pending',0,0,?,?,?,?)`,
    ).run(
      input.commandId, input.sessionId, input.runnerId, input.payloadJson, input.payloadSha256,
      input.now, input.expiresAt, input.now, input.now,
    );
    return this.getSessionPromptCommand(input.commandId)!;
  }

  getSessionPromptCommand(commandId: string): SessionPromptCommandRecord | null {
    const row = this.stmt("SELECT * FROM session_prompt_commands WHERE command_id=?")
      .get(commandId) as unknown as SessionPromptCommandRow | undefined;
    return row ? this.sessionPromptCommand(row) : null;
  }

  dueSessionPromptCommands(now: number, runnerId?: string, limit = 100): SessionPromptCommandRecord[] {
    const runner = runnerId ? "AND command.runner_id=?" : "";
    const params = runnerId ? [now, now, runnerId, limit] : [now, now, limit];
    const rows = this.stmt(
      `SELECT command.* FROM session_prompt_commands command
       JOIN sessions session ON session.id=command.session_id
       WHERE command.state IN ('pending','sent','accepted','queued','started')
         AND command.next_attempt_at IS NOT NULL AND command.next_attempt_at<=? AND command.expires_at>?
         AND session.status NOT IN ('completed','failed','stopped') ${runner}
       ORDER BY command.created_at,command.rowid LIMIT ?`,
    ).all(...params) as unknown as SessionPromptCommandRow[];
    return rows.map((row) => this.sessionPromptCommand(row));
  }

  markSessionPromptCommandSent(
    commandId: string,
    requestId: string,
    now: number,
    nextAttemptAt: number,
  ): SessionPromptCommandRecord | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.stmt("SELECT * FROM session_prompt_commands WHERE command_id=?")
        .get(commandId) as unknown as SessionPromptCommandRow | undefined;
      if (!row || !["pending", "sent", "accepted", "queued", "started"].includes(row.state)) {
        this.db.exec("COMMIT");
        return null;
      }
      this.stmt(
        "INSERT INTO session_prompt_command_attempts (request_id,command_id,runner_id,sent_at) VALUES (?,?,?,?)",
      ).run(requestId, commandId, row.runner_id, now);
      this.stmt(
        `DELETE FROM session_prompt_command_attempts
         WHERE command_id=? AND request_id NOT IN (
           SELECT request_id FROM session_prompt_command_attempts
           WHERE command_id=? ORDER BY sent_at DESC,rowid DESC LIMIT ?
         )`,
      ).run(commandId, commandId, SESSION_PROMPT_ATTEMPT_RETENTION_LIMIT);
      this.stmt(
        `UPDATE session_prompt_commands
         SET state=CASE WHEN state IN ('pending','sent') THEN 'sent' ELSE state END,
             attempt_count=attempt_count+1,next_attempt_at=?,updated_at=?
         WHERE command_id=?`,
      ).run(nextAttemptAt, now, commandId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getSessionPromptCommand(commandId);
  }

  recordSessionPromptCommandReceipt(input: {
    commandId: string;
    runnerId: string;
    sessionId: string;
    state: Exclude<SessionPromptCommandState, "pending" | "sent">;
    revision: number;
    requestId?: string;
    error?: string;
    code?: DurableSessionCommandErrorCode;
    userEventSeq?: number;
    now: number;
  }): { command: SessionPromptCommandRecord; advanced: boolean } | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.stmt("SELECT * FROM session_prompt_commands WHERE command_id=?")
        .get(input.commandId) as unknown as SessionPromptCommandRow | undefined;
      if (!row || row.runner_id !== input.runnerId || row.session_id !== input.sessionId) {
        this.db.exec("ROLLBACK");
        return null;
      }
      if (input.requestId) {
        const attempt = this.stmt(
          "SELECT 1 FROM session_prompt_command_attempts WHERE request_id=? AND command_id=? AND runner_id=?",
        ).get(input.requestId, input.commandId, input.runnerId);
        if (!attempt) {
          this.db.exec("ROLLBACK");
          return null;
        }
      }
      const terminal = new Set<SessionPromptCommandState>(["completed", "failed", "uncertain"]);
      const incomingTerminal = terminal.has(input.state);
      // CP terminality is a conservative no-retry fence, not proof of the runner outcome. A later
      // authenticated terminal receipt may narrow `uncertain` to the definitive provider result;
      // no terminal state other than uncertainty is mutable, and nonterminal updates never revive it.
      const refinesUncertain = row.state === "uncertain" &&
        (input.state === "completed" || input.state === "failed") &&
        input.revision >= row.revision;
      if ((terminal.has(row.state) && !refinesUncertain) || input.revision < row.revision ||
          (input.revision === row.revision && input.state === row.state)) {
        this.db.exec("COMMIT");
        return { command: this.sessionPromptCommand(row), advanced: false };
      }
      const rank: Record<SessionPromptCommandState, number> = {
        pending: 0, sent: 1, accepted: 2, queued: 3, started: 4,
        completed: 5, failed: 5, uncertain: 5,
      };
      if ((input.revision === row.revision && !incomingTerminal) ||
          (!incomingTerminal && rank[input.state] < rank[row.state])) {
        this.db.exec("COMMIT");
        return { command: this.sessionPromptCommand(row), advanced: false };
      }
      const terminalExpiresAt = refinesUncertain
        ? Math.min(row.expires_at, input.now + SESSION_PROMPT_TERMINAL_RETENTION_MS)
        : input.now + SESSION_PROMPT_TERMINAL_RETENTION_MS;
      this.stmt(
        `UPDATE session_prompt_commands SET state=?,revision=?,error=?,error_code=?,
         user_event_seq=COALESCE(?,user_event_seq),next_attempt_at=?,
         payload_json=CASE WHEN ? THEN 'null' ELSE payload_json END,
         expires_at=CASE WHEN ? THEN ? ELSE expires_at END,
         updated_at=? WHERE command_id=?`,
      ).run(
        input.state, input.revision, input.error ?? null, input.code ?? null,
        input.userEventSeq ?? null, terminal.has(input.state) ? null : input.now + 30_000,
        input.state === "completed" ? 1 : 0,
        incomingTerminal ? 1 : 0, terminalExpiresAt,
        input.now, input.commandId,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { command: this.getSessionPromptCommand(input.commandId)!, advanced: true };
  }

  expireSessionPromptCommands(now: number): string[] {
    const rows = this.stmt(
      `SELECT * FROM session_prompt_commands
       WHERE state IN ('pending','sent','accepted','queued','started') AND expires_at<=?
       ORDER BY expires_at,created_at,rowid LIMIT 100`,
    ).all(now) as unknown as SessionPromptCommandRow[];
    const sessions = new Set<string>();
    for (const row of rows) {
      const uncertain = row.state !== "pending";
      this.stmt(
        `UPDATE session_prompt_commands SET state=?,revision=revision+1,error=?,next_attempt_at=NULL,
         expires_at=?,updated_at=?
         WHERE command_id=?`,
      ).run(
        uncertain ? "uncertain" : "failed",
        uncertain
          ? "durable prompt exceeded its receipt horizon after possible runner acceptance"
          : "durable prompt expired before runner acceptance",
        now + SESSION_PROMPT_TERMINAL_RETENTION_MS,
        now,
        row.command_id,
      );
      sessions.add(row.session_id);
    }
    return [...sessions];
  }

  cancelSessionPromptCommands(sessionId: string, reason: string, now: number): number {
    const rows = this.stmt(
      `SELECT command_id,state FROM session_prompt_commands
       WHERE session_id=? AND state IN ('pending','sent','accepted','queued','started')`,
    ).all(sessionId) as Array<{ command_id: string; state: SessionPromptCommandState }>;
    for (const row of rows) {
      // `sent` is mark-before-send, so only a never-attempted pending row is definitely cancelled.
      // Anything later may already have reached provider admission and is explicitly uncertain.
      this.stmt(
        `UPDATE session_prompt_commands SET state=?,revision=revision+1,error=?,error_code='COMMAND_CANCELLED',
         next_attempt_at=NULL,expires_at=?,updated_at=? WHERE command_id=?`,
      ).run(
        row.state === "pending" ? "failed" : "uncertain",
        reason,
        now + SESSION_PROMPT_TERMINAL_RETENTION_MS,
        now,
        row.command_id,
      );
    }
    return rows.length;
  }

  cancelPendingSessionPromptCommand(
    sessionId: string,
    commandId: string,
    now: number,
  ): "cancelled" | "not_found" | "delivery_started" {
    const row = this.stmt(
      "SELECT state FROM session_prompt_commands WHERE session_id=? AND command_id=? AND dismissed_at IS NULL",
    ).get(sessionId, commandId) as { state: SessionPromptCommandState } | undefined;
    if (!row) return "not_found";
    if (row.state !== "pending") return "delivery_started";
    const updated = this.stmt(
      `UPDATE session_prompt_commands SET state='failed',revision=revision+1,
       error='prompt cancelled before runner delivery',error_code='COMMAND_CANCELLED',
       next_attempt_at=NULL,expires_at=?,updated_at=?
       WHERE session_id=? AND command_id=? AND state='pending' AND dismissed_at IS NULL`,
    ).run(now + SESSION_PROMPT_TERMINAL_RETENTION_MS, now, sessionId, commandId);
    return Number(updated.changes) === 1 ? "cancelled" : "delivery_started";
  }

  dismissTerminalSessionPromptCommand(
    sessionId: string,
    commandId: string,
    now: number,
  ): "dismissed" | "not_found" | "not_terminal" {
    const row = this.stmt(
      "SELECT state FROM session_prompt_commands WHERE session_id=? AND command_id=? AND dismissed_at IS NULL",
    ).get(sessionId, commandId) as { state: SessionPromptCommandState } | undefined;
    if (!row) return "not_found";
    if (row.state !== "failed" && row.state !== "uncertain") return "not_terminal";
    const updated = this.stmt(
      `UPDATE session_prompt_commands SET dismissed_at=?,payload_json='null',
       expires_at=MIN(expires_at,?),updated_at=?
       WHERE session_id=? AND command_id=? AND state IN ('failed','uncertain') AND dismissed_at IS NULL`,
    ).run(now, now + SESSION_PROMPT_TERMINAL_RETENTION_MS, now, sessionId, commandId);
    return Number(updated.changes) === 1 ? "dismissed" : "not_terminal";
  }

  pruneSessionPromptCommands(now: number, limit = 1_000): string[] {
    const rows = this.stmt(
      `SELECT command_id,session_id FROM session_prompt_commands
       WHERE state IN ('completed','failed','uncertain') AND expires_at<=?
       ORDER BY expires_at,created_at,rowid LIMIT ?`,
    ).all(now, Math.max(1, Math.min(limit, 10_000))) as Array<{ command_id: string; session_id: string }>;
    if (!rows.length) return [];
    const placeholders = rows.map(() => "?").join(",");
    this.stmt(`DELETE FROM session_prompt_commands WHERE command_id IN (${placeholders})`)
      .run(...rows.map((row) => row.command_id));
    return [...new Set(rows.map((row) => row.session_id))];
  }

  private sessionCommandInvocationView(
    row: SessionCommandInvocationRow,
    argumentText = row.argument_text,
  ): SessionCommandInvocationView {
    return {
      invocationId: row.invocation_id,
      submissionId: row.submission_id,
      sessionId: row.session_id,
      providerCommandId: row.provider_command_id,
      catalogRevision: row.catalog_revision,
      commandName: row.command_name,
      argumentText,
      executionMode: row.execution_mode,
      state: row.state,
      revision: row.revision,
      ...(row.error ? { error: row.error } : {}),
      ...(row.error_code ? { code: row.error_code } : {}),
      ...(row.user_event_seq != null ? { userEventSeq: row.user_event_seq } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  stageSessionCommandInvocation(
    input: StageSessionCommandInvocationInput,
    activeLimit?: number,
  ):
    | { kind: "inserted" | "duplicate" | "conflict"; invocation: SessionCommandInvocationView }
    | { kind: "full" } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.stmt(
        "SELECT * FROM session_command_invocations WHERE session_id=? AND submission_id=?",
      ).get(input.sessionId, input.submissionId) as unknown as SessionCommandInvocationRow | undefined;
      if (existing) {
        this.db.exec("COMMIT");
        return {
          kind: existing.payload_digest === input.payloadDigest ? "duplicate" : "conflict",
          invocation: this.sessionCommandInvocationView(existing),
        };
      }
      if (activeLimit !== undefined) {
        const boundedLimit = Number.isSafeInteger(activeLimit) ? Math.max(1, Math.min(activeLimit, 100)) : 100;
        const active = this.stmt(
          `SELECT COUNT(*) AS count FROM session_command_invocations WHERE session_id=?
             AND state IN ('pending','sent','accepted','queued','started')`,
        ).get(input.sessionId) as { count: number };
        if (active.count >= boundedLimit) {
          this.db.exec("COMMIT");
          return { kind: "full" };
        }
      }
      this.stmt(
        `INSERT INTO session_command_invocations
         (invocation_id,session_id,runner_id,submission_id,provider_command_id,catalog_revision,
          command_name,argument_text,execution_mode,payload_digest,state,revision,next_attempt_at,
          expires_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'pending',0,?,?,?,?)`,
      ).run(
        input.invocationId,
        input.sessionId,
        input.runnerId,
        input.submissionId,
        input.providerCommandId,
        input.catalogRevision,
        input.commandName,
        input.argumentText,
        input.executionMode,
        input.payloadDigest,
        input.now,
        input.expiresAt,
        input.now,
        input.now,
      );
      this.stmt(
        `INSERT INTO session_command_invocation_attempts
         (request_id,invocation_id,runner_id,created_at) VALUES (?,?,?,?)`,
      ).run(input.requestId, input.invocationId, input.runnerId, input.now);
      const row = this.stmt("SELECT * FROM session_command_invocations WHERE invocation_id=?")
        .get(input.invocationId) as unknown as SessionCommandInvocationRow;
      this.db.exec("COMMIT");
      return { kind: "inserted", invocation: this.sessionCommandInvocationView(row) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getSessionCommandInvocation(invocationId: string): SessionCommandInvocationView | null {
    const row = this.stmt("SELECT * FROM session_command_invocations WHERE invocation_id=?")
      .get(invocationId) as unknown as SessionCommandInvocationRow | undefined;
    return row ? this.sessionCommandInvocationView(row) : null;
  }

  getSessionCommandInvocationBySubmission(
    sessionId: string,
    submissionId: string,
  ): SessionCommandInvocationView | null {
    const row = this.stmt(
      "SELECT * FROM session_command_invocations WHERE session_id=? AND submission_id=?",
    ).get(sessionId, submissionId) as unknown as SessionCommandInvocationRow | undefined;
    return row ? this.sessionCommandInvocationView(row) : null;
  }

  listSessionCommandInvocations(
    sessionId: string,
    completedLimit = 50,
    activeLimit = 100,
    recoveryLimit = 5,
  ): SessionCommandInvocationView[] {
    const boundedCompleted = Number.isSafeInteger(completedLimit)
      ? Math.max(1, Math.min(completedLimit, 100))
      : 50;
    const boundedActive = Number.isSafeInteger(activeLimit)
      ? Math.max(1, Math.min(activeLimit, 100))
      : 100;
    const boundedRecovery = Number.isSafeInteger(recoveryLimit)
      ? Math.max(1, Math.min(recoveryLimit, 100))
      : 5;
    const active = this.stmt(
      `SELECT * FROM session_command_invocations WHERE session_id=?
         AND state IN ('pending','sent','accepted','queued','started')
       ORDER BY created_at DESC,invocation_id DESC LIMIT ?`,
    ).all(sessionId, boundedActive) as unknown as SessionCommandInvocationRow[];
    const recovery = this.stmt(
      `SELECT * FROM session_command_invocations WHERE session_id=?
         AND state IN ('rejected','uncertain')
       ORDER BY created_at DESC,invocation_id DESC LIMIT ?`,
    ).all(sessionId, boundedRecovery) as unknown as SessionCommandInvocationRow[];
    const completed = this.stmt(
      `SELECT * FROM session_command_invocations WHERE session_id=?
         AND state='completed'
       ORDER BY created_at DESC,invocation_id DESC LIMIT ?`,
    ).all(sessionId, boundedCompleted) as unknown as SessionCommandInvocationRow[];
    const rows = [...active, ...recovery, ...completed].sort((left, right) =>
      right.created_at - left.created_at ||
      (right.invocation_id === left.invocation_id ? 0 : right.invocation_id > left.invocation_id ? 1 : -1));
    return rows.map((row) => this.sessionCommandInvocationView(
      row,
      row.argument_text.length > 512 ? `${row.argument_text.slice(0, 511)}…` : row.argument_text,
    ));
  }

  sessionCommandInvocationMessage(invocationId: string): InvokeSessionCommandMessage | null {
    const row = this.stmt(
      `SELECT invocation.*,attempt.request_id FROM session_command_invocations invocation
       JOIN session_command_invocation_attempts attempt ON attempt.invocation_id=invocation.invocation_id
       WHERE invocation.invocation_id=? ORDER BY attempt.created_at DESC,attempt.request_id DESC LIMIT 1`,
    ).get(invocationId) as unknown as (SessionCommandInvocationRow & { request_id: string }) | undefined;
    if (!row) return null;
    return {
      type: "invoke_session_command",
      requestId: row.request_id,
      invocationId: row.invocation_id,
      submissionId: row.submission_id,
      payloadDigest: row.payload_digest,
      expiresAt: row.expires_at,
      sessionId: row.session_id,
      providerCommandId: row.provider_command_id,
      catalogRevision: row.catalog_revision,
      expectedExecutionMode: row.execution_mode,
      argumentText: row.argument_text,
    };
  }

  markSessionCommandInvocationSent(
    requestId: string,
    now: number,
    nextAttemptAt = now,
  ): SessionCommandInvocationView | null {
    this.stmt(
      `UPDATE session_command_invocations SET state='sent',attempt_count=attempt_count+1,
       next_attempt_at=?,updated_at=?
       WHERE invocation_id=(SELECT invocation_id FROM session_command_invocation_attempts WHERE request_id=?)
         AND state IN ('pending','sent')`,
    ).run(nextAttemptAt, now, requestId);
    this.stmt("UPDATE session_command_invocation_attempts SET sent_at=COALESCE(sent_at,?) WHERE request_id=?")
      .run(now, requestId);
    const row = this.stmt(
      `SELECT invocation.* FROM session_command_invocations invocation
       JOIN session_command_invocation_attempts attempt ON attempt.invocation_id=invocation.invocation_id
       WHERE attempt.request_id=?`,
    ).get(requestId) as unknown as SessionCommandInvocationRow | undefined;
    return row ? this.sessionCommandInvocationView(row) : null;
  }

  sessionCommandInvocationMessagesByState(
    runnerId: string,
    state: "pending" | "sent",
    now: number,
    limit = 50,
    offset = 0,
  ): Array<{ message: InvokeSessionCommandMessage; attemptCount: number }> {
    const rows = this.stmt(
      `SELECT invocation_id,attempt_count FROM session_command_invocations
       WHERE runner_id=? AND state=? AND expires_at>?
       ORDER BY created_at,invocation_id LIMIT ? OFFSET ?`,
    ).all(
      runnerId,
      state,
      now,
      Math.max(1, Math.min(limit, 100)),
      Math.max(0, offset),
    ) as unknown as Array<{ invocation_id: string; attempt_count: number }>;
    return rows.flatMap((row) => {
      const message = this.sessionCommandInvocationMessage(row.invocation_id);
      return message ? [{ message, attemptCount: row.attempt_count }] : [];
    });
  }

  dueSessionCommandInvocationMessages(
    runnerId: string,
    now: number,
    limit = 100,
  ): Array<{ message: InvokeSessionCommandMessage; attemptCount: number }> {
    const rows = this.stmt(
      `SELECT invocation_id,attempt_count FROM session_command_invocations
       WHERE runner_id=? AND state IN ('pending','sent') AND expires_at>?
         AND next_attempt_at<=?
       ORDER BY next_attempt_at,created_at,invocation_id LIMIT ?`,
    ).all(runnerId, now, now, Math.max(1, Math.min(limit, 100))) as unknown as Array<{
      invocation_id: string;
      attempt_count: number;
    }>;
    return rows.flatMap((row) => {
      const message = this.sessionCommandInvocationMessage(row.invocation_id);
      return message ? [{ message, attemptCount: row.attempt_count }] : [];
    });
  }

  dueSessionCommandInvocationRunnerIds(now: number): string[] {
    return (this.stmt(
      `SELECT DISTINCT runner_id FROM session_command_invocations
       WHERE state IN ('pending','sent') AND expires_at>?
         AND next_attempt_at<=?
       ORDER BY runner_id`,
    ).all(now, now) as Array<{ runner_id: string }>).map((row) => row.runner_id);
  }

  expiringSessionCommandInvocationSessionIds(now: number): string[] {
    return (this.stmt(
      `SELECT DISTINCT session_id FROM session_command_invocations
       WHERE expires_at<=? AND state IN ('pending','sent','accepted','queued','started')`,
    ).all(now) as Array<{ session_id: string }>).map((row) => row.session_id);
  }

  unsettledSessionCommandInvocationSessionIdsForRunner(runnerId: string): string[] {
    return (this.stmt(
      `SELECT DISTINCT session_id FROM session_command_invocations
       WHERE runner_id=? AND state IN ('pending','sent','accepted','queued','started')`,
    ).all(runnerId) as Array<{ session_id: string }>).map((row) => row.session_id);
  }

  recordSessionCommandInvocationReceipt(
    runnerId: string,
    receipt: SessionCommandInvocationResultMessage | SessionCommandInvocationUpdateMessage,
    now: number,
  ): { invocation: SessionCommandInvocationView; changed: boolean } | null {
    const requestId = receipt.type === "session_command_invocation_result" ? receipt.requestId : null;
    const row = requestId
      ? this.stmt(
          `SELECT invocation.* FROM session_command_invocations invocation
           JOIN session_command_invocation_attempts attempt ON attempt.invocation_id=invocation.invocation_id
           WHERE attempt.request_id=? AND attempt.runner_id=?`,
        ).get(requestId, runnerId) as unknown as SessionCommandInvocationRow | undefined
      : this.stmt(
          "SELECT * FROM session_command_invocations WHERE invocation_id=? AND runner_id=?",
        ).get(receipt.invocationId, runnerId) as unknown as SessionCommandInvocationRow | undefined;
    if (!row || row.invocation_id !== receipt.invocationId || row.session_id !== receipt.sessionId ||
        row.submission_id !== receipt.submissionId) return null;
    if (sessionCommandTerminal(row.state)) {
      return { invocation: this.sessionCommandInvocationView(row), changed: false };
    }
    if (receipt.revision < row.revision) {
      return { invocation: this.sessionCommandInvocationView(row), changed: false };
    }
    if (receipt.revision === row.revision && receipt.state === row.state) {
      return { invocation: this.sessionCommandInvocationView(row), changed: false };
    }
    if (!sessionCommandReceiptAdvances(row.state, receipt.state, row.revision, receipt.revision)) {
      return { invocation: this.sessionCommandInvocationView(row), changed: false };
    }
    const terminalAt = sessionCommandTerminal(receipt.state) ? now : null;
    this.stmt(
      `UPDATE session_command_invocations SET state=?,revision=?,error=?,error_code=?,
       user_event_seq=COALESCE(?,user_event_seq),
       updated_at=?,terminal_at=? WHERE invocation_id=?`,
    ).run(
      receipt.state,
      receipt.revision,
      receipt.error ?? null,
      receipt.code ?? null,
      "userEventSeq" in receipt ? (receipt.userEventSeq ?? null) : null,
      now,
      terminalAt,
      row.invocation_id,
    );
    return { invocation: this.getSessionCommandInvocation(row.invocation_id)!, changed: true };
  }

  resolveSessionCommandInvocationFromUserMessage(
    sessionId: string,
    invocationId: string,
    submissionId: string,
    providerCommandId: string,
    catalogRevision: string,
    commandName: string,
    executionMode: SessionCommandExecutionMode,
    userEventSeq: number | undefined,
    now: number,
  ): boolean {
    if (userEventSeq === undefined) return false;
    const updated = this.stmt(
      `UPDATE session_command_invocations SET user_event_seq=?,updated_at=?
       WHERE session_id=? AND invocation_id=? AND submission_id=? AND provider_command_id=?
         AND catalog_revision=? AND command_name=? AND execution_mode=?
         AND user_event_seq IS NULL`,
    ).run(
      userEventSeq,
      now,
      sessionId,
      invocationId,
      submissionId,
      providerCommandId,
      catalogRevision,
      commandName,
      executionMode,
    );
    return Number(updated.changes) > 0;
  }

  expireSessionCommandInvocations(now: number, runnerId?: string): number {
    const suffix = runnerId ? " AND runner_id=?" : "";
    const args = runnerId ? [now, now, now, runnerId] : [now, now, now];
    const pending = this.stmt(
      `UPDATE session_command_invocations SET state='rejected',error='session command expired before delivery',
       error_code='COMMAND_EXPIRED',updated_at=?,terminal_at=?
       WHERE expires_at<=? AND state='pending'${suffix}`,
    ).run(...args);
    const uncertainArgs = runnerId ? [now, now, now, runnerId] : [now, now, now];
    const uncertain = this.stmt(
      `UPDATE session_command_invocations SET state='uncertain',
       error='session command expired after delivery may have begun',updated_at=?,terminal_at=?
       WHERE expires_at<=? AND state IN ('sent','accepted','queued','started')${suffix}`,
    ).run(...uncertainArgs);
    return Number(pending.changes) + Number(uncertain.changes);
  }

  settleSessionCommandCapabilityLoss(runnerId: string, now: number): number {
    const pending = this.stmt(
      `UPDATE session_command_invocations SET state='rejected',error='runner does not support session command receipts',
       error_code='COMMAND_MODE_UNSUPPORTED',updated_at=?,terminal_at=?
       WHERE runner_id=? AND state='pending'`,
    ).run(now, now, runnerId);
    const uncertain = this.stmt(
      `UPDATE session_command_invocations SET state='uncertain',
       error='runner lost session command receipt capability after delivery',updated_at=?,terminal_at=?
       WHERE runner_id=? AND state IN ('sent','accepted','queued','started')`,
    ).run(now, now, runnerId);
    return Number(pending.changes) + Number(uncertain.changes);
  }

  pruneSessionCommandInvocations(terminalBefore: number, limit = 1_000): number {
    const deleted = this.stmt(
      `DELETE FROM session_command_invocations WHERE invocation_id IN (
         SELECT invocation_id FROM session_command_invocations
         WHERE terminal_at IS NOT NULL AND terminal_at<=?
         ORDER BY terminal_at,invocation_id LIMIT ?
       )`,
    ).run(terminalBefore, Math.max(1, Math.min(limit, 10_000)));
    return Number(deleted.changes);
  }

  compactSteeringAttempts(now: number, limit = 100): number {
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(1_000, limit)) : 100;
    const rows = this.stmt(
      `SELECT attempt.request_id FROM session_steering_attempts attempt
       WHERE attempt.disposition<>'pending' AND attempt.terminal_at IS NOT NULL AND
         ((disposition<>'uncertain' AND terminal_at<=?) OR
          (disposition='uncertain' AND resolved_at IS NOT NULL AND resolved_at<=?))
         AND compacted_at IS NULL
         AND (
           NOT EXISTS (
             SELECT 1 FROM session_steering_attempt_artifacts owned
              WHERE owned.request_id=attempt.request_id
           )
           OR attempt.disposition IN ('rejected','uncertain')
           OR attempt.queue_absent_at IS NOT NULL
           OR NOT EXISTS (
             SELECT 1 FROM session_steering_attempt_artifacts owned
              WHERE owned.request_id=attempt.request_id
                AND NOT EXISTS (
                  SELECT 1 FROM session_event_artifacts event_ref
                   WHERE event_ref.artifact_id=owned.artifact_id
                )
           )
         )
       ORDER BY terminal_at,request_id LIMIT ?`,
    ).all(now - 30 * 24 * 60 * 60_000, now - 30 * 24 * 60 * 60_000, bounded) as
      unknown as Array<{ request_id: string }>;
    if (!rows.length) return 0;
    const placeholders = rows.map(() => "?").join(",");
    const requestIds = rows.map((row) => row.request_id);
    const ownedArtifacts = this.stmt(
      `SELECT DISTINCT artifact_id FROM session_steering_attempt_artifacts
       WHERE request_id IN (${placeholders})`,
    ).all(...requestIds) as unknown as Array<{ artifact_id: string }>;
    this.db.exec("BEGIN IMMEDIATE");
    let compacted;
    let deletedArtifacts = 0;
    try {
      compacted = this.stmt(
        `UPDATE session_steering_attempts SET text_snapshot=NULL,images_json=NULL,config_json=NULL,
         receipt_json=NULL,resolution_receipt_json=NULL,resolution_request_id=NULL,
         queued_prompt_id=NULL,compacted_at=? WHERE request_id IN (${placeholders})`,
      ).run(now, ...requestIds);
      for (const { artifact_id: artifactId } of ownedArtifacts) {
        const deleted = this.stmt(
          `DELETE FROM artifacts WHERE id=? AND run_id IS NULL
             AND EXISTS (
               SELECT 1 FROM steering_owned_prompt_image_artifacts owned WHERE owned.artifact_id=artifacts.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM session_steering_attempt_artifacts ref
                WHERE ref.artifact_id=artifacts.id AND ref.request_id NOT IN (${placeholders})
             )
             AND NOT EXISTS (SELECT 1 FROM session_event_artifacts ref WHERE ref.artifact_id=artifacts.id)
             AND NOT EXISTS (SELECT 1 FROM workflow_attempt_artifacts ref WHERE ref.artifact_id=artifacts.id)`,
        ).run(artifactId, ...requestIds);
        deletedArtifacts += Number(deleted.changes);
      }
      this.stmt(
        `DELETE FROM session_steering_attempt_artifacts WHERE request_id IN (${placeholders})`,
      ).run(...requestIds);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (deletedArtifacts) this.collectWorkflowArtifactBlobs();
    return Number(compacted.changes);
  }

  /** Retry-safe GC for steering-created images whose attempt and event reachability disappeared
   * after compaction. The provenance table excludes reusable uploads, even if their bytes and
   * prompt-image metadata are otherwise identical. */
  collectOrphanedSteeringPromptImages(limit = 1_000): number {
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 10_000)) : 1_000;
    this.db.exec("BEGIN IMMEDIATE");
    let deleted = 0;
    try {
      const rows = this.stmt(
        `SELECT artifact.id FROM artifacts artifact
         JOIN steering_owned_prompt_image_artifacts owned ON owned.artifact_id=artifact.id
        WHERE NOT EXISTS (
          SELECT 1 FROM session_steering_attempt_artifacts ref WHERE ref.artifact_id=artifact.id
        ) AND NOT EXISTS (
          SELECT 1 FROM session_event_artifacts ref WHERE ref.artifact_id=artifact.id
        ) AND NOT EXISTS (
          SELECT 1 FROM workflow_attempt_artifacts ref WHERE ref.artifact_id=artifact.id
        ) ORDER BY artifact.id LIMIT ?`,
      ).all(bounded) as unknown as Array<{ id: string }>;
      for (const row of rows) {
        deleted += Number(this.stmt("DELETE FROM artifacts WHERE id=?").run(row.id).changes);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (deleted) this.collectWorkflowArtifactBlobs();
    return deleted;
  }

  getSession(id: string): SessionView | null {
    const row = this.stmt("SELECT * FROM sessions WHERE id=?").get(id) as unknown as
      | SessionRow
      | undefined;
    return row ? this.sessionView(row, undefined, this.sessionStopIntent(id)) : null;
  }

  recordSideChat(parentSessionId: string, childSessionId: string, now: number): void {
    if (!parentSessionId || !childSessionId || parentSessionId === childSessionId ||
        !Number.isSafeInteger(now) || now < 0) {
      throw new Error("side chat relationship is invalid");
    }
    this.stmt(
      `INSERT INTO session_side_chats (parent_session_id, child_session_id, created_at)
       VALUES (?, ?, ?)`,
    ).run(parentSessionId, childSessionId, now);
  }

  getSideChat(parentSessionId: string): { parentSessionId: string; childSessionId: string; createdAt: number } | null {
    const row = this.stmt(
      `SELECT parent_session_id, child_session_id, created_at
       FROM session_side_chats WHERE parent_session_id=?`,
    ).get(parentSessionId) as unknown as {
      parent_session_id: string;
      child_session_id: string;
      created_at: number;
    } | undefined;
    return row ? {
      parentSessionId: row.parent_session_id,
      childSessionId: row.child_session_id,
      createdAt: row.created_at,
    } : null;
  }

  sideChatParent(childSessionId: string): string | null {
    const row = this.stmt(
      "SELECT parent_session_id FROM session_side_chats WHERE child_session_id=?",
    ).get(childSessionId) as unknown as { parent_session_id: string } | undefined;
    return row?.parent_session_id ?? null;
  }

  recordSessionFork(targetSessionId: string, sourceSessionId: string, sourceTurn: number, now: number): void {
    if (!targetSessionId || !sourceSessionId || targetSessionId === sourceSessionId ||
        !Number.isSafeInteger(sourceTurn) || sourceTurn < 1) {
      throw new Error("session fork provenance is invalid");
    }
    this.stmt(
      `INSERT INTO session_forks (target_session_id, source_session_id, source_turn, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(targetSessionId, sourceSessionId, sourceTurn, now);
  }

  /** True only for bounded, recorded provider-fork ancestry; ordinary sibling sessions never
   * inherit artifact access merely because they share a runner or workspace. */
  sessionForkIncludesAncestor(targetSessionId: string, ancestorSessionId: string): boolean {
    return Boolean(this.stmt(
      `WITH RECURSIVE ancestors(session_id, depth) AS (
         SELECT source_session_id, 1 FROM session_forks WHERE target_session_id=?
         UNION ALL
         SELECT fork.source_session_id, ancestors.depth + 1
         FROM session_forks fork JOIN ancestors ON fork.target_session_id=ancestors.session_id
         WHERE ancestors.depth < 64
       )
       SELECT 1 FROM ancestors WHERE session_id=? LIMIT 1`,
    ).get(targetSessionId, ancestorSessionId));
  }

  listSessions(opts: { includeArchived?: boolean } = {}): SessionView[] {
    const where = opts.includeArchived ? "" : "WHERE archived=0";
    const rows = this.stmt(`SELECT * FROM sessions ${where} ORDER BY created_at DESC`)
      .all() as unknown as SessionRow[];
    const legacyTargets = new Map<string, ExecutionTargetDefinition[] | undefined>();
    const stopIntents = this.sessionStopIntents();
    return rows.map((r) => this.sessionView(r, legacyTargets, stopIntents.get(r.id)));
  }

  private legacyExecutionTargets(runnerId: string): ExecutionTargetDefinition[] | undefined {
    const runner = this.stmt(
      "SELECT runner_id, hostname, status, protocol_version, runtime FROM runners WHERE runner_id=?",
    ).get(runnerId) as unknown as Pick<RunnerRow,
      "runner_id" | "hostname" | "status" | "protocol_version" | "runtime"
    > | undefined;
    if (!runner || !runnerSupportsProtocol(runner.protocol_version, "executionTargets")) return undefined;
    return executionTargetsForHost({
      runnerId: runner.runner_id,
      hostname: runner.hostname,
      status: runner.status as RunnerStatus,
      runtime: runnerSupportsProtocol(runner.protocol_version, "runtimeDiagnostics")
        ? (parseJson<RunnerView["runtime"]>(runner.runtime) ?? undefined)
        : undefined,
    }, this.boxIdForRunner(runnerId) !== null);
  }

  private sessionView(
    row: SessionRow,
    legacyTargetCache?: Map<string, ExecutionTargetDefinition[] | undefined>,
    stopIntent?: SessionStopIntentRecord,
  ): SessionView {
    const agentName = row.agent_id
      ? ((this.stmt("SELECT name FROM agent_definitions WHERE id=?").get(row.agent_id) as
          | { name: string }
          | undefined)?.name ?? row.agent_id)
      : null;
    const workspaceName = row.workspace_id
      ? this.workspaceDisplayName(row.runner_id, row.workspace_id)
      : null;
    const projectName = row.project_id
      ? ((this.stmt("SELECT name FROM projects WHERE id=?").get(row.project_id) as
          | { name: string }
          | undefined)?.name ?? null)
      : null;
    // Maintained by appendEvent/clearSessionEvents (backfilled at open) — a COUNT(*) here ran
    // twice per streamed delta and scaled with session length. NULL only for a session created
    // this process-lifetime with no events yet, which is exactly 0.
    const count = row.message_count ?? 0;

    const status = row.status as SessionStatus;
    const column = (row.board_column as BoardColumn | null) ?? columnForStatus(status);
    const persistedTarget = parseJson<ExecutionTargetRef>(row.execution_target);
    let legacyTargets: ExecutionTargetDefinition[] | undefined;
    if (!persistedTarget) {
      if (legacyTargetCache) {
        if (!legacyTargetCache.has(row.runner_id)) {
          legacyTargetCache.set(row.runner_id, this.legacyExecutionTargets(row.runner_id));
        }
        legacyTargets = legacyTargetCache.get(row.runner_id);
      } else {
        legacyTargets = this.legacyExecutionTargets(row.runner_id);
      }
    }
    const target = persistedTarget ?? legacyTargets?.find((candidate) =>
      candidate.workspaceStrategy === (row.use_worktree === 1 ? "worktree" : "in_place")
    );

    let pending: PendingApproval | null = null;
    if (row.pending_approval) {
      try {
        pending = JSON.parse(row.pending_approval) as PendingApproval;
      } catch {
        pending = null;
      }
    }

    const durablePromptQueue = this.pendingSessionPromptQueue(row.id);
    const pendingPrompts = this.pendingSessionPrompts(row.id);
    return {
      id: row.id,
      runnerId: row.runner_id,
      workspaceId: row.workspace_id,
      workspaceName,
      projectId: row.project_id,
      projectName,
      projectLocationId: row.project_location_id,
      audience: this.sessionScope(row.id)?.owner.kind,
      importLocationReady: row.adopted === 1 ? Boolean(row.workspace_path?.trim()) : undefined,
      agentId: row.agent_id,
      agentName,
      title: row.title,
      titleSource: (row.title_source as SessionTitleSource | null) ?? "generated",
      providerUpdatedAt: row.provider_updated_at ?? undefined,
      backgroundWorkState: parseBackgroundWorkState(row.background_work_state),
      backgroundWorkTracking: parseBackgroundWorkTracking(row.background_work_tracking),
      ...(() => {
        const backgroundDeliveries = this.listBackgroundDeliveries(row.id, status);
        return backgroundDeliveries.length ? { backgroundDeliveries } : {};
      })(),
      ...(() => {
        const backgroundJobs = this.listManagedBackgroundJobs(row.id);
        return backgroundJobs.length ? {
          backgroundJobs,
          ...(this.managedBackgroundJobsTruncated(row.id) ? { backgroundJobsTruncated: true } : {}),
        } : {};
      })(),
      status,
      column,
      runId: row.run_id,
      useWorktree: row.use_worktree === 1,
      worktreePath: row.worktree_path,
      worktrees: (() => {
        const parsed = parseJson<SessionWorktreeView[]>(row.worktrees);
        return Array.isArray(parsed) ? parsed : undefined;
      })(),
      executionTarget: target ? {
        id: target.id,
        runnerId: target.runnerId,
        kind: target.kind,
        workspaceStrategy: target.workspaceStrategy,
        adapter: target.adapter,
        boundaries: target.boundaries,
        ...(target.environment ? { environment: target.environment } : {}),
        ...(target.policy ? { policy: target.policy } : {}),
      } : undefined,
      executionHandoff: (() => {
        try {
          return validateExecutionHandoffReceipt(parseJson<ExecutionHandoffReceipt>(row.execution_handoff) ?? undefined, target);
        } catch {
          return undefined;
        }
      })(),
      archived: row.archived === 1,
      archiveStatus: stopIntent?.archiveAfterStop ? stopIntent.operation.status : undefined,
      archiveOperation: stopIntent?.archiveAfterStop ? stopIntent.operation : undefined,
      stopOperation: stopIntent?.operation,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastEventAt: row.last_event_at,
      messageCount: count,
      eventEpoch: row.event_epoch ?? 0,
      preview: row.preview,
      pendingApproval: pending,
      ...(durablePromptQueue.length ? { queued: durablePromptQueue } : {}),
      ...(pendingPrompts.length ? { pendingPrompts } : {}),
      ...(() => {
        const steeringAttempts = this.listSteeringAttempts(row.id);
        return steeringAttempts.length ? { steeringAttempts } : {};
      })(),
      ...(() => {
        const commandInvocations = this.listSessionCommandInvocations(row.id);
        return commandInvocations.length ? { commandInvocations } : {};
      })(),
      driver: (row.driver as AgentDriverKind) ?? "acp",
      model: row.model,
      resolvedModel: row.resolved_model,
      effort: row.effort,
      permissionMode: row.permission_mode,
      agentCapabilities: parseJson<SessionCapabilities>(row.agent_capabilities) ?? undefined,
      tokensIn: row.input_tokens ?? 0,
      tokensOut: row.output_tokens ?? 0,
      contextTokensUsed: row.context_tokens_used ?? undefined,
      contextWindow: row.context_window ?? undefined,
      costUsd: row.cost_usd ?? 0,
      adopted: row.adopted === 1,
      costBudgetUsd: row.cost_budget_usd ?? null,
      costBudgetStepUsd: row.cost_budget_step_usd ?? row.cost_budget_usd ?? null,
      costCheckpointsUsd: ControlPlaneDb.parseCheckpoints(row.cost_checkpoints_usd),
      costCheckpointApprovedUsd: row.cost_checkpoint_approved_usd ?? null,
      costUnpricedAcknowledged: row.cost_unpriced_ack === 1,
      maxToolCalls: row.max_tool_calls ?? null,
      maxToolCallsStep: row.max_tool_calls_step ?? row.max_tool_calls ?? null,
      // Lazy: sessions without the guardrail never pay the COUNT (same class as messageCount).
      toolCallCount: row.max_tool_calls != null ? this.countToolCalls(row.id) : undefined,
    };
  }

  /** Commands not yet started remain visible across CP or runner restarts. A live runner queue
   * overlay replaces this projection once admission creates its own steer/cancel identities. */
  private pendingSessionPromptQueue(sessionId: string): QueuedPromptView[] {
    const rows = this.stmt(
      `SELECT command_id,payload_json,state,error FROM (
         SELECT command_id,payload_json,state,error,created_at,rowid AS prompt_rowid
         FROM session_prompt_commands
         WHERE session_id=? AND dismissed_at IS NULL
           AND state IN ('pending','sent','accepted','queued','failed','uncertain')
         ORDER BY created_at DESC,rowid DESC LIMIT 100
       ) ORDER BY created_at,prompt_rowid`,
    ).all(sessionId) as Array<{
      command_id: string;
      payload_json: string;
      state: SessionPromptCommandState;
      error: string | null;
    }>;
    return rows.flatMap((row) => {
      try {
        const command = JSON.parse(row.payload_json) as PromptSessionMessage;
        if (command.type !== "prompt_session") return [];
        const durableDeliveryState = row.state === "queued" || row.state === "failed" || row.state === "uncertain"
          ? row.state
          : "pending";
        return [{
          id: row.command_id,
          text: command.text.length > 500 ? `${command.text.slice(0, 500)}…` : command.text,
          hasImages: Boolean(command.images?.length),
          steerable: false,
          steerDisabledReason: durableDeliveryState === "failed" || durableDeliveryState === "uncertain"
            ? (row.error ?? "Durable delivery did not complete.")
            : "Waiting for durable runner admission.",
          durableDeliveryState,
          ...(row.error ? { durableDeliveryError: row.error } : {}),
        }];
      } catch {
        return [];
      }
    });
  }

  private pendingSessionPrompts(sessionId: string): PendingPromptView[] {
    const rows = this.stmt(
      `SELECT * FROM (
         SELECT *,rowid AS prompt_rowid FROM session_prompt_commands
         WHERE session_id=? AND dismissed_at IS NULL
           AND state IN ('pending','sent','accepted','queued','started','failed','uncertain')
         ORDER BY created_at DESC,rowid DESC LIMIT 100
       ) ORDER BY created_at,prompt_rowid`,
    ).all(sessionId) as unknown as SessionPromptCommandRow[];
    return rows.flatMap((row) => {
      if (row.state === "completed") return [];
      let command: PromptSessionMessage;
      try {
        command = JSON.parse(row.payload_json) as PromptSessionMessage;
      } catch {
        return [];
      }
      if (command?.type !== "prompt_session") return [];
      return [{
        commandId: row.command_id,
        text: command.text.length > 4_096 ? `${command.text.slice(0, 4_095)}…` : command.text,
        hasImages: Boolean(command.images?.length),
        state: row.state,
        revision: row.revision,
        attemptCount: row.attempt_count,
        ...(row.error ? { error: row.error } : {}),
        ...(row.error_code ? { errorCode: row.error_code } : {}),
        ...(row.user_event_seq != null ? { userEventSeq: row.user_event_seq } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.state === "pending" ? { canCancel: true } : {}),
        ...(row.state === "failed" || row.state === "uncertain" ? { canDismiss: true } : {}),
      }];
    });
  }

  /* ----------------------------- Events ---------------------------------- */

  private linkSessionEventArtifacts(
    eventId: number,
    eventPayloadArtifactIds: readonly string[],
    promptImages: readonly PromptImageReference[] = [],
  ): void {
    const insertEventPayload = this.stmt(
      `INSERT INTO session_event_artifacts (event_id, artifact_id)
       SELECT ?, id FROM artifacts
        WHERE id=? AND run_id IS NULL
          AND CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.purpose') END='session_event_payload'`,
    );
    for (const artifactId of new Set(eventPayloadArtifactIds)) {
      if (Number(insertEventPayload.run(eventId, artifactId).changes) !== 1) {
        throw new Error("session event payload artifact is missing or invalid");
      }
    }
    const event = this.stmt(
      `SELECT event.session_id,session.run_id FROM session_events event
       JOIN sessions session ON session.id=event.session_id WHERE event.id=?`,
    ).get(eventId) as { session_id: string; run_id: string | null } | undefined;
    if (!event && promptImages.length) throw new Error("session event disappeared before prompt image linking");
    const insertPromptImage = this.stmt(
      "INSERT OR IGNORE INTO session_event_artifacts (event_id,artifact_id) VALUES (?,?)",
    );
    for (const image of new Map(promptImages.map((item) => [item.artifactId, item])).values()) {
      const artifact = this.stmt(
        `SELECT id,run_id,session_id,kind,mime_type,encoding,size_bytes,sha256
         FROM artifacts WHERE id=?`,
      ).get(image.artifactId) as unknown as {
        id: string; run_id: string | null; session_id: string | null; kind: string;
        mime_type: string; encoding: string; size_bytes: number; sha256: string;
      } | undefined;
      const scopeAllowed = Boolean(event && artifact && (
        artifact.session_id === event.session_id ||
        (artifact.session_id && this.sessionForkIncludesAncestor(event.session_id, artifact.session_id)) ||
        (artifact.run_id && artifact.run_id === event.run_id)
      ));
      if (!artifact || artifact.kind !== "screenshot" || artifact.encoding !== "base64" ||
          artifact.mime_type !== image.mimeType || artifact.size_bytes !== image.sizeBytes ||
          artifact.sha256 !== image.sha256 || !scopeAllowed) continue;
      insertPromptImage.run(eventId, image.artifactId);
    }
  }

  appendEvent(
    sessionId: string,
    payload: SessionEventPayload,
    ts: number,
    options?: {
      accrueUsage?: boolean;
      runnerSeq?: number;
      historyEpoch?: number | null;
      /** Pre-externalization shape; indexed into FTS but never retained in event JSON or frames. */
      searchPayload?: SessionEventPayload;
      /** Event-only artifact chunks committed atomically with this cached event row. */
      artifactIds?: readonly string[];
      /** Only a live runner event may correlate this delivery with a future trailing idle. */
      armBackgroundStatusSettlement?: boolean;
    },
  ): SessionEvent {
    if (options?.runnerSeq !== undefined &&
        (!Number.isSafeInteger(options.runnerSeq) || options.runnerSeq < 0)) {
      throw new RangeError("runnerSeq must be a non-negative safe integer when present");
    }
    // One transaction for the seq read + insert + session-row maintenance: this is the hottest
    // write path (one call per streamed delta) and was previously 5 separate auto-commit
    // statements — 5 WAL commits per token chunk, and a torn crash could desync seq/counters.
    let appended: SessionEvent;
    this.db.exec("BEGIN");
    try {
      const seq =
        ((
          this.stmt("SELECT MAX(seq) AS m FROM session_events WHERE session_id=?")
            .get(sessionId) as unknown as { m: number | null }
        ).m ?? 0) + 1;

      const info = this.stmt(
          `INSERT INTO session_events (session_id, seq, runner_seq, ts, kind, payload)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(sessionId, seq, options?.runnerSeq ?? null, ts, payload.kind, JSON.stringify(payload));
      if (payload.kind === "background_continuation_delivered") {
        const eventEpoch = (this.stmt("SELECT event_epoch FROM sessions WHERE id=?").get(sessionId) as
          | { event_epoch: number }
          | undefined)?.event_epoch ?? 0;
        this.projectBackgroundContinuationInTransaction(
          sessionId,
          payload,
          ts,
          eventEpoch,
          seq,
          options?.armBackgroundStatusSettlement === true,
        );
      }
      this.linkSessionEventArtifacts(
        Number(info.lastInsertRowid),
        options?.artifactIds ?? [],
        userMessagePromptImageReferences(payload),
      );

      // Maintain the transcript search index (Cmd+K) — the SAME policy as the open-time
      // catch-up (searchTextForEvent), in the same transaction as the event row so a torn
      // write can't desync the index. fts_state.last_rowid advances for EVERY event (indexed
      // or not) so the catch-up cursor never re-processes rows this build already handled.
      const ftsText = searchTextForEvent(options?.searchPayload ?? payload);
      if (ftsText) {
        this.stmt("INSERT INTO session_events_fts(text, session_id, seq) VALUES (?, ?, ?)").run(
          ftsText,
          sessionId,
          seq,
        );
      }
      this.stmt("UPDATE fts_state SET last_rowid=? WHERE id=1 AND last_rowid<?").run(
        Number(info.lastInsertRowid),
        Number(info.lastInsertRowid),
      );

      // Maintain card preview + last activity + the message_count counter (sessionView reads the
      // counter instead of COUNT(*)-ing the event table on every broadcast).
      if (payload.kind === "user_message") {
        this.stmt(
            "UPDATE sessions SET last_event_at=?, message_count=COALESCE(message_count,0)+1, preview='' WHERE id=?",
          )
          .run(ts, sessionId);
      } else if (payload.kind === "agent_message" && payload.text) {
        const prev =
          (this.stmt("SELECT preview FROM sessions WHERE id=?").get(sessionId) as
            | { preview: string | null }
            | undefined)?.preview ?? "";
        const next = (prev + payload.text).slice(-240);
        this.stmt(
            "UPDATE sessions SET last_event_at=?, message_count=COALESCE(message_count,0)+1, preview=? WHERE id=?",
          )
          .run(ts, next, sessionId);
      } else {
        this.stmt(
            "UPDATE sessions SET last_event_at=?, message_count=COALESCE(message_count,0)+1 WHERE id=?",
          )
          .run(ts, sessionId);
      }

      if (options?.runnerSeq !== undefined) {
        this.stmt("UPDATE sessions SET hydrated_seq=? WHERE id=? AND hydrated_seq < ?")
          .run(options.runnerSeq, sessionId, options.runnerSeq);
      }

      if (options?.accrueUsage) {
        this.recordUsageEventInTransaction(
          sessionId,
          payload,
          ts,
          options.runnerSeq !== undefined
            ? { runnerSeq: options.runnerSeq, historyEpoch: options.historyEpoch ?? null }
            : undefined,
        );
      }

      this.db.exec("COMMIT");
      appended = {
        id: Number(info.lastInsertRowid),
        sessionId,
        seq,
        ts,
        payload,
      };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    if (options?.accrueUsage) this.maybeMaintainUsageAggregation();
    return appended;
  }

  /** Atomically apply one contiguous runner-owned page while retaining independent CP event seq/id
   * allocation. Expectation drift is a normal stale response and applies nothing. */
  appendHydratedPage(
    sessionId: string,
    expected: { afterSeq: number; historyEpoch: number; eventEpoch: number },
    events: readonly HydratedRunnerEvent[],
    options: { armBackgroundStatusSettlement?: boolean } = {},
  ): AppendHydratedPageResult {
    for (const [name, value] of Object.entries(expected)) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer`);
      }
    }
    for (let index = 0; index < events.length; index++) {
      const event = events[index]!;
      if (event.seq !== expected.afterSeq + index + 1) {
        throw new RangeError("hydrated runner events must be contiguous after the expected cursor");
      }
      if (!Number.isSafeInteger(event.ts) || event.ts < 0) {
        throw new RangeError("hydrated runner event timestamps must be non-negative safe integers");
      }
    }

    let appliedResult: AppendHydratedPageResult;
    this.db.exec("BEGIN");
    try {
      const state = this.stmt(
        `SELECT hydrated_seq, runner_history_epoch, event_epoch, preview
           FROM sessions WHERE id=?`,
      ).get(sessionId) as {
        hydrated_seq: number;
        runner_history_epoch: number | null;
        event_epoch: number;
        preview: string | null;
      } | undefined;
      if (!state || state.hydrated_seq !== expected.afterSeq ||
          state.runner_history_epoch !== expected.historyEpoch ||
          state.event_epoch !== expected.eventEpoch) {
        this.db.exec("ROLLBACK");
        return { applied: false, events: [] };
      }
      if (events.length === 0) {
        this.db.exec("COMMIT");
        return { applied: true, events: [] };
      }

      const usageGeneration = this.stmt(
        "SELECT runner_history_epoch FROM usage_session_state WHERE session_id=?",
      ).get(sessionId) as { runner_history_epoch: number | null } | undefined;
      if (usageGeneration && usageGeneration.runner_history_epoch !== null &&
          usageGeneration.runner_history_epoch !== expected.historyEpoch) {
        // A known-to-known epoch change is replacement history. Cover this entire replay page
        // before visiting individual events; skipping only its first event would charge the rest
        // again. A later cumulative snapshot contributes only a missing positive residual.
        this.stmt(
          `UPDATE usage_session_state
              SET runner_history_epoch=?, covered_through_seq=?, updated_at=?
            WHERE session_id=?`,
        ).run(expected.historyEpoch, events[events.length - 1]!.seq, Date.now(), sessionId);
      }

      let cpSeq = ((this.stmt("SELECT MAX(seq) AS m FROM session_events WHERE session_id=?")
        .get(sessionId) as { m: number | null }).m ?? 0);
      let preview = state.preview;
      let maxRowId = 0;
      const inserted: SessionEvent[] = [];
      const insertEvent = this.stmt(
        `INSERT INTO session_events (session_id, seq, runner_seq, ts, kind, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const insertFts = this.stmt(
        "INSERT INTO session_events_fts(text, session_id, seq) VALUES (?, ?, ?)",
      );
      for (const event of events) {
        cpSeq += 1;
        const info = insertEvent.run(
          sessionId,
          cpSeq,
          event.seq,
          event.ts,
          event.payload.kind,
          JSON.stringify(event.payload),
        );
        const rowId = Number(info.lastInsertRowid);
        this.linkSessionEventArtifacts(
          rowId,
          event.artifactIds ?? [],
          userMessagePromptImageReferences(event.payload),
        );
        maxRowId = Math.max(maxRowId, rowId);
        const ftsText = searchTextForEvent(event.searchPayload ?? event.payload);
        if (ftsText) insertFts.run(ftsText, sessionId, cpSeq);
        if (event.payload.kind === "user_message") {
          preview = "";
        } else if (event.payload.kind === "agent_message" && event.payload.text) {
          preview = ((preview ?? "") + event.payload.text).slice(-240);
        }
        inserted.push({
          id: rowId,
          sessionId,
          seq: cpSeq,
          ts: event.ts,
          payload: event.payload,
        });
        this.projectBackgroundContinuationInTransaction(
          sessionId,
          event.payload,
          event.ts,
          state.event_epoch,
          cpSeq,
          options.armBackgroundStatusSettlement === true,
        );
        this.recordUsageEventInTransaction(
          sessionId,
          event.payload,
          event.ts,
          { historyEpoch: expected.historyEpoch, runnerSeq: event.seq },
        );
      }
      this.stmt("UPDATE fts_state SET last_rowid=? WHERE id=1 AND last_rowid<?")
        .run(maxRowId, maxRowId);
      const finalRunnerSeq = events[events.length - 1]!.seq;
      const finalTs = events[events.length - 1]!.ts;
      this.stmt(
        `UPDATE sessions
            SET hydrated_seq=?,
                runner_history_tail_seq=CASE WHEN runner_history_tail_seq < ? THEN ? ELSE runner_history_tail_seq END,
                last_event_at=?, message_count=COALESCE(message_count,0)+?, preview=?
          WHERE id=?`,
      ).run(finalRunnerSeq, finalRunnerSeq, finalRunnerSeq, finalTs, events.length, preview, sessionId);
      this.db.exec("COMMIT");
      appliedResult = { applied: true, events: inserted };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.maybeMaintainUsageAggregation();
    return appliedResult;
  }

  listEvents(sessionId: string, afterSeq = 0): SessionEvent[] {
    const rows = this.stmt(
        "SELECT id, session_id, seq, ts, payload FROM session_events WHERE session_id=? AND seq>? ORDER BY seq",
      )
      .all(sessionId, afterSeq) as unknown as {
      id: number;
      session_id: string;
      seq: number;
      ts: number;
      payload: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      seq: r.seq,
      ts: r.ts,
      payload: JSON.parse(r.payload) as SessionEventPayload,
    }));
  }

  hasCompletedUserMessage(sessionId: string): boolean {
    return Boolean(this.stmt(
      `SELECT 1 FROM session_events
       WHERE session_id=? AND kind='user_message'
         AND COALESCE(json_extract(payload, '$.final'), 1) != 0
         AND json_type(payload, '$.commandInvocation') IS NULL
       LIMIT 1`,
    ).get(sessionId));
  }

  /** Original objective plus a bounded recent semantic tail, returned chronologically. */
  listSessionTitleContextEvents(sessionId: string, recentLimit = 8): SessionEvent[] {
    const predicate = `session_id=? AND (
      (kind='user_message' AND COALESCE(json_extract(payload, '$.final'), 1) != 0
        AND json_type(payload, '$.commandInvocation') IS NULL)
      OR (kind='agent_message' AND json_extract(payload, '$.final') = 1
        AND json_type(payload, '$.parentToolUseId') IS NULL))`;
    type TitleEventRow = { id: number; session_id: string; seq: number; ts: number; payload: string };
    const first = this.stmt(
      `SELECT id, session_id, seq, ts, payload FROM session_events WHERE ${predicate} ORDER BY seq LIMIT 1`,
    ).get(sessionId) as TitleEventRow | undefined;
    const recent = this.stmt(
      `SELECT id, session_id, seq, ts, payload FROM session_events WHERE ${predicate} ORDER BY seq DESC LIMIT ?`,
    ).all(sessionId, recentLimit) as unknown as TitleEventRow[];
    const rows = [...new Map([...(first ? [first] : []), ...recent].map((row) => [row.id, row])).values()]
      .sort((left, right) => left.seq - right.seq);
    return rows.map((row) => ({
      id: row.id, sessionId: row.session_id, seq: row.seq, ts: row.ts,
      payload: JSON.parse(row.payload) as SessionEventPayload,
    }));
  }

  /** Latest runner-assigned turn coordinate visible in the cached transcript, when supported. */
  latestTurnId(sessionId: string): string | undefined {
    const row = this.stmt(
      "SELECT payload FROM session_events WHERE session_id=? AND kind='user_message' ORDER BY seq DESC LIMIT 1",
    ).get(sessionId) as { payload: string } | undefined;
    if (!row) return undefined;
    try {
      const payload = JSON.parse(row.payload) as Extract<SessionEventPayload, { kind: "user_message" }>;
      return typeof payload.turnId === "string" && payload.turnId ? payload.turnId : undefined;
    } catch {
      return undefined;
    }
  }

  /** One bounded page from the CP cache. The extra row is observed only to compute hasMore. */
  listCachedEventPage(sessionId: string, afterSeq: number, limit: number): CachedEventPage {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new RangeError("afterSeq must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("limit must be a positive safe integer");
    }
    const rows = this.stmt(
      `SELECT id, session_id, seq, ts, payload FROM session_events
        WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?`,
    ).all(sessionId, afterSeq, limit + 1) as unknown as Array<{
      id: number;
      session_id: string;
      seq: number;
      ts: number;
      payload: string;
    }>;
    const events = rows.slice(0, limit).map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      seq: row.seq,
      ts: row.ts,
      payload: JSON.parse(row.payload) as SessionEventPayload,
    }));
    return {
      events,
      nextAfterSeq: events.at(-1)?.seq ?? afterSeq,
      hasMore: rows.length > limit,
    };
  }

  /** One bounded page ending at the cached tail (`beforeSeq` absent) or immediately below
   * `beforeSeq`. Reads descending so the newest rows cost one indexed seek regardless of how long
   * the session is, then returns them ascending. The extra row only computes `hasMoreOlder`. */
  listCachedEventTailPage(
    sessionId: string,
    beforeSeq: number | undefined,
    limit: number,
    options: { alignToTurn?: boolean } = {},
  ): CachedEventTailPage {
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)) {
      throw new RangeError("beforeSeq must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("limit must be a positive safe integer");
    }
    const rows = (beforeSeq === undefined
      ? this.stmt(
        `SELECT id, session_id, seq, ts, payload FROM session_events
          WHERE session_id=? ORDER BY seq DESC LIMIT ?`,
      ).all(sessionId, limit + 1)
      : this.stmt(
        `SELECT id, session_id, seq, ts, payload FROM session_events
          WHERE session_id=? AND seq<? ORDER BY seq DESC LIMIT ?`,
      ).all(sessionId, beforeSeq, limit + 1)) as unknown as Array<{
        id: number;
        session_id: string;
        seq: number;
        ts: number;
        payload: string;
      }>;
    const pageRows = rows.slice(0, limit);
    const events = pageRows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      seq: row.seq,
      ts: row.ts,
      payload: JSON.parse(row.payload) as SessionEventPayload,
    })).reverse();
    const page: CachedEventTailPage = {
      events,
      ...(events[0] ? { nextBeforeSeq: events[0].seq } : {}),
      hasMoreOlder: rows.length > limit,
    };
    if (options.alignToTurn !== true || !page.hasMoreOlder || events[0] === undefined) return page;
    const pagePayloadBytes = pageRows.reduce((total, row) =>
      total + Buffer.byteLength(row.payload, "utf8"), 0);
    return this.alignTailPageToTurn(sessionId, page, events[0].seq, pagePayloadBytes);
  }

  /** Extend a count-bounded tail page down to the start of the turn it begins inside, so its first
   * rows are an invocation and its updates rather than orphaned updates. Uses the same
   * (session_id, seq) index as the page itself and stops at the alignment cap. */
  private alignTailPageToTurn(
    sessionId: string,
    page: CachedEventTailPage,
    windowStartSeq: number,
    windowPayloadBytes: number,
  ): CachedEventTailPage {
    // The anchor search includes the page's own first row: a page that already begins at a user
    // message is aligned, and reaching past it would drag in an entire extra turn.
    const floor = Math.max(0, windowStartSeq - TAIL_TURN_ALIGNMENT_MAX_EVENTS);
    const anchor = this.stmt(
      `SELECT seq FROM session_events
        WHERE session_id=? AND kind='user_message' AND seq<=? AND seq>=?
        ORDER BY seq DESC LIMIT 1`,
    ).get(sessionId, windowStartSeq, floor) as { seq: number } | undefined;
    // No anchor within reach: an adopted transcript, a resumed session, or a turn longer than the
    // cap. The count boundary stands, and the page says it is unaligned.
    if (!anchor) return { ...page, turnAligned: false };
    // The count boundary itself is already a semantic boundary, so no extension (or extension
    // budget) is needed even when the requested page's own payload exceeds the safety ceiling.
    if (anchor.seq === windowStartSeq) return { ...page, turnAligned: true };
    const extension = this.stmt(
      `SELECT COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS payload_bytes
        FROM session_events WHERE session_id=? AND seq>=? AND seq<?`,
    ).get(sessionId, anchor.seq, windowStartSeq) as { payload_bytes: number };
    if (windowPayloadBytes + Number(extension.payload_bytes) > TAIL_TURN_ALIGNMENT_MAX_PAYLOAD_BYTES) {
      return { ...page, turnAligned: false };
    }
    const rows = this.stmt(
      `SELECT id, session_id, seq, ts, payload FROM session_events
        WHERE session_id=? AND seq>=? AND seq<? ORDER BY seq`,
    ).all(sessionId, anchor.seq, windowStartSeq) as unknown as Array<{
      id: number;
      session_id: string;
      seq: number;
      ts: number;
      payload: string;
    }>;
    const older = rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      seq: row.seq,
      ts: row.ts,
      payload: JSON.parse(row.payload) as SessionEventPayload,
    }));
    const events = [...older, ...page.events];
    const remaining = this.stmt(
      "SELECT 1 FROM session_events WHERE session_id=? AND seq<? LIMIT 1",
    ).get(sessionId, anchor.seq) as { 1: number } | undefined;
    return {
      events,
      nextBeforeSeq: anchor.seq,
      hasMoreOlder: remaining !== undefined,
      turnAligned: true,
    };
  }

  /** Point-in-time boundary and preflight size for operational transcript exports. */
  sessionEventSnapshot(sessionId: string): { throughSeq: number; eventCount: number; sourceBytes: number } {
    const row = this.stmt(
      `SELECT COALESCE(MAX(seq), 0) AS through_seq, COUNT(*) AS event_count,
              COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS source_bytes
       FROM session_events WHERE session_id=?`,
    ).get(sessionId) as { through_seq: number; event_count: number; source_bytes: number };
    return {
      throughSeq: Number(row.through_seq),
      eventCount: Number(row.event_count),
      sourceBytes: Number(row.source_bytes),
    };
  }

  /** Machine-local roots that must be removed from operational transcript message text. */
  sessionSensitivePaths(id: string): string[] {
    const row = this.stmt(
      "SELECT runner_id, workspace_id, workspace_path, worktree_path FROM sessions WHERE id=?",
    ).get(id) as { runner_id: string; workspace_id: string | null; workspace_path: string | null; worktree_path: string | null } | undefined;
    if (!row) return [];
    const workspace = row.workspace_id ? this.getWorkspacePath(row.runner_id, row.workspace_id) : null;
    return [...new Set([row.workspace_path, row.worktree_path, workspace].filter((path): path is string => Boolean(path)))];
  }

  /** Read exactly one bounded snapshot. Callers must reject an oversized count before invoking. */
  listEventsThrough(sessionId: string, throughSeq: number, limit: number): SessionEvent[] {
    const rows = this.stmt(
      `SELECT id, session_id, seq, ts, payload FROM session_events
       WHERE session_id=? AND seq<=? ORDER BY seq LIMIT ?`,
    ).all(sessionId, throughSeq, limit) as unknown as Array<{
      id: number;
      session_id: string;
      seq: number;
      ts: number;
      payload: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      seq: row.seq,
      ts: row.ts,
      payload: JSON.parse(row.payload) as SessionEventPayload,
    }));
  }

  /**
   * Read only fields the operational transcript projector can consume. Excluded images, diffs,
   * tool output, and other large JSON members stay inside SQLite after the raw-byte preflight.
   */
  listTranscriptEventsThrough(sessionId: string, throughSeq: number, limit: number): SessionEvent[] {
    const rows = this.stmt(
      `SELECT id, session_id, seq, ts, kind,
              json_extract(payload, '$.kind') AS payload_kind,
              CASE WHEN kind IN ('user_message','agent_message') THEN json_extract(payload, '$.text') END AS text,
              CASE WHEN kind='agent_message' THEN json_type(payload, '$.final') END AS final_type,
              CASE WHEN kind='agent_message' THEN json_extract(payload, '$.final') END AS final_value,
              CASE WHEN kind='agent_message' THEN json_type(payload, '$.parentToolUseId') END AS parent_type,
              CASE WHEN kind='agent_message' THEN json_extract(payload, '$.parentToolUseId') END AS parent_value,
              CASE WHEN kind='agent_message' THEN json_type(payload, '$.messageId') END AS message_id_type,
              CASE WHEN kind='agent_message' THEN json_extract(payload, '$.messageId') END AS message_id_value
       FROM session_events WHERE session_id=? AND seq<=? ORDER BY seq LIMIT ?`,
    ).all(sessionId, throughSeq, limit) as unknown as Array<{
      id: number;
      session_id: string;
      seq: number;
      ts: number;
      kind: string;
      payload_kind: unknown;
      text: unknown;
      final_type: string | null;
      final_value: unknown;
      parent_type: string | null;
      parent_value: unknown;
      message_id_type: string | null;
      message_id_value: unknown;
    }>;
    return rows.map((row) => {
      let payload: SessionEventPayload;
      const invalidMetadata = row.payload_kind !== row.kind ||
        (row.kind === "agent_message" && row.final_type !== null && row.final_type !== "true" && row.final_type !== "false") ||
        (row.kind === "agent_message" && row.parent_type !== null && row.parent_type !== "text") ||
        (row.kind === "agent_message" && row.message_id_type !== null && row.message_id_type !== "text");
      if (invalidMetadata) {
        payload = { kind: "__invalid_transcript_source" } as unknown as SessionEventPayload;
      } else if (row.kind === "user_message") {
        payload = { kind: "user_message", text: row.text as string };
      } else if (row.kind === "agent_message") {
        payload = {
          kind: "agent_message",
          text: row.text as string,
          ...(row.final_type !== null ? { final: row.final_type === "true" } : {}),
          ...(row.parent_type !== null ? { parentToolUseId: row.parent_value as string } : {}),
          ...(row.message_id_type !== null ? { messageId: row.message_id_value as string } : {}),
        };
      } else {
        // The projector exhaustively decides which known kinds are omitted and rejects unknowns.
        payload = { kind: row.kind } as SessionEventPayload;
      }
      return { id: row.id, sessionId: row.session_id, seq: row.seq, ts: row.ts, payload };
    });
  }

  private transcriptShareView(row: {
    share_id: string;
    session_id: string;
    created_by_user_id: string;
    created_at: number;
    expires_at: number;
    revoked_at: number | null;
  }, now: number): TranscriptShareView {
    return {
      shareId: row.share_id,
      sessionId: row.session_id,
      createdByUserId: row.created_by_user_id,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      status: row.revoked_at !== null ? "revoked" : Number(row.expires_at) <= now ? "expired" : "active",
      ...(row.revoked_at !== null ? { revokedAt: Number(row.revoked_at) } : {}),
    };
  }

  /** Atomically enforce the per-session live-share ceiling while persisting one frozen snapshot. */
  createTranscriptShare(
    input: CreateTranscriptShareRecordInput,
    maxActive: number,
    maxActiveBytesPerSession: number,
    maxActiveBytesPerOrganization: number,
  ): TranscriptShareView | "count_limit" | "byte_limit" {
    if (!Number.isSafeInteger(input.projectionBytes) || input.projectionBytes < 1 ||
        input.projectionBytes !== Buffer.byteLength(input.projectionJson, "utf8")) {
      throw new RangeError("projectionBytes must equal the positive UTF-8 projection size");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.stmt(
        "UPDATE transcript_shares SET projection_json=NULL WHERE projection_json IS NOT NULL AND (revoked_at IS NOT NULL OR expires_at<=?)",
      ).run(input.createdAt);
      this.stmt(
        `DELETE FROM transcript_shares WHERE share_id IN (
           SELECT share_id FROM transcript_shares
           WHERE session_id=? AND (revoked_at IS NOT NULL OR expires_at<=?)
           ORDER BY created_at DESC, share_id DESC LIMIT -1 OFFSET ?
         )`,
      ).run(input.sessionId, input.createdAt, TRANSCRIPT_SHARE_TERMINAL_RETENTION_PER_SESSION);
      const active = this.stmt(
        `SELECT COUNT(*) AS count, COALESCE(SUM(projection_bytes), 0) AS bytes FROM transcript_shares
         WHERE session_id=? AND revoked_at IS NULL AND expires_at>?`,
      ).get(input.sessionId, input.createdAt) as { count: number; bytes: number };
      if (Number(active.count) >= maxActive) {
        this.db.exec("ROLLBACK");
        return "count_limit";
      }
      const organization = this.stmt(
        `SELECT COALESCE(SUM(projection_bytes), 0) AS bytes FROM transcript_shares
         WHERE organization_id=? AND revoked_at IS NULL AND expires_at>?`,
      ).get(input.organizationId, input.createdAt) as { bytes: number };
      if (Number(active.bytes) + input.projectionBytes > maxActiveBytesPerSession ||
          Number(organization.bytes) + input.projectionBytes > maxActiveBytesPerOrganization) {
        this.db.exec("ROLLBACK");
        return "byte_limit";
      }
      this.stmt(
        `INSERT INTO transcript_shares
         (share_id, token_hash, session_id, organization_id, created_by_user_id, projection_json, projection_bytes,
          snapshot_through_seq, schema_version, created_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        input.shareId,
        input.tokenHash,
        input.sessionId,
        input.organizationId,
        input.createdByUserId,
        input.projectionJson,
        input.projectionBytes,
        input.snapshotThroughSeq,
        input.schemaVersion,
        input.createdAt,
        input.expiresAt,
      );
      this.db.exec("COMMIT");
      return this.transcriptShareView({
        share_id: input.shareId,
        session_id: input.sessionId,
        created_by_user_id: input.createdByUserId,
        created_at: input.createdAt,
        expires_at: input.expiresAt,
        revoked_at: null,
      }, input.createdAt);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listTranscriptShares(sessionId: string, now: number): TranscriptShareView[] {
    this.stmt(
      "UPDATE transcript_shares SET projection_json=NULL WHERE session_id=? AND projection_json IS NOT NULL AND (revoked_at IS NOT NULL OR expires_at<=?)",
    ).run(sessionId, now);
    const rows = this.stmt(
      `SELECT share_id, session_id, created_by_user_id, created_at, expires_at, revoked_at
       FROM transcript_shares WHERE session_id=?
       ORDER BY CASE WHEN revoked_at IS NULL AND expires_at>? THEN 0 ELSE 1 END,
                created_at DESC, share_id DESC LIMIT ?`,
    ).all(sessionId, now, 20 + TRANSCRIPT_SHARE_TERMINAL_RETENTION_PER_SESSION) as unknown as Array<{
      share_id: string;
      session_id: string;
      created_by_user_id: string;
      created_at: number;
      expires_at: number;
      revoked_at: number | null;
    }>;
    return rows.map((row) => this.transcriptShareView(row, now));
  }

  revokeTranscriptShare(sessionId: string, shareId: string, now: number): TranscriptShareView | null {
    const row = this.stmt(
      `SELECT share_id, session_id, created_by_user_id, created_at, expires_at, revoked_at
       FROM transcript_shares WHERE share_id=? AND session_id=?`,
    ).get(shareId, sessionId) as unknown as {
      share_id: string;
      session_id: string;
      created_by_user_id: string;
      created_at: number;
      expires_at: number;
      revoked_at: number | null;
    } | undefined;
    if (!row) return null;
    const revokedAt = row.revoked_at ?? now;
    this.stmt(
      "UPDATE transcript_shares SET revoked_at=?, projection_json=NULL WHERE share_id=? AND session_id=?",
    ).run(revokedAt, shareId, sessionId);
    this.stmt(
      `DELETE FROM transcript_shares WHERE share_id IN (
         SELECT share_id FROM transcript_shares
         WHERE session_id=? AND (revoked_at IS NOT NULL OR expires_at<=?)
         ORDER BY created_at DESC, share_id DESC LIMIT -1 OFFSET ?
       )`,
    ).run(sessionId, now, TRANSCRIPT_SHARE_TERMINAL_RETENTION_PER_SESSION);
    return this.transcriptShareView({ ...row, revoked_at: revokedAt }, now);
  }

  /** Metadata-only capability lookup. Large projection bytes are fetched only after rate admission. */
  transcriptShareByTokenHash(tokenHash: string, now: number): {
    shareId: string;
    expiresAt: number;
    schemaVersion: number;
  } | null {
    const row = this.stmt(
      `SELECT share_id, projection_json IS NOT NULL AS has_projection, expires_at, revoked_at, schema_version
       FROM transcript_shares WHERE token_hash=?`,
    ).get(tokenHash) as unknown as {
      share_id: string;
      has_projection: number;
      expires_at: number;
      revoked_at: number | null;
      schema_version: number;
    } | undefined;
    if (!row) return null;
    if (row.revoked_at !== null || Number(row.expires_at) <= now || !row.has_projection) {
      if (row.has_projection) {
        this.stmt("UPDATE transcript_shares SET projection_json=NULL WHERE share_id=?").run(row.share_id);
      }
      return null;
    }
    return {
      shareId: row.share_id,
      expiresAt: Number(row.expires_at),
      schemaVersion: Number(row.schema_version),
    };
  }

  /** Repeat lifecycle predicates while loading bytes so a revoke/expiry can never fall through. */
  transcriptShareContentById(shareId: string, now: number): string | null {
    const row = this.stmt(
      `SELECT projection_json FROM transcript_shares
       WHERE share_id=? AND revoked_at IS NULL AND expires_at>? AND projection_json IS NOT NULL`,
    ).get(shareId, now) as { projection_json: string } | undefined;
    return row?.projection_json ?? null;
  }

  /* -------------------------- Review findings --------------------------- */

  private reviewFinding(row: ReviewFindingRow): ReviewFinding {
    return {
      findingId: row.finding_id,
      sessionId: row.session_id,
      scope: row.scope,
      diffHash: row.diff_hash,
      filePath: row.file_path,
      side: row.side,
      line: row.line,
      body: row.body,
      severity: row.severity,
      required: row.required === 1,
      status: row.status,
      source: row.source,
      author: { kind: row.author_kind, ...(row.author_id ? { id: row.author_id } : {}) },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.sent_at != null ? { sentAt: row.sent_at } : {}),
      ...(row.resolved_at != null ? { resolvedAt: row.resolved_at } : {}),
      ...(row.resolved_by_kind
        ? { resolvedBy: { kind: row.resolved_by_kind, ...(row.resolved_by_id ? { id: row.resolved_by_id } : {}) } }
        : {}),
      ...(row.remote_provider === "github" && row.remote_repository && row.remote_pr_number != null &&
          row.remote_thread_id && row.remote_comment_id != null && row.remote_url && row.remote_commit_id &&
          row.remote_outdated != null && row.remote_subject_type && row.remote_synchronized_at != null
        ? {
            remote: {
              provider: "github" as const,
              repository: row.remote_repository,
              pullRequestNumber: row.remote_pr_number,
              threadId: row.remote_thread_id,
              commentId: row.remote_comment_id,
              url: row.remote_url,
              commitId: row.remote_commit_id,
              outdated: row.remote_outdated === 1,
              subjectType: row.remote_subject_type,
              synchronizedAt: row.remote_synchronized_at,
            },
          }
        : {}),
    };
  }

  createReviewFinding(finding: ReviewFinding): ReviewFinding {
    this.stmt(
      `INSERT INTO review_findings
         (finding_id, session_id, scope, diff_hash, file_path, side, line, body, severity,
          required, status, source, author_kind, author_id, created_at, updated_at, sent_at, resolved_at,
          resolved_by_kind, resolved_by_id, remote_provider, remote_repository, remote_pr_number,
          remote_thread_id, remote_comment_id, remote_url, remote_commit_id, remote_outdated, remote_subject_type,
          remote_synchronized_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      finding.findingId, finding.sessionId, finding.scope, finding.diffHash, finding.filePath,
      finding.side, finding.line, finding.body, finding.severity, finding.required ? 1 : 0,
      finding.status, finding.source, finding.author.kind, finding.author.id ?? null,
      finding.createdAt, finding.updatedAt, finding.sentAt ?? null, finding.resolvedAt ?? null,
      finding.resolvedBy?.kind ?? null, finding.resolvedBy?.id ?? null,
      finding.remote?.provider ?? null, finding.remote?.repository ?? null,
      finding.remote?.pullRequestNumber ?? null, finding.remote?.threadId ?? null,
      finding.remote?.commentId ?? null, finding.remote?.url ?? null, finding.remote?.commitId ?? null,
      finding.remote == null ? null : finding.remote.outdated ? 1 : 0,
      finding.remote?.subjectType ?? null,
      finding.remote?.synchronizedAt ?? null,
    );
    return finding;
  }

  /** Reconcile one complete GitHub PR review-thread snapshot. Missing rows are dismissed only
   * after a successful authoritative read; transport/parser failures never reach this method. */
  reconcileGitHubReviewFindings(sessionId: string, sync: GitHubReviewSyncInfo): GitHubReviewReconciliation {
    const existingRows = this.stmt(
      `SELECT * FROM review_findings
       WHERE session_id=? AND remote_provider='github' AND remote_repository=? AND remote_pr_number=?`,
    ).all(sessionId, sync.repository, sync.pullRequestNumber) as unknown as ReviewFindingRow[];
    const existingByThread = new Map(existingRows.map((row) => [row.remote_thread_id!, row]));
    const seen = new Set<string>();
    const counts: GitHubReviewReconciliation = { imported: 0, updated: 0, resolved: 0, reopened: 0, dismissedMissing: 0 };

    this.db.exec("BEGIN");
    try {
      for (const thread of sync.threads) {
        seen.add(thread.threadId);
        const existing = existingByThread.get(thread.threadId);
        const anchorCurrent = thread.subjectType === "line" && !thread.outdated && sync.localHeadOid === sync.pullRequestHeadOid;
        const diffHash = anchorCurrent
          ? sync.diffHash
          : createHash("sha256").update(`github:${sync.repository}:${sync.pullRequestNumber}:${thread.threadId}:${thread.commitId}`).digest("hex");
        const desiredStatus: ReviewFindingStatus = thread.resolved
          ? "resolved"
          : existing?.status === "sent" ? "sent" : "open";
        if (!existing) {
          const now = Math.max(thread.updatedAt, thread.createdAt);
          this.createReviewFinding({
            findingId: `rf_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
            sessionId,
            scope: "all_branch",
            diffHash,
            filePath: thread.path,
            side: thread.side,
            line: thread.line,
            body: thread.body,
            severity: "major",
            required: true,
            status: desiredStatus,
            source: "github",
            author: { kind: "human", id: thread.author },
            createdAt: thread.createdAt,
            updatedAt: now,
            ...(thread.resolved ? { resolvedAt: thread.updatedAt, resolvedBy: { kind: "system", id: "github" } as const } : {}),
            remote: {
              provider: "github",
              repository: sync.repository,
              pullRequestNumber: sync.pullRequestNumber,
              threadId: thread.threadId,
              commentId: thread.commentId,
              url: thread.url,
              commitId: thread.commitId,
              outdated: thread.outdated,
              subjectType: thread.subjectType,
              synchronizedAt: sync.synchronizedAt,
            },
          });
          counts.imported += 1;
          continue;
        }

        const wasUnresolved = existing.status === "open" || existing.status === "sent";
        const changed = existing.scope !== "all_branch" || existing.diff_hash !== diffHash ||
          existing.file_path !== thread.path || existing.side !== thread.side || existing.line !== thread.line ||
          existing.body !== thread.body || existing.severity !== "major" || existing.required !== 1 ||
          existing.status !== desiredStatus || existing.author_kind !== "human" || existing.author_id !== thread.author ||
          existing.remote_comment_id !== thread.commentId || existing.remote_url !== thread.url ||
          existing.remote_commit_id !== thread.commitId || existing.remote_outdated !== (thread.outdated ? 1 : 0) ||
          existing.remote_subject_type !== thread.subjectType;
        if (changed) {
          const effectiveUpdatedAt = Math.max(existing.updated_at + 1, thread.updatedAt);
          this.stmt(
            `UPDATE review_findings SET
               scope='all_branch', diff_hash=?, file_path=?, side=?, line=?, body=?, severity='major',
               required=1, status=?, author_kind='human', author_id=?, updated_at=?,
               sent_at=CASE WHEN ?='sent' THEN sent_at ELSE NULL END,
               resolved_at=CASE WHEN ?='resolved' THEN ? ELSE NULL END,
               resolved_by_kind=CASE WHEN ?='resolved' THEN 'system' ELSE NULL END,
               resolved_by_id=CASE WHEN ?='resolved' THEN 'github' ELSE NULL END,
               remote_comment_id=?, remote_url=?, remote_commit_id=?, remote_outdated=?, remote_subject_type=?, remote_synchronized_at=?
             WHERE finding_id=?`,
          ).run(
            diffHash, thread.path, thread.side, thread.line, thread.body, desiredStatus, thread.author,
            effectiveUpdatedAt, desiredStatus, desiredStatus, thread.updatedAt, desiredStatus, desiredStatus,
            thread.commentId, thread.url, thread.commitId, thread.outdated ? 1 : 0, thread.subjectType, sync.synchronizedAt,
            existing.finding_id,
          );
          counts.updated += 1;
          if (thread.resolved && wasUnresolved) counts.resolved += 1;
          if (!thread.resolved && (existing.status === "resolved" || existing.status === "dismissed")) counts.reopened += 1;
        } else {
          this.stmt("UPDATE review_findings SET remote_synchronized_at=? WHERE finding_id=?")
            .run(sync.synchronizedAt, existing.finding_id);
        }
      }

      for (const existing of existingRows) {
        if (existing.remote_thread_id == null || seen.has(existing.remote_thread_id) || existing.status === "dismissed") continue;
        this.stmt(
          `UPDATE review_findings SET status='dismissed', required=0, sent_at=NULL,
             updated_at=MAX(updated_at + 1, ?), resolved_at=MAX(updated_at + 1, ?),
             resolved_by_kind='system', resolved_by_id='github-sync', remote_synchronized_at=?
           WHERE finding_id=?`,
        ).run(sync.synchronizedAt, sync.synchronizedAt, sync.synchronizedAt, existing.finding_id);
        counts.dismissedMissing += 1;
      }
      this.db.exec("COMMIT");
      return counts;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listReviewFindings(sessionId: string): ReviewFinding[] {
    const rows = this.stmt(
      `SELECT * FROM review_findings WHERE session_id=?
       ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'sent' THEN 1 ELSE 2 END, created_at, finding_id`,
    ).all(sessionId) as unknown as ReviewFindingRow[];
    return rows.map((row) => this.reviewFinding(row));
  }

  reviewFindingSummary(sessionId: string): ReviewFindingSummary {
    const row = this.stmt(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status IN ('open','sent') THEN 1 ELSE 0 END) AS unresolved,
              SUM(CASE WHEN required=1 AND status IN ('open','sent') THEN 1 ELSE 0 END) AS required_unresolved,
              SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) AS resolved,
              SUM(CASE WHEN status='dismissed' THEN 1 ELSE 0 END) AS dismissed
         FROM review_findings WHERE session_id=?`,
    ).get(sessionId) as unknown as {
      total: number; unresolved: number | null; required_unresolved: number | null;
      sent: number | null; resolved: number | null; dismissed: number | null;
    };
    const unresolved = row.unresolved ?? 0;
    const requiredUnresolved = row.required_unresolved ?? 0;
    return {
      total: row.total,
      unresolved,
      requiredUnresolved,
      sent: row.sent ?? 0,
      resolved: row.resolved ?? 0,
      dismissed: row.dismissed ?? 0,
      completion: requiredUnresolved > 0 ? "blocked" : unresolved > 0 ? "in_review" : "complete",
    };
  }

  updateReviewFindingStatus(input: {
    sessionId: string;
    findingId: string;
    status: Exclude<ReviewFindingStatus, "sent">;
    expectedUpdatedAt: number;
    now: number;
    actor: ReviewFinding["author"];
  }): { kind: "ok"; finding: ReviewFinding } | { kind: "not_found" | "stale" } {
    const existing = this.stmt("SELECT * FROM review_findings WHERE session_id=? AND finding_id=?")
      .get(input.sessionId, input.findingId) as unknown as ReviewFindingRow | undefined;
    if (!existing) return { kind: "not_found" };
    if (existing.updated_at !== input.expectedUpdatedAt) return { kind: "stale" };
    const effectiveNow = Math.max(input.now, existing.updated_at + 1);
    const resolvedAt = input.status === "resolved" || input.status === "dismissed" ? effectiveNow : null;
    const terminal = input.status === "resolved" || input.status === "dismissed";
    const result = this.stmt(
      `UPDATE review_findings SET status=?, updated_at=?, resolved_at=?, resolved_by_kind=?, resolved_by_id=?
       WHERE session_id=? AND finding_id=? AND updated_at=?`,
    ).run(
      input.status, effectiveNow, resolvedAt, terminal ? input.actor.kind : null,
      terminal ? input.actor.id ?? null : null,
      input.sessionId, input.findingId, input.expectedUpdatedAt,
    );
    if (Number(result.changes) !== 1) return { kind: "stale" };
    const row = this.stmt("SELECT * FROM review_findings WHERE finding_id=?").get(input.findingId) as unknown as ReviewFindingRow;
    return { kind: "ok", finding: this.reviewFinding(row) };
  }

  markReviewFindingsSent(
    sessionId: string,
    identities: Array<{ findingId: string; expectedUpdatedAt: number }>,
    now: number,
  ): ReviewFinding[] | null {
    this.db.exec("BEGIN");
    try {
      const update = this.stmt(
        `UPDATE review_findings
         SET status='sent',
             sent_at=COALESCE(sent_at, MAX(updated_at + 1, ?)),
             updated_at=MAX(updated_at + 1, ?)
         WHERE session_id=? AND finding_id=? AND updated_at=? AND status IN ('open','sent')`,
      );
      for (const identity of identities) {
        const result = update.run(now, now, sessionId, identity.findingId, identity.expectedUpdatedAt);
        if (Number(result.changes) !== 1) {
          this.db.exec("ROLLBACK");
          return null;
        }
      }
      this.db.exec("COMMIT");
      const ids = new Set(identities.map((identity) => identity.findingId));
      return this.listReviewFindings(sessionId).filter((finding) => ids.has(finding.findingId));
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /* ------------------------------- Runs ---------------------------------- */

  createRun(input: {
    id: string;
    title: string;
    prompt: string;
    workspaceId: string | null;
    runnerId: string | null;
    now: number;
  }): void {
    this.stmt(
        `INSERT INTO multi_agent_runs (id, title, prompt, workspace_id, runner_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.title, input.prompt, input.workspaceId, input.runnerId, input.now, input.now);
  }

  addRunMember(runId: string, sessionId: string, agentId: string | null): void {
    this.stmt("INSERT OR IGNORE INTO multi_agent_run_members (run_id, session_id, agent_id) VALUES (?, ?, ?)")
      .run(runId, sessionId, agentId);
  }

  getRun(id: string): RunView | null {
    const row = this.stmt("SELECT * FROM multi_agent_runs WHERE id=?").get(id) as unknown as
      | RunRow
      | undefined;
    if (!row) return null;
    return this.runView(row);
  }

  listRuns(): RunView[] {
    const rows = this.stmt("SELECT * FROM multi_agent_runs ORDER BY created_at DESC")
      .all() as unknown as RunRow[];
    return rows.map((r) => this.runView(r));
  }

  workflowRunScope(runId: string): { runnerId: string | null; workspaceId: string | null } | null {
    const row = this.stmt("SELECT runner_id, workspace_id FROM multi_agent_runs WHERE id=?").get(runId) as unknown as
      | { runner_id: string | null; workspace_id: string | null }
      | undefined;
    return row ? { runnerId: row.runner_id, workspaceId: row.workspace_id } : null;
  }

  private runView(row: RunRow): RunView {
    const sessionIds = (
      this.stmt("SELECT session_id FROM multi_agent_run_members WHERE run_id=? ORDER BY rowid")
        .all(row.id) as unknown as { session_id: string }[]
    ).map((m) => m.session_id);
    const workspaceName = row.workspace_id
      ? (row.runner_id
        ? this.workspaceDisplayName(row.runner_id, row.workspace_id)
        : ((this.stmt("SELECT name FROM workspaces WHERE id=? LIMIT 1").get(row.workspace_id) as
            | { name: string }
            | undefined)?.name ?? row.workspace_id))
      : null;
    return {
      id: row.id,
      title: row.title,
      prompt: row.prompt,
      workspaceId: row.workspace_id,
      workspaceName,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sessionIds,
    };
  }

  /* ------------------------------- Pods ---------------------------------- */

  createPod(input: {
    id: string;
    title: string;
    objective: string;
    sessionIds: string[];
    now: number;
  }): PodView | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.stmt(
        "INSERT INTO pods (id, title, objective, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
      ).run(input.id, input.title, input.objective, input.now, input.now);
      const insertMember = this.stmt(
        `INSERT INTO pod_members (pod_id, session_id, joined_at, role)
         SELECT ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM pod_members m JOIN pods p ON p.id=m.pod_id
           WHERE m.session_id=? AND p.status='active'
         )`,
      );
      for (const [index, sessionId] of input.sessionIds.entries()) {
        const inserted = insertMember.run(input.id, sessionId, input.now + index, index === 0 ? "lead" : "worker", sessionId);
        if (Number(inserted.changes) !== 1) {
          this.db.exec("ROLLBACK");
          return null;
        }
      }
      this.stmt(
        `INSERT INTO pod_orchestration
         (pod_id, mode, context_token_budget, summary_token_budget, max_turns,
          max_repeated_outputs, status, turns_used, updated_at)
         VALUES (?, 'manual', 4096, 512, 12, 2, 'idle', 0, ?)`,
      ).run(input.id, input.now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getPod(input.id);
  }

  getPod(id: string): PodView | null {
    const row = this.stmt("SELECT * FROM pods WHERE id=?").get(id) as unknown as PodRow | undefined;
    return row ? this.podView(row) : null;
  }

  listPods(): PodView[] {
    const rows = this.stmt("SELECT * FROM pods ORDER BY updated_at DESC, id")
      .all() as unknown as PodRow[];
    return rows.map((row) => this.podView(row));
  }

  activePodForSession(sessionId: string): PodView | null {
    const row = this.stmt(
      "SELECT p.* FROM pods p JOIN pod_members m ON m.pod_id=p.id WHERE m.session_id=? AND p.status='active' LIMIT 1",
    ).get(sessionId) as unknown as PodRow | undefined;
    return row ? this.podView(row) : null;
  }

  podsForSession(sessionId: string): PodView[] {
    const rows = this.stmt(
      "SELECT p.* FROM pods p JOIN pod_members m ON m.pod_id=p.id WHERE m.session_id=? ORDER BY p.updated_at DESC, p.id",
    ).all(sessionId) as unknown as PodRow[];
    return rows.map((row) => this.podView(row));
  }

  addPodMember(
    podId: string,
    sessionId: string,
    now: number,
    role: PodMemberRole = "worker",
    contextTokenBudget: number | null = null,
  ): PodView | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.stmt(
        `INSERT INTO pod_members (pod_id, session_id, joined_at, role, context_token_budget)
         SELECT ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM pods target
           WHERE target.id=? AND target.status='active'
             AND (SELECT COUNT(*) FROM pod_members existing WHERE existing.pod_id=target.id) < 12
         ) AND NOT EXISTS (
           SELECT 1 FROM pod_members m JOIN pods p ON p.id=m.pod_id
           WHERE m.session_id=? AND p.status='active'
         )`,
      ).run(podId, sessionId, now, role, contextTokenBudget, podId, sessionId);
      if (Number(inserted.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.stmt("UPDATE pods SET updated_at=? WHERE id=?").run(now, podId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getPod(podId);
  }

  removePodMember(podId: string, sessionId: string, now: number): PodView | null {
    const removed = this.stmt("DELETE FROM pod_members WHERE pod_id=? AND session_id=?")
      .run(podId, sessionId);
    if (Number(removed.changes) !== 1) return null;
    this.stmt("UPDATE pods SET updated_at=? WHERE id=?").run(now, podId);
    return this.getPod(podId);
  }

  closePod(podId: string, now: number): PodView | null {
    this.stopPodOrchestration(podId, "pod_closed", now);
    this.failPodReconciliations(podId, "pod closed during reconciliation", now);
    const changed = this.stmt(
      "UPDATE pods SET status='closed', updated_at=? WHERE id=? AND status='active'",
    ).run(now, podId);
    return Number(changed.changes) === 1 ? this.getPod(podId) : null;
  }

  /** Refresh a pod after a member disappeared through session/runner/box deletion. Active pods
   * require at least two members, so infrastructure cleanup closes an undersized pod atomically
   * instead of leaving an unusable active record behind. */
  reconcilePodAfterMembershipLoss(podId: string, now: number): PodView | null {
    const changed = this.stmt(
      `UPDATE pods
       SET status=CASE
         WHEN status='active' AND (SELECT COUNT(*) FROM pod_members WHERE pod_id=?) < 2 THEN 'closed'
         ELSE status
       END,
       updated_at=?
       WHERE id=?`,
    ).run(podId, now, podId);
    this.stmt(
      `UPDATE pod_orchestration
       SET status='stopped', current_session_id=NULL, stop_reason='membership_changed', updated_at=?
       WHERE pod_id=? AND status='running' AND (
         NOT EXISTS (SELECT 1 FROM pod_members WHERE pod_id=? AND session_id=current_session_id)
         OR EXISTS (SELECT 1 FROM pods WHERE id=? AND status='closed')
       )`,
    ).run(now, podId, podId, podId);
    this.stmt(
      `UPDATE pod_orchestration_steps SET status='failed', error='membership changed during orchestration', settled_at=?
       WHERE pod_id=? AND status IN ('dispatching','running')
         AND EXISTS (SELECT 1 FROM pod_orchestration o WHERE o.pod_id=? AND o.status='stopped')`,
    ).run(now, podId, podId);
    this.stmt(
      `UPDATE pod_reconciliations
       SET status='failed', error='membership changed during reconciliation', completed_at=?
       WHERE pod_id=? AND status='running' AND (
         NOT EXISTS (SELECT 1 FROM pod_members WHERE pod_id=? AND session_id=source_session_id)
         OR NOT EXISTS (SELECT 1 FROM pod_members WHERE pod_id=? AND session_id=target_session_id)
         OR EXISTS (SELECT 1 FROM pods WHERE id=? AND status='closed')
       )`,
    ).run(now, podId, podId, podId, podId);
    return Number(changed.changes) === 1 ? this.getPod(podId) : null;
  }

  touchPod(podId: string, now: number): PodView | null {
    const changed = this.stmt("UPDATE pods SET updated_at=? WHERE id=?").run(now, podId);
    return Number(changed.changes) === 1 ? this.getPod(podId) : null;
  }

  updatePodMember(
    podId: string,
    sessionId: string,
    patch: { role?: PodMemberRole; contextTokenBudget?: number | null },
    now: number,
  ): PodView | null {
    const current = this.stmt(
      "SELECT role, context_token_budget FROM pod_members WHERE pod_id=? AND session_id=?",
    ).get(podId, sessionId) as unknown as { role: PodMemberRole; context_token_budget: number | null } | undefined;
    if (!current) return null;
    const changed = this.stmt(
      `UPDATE pod_members SET role=?, context_token_budget=? WHERE pod_id=? AND session_id=?`,
    ).run(
      patch.role ?? current.role,
      patch.contextTokenBudget === undefined ? current.context_token_budget : patch.contextTokenBudget,
      podId,
      sessionId,
    );
    if (Number(changed.changes) !== 1) return null;
    this.stmt("UPDATE pods SET updated_at=? WHERE id=?").run(now, podId);
    return this.getPod(podId);
  }

  updatePodOrchestrationPolicy(podId: string, policy: PodOrchestrationPolicy, now: number): PodView | null {
    const changed = this.stmt(
      `UPDATE pod_orchestration
       SET mode=?, context_token_budget=?, summary_token_budget=?, max_turns=?,
           max_repeated_outputs=?, updated_at=?
       WHERE pod_id=? AND status<>'running'`,
    ).run(
      policy.mode,
      policy.contextTokenBudget,
      policy.summaryTokenBudget,
      policy.maxTurns,
      policy.maxRepeatedOutputs,
      now,
      podId,
    );
    if (Number(changed.changes) !== 1) return null;
    this.stmt("UPDATE pods SET updated_at=? WHERE id=?").run(now, podId);
    return this.getPod(podId);
  }

  startPodOrchestration(podId: string, runId: string, now: number): PodView | null {
    const changed = this.stmt(
      `UPDATE pod_orchestration
       SET status='running', run_id=?, turns_used=0, current_session_id=NULL,
           last_session_id=NULL, stop_reason=NULL, started_at=?, updated_at=?
       WHERE pod_id=? AND status<>'running'`,
    ).run(runId, now, now, podId);
    if (Number(changed.changes) !== 1) return null;
    this.stmt("UPDATE pods SET updated_at=? WHERE id=?").run(now, podId);
    return this.getPod(podId);
  }

  beginPodOrchestrationStep(input: {
    stepId: string;
    podId: string;
    runId: string;
    targetSessionId: string;
    triggerSessionId?: string;
    selectedEntryIds: string[];
    summarizedFromSeq?: number;
    summarizedToSeq?: number;
    estimatedTokens: number;
    now: number;
  }): PodOrchestrationStep | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.stmt(
        `SELECT turns_used, max_turns FROM pod_orchestration
         WHERE pod_id=? AND status='running' AND run_id=? AND current_session_id IS NULL`,
      ).get(input.podId, input.runId) as unknown as { turns_used: number; max_turns: number } | undefined;
      if (!state || state.turns_used >= state.max_turns) {
        this.db.exec("ROLLBACK");
        return null;
      }
      const turn = state.turns_used + 1;
      this.stmt(
        `INSERT INTO pod_orchestration_steps
         (step_id, pod_id, run_id, turn, target_session_id, trigger_session_id,
          selected_entry_ids, summarized_from_seq, summarized_to_seq, estimated_tokens,
          status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dispatching', ?)`,
      ).run(
        input.stepId,
        input.podId,
        input.runId,
        turn,
        input.targetSessionId,
        input.triggerSessionId ?? null,
        JSON.stringify(input.selectedEntryIds),
        input.summarizedFromSeq ?? null,
        input.summarizedToSeq ?? null,
        input.estimatedTokens,
        input.now,
      );
      this.stmt(
        `UPDATE pod_orchestration SET turns_used=?, current_session_id=?, last_session_id=?, updated_at=?
         WHERE pod_id=?`,
      ).run(turn, input.targetSessionId, input.targetSessionId, input.now, input.podId);
      this.stmt("UPDATE pods SET updated_at=? WHERE id=?").run(input.now, input.podId);
      this.db.exec("COMMIT");
      return this.podOrchestrationStep(
        this.stmt("SELECT * FROM pod_orchestration_steps WHERE step_id=?").get(input.stepId) as unknown as PodOrchestrationStepRow,
      );
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markPodOrchestrationStepRunning(stepId: string, podId: string, targetSessionId: string, maxContextSeq: number, now: number): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.stmt(
        "UPDATE pod_orchestration_steps SET status='running' WHERE step_id=? AND pod_id=? AND status='dispatching'",
      ).run(stepId, podId);
      if (Number(changed.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.stmt(
        `UPDATE pod_members SET last_context_seq=MAX(last_context_seq, ?)
         WHERE pod_id=? AND session_id=?`,
      ).run(maxContextSeq, podId, targetSessionId);
      this.stmt("UPDATE pod_orchestration SET updated_at=? WHERE pod_id=?").run(now, podId);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  settlePodOrchestrationStep(
    podId: string,
    sessionId: string,
    outputEntryId: string,
    outputHash: string,
    now: number,
  ): PodOrchestrationStep | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.stmt(
        `SELECT step.* FROM pod_orchestration_steps step
         JOIN pod_orchestration state ON state.pod_id=step.pod_id AND state.run_id=step.run_id
         WHERE state.pod_id=? AND state.status='running' AND state.current_session_id=?
           AND step.turn=state.turns_used AND step.target_session_id=? AND step.status='running'`,
      ).get(podId, sessionId, sessionId) as unknown as PodOrchestrationStepRow | undefined;
      if (!row) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.stmt(
        `UPDATE pod_orchestration_steps
         SET status='settled', output_entry_id=?, output_hash=?, settled_at=? WHERE step_id=?`,
      ).run(outputEntryId, outputHash, now, row.step_id);
      this.stmt(
        `UPDATE pod_orchestration SET current_session_id=NULL, updated_at=? WHERE pod_id=?`,
      ).run(now, podId);
      this.db.exec("COMMIT");
      return this.podOrchestrationStep({
        ...row,
        status: "settled",
        output_entry_id: outputEntryId,
        output_hash: outputHash,
        settled_at: now,
      });
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  countPodOrchestrationOutputHash(podId: string, runId: string, outputHash: string): number {
    return Number((this.stmt(
      `SELECT COUNT(*) AS count FROM pod_orchestration_steps
       WHERE pod_id=? AND run_id=? AND status='settled' AND output_hash=?`,
    ).get(podId, runId, outputHash) as unknown as { count: number }).count);
  }

  stopPodOrchestration(
    podId: string,
    reason: string,
    now: number,
    status: "paused" | "stopped" = "stopped",
  ): PodView | null {
    const state = this.stmt("SELECT status FROM pod_orchestration WHERE pod_id=?")
      .get(podId) as unknown as { status: PodOrchestrationView["state"]["status"] } | undefined;
    if (!state) return null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.stmt(
        `UPDATE pod_orchestration SET status=?, current_session_id=NULL, stop_reason=?, updated_at=? WHERE pod_id=?`,
      ).run(status, reason.slice(0, 1_000), now, podId);
      this.stmt(
        `UPDATE pod_orchestration_steps
         SET status='failed', error=?, settled_at=?
         WHERE pod_id=? AND status IN ('dispatching','running')`,
      ).run(reason.slice(0, 1_000), now, podId);
      this.stmt("UPDATE pods SET updated_at=? WHERE id=?").run(now, podId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getPod(podId);
  }

  pauseInterruptedPodOrchestrations(now: number): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.stmt(
        `UPDATE pods SET updated_at=?
         WHERE id IN (SELECT pod_id FROM pod_orchestration WHERE status='running')`,
      ).run(now);
      this.stmt(
        `UPDATE pod_orchestration_steps
         SET status='failed', error='control plane restarted with delivery state uncertain', settled_at=?
         WHERE status IN ('dispatching','running')`,
      ).run(now);
      this.stmt(
        `UPDATE pod_orchestration
         SET status='paused', current_session_id=NULL,
             stop_reason='control_plane_restart', updated_at=? WHERE status='running'`,
      ).run(now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  beginPodReconciliation(input: {
    reconciliationId: string;
    podId: string;
    sourceSessionId: string;
    targetSessionId: string;
    actorId: string;
    now: number;
  }): PodReconciliation | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.stmt(
        `INSERT INTO pod_reconciliations
         (reconciliation_id, pod_id, source_session_id, target_session_id, actor_id, status, created_at)
         SELECT ?, pod.id, ?, ?, ?, 'running', ? FROM pods pod
         WHERE pod.id=? AND pod.status='active'
           AND EXISTS (SELECT 1 FROM pod_members WHERE pod_id=pod.id AND session_id=?)
           AND EXISTS (SELECT 1 FROM pod_members WHERE pod_id=pod.id AND session_id=?)
           AND NOT EXISTS (SELECT 1 FROM pod_orchestration WHERE pod_id=pod.id AND status='running')
           AND NOT EXISTS (SELECT 1 FROM pod_reconciliations WHERE pod_id=pod.id AND status='running')`,
      ).run(
        input.reconciliationId,
        input.sourceSessionId,
        input.targetSessionId,
        input.actorId.slice(0, 256),
        input.now,
        input.podId,
        input.sourceSessionId,
        input.targetSessionId,
      );
      if (Number(inserted.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.stmt("UPDATE pods SET updated_at=? WHERE id=?").run(input.now, input.podId);
      this.db.exec("COMMIT");
      return this.podReconciliation(
        this.stmt("SELECT * FROM pod_reconciliations WHERE reconciliation_id=?")
          .get(input.reconciliationId) as unknown as PodReconciliationRow,
      );
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  settlePodReconciliation(
    reconciliationId: string,
    result: {
      status: Exclude<PodReconciliation["status"], "running">;
      sourceHead?: string;
      targetHead?: string;
      mergeBase?: string;
      resultHead?: string;
      conflictPaths?: string[];
      error?: string;
    },
    now: number,
  ): PodReconciliation | null {
    const row = this.stmt("SELECT pod_id FROM pod_reconciliations WHERE reconciliation_id=? AND status='running'")
      .get(reconciliationId) as unknown as { pod_id: string } | undefined;
    if (!row) return null;
    const changed = this.stmt(
      `UPDATE pod_reconciliations
       SET status=?, source_head=?, target_head=?, merge_base=?, result_head=?, conflict_paths=?, error=?, completed_at=?
       WHERE reconciliation_id=? AND status='running'`,
    ).run(
      result.status,
      result.sourceHead ?? null,
      result.targetHead ?? null,
      result.mergeBase ?? null,
      result.resultHead ?? null,
      result.conflictPaths ? JSON.stringify(result.conflictPaths.slice(0, 100).map((path) => path.slice(0, 512))) : null,
      result.error?.slice(0, 1_000) ?? null,
      now,
      reconciliationId,
    );
    if (Number(changed.changes) !== 1) return null;
    this.stmt("UPDATE pods SET updated_at=? WHERE id=?").run(now, row.pod_id);
    return this.getPodReconciliation(reconciliationId);
  }

  failPodReconciliations(podId: string, reason: string, now: number): void {
    this.stmt(
      `UPDATE pod_reconciliations SET status='failed', error=?, completed_at=?
       WHERE pod_id=? AND status='running'`,
    ).run(reason.slice(0, 1_000), now, podId);
  }

  failInterruptedPodReconciliations(now: number): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.stmt(
        `UPDATE pods SET updated_at=?
         WHERE id IN (SELECT pod_id FROM pod_reconciliations WHERE status='running')`,
      ).run(now);
      this.stmt(
        `UPDATE pod_reconciliations
         SET status='failed', error='control plane restarted with reconciliation delivery uncertain', completed_at=?
         WHERE status='running'`,
      ).run(now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  activePodReconciliationForSession(sessionId: string): PodReconciliation | null {
    const row = this.stmt(
      `SELECT reconciliation.* FROM pod_reconciliations reconciliation
       JOIN pods pod ON pod.id=reconciliation.pod_id
       WHERE reconciliation.status='running' AND pod.status='active'
         AND (reconciliation.source_session_id=? OR reconciliation.target_session_id=?)
       ORDER BY reconciliation.created_at DESC LIMIT 1`,
    ).get(sessionId, sessionId) as unknown as PodReconciliationRow | undefined;
    return row ? this.podReconciliation(row) : null;
  }

  getPodReconciliation(reconciliationId: string): PodReconciliation | null {
    const row = this.stmt("SELECT * FROM pod_reconciliations WHERE reconciliation_id=?")
      .get(reconciliationId) as unknown as PodReconciliationRow | undefined;
    return row ? this.podReconciliation(row) : null;
  }

  listPodReconciliations(podId: string, limit = 20): PodReconciliation[] {
    const rows = this.stmt(
      `SELECT * FROM pod_reconciliations WHERE pod_id=?
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(podId, Math.max(1, Math.min(100, Math.floor(limit)))) as unknown as PodReconciliationRow[];
    return rows.map((row) => this.podReconciliation(row));
  }

  podContextSelectionWindow(podId: string, afterSeq: number, limit = 500): PodContextSelectionWindow {
    const stats = this.stmt(
      `SELECT COUNT(*) AS count, MIN(seq) AS min_seq, MAX(seq) AS max_seq
       FROM pod_context_entries WHERE pod_id=? AND seq>?`,
    ).get(podId, afterSeq) as unknown as { count: number; min_seq: number | null; max_seq: number | null };
    const rows = this.stmt(
      `SELECT id, pod_id, seq, ts, source, content FROM pod_context_entries
       WHERE pod_id=? AND seq>? ORDER BY seq DESC LIMIT ?`,
    ).all(podId, afterSeq, limit) as unknown as PodContextEntryRow[];
    return {
      entries: rows.reverse().map((row) => this.podContextEntry(row)),
      totalCount: Number(stats.count),
      ...(stats.min_seq == null ? {} : { minSeq: stats.min_seq }),
      ...(stats.max_seq == null ? {} : { maxSeq: stats.max_seq }),
    };
  }

  podOrchestrationSteps(podId: string, runId: string, limit = 100): PodOrchestrationStep[] {
    const rows = this.stmt(
      `SELECT * FROM pod_orchestration_steps WHERE pod_id=? AND run_id=? ORDER BY turn DESC LIMIT ?`,
    ).all(podId, runId, limit) as unknown as PodOrchestrationStepRow[];
    return rows.reverse().map((row) => this.podOrchestrationStep(row));
  }

  private podOrchestrationView(podId: string, podUpdatedAt: number): PodOrchestrationView {
    const row = this.stmt("SELECT * FROM pod_orchestration WHERE pod_id=?")
      .get(podId) as unknown as PodOrchestrationRow | undefined;
    if (!row) {
      return {
        policy: DEFAULT_POD_ORCHESTRATION_POLICY,
        state: { status: "idle", turnsUsed: 0, updatedAt: podUpdatedAt },
      };
    }
    const lastStep = row.run_id
      ? this.stmt(
          `SELECT * FROM pod_orchestration_steps WHERE pod_id=? AND run_id=? ORDER BY turn DESC LIMIT 1`,
        ).get(podId, row.run_id) as unknown as PodOrchestrationStepRow | undefined
      : undefined;
    return {
      policy: {
        mode: row.mode,
        contextTokenBudget: row.context_token_budget,
        summaryTokenBudget: row.summary_token_budget,
        maxTurns: row.max_turns,
        maxRepeatedOutputs: row.max_repeated_outputs,
      },
      state: {
        status: row.status,
        ...(row.run_id ? { runId: row.run_id } : {}),
        turnsUsed: row.turns_used,
        ...(row.current_session_id ? { currentSessionId: row.current_session_id } : {}),
        ...(row.last_session_id ? { lastSessionId: row.last_session_id } : {}),
        ...(row.stop_reason ? { stopReason: row.stop_reason } : {}),
        ...(row.started_at == null ? {} : { startedAt: row.started_at }),
        updatedAt: row.updated_at,
      },
      ...(lastStep ? { lastStep: this.podOrchestrationStep(lastStep) } : {}),
    };
  }

  private podOrchestrationStep(row: PodOrchestrationStepRow): PodOrchestrationStep {
    return {
      stepId: row.step_id,
      podId: row.pod_id,
      runId: row.run_id,
      turn: row.turn,
      targetSessionId: row.target_session_id,
      ...(row.trigger_session_id ? { triggerSessionId: row.trigger_session_id } : {}),
      selectedEntryIds: JSON.parse(row.selected_entry_ids) as string[],
      ...(row.summarized_from_seq == null ? {} : { summarizedFromSeq: row.summarized_from_seq }),
      ...(row.summarized_to_seq == null ? {} : { summarizedToSeq: row.summarized_to_seq }),
      estimatedTokens: row.estimated_tokens,
      ...(row.output_entry_id ? { outputEntryId: row.output_entry_id } : {}),
      status: row.status,
      ...(row.error ? { error: row.error } : {}),
      createdAt: row.created_at,
      ...(row.settled_at == null ? {} : { settledAt: row.settled_at }),
    };
  }

  private podReconciliation(row: PodReconciliationRow): PodReconciliation {
    return {
      reconciliationId: row.reconciliation_id,
      podId: row.pod_id,
      sourceSessionId: row.source_session_id,
      targetSessionId: row.target_session_id,
      actorId: row.actor_id,
      status: row.status,
      ...(row.source_head ? { sourceHead: row.source_head } : {}),
      ...(row.target_head ? { targetHead: row.target_head } : {}),
      ...(row.merge_base ? { mergeBase: row.merge_base } : {}),
      ...(row.result_head ? { resultHead: row.result_head } : {}),
      ...(row.conflict_paths ? { conflictPaths: JSON.parse(row.conflict_paths) as string[] } : {}),
      ...(row.error ? { error: row.error } : {}),
      createdAt: row.created_at,
      ...(row.completed_at == null ? {} : { completedAt: row.completed_at }),
    };
  }

  private podView(row: PodRow): PodView {
    const members = this.stmt(
      `SELECT session_id, joined_at, role, context_token_budget, last_context_seq
       FROM pod_members WHERE pod_id=? ORDER BY joined_at, session_id`,
    ).all(row.id) as unknown as Array<{
      session_id: string;
      joined_at: number;
      role: PodMemberRole;
      context_token_budget: number | null;
      last_context_seq: number;
    }>;
    return {
      id: row.id,
      title: row.title,
      objective: row.objective,
      status: row.status,
      members: members.map((member) => ({
        sessionId: member.session_id,
        joinedAt: member.joined_at,
        role: member.role,
        contextTokenBudget: member.context_token_budget,
        lastContextSeq: member.last_context_seq,
      })),
      orchestration: this.podOrchestrationView(row.id, row.updated_at),
      reconciliations: this.listPodReconciliations(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  appendPodContextEntry(input: {
    id: string;
    podId: string;
    ts: number;
    source: PodContextEntry["source"];
    content: string;
  }): { entry: PodContextEntry; created: boolean } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (input.source.kind === "session") {
        const existing = this.stmt(
          `SELECT id, pod_id, seq, ts, source, content FROM pod_context_entries
           WHERE pod_id=? AND source_kind='session' AND source_session_id=?
             AND source_from_seq=? AND source_to_seq=?`,
        ).get(input.podId, input.source.sessionId, input.source.fromSeq, input.source.toSeq) as unknown as
          | PodContextEntryRow
          | undefined;
        if (existing) {
          this.db.exec("COMMIT");
          return { entry: this.podContextEntry(existing), created: false };
        }
      }
      const nextSeq = ((this.stmt(
        "SELECT MAX(seq) AS m FROM pod_context_entries WHERE pod_id=?",
      ).get(input.podId) as unknown as { m: number | null }).m ?? 0) + 1;
      this.stmt(
        `INSERT INTO pod_context_entries
          (id, pod_id, seq, ts, source_kind, source, source_session_id, source_from_seq, source_to_seq, content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.podId,
        nextSeq,
        input.ts,
        input.source.kind,
        JSON.stringify(input.source),
        input.source.kind === "session" ? input.source.sessionId : null,
        input.source.kind === "session" ? input.source.fromSeq : null,
        input.source.kind === "session" ? input.source.toSeq : null,
        input.content,
      );
      this.stmt("UPDATE pods SET updated_at=? WHERE id=?").run(input.ts, input.podId);
      this.db.exec("COMMIT");
      return {
        entry: { id: input.id, podId: input.podId, seq: nextSeq, ts: input.ts, source: input.source, content: input.content },
        created: true,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listPodContextEntries(podId: string, beforeSeq?: number, limit = 100): PodContextEntry[] {
    const rows = (beforeSeq === undefined
      ? this.stmt(
          `SELECT id, pod_id, seq, ts, source, content FROM pod_context_entries
           WHERE pod_id=? ORDER BY seq DESC LIMIT ?`,
        ).all(podId, limit)
      : this.stmt(
          `SELECT id, pod_id, seq, ts, source, content FROM pod_context_entries
           WHERE pod_id=? AND seq<? ORDER BY seq DESC LIMIT ?`,
        ).all(podId, beforeSeq, limit)) as unknown as PodContextEntryRow[];
    return rows.reverse().map((row) => this.podContextEntry(row));
  }

  getPodContextEntries(podId: string, ids: string[]): PodContextEntry[] {
    return ids.flatMap((id) => {
      const row = this.stmt(
        "SELECT id, pod_id, seq, ts, source, content FROM pod_context_entries WHERE pod_id=? AND id=?",
      ).get(podId, id) as unknown as PodContextEntryRow | undefined;
      return row ? [this.podContextEntry(row)] : [];
    });
  }

  private podContextEntry(row: PodContextEntryRow): PodContextEntry {
    return {
      id: row.id,
      podId: row.pod_id,
      seq: row.seq,
      ts: row.ts,
      source: JSON.parse(row.source) as PodContextEntry["source"],
      content: row.content,
    };
  }

  createWorkflowDefinition(definition: Omit<WorkflowDefinition, "version">): WorkflowDefinition {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const version = ((this.stmt("SELECT MAX(version) AS version FROM workflow_definitions WHERE workflow_id=?")
        .get(definition.workflowId) as unknown as { version: number | null }).version ?? 0) + 1;
      this.stmt(
        `INSERT INTO workflow_definitions
         (workflow_id, version, name, description, max_transitions, graph, source,
          created_by_kind, created_by_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        definition.workflowId, version, definition.name, definition.description ?? null,
        definition.maxTransitions, JSON.stringify({ nodes: definition.nodes, edges: definition.edges }),
        definition.source, definition.createdBy.kind, definition.createdBy.id ?? null, definition.createdAt,
      );
      this.db.exec("COMMIT");
      return { ...definition, version };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getWorkflowDefinition(workflowId: string, version?: number): WorkflowDefinition | null {
    const row = (version === undefined
      ? this.stmt("SELECT * FROM workflow_definitions WHERE workflow_id=? ORDER BY version DESC LIMIT 1").get(workflowId)
      : this.stmt("SELECT * FROM workflow_definitions WHERE workflow_id=? AND version=?").get(workflowId, version)) as unknown as WorkflowDefinitionRow | undefined;
    return row ? this.workflowDefinition(row) : null;
  }

  listWorkflowDefinitions(limit = 100): WorkflowDefinition[] {
    const rows = this.stmt(
      `SELECT d.* FROM workflow_definitions d
       JOIN (SELECT workflow_id, MAX(version) AS version FROM workflow_definitions GROUP BY workflow_id) latest
         ON latest.workflow_id=d.workflow_id AND latest.version=d.version
       ORDER BY d.created_at DESC, d.workflow_id LIMIT ?`,
    ).all(limit) as unknown as WorkflowDefinitionRow[];
    return rows.map((row) => this.workflowDefinition(row));
  }

  private workflowDefinition(row: WorkflowDefinitionRow): WorkflowDefinition {
    const graph = JSON.parse(row.graph) as Pick<WorkflowDefinition, "nodes" | "edges">;
    return {
      workflowId: row.workflow_id,
      version: row.version,
      name: row.name,
      ...(row.description !== null ? { description: row.description } : {}),
      maxTransitions: row.max_transitions,
      nodes: graph.nodes,
      edges: graph.edges,
      source: row.source,
      createdBy: { kind: row.created_by_kind, ...(row.created_by_id ? { id: row.created_by_id } : {}) },
      createdAt: row.created_at,
    };
  }

  createWorkflowInstance(input: {
    instanceId: string;
    definition: WorkflowDefinition;
    runId: string;
    createdBy: WorkflowInstanceView["createdBy"];
    now: number;
  }): WorkflowInstanceDetail {
    const destinations = new Set(input.definition.edges.map((edge) => edge.to));
    const roots = input.definition.nodes.filter((node) => !destinations.has(node.nodeId));
    const initialStatus: WorkflowInstanceStatus = roots.some((node) => node.kind === "agent") ? "queued" : "waiting_gate";
    this.db.exec("BEGIN");
    try {
      this.stmt(
        `INSERT INTO workflow_instances
         (instance_id, workflow_id, workflow_version, run_id, status, transition_count,
          created_by_kind, created_by_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      ).run(input.instanceId, input.definition.workflowId, input.definition.version, input.runId,
        initialStatus, input.createdBy.kind, input.createdBy.id ?? null, input.now, input.now);
      const insertNode = this.stmt(
        `INSERT INTO workflow_node_states (instance_id, node_id, status, attempt_count)
         VALUES (?, ?, ?, 0)`,
      );
      for (const node of input.definition.nodes) {
        const root = !destinations.has(node.nodeId);
        insertNode.run(input.instanceId, node.nodeId, root ? (node.kind === "agent" ? "ready" : "waiting_gate") : "pending");
      }
      this.stmt(
        `INSERT INTO workflow_events
         (instance_id, seq, kind, actor_kind, actor_id, created_at)
         VALUES (?, 1, 'instance_created', ?, ?, ?)`,
      ).run(input.instanceId, input.createdBy.kind, input.createdBy.id ?? null, input.now);
      this.stmt("UPDATE multi_agent_runs SET updated_at=MAX(updated_at + 1, ?) WHERE id=?").run(input.now, input.runId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getWorkflowInstance(input.instanceId)!;
  }

  getWorkflowInstance(instanceId: string): WorkflowInstanceDetail | null {
    const row = this.stmt("SELECT * FROM workflow_instances WHERE instance_id=?").get(instanceId) as unknown as WorkflowInstanceRow | undefined;
    if (!row) return null;
    const definition = this.getWorkflowDefinition(row.workflow_id, row.workflow_version);
    if (!definition) throw new Error(`workflow definition ${row.workflow_id}@${row.workflow_version} is missing`);
    const attempts = this.listWorkflowAttempts(instanceId, 501);
    const events = this.listWorkflowEvents(instanceId, 1_001);
    return {
      ...this.workflowInstanceView(row),
      definition,
      attempts: attempts.slice(-500),
      events: events.slice(-1_000),
      ...(attempts.length > 500 ? { attemptsTruncated: true } : {}),
      ...(events.length > 1_000 ? { eventsTruncated: true } : {}),
    };
  }

  listWorkflowInstances(runId?: string, limit = 100): WorkflowInstanceView[] {
    const rows = (runId
      ? this.stmt("SELECT * FROM workflow_instances WHERE run_id=? ORDER BY created_at DESC, instance_id LIMIT ?").all(runId, limit)
      : this.stmt("SELECT * FROM workflow_instances ORDER BY created_at DESC, instance_id LIMIT ?").all(limit)) as unknown as WorkflowInstanceRow[];
    return rows.map((row) => this.workflowInstanceView(row));
  }

  private workflowInstanceView(row: WorkflowInstanceRow): WorkflowInstanceView {
    const states = this.stmt("SELECT * FROM workflow_node_states WHERE instance_id=? ORDER BY rowid")
      .all(row.instance_id) as unknown as WorkflowNodeStateRow[];
    return {
      instanceId: row.instance_id,
      workflowId: row.workflow_id,
      workflowVersion: row.workflow_version,
      runId: row.run_id,
      status: row.status,
      transitionCount: row.transition_count,
      nodeStates: states.map((state) => ({
        nodeId: state.node_id, status: state.status, attemptCount: state.attempt_count,
        ...(state.session_id ? { sessionId: state.session_id } : {}),
        ...(state.started_at !== null ? { startedAt: state.started_at } : {}),
        ...(state.completed_at !== null ? { completedAt: state.completed_at } : {}),
        ...(state.error ? { error: state.error } : {}),
        ...(state.ready_at !== null ? { readyAt: state.ready_at } : {}),
        ...(state.outcome ? { outcome: state.outcome } : {}),
      })),
      createdBy: { kind: row.created_by_kind, ...(row.created_by_id ? { id: row.created_by_id } : {}) },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    };
  }

  runMemberSessions(runId: string, agentId: string): SessionView[] {
    const rows = this.stmt(
      "SELECT session_id FROM multi_agent_run_members WHERE run_id=? AND agent_id=? ORDER BY rowid",
    ).all(runId, agentId) as unknown as Array<{ session_id: string }>;
    return rows.map((row) => this.getSession(row.session_id)).filter((session): session is SessionView => session !== null);
  }

  getWorkflowAttemptByDispatchKey(dispatchKey: string): WorkflowAttemptView | null {
    const row = this.stmt("SELECT * FROM workflow_attempts WHERE dispatch_key=?").get(dispatchKey) as unknown as WorkflowAttemptRow | undefined;
    return row ? this.workflowAttempt(row) : null;
  }

  getWorkflowAttempt(attemptId: string): WorkflowAttemptView | null {
    const row = this.stmt("SELECT * FROM workflow_attempts WHERE attempt_id=?").get(attemptId) as unknown as WorkflowAttemptRow | undefined;
    return row ? this.workflowAttempt(row) : null;
  }

  claimWorkflowAttempt(input: {
    attemptId: string; instanceId: string; nodeId: string; dispatchKey: string; sessionId: string;
    timeoutMs: number; maxTransitions: number; actor: WorkflowEventView["actor"]; now: number;
  }): { attempt: WorkflowAttemptView; idempotent: boolean } {
    const existing = this.getWorkflowAttemptByDispatchKey(input.dispatchKey);
    if (existing) {
      if (existing.instanceId !== input.instanceId || existing.nodeId !== input.nodeId) {
        throw new Error("dispatch key is already bound to another workflow node");
      }
      return { attempt: existing, idempotent: true };
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.stmt(
        "SELECT status, attempt_count, ready_at FROM workflow_node_states WHERE instance_id=? AND node_id=?",
      ).get(input.instanceId, input.nodeId) as unknown as { status: string; attempt_count: number; ready_at: number | null } | undefined;
      if (!state) throw new Error("workflow node not found");
      if (state.status !== "ready") throw new Error(`workflow node is ${state.status}`);
      if (state.ready_at !== null && state.ready_at > input.now) throw new Error(`workflow node retry is not ready until ${state.ready_at}`);
      const instanceUpdate = this.stmt(
        `UPDATE workflow_instances SET status='running', transition_count=transition_count+1,
         updated_at=MAX(updated_at + 1, ?)
         WHERE instance_id=? AND status NOT IN ('succeeded','failed','stopped') AND transition_count < ?`,
      ).run(input.now, input.instanceId, input.maxTransitions);
      if (Number(instanceUpdate.changes) !== 1) throw new Error("workflow transition limit reached or instance is terminal");
      const attempt = state.attempt_count + 1;
      const deadlineAt = input.now + input.timeoutMs;
      this.stmt(
        `UPDATE workflow_node_states SET status='running', attempt_count=?, session_id=?, started_at=?,
         completed_at=NULL, error=NULL, ready_at=NULL, outcome=NULL WHERE instance_id=? AND node_id=?`,
      ).run(attempt, input.sessionId, input.now, input.instanceId, input.nodeId);
      this.stmt(
        `INSERT INTO workflow_attempts
         (attempt_id, instance_id, node_id, attempt, status, dispatch_key, session_id, started_at, deadline_at)
         VALUES (?, ?, ?, ?, 'dispatching', ?, ?, ?, ?)`,
      ).run(input.attemptId, input.instanceId, input.nodeId, attempt, input.dispatchKey, input.sessionId, input.now, deadlineAt);
      this.insertWorkflowEvent({
        instanceId: input.instanceId, kind: "attempt_started", nodeId: input.nodeId,
        attemptId: input.attemptId, actor: input.actor, detail: { dispatchKey: input.dispatchKey }, createdAt: input.now,
      });
      this.stmt(
        "UPDATE multi_agent_runs SET updated_at=MAX(updated_at + 1, ?) WHERE id=(SELECT run_id FROM workflow_instances WHERE instance_id=?)",
      ).run(input.now, input.instanceId);
      this.db.exec("COMMIT");
      return { attempt: this.getWorkflowAttempt(input.attemptId)!, idempotent: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setWorkflowAttemptStatus(
    attemptId: string,
    expected: WorkflowAttemptStatus[],
    status: WorkflowAttemptStatus,
    actor: WorkflowEventView["actor"] = { kind: "system", id: "workflow-runtime" },
    now = Date.now(),
  ): WorkflowAttemptView | null {
    const placeholders = expected.map(() => "?").join(",");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.stmt(`UPDATE workflow_attempts SET status=? WHERE attempt_id=? AND status IN (${placeholders})`)
        .run(status, attemptId, ...expected);
      if (Number(result.changes) !== 1) { this.db.exec("ROLLBACK"); return null; }
      const attempt = this.getWorkflowAttempt(attemptId)!;
      this.stmt("UPDATE workflow_instances SET updated_at=MAX(updated_at + 1, ?) WHERE instance_id=?")
        .run(now, attempt.instanceId);
      this.stmt(
        "UPDATE multi_agent_runs SET updated_at=MAX(updated_at + 1, ?) WHERE id=(SELECT run_id FROM workflow_instances WHERE instance_id=?)",
      ).run(now, attempt.instanceId);
      this.insertWorkflowEvent({
        instanceId: attempt.instanceId, kind: "attempt_status_changed", nodeId: attempt.nodeId,
        attemptId, actor, detail: { status }, createdAt: now,
      });
      this.db.exec("COMMIT");
      return attempt;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  finishWorkflowInstance(input: {
    instanceId: string; status: Extract<WorkflowInstanceStatus, "failed" | "stopped">;
    error: string; actor: WorkflowEventView["actor"]; now: number;
  }): WorkflowInstanceDetail {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.stmt(
        `UPDATE workflow_instances SET status=?, updated_at=MAX(updated_at + 1, ?), completed_at=?
         WHERE instance_id=? AND status NOT IN ('succeeded','failed','stopped')`,
      ).run(input.status, input.now, input.now, input.instanceId);
      if (Number(changed.changes) !== 1) throw new Error("workflow instance is terminal");
      this.stmt(
        `UPDATE workflow_node_states SET status=CASE WHEN status IN ('pending','ready','waiting_gate') THEN 'stopped' ELSE status END,
         error=CASE WHEN status IN ('pending','ready','waiting_gate') THEN ? ELSE error END,
         completed_at=CASE WHEN status IN ('pending','ready','waiting_gate') THEN ? ELSE completed_at END
         WHERE instance_id=?`,
      ).run(input.error, input.now, input.instanceId);
      this.stmt(
        `UPDATE workflow_attempts SET status='cancelled', completed_at=?, error=?
         WHERE instance_id=? AND status IN ('dispatching','running','awaiting_output')`,
      ).run(input.now, input.error, input.instanceId);
      this.stmt(
        `UPDATE workflow_node_states SET status='stopped', completed_at=?, error=?
         WHERE instance_id=? AND status='running'`,
      ).run(input.now, input.error, input.instanceId);
      this.insertWorkflowEvent({
        instanceId: input.instanceId, kind: "instance_status_changed", actor: input.actor,
        detail: { status: input.status, error: input.error }, createdAt: input.now,
      });
      this.stmt(
        "UPDATE multi_agent_runs SET updated_at=MAX(updated_at + 1, ?) WHERE id=(SELECT run_id FROM workflow_instances WHERE instance_id=?)",
      ).run(input.now, input.instanceId);
      this.db.exec("COMMIT");
      return this.getWorkflowInstance(input.instanceId)!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  activeWorkflowAttemptsForSession(sessionId: string): WorkflowAttemptView[] {
    const rows = this.stmt(
      "SELECT * FROM workflow_attempts WHERE session_id=? AND status IN ('dispatching','running','awaiting_output') ORDER BY started_at, attempt_id",
    ).all(sessionId) as unknown as WorkflowAttemptRow[];
    return rows.map((row) => this.workflowAttempt(row));
  }

  /** True while a durable automation execution owns this session's command lifecycle. Steering
   * around that outbox would bypass its ordering, receipt, and failure semantics. */
  hasActiveAutomationCommandForSession(sessionId: string): boolean {
    return Boolean(this.stmt(
      `SELECT 1 FROM automation_commands command
       JOIN automation_executions execution ON execution.execution_id=command.execution_id
       WHERE command.session_id=?
         AND execution.status IN ('dispatching','running')
         AND command.state IN ('staged','pending','sent','accepted','started')
       LIMIT 1`,
    ).get(sessionId));
  }

  activeWorkflowAttempts(deadlineAtOrBefore?: number): WorkflowAttemptView[] {
    const rows = (deadlineAtOrBefore === undefined
      ? this.stmt("SELECT * FROM workflow_attempts WHERE status IN ('dispatching','running','awaiting_output') ORDER BY started_at, attempt_id").all()
      : this.stmt("SELECT * FROM workflow_attempts WHERE status IN ('dispatching','running','awaiting_output') AND deadline_at<=? ORDER BY deadline_at, attempt_id").all(deadlineAtOrBefore)) as unknown as WorkflowAttemptRow[];
    return rows.map((row) => this.workflowAttempt(row));
  }

  finishWorkflowAttempt(input: {
    attemptId: string; status: Extract<WorkflowAttemptStatus, "succeeded" | "failed" | "timed_out" | "cancelled">;
    outcome: WorkflowNodeOutcome; outputs?: Record<string, string>;
    retryAt?: number; nextNodes?: Array<{ nodeId: string; kind: "agent" | "human_gate" | "policy_gate" }>;
    instanceStatus?: WorkflowInstanceStatus; error?: string;
    actor: WorkflowEventView["actor"]; now: number;
  }): WorkflowInstanceDetail {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const attempt = this.stmt("SELECT * FROM workflow_attempts WHERE attempt_id=?").get(input.attemptId) as unknown as WorkflowAttemptRow | undefined;
      if (!attempt) throw new Error("workflow attempt not found");
      if (!["dispatching", "running", "awaiting_output"].includes(attempt.status)) throw new Error(`workflow attempt is ${attempt.status}`);
      this.stmt("UPDATE workflow_attempts SET status=?, completed_at=?, error=? WHERE attempt_id=?")
        .run(input.status, input.now, input.error ?? null, input.attemptId);
      for (const [contractName, artifactId] of Object.entries(input.outputs ?? {})) {
        this.stmt(
          "INSERT INTO workflow_attempt_artifacts (attempt_id, contract_name, artifact_id) VALUES (?, ?, ?)",
        ).run(input.attemptId, contractName, artifactId);
      }
      const retry = input.retryAt !== undefined;
      this.stmt(
        `UPDATE workflow_node_states SET status=?, completed_at=?, error=?, ready_at=?, outcome=?
         WHERE instance_id=? AND node_id=?`,
      ).run(retry ? "ready" : input.status === "succeeded" ? "succeeded" : "failed",
        retry ? null : input.now, input.error ?? null, input.retryAt ?? null, input.outcome,
        attempt.instance_id, attempt.node_id);
      for (const next of input.nextNodes ?? []) {
        this.stmt(
          `UPDATE workflow_node_states SET status=?, completed_at=NULL, error=NULL, ready_at=NULL, outcome=NULL
           WHERE instance_id=? AND node_id=? AND status IN ('pending','succeeded','failed')`,
        ).run(next.kind === "agent" ? "ready" : "waiting_gate", attempt.instance_id, next.nodeId);
      }
      this.stmt(
        `UPDATE workflow_instances SET status=COALESCE(?, status), updated_at=MAX(updated_at + 1, ?),
         completed_at=CASE WHEN ? IN ('succeeded','failed','stopped') THEN ? ELSE completed_at END
         WHERE instance_id=?`,
      ).run(input.instanceStatus ?? null, input.now, input.instanceStatus ?? null, input.now, attempt.instance_id);
      if (input.instanceStatus && ["succeeded", "failed", "stopped"].includes(input.instanceStatus)) {
        this.stmt(
          `UPDATE workflow_attempts SET status='cancelled', completed_at=?, error='workflow reached a terminal stop condition'
           WHERE instance_id=? AND attempt_id<>? AND status IN ('dispatching','running','awaiting_output')`,
        ).run(input.now, attempt.instance_id, attempt.attempt_id);
        this.stmt(
          `UPDATE workflow_node_states SET status='stopped', completed_at=?, error='workflow reached a terminal stop condition'
           WHERE instance_id=? AND node_id<>? AND status IN ('pending','ready','running','waiting_gate')`,
        ).run(input.now, attempt.instance_id, attempt.node_id);
      }
      this.insertWorkflowEvent({
        instanceId: attempt.instance_id, kind: "attempt_finished", nodeId: attempt.node_id,
        attemptId: attempt.attempt_id, actor: input.actor,
        detail: { status: input.status, outcome: input.outcome, retry: retry }, createdAt: input.now,
      });
      this.stmt(
        "UPDATE multi_agent_runs SET updated_at=MAX(updated_at + 1, ?) WHERE id=(SELECT run_id FROM workflow_instances WHERE instance_id=?)",
      ).run(input.now, attempt.instance_id);
      this.db.exec("COMMIT");
      return this.getWorkflowInstance(attempt.instance_id)!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  resolveWorkflowGateState(input: {
    instanceId: string; nodeId: string; outcome: Extract<WorkflowNodeOutcome, "success" | "failure">;
    nextNodes: Array<{ nodeId: string; kind: "agent" | "human_gate" | "policy_gate" }>;
    instanceStatus?: WorkflowInstanceStatus; maxTransitions: number; actor: WorkflowEventView["actor"]; now: number;
  }): WorkflowInstanceDetail {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.stmt(
        `UPDATE workflow_node_states SET status=?, outcome=?, completed_at=?
         WHERE instance_id=? AND node_id=? AND status='waiting_gate'`,
      ).run(input.outcome === "success" ? "succeeded" : "failed", input.outcome, input.now, input.instanceId, input.nodeId);
      if (Number(changed.changes) !== 1) throw new Error("workflow gate is not waiting");
      const transitioned = this.stmt(
        `UPDATE workflow_instances SET transition_count=transition_count+1
         WHERE instance_id=? AND status NOT IN ('succeeded','failed','stopped') AND transition_count < ?`,
      ).run(input.instanceId, input.maxTransitions);
      if (Number(transitioned.changes) !== 1) throw new Error("workflow transition limit reached or instance is terminal");
      for (const next of input.nextNodes) {
        this.stmt(
          `UPDATE workflow_node_states SET status=?, completed_at=NULL, error=NULL, ready_at=NULL, outcome=NULL
           WHERE instance_id=? AND node_id=? AND status IN ('pending','succeeded','failed')`,
        ).run(next.kind === "agent" ? "ready" : "waiting_gate", input.instanceId, next.nodeId);
      }
      this.stmt(
        `UPDATE workflow_instances SET status=COALESCE(?, 'running'), updated_at=MAX(updated_at + 1, ?),
         completed_at=CASE WHEN ? IN ('succeeded','failed','stopped') THEN ? ELSE completed_at END
         WHERE instance_id=?`,
      ).run(input.instanceStatus ?? null, input.now, input.instanceStatus ?? null, input.now, input.instanceId);
      if (input.instanceStatus && ["succeeded", "failed", "stopped"].includes(input.instanceStatus)) {
        this.stmt(
          `UPDATE workflow_attempts SET status='cancelled', completed_at=?, error='workflow reached a terminal gate condition'
           WHERE instance_id=? AND status IN ('dispatching','running','awaiting_output')`,
        ).run(input.now, input.instanceId);
        this.stmt(
          `UPDATE workflow_node_states SET status='stopped', completed_at=?, error='workflow reached a terminal gate condition'
           WHERE instance_id=? AND node_id<>? AND status IN ('pending','ready','running','waiting_gate')`,
        ).run(input.now, input.instanceId, input.nodeId);
      }
      this.insertWorkflowEvent({
        instanceId: input.instanceId, kind: "gate_resolved", nodeId: input.nodeId,
        actor: input.actor, detail: { outcome: input.outcome }, createdAt: input.now,
      });
      this.stmt(
        "UPDATE multi_agent_runs SET updated_at=MAX(updated_at + 1, ?) WHERE id=(SELECT run_id FROM workflow_instances WHERE instance_id=?)",
      ).run(input.now, input.instanceId);
      this.db.exec("COMMIT");
      return this.getWorkflowInstance(input.instanceId)!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  workflowAttemptOutputs(attemptId: string): Record<string, WorkflowArtifact> {
    const rows = this.stmt(
      `SELECT wa.contract_name, a.* FROM workflow_attempt_artifacts wa
       JOIN artifacts a ON a.id=wa.artifact_id WHERE wa.attempt_id=? ORDER BY wa.contract_name`,
    ).all(attemptId) as unknown as Array<WorkflowArtifactRow & { contract_name: string }>;
    return Object.fromEntries(rows.map((row) => [row.contract_name, this.workflowArtifact(row, true) as WorkflowArtifact]));
  }

  latestWorkflowOutputs(instanceId: string): Record<string, WorkflowArtifact> {
    const rows = this.stmt(
      `SELECT * FROM (
         SELECT wa.contract_name, a.*, ROW_NUMBER() OVER (
           PARTITION BY wa.contract_name ORDER BY att.completed_at DESC, att.attempt_id DESC
         ) AS output_rank
         FROM workflow_attempt_artifacts wa
         JOIN workflow_attempts att ON att.attempt_id=wa.attempt_id AND att.status='succeeded'
         JOIN artifacts a ON a.id=wa.artifact_id
         WHERE att.instance_id=?
       ) WHERE output_rank=1 LIMIT 1024`,
    ).all(instanceId) as unknown as Array<WorkflowArtifactRow & { contract_name: string }>;
    return Object.fromEntries(rows.map((row) => [row.contract_name, this.workflowArtifact(row, true) as WorkflowArtifact]));
  }

  /** Metadata-first workflow inputs so binary outputs never materialize through a base64 string. */
  latestWorkflowOutputViews(instanceId: string): Record<string, WorkflowArtifactView> {
    const rows = this.stmt(
      `SELECT * FROM (
         SELECT wa.contract_name, a.*, ROW_NUMBER() OVER (
           PARTITION BY wa.contract_name ORDER BY att.completed_at DESC, att.attempt_id DESC
         ) AS output_rank
         FROM workflow_attempt_artifacts wa
         JOIN workflow_attempts att ON att.attempt_id=wa.attempt_id AND att.status='succeeded'
         JOIN artifacts a ON a.id=wa.artifact_id
         WHERE att.instance_id=?
       ) WHERE output_rank=1 LIMIT 1024`,
    ).all(instanceId) as unknown as Array<WorkflowArtifactRow & { contract_name: string }>;
    return Object.fromEntries(rows.map((row) => [row.contract_name, this.workflowArtifact(row, false) as WorkflowArtifactView]));
  }

  createWorkflowAttempt(attempt: WorkflowAttemptView): WorkflowAttemptView {
    this.stmt(
      `INSERT INTO workflow_attempts
       (attempt_id, instance_id, node_id, attempt, status, dispatch_key, session_id, started_at, deadline_at, completed_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(attempt.attemptId, attempt.instanceId, attempt.nodeId, attempt.attempt, attempt.status,
      attempt.dispatchKey, attempt.sessionId ?? null, attempt.startedAt, attempt.deadlineAt, attempt.completedAt ?? null, attempt.error ?? null);
    return attempt;
  }

  listWorkflowAttempts(instanceId: string, limit = 501): WorkflowAttemptView[] {
    const rows = this.stmt(
      `SELECT * FROM (SELECT * FROM workflow_attempts WHERE instance_id=? ORDER BY started_at DESC, attempt_id DESC LIMIT ?)
       ORDER BY started_at, attempt_id`,
    ).all(instanceId, limit) as unknown as WorkflowAttemptRow[];
    return rows.map((row) => this.workflowAttempt(row));
  }

  private workflowAttempt(row: WorkflowAttemptRow): WorkflowAttemptView {
    return {
      attemptId: row.attempt_id, instanceId: row.instance_id, nodeId: row.node_id, attempt: row.attempt,
      status: row.status, dispatchKey: row.dispatch_key,
      ...(row.session_id ? { sessionId: row.session_id } : {}), startedAt: row.started_at, deadlineAt: row.deadline_at,
      ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
      ...(row.error ? { error: row.error } : {}),
    };
  }

  appendWorkflowEvent(event: Omit<WorkflowEventView, "eventId" | "seq">): WorkflowEventView {
    this.db.exec("BEGIN");
    try {
      const inserted = this.insertWorkflowEvent(event);
      this.db.exec("COMMIT");
      return inserted;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertWorkflowEvent(event: Omit<WorkflowEventView, "eventId" | "seq">): WorkflowEventView {
    const seq = ((this.stmt("SELECT MAX(seq) AS seq FROM workflow_events WHERE instance_id=?")
      .get(event.instanceId) as unknown as { seq: number | null }).seq ?? 0) + 1;
    const info = this.stmt(
      `INSERT INTO workflow_events
       (instance_id, seq, kind, node_id, attempt_id, actor_kind, actor_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(event.instanceId, seq, event.kind, event.nodeId ?? null, event.attemptId ?? null,
      event.actor.kind, event.actor.id ?? null, event.detail ? JSON.stringify(event.detail) : null, event.createdAt);
    return { ...event, eventId: Number(info.lastInsertRowid), seq };
  }

  listWorkflowEvents(instanceId: string, limit = 1_001): WorkflowEventView[] {
    const rows = this.stmt(
      `SELECT * FROM (SELECT * FROM workflow_events WHERE instance_id=? ORDER BY seq DESC LIMIT ?) ORDER BY seq`,
    ).all(instanceId, limit) as unknown as WorkflowEventRow[];
    return rows.map((row) => ({
      eventId: row.event_id, instanceId: row.instance_id, seq: row.seq, kind: row.kind,
      ...(row.node_id ? { nodeId: row.node_id } : {}), ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
      actor: { kind: row.actor_kind, ...(row.actor_id ? { id: row.actor_id } : {}) },
      ...(row.detail ? { detail: JSON.parse(row.detail) as WorkflowEventView["detail"] } : {}),
      createdAt: row.created_at,
    }));
  }

  createWorkflowArtifact(artifact: WorkflowArtifact): WorkflowArtifact {
    const bytes = workflowArtifactBytes(artifact);
    this.createWorkflowArtifactBytes(artifact, bytes);
    return artifact;
  }

  /** Persist already-validated bytes without manufacturing a base64 copy in the control plane. */
  createWorkflowArtifactBytes(
    artifact: WorkflowArtifactView,
    bytes: Buffer,
    options: { preparedPromptImageExpiresAt?: number } = {},
  ): WorkflowArtifactView {
    if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0 ||
        artifact.sizeBytes > MAX_WORKFLOW_ARTIFACT_BLOB_BYTES || bytes.byteLength !== artifact.sizeBytes ||
        artifactBlobSha256(bytes) !== artifact.sha256) {
      throw new Error("workflow artifact bytes do not match metadata");
    }
    assertArtifactBlobKey(artifact.sha256);
    this.stmt("INSERT OR IGNORE INTO artifact_blob_pending (blob_key, created_at) VALUES (?, ?)")
      .run(artifact.sha256, artifact.createdAt);
    try {
      this.artifactBlobs.put(artifact.sha256, bytes);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.stmt(
          `INSERT INTO artifacts
           (id, run_id, session_id, kind, name, mime_type, encoding, data, blob_key, size_bytes, sha256,
            created_by_kind, created_by_id, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          artifact.artifactId,
          artifact.runId ?? null,
          artifact.sessionId ?? null,
          artifact.kind,
          artifact.name,
          artifact.mimeType,
          artifact.encoding,
          artifact.sha256,
          artifact.sizeBytes,
          artifact.sha256,
          artifact.createdBy.kind,
          artifact.createdBy.id ?? null,
          artifact.metadata ? JSON.stringify(artifact.metadata) : null,
          artifact.createdAt,
        );
        if (options.preparedPromptImageExpiresAt !== undefined) {
          const inserted = this.stmt(
            `INSERT INTO prepared_prompt_image_artifacts
             (artifact_id,session_id,mime_type,size_bytes,sha256,expires_at)
             SELECT id,session_id,mime_type,size_bytes,sha256,? FROM artifacts
             WHERE id=? AND session_id IS NOT NULL AND run_id IS NULL AND kind='screenshot'
               AND encoding='base64'
               AND CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.purpose') END='prompt_image'`,
          ).run(options.preparedPromptImageExpiresAt, artifact.artifactId);
          if (Number(inserted.changes) !== 1) throw new Error("prompt image preparation artifact is invalid");
        }
        if (artifact.runId) {
          // Always advance the run revision even when creation and artifact write share one millisecond;
          // the web uses updatedAt as the artifact-list refresh signal.
          this.stmt("UPDATE multi_agent_runs SET updated_at=MAX(updated_at + 1, ?) WHERE id=?")
            .run(artifact.createdAt, artifact.runId);
        }
        this.stmt("DELETE FROM artifact_blob_pending WHERE blob_key=?").run(artifact.sha256);
        this.db.exec("COMMIT");
        return artifact;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      this.cleanupPendingArtifactBlob(artifact.sha256);
      throw error;
    }
  }

  /** Exact verified bytes for authenticated raw delivery. */
  readWorkflowArtifactBytes(artifactId: string): Buffer | null {
    const row = this.stmt(
      `SELECT id, encoding, data, blob_key, size_bytes, sha256 FROM artifacts WHERE id=?`,
    ).get(artifactId) as unknown as Pick<WorkflowArtifactRow, "id" | "encoding" | "data" | "blob_key" | "size_bytes" | "sha256"> | undefined;
    if (!row) return null;
    if (!row.blob_key) {
      return workflowArtifactBytes({
        encoding: row.encoding,
        data: row.data ?? "",
        sizeBytes: row.size_bytes,
        sha256: row.sha256,
      });
    }
    assertArtifactBlobKey(row.blob_key);
    if (row.blob_key !== row.sha256 || !Number.isSafeInteger(row.size_bytes) || row.size_bytes < 0 ||
        row.size_bytes > MAX_WORKFLOW_ARTIFACT_BLOB_BYTES) {
      throw new Error("workflow artifact blob metadata is invalid");
    }
    return this.artifactBlobs.read(row.blob_key, row.size_bytes);
  }

  deleteWorkflowArtifact(artifactId: string): boolean {
    const deleted = Number(this.stmt("DELETE FROM artifacts WHERE id=?").run(artifactId).changes) > 0;
    if (deleted) this.collectWorkflowArtifactBlobs();
    return deleted;
  }

  findPreparedPromptImageArtifact(
    sessionId: string,
    mimeType: string,
    sizeBytes: number,
    sha256: string,
    renewUntil: number,
  ): WorkflowArtifactView | null {
    const row = this.stmt(
      `SELECT artifact_id FROM prepared_prompt_image_artifacts
       WHERE session_id=? AND mime_type=? AND size_bytes=? AND sha256=?`,
    ).get(sessionId, mimeType, sizeBytes, sha256) as { artifact_id: string } | undefined;
    if (!row) return null;
    const artifact = this.getWorkflowArtifact(row.artifact_id);
    if (!artifact || artifact.sessionId !== sessionId || artifact.kind !== "screenshot" ||
        artifact.encoding !== "base64" || artifact.mimeType !== mimeType ||
        artifact.sizeBytes !== sizeBytes || artifact.sha256 !== sha256) {
      this.stmt("DELETE FROM prepared_prompt_image_artifacts WHERE artifact_id=?").run(row.artifact_id);
      return null;
    }
    this.stmt("UPDATE prepared_prompt_image_artifacts SET expires_at=MAX(expires_at, ?) WHERE artifact_id=?")
      .run(renewUntil, row.artifact_id);
    return artifact;
  }

  commitPreparedPromptImages(artifactIds: readonly string[]): void {
    const remove = this.stmt("DELETE FROM prepared_prompt_image_artifacts WHERE artifact_id=?");
    for (const artifactId of new Set(artifactIds)) remove.run(artifactId);
  }

  /** Expire only uploads that never gained durable attempt, event, or workflow reachability. */
  collectExpiredPreparedPromptImages(now: number, limit = 1_000): number {
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 10_000)) : 1_000;
    const rows = this.stmt(
      `SELECT prepared.artifact_id FROM prepared_prompt_image_artifacts prepared
       WHERE prepared.expires_at<=? ORDER BY prepared.expires_at,prepared.artifact_id LIMIT ?`,
    ).all(now, bounded) as unknown as Array<{ artifact_id: string }>;
    if (!rows.length) return 0;
    this.db.exec("BEGIN IMMEDIATE");
    let deleted = 0;
    try {
      for (const row of rows) {
        const referenced = this.stmt(
          `SELECT 1 WHERE
             EXISTS (SELECT 1 FROM session_event_artifacts WHERE artifact_id=?) OR
             EXISTS (SELECT 1 FROM session_steering_attempt_artifacts WHERE artifact_id=?) OR
             EXISTS (SELECT 1 FROM workflow_attempt_artifacts WHERE artifact_id=?) OR
             EXISTS (
               SELECT 1 FROM session_prompt_commands command,
                 json_each(CASE WHEN json_valid(command.payload_json) THEN command.payload_json ELSE '{}' END, '$.images') image
               WHERE command.dismissed_at IS NULL
                 AND json_extract(image.value, '$.artifactId')=?
             )`,
        ).get(row.artifact_id, row.artifact_id, row.artifact_id, row.artifact_id);
        if (referenced) {
          this.stmt("DELETE FROM prepared_prompt_image_artifacts WHERE artifact_id=?").run(row.artifact_id);
        } else {
          deleted += Number(this.stmt("DELETE FROM artifacts WHERE id=?").run(row.artifact_id).changes);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (deleted) this.collectWorkflowArtifactBlobs();
    return deleted;
  }

  getWorkflowArtifact(artifactId: string): WorkflowArtifact | null {
    const row = this.stmt(
      `SELECT id, run_id, session_id, kind, name, mime_type, encoding, blob_key, size_bytes, sha256,
              created_by_kind, created_by_id, metadata, created_at,
              LENGTH(CAST(data AS BLOB)) AS stored_data_bytes
       FROM artifacts WHERE id=?`,
    ).get(artifactId) as unknown as (WorkflowArtifactRow & { stored_data_bytes: number }) | undefined;
    if (!row) return null;
    if (!row.blob_key) {
      if (!Number.isSafeInteger(row.stored_data_bytes) || row.stored_data_bytes < 0 ||
          row.stored_data_bytes > MAX_WORKFLOW_ARTIFACT_INLINE_BYTES) {
        throw new Error("workflow artifact inline body is invalid");
      }
      const body = this.stmt("SELECT data FROM artifacts WHERE id=?").get(artifactId) as unknown as { data: string } | undefined;
      row.data = body?.data ?? "";
    }
    return this.workflowArtifact(row, true) as WorkflowArtifact;
  }

  workflowArtifactScope(artifactId: string): { runId?: string; sessionId?: string } | null {
    const row = this.stmt("SELECT run_id, session_id FROM artifacts WHERE id=?").get(artifactId) as unknown as
      { run_id: string | null; session_id: string | null } | undefined;
    return row ? {
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
    } : null;
  }

  /** Metadata and materialized-byte size only, so export authorization and corruption bounds run
   * before the sidecar store copies artifact bytes into the Node process. */
  workflowArtifactExportPreflight(artifactId: string): {
    artifact: WorkflowArtifactView;
    storedDataBytes: number;
  } | null {
    const row = this.stmt(
      `SELECT id, run_id, session_id, kind, name, mime_type, encoding, blob_key, size_bytes, sha256,
              created_by_kind, created_by_id, metadata, created_at,
              CASE WHEN blob_key IS NULL THEN LENGTH(CAST(data AS BLOB)) ELSE size_bytes END AS stored_data_bytes
       FROM artifacts WHERE id=?`,
    ).get(artifactId) as unknown as (WorkflowArtifactRow & { stored_data_bytes: number }) | undefined;
    if (row?.blob_key) {
      assertArtifactBlobKey(row.blob_key);
      if (row.blob_key !== row.sha256) throw new Error("workflow artifact blob key does not match metadata");
    }
    return row
      ? { artifact: this.workflowArtifact(row, false), storedDataBytes: Number(row.stored_data_bytes) }
      : null;
  }

  listRunWorkflowArtifacts(runId: string, after: { createdAt: number; artifactId: string } | null = null, limit = 51): WorkflowArtifactView[] {
    const rows = this.stmt(
      `SELECT id, run_id, session_id, kind, name, mime_type, encoding, size_bytes, sha256,
              created_by_kind, created_by_id, metadata, created_at
       FROM artifacts WHERE run_id=? AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))
       ORDER BY created_at, id LIMIT ?`,
    ).all(runId, after?.artifactId ?? null, after?.createdAt ?? 0, after?.createdAt ?? 0, after?.artifactId ?? "", limit) as unknown as WorkflowArtifactRow[];
    return rows.map((row) => this.workflowArtifact(row, false));
  }

  listSessionWorkflowArtifacts(sessionId: string, after: { createdAt: number; artifactId: string } | null = null, limit = 51): WorkflowArtifactView[] {
    const rows = this.stmt(
      `SELECT id, run_id, session_id, kind, name, mime_type, encoding, size_bytes, sha256,
              created_by_kind, created_by_id, metadata, created_at
       FROM artifacts WHERE session_id=? AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))
       ORDER BY created_at, id LIMIT ?`,
    ).all(sessionId, after?.artifactId ?? null, after?.createdAt ?? 0, after?.createdAt ?? 0, after?.artifactId ?? "", limit) as unknown as WorkflowArtifactRow[];
    return rows.map((row) => this.workflowArtifact(row, false));
  }

  private workflowArtifact(row: WorkflowArtifactRow, includeData: boolean): WorkflowArtifactView | WorkflowArtifact {
    return {
      artifactId: row.id,
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      kind: row.kind,
      name: row.name,
      mimeType: row.mime_type,
      encoding: row.encoding,
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
      createdBy: { kind: row.created_by_kind, ...(row.created_by_id ? { id: row.created_by_id } : {}) },
      ...(row.metadata ? { metadata: JSON.parse(row.metadata) as WorkflowArtifactView["metadata"] } : {}),
      createdAt: row.created_at,
      ...(includeData ? { data: this.workflowArtifactData(row) } : {}),
    };
  }

  private workflowArtifactData(row: WorkflowArtifactRow): string {
    if (!row.blob_key) {
      const data = row.data ?? "";
      workflowArtifactBytes({
        encoding: row.encoding,
        data,
        sizeBytes: row.size_bytes,
        sha256: row.sha256,
      });
      return data;
    }
    assertArtifactBlobKey(row.blob_key);
    if (row.blob_key !== row.sha256) throw new Error("workflow artifact blob key does not match metadata");
    if (!Number.isSafeInteger(row.size_bytes) || row.size_bytes < 0 || row.size_bytes > MAX_WORKFLOW_ARTIFACT_BLOB_BYTES) {
      throw new Error("workflow artifact blob size is invalid");
    }
    const bytes = this.artifactBlobs.read(row.blob_key, row.size_bytes);
    return row.encoding === "base64" ? bytes.toString("base64") : bytes.toString("utf8");
  }

  private cleanupPendingArtifactBlob(blobKey: string): void {
    try {
      const references = this.stmt("SELECT COUNT(*) AS count FROM artifacts WHERE blob_key=?")
        .get(blobKey) as unknown as { count: number };
      if (Number(references.count) === 0) this.artifactBlobs.delete(blobKey);
      this.stmt("DELETE FROM artifact_blob_pending WHERE blob_key=?").run(blobKey);
    } catch {
      // Leave the durable pending row for startup recovery if cleanup cannot complete now.
    }
  }

  private recoverPendingArtifactBlobs(limit = 1_000): void {
    const rows = this.stmt("SELECT blob_key FROM artifact_blob_pending ORDER BY created_at, blob_key LIMIT ?")
      .all(limit) as unknown as Array<{ blob_key: string }>;
    for (const row of rows) this.cleanupPendingArtifactBlob(row.blob_key);
  }

  private migrateInlineWorkflowArtifacts(): void {
    let cursor = "";
    while (true) {
      const preflight = this.stmt(
        `SELECT id, encoding, size_bytes, sha256, LENGTH(CAST(data AS BLOB)) AS stored_data_bytes
         FROM artifacts WHERE blob_key IS NULL AND id > ? ORDER BY id LIMIT 1`,
      ).get(cursor) as unknown as
        | { id: string; encoding: WorkflowArtifact["encoding"]; size_bytes: number; sha256: string; stored_data_bytes: number }
        | undefined;
      if (!preflight) return;
      cursor = preflight.id;
      if (!Number.isSafeInteger(preflight.stored_data_bytes) || preflight.stored_data_bytes < 0 ||
          preflight.stored_data_bytes > MAX_WORKFLOW_ARTIFACT_INLINE_BYTES) continue;
      const body = this.stmt("SELECT data FROM artifacts WHERE id=? AND blob_key IS NULL")
        .get(preflight.id) as unknown as { data: string } | undefined;
      if (!body) continue;
      let bytes: Buffer;
      try {
        bytes = workflowArtifactBytes({
          encoding: preflight.encoding,
          data: body.data,
          sizeBytes: preflight.size_bytes,
          sha256: preflight.sha256,
        });
      } catch {
        // Preserve a corrupt legacy row inline so the existing fail-closed read/export path can
        // report it without destroying the only recoverable copy.
        continue;
      }
      this.stmt("INSERT OR IGNORE INTO artifact_blob_pending (blob_key, created_at) VALUES (?, ?)")
        .run(preflight.sha256, Date.now());
      this.artifactBlobs.put(preflight.sha256, bytes);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.stmt("UPDATE artifacts SET blob_key=?, data='' WHERE id=? AND blob_key IS NULL")
          .run(preflight.sha256, preflight.id);
        this.stmt("DELETE FROM artifact_blob_pending WHERE blob_key=?").run(preflight.sha256);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  /** One-time additive index for event-artifact reachability created before the reference table.
   * JSON extraction happens once per database, never as a recurring startup/orphan scan. */
  private backfillSessionEventArtifactReferences(): void {
    this.stmt("INSERT OR IGNORE INTO session_event_artifact_reference_state (id, backfilled) VALUES (1, 0)").run();
    const eventPayloadState = this.stmt("SELECT backfilled FROM session_event_artifact_reference_state WHERE id=1")
      .get() as { backfilled: number };
    if (eventPayloadState.backfilled !== 1) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const path of ["$.textRefs", "$.diffRefs"]) {
          this.stmt(
            `INSERT OR IGNORE INTO session_event_artifacts (event_id, artifact_id)
             SELECT e.id, json_extract(ref.value, '$.artifactId')
               FROM session_events e,
                    json_each(CASE WHEN json_valid(e.payload) THEN e.payload ELSE '{}' END, ?) ref
               JOIN artifacts a ON a.id=json_extract(ref.value, '$.artifactId')
              WHERE json_type(ref.value, '$.artifactId')='text'
                AND a.run_id IS NULL
                AND CASE WHEN json_valid(a.metadata) THEN json_extract(a.metadata, '$.purpose') END='session_event_payload'`,
          ).run(path);
        }
        this.stmt("UPDATE session_event_artifact_reference_state SET backfilled=1 WHERE id=1").run();
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    this.stmt("INSERT OR IGNORE INTO session_prompt_image_reference_state (id, backfilled) VALUES (1, 0)").run();
    const promptImageState = this.stmt("SELECT backfilled FROM session_prompt_image_reference_state WHERE id=1")
      .get() as { backfilled: number };
    if (promptImageState.backfilled === 1) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.stmt(
        `INSERT OR IGNORE INTO session_event_artifacts (event_id, artifact_id)
         SELECT e.id, json_extract(image.value, '$.artifactId')
           FROM session_events e,
                json_each(CASE WHEN json_valid(e.payload) THEN e.payload ELSE '{}' END, '$.images') image
           JOIN artifacts a ON a.id=json_extract(image.value, '$.artifactId')
           JOIN sessions session ON session.id=e.session_id
          WHERE e.kind='user_message'
            AND json_type(image.value)='object'
            AND json_type(image.value, '$.artifactId')='text'
            AND json_type(image.value, '$.mimeType')='text'
            AND json_type(image.value, '$.sizeBytes')='integer'
            AND json_type(image.value, '$.sha256')='text'
            AND (SELECT COUNT(*) FROM json_each(image.value))=4
            AND NOT EXISTS (
              SELECT 1 FROM json_each(image.value) member
               WHERE member.key NOT IN ('artifactId','mimeType','sizeBytes','sha256')
            )
            AND a.kind='screenshot' AND a.encoding='base64'
            AND a.mime_type=json_extract(image.value, '$.mimeType')
            AND a.size_bytes=json_extract(image.value, '$.sizeBytes')
            AND a.sha256=json_extract(image.value, '$.sha256')
            AND (
              a.session_id=e.session_id OR (a.run_id IS NOT NULL AND a.run_id=session.run_id) OR
              (a.session_id IS NOT NULL AND EXISTS (
                WITH RECURSIVE ancestors(session_id,depth) AS (
                  SELECT source_session_id,1 FROM session_forks WHERE target_session_id=e.session_id
                  UNION ALL
                  SELECT fork.source_session_id,ancestors.depth+1
                    FROM session_forks fork JOIN ancestors ON fork.target_session_id=ancestors.session_id
                   WHERE ancestors.depth<64
                ) SELECT 1 FROM ancestors WHERE session_id=a.session_id LIMIT 1
              ))
            )`,
      ).run();
      this.stmt("UPDATE session_prompt_image_reference_state SET backfilled=1 WHERE id=1").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Remove crash-window event artifacts that never became reachable from a committed event.
   * The indexed reference table avoids an O(artifacts x event-payload-text) `instr` scan. The
   * content-addressed blob collector still protects bytes shared by another artifact row. */
  collectOrphanedEventPayloadArtifacts(limit = 1_000): number {
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 10_000)) : 1_000;
    const rows = this.stmt(
      `SELECT a.id
         FROM artifacts a
        WHERE a.run_id IS NULL
          AND CASE WHEN json_valid(a.metadata) THEN json_extract(a.metadata, '$.purpose') END='session_event_payload'
          AND NOT EXISTS (SELECT 1 FROM session_event_artifacts ref WHERE ref.artifact_id=a.id)
        ORDER BY a.id LIMIT ?`,
    ).all(bounded) as unknown as Array<{ id: string }>;
    for (const row of rows) this.stmt("DELETE FROM artifacts WHERE id=?").run(row.id);
    if (rows.length) this.collectWorkflowArtifactBlobs();
    return rows.length;
  }

  /** One row at a time keeps startup migration memory bounded. Legacy or temporarily
   * unexternalizable rows remain as the lossless source and are retried on the next open. */
  private migrateInlineSessionEventPayloads(): void {
    this.stmt("INSERT OR IGNORE INTO session_event_payload_migration_state (id, through_id) VALUES (1, 0)").run();
    let cursor = (this.stmt("SELECT through_id FROM session_event_payload_migration_state WHERE id=1")
      .get() as { through_id: number }).through_id;
    const target = Number((this.stmt("SELECT COALESCE(MAX(id), 0) AS id FROM session_events")
      .get() as { id: number }).id);
    let deferred = false;
    while (true) {
      const row = this.stmt(
        `SELECT id, session_id, ts, payload
           FROM session_events
          WHERE id > ? AND id <= ? AND LENGTH(CAST(payload AS BLOB)) > ?
            AND kind IN ('tool_call','tool_call_update','command_output','stderr','file_edit')
          ORDER BY id LIMIT 1`,
      ).get(cursor, target, EVENT_PAYLOAD_PREVIEW_BYTES) as unknown as {
        id: number; session_id: string; ts: number; payload: string;
      } | undefined;
      if (!row) break;
      const payload = parseJson<SessionEventPayload>(row.payload);
      if (!payload || typeof payload.kind !== "string") {
        cursor = row.id;
        continue;
      }
      let externalized;
      try {
        externalized = externalizeSessionEventPayload(
          this,
          row.session_id,
          payload,
          row.ts,
          (index, sha256) => `evp_${row.id}_${index}_${sha256.slice(0, 12)}`,
        );
      } catch (error) {
        process.emitWarning(`session event payload migration deferred for row ${row.id}: ${(error as Error).message}`);
        deferred = true;
        break;
      }
      if (!externalized.artifactIds.length) {
        cursor = row.id;
        continue;
      }
      try {
        this.db.exec("BEGIN");
        const changed = Number(this.stmt("UPDATE session_events SET payload=? WHERE id=? AND payload=?")
          .run(JSON.stringify(externalized.payload), row.id, row.payload).changes);
        if (changed !== 1) {
          this.db.exec("ROLLBACK");
          cleanupEventPayloadArtifacts(this, externalized.artifactIds);
          cursor = row.id;
          continue;
        }
        this.linkSessionEventArtifacts(
          row.id,
          externalized.artifactIds,
          userMessagePromptImageReferences(externalized.payload),
        );
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        cleanupEventPayloadArtifacts(this, externalized.artifactIds);
        throw error;
      }
      cursor = row.id;
    }
    this.stmt("UPDATE session_event_payload_migration_state SET through_id=? WHERE id=1")
      .run(deferred ? cursor : target);
  }

  collectWorkflowArtifactBlobs(limit = 1_000): { examined: number; deleted: number; retained: number } {
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 10_000)) : 1_000;
    const rows = this.stmt("SELECT blob_key FROM artifact_blob_gc ORDER BY queued_at, blob_key LIMIT ?")
      .all(bounded) as unknown as Array<{ blob_key: string }>;
    let deleted = 0;
    let retained = 0;
    for (const row of rows) {
      try {
        assertArtifactBlobKey(row.blob_key);
        const references = this.stmt("SELECT COUNT(*) AS count FROM artifacts WHERE blob_key=?")
          .get(row.blob_key) as unknown as { count: number };
        if (Number(references.count) > 0) {
          retained += 1;
        } else if (this.artifactBlobs.delete(row.blob_key)) {
          deleted += 1;
        }
        this.stmt("DELETE FROM artifact_blob_gc WHERE blob_key=?").run(row.blob_key);
      } catch {
        // Keep the queue row so a transient filesystem error is retryable on the next maintenance pass.
      }
    }
    return { examined: rows.length, deleted, retained };
  }

  /** Test/diagnostic-only location; null for an in-memory store. */
  workflowArtifactBlobRoot(): string | null {
    return this.artifactBlobs.rootPath;
  }

  /* -------------------------- Durable automations ------------------------- */

  createAutomation(input: {
    automationId: string;
    spec: AutomationSpec;
    nextFireAt: number | null;
    actor: GovernanceActor;
    now: number;
  }): AutomationSchedule {
    const { spec } = input;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.stmt(
        `INSERT INTO automations
         (automation_id, name, cron_expression, timezone, enabled, next_fire_at, misfire_policy,
          runner_policy, concurrency_policy, limits_json, notifications_json, action_json,
          created_by_kind, created_by_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        input.automationId, spec.name, spec.cron, spec.timezone, spec.enabled ? 1 : 0, input.nextFireAt,
        JSON.stringify(spec.misfirePolicy), JSON.stringify(spec.runnerPolicy), spec.concurrencyPolicy,
        JSON.stringify(spec.limits), JSON.stringify(spec.notifications), JSON.stringify(spec.action),
        input.actor.kind, input.actor.id ?? null, input.now, input.now,
      );
      this.insertAutomationEvent({
        automationId: input.automationId, kind: "created", actor: input.actor,
        detail: { enabled: spec.enabled, nextFireAt: input.nextFireAt }, now: input.now,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getAutomation(input.automationId)!;
  }

  updateAutomation(input: {
    automationId: string;
    spec: AutomationSpec;
    nextFireAt: number | null;
    actor: GovernanceActor;
    now: number;
  }): AutomationSchedule | null {
    const current = this.getAutomation(input.automationId);
    if (!current) return null;
    const { spec } = input;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.stmt(
        `UPDATE automations SET revision=revision+1, name=?, cron_expression=?, timezone=?, enabled=?, next_fire_at=?,
          misfire_policy=?, runner_policy=?, concurrency_policy=?, limits_json=?, notifications_json=?,
          action_json=?, updated_at=? WHERE automation_id=? AND deleted_at IS NULL`,
      ).run(
        spec.name, spec.cron, spec.timezone, spec.enabled ? 1 : 0, input.nextFireAt,
        JSON.stringify(spec.misfirePolicy), JSON.stringify(spec.runnerPolicy), spec.concurrencyPolicy,
        JSON.stringify(spec.limits), JSON.stringify(spec.notifications), JSON.stringify(spec.action),
        input.now, input.automationId,
      );
      if (Number(changed.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return null;
      }
      const kind: AutomationAuditEventKind = current.enabled === spec.enabled
        ? "updated"
        : spec.enabled ? "enabled" : "disabled";
      if (!spec.enabled) {
        this.stmt(
          `UPDATE automation_trigger_invocations
           SET state='rejected', spec_json='{}', sender_hash=NULL, updated_at=?
           WHERE state='pending' AND trigger_id IN
             (SELECT trigger_id FROM automation_triggers WHERE automation_id=? AND deleted_at IS NULL)`,
        ).run(input.now, input.automationId);
      }
      this.insertAutomationEvent({
        automationId: input.automationId, kind, actor: input.actor,
        detail: { enabled: spec.enabled, nextFireAt: input.nextFireAt }, now: input.now,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getAutomation(input.automationId);
  }

  deleteAutomation(automationId: string, actor: GovernanceActor, now: number): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.stmt(
        "UPDATE automations SET enabled=0, next_fire_at=NULL, deleted_at=?, updated_at=? WHERE automation_id=? AND deleted_at IS NULL",
      ).run(now, now, automationId);
      if (Number(changed.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.stmt(
        "UPDATE automation_triggers SET secret_key='', deleted_at=?, updated_at=? WHERE automation_id=? AND deleted_at IS NULL",
      ).run(now, now, automationId);
      this.stmt(
        `UPDATE automation_trigger_invocations
         SET state='rejected', spec_json='{}', sender_hash=NULL, updated_at=?
         WHERE state='pending' AND trigger_id IN (SELECT trigger_id FROM automation_triggers WHERE automation_id=?)`,
      ).run(now, automationId);
      this.insertAutomationEvent({ automationId, kind: "deleted", actor, now });
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getAutomation(automationId: string): AutomationSchedule | null {
    const row = this.stmt("SELECT * FROM automations WHERE automation_id=? AND deleted_at IS NULL")
      .get(automationId) as unknown as AutomationRow | undefined;
    return row ? this.automation(row) : null;
  }

  listAutomations(): AutomationSchedule[] {
    const rows = this.stmt(
      "SELECT * FROM automations WHERE deleted_at IS NULL ORDER BY enabled DESC, next_fire_at, created_at, automation_id",
    ).all() as unknown as AutomationRow[];
    return rows.map((row) => this.automation(row));
  }

  createAutomationTrigger(input: {
    triggerId: string;
    automationId: string;
    kind: AutomationTriggerKind;
    name: string;
    secret: string;
    actor: GovernanceActor;
    now: number;
  }): AutomationTriggerView | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const automation = this.stmt("SELECT 1 FROM automations WHERE automation_id=? AND deleted_at IS NULL")
        .get(input.automationId);
      if (!automation) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.stmt(
        `INSERT INTO automation_triggers
         (trigger_id,automation_id,kind,name,secret_key,generation,created_by_kind,created_by_id,created_at,updated_at)
         VALUES (?,?,?,?,?,1,?,?,?,?)`,
      ).run(input.triggerId, input.automationId, input.kind, input.name, input.secret,
        input.actor.kind, input.actor.id ?? null, input.now, input.now);
      this.insertAutomationEvent({
        automationId: input.automationId, kind: "trigger_created", actor: input.actor,
        detail: { triggerId: input.triggerId, triggerKind: input.kind, name: input.name }, now: input.now,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getAutomationTrigger(input.triggerId);
  }

  listAutomationTriggers(automationId: string): AutomationTriggerView[] {
    const rows = this.stmt(
      `SELECT * FROM automation_triggers WHERE automation_id=? AND deleted_at IS NULL
       ORDER BY created_at, trigger_id`,
    ).all(automationId) as unknown as AutomationTriggerRow[];
    return rows.map((row) => this.automationTrigger(row));
  }

  getAutomationTrigger(triggerId: string): AutomationTriggerView | null {
    const row = this.stmt(
      "SELECT * FROM automation_triggers WHERE trigger_id=? AND deleted_at IS NULL",
    ).get(triggerId) as unknown as AutomationTriggerRow | undefined;
    return row ? this.automationTrigger(row) : null;
  }

  getAutomationTriggerRecord(triggerId: string): AutomationTriggerRecord | null {
    const row = this.stmt(
      `SELECT trigger.* FROM automation_triggers trigger
       JOIN automations automation ON automation.automation_id=trigger.automation_id AND automation.deleted_at IS NULL
       WHERE trigger.trigger_id=? AND trigger.deleted_at IS NULL`,
    ).get(triggerId) as unknown as AutomationTriggerRow | undefined;
    return row ? { ...this.automationTrigger(row), secret: row.secret_key } : null;
  }

  rotateAutomationTrigger(input: {
    triggerId: string;
    automationId: string;
    secret: string;
    actor: GovernanceActor;
    now: number;
  }): AutomationTriggerView | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.stmt(
        `UPDATE automation_triggers SET secret_key=?, generation=generation+1, updated_at=?
         WHERE trigger_id=? AND automation_id=? AND deleted_at IS NULL`,
      ).run(input.secret, input.now, input.triggerId, input.automationId);
      if (Number(changed.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.insertAutomationEvent({
        automationId: input.automationId, kind: "trigger_rotated", actor: input.actor,
        detail: { triggerId: input.triggerId }, now: input.now,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getAutomationTrigger(input.triggerId);
  }

  deleteAutomationTrigger(input: {
    triggerId: string;
    automationId: string;
    actor: GovernanceActor;
    now: number;
  }): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.stmt(
        `UPDATE automation_triggers SET secret_key='', deleted_at=?, updated_at=?
         WHERE trigger_id=? AND automation_id=? AND deleted_at IS NULL`,
      ).run(input.now, input.now, input.triggerId, input.automationId);
      if (Number(changed.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.stmt(
        `UPDATE automation_trigger_invocations
         SET state='rejected', spec_json='{}', sender_hash=NULL, updated_at=?
         WHERE trigger_id=? AND state='pending'`,
      ).run(input.now, input.triggerId);
      this.insertAutomationEvent({
        automationId: input.automationId, kind: "trigger_deleted", actor: input.actor,
        detail: { triggerId: input.triggerId }, now: input.now,
      });
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordAutomationTriggerInvocation(input: {
    invocationId: string;
    triggerId: string;
    eventId: string;
    bodySha256: string;
    senderHash?: string;
    now: number;
  }): { invocation?: AutomationTriggerInvocationRecord; duplicate: boolean; conflict: boolean; limited: boolean;
    retired?: boolean; unavailable?: boolean } | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const trigger = this.stmt(
        `SELECT automation.* FROM automation_triggers trigger JOIN automations automation ON automation.automation_id=trigger.automation_id
         WHERE trigger.trigger_id=? AND trigger.deleted_at IS NULL AND automation.deleted_at IS NULL`,
      ).get(input.triggerId) as unknown as AutomationRow | undefined;
      if (!trigger) {
        this.db.exec("ROLLBACK");
        return null;
      }
      const existing = this.stmt(
        "SELECT * FROM automation_trigger_invocations WHERE trigger_id=? AND event_id=?",
      ).get(input.triggerId, input.eventId) as unknown as AutomationTriggerInvocationRow | undefined;
      if (existing) {
        this.db.exec("COMMIT");
        return {
          invocation: this.automationTriggerInvocation(existing),
          duplicate: true,
          conflict: existing.body_sha256 !== input.bodySha256,
          limited: false,
        };
      }
      const retired = this.stmt(
        "SELECT 1 FROM automation_executions WHERE idempotency_key=?",
      ).get(`trigger:${input.triggerId}:${input.eventId}`);
      if (retired) {
        this.db.exec("COMMIT");
        return { duplicate: false, conflict: false, limited: false, retired: true };
      }
      if (!this.automation(trigger).enabled) {
        this.db.exec("COMMIT");
        return { duplicate: false, conflict: false, limited: false, unavailable: true };
      }
      const recent = this.stmt(
        "SELECT COUNT(*) AS value FROM automation_trigger_invocations WHERE trigger_id=? AND received_at>?",
      ).get(input.triggerId, input.now - 60_000) as { value: number };
      const pending = this.stmt(
        "SELECT COUNT(*) AS value FROM automation_trigger_invocations WHERE trigger_id=? AND state='pending'",
      ).get(input.triggerId) as { value: number };
      const globalPending = this.stmt(
        "SELECT COUNT(*) AS value FROM automation_trigger_invocations WHERE state='pending'",
      ).get() as { value: number };
      if (Number(recent.value) >= 30 || Number(pending.value) >= 100 || Number(globalPending.value) >= 1_000) {
        this.db.exec("ROLLBACK");
        return { duplicate: false, conflict: false, limited: true };
      }
      const schedule = this.automation(trigger);
      const { automationId: _automationId, revision: _revision, nextFireAt: _nextFireAt,
        lastFiredAt: _lastFiredAt, createdBy: _createdBy, createdAt: _createdAt,
        updatedAt: _updatedAt, ...specSnapshot } = schedule;
      this.stmt(
        `INSERT INTO automation_trigger_invocations
         (invocation_id,trigger_id,automation_id,event_id,body_sha256,sender_hash,automation_revision,spec_json,
          state,received_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`,
      ).run(input.invocationId, input.triggerId, schedule.automationId, input.eventId, input.bodySha256,
        input.senderHash ?? null, schedule.revision, JSON.stringify(specSnapshot), input.now, input.now);
      this.stmt(
        `UPDATE automation_triggers SET invocation_count=invocation_count+1,
         last_invoked_at=MAX(COALESCE(last_invoked_at,?),?) WHERE trigger_id=?`,
      ).run(input.now, input.now, input.triggerId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      invocation: this.getAutomationTriggerInvocation(input.invocationId)!,
      duplicate: false,
      conflict: false,
      limited: false,
    };
  }

  compactAutomationTriggerInvocations(now: number): number {
    const compacted = this.stmt(
      `UPDATE automation_trigger_invocations SET spec_json='{}', sender_hash=NULL
       WHERE state<>'pending' AND updated_at<? AND (spec_json<>'{}' OR sender_hash IS NOT NULL)`,
    ).run(now - 30 * 24 * 60 * 60 * 1_000);
    return Number(compacted.changes);
  }

  getAutomationTriggerInvocation(invocationId: string): AutomationTriggerInvocationRecord | null {
    const row = this.stmt("SELECT * FROM automation_trigger_invocations WHERE invocation_id=?")
      .get(invocationId) as unknown as AutomationTriggerInvocationRow | undefined;
    return row ? this.automationTriggerInvocation(row) : null;
  }

  pendingAutomationTriggerInvocations(limit = 100): AutomationTriggerInvocationRecord[] {
    const rows = this.stmt(
      "SELECT * FROM automation_trigger_invocations WHERE state='pending' ORDER BY received_at, invocation_id LIMIT ?",
    ).all(Math.max(1, Math.min(100, Math.floor(limit)))) as unknown as AutomationTriggerInvocationRow[];
    return rows.map((row) => this.automationTriggerInvocation(row));
  }

  automationScheduleForTriggerInvocation(invocationId: string): AutomationSchedule | null {
    const row = this.stmt(
      `SELECT invocation.*, trigger.kind AS trigger_kind
       FROM automation_trigger_invocations invocation
       JOIN automation_triggers trigger ON trigger.trigger_id=invocation.trigger_id
       WHERE invocation.invocation_id=?`,
    ).get(invocationId) as unknown as (AutomationTriggerInvocationRow & { trigger_kind: AutomationTriggerKind }) | undefined;
    if (!row) return null;
    return {
      ...(JSON.parse(row.spec_json) as AutomationSpec),
      automationId: row.automation_id,
      revision: row.automation_revision,
      createdBy: { kind: "policy", id: `${row.trigger_kind}:${row.trigger_id}` },
      createdAt: row.received_at,
      updatedAt: row.received_at,
    };
  }

  settleAutomationTriggerInvocation(
    invocationId: string,
    state: Exclude<AutomationTriggerInvocationState, "pending" | "dispatched">,
    now: number,
  ): AutomationTriggerInvocationRecord | null {
    this.stmt(
      `UPDATE automation_trigger_invocations SET state=?,
       spec_json=CASE WHEN ?='rejected' THEN '{}' ELSE spec_json END,
       sender_hash=CASE WHEN ?='rejected' THEN NULL ELSE sender_hash END,
       updated_at=? WHERE invocation_id=? AND state='pending'`,
    ).run(state, state, state, now, invocationId);
    return this.getAutomationTriggerInvocation(invocationId);
  }

  dueAutomations(now: number, limit = 100): AutomationSchedule[] {
    const rows = this.stmt(
      `SELECT * FROM automations WHERE deleted_at IS NULL AND enabled=1 AND next_fire_at IS NOT NULL
       AND next_fire_at<=? ORDER BY next_fire_at, automation_id LIMIT ?`,
    ).all(now, Math.max(1, Math.min(100, Math.floor(limit)))) as unknown as AutomationRow[];
    return rows.map((row) => this.automation(row));
  }

  activeAutomationExecution(automationId: string): AutomationExecution | null {
    const row = this.stmt(
      `SELECT * FROM automation_executions WHERE automation_id=? AND status IN ('dispatching','running')
       ORDER BY scheduled_for, execution_id LIMIT 1`,
    ).get(automationId) as unknown as AutomationExecutionRow | undefined;
    return row ? this.automationExecution(row) : null;
  }

  activeAutomationExecutions(): AutomationExecution[] {
    const rows = this.stmt(
      "SELECT * FROM automation_executions WHERE status IN ('dispatching','running') ORDER BY created_at, execution_id",
    ).all() as unknown as AutomationExecutionRow[];
    return rows.map((row) => this.automationExecution(row));
  }

  claimAutomationExecution(input: {
    executionId: string;
    automationId: string;
    expectedNextFireAt: number;
    scheduledFor: number;
    nextFireAt: number;
    actionKind: AutomationExecution["actionKind"];
    status: "dispatching" | "skipped" | "expired";
    deliveryMode?: NonNullable<AutomationExecution["deliveryMode"]>;
    actor: GovernanceActor;
    error?: string;
    eventKind?: AutomationAuditEventKind;
    eventDetail?: AutomationAuditEvent["detail"];
    now: number;
  }): AutomationExecution | null {
    const idempotencyKey = `${input.automationId}:${input.scheduledFor}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.stmt(
        `UPDATE automations SET next_fire_at=?, last_fired_at=?, updated_at=?
         WHERE automation_id=? AND deleted_at IS NULL AND enabled=1 AND next_fire_at=?`,
      ).run(input.nextFireAt, input.scheduledFor, input.now, input.automationId, input.expectedNextFireAt);
      if (Number(changed.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return null;
      }
      const scheduleRow = this.stmt("SELECT * FROM automations WHERE automation_id=?")
        .get(input.automationId) as unknown as AutomationRow;
      const schedule = this.automation(scheduleRow);
      const { automationId: _automationId, revision: _revision, nextFireAt: _nextFireAt,
        lastFiredAt: _lastFiredAt, createdBy: _createdBy, createdAt: _createdAt,
        updatedAt: _updatedAt, ...specSnapshot } = schedule;
      const terminal = input.status === "dispatching" ? null : input.now;
      this.stmt(
        `INSERT INTO automation_executions
         (execution_id, automation_id, idempotency_key, scheduled_for, automation_revision, spec_json,
          delivery_mode, action_kind, status, actor_kind, actor_id, error, created_at, completed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        input.executionId, input.automationId, idempotencyKey, input.scheduledFor,
        schedule.revision, JSON.stringify(specSnapshot), input.deliveryMode ?? "legacy_at_most_once", input.actionKind,
        input.status, input.actor.kind, input.actor.id ?? null, input.error ?? null, input.now, terminal,
      );
      this.insertAutomationEvent({
        automationId: input.automationId, executionId: input.executionId,
        kind: input.eventKind ?? "execution_claimed", actor: input.actor,
        detail: input.eventDetail ?? { scheduledFor: input.scheduledFor, status: input.status }, now: input.now,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getAutomationExecution(input.executionId);
  }

  claimAutomationTriggerExecution(input: {
    invocationId: string;
    executionId: string;
    status: "dispatching" | "skipped" | "expired";
    actor: GovernanceActor;
    error?: string;
    now: number;
  }): AutomationExecution | null {
    this.db.exec("BEGIN IMMEDIATE");
    let existingExecutionId: string | null = null;
    try {
      const row = this.stmt(
        `SELECT invocation.*, trigger.kind AS trigger_kind, automation.next_fire_at
         FROM automation_trigger_invocations invocation
         JOIN automation_triggers trigger ON trigger.trigger_id=invocation.trigger_id
         JOIN automations automation ON automation.automation_id=trigger.automation_id
         WHERE invocation.invocation_id=?`,
      ).get(input.invocationId) as unknown as (AutomationTriggerInvocationRow & {
        next_fire_at: number | null; trigger_kind: AutomationTriggerKind;
      }) | undefined;
      if (!row) {
        this.db.exec("ROLLBACK");
        return null;
      }
      if (row.state !== "pending") {
        existingExecutionId = row.execution_id;
        this.db.exec("COMMIT");
      } else {
        const specSnapshot = JSON.parse(row.spec_json) as AutomationSpec;
        const maximum = this.stmt(
          "SELECT MAX(scheduled_for) AS value FROM automation_executions WHERE automation_id=?",
        ).get(row.automation_id) as { value: number | null };
        let scheduledFor = Math.max(row.received_at, (maximum.value ?? row.received_at - 1) + 1);
        // The legacy scheduler uniqueness constraint remains on prerelease databases. Never occupy
        // the exact next cron timestamp with an out-of-band occurrence.
        if (row.next_fire_at !== null && scheduledFor === row.next_fire_at) scheduledFor += 1;
        while (this.stmt(
          "SELECT 1 FROM automation_executions WHERE automation_id=? AND scheduled_for=?",
        ).get(row.automation_id, scheduledFor)) scheduledFor += 1;
        const idempotencyKey = `trigger:${row.trigger_id}:${row.event_id}`;
        const terminal = input.status === "dispatching" ? null : input.now;
        this.stmt(
          `INSERT INTO automation_executions
           (execution_id,automation_id,idempotency_key,scheduled_for,automation_revision,spec_json,
            delivery_mode,action_kind,status,actor_kind,actor_id,error,created_at,completed_at)
           VALUES (?,?,?,?,?,?,'receipted_v53',?,?,?,?,?,?,?)`,
        ).run(input.executionId, row.automation_id, idempotencyKey, scheduledFor, row.automation_revision,
          row.spec_json, specSnapshot.action.kind, input.status, input.actor.kind,
          input.actor.id ?? null, input.error ?? null, input.now, terminal);
        const invocationState: AutomationTriggerInvocationState = input.status === "dispatching"
          ? "dispatched" : input.status;
        this.stmt(
          `UPDATE automation_trigger_invocations SET state=?, execution_id=?, updated_at=?
           WHERE invocation_id=? AND state='pending'`,
        ).run(invocationState, input.executionId, input.now, input.invocationId);
        this.insertAutomationEvent({
          automationId: row.automation_id, executionId: input.executionId, kind: "trigger_invoked", actor: input.actor,
          detail: {
            triggerId: row.trigger_id,
            triggerKind: row.trigger_kind,
            invocationId: row.invocation_id,
            status: input.status,
          },
          now: input.now,
        });
        this.db.exec("COMMIT");
        existingExecutionId = input.executionId;
      }
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return existingExecutionId ? this.getAutomationExecution(existingExecutionId) : null;
  }

  stageAutomationDeliveryPlan(input: StageAutomationDeliveryPlanInput): AutomationCommandRecord[] {
    if (!input.commands.length && (!input.runId || !input.workflowInstanceId)) {
      throw new Error("automation delivery plan requires a command or a control-plane-only workflow");
    }
    JSON.parse(input.planJson);
    const ordinals = new Set<number>();
    const byId = new Map(input.commands.map((command) => [command.commandId, command]));
    for (const command of input.commands) {
      if (!command.commandId || !command.runnerId || !command.sessionId ||
          !Number.isInteger(command.ordinal) || command.ordinal < 0 || ordinals.has(command.ordinal) ||
          !/^[a-f0-9]{64}$/i.test(command.payloadSha256)) {
        throw new Error("automation delivery command is malformed");
      }
      JSON.parse(command.payloadJson);
      ordinals.add(command.ordinal);
      if (command.dependencyCommandId) {
        const dependency = byId.get(command.dependencyCommandId);
        if (!dependency || dependency.ordinal >= command.ordinal) {
          throw new Error("automation command dependency must reference an earlier command in the same plan");
        }
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const execution = this.stmt(
        "SELECT automation_id, status, delivery_mode, delivery_plan_json, runner_id, session_id, run_id, workflow_instance_id FROM automation_executions WHERE execution_id=?",
      ).get(input.executionId) as unknown as {
        automation_id: string; status: AutomationExecutionStatus; delivery_mode: string; delivery_plan_json: string | null;
        runner_id: string | null; session_id: string | null; run_id: string | null; workflow_instance_id: string | null;
      } | undefined;
      if (!execution) throw new Error("automation execution not found");
      if (execution.status !== "dispatching") throw new Error(`automation execution is ${execution.status}`);
      const existing = this.stmt(
        "SELECT * FROM automation_commands WHERE execution_id=? ORDER BY ordinal, command_id",
      ).all(input.executionId) as unknown as AutomationCommandRow[];
      if (execution.delivery_plan_json !== null || existing.length) {
        const samePlan = execution.delivery_mode === "receipted_v53" && execution.delivery_plan_json === input.planJson &&
          execution.runner_id === input.runnerId && execution.session_id === (input.sessionId ?? null) &&
          execution.run_id === (input.runId ?? null) && execution.workflow_instance_id === (input.workflowInstanceId ?? null) &&
          existing.length === input.commands.length && existing.every((row, index) => {
            const command = [...input.commands].sort((a, b) => a.ordinal - b.ordinal || a.commandId.localeCompare(b.commandId))[index];
            return command && row.command_id === command.commandId && row.ordinal === command.ordinal &&
              row.runner_id === command.runnerId && row.session_id === command.sessionId && row.kind === command.kind &&
              row.payload_json === command.payloadJson && row.payload_sha256 === command.payloadSha256 &&
              row.expires_at === (command.expiresAt ?? null) &&
              row.dependency_command_id === (command.dependencyCommandId ?? null);
          });
        if (!samePlan) throw new Error("automation execution already has a different delivery plan");
        this.db.exec("COMMIT");
        return existing.map((row) => this.automationCommand(row));
      }
      const changed = this.stmt(
        `UPDATE automation_executions SET delivery_mode='receipted_v53', delivery_plan_json=?, runner_id=?,
         session_id=?, run_id=?, workflow_instance_id=? WHERE execution_id=? AND status='dispatching'`,
      ).run(input.planJson, input.runnerId, input.sessionId ?? null, input.runId ?? null,
        input.workflowInstanceId ?? null, input.executionId);
      if (Number(changed.changes) !== 1) throw new Error("automation execution could not stage delivery");
      const insert = this.stmt(
        `INSERT INTO automation_commands
         (command_id, execution_id, ordinal, runner_id, session_id, kind, payload_json, payload_sha256,
          expires_at, dependency_command_id, state, revision, attempt_count, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'staged',0,0,?,?)`,
      );
      for (const command of [...input.commands].sort((a, b) => a.ordinal - b.ordinal)) {
        insert.run(command.commandId, input.executionId, command.ordinal, command.runnerId, command.sessionId,
          command.kind, command.payloadJson, command.payloadSha256, command.expiresAt ?? null,
          command.dependencyCommandId ?? null, input.now, input.now);
        this.insertAutomationEvent({
          automationId: execution.automation_id, executionId: input.executionId, kind: "command_status_changed",
          actor: { kind: "system", id: "automation-outbox" },
          detail: { commandId: command.commandId, state: "staged", ordinal: command.ordinal }, now: input.now,
        });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.listAutomationCommands(input.executionId);
  }

  activateAutomationCommands(executionId: string, now: number): AutomationCommandRecord[] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const execution = this.stmt("SELECT automation_id FROM automation_executions WHERE execution_id=? AND status='dispatching'")
        .get(executionId) as { automation_id: string } | undefined;
      if (!execution) throw new Error("dispatching automation execution not found");
      const staged = this.stmt(
        "SELECT command_id, ordinal FROM automation_commands WHERE execution_id=? AND state='staged' ORDER BY ordinal",
      ).all(executionId) as Array<{ command_id: string; ordinal: number }>;
      this.stmt(
        "UPDATE automation_commands SET state='pending', next_attempt_at=?, updated_at=? WHERE execution_id=? AND state='staged'",
      ).run(now, now, executionId);
      for (const command of staged) {
        this.insertAutomationEvent({
          automationId: execution.automation_id, executionId, kind: "command_status_changed",
          actor: { kind: "system", id: "automation-outbox" },
          detail: { commandId: command.command_id, state: "pending", ordinal: command.ordinal }, now,
        });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.listAutomationCommands(executionId);
  }

  dueAutomationCommands(now: number, runnerId?: string, limit = 100): AutomationCommandRecord[] {
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    const runner = runnerId ? "AND command.runner_id=?" : "";
    const params = runnerId ? [now, now, runnerId, bounded] : [now, now, bounded];
    const rows = this.stmt(
      `SELECT command.* FROM automation_commands command
       JOIN automation_executions execution ON execution.execution_id=command.execution_id
       WHERE execution.status IN ('dispatching','running')
         AND command.state IN ('pending','sent','accepted','started') AND command.next_attempt_at IS NOT NULL
         AND command.next_attempt_at<=? AND (command.expires_at IS NULL OR command.expires_at>?) ${runner}
         AND (command.dependency_command_id IS NULL OR EXISTS (
           SELECT 1 FROM automation_commands dependency
           WHERE dependency.command_id=command.dependency_command_id AND dependency.state='completed'
         ))
         AND NOT EXISTS (
           SELECT 1 FROM automation_commands blocker
           WHERE blocker.execution_id=command.execution_id AND blocker.state IN ('rejected','uncertain')
         )
       ORDER BY command.next_attempt_at, command.execution_id, command.ordinal LIMIT ?`,
    ).all(...params) as unknown as AutomationCommandRow[];
    return rows.map((row) => this.automationCommand(row));
  }

  activeAutomationCommands(runnerId?: string, limit = 100): AutomationCommandRecord[] {
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    const runner = runnerId ? "AND command.runner_id=?" : "";
    const params = runnerId ? [runnerId, bounded] : [bounded];
    const rows = this.stmt(
      `SELECT command.* FROM automation_commands command
       JOIN automation_executions execution ON execution.execution_id=command.execution_id
       WHERE execution.status IN ('dispatching','running')
         AND command.state IN ('staged','pending','sent','accepted','started') ${runner}
       ORDER BY command.execution_id, command.ordinal LIMIT ?`,
    ).all(...params) as unknown as AutomationCommandRow[];
    return rows.map((row) => this.automationCommand(row));
  }

  expireAutomationCommands(now: number, limit = 100): AutomationCommandRecord[] {
    const rows = this.stmt(
      `SELECT * FROM automation_commands WHERE state IN ('staged','pending','sent','accepted','started')
       AND expires_at IS NOT NULL AND expires_at<=? ORDER BY expires_at, execution_id, ordinal LIMIT ?`,
    ).all(now, Math.max(1, Math.min(100, Math.floor(limit)))) as unknown as AutomationCommandRow[];
    const expired: AutomationCommandRecord[] = [];
    for (const row of rows) {
      // `sent` is mark-before-send: after a crash it may mean bytes never left, or that the runner
      // accepted them and its ACK was lost. Only staged/pending are provably unaccepted.
      const accepted = row.state === "sent" || row.state === "accepted" || row.state === "started";
      const applied = this.recordAutomationCommandReceipt({
        commandId: row.command_id,
        runnerId: row.runner_id,
        state: accepted ? "uncertain" : "rejected",
        revision: row.revision + 1,
        error: accepted
          ? "durable automation command exceeded its receipt horizon after runner acceptance"
          : "durable automation command expired before runner acceptance",
        now,
      });
      if (applied) expired.push(applied.command);
    }
    return expired;
  }

  markAutomationCommandSent(
    commandId: string,
    requestId: string,
    now: number,
    nextAttemptAt: number,
    error?: string,
  ): AutomationCommandRecord | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.stmt(
        `SELECT command.*, execution.automation_id FROM automation_commands command
         JOIN automation_executions execution ON execution.execution_id=command.execution_id
         WHERE command.command_id=?`,
      ).get(commandId) as unknown as (AutomationCommandRow & { automation_id: string }) | undefined;
      if (!row) { this.db.exec("ROLLBACK"); return null; }
      if (!["pending", "sent", "accepted", "started"].includes(row.state)) {
        this.db.exec("COMMIT");
        return this.automationCommand(row);
      }
      this.stmt(
        `INSERT INTO automation_command_attempts (request_id,command_id,runner_id,attempt_number,sent_at)
         VALUES (?,?,?,?,?)`,
      ).run(requestId, commandId, row.runner_id, row.attempt_count + 1, now);
      this.stmt(
        `UPDATE automation_commands SET state=CASE WHEN state IN ('pending','sent') THEN 'sent' ELSE state END,
         attempt_count=attempt_count+1, last_sent_at=?, next_attempt_at=?, last_error=?, updated_at=?
         WHERE command_id=? AND state IN ('pending','sent','accepted','started')`,
      ).run(now, nextAttemptAt, error ?? null, now, commandId);
      this.insertAutomationEvent({
        automationId: row.automation_id, executionId: row.execution_id, kind: "command_status_changed",
        actor: { kind: "system", id: "automation-outbox" },
        detail: { commandId, state: row.state === "pending" || row.state === "sent" ? "sent" : row.state,
          attemptCount: row.attempt_count + 1 }, now,
      });
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
    return this.getAutomationCommand(commandId);
  }

  recordAutomationCommandReceipt(input: RecordAutomationCommandReceiptInput): {
    executionId: string;
    command: AutomationCommandRecord;
    advanced: boolean;
  } | null {
    const rank: Record<AutomationCommandState, number> = {
      staged: 0, pending: 1, sent: 2, accepted: 3, started: 4, completed: 5,
      rejected: 6, uncertain: 6,
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.stmt(
        `SELECT command.*, execution.automation_id FROM automation_commands command
         JOIN automation_executions execution ON execution.execution_id=command.execution_id
         WHERE command.command_id=?`,
      ).get(input.commandId) as unknown as (AutomationCommandRow & { automation_id: string }) | undefined;
      if (!row || row.runner_id !== input.runnerId ||
          (input.sessionId !== undefined && row.session_id !== input.sessionId)) {
        this.db.exec("ROLLBACK");
        return null;
      }
      if (input.requestId !== undefined) {
        const attempt = this.stmt(
          `SELECT 1 FROM automation_command_attempts
           WHERE request_id=? AND command_id=? AND runner_id=?`,
        ).get(input.requestId, input.commandId, input.runnerId);
        if (!attempt) { this.db.exec("ROLLBACK"); return null; }
      }
      const terminal = row.state === "completed" || row.state === "rejected" || row.state === "uncertain";
      const incomingTerminal = input.state === "completed" || input.state === "rejected" || input.state === "uncertain";
      if (terminal || input.revision < row.revision ||
          (input.revision === row.revision && input.state === row.state)) {
        this.db.exec("COMMIT");
        return { executionId: row.execution_id, command: this.automationCommand(row), advanced: false };
      }
      if ((input.revision === row.revision && !incomingTerminal) ||
          (!incomingTerminal && rank[input.state] < rank[row.state])) {
        this.db.exec("COMMIT");
        return { executionId: row.execution_id, command: this.automationCommand(row), advanced: false };
      }
      const completed = input.state === "completed" || input.state === "rejected" || input.state === "uncertain";
      this.stmt(
        `UPDATE automation_commands SET state=?, revision=?,
         next_attempt_at=CASE WHEN ? IN ('accepted','started') THEN ? ELSE NULL END,
         last_error=?, error_code=?,
         duplicate=?, user_event_seq=COALESCE(?,user_event_seq), updated_at=?,
         accepted_at=CASE WHEN ? IN ('accepted','started','completed') THEN COALESCE(accepted_at,?) ELSE accepted_at END,
         started_at=CASE WHEN ? IN ('started','completed') THEN COALESCE(started_at,?) ELSE started_at END,
         payload_json=CASE WHEN ? THEN 'null' ELSE payload_json END,
         completed_at=CASE WHEN ? THEN COALESCE(completed_at,?) ELSE completed_at END
         WHERE command_id=? AND revision<=? AND state NOT IN ('completed','rejected','uncertain')`,
      ).run(input.state, input.revision, input.state, input.now + 30_000, input.error ?? null, input.code ?? null,
        input.duplicate === undefined ? null : input.duplicate ? 1 : 0, input.userEventSeq ?? null, input.now,
        input.state, input.now, input.state, input.now, completed ? 1 : 0, completed ? 1 : 0, input.now,
        input.commandId, input.revision);
      this.insertAutomationEvent({
        automationId: row.automation_id, executionId: row.execution_id, kind: "command_status_changed",
        actor: { kind: "system", id: `runner:${input.runnerId}` },
        detail: { commandId: input.commandId, state: input.state, revision: input.revision,
          code: input.code ?? null, duplicate: input.duplicate ?? false }, now: input.now,
      });
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
    const command = this.getAutomationCommand(input.commandId)!;
    return { executionId: command.executionId, command, advanced: true };
  }

  rejectAutomationCommand(commandId: string, error: string, now: number): AutomationCommandRecord | null {
    const row = this.getAutomationCommand(commandId);
    if (!row) return null;
    const applied = this.recordAutomationCommandReceipt({
      commandId,
      runnerId: row.runnerId,
      state: "rejected",
      revision: row.revision + 1,
      error,
      now,
    });
    return applied?.command ?? null;
  }

  terminalizeAutomationExecutionCommands(
    executionId: string,
    exceptCommandId: string,
    error: string,
    now: number,
  ): AutomationCommandRecord[] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const execution = this.stmt("SELECT automation_id FROM automation_executions WHERE execution_id=?")
        .get(executionId) as { automation_id: string } | undefined;
      if (!execution) { this.db.exec("ROLLBACK"); return []; }
      const rows = this.stmt(
        `SELECT * FROM automation_commands WHERE execution_id=? AND command_id<>?
         AND state NOT IN ('completed','rejected','uncertain') ORDER BY ordinal, command_id`,
      ).all(executionId, exceptCommandId) as unknown as AutomationCommandRow[];
      for (const row of rows) {
        const accepted = row.state === "sent" || row.state === "accepted" || row.state === "started";
        const state: AutomationCommandState = accepted ? "uncertain" : "rejected";
        const lastError = accepted ? `${error}; runner cancellation was requested after acceptance` : error;
        this.stmt(
          `UPDATE automation_commands SET state=?, revision=revision+1, next_attempt_at=NULL,
           last_error=?, payload_json='null', updated_at=?, completed_at=COALESCE(completed_at,?)
           WHERE command_id=? AND state NOT IN ('completed','rejected','uncertain')`,
        ).run(state, lastError, now, now, row.command_id);
        this.insertAutomationEvent({
          automationId: execution.automation_id,
          executionId,
          kind: "command_status_changed",
          actor: { kind: "system", id: "automation-outbox" },
          detail: { commandId: row.command_id, state, revision: row.revision + 1 },
          now,
        });
      }
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
    return this.listAutomationCommands(executionId)
      .filter((row) => row.commandId !== exceptCommandId && ["rejected", "uncertain"].includes(row.state));
  }

  listAutomationCommands(executionId: string): AutomationCommandRecord[] {
    const rows = this.stmt(
      "SELECT * FROM automation_commands WHERE execution_id=? ORDER BY ordinal, command_id",
    ).all(executionId) as unknown as AutomationCommandRow[];
    return rows.map((row) => this.automationCommand(row));
  }

  getAutomationDeliveryPlan(executionId: string): string | null {
    const row = this.stmt("SELECT delivery_plan_json FROM automation_executions WHERE execution_id=?")
      .get(executionId) as { delivery_plan_json: string | null } | undefined;
    return row?.delivery_plan_json ?? null;
  }

  getAutomationCommand(commandId: string): AutomationCommandRecord | null {
    const row = this.stmt("SELECT * FROM automation_commands WHERE command_id=?")
      .get(commandId) as unknown as AutomationCommandRow | undefined;
    return row ? this.automationCommand(row) : null;
  }

  settleAutomationExecution(input: {
    executionId: string;
    status: "running" | "succeeded" | "failed";
    actor: GovernanceActor;
    runnerId?: string;
    sessionId?: string;
    runId?: string;
    workflowInstanceId?: string;
    error?: string;
    now: number;
  }): AutomationExecution | null {
    const allowed = input.status === "running" ? "status='dispatching'" : "status IN ('dispatching','running')";
    const terminal = input.status === "running" ? null : input.now;
    const started = input.status === "running" ? input.now : null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.stmt(
        `UPDATE automation_executions SET status=?, runner_id=COALESCE(?,runner_id),
          session_id=COALESCE(?,session_id), run_id=COALESCE(?,run_id),
          workflow_instance_id=COALESCE(?,workflow_instance_id), error=?,
          started_at=COALESCE(started_at,?), completed_at=? WHERE execution_id=? AND ${allowed}`,
      ).run(
        input.status, input.runnerId ?? null, input.sessionId ?? null, input.runId ?? null,
        input.workflowInstanceId ?? null, input.error ?? null, started, terminal, input.executionId,
      );
      if (Number(changed.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return null;
      }
      const row = this.stmt("SELECT automation_id FROM automation_executions WHERE execution_id=?")
        .get(input.executionId) as { automation_id: string };
      this.insertAutomationEvent({
        automationId: row.automation_id, executionId: input.executionId, kind: "execution_status_changed",
        actor: input.actor, detail: { status: input.status, error: input.error ?? null }, now: input.now,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getAutomationExecution(input.executionId);
  }

  failInterruptedAutomationExecutions(now: number): number {
    const rows = this.stmt(
      "SELECT execution_id FROM automation_executions WHERE status='dispatching' AND delivery_mode<>'receipted_v53'",
    )
      .all() as Array<{ execution_id: string }>;
    for (const row of rows) {
      this.settleAutomationExecution({
        executionId: row.execution_id, status: "failed", actor: { kind: "system", id: "scheduler-recovery" },
        error: "control plane restarted with automation delivery uncertain; the action was not replayed", now,
      });
    }
    return rows.length;
  }

  getAutomationExecution(executionId: string): AutomationExecution | null {
    const row = this.stmt("SELECT * FROM automation_executions WHERE execution_id=?")
      .get(executionId) as unknown as AutomationExecutionRow | undefined;
    return row ? this.automationExecution(row) : null;
  }

  listAutomationExecutions(automationId: string, limit = 50): AutomationExecution[] {
    const rows = this.stmt(
      `SELECT * FROM automation_executions WHERE automation_id=?
       ORDER BY scheduled_for DESC, execution_id DESC LIMIT ?`,
    ).all(automationId, Math.max(1, Math.min(100, Math.floor(limit)))) as unknown as AutomationExecutionRow[];
    return rows.map((row) => this.automationExecution(row));
  }

  listAutomationEvents(automationId: string, limit = 100): AutomationAuditEvent[] {
    const rows = this.stmt(
      `SELECT * FROM automation_events WHERE automation_id=?
       ORDER BY created_at DESC, event_id DESC LIMIT ?`,
    ).all(automationId, Math.max(1, Math.min(200, Math.floor(limit)))) as unknown as AutomationEventRow[];
    return rows.map((row) => ({
      eventId: row.event_id, automationId: row.automation_id,
      ...(row.execution_id ? { executionId: row.execution_id } : {}), kind: row.kind,
      actor: { kind: row.actor_kind, ...(row.actor_id ? { id: row.actor_id } : {}) },
      ...(row.detail ? { detail: JSON.parse(row.detail) as AutomationAuditEvent["detail"] } : {}),
      createdAt: row.created_at,
    }));
  }

  private insertAutomationEvent(input: {
    automationId: string;
    executionId?: string;
    kind: AutomationAuditEventKind;
    actor: GovernanceActor;
    detail?: AutomationAuditEvent["detail"];
    now: number;
  }): void {
    this.stmt(
      `INSERT INTO automation_events
       (automation_id, execution_id, kind, actor_kind, actor_id, detail, created_at) VALUES (?,?,?,?,?,?,?)`,
    ).run(
      input.automationId, input.executionId ?? null, input.kind, input.actor.kind, input.actor.id ?? null,
      input.detail ? JSON.stringify(input.detail) : null, input.now,
    );
  }

  private automation(row: AutomationRow): AutomationSchedule {
    return {
      automationId: row.automation_id, revision: row.revision, name: row.name, cron: row.cron_expression, timezone: row.timezone,
      enabled: row.enabled === 1,
      ...(row.next_fire_at === null ? {} : { nextFireAt: row.next_fire_at }),
      ...(row.last_fired_at === null ? {} : { lastFiredAt: row.last_fired_at }),
      misfirePolicy: JSON.parse(row.misfire_policy) as AutomationSchedule["misfirePolicy"],
      runnerPolicy: JSON.parse(row.runner_policy) as AutomationSchedule["runnerPolicy"],
      concurrencyPolicy: row.concurrency_policy,
      limits: JSON.parse(row.limits_json) as AutomationSchedule["limits"],
      notifications: JSON.parse(row.notifications_json) as AutomationSchedule["notifications"],
      action: JSON.parse(row.action_json) as AutomationSchedule["action"],
      createdBy: { kind: row.created_by_kind, ...(row.created_by_id ? { id: row.created_by_id } : {}) },
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  private automationExecution(row: AutomationExecutionRow): AutomationExecution {
    const commands = row.delivery_mode === "receipted_v53"
      ? this.listAutomationCommands(row.execution_id).map((command) => this.automationCommandView(command))
      : [];
    return {
      executionId: row.execution_id, automationId: row.automation_id, idempotencyKey: row.idempotency_key,
      scheduledFor: row.scheduled_for, automationRevision: row.automation_revision,
      ...(row.spec_json ? { specSnapshot: JSON.parse(row.spec_json) as AutomationSpec } : {}),
      actionKind: row.action_kind, status: row.status,
      deliveryMode: row.delivery_mode as NonNullable<AutomationExecution["deliveryMode"]>,
      actor: { kind: row.actor_kind, ...(row.actor_id ? { id: row.actor_id } : {}) },
      ...(row.runner_id ? { runnerId: row.runner_id } : {}),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(row.workflow_instance_id ? { workflowInstanceId: row.workflow_instance_id } : {}),
      ...(row.error ? { error: row.error } : {}), createdAt: row.created_at,
      ...(row.started_at === null ? {} : { startedAt: row.started_at }),
      ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
      ...(commands.length ? { commands } : {}),
    };
  }

  private automationTrigger(row: AutomationTriggerRow): AutomationTriggerView {
    return {
      triggerId: row.trigger_id,
      automationId: row.automation_id,
      kind: row.kind,
      name: row.name,
      generation: row.generation,
      createdBy: { kind: row.created_by_kind, ...(row.created_by_id ? { id: row.created_by_id } : {}) },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.last_invoked_at == null ? {} : { lastInvokedAt: row.last_invoked_at }),
      invocationCount: Number(row.invocation_count ?? 0),
    };
  }

  private automationTriggerInvocation(row: AutomationTriggerInvocationRow): AutomationTriggerInvocationRecord {
    return {
      invocationId: row.invocation_id,
      triggerId: row.trigger_id,
      automationId: row.automation_id,
      eventId: row.event_id,
      state: row.state,
      automationRevision: row.automation_revision,
      specJson: row.spec_json,
      bodySha256: row.body_sha256,
      ...(row.sender_hash ? { senderHash: row.sender_hash } : {}),
      receivedAt: row.received_at,
      updatedAt: row.updated_at,
      ...(row.execution_id ? { executionId: row.execution_id } : {}),
    };
  }

  private automationCommandView(command: AutomationCommandRecord): AutomationCommandView {
    return {
      commandId: command.commandId,
      executionId: command.executionId,
      ordinal: command.ordinal,
      runnerId: command.runnerId,
      sessionId: command.sessionId,
      kind: command.kind,
      state: command.state,
      revision: command.revision,
      attemptCount: command.attemptCount,
      ...(command.lastError === undefined ? {} : { lastError: command.lastError }),
      createdAt: command.createdAt,
      updatedAt: command.updatedAt,
      ...(command.lastSentAt === undefined ? {} : { lastSentAt: command.lastSentAt }),
      ...(command.acceptedAt === undefined ? {} : { acceptedAt: command.acceptedAt }),
      ...(command.startedAt === undefined ? {} : { startedAt: command.startedAt }),
      ...(command.completedAt === undefined ? {} : { completedAt: command.completedAt }),
    };
  }

  private automationCommand(row: AutomationCommandRow): AutomationCommandRecord {
    return {
      commandId: row.command_id,
      executionId: row.execution_id,
      ordinal: row.ordinal,
      runnerId: row.runner_id,
      sessionId: row.session_id,
      kind: row.kind,
      state: row.state,
      revision: row.revision,
      attemptCount: row.attempt_count,
      payloadJson: row.payload_json,
      payloadSha256: row.payload_sha256,
      expiresAt: row.expires_at ?? Number.MAX_SAFE_INTEGER,
      ...(row.dependency_command_id ? { dependencyCommandId: row.dependency_command_id } : {}),
      ...(row.next_attempt_at === null ? {} : { nextAttemptAt: row.next_attempt_at }),
      ...(row.last_error ? { lastError: row.last_error } : {}),
      ...(row.error_code ? { errorCode: row.error_code as DurableSessionCommandErrorCode } : {}),
      ...(row.duplicate === null ? {} : { duplicate: row.duplicate === 1 }),
      ...(row.user_event_seq === null ? {} : { userEventSeq: row.user_event_seq }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.last_sent_at === null ? {} : { lastSentAt: row.last_sent_at }),
      ...(row.accepted_at === null ? {} : { acceptedAt: row.accepted_at }),
      ...(row.started_at === null ? {} : { startedAt: row.started_at }),
      ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    };
  }

  /** Test-only: the underlying sqlite handle (out-of-band drift simulation in FTS tests). */
  raw(): DatabaseSync {
    return this.db;
  }

  close(): void {
    this.collectWorkflowArtifactBlobs();
    this.db.close();
  }
}

function jsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function jsonObject(raw: string): Record<string, string> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function parseBackgroundWorkState(raw: string | null): BackgroundWorkState | undefined {
  return raw === "running" || raw === "continuation_pending" || raw === "orphaned"
    ? raw
    : undefined;
}

/** A pre-v106 runner may still report the historical `resumed` sentinel. The delivery rows retain
 * that event durably; the current-state column deliberately clears it. */
function backgroundWorkStateForStorage(raw: BackgroundWorkState | undefined): string | null {
  return raw === "running" || raw === "continuation_pending" || raw === "orphaned" ? raw : null;
}

function parseBackgroundWorkTracking(raw: string | null): BackgroundWorkTracking | undefined {
  return raw === "managed" || raw === "untracked" ? raw : undefined;
}

function validBackgroundIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function validOptionalBackgroundIdentity(value: unknown): value is string | undefined {
  return value === undefined || validBackgroundIdentity(value);
}

function validBackgroundTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validOptionalBackgroundTimestamp(value: unknown): value is number | undefined {
  return value === undefined || validBackgroundTimestamp(value);
}

function validOptionalBackgroundBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function validBackgroundLaunchType(
  value: unknown,
): value is ManagedBackgroundJobSnapshot["launchType"] {
  return value === "agent" || value === "shell" || value === "monitor" ||
    value === "workflow" || value === "unknown";
}

function validBackgroundTerminalStatus(
  value: unknown,
): value is ManagedBackgroundJobSnapshot["terminalStatus"] {
  return value === undefined || value === "completed" || value === "failed" || value === "killed";
}
