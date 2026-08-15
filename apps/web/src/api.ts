import type {
  AddBoxRequest,
  AccessScopeChangePreview,
  AddPodMemberRequest,
  AppendPodContextRequest,
  ApprovalQueueItem,
  ApprovalQueueRejectRequest,
  ApprovalQueueRejectResult,
  ApproveRequest,
  AutomationExecution,
  AutomationAuditEvent,
  AutomationSchedule,
  AutomationTriggerCredential,
  AutomationTriggerView,
  BoardColumn,
  BoxView,
  CreatePodRequest,
  CreateProjectRequest,
  CreateAutomationRequest,
  CreateAutomationTriggerRequest,
  CreateRunRequest,
  CreateSessionRequest,
  AddProjectLocationRequest,
  CreateProjectLocationRequest,
  MoveProjectLocationRequest,
  CreateTranscriptShareRequest,
  CreateTranscriptShareResult,
  CreateWorkflowDefinitionRequest,
  CreateWorkflowArtifactRequest,
  CreateWorkflowRunRequest,
  CreateWorkflowRunResult,
  DeviceView,
  DirectoryEntry,
  ExternalSessionDescriptor,
  GitActionData,
  GitActionRequest,
  GitDiffInfo,
  GitDiffScope,
  GitSummaryInfo,
  GovernanceAuditEntry,
  IdentityAdministrationView,
  HostAction,
  MutationAuditView,
  OnboardingInfo,
  OrganizationMembershipView,
  OrganizationRole,
  ResourceOwner,
  PodContextEntry,
  PodContextPage,
  PodOrchestrationActionResult,
  PodReconciliationActionResult,
  PodView,
  ProjectResponse,
  ProjectsResponse,
  DeleteProjectResponse,
  ArchiveProjectSessionsResponse,
  PromptImageInput,
  PromptImageReference,
  InvokeSessionCommandRequest,
  RelayPodRequest,
  RelayPodResult,
  ReconcilePodRequest,
  RunView,
  ReviewQueueItem,
  ReviewFindingsResponse,
  RunnerCredentialSecret,
  CreateReviewFindingRequest,
  UpdateReviewFindingRequest,
  BundleReviewFindingsRequest,
  SessionConfig,
  SessionEventsResponse,
  SessionFileEntry,
  SessionView,
  SessionCommandInvocationView,
  SteerRequest,
  SteeringAttemptView,
  SetProjectRequest,
  SideChatResponse,
  SideChatView,
  ShellHistoryPage,
  ShellView,
  StartPodOrchestrationRequest,
  SshConfigHost,
  TeamView,
  TranscriptShareView,
  UsageAggregationGranularity,
  UsageAggregationResponse,
  UsageRetentionPolicy,
  UserStatus,
  WorkspaceInfo,
  WorkflowArtifact,
  WorkflowArtifactPage,
  WorkflowDefinition,
  WorkflowInstanceDetail,
  WorkflowInstanceView,
  UpdatePodMemberRequest,
  UpdateProjectRequest,
  UpdatePodOrchestrationRequest,
  UpdateAutomationRequest,
  DispatchWorkflowNodeResult,
} from "@wollipog/protocol";
import { isPromptImageReference } from "@wollipog/protocol";
import { CONTROL_PLANE_HTTP } from "./config.js";
import { deviceToken } from "./device-token.js";
import { createBrowserApiTransport, type ApiTransport } from "./api-transport.js";

/** A non-2xx API response. IS-A Error, so existing `(e as Error).message` sites keep working;
 * `code` carries machine-readable failure classes (e.g. GIT_STALE → auto-refetch the diff). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function requestJson<T>(transport: ApiTransport, path: string, init?: RequestInit): Promise<T> {
  const res = await transport.request(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let code: string | undefined;
    let details: Record<string, unknown> | undefined;
    try {
      const body = (await res.json()) as Record<string, unknown> & { error?: string; code?: string };
      if (body?.error) message = body.error;
      if (typeof body?.code === "string") code = body.code;
      details = body;
    } catch {
      /* ignore */
    }
    throw new ApiError(message, res.status, code, details);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function sessionLookupPath(id: string): string {
  return `/api/sessions/lookup/by-id?${new URLSearchParams({ id }).toString()}`;
}

function accessScopeQuery(owner: ResourceOwner): string {
  const ownerId = owner.kind === "organization" ? owner.organizationId
    : owner.kind === "user" ? owner.userId : owner.teamId;
  return new URLSearchParams({ ownerKind: owner.kind, ownerId }).toString();
}

async function transcriptExport(
  transport: ApiTransport,
  id: string,
  format: "json" | "markdown",
): Promise<{ blob: Blob; filename: string }> {
  const res = await transport.request(
    `/api/sessions/${encodeURIComponent(id)}/export?format=${encodeURIComponent(format)}`,
  );
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      if (body?.error) message = body.error;
      if (typeof body?.code === "string") code = body.code;
    } catch {
      /* ignore */
    }
    throw new ApiError(message, res.status, code);
  }
  return {
    blob: await res.blob(),
    filename: `session-transcript-operationally-redacted.${format === "json" ? "json" : "md"}`,
  };
}

async function artifactExport(transport: ApiTransport, artifactId: string): Promise<Blob> {
  const res = await transport.request(`/api/artifacts/${encodeURIComponent(artifactId)}/export`, {
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      if (body?.error) message = body.error;
      if (typeof body?.code === "string") code = body.code;
    } catch {
      /* ignore */
    }
    throw new ApiError(message, res.status, code);
  }
  return res.blob();
}

async function uploadPromptImage(
  transport: ApiTransport,
  sessionId: string,
  image: PromptImageInput,
): Promise<PromptImageReference> {
  if (isPromptImageReference(image)) return image;
  const binary = atob(image.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const res = await transport.request(`/api/sessions/${encodeURIComponent(sessionId)}/prompt-images`, {
    method: "POST",
    headers: {
      "content-type": image.mimeType,
    },
    body: bytes,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch { /* ignore */ }
    throw new ApiError(message, res.status);
  }
  return await res.json() as PromptImageReference;
}

export function createApiClient(transport: ApiTransport) {
  const req = <T>(path: string, init?: RequestInit) => requestJson<T>(transport, path, init);
  const client = {
  usage: (input: {
    days: number;
    granularity?: UsageAggregationGranularity;
    runnerId?: string;
    workspaceId?: string;
    agentId?: string;
    driver?: string;
  }) => {
    const query = new URLSearchParams({ days: String(input.days) });
    for (const [key, value] of Object.entries(input)) {
      if (key !== "days" && value) query.set(key, String(value));
    }
    return req<UsageAggregationResponse>(`/api/usage?${query.toString()}`);
  },

  updateUsageRetention: (body: Pick<UsageRetentionPolicy, "hourlyDays" | "dailyDays">) =>
    req<{ retention: UsageRetentionPolicy }>("/api/usage/retention", {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  createSession: (body: CreateSessionRequest) =>
    req<SessionView>("/api/sessions", { method: "POST", body: JSON.stringify(body) }),

  projects: () => req<ProjectsResponse>("/api/projects"),

  project: (id: string) =>
    req<ProjectResponse>(`/api/projects/${encodeURIComponent(id)}`),

  createProject: (body: CreateProjectRequest) =>
    req<ProjectResponse>("/api/projects", { method: "POST", body: JSON.stringify(body) }),

  updateProject: (id: string, body: UpdateProjectRequest) =>
    req<ProjectResponse>(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  previewProjectAccessScope: (id: string, owner: ResourceOwner) =>
    req<{ preview: AccessScopeChangePreview }>(
      `/api/projects/${encodeURIComponent(id)}/access-scope?${accessScopeQuery(owner)}`,
    ),

  updateProjectAccessScope: (id: string, owner: ResourceOwner, confirmationToken: string) =>
    req<ProjectResponse & { preview: AccessScopeChangePreview }>(
      `/api/projects/${encodeURIComponent(id)}/access-scope`,
      { method: "PUT", body: JSON.stringify({ owner, confirmationToken }) },
    ),

  deleteProject: (id: string) =>
    req<DeleteProjectResponse>(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),

  addProjectLocation: (projectId: string, body: AddProjectLocationRequest) =>
    req<ProjectResponse>(`/api/projects/${encodeURIComponent(projectId)}/locations`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  createProjectLocation: (projectId: string, body: CreateProjectLocationRequest) =>
    req<ProjectResponse>(`/api/projects/${encodeURIComponent(projectId)}/locations/new`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  previewWorkspaceAccessScope: (runnerId: string, workspaceId: string, owner: ResourceOwner) =>
    req<{ preview: AccessScopeChangePreview }>(
      `/api/runners/${encodeURIComponent(runnerId)}/workspaces/${encodeURIComponent(workspaceId)}` +
      `/access-scope?${accessScopeQuery(owner)}`,
    ),

  updateWorkspaceAccessScope: (
    runnerId: string,
    workspaceId: string,
    owner: ResourceOwner,
    confirmationToken: string,
  ) => req<{ workspace: WorkspaceInfo; preview: AccessScopeChangePreview }>(
    `/api/runners/${encodeURIComponent(runnerId)}/workspaces/${encodeURIComponent(workspaceId)}/access-scope`,
    { method: "PUT", body: JSON.stringify({ owner, confirmationToken }) },
  ),

  moveProjectLocation: (projectId: string, body: MoveProjectLocationRequest) =>
    req<ProjectResponse>(`/api/projects/${encodeURIComponent(projectId)}/locations/move`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  removeProjectLocation: (projectId: string, locationId: string) =>
    req<ProjectResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(locationId)}`,
      { method: "DELETE" },
    ),

  setDefaultProjectLocation: (projectId: string, locationId: string) =>
    req<ProjectResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(locationId)}/default`,
      { method: "POST" },
    ),

  archiveProjectSessions: (projectId: string) =>
    req<ArchiveProjectSessionsResponse>(`/api/projects/${encodeURIComponent(projectId)}/archive-sessions`, {
      method: "POST",
    }),

  automations: () => req<{ automations: AutomationSchedule[] }>("/api/automations"),

  automation: (id: string) =>
    req<{ automation: AutomationSchedule; executions: AutomationExecution[]; events: AutomationAuditEvent[] }>(
      `/api/automations/${encodeURIComponent(id)}`,
    ),

  createAutomation: (body: CreateAutomationRequest) =>
    req<AutomationSchedule>("/api/automations", { method: "POST", body: JSON.stringify(body) }),

  updateAutomation: (id: string, body: UpdateAutomationRequest) =>
    req<AutomationSchedule>(`/api/automations/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  deleteAutomation: (id: string) =>
    req<{ deleted: true }>(`/api/automations/${encodeURIComponent(id)}`, { method: "DELETE" }),

  automationTriggers: (id: string) =>
    req<{ triggers: AutomationTriggerView[] }>(`/api/automations/${encodeURIComponent(id)}/triggers`),

  createAutomationTrigger: (id: string, body: CreateAutomationTriggerRequest) =>
    req<AutomationTriggerCredential>(`/api/automations/${encodeURIComponent(id)}/triggers`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  rotateAutomationTrigger: (automationId: string, triggerId: string) =>
    req<AutomationTriggerCredential>(
      `/api/automations/${encodeURIComponent(automationId)}/triggers/${encodeURIComponent(triggerId)}/rotate`,
      { method: "POST" },
    ),

  deleteAutomationTrigger: (automationId: string, triggerId: string) =>
    req<{ deleted: true }>(
      `/api/automations/${encodeURIComponent(automationId)}/triggers/${encodeURIComponent(triggerId)}`,
      { method: "DELETE" },
    ),

  getSessionEvents: (id: string, after = 0) =>
    req<SessionEventsResponse>(`/api/sessions/${encodeURIComponent(id)}/events?after=${after}`),

  sideChat: (id: string) =>
    req<SideChatResponse>(`/api/sessions/${encodeURIComponent(id)}/side-chat`),

  createSideChat: (id: string) =>
    req<SideChatView>(`/api/sessions/${encodeURIComponent(id)}/side-chat`, { method: "POST" }),

  getSessionEventPage: (id: string, after: number, eventEpoch: number, limit = 200) => {
    const query = new URLSearchParams({
      after: String(after),
      limit: String(limit),
      eventEpoch: String(eventEpoch),
    });
    return req<SessionEventsResponse>(`/api/sessions/${encodeURIComponent(id)}/events?${query}`);
  },

  transcriptExport: (id: string, format: "json" | "markdown") => transcriptExport(transport, id, format),

  transcriptShares: (id: string) =>
    req<{ shares: TranscriptShareView[] }>(`/api/sessions/${encodeURIComponent(id)}/transcript-shares`),

  createTranscriptShare: (id: string, body: CreateTranscriptShareRequest) =>
    req<CreateTranscriptShareResult>(`/api/sessions/${encodeURIComponent(id)}/transcript-shares`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  revokeTranscriptShare: (id: string, shareId: string) =>
    req<{ share: TranscriptShareView }>(
      `/api/sessions/${encodeURIComponent(id)}/transcript-shares/${encodeURIComponent(shareId)}`,
      { method: "DELETE" },
    ),

  // `config` is applied atomically before the turn on the control plane — pass the composer's
  // currently-selected model/effort/approval so a change made just before Send can't be lost to an
  // in-flight setConfig round trip.
  prompt: async (id: string, text: string, images: PromptImageInput[] = [], config?: SessionConfig, slashCommand?: string) => {
    const references = await Promise.all(images.map((image) => uploadPromptImage(transport, id, image)));
    return req<SessionView>(`/api/sessions/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text, images: references, config, slashCommand }),
    });
  },
  invokeSessionCommand: (id: string, request: InvokeSessionCommandRequest) =>
    req<SessionCommandInvocationView>(`/api/sessions/${encodeURIComponent(id)}/command-invocations`, {
      method: "POST",
      body: JSON.stringify(request),
    }),
  steer: async (id: string, request: SteerRequest) => {
    const references = request.images
      ? await Promise.all(request.images.map((image) => uploadPromptImage(transport, id, image)))
      : undefined;
    return req<SteeringAttemptView>(`/api/sessions/${encodeURIComponent(id)}/steer`, {
      method: "POST",
      body: JSON.stringify({
        ...request,
        ...(references ? { images: references } : {}),
      }),
    });
  },
  resolveSteeringAttempt: (
    id: string,
    submissionId: string,
    action: "queue_again" | "dismiss",
  ) => req<SteeringAttemptView>(
    `/api/sessions/${encodeURIComponent(id)}/steering/${encodeURIComponent(submissionId)}/resolve`,
    { method: "POST", body: JSON.stringify({ action }) },
  ),
  renameSession: (id: string, title: string) =>
    req<SessionView>(`/api/sessions/${id}/title`, {
      method: "POST",
      body: JSON.stringify({ title }),
    }),

  stop: (id: string) => req<SessionView>(`/api/sessions/${id}/stop`, { method: "POST" }),

  cancelTurn: (id: string) =>
    req<SessionView>(`/api/sessions/${encodeURIComponent(id)}/cancel`, { method: "POST" }),

  // Cancel one not-yet-started queued prompt. Fire-and-forget: the runner echoes the updated queue
  // back over the live socket (session_upsert), so there's nothing to read here.
  cancelQueuedPrompt: (id: string, promptId: string) =>
    req<void>(`/api/sessions/${id}/cancel-queued`, { method: "POST", body: JSON.stringify({ promptId }) }),

  resolvePendingPrompt: (id: string, commandId: string, action: "cancel" | "dismiss") =>
    req<SessionView>(
      `/api/sessions/${encodeURIComponent(id)}/pending-prompts/${encodeURIComponent(commandId)}/resolve`,
      { method: "POST", body: JSON.stringify({ action }) },
    ),

  restart: (id: string) => req<SessionView>(`/api/sessions/${id}/restart`, { method: "POST" }),

  approve: (id: string, body: ApproveRequest) =>
    req<SessionView>(`/api/sessions/${id}/approve`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  governanceAudit: (id: string, limit = 50) =>
    req<{ entries: GovernanceAuditEntry[] }>(
      `/api/sessions/${encodeURIComponent(id)}/governance-audit?limit=${limit}`,
    ),

  approvalQueue: () => req<{ items: ApprovalQueueItem[] }>("/api/governance/approval-queue"),

  reviewQueue: () => req<{ items: ReviewQueueItem[] }>("/api/governance/review-queue"),

  reviewFindings: (sessionId: string) =>
    req<ReviewFindingsResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/review-findings`),

  createReviewFinding: (sessionId: string, body: CreateReviewFindingRequest) =>
    req<ReviewFindingsResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/review-findings`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  updateReviewFinding: (sessionId: string, findingId: string, body: UpdateReviewFindingRequest) =>
    req<ReviewFindingsResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/review-findings/${encodeURIComponent(findingId)}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),

  bundleReviewFindings: (sessionId: string, body: BundleReviewFindingsRequest) =>
    req<ReviewFindingsResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/review-findings/bundle`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  rejectApprovalQueue: (body: ApprovalQueueRejectRequest) =>
    req<{ results: ApprovalQueueRejectResult[] }>("/api/governance/approval-queue/reject", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  answerQuestion: (id: string, body: { requestId: string; answers: Record<string, string | string[]> }) =>
    req<SessionView>(`/api/sessions/${id}/answer`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  rewind: (id: string, turn: number) =>
    req<{ ok: boolean }>(`/api/sessions/${id}/rewind`, {
      method: "POST",
      body: JSON.stringify({ turn }),
    }),

  fork: (id: string, turn: number) =>
    req<SessionView>(`/api/sessions/${id}/fork`, {
      method: "POST",
      body: JSON.stringify({ turn }),
    }),

  search: (q: string) =>
    req<{ results: { sessionId: string; seq: number; snippet: string; title: string; workspaceName?: string | null }[] }>(
      `/api/search?q=${encodeURIComponent(q)}`,
    ),

  setColumn: (id: string, column: BoardColumn) =>
    req<SessionView>(`/api/sessions/${id}/column`, {
      method: "POST",
      body: JSON.stringify({ column }),
    }),

  /** Full session list including archived — the live snapshot only carries non-archived
   * sessions, while archived sessions remain reachable through search and direct links. */
  listAllSessions: () => req<{ sessions: SessionView[] }>("/api/sessions?archived=true"),

  /** Exact authorized lookup used by direct links, including archived sessions omitted from the
   * live dashboard snapshot. */
  session: (id: string) => req<{ session: SessionView }>(sessionLookupPath(id)),

  setArchived: (id: string, archived: boolean) =>
    req<SessionView>(`/api/sessions/${id}/archive`, {
      method: "POST",
      body: JSON.stringify({ archived }),
    }),

  /** Legacy compatibility adapter: re-file by workspace identity (null means no workspace group). */
  setWorkspace: (id: string, workspaceId: string | null) =>
    req<SessionView>(`/api/sessions/${id}/workspace`, {
      method: "POST",
      body: JSON.stringify({ workspaceId }),
    }),

  setProject: (id: string, projectId: string | null, options: { linkLocation?: boolean } = {}) =>
    req<SessionView>(`/api/sessions/${encodeURIComponent(id)}/project`, {
      method: "POST",
      body: JSON.stringify({
        projectId,
        ...(options.linkLocation ? { linkLocation: true } : {}),
      } satisfies SetProjectRequest),
    }),

  setConfig: (id: string, config: SessionConfig) =>
    req<SessionView>(`/api/sessions/${id}/config`, {
      method: "POST",
      body: JSON.stringify(config),
    }),

  deleteSession: (id: string) => req<void>(`/api/sessions/${id}`, { method: "DELETE" }),

  logoutAgent: (id: string) =>
    req<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/logout-agent`, { method: "POST" }),

  // Re-import an adopted session: re-parse its original CLI transcript with the current parser.
  reprocessSession: (id: string) =>
    req<SessionView>(`/api/sessions/${encodeURIComponent(id)}/reprocess`, { method: "POST" }),

  createRun: (body: CreateRunRequest) =>
    req<{ run: RunView; sessions: SessionView[] }>("/api/runs", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  createPod: (body: CreatePodRequest) =>
    req<{ pod: PodView; sessions: SessionView[] }>("/api/pods", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  pod: (id: string) =>
    req<{ pod: PodView; sessions: SessionView[] }>(`/api/pods/${encodeURIComponent(id)}`),

  podContext: (id: string, before?: number, limit = 100) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (before !== undefined) query.set("before", String(before));
    return req<PodContextPage>(`/api/pods/${encodeURIComponent(id)}/context?${query}`);
  },

  appendPodContext: (id: string, body: AppendPodContextRequest) =>
    req<{ entry: PodContextEntry; created: boolean; pod: PodView }>(
      `/api/pods/${encodeURIComponent(id)}/context`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  addPodMember: (id: string, body: AddPodMemberRequest) =>
    req<{ pod: PodView; sessions: SessionView[] }>(`/api/pods/${encodeURIComponent(id)}/members`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  removePodMember: (id: string, sessionId: string) =>
    req<{ pod: PodView; sessions: SessionView[] }>(
      `/api/pods/${encodeURIComponent(id)}/members/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    ),

  updatePodMember: (id: string, sessionId: string, body: UpdatePodMemberRequest) =>
    req<{ pod: PodView; sessions: SessionView[] }>(
      `/api/pods/${encodeURIComponent(id)}/members/${encodeURIComponent(sessionId)}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),

  updatePodOrchestration: (id: string, body: UpdatePodOrchestrationRequest) =>
    req<{ pod: PodView }>(`/api/pods/${encodeURIComponent(id)}/orchestration`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  startPodOrchestration: (id: string, body: StartPodOrchestrationRequest) =>
    req<PodOrchestrationActionResult>(`/api/pods/${encodeURIComponent(id)}/orchestration/start`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  stopPodOrchestration: (id: string) =>
    req<{ pod: PodView }>(`/api/pods/${encodeURIComponent(id)}/orchestration/stop`, { method: "POST" }),

  reconcilePod: (id: string, body: ReconcilePodRequest) =>
    req<PodReconciliationActionResult>(`/api/pods/${encodeURIComponent(id)}/reconcile`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  relayPod: (id: string, body: RelayPodRequest) =>
    req<RelayPodResult>(`/api/pods/${encodeURIComponent(id)}/relay`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  closePod: (id: string) =>
    req<{ pod: PodView; sessions: SessionView[] }>(`/api/pods/${encodeURIComponent(id)}/close`, {
      method: "POST",
    }),

  workflowDefinitions: () => req<WorkflowDefinition[]>("/api/workflows"),

  workflowDefinition: (workflowId: string, version?: number) =>
    req<WorkflowDefinition>(`/api/workflows/${encodeURIComponent(workflowId)}${version ? `?version=${version}` : ""}`),

  createWorkflowDefinition: (body: CreateWorkflowDefinitionRequest) =>
    req<WorkflowDefinition>("/api/workflows", { method: "POST", body: JSON.stringify(body) }),

  createWorkflowDefinitionVersion: (workflowId: string, body: CreateWorkflowDefinitionRequest) =>
    req<WorkflowDefinition>(`/api/workflows/${encodeURIComponent(workflowId)}/versions`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  createWorkflowRun: (body: CreateWorkflowRunRequest) =>
    req<CreateWorkflowRunResult>("/api/workflow-runs", { method: "POST", body: JSON.stringify(body) }),

  workflowInstances: (runId?: string) =>
    req<WorkflowInstanceView[]>(`/api/workflow-instances${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`),

  workflowInstance: (instanceId: string) =>
    req<WorkflowInstanceDetail>(`/api/workflow-instances/${encodeURIComponent(instanceId)}`),

  dispatchWorkflowNode: (instanceId: string, nodeId: string, dispatchKey: string) =>
    req<DispatchWorkflowNodeResult>(
      `/api/workflow-instances/${encodeURIComponent(instanceId)}/nodes/${encodeURIComponent(nodeId)}/dispatch`,
      { method: "POST", body: JSON.stringify({ dispatchKey }) },
    ),

  resolveWorkflowGate: (instanceId: string, nodeId: string, outcome: "success" | "failure") =>
    req<WorkflowInstanceDetail>(
      `/api/workflow-instances/${encodeURIComponent(instanceId)}/nodes/${encodeURIComponent(nodeId)}/resolve`,
      { method: "POST", body: JSON.stringify({ outcome }) },
    ),

  createWorkflowArtifact: (body: CreateWorkflowArtifactRequest) =>
    req<WorkflowArtifact>(body.kind === "screenshot" ? "/api/artifacts/screenshots" : "/api/artifacts", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  workflowArtifact: (artifactId: string) =>
    req<WorkflowArtifact>(`/api/artifacts/${encodeURIComponent(artifactId)}`),

  artifactExport: (artifactId: string) => artifactExport(transport, artifactId),

  runWorkflowArtifacts: (runId: string, cursor?: string) =>
    req<WorkflowArtifactPage>(`/api/runs/${encodeURIComponent(runId)}/artifacts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),

  sessionWorkflowArtifacts: (sessionId: string, cursor?: string) =>
    req<WorkflowArtifactPage>(`/api/sessions/${encodeURIComponent(sessionId)}/artifacts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),

  rediscover: (runnerId: string) =>
    req<{ ok: true }>(`/api/runners/${encodeURIComponent(runnerId)}/rediscover`, { method: "POST" }),

  setAcpRegistryApproval: (
    runnerId: string,
    agentId: string,
    body: { action: "approve" | "revoke"; schemaVersion: string; adapterVersion: string; confirmation: "explicit" },
  ) => req<{ ok: true }>(
    `/api/runners/${encodeURIComponent(runnerId)}/acp-registry/${encodeURIComponent(agentId)}/approval`,
    { method: "POST", body: JSON.stringify(body) },
  ),

  removeRunner: (runnerId: string) =>
    req<void>(`/api/runners/${encodeURIComponent(runnerId)}`, { method: "DELETE" }),

  updateMachine: (runnerId: string, body: { displayName: string }) =>
    req<{ ok: true }>(`/api/runners/${encodeURIComponent(runnerId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  // Phase 3: external (CLI-started) sessions on a box.
  listExternalSessions: (runnerId: string, agentId?: string) =>
    req<{ sessions: ExternalSessionDescriptor[] }>(
      `/api/runners/${encodeURIComponent(runnerId)}/external-sessions${
        agentId ? `?${new URLSearchParams({ agentId }).toString()}` : ""
      }`,
    ),

  // Browse the runner machine's filesystem for the workspace picker.
  listDirectory: (runnerId: string, path: string, distro?: string) => {
    const qs = new URLSearchParams({ path });
    if (distro) qs.set("distro", distro);
    return req<{ path: string; parent: string | null; entries: DirectoryEntry[] }>(
      `/api/runners/${encodeURIComponent(runnerId)}/list-directory?${qs.toString()}`,
    );
  },

  // Files panel: browse / read files under a session's root (paths are root-relative).
  listSessionFiles: (sessionId: string, path: string) =>
    req<{ path: string; entries: SessionFileEntry[] }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/files?${new URLSearchParams({ path }).toString()}`,
    ),

  readSessionFile: (sessionId: string, path: string) =>
    req<{ path: string; content?: string; size?: number; truncated?: boolean; binary?: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/file?${new URLSearchParams({ path }).toString()}`,
    ),

  // Shells panel: durable metadata plus bounded sequence-addressed history.
  listShells: (sessionId: string) =>
    req<{ shells: ShellView[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/shells`),

  shellHistory: (sessionId: string, shellId: string, after = 0, limit = 200) =>
    req<ShellHistoryPage>(
      `/api/sessions/${encodeURIComponent(sessionId)}/shells/${encodeURIComponent(shellId)}/history?` +
      new URLSearchParams({ after: String(after), limit: String(limit) }).toString(),
    ),

  openShell: (sessionId: string, body?: { cols: number; rows: number; kind?: "shell" | "agent_tui" }) =>
    req<{ shell: ShellView }>(`/api/sessions/${encodeURIComponent(sessionId)}/shells`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),

  resizeShell: (sessionId: string, shellId: string, cols: number, rows: number) =>
    req<void>(
      `/api/sessions/${encodeURIComponent(sessionId)}/shells/${encodeURIComponent(shellId)}/resize`,
      { method: "POST", body: JSON.stringify({ cols, rows }) },
    ),

  shellInput: (sessionId: string, shellId: string, data: string) =>
    req<void>(
      `/api/sessions/${encodeURIComponent(sessionId)}/shells/${encodeURIComponent(shellId)}/input`,
      { method: "POST", body: JSON.stringify({ data }) },
    ),

  closeShell: (sessionId: string, shellId: string) =>
    req<void>(`/api/sessions/${encodeURIComponent(sessionId)}/shells/${encodeURIComponent(shellId)}`, {
      method: "DELETE",
    }),

  adoptSession: (runnerId: string, descriptor: ExternalSessionDescriptor, backfill = true) =>
    req<SessionView>("/api/sessions/adopt", {
      method: "POST",
      body: JSON.stringify({ runnerId, descriptor, backfill }),
    }),

  getOnboarding: () => req<OnboardingInfo>("/api/onboarding"),

  issueRunnerCredential: (runnerId: string, label?: string) =>
    req<RunnerCredentialSecret>("/api/runner-credentials", {
      method: "POST",
      body: JSON.stringify({ runnerId, label }),
    }),

  rotateRunnerCredential: (runnerId: string, label?: string) =>
    req<RunnerCredentialSecret>(`/api/runner-credentials/${encodeURIComponent(runnerId)}/rotate`, {
      method: "POST",
      body: JSON.stringify({ label }),
    }),

  listBoxes: () => req<{ boxes: BoxView[] }>("/api/boxes"),

  addBox: (body: AddBoxRequest) =>
    req<{ box: BoxView }>("/api/boxes", { method: "POST", body: JSON.stringify(body) }),

  /* Web Push (push-to-wake). The public key is what pushManager.subscribe() needs. */
  getVapidPublicKey: () => req<{ publicKey: string }>("/api/push/vapid-public-key"),
  subscribePush: (body: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    req<{ ok: true }>("/api/push/subscriptions", { method: "POST", body: JSON.stringify(body) }),
  unsubscribePush: (endpoint: string) =>
    req<void>("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) }),

  /* Paired devices (revocable bearer credentials for dashboards). */
  listDevices: () => req<{ devices: DeviceView[] }>("/api/devices"),
  /** Loopback-only: mints a device token, returned exactly once, plus whether a clickable
   * pairing link can work here (bundle served + bound beyond loopback). */
  pairDevice: (name: string, userId?: string) =>
    req<{
      device: DeviceView;
      token: string;
      pairing: { hosts: string[]; port: number; webServed: boolean; boundBeyondLoopback: boolean };
    }>("/api/devices", { method: "POST", body: JSON.stringify({ name, userId }) }),
  revokeDevice: (deviceId: string) => req<void>(`/api/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" }),

  getIdentity: () => req<IdentityAdministrationView>("/api/identity"),
  createIdentityMember: (body: { displayName: string; role: OrganizationRole }) =>
    req<{ membership: OrganizationMembershipView }>("/api/identity/users", { method: "POST", body: JSON.stringify(body) }),
  updateIdentityMember: (userId: string, body: { displayName?: string; role?: OrganizationRole; status?: UserStatus }) =>
    req<{ membership: OrganizationMembershipView }>(`/api/identity/users/${encodeURIComponent(userId)}`, {
      method: "PATCH", body: JSON.stringify(body),
    }),
  createIdentityTeam: (body: { name: string; memberUserIds: string[] }) =>
    req<{ team: TeamView }>("/api/identity/teams", { method: "POST", body: JSON.stringify(body) }),
  updateIdentityTeamMembers: (teamId: string, memberUserIds: string[]) =>
    req<{ team: TeamView }>(`/api/identity/teams/${encodeURIComponent(teamId)}/members`, {
      method: "PUT", body: JSON.stringify({ memberUserIds }),
    }),
  deleteIdentityTeam: (teamId: string) =>
    req<void>(`/api/identity/teams/${encodeURIComponent(teamId)}`, { method: "DELETE" }),
  listMutationAudit: (limit = 100) =>
    req<{ audit: MutationAuditView[] }>(`/api/identity/mutation-audit?limit=${limit}`),

  /** Resolve the dashboard's exact runner artifact. Identical content is a no-op; otherwise the
   * response identifies the deployment that has started and live box status carries progress. */
  updateBoxRunner: (boxId: string, force = false) =>
    req<{
      ok: true;
      status: "already_current" | "started" | "superseded";
      forced?: boolean;
      expectedVersion: string;
      source: "staged" | "release-cache";
      triple: string;
      releaseTag: string;
    }>(`/api/boxes/${encodeURIComponent(boxId)}/update-runner`, {
      method: "POST",
      body: JSON.stringify({ force }),
    }),

  reconnectBox: (boxId: string, force = false) =>
    req<{ ok: true; forced?: boolean }>(`/api/boxes/${encodeURIComponent(boxId)}/reconnect`, {
      method: "POST",
      body: JSON.stringify({ force }),
    }),

  adoptLegacyBoxData: (boxId: string, force = false) =>
    req<{ ok: true; status: "started"; forced?: boolean }>(
      `/api/boxes/${encodeURIComponent(boxId)}/adopt-legacy-data-dir`,
      {
        method: "POST",
        body: JSON.stringify({ force, acknowledgeAllLegacyRunnersStopped: true }),
      },
    ),

  removeBox: (boxId: string) => req<void>(`/api/boxes/${encodeURIComponent(boxId)}`, { method: "DELETE" }),

  sshConfigHosts: () => req<{ hosts: SshConfigHost[] }>("/api/ssh-config-hosts"),

  git: (id: string, body: GitActionRequest) =>
    req<GitActionData>(`/api/sessions/${id}/git`, { method: "POST", body: JSON.stringify(body) }),

  // Phase 2: fetch a parsed diff for the given scope (uncommitted / all_branch / last_turn).
  gitDiff: (id: string, scope: GitDiffScope) =>
    req<GitActionData>(`/api/sessions/${id}/git`, {
      method: "POST",
      body: JSON.stringify({ action: "diff", scope } satisfies GitActionRequest),
    }) as Promise<{ diff: GitDiffInfo }>,

  // Pinned summary: one read for branch/ahead-behind/line totals + the gh PR + its checks.
  gitSummary: (id: string) => req<GitActionData>(`/api/sessions/${id}/git`, {
    method: "POST",
    body: JSON.stringify({ action: "summary" } satisfies GitActionRequest),
  }) as Promise<{ summary: GitSummaryInfo }>,

  // Host actions on the session's runner: open the working dir in a local editor / file manager.
  hostAction: (id: string, body: HostAction) =>
    req<{ ok: true }>(`/api/sessions/${id}/host-action`, { method: "POST", body: JSON.stringify(body) }),

  // Project menu: reveal a workspace root in the runner host's file manager.
  revealWorkspace: (runnerId: string, path: string) =>
    req<{ ok: true }>(`/api/runners/${encodeURIComponent(runnerId)}/host-action`, {
      method: "POST",
      body: JSON.stringify({ kind: "reveal", path }),
    }),

  // Workspace chip: create a project (CP-owned workspace; survives runner re-registers).
  createWorkspace: (runnerId: string, body: { name: string; path: string }) =>
    req<{ workspace: WorkspaceInfo }>(`/api/runners/${encodeURIComponent(runnerId)}/workspaces`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  registerMachineWorkspace: (runnerId: string, body: { name: string; path: string }) =>
    req<{ workspace: WorkspaceInfo }>(
      `/api/runners/${encodeURIComponent(runnerId)}/workspaces/register`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  // Project menu: rename a workspace (CP-owned display-name override; empty name resets).
  renameWorkspace: (runnerId: string, workspaceId: string, name: string) =>
    req<{ ok: true }>(
      `/api/runners/${encodeURIComponent(runnerId)}/workspaces/${encodeURIComponent(workspaceId)}/rename`,
      { method: "POST", body: JSON.stringify({ name }) },
    ),

  // Phase 2 PR-B: stage/unstage one hunk against the exact diff the pane shows (diffHash).
  // Success returns a fresh {status, diff} in the same round trip.
  gitStageHunk: (id: string, body: { direction: "stage" | "unstage"; filePath: string; hunkIndex: number; diffHash: string }) =>
    req<GitActionData>(`/api/sessions/${id}/git`, {
      method: "POST",
      body: JSON.stringify({ action: "stage_hunk", ...body } satisfies GitActionRequest),
    }),

  gitStageLines: (id: string, body: {
    direction: "stage" | "unstage";
    filePath: string;
    hunkIndex: number;
    lineIndices: number[];
    diffHash: string;
  }) => req<GitActionData>(`/api/sessions/${id}/git`, {
    method: "POST",
    body: JSON.stringify({ action: "stage_lines", ...body } satisfies GitActionRequest),
  }),

  gitDiscardFile: (id: string, body: { filePath: string; diffHash: string }) =>
    req<GitActionData>(`/api/sessions/${id}/git`, {
      method: "POST",
      body: JSON.stringify({ action: "discard_file", ...body } satisfies GitActionRequest),
    }),
  };
  return client;
}

export type ApiClient = ReturnType<typeof createApiClient>;

const defaultApiTransport = createBrowserApiTransport({
  instanceId: "local",
  origin: CONTROL_PLANE_HTTP,
  token: deviceToken,
});

/** The compatibility client used until the desktop instance provider supplies a scoped client. */
export const api = createApiClient(defaultApiTransport);
