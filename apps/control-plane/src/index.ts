/**
 * Control plane: routes UI commands to runners, ingests runner events, persists
 * everything, and streams live updates to the UI.
 */

import os from "node:os";
import { writeSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import {
  AUTOMATION_TRIGGER_MAX_BODY_BYTES,
  registerAutomationTriggerContentTypeParser,
} from "./automation-trigger-ingress.js";
import {
  PROTOCOL_VERSION,
  POLICY_HOOK_POLL_CAPABILITY,
  parseMessage,
  CONTROL_PLANE_SERVICE,
  providerSupportsConversationFork,
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type AddBoxRequest,
  type AccessScopeChangePreview,
  type AddPodMemberRequest,
  type AppendPodContextRequest,
  type ApprovalQueueRejectRequest,
  type ExternalSessionDescriptor,
  type ApproveRequest,
  type ControlPlaneToRunner,
  type CreatePodRequest,
  type CreateRunRequest,
  type CreateAutomationRequest,
  type CreateAutomationTriggerRequest,
  type CreateWorkflowDefinitionRequest,
  type CreateWorkflowDefinitionVersionRequest,
  type CreateWorkflowInstanceRequest,
  type CreateWorkflowRunRequest,
  type CompleteWorkflowAttemptRequest,
  type DispatchWorkflowNodeRequest,
  type CreateWorkflowArtifactRequest,
  type CreateSessionRequest,
  type CreateProjectRequest,
  type UpdateProjectRequest,
  type AddProjectLocationRequest,
  type CreateProjectLocationRequest,
  type MoveProjectLocationRequest,
  type GitActionRequest,
  type GovernancePolicy,
  type OnboardingInfo,
  type OrganizationRole,
  type ResourceOwner,
  type ResourceScope,
  type SessionView,
  type ShellView,
  type UserStatus,
  type PromptRequest,
  type InvokeSessionCommandRequest,
  type SteerRequest,
  type RelayPodRequest,
  type ReconcilePodRequest,
  type RunnerToControlPlane,
  type RunnerProtocolCapability,
  type ResolveWorkflowGateRequest,
  type SetArchivedRequest,
  type SetColumnRequest,
  type SetSessionTitleRequest,
  type SetWorkspaceRequest,
  type SetProjectRequest,
  type StartPodOrchestrationRequest,
  type UpdatePodMemberRequest,
  type UpdatePodOrchestrationRequest,
  type UpdateAutomationRequest,
} from "@wollipog/protocol";
import {
  nativeTuiCreationError,
  nativeTuiSessionError,
  openNativeTuiAtomically,
} from "./native-tui-launch.js";
import {
  carriesTokenParam,
  extractBearer,
  hashToken,
  isAuthenticatedConductorClaim,
  isAuthenticatedPolicyHookClaim,
  isConductorApiRouteAllowed,
  isPolicyHookApiRouteAllowed,
  isTrustedLoopback,
  newDeviceToken,
  redactTokenInUrl,
  requiresDeviceAuth,
  shouldTouchDevice,
  tokenMatchesHash,
} from "./auth.js";
import { reconcilePolicyHooksSafely } from "./policy-hook-maintenance.js";
import {
  LEGACY_CONDUCTOR_ACTOR_SESSION_HEADER,
  LEGACY_POLICY_HOOK_POLL_CAPABILITY_HEADER,
  LEGACY_POLICY_HOOK_SESSION_HEADER,
  selectAutomationTriggerHeaders,
  selectCompatibleHeader,
  WOLLIPOG_CONDUCTOR_ACTOR_SESSION_HEADER,
  WOLLIPOG_POLICY_HOOK_POLL_CAPABILITY_HEADER,
  WOLLIPOG_POLICY_HOOK_SESSION_HEADER,
} from "./wire-compat.js";
import {
  loadOrCreateLocalDeviceToken,
  readLocalDeviceToken,
  localDeviceTokenPath,
  localPairingUrl,
} from "./local-device-credential.js";
import { BoxOrchestrator, makeBinaryResolver, managedBoxRunnerDataDir } from "./box-orchestrator.js";
import {
  decideScopedBoxLifecycle,
  parseBoxLifecycleForce,
} from "./box-lifecycle.js";
import { registerBoxLegacyAdoptionRoute } from "./box-legacy-adoption-route.js";
import { RUNNER_RELEASE_TAG } from "./release-version.js";
import { readSshConfigHosts } from "./ssh-config.js";
import { ControlPlaneDb, GOVERNANCE_AUDIT_RETENTION_MS } from "./db.js";
import { registerSessionLookupRoute } from "./session-lookup-route.js";
import {
  canAssignSessionProject,
  resolveSessionCreationOwnership,
} from "./session-creation-route.js";
import { registerInstanceRoute } from "./instance-route.js";
import {
  gitActionAllowed,
  gitActionCapability,
  gitActionRequiresLinkedWorktree,
  parseGitAction,
} from "./git-route.js";
import { editorAdvertisesLocation, parseSessionHostAction } from "./host-actions.js";
import { validateGitHubReviewSync } from "./review-findings.js";
import { Hub, isRunnerRequestTimeoutError } from "./hub.js";
import {
  buildRunnerWsUrl,
  isAllowedOrigin,
  isLoopback,
  isLoopbackBindHost,
  isTailnetOrLoopbackConnection,
  pairingHosts,
  tailnetIpv4,
} from "./net.js";
import {
  SESSION_COMMAND_INVOCATION_RETENTION_MS,
  sessionBlocksConversationFork,
  SessionsService,
} from "./sessions.js";
import { ShellRegistry } from "./shell-registry.js";
import { registerAuthGate } from "./http-auth.js";
import { pushDecision } from "./push-decision.js";
import { validateSubscription, WebPushSender } from "./web-push.js";
import {
  injectSameOriginMarker,
  readWebIndexHtml,
  isIndexHtmlPath,
  isSpaNavigation,
  resolveWebDist,
  shouldCacheWebIndex,
} from "./web-dist.js";
import { normalizeDriverTelemetry, telemetryWindowDays } from "./driver-telemetry.js";
import { registerUsageRoutes } from "./usage-routes.js";
import { validateRegistryApproval, type RegistryApprovalInput } from "./registry-approval.js";
import { AutomationsService } from "./automations.js";
import { buildAuthorizedSessionTranscriptExport, type TranscriptExportFormat } from "./session-exports.js";
import { principalCanReadWorkflowArtifact } from "./artifact-exports.js";
import { registerWorkflowArtifactExportRoute } from "./artifact-export-route.js";
import { registerRunnerCredentialRoutes } from "./runner-credential-route.js";
import { registerPromptImageRoutes } from "./prompt-image-route.js";
import {
  makeManagedBoxRunnerCredentialIssuer,
  makeManagedDesktopRunnerCredentialIssuer,
  markLegacyRunnerCredentialWarning,
} from "./runner-credentials.js";
import { takeManagedDesktopIdentity } from "./managed-desktop-auth.js";
import {
  managedDesktopSessionsForRunner,
  registerManagedDesktopRoutes,
} from "./managed-desktop-routes.js";
import {
  createAuthorizedTranscriptShare,
  listAuthorizedTranscriptShares,
  revokeAuthorizedTranscriptShare,
} from "./transcript-shares.js";
import { registerPublicTranscriptShareRoute } from "./transcript-share-route.js";
import { scopeAudienceContained } from "./resource-scope.js";
import {
  MAX_UI_CLIENT_MESSAGE_BYTES,
  normalizeUiClientRawData,
  parseUiClientMessage,
} from "./ui-channel.js";
import {
  agentDelegationAuthorizationError,
  boundedTargetId,
  forkProjectAssignment,
  forkSnapshotIdentityError,
  providerForkCleanupTarget,
  providerForkSnapshotIdError,
  canAdministerIdentity,
  isMutationMethod,
  PERSONAL_ORGANIZATION_ID,
  mutationAuthorizationError,
  type AuthPrincipal,
  type HumanPrincipal,
} from "./identity.js";

// Consume inherited launch material before initialization can create any descendants.
const MANAGED_DESKTOP_IDENTITY = takeManagedDesktopIdentity();
const PORT = Number(process.env.CONTROL_PLANE_PORT ?? 4317);
const HOST = process.env.CONTROL_PLANE_HOST ?? "127.0.0.1";
const TAILNET_ONLY = process.env.CONTROL_PLANE_TAILNET_ONLY === "1";
const TOKEN = process.env.CONTROL_PLANE_TOKEN ?? "dev-local-token";
const DB_PATH = process.env.CONTROL_PLANE_DB ?? "data/control-plane.db";
const ARTIFACT_BLOB_DIR = process.env.CONTROL_PLANE_ARTIFACT_DIR;
const HEARTBEAT_INTERVAL_MS = Number(process.env.CONTROL_PLANE_HEARTBEAT_MS ?? 10_000);
const LOCAL_DEVICE_TOKEN_PATH = localDeviceTokenPath(DB_PATH);

// Recovery is read-only: wrong coordinates must fail loudly instead of minting a plausible but
// unusable owner credential. Synchronous fd writes make the one-line contract flush-safe on Windows.
if (process.argv.includes("--print-pair-url")) {
  try {
    const token = readLocalDeviceToken(LOCAL_DEVICE_TOKEN_PATH);
    writeSync(1, `${localPairingUrl(PORT, token)}\n`);
    process.exit(0);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeSync(
      2,
      `[control-plane] could not print the local pairing URL from ${LOCAL_DEVICE_TOKEN_PATH}: ${detail}. ` +
        "Start the control plane once with the same database coordinates first.\n",
    );
    process.exit(1);
  }
}

const LOCAL_DEVICE_TOKEN = (() => {
  try {
    return loadOrCreateLocalDeviceToken(LOCAL_DEVICE_TOKEN_PATH);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeSync(2, `[control-plane] could not load the local device credential at ${LOCAL_DEVICE_TOKEN_PATH}: ${detail}\n`);
    process.exit(1);
  }
})();
const LOCAL_DEVICE_TOKEN_HASH = hashToken(LOCAL_DEVICE_TOKEN);
const LOCAL_PAIRING_URL = localPairingUrl(PORT, LOCAL_DEVICE_TOKEN);

const db = ControlPlaneDb.open(DB_PATH, ARTIFACT_BLOB_DIR ? { artifactBlobDir: ARTIFACT_BLOB_DIR } : {});
const legacyCredentialMigration = db.backfillLegacyRunnerCredentials(hashToken(TOKEN), Date.now());
if (legacyCredentialMigration.blocked > 0) {
  console.warn(
    `[control-plane] refused to copy the legacy fleet token across ${legacyCredentialMigration.blocked} runners; ` +
      "issue runner-specific credentials before reconnecting them",
  );
}
db.scrubLegacyAgentSecrets(Date.now());
const hub = new Hub(db);
const shellRegistry = new ShellRegistry(db);
shellRegistry.reconcileStartup(Date.now());
// Larger body limit so pasted screenshots (base64) fit comfortably.
const app = Fastify({
  bodyLimit: 32 * 1024 * 1024,
  logger: {
    // /ui carries the device token as ?token= (browsers can't set WS headers). Redact it from
    // the request-log URL so a reusable credential never lands in the logs.
    serializers: {
      req(req: { method: string; url: string }) {
        return { method: req.method, url: redactTokenInUrl(req.url) };
      },
    },
  },
});
const warnedLegacyRunnerCredentialIds = new Set<string>();

// The packaged desktop's "Enable Tailnet Access" setting binds the sidecar to IPv4 wildcard so
// its local Tauri UI can keep using 127.0.0.1 while browsers use the machine's Tailscale address.
// Fail closed before static serving, REST auth, or either WebSocket channel: a non-loopback request
// is accepted only when BOTH socket endpoints are in Tailscale's 100.64.0.0/10 range. Forwarding
// headers are deliberately ignored, so a LAN peer cannot claim a tailnet address.
if (TAILNET_ONLY) {
  app.addHook("onRequest", async (req, reply) => {
    if (isTailnetOrLoopbackConnection(req.ip, req.raw.socket.localAddress)) return;
    return reply.code(403).send({ error: "tailnet access only" });
  });
}

// Tolerate empty bodies on action endpoints (POST /stop etc.) that send
// `content-type: application/json` with no payload — default parser 400/415s.
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
  const text = (body as string).trim();
  if (!text) return done(null, {});
  try {
    done(null, JSON.parse(text));
  } catch (err) {
    (err as { statusCode?: number }).statusCode = 400;
    done(err as Error, undefined);
  }
});


// Signed automation ingress uses the exact raw bytes. Re-serializing parsed JSON would make the
// signature depend on key order/whitespace chosen by the control plane instead of the sender.
registerAutomationTriggerContentTypeParser(app);

const requestPrincipals = new WeakMap<object, AuthPrincipal>();
const requestMutationAudits = new WeakMap<object, string>();

/**
 * The device a request's token authenticates, or null. `allowQueryToken` is true ONLY for the
 * /ui WebSocket (browsers can't set headers on a WS upgrade); REST accepts the bearer header
 * only, so tokens never ride REST URLs into logs/history/proxies. Touches last_seen (throttled).
 */
function authedDevice(
  req: { headers: { authorization?: string }; url: string },
  allowQueryToken = false,
): { id: string; name: string; principal: HumanPrincipal } | null {
  let token = extractBearer(req.headers.authorization);
  if (!token && allowQueryToken && req.url.includes("?")) {
    token = new URLSearchParams(req.url.slice(req.url.indexOf("?") + 1)).get("token");
  }
  if (!token) return null;
  const device = db.deviceByTokenHash(hashToken(token));
  if (!device) return null;
  const now = Date.now();
  if (shouldTouchDevice(device.lastSeenAt, now)) db.touchDevice(device.id, now);
  return {
    id: device.id,
    name: device.name,
    principal: {
      kind: "human",
      actorId: device.userId,
      userId: device.userId,
      userName: device.userName,
      organizationId: device.organizationId,
      organizationName: device.organizationName,
      role: device.role,
      deviceId: device.id,
      localBootstrap: false,
    },
  };
}

/** The protected startup credential represents the personal bootstrap owner, but only over a
 * direct trusted-loopback connection. A terminal-scrollback or file leak therefore cannot turn
 * into remote owner access when the control plane is bound beyond loopback. */
function authedLocalBootstrap(
  req: { ip: string; headers: { authorization?: string; [key: string]: unknown }; url: string },
  allowQueryToken = false,
): { id: string; name: string; principal: HumanPrincipal } | null {
  if (!trustedLoopback(req)) return null;
  let token = extractBearer(req.headers.authorization);
  if (!token && allowQueryToken && req.url.includes("?")) {
    token = new URLSearchParams(req.url.slice(req.url.indexOf("?") + 1)).get("token");
  }
  return token && tokenMatchesHash(token, LOCAL_DEVICE_TOKEN_HASH) ? localApiPrincipal() : null;
}

/** Resolve the exact live conductor whose sidecar presented its runner's active credential. The
 * session claim and exact runner binding prevent that secret from becoming an unscoped REST token. */
function authedConductor(req: { headers: { authorization?: string; [key: string]: unknown } }) {
  const selected = selectCompatibleHeader(
    req.headers,
    WOLLIPOG_CONDUCTOR_ACTOR_SESSION_HEADER,
    LEGACY_CONDUCTOR_ACTOR_SESSION_HEADER,
  );
  const claimed = selected.ok ? selected.value : undefined;
  const session = typeof claimed === "string" && claimed.length <= 256 ? db.getSession(claimed) : null;
  const bearer = extractBearer(req.headers.authorization);
  return isAuthenticatedConductorClaim({
    credentialValid: Boolean(session && bearer && db.verifyActiveRunnerCredential(session.runnerId, hashToken(bearer))),
    claimedSessionId: claimed,
    session,
  }) ? session : null;
}

/** Resolve one live Claude session whose hook sidecar presented its independently bound token. */
function authedPolicyHook(req: { headers: { authorization?: string; [key: string]: unknown } }) {
  const selected = selectCompatibleHeader(
    req.headers,
    WOLLIPOG_POLICY_HOOK_SESSION_HEADER,
    LEGACY_POLICY_HOOK_SESSION_HEADER,
  );
  const claimed = selected.ok ? selected.value : undefined;
  const session = typeof claimed === "string" && claimed.length <= 256 ? db.getSession(claimed) : null;
  const bearer = extractBearer(req.headers.authorization);
  return isAuthenticatedPolicyHookClaim({
    credentialValid: Boolean(session && bearer &&
      db.policyHookCredentialValid(session.id, session.runnerId, hashToken(bearer))),
    claimedSessionId: claimed,
    session,
  }) ? session : null;
}

/** The HTTP gate accepts paired devices and narrowly authenticated runner sidecars. */
function authedApiPrincipal(
  req: {
    headers: { authorization?: string; [key: string]: unknown };
    ip: string;
    method: string;
    routeOptions?: { url?: string };
    url: string;
  },
  allowQueryToken = false,
): { id: string; name: string; principal: AuthPrincipal } | null {
  const local = authedLocalBootstrap(req, allowQueryToken);
  if (local) return local;
  const routePath = req.routeOptions?.url ?? req.url.split("?")[0] ?? "";
  const policyHook = authedPolicyHook(req);
  if (policyHook && isPolicyHookApiRouteAllowed(req.method, routePath)) {
    const delegatedScope = db.sessionScope(policyHook.id);
    if (!delegatedScope) return null;
    return {
      id: policyHook.id,
      name: policyHook.agentName ?? "Claude Hook",
      principal: {
        kind: "agent",
        actorId: policyHook.id,
        organizationId: delegatedScope.organizationId,
        delegatedScope,
      },
    };
  }
  const conductor = authedConductor(req);
  if (conductor && isConductorApiRouteAllowed(req.method, routePath)) {
    const delegatedScope = db.sessionScope(conductor.id);
    if (!delegatedScope) return null;
    return {
      id: conductor.id,
      name: conductor.agentName ?? "Conductor",
      principal: {
        kind: "agent",
        actorId: conductor.id,
        organizationId: delegatedScope.organizationId,
        delegatedScope,
      },
    };
  }
  return authedDevice(req, allowQueryToken);
}

function localApiPrincipal(): { id: string; name: string; principal: HumanPrincipal } {
  const context = db.localIdentityContext();
  return {
    id: context.userId,
    name: context.userName,
    principal: { kind: "human", actorId: context.userId, ...context },
  };
}

function requestPrincipal(req: FastifyRequest, allowQueryToken = false): AuthPrincipal | null {
  const authenticated = authedApiPrincipal(req, allowQueryToken);
  return authenticated?.principal ?? null;
}

function requestHuman(req: FastifyRequest): HumanPrincipal | null {
  const principal = requestPrincipal(req);
  return principal?.kind === "human" ? principal : null;
}

function humanActorId(req: FastifyRequest): string {
  return requestHuman(req)?.userId ?? db.localIdentityContext().userId;
}

/** Attribute workflow mutations from the authenticated conductor MCP sidecar to its exact
 * session. The claim is accepted only with the runner/control-plane token and a live persisted
 * conductor session; ordinary device calls retain paired-device provenance. */
function workflowActor(req: { headers: { authorization?: string; [key: string]: unknown }; url: string }) {
  const conductor = authedConductor(req);
  if (conductor) return { kind: "agent" as const, id: conductor.id };
  const device = authedDevice(req);
  return { kind: "human" as const, id: device?.principal.userId ?? db.localIdentityContext().userId };
}

/** Automation definitions are operator-owned. Conductor credentials never gain schedule-write
 * attribution; paired devices retain their exact id and authenticated bootstrap remains `local`. */
function automationActor(req: { headers: { authorization?: string; [key: string]: unknown }; url: string }) {
  const device = authedDevice(req);
  return { kind: "human" as const, id: device?.principal.userId ?? db.localIdentityContext().userId };
}

/** True for a loopback request NOT arriving through a reverse proxy (which would spoof the peer
 * IP to 127.0.0.1). See auth.isTrustedLoopback. */
function trustedLoopback(req: { ip: string; headers: Record<string, unknown> }): boolean {
  return isTrustedLoopback(req.ip, req.headers, isLoopback);
}

function authorizeApiRequest(req: FastifyRequest, authenticated: { principal?: AuthPrincipal } | null) {
  const principal = authenticated?.principal ?? null;
  if (principal) requestPrincipals.set(req, principal);
  const routePath = req.routeOptions?.url ?? req.url.split("?")[0] ?? "";
  const mutationError = mutationAuthorizationError(req.method, routePath, principal);
  if (mutationError) return mutationError;
  if (!principal) return null;

  const memberScopedRoute = routePath === "/api/instance" || routePath === "/api/identity" || routePath === "/api/runners" ||
    routePath === "/api/projects" || routePath.startsWith("/api/projects/") ||
    routePath === "/api/sessions" || routePath.startsWith("/api/sessions/") ||
    routePath === "/api/usage" || routePath === "/api/usage/retention" ||
    routePath === "/api/push/vapid-public-key" || routePath === "/api/push/subscriptions" ||
    routePath === "/api/push/unsubscribe" ||
    routePath === "/api/artifacts/:artifactId/export" ||
    routePath === "/api/runners/:runnerId/host-action" ||
    routePath === "/api/runners/:runnerId/workspaces/:workspaceId/rename" ||
    routePath === "/api/runners/:runnerId/workspaces/:workspaceId/access-scope";
  const organizationAdminRoute = routePath === "/api/identity" || routePath.startsWith("/api/identity/") ||
    routePath === "/api/runner-credentials" || routePath.startsWith("/api/runner-credentials/") ||
    routePath === "/api/devices" || routePath.startsWith("/api/devices/");
  const organizationAdmin = principal.kind === "human" && (principal.role === "owner" || principal.role === "admin");
  if (principal.kind === "human") {
    if (!organizationAdmin && req.method === "POST" && routePath === "/api/projects/:id/locations/new") {
      return "organization owner or admin permission is required to register an arbitrary host path";
    }
    if (!organizationAdmin && !memberScopedRoute) {
      return "organization owner or admin permission is required for this global resource";
    }
    if (organizationAdmin && !memberScopedRoute && !organizationAdminRoute &&
        principal.organizationId !== PERSONAL_ORGANIZATION_ID) {
      return "this global resource belongs to the personal control-plane organization";
    }
    if (!organizationAdmin && routePath === "/api/sessions/adopt") {
      return "organization owner or admin permission is required to adopt unscoped provider sessions";
    }
  }
  if (principal.kind === "agent") {
    const delegationError = agentDelegationAuthorizationError(routePath, principal);
    if (delegationError) return delegationError;
  }

  const params = (req.params ?? {}) as Record<string, unknown>;
  const sessionId = typeof params.id === "string" && routePath.startsWith("/api/sessions/") ? params.id
    : typeof params.sessionId === "string" ? params.sessionId : null;
  if (sessionId && !db.canAccessSession(principal, sessionId)) {
    return { statusCode: 404, error: "session not found" };
  }
  const runnerId = typeof params.runnerId === "string" ? params.runnerId
    : typeof params.id === "string" && routePath.startsWith("/api/runners/") ? params.id : null;
  if (runnerId) {
    const credentialRoute = routePath.startsWith("/api/runner-credentials/");
    const accessible = credentialRoute
      ? db.runnerCredentialScope(runnerId)?.organizationId === principal.organizationId
      : db.canAccessRunner(principal, runnerId);
    if (!accessible) return { statusCode: 404, error: "runner not found" };
  }
  const workspaceId = typeof params.workspaceId === "string" ? params.workspaceId : null;
  if (runnerId && workspaceId && !db.canAccessWorkspace(principal, runnerId, workspaceId)) {
    return { statusCode: 404, error: "workspace not found" };
  }
  if (routePath === "/api/artifacts/:artifactId/export") {
    const artifactId = typeof params.artifactId === "string" ? params.artifactId : "";
    const scope = artifactId ? db.workflowArtifactScope(artifactId) : null;
    if (!scope || !principalCanReadWorkflowArtifact(db, principal, scope)) {
      return { statusCode: 404, error: "artifact not found" };
    }
  }
  if (routePath === "/api/sessions" && req.method === "POST") {
    const body = (req.body ?? {}) as { runnerId?: unknown; workspaceId?: unknown; workspacePath?: unknown };
    if (principal.kind === "human" && !organizationAdmin &&
        typeof body.workspacePath === "string" && body.workspacePath.trim()) {
      return "organization owner or admin permission is required to start a session from an arbitrary host path";
    }
    if (typeof body.runnerId !== "string" || !db.canAccessRunner(principal, body.runnerId)) {
      return { statusCode: 404, error: "runner not found" };
    }
    if (typeof body.workspaceId === "string" && !body.workspacePath &&
        !db.canAccessWorkspace(principal, body.runnerId, body.workspaceId)) {
      return { statusCode: 404, error: "workspace not found" };
    }
  }
  if (routePath === "/api/sessions/adopt" && req.method === "POST") {
    const runnerId = (req.body as { runnerId?: unknown })?.runnerId;
    if (typeof runnerId !== "string" || !db.canAccessRunner(principal, runnerId)) {
      return { statusCode: 404, error: "runner not found" };
    }
  }
  if (routePath === "/api/sessions/:id/workspace" && sessionId) {
    const session = db.getSession(sessionId);
    const workspaceId = (req.body as { workspaceId?: unknown })?.workspaceId;
    if (session && typeof workspaceId === "string" && !db.canAccessWorkspace(principal, session.runnerId, workspaceId)) {
      return { statusCode: 404, error: "workspace not found" };
    }
  }
  return null;
}

// Per-device bearer auth + CSRF Origin gate for the UI-facing surface. The policy lives in
// http-auth.ts so it can be regression-tested with app.inject against real Fastify routing.
registerAuthGate(app, {
  authenticate: authedApiPrincipal,
  isAllowedOrigin,
  authorize: authorizeApiRequest,
});

// Persist an intent before authorized handlers run so an abrupt process exit cannot leave a
// successful mutation entirely unattributed. Denied requests do not reach this hook and are
// inserted by onResponse instead. Bodies, queries, headers, and tokens are never recorded.
app.addHook("preHandler", async (req) => {
  const route = req.routeOptions?.url ?? req.url.split("?")[0] ?? "";
  if (!isMutationMethod(req.method) || !(route === "/api" || route.startsWith("/api/"))) return;
  const auditId = `mut_${randomUUID().replace(/-/g, "")}`;
  db.recordMutationAudit({
    auditId,
    principal: requestPrincipals.get(req) ?? requestPrincipal(req),
    method: req.method,
    route,
    targetId: boundedTargetId(req.params),
    statusCode: 0,
    now: Date.now(),
  });
  requestMutationAudits.set(req, auditId);
});

// Complete authorized intents and append content-free attribution for attempts rejected by an
// earlier auth hook. A status of 0 therefore means the process ended while the handler ran.
app.addHook("onResponse", async (req, reply) => {
  const route = req.routeOptions?.url ?? req.url.split("?")[0] ?? "";
  if (!isMutationMethod(req.method) || !(route === "/api" || route.startsWith("/api/"))) return;
  try {
    const auditId = requestMutationAudits.get(req);
    if (auditId) {
      db.completeMutationAudit(auditId, reply.statusCode);
      return;
    }
    // Only audit a principal captured by the authorization hook. In particular, a rejected
    // unauthenticated request may have a loopback peer, but it never passed the auth gate and must
    // not be attributed to (or allowed to churn the audit history of) the local owner.
    const principal = requestPrincipals.get(req);
    if (!principal) return; // unauthenticated network noise is not an attributable actor
    db.recordMutationAudit({
      auditId: `mut_${randomUUID().replace(/-/g, "")}`,
      principal,
      method: req.method,
      route,
      targetId: boundedTargetId(req.params),
      statusCode: reply.statusCode,
      now: Date.now(),
    });
  } catch (error) {
    req.log.error({ error: error instanceof Error ? error.message : String(error) }, "mutation audit write failed");
  }
});

/* ----------------------------- Static web app ----------------------------- */

// Serve the built dashboard from the control plane's own origin when a bundle is present. This
// is what makes a single `http://<host>:<port>/#pair=<token>` link work on a phone: same-origin
// REST + /ui (no CORS), and the fragment never reaches the server. Absent bundle → API-only.
//
// SECURITY INVARIANT: every sensitive route is an EXPLICIT `/api/...` (or `/ui`, `/runner`)
// route, and Fastify prefers explicit routes over this plugin's wildcard. So the wildcard can
// only ever serve files under webDist (traversal-guarded by @fastify/static) or the public app
// shell — it can never reach a mutating handler with `routeOptions.url === "/*"` and thus skip
// the device-auth gate above.
const webDist = resolveWebDist();
if (webDist) {
  // `allowedPath` refuses EVERY spelling of the entry document (`/INDEX.HTML`, `//index.html`,
  // `/./index.html`, `/index.html/` …). An explicit `/index.html` route only beats the wildcard
  // for that exact string; the rest would otherwise be served raw off disk — unmarked — and a
  // phone opening one would point its API calls at itself. Refused paths fall through to the
  // notFound handler, which renders the marked shell.
  app.register(fastifyStatic, {
    root: webDist,
    prefix: "/",
    index: false,
    allowedPath: (pathname) => !isIndexHtmlPath(pathname),
  });
  app.log.info(`serving the web app from ${webDist}`);
} else {
  app.log.info("no web bundle found (run `pnpm --filter @wollipog/web build`) — serving the API only");
}

/** The app shell with the same-origin marker injected. Packaged assets are cached; watched source builds reload. */
const cacheWebIndex = shouldCacheWebIndex(process.execPath, process.env.npm_lifecycle_event);
let cachedIndexHtml: string | null = null;
function indexHtml(): string | null {
  if (!webDist) return null;
  if (cachedIndexHtml !== null && cacheWebIndex) return cachedIndexHtml;
  cachedIndexHtml = readWebIndexHtml(webDist, cachedIndexHtml);
  return cachedIndexHtml;
}

// Fastify's DEFAULT 404 log line is built from the raw request URL, outside the request-log
// serializer — so a mistyped `/ui/?token=…` (route miss) would leak the token to logs. A custom
// handler that logs the REDACTED url closes that path (the serializer covers matched routes).
// It doubles as the SPA fallback: unknown client-side routes render the app shell.
app.setNotFoundHandler((req, reply) => {
  const rawUrl = req.raw.url ?? "";
  const pathname = rawUrl.split("?")[0] ?? "";
  const html = indexHtml();
  // Belt-and-braces with isSpaNavigation's reserved-prefix check: a URL carrying a device token
  // (in any spelling URLSearchParams accepts — carriesTokenParam decodes the key) is never a
  // client-side navigation, and rendering the shell would leave that reusable credential in
  // history/referrers instead of taking the redacting 404 path below.
  if (html && !carriesTokenParam(rawUrl) && isSpaNavigation(req.method, pathname)) {
    return reply.type("text/html; charset=utf-8").send(html);
  }
  req.log.info({ url: redactTokenInUrl(rawUrl) }, "route not found");
  reply.code(404).send({ error: "not found" });
});

// Web Push (push-to-wake for phones/closed tabs): payloads are encrypted per subscription
// (RFC 8291); the VAPID private key lives in sqlite and never leaves this process.
const pushSender = new WebPushSender(db, {
  info: (m) => app.log.info(m),
  warn: (m) => app.log.warn(m),
});

const svc = new SessionsService(
  db,
  hub,
  {
    info: (m) => app.log.info(m),
    warn: (m) => app.log.warn(m),
    error: (m) => app.log.error(m),
  },
  // Status-transition notifier: the pure decision picks the attention moments
  // (input_required / turn settle / completed / failed); send() fans out fire-and-forget.
  (prevStatus, view) => {
    const msg = pushDecision(prevStatus, view);
    if (msg) pushSender.send(msg, { kind: "session", sessionId: view.id });
  },
);

registerPromptImageRoutes(app, {
  db,
  service: svc,
  requestPrincipal,
  actor: workflowActor,
});

const automations = new AutomationsService(
  db,
  hub,
  svc,
  {
    info: (message) => app.log.info(message),
    warn: (message) => app.log.warn(message),
  },
  (automation, execution, event) => {
    const label = event === "started" ? "started"
      : event === "succeeded" ? "completed"
        : event === "expired" ? "expired waiting for a runner" : "failed";
    pushSender.send({
      title: `${automation.name} ${label}`.slice(0, 120),
      body: event === "succeeded"
        ? "The scheduled action completed successfully."
        : event === "started"
          ? "The scheduled action was accepted and is running."
          : (execution.error ?? "Open Automations to inspect the execution.").slice(0, 240),
      notificationKey: `automation:${automation.automationId}`,
      view: "automations",
      urgency: event === "failed" || event === "expired" ? "high" : "normal",
    }, { kind: "organization_admin", organizationId: db.localIdentityContext().organizationId });
  },
);
automations.recover(Date.now());

function runnerCapabilityError(
  runnerId: string,
  capability: RunnerProtocolCapability,
  label: string,
): string | null {
  const protocolVersion = db.getRunner(runnerId)?.protocolVersion;
  return runnerSupportsProtocol(protocolVersion, capability)
    ? null
    : runnerCapabilityRequirement(protocolVersion, capability, label);
}

// Bootstraps + supervises runners on remote machines over SSH ("boxes"). The runner binary it
// deploys is found in $WOLLIPOG_RUNNER_BIN_DIR / apps/runner/dist-bin (explicit overrides) / a
// release-identified cache, else downloaded from this packaged control plane's exact release.
const orchestrator = new BoxOrchestrator({
  db,
  hub,
  cpPort: PORT,
  issueCredential: makeManagedBoxRunnerCredentialIssuer(db),
  resolveBinary: makeBinaryResolver({
    repo: "picoduck/wollipog",
    releaseTag: RUNNER_RELEASE_TAG,
    cacheDir: join(os.homedir(), ".agent-manager", "runner-bin"),
    distBinDir: join(process.cwd(), "..", "..", "apps", "runner", "dist-bin"),
    log: (m) => app.log.info(m),
    warn: (m) => app.log.warn(m),
  }),
  log: (m) => app.log.info(m),
});

// Only local browser origins may make cross-origin REST calls. Every API request also carries a
// credential; this CORS boundary prevents a browser page from reading responses and remains
// defense-in-depth for the independently capability-authenticated public transcript route.
// Registered without await (Fastify loads plugins in order on ready) so this module
// has no top-level await — required to bundle the control plane into a CJS single
// executable (the Tauri sidecar) without an ESM wrapper.
app.register(cors, { origin: isLocalOrigin });
// @fastify/websocket v11 upgrades a route via an onRoute hook that must already be
// registered when the route is added. A bare top-level `app.register(websocket)` is
// deferred (avvio), so it isn't loaded when these synchronously-added routes register —
// the upgrade never happens and the handler runs as a plain HTTP route (the first arg is
// the request, not a socket → "socket.on is not a function", every connection 500s).
// Co-locate the plugin + WS routes and await the plugin INSIDE this child plugin: order is
// guaranteed, and the await is not module-level (keeps the CP bundlable as a CJS single
// executable for the Tauri sidecar — see the cors note above).
app.register(async (instance) => {
  await instance.register(websocket);

  /* ----------------------------- Runner channel ---------------------------- */
  instance.get("/runner", { websocket: true }, (socket) => {
  let runnerId: string | null = null;
  let credentialId: string | null = null;
  const runnerClient = {
    send: (d: string) => socket.send(d),
    close: (code?: number, reason?: string) => socket.close(code, reason),
  };

  socket.on("message", (raw: Buffer) => {
    const msg = parseMessage<RunnerToControlPlane>(raw.toString());
    if (!msg) return;

    // Nothing but `register` is accepted until this socket has authenticated — an
    // unregistered client must not be able to inject events, queue overlays, or
    // shell output for sessions it doesn't own. And once REPLACED by a reconnect,
    // a stale socket loses its voice entirely: it authenticated as this runner
    // once, but the live replacement owns the runner's state now.
    if (msg.type !== "register") {
      if (!runnerId) return;
      if (!hub.isCurrentRunnerSocket(runnerId, runnerClient)) return;
      if (!credentialId || !db.isRunnerCredentialActive(runnerId, credentialId)) {
        socket.close(1008, "runner credential is no longer active");
        return;
      }
    }

    switch (msg.type) {
      case "register": {
        if (runnerId) {
          send(socket, { type: "register_rejected", reason: "socket is already registered" });
          socket.close(1008, "duplicate registration");
          return;
        }
        let credential;
        try {
          credential = db.registerRunnerWithCredential(
            msg.runner,
            hashToken(msg.token),
            Date.now(),
            msg.protocolVersion ?? null,
          );
        } catch (error) {
          app.log.warn({ err: error, runnerId: msg.runner.runnerId }, "runner registration persistence failed");
          send(socket, { type: "register_rejected", reason: "registration failed" });
          socket.close(1008, "registration failed");
          return;
        }
        if (!credential) {
          send(socket, { type: "register_rejected", reason: "invalid token" });
          socket.close(1008, "invalid token");
          return;
        }
        if (markLegacyRunnerCredentialWarning(
          msg.token,
          msg.runner.runnerId,
          warnedLegacyRunnerCredentialIds,
        )) {
          app.log.warn(
            "a runner authenticated with a legacy credential; rotate it to complete the credential migration",
          );
        }
        runnerId = msg.runner.runnerId;
        credentialId = credential.credentialId;
        hub.attachRunner(runnerId, runnerClient);
        hub.clearRunnerQueues(runnerId); // a fresh connection has no in-flight queues — drop stale ones
        send(socket, {
          type: "registered",
          ok: true,
          serverTime: Date.now(),
          heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
          protocolVersion: PROTOCOL_VERSION,
        });
        // Close/forget requests made while this runner was offline are durable. The registered
        // frame is ordered first, so the runner can safely process these immediately afterward.
        for (const shellId of shellRegistry.pendingCloseIds(runnerId)) {
          hub.sendToRunner(runnerId, { type: "shell_close", shellId });
        }
        svc.recoverPendingSteeringResolutions(runnerId);
        svc.recoverPendingSessionCommands(runnerId);
        // A pre-v57 runner cannot emit the inventory fence that normally settles startup's
        // reconnecting rows. Its old transport already kills shells on disconnect, so resolve
        // those durable rows now; any queued legacy shell_exit frames remain idempotent.
        for (const shell of shellRegistry.reconcileRegistration(runnerId, msg.protocolVersion, Date.now())) {
          hub.shellExit(shell.sessionId, shell.shellId, null, shell.outputEndSeq);
        }
        // Phase 2: hydrate from the box's session snapshots (the source of truth) when present —
        // this subsumes reconcile and lets a dashboard see sessions it didn't create. Fall back to
        // reconcile for pre-Phase-2 runners.
        if (msg.sessionSnapshots) svc.hydrateRunnerSessions(runnerId, msg.sessionSnapshots);
        else svc.reconcileRunnerSessions(runnerId, msg.liveSessions ?? []);
        svc.recoverWorkflowRunner(runnerId);
        automations.tick(Date.now());
        automations.commandOutbox.flush(Date.now(), runnerId);
        hub.runnerChanged(runnerId);
        for (const projectId of db.projectIdsForRunner(runnerId)) hub.projectChangedById(projectId);
        // If this runner is a box's runner (connected through the SSH tunnel), flip it online.
        orchestrator.onRunnerRegistered(runnerId, credential.credentialId);
        app.log.info(
          `runner online: ${runnerId} (${msg.runner.hostname}, ${msg.runner.os}) ` +
            `agents=[${msg.runner.agents.map((a) => a.id).join(", ")}]`,
        );
        break;
      }
      case "heartbeat":
        if (runnerId) db.touch(runnerId, Date.now());
        break;
      case "session_status":
        svc.onSessionStatus(msg.sessionId, msg.status, msg.detail, msg.worktreePath, runnerId ?? undefined);
        break;
      case "policy_hook_credential":
        {
          const accepted = db.setPolicyHookCredential(msg.sessionId, runnerId!, msg.tokenHash, Date.now());
          send(socket, {
            type: "policy_hook_credential_registered",
            sessionId: msg.sessionId,
            tokenHash: msg.tokenHash,
            accepted,
            ...(!accepted ? { error: "session binding was rejected" } : {}),
          });
          if (!accepted) {
            app.log.warn(`runner ${runnerId} sent invalid policy-hook credential binding for ${msg.sessionId}`);
          }
        }
        break;
      case "session_runtime_updated":
        svc.applySessionRuntimeUpdate(runnerId!, msg.snapshot);
        break;
      case "session_event":
        svc.onSessionEvent(msg.sessionId, msg.payload, msg.seq, msg.ts, runnerId ?? undefined);
        break;
      case "session_queue": {
        // Ephemeral relay — the prompts waiting behind the running turn, straight to
        // dashboards. Only the session's OWNING runner may overlay queue state.
        svc.onSessionQueue(runnerId!, msg.sessionId, msg.queue, msg.held, msg.activeTurnId);
        break;
      }
      case "process_status":
        app.log.info(
          `process[${msg.sessionId}] ${msg.processStatus}` +
            (msg.pid ? ` pid=${msg.pid}` : "") +
            (msg.exitCode != null ? ` exit=${msg.exitCode}` : ""),
        );
        break;
      case "agents_updated":
        if (runnerId === msg.runnerId) {
          db.updateRunnerAgents(msg.runnerId, msg.agents, Date.now(), msg.editors);
          hub.runnerChanged(msg.runnerId);
          app.log.info(`runner ${msg.runnerId} agents: [${msg.agents.map((a) => a.id).join(", ")}]`);
        }
        break;
      case "driver_telemetry": {
        const event = normalizeDriverTelemetry(msg);
        if (runnerId != null && event) {
          db.recordDriverTelemetry(event, db.boxIdForRunner(runnerId) != null);
        } else {
          app.log.warn(`runner ${runnerId} sent malformed driver telemetry — ignored`);
        }
        break;
      }
      case "durable_session_command_result":
      case "durable_session_command_update":
        automations.onDurableCommandReceipt(runnerId!, msg);
        break;
      case "session_command_invocation_result":
      case "session_command_invocation_update":
        svc.onSessionCommandInvocationReceipt(runnerId!, msg);
        break;
      case "git_result":
      case "session_history_result":
      case "session_history_page_result":
      case "reprocess_session_result":
      case "list_external_sessions_result":
      case "adopt_session_result":
      case "list_directory_result":
      case "list_session_files_result":
      case "read_session_file_result":
      case "shell_open_result":
      case "rewind_result":
      case "fork_result":
      case "logout_agent_result":
      case "acp_registry_approval_result":
      case "host_action_result":
      case "interrupt_turn_result":
        hub.resolveRunnerRequest(msg, runnerId!);
        break;
      case "steer_session_result":
        svc.onSteerSessionResult(runnerId!, msg);
        break;
      case "resolve_steering_attempt_result":
        svc.onResolveSteeringAttemptResult(runnerId!, msg);
        break;
      case "shell_output": {
        // Persist the bounded sequence-addressed tail before relaying it to dashboards.
        const chunk = shellRegistry.output(runnerId!, msg.shellId, msg.stream, msg.data, msg.seq, Date.now());
        if (chunk) hub.shellOutput(msg.sessionId, msg.shellId, msg.stream, msg.data, chunk.seq);
        break;
      }
      case "shell_exit": {
        // The runner's dead-target synthetic exit carries an empty sessionId — resolve from
        // the registry so dashboards can route it; drop if the shell is already forgotten.
        const shell = shellRegistry.exit(runnerId!, msg.shellId, msg.code, msg.outputSeq, Date.now());
        if (shell) hub.shellExit(shell.sessionId, msg.shellId, msg.code, msg.outputSeq);
        break;
      }
      case "shell_snapshot": {
        shellRegistry.snapshot(runnerId!, msg, Date.now());
        break;
      }
      case "shell_inventory_complete": {
        const missing = shellRegistry.inventoryComplete(runnerId!, msg.shellIds, Date.now());
        for (const shell of missing) hub.shellExit(shell.sessionId, shell.shellId, null, shell.outputEndSeq);
        const sessionIds = msg.shellIds
          .map((shellId) => shellRegistry.get(shellId)?.sessionId)
          .filter((sessionId): sessionId is string => Boolean(sessionId));
        hub.shellRegistryReconciled(runnerId!, [...sessionIds, ...missing.map((shell) => shell.sessionId)]);
        break;
      }
    }
  });

  const onGone = () => {
    if (!runnerId) return;
    // A stale close (the runner already reconnected on a NEW socket) must be a no-op:
    // marking offline / clearing queues / failing sessions here would clobber the live
    // replacement connection that just registered.
    if (!hub.detachRunner(runnerId, runnerClient)) {
      app.log.info(`stale socket closed for ${runnerId} (already replaced by a reconnect)`);
      runnerId = null;
      return;
    }
    db.markOffline(runnerId, Date.now());
    hub.clearRunnerQueues(runnerId); // in-memory queues die with the runner
    svc.failRunnerSessions(runnerId);
    // Preserve v57 shell rows while the runner transport reconnects. Older runners have no
    // authoritative inventory and therefore resolve as exited at disconnect.
    const reconnectingShells = shellRegistry.markReconnecting(runnerId, Date.now());
    if (!runnerSupportsProtocol(db.getRunner(runnerId)?.protocolVersion, "durableSessionShells")) {
      const exited = shellRegistry.inventoryComplete(runnerId, [], Date.now());
      for (const shell of exited) hub.shellExit(shell.sessionId, shell.shellId, null, shell.outputEndSeq);
    } else if (reconnectingShells.length > 0) {
      hub.shellRegistryReconciled(runnerId, reconnectingShells.map((shell) => shell.sessionId));
    }
    hub.runnerChanged(runnerId);
    for (const projectId of db.projectIdsForRunner(runnerId)) hub.projectChangedById(projectId);
    // If this runner is a box's, mark the box offline too (the SSH child may still be alive).
    orchestrator.onRunnerDisconnected(runnerId);
    app.log.info(`runner offline: ${runnerId}`);
    runnerId = null;
  };
  socket.on("close", onGone);
  socket.on("error", onGone);
});
});

// Register the browser channel in a separate encapsulated plugin so ws enforces its small payload
// cap while assembling fragments. The runner sibling intentionally retains the default larger
// allowance for images and history frames.
app.register(async (instance) => {
  await instance.register(websocket, { options: { maxPayload: MAX_UI_CLIENT_MESSAGE_BYTES } });

  /* ------------------------------- UI channel ------------------------------ */
  instance.get("/ui", { websocket: true }, (socket, req) => {
  // Browsers cannot set a WebSocket Authorization header, so every UI client presents its local
  // startup or paired-device credential as ?token=. Possession stands in for Origin because a
  // paired phone's origin is intentionally not localhost.
  const authenticated = requiresDeviceAuth("/ui") ? authedApiPrincipal(req, true) : null;
  if (!authenticated) {
    socket.close(1008, "unauthorized — open the startup pairing URL or pair this device");
    return;
  }
  const client = {
    send: (data: string, onComplete?: (error?: Error) => void) => socket.send(data, onComplete),
    get bufferedAmount() { return socket.bufferedAmount; },
    asyncDelivery: true,
  };
  // Tag the client with its device so a revoke can force-close it immediately.
  const admitted = hub.addUiClient(client, {
    deviceId: authenticated.principal.kind === "human" ? authenticated.principal.deviceId : null,
    principal: authenticated.principal,
    close: (code = 1008, reason = "authorization changed") => socket.close(code, reason),
  });
  if (!admitted) {
    socket.close(1013, "too many UI connections; close another dashboard and retry");
    return;
  }
  socket.on("message", (raw, isBinary) => {
    if (isBinary) {
      hub.removeUiClient(client);
      socket.close(1003, "UI subscription messages must be text");
      return;
    }
    const normalized = normalizeUiClientRawData(raw);
    if (!normalized) {
      hub.removeUiClient(client);
      socket.close(1003, "unsupported UI subscription message encoding");
      return;
    }
    if (normalized.byteLength > MAX_UI_CLIENT_MESSAGE_BYTES) {
      hub.removeUiClient(client);
      socket.close(1009, "UI subscription message is too large");
      return;
    }
    const msg = parseUiClientMessage(normalized.toString("utf8"));
    if (!msg) {
      hub.removeUiClient(client);
      socket.close(1007, "invalid UI subscription message");
      return;
    }
    const applied = hub.setUiSessionSubscriptions(client, msg.revision, msg.sessionIds, msg.podIds);
    if (!applied.ok && applied.reason !== "client_missing") {
      hub.removeUiClient(client);
      socket.close(
        applied.reason === "rate_limited" ? 1013 : 1002,
        applied.reason === "rate_limited"
          ? "too many UI subscription updates; reconnect and retry"
          : "UI subscription revision must increase",
      );
    }
  });
  socket.on("close", () => hub.removeUiClient(client));
  socket.on("error", () => hub.removeUiClient(client));
  });
});

/* --------------------------------- REST ---------------------------------- */

// The `service` marker lets the desktop shell confirm this is OUR control plane (not
// some unrelated process on the same port) before skipping its managed sidecar.
app.get("/healthz", async () => ({ ok: true, ts: Date.now(), service: CONTROL_PLANE_SERVICE }));

registerManagedDesktopRoutes(app, MANAGED_DESKTOP_IDENTITY, {
  trustedLoopback,
  sessionsForRunner: (runnerId) => managedDesktopSessionsForRunner(
    (options) => db.listSessions(options),
    runnerId,
  ),
  provisionRunner: makeManagedDesktopRunnerCredentialIssuer(db),
});

// The app shell always goes through indexHtml() so it always carries the same-origin marker.
// BOTH spellings need an explicit route: static is registered with index:false (so `/` is ours),
// but its wildcard would otherwise serve `/index.html` straight off disk — unmarked. A phone
// opening `http://host:4317/index.html#pair=<token>` would then target 127.0.0.1, i.e. itself.
// Explicit routes beat the static wildcard, so registering them here is sufficient.
const serveShell = async (req: FastifyRequest, reply: FastifyReply) => {
  const html = indexHtml();
  if (!html) return reply.code(404).send({ error: "no web bundle built — run `pnpm --filter @wollipog/web build`" });
  // The token belongs in the `#pair=` fragment (never sent to the server), not a `?token=` query.
  // If one rode the query in, redirect to the clean path so the reusable credential doesn't
  // linger in the address bar or leak via same-origin referrers. The app adopts only `#pair=`,
  // so nothing functional is lost.
  const rawUrl = req.raw.url ?? "";
  if (carriesTokenParam(rawUrl)) return reply.redirect(rawUrl.split("?")[0] || "/", 303);
  return reply.type("text/html; charset=utf-8").send(html);
};
app.get("/", serveShell);
app.get("/index.html", serveShell);

app.get("/api/runners", async (req) => {
  const principal = requestPrincipal(req);
  return { runners: principal ? db.listRunnersForPrincipal(principal) : [] };
});

/* ------------------------------- Projects -------------------------------- */

const projectName = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  return name && name.length <= 120 && !/[\0-\x1f\x7f]/.test(name) ? name : null;
};

const requestedAccessScope = (
  principal: HumanPrincipal,
  value: unknown,
  fallback?: ResourceScope,
): { ok: true; scope: ResourceScope } | { ok: false; status: 400 | 403; error: string } => {
  const requestedValue = value === undefined ? fallback?.owner : value;
  if (!requestedValue || typeof requestedValue !== "object" || Array.isArray(requestedValue)) {
    return { ok: false, status: 400, error: "owner must select a valid access scope" };
  }
  const owner = requestedValue as Partial<ResourceOwner>;
  const administers = canAdministerIdentity(principal.role);
  if (owner.kind === "organization") {
    if (owner.organizationId !== principal.organizationId) {
      return { ok: false, status: 400, error: "organization access must use the current organization" };
    }
    if (!administers) {
      return { ok: false, status: 403, error: "organization owner or admin permission is required for organization access" };
    }
    return { ok: true, scope: { organizationId: principal.organizationId, owner: {
      kind: "organization", organizationId: principal.organizationId,
    } } };
  }
  if (owner.kind === "user") {
    if (owner.userId !== principal.userId) {
      return { ok: false, status: 403, error: "a private scope can only be assigned to the current user" };
    }
    return { ok: true, scope: { organizationId: principal.organizationId, owner: {
      kind: "user", userId: principal.userId,
    } } };
  }
  if (owner.kind === "team" && typeof owner.teamId === "string") {
    const team = db.identityAdministration(principal).teams.find((candidate) => candidate.teamId === owner.teamId);
    if (!team || (!administers && !team.memberUserIds.includes(principal.userId))) {
      return { ok: false, status: 403, error: "the selected team is not available to the current user" };
    }
    return { ok: true, scope: { organizationId: principal.organizationId, owner: {
      kind: "team", teamId: owner.teamId,
    } } };
  }
  return { ok: false, status: 400, error: "owner must select a valid access scope" };
};

const accessScopeTransitionError = (
  principal: HumanPrincipal,
  currentScope: ResourceScope,
  targetScope: ResourceScope,
): string | null => {
  if (canAdministerIdentity(principal.role)) return null;
  const sameAudience = scopeAudienceContained(currentScope, targetScope) &&
    scopeAudienceContained(targetScope, currentScope);
  if (sameAudience || (db.scopeAudienceContainedWithMembership(targetScope, currentScope) &&
      !db.scopeAudienceContainedWithMembership(currentScope, targetScope))) return null;
  return "organization owner or admin permission is required unless the access change only narrows the current audience";
};

const accessScopeOwnerFromQuery = (query: unknown): ResourceOwner | undefined => {
  const { ownerKind, ownerId } = (query ?? {}) as { ownerKind?: unknown; ownerId?: unknown };
  if (ownerKind === "organization" && typeof ownerId === "string") {
    return { kind: "organization", organizationId: ownerId };
  }
  if (ownerKind === "user" && typeof ownerId === "string") return { kind: "user", userId: ownerId };
  if (ownerKind === "team" && typeof ownerId === "string") return { kind: "team", teamId: ownerId };
  return undefined;
};

/** Keep relationship evidence internal when a Location manager cannot access an attached Project. */
const accessScopePreviewForPrincipal = (
  principal: AuthPrincipal,
  preview: AccessScopeChangePreview,
): AccessScopeChangePreview => ({
  ...preview,
  affectedProjects: preview.affectedProjects.filter((project) =>
    db.canAccessProject(principal, project.projectId)),
});

const accessibleProject = (req: FastifyRequest, projectId: string) => {
  const principal = requestPrincipal(req);
  return principal ? db.getProjectForPrincipal(principal, projectId) : null;
};

const manageableProject = (req: FastifyRequest, projectId: string) => {
  const principal = requestHuman(req);
  return principal && db.canManageProject(principal, projectId)
    ? db.getProjectForPrincipal(principal, projectId)
    : null;
};

const canManageAffectedSessions = (
  principal: HumanPrincipal,
  predicate: (session: SessionView) => boolean,
) => db.listSessions({ includeArchived: true })
  .filter(predicate)
  .every((session) => db.canAccessSession(principal, session.id));

app.get("/api/projects", async (req) => {
  const principal = requestPrincipal(req);
  return { projects: principal ? db.listProjectsForPrincipal(principal, true) : [] };
});

app.get("/api/projects/:id", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const project = accessibleProject(req, id);
  return project ? { project } : reply.code(404).send({ error: "project not found" });
});

app.post("/api/projects", async (req, reply) => {
  const principal = requestHuman(req);
  if (!principal) return reply.code(403).send({ error: "human identity is required" });
  const body = (req.body ?? {}) as CreateProjectRequest;
  const name = projectName(body.name);
  if (!name) return reply.code(400).send({ error: "name must be 1-120 characters" });
  const defaultScope: ResourceScope = {
    organizationId: principal.organizationId,
    owner: principal.role === "owner" || principal.role === "admin"
      ? { kind: "organization", organizationId: principal.organizationId }
      : { kind: "user", userId: principal.userId },
  };
  const requested = requestedAccessScope(principal, body.owner, defaultScope);
  if (!requested.ok) return reply.code(requested.status).send({ error: requested.error });
  const project = db.createProject({
    name,
    scope: requested.scope,
  });
  hub.projectChanged(project);
  return reply.code(201).send({ project: db.getProjectForPrincipal(principal, project.id)! });
});

app.patch("/api/projects/:id", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const principal = requestHuman(req);
  if (!principal) return reply.code(403).send({ error: "human identity is required" });
  if (!manageableProject(req, id)) return reply.code(404).send({ error: "project not found" });
  const body = (req.body ?? {}) as UpdateProjectRequest;
  if (body.name === undefined && body.hidden === undefined) {
    return reply.code(400).send({ error: "name or hidden is required" });
  }
  const name = body.name === undefined ? undefined : projectName(body.name);
  if (body.name !== undefined && !name) return reply.code(400).send({ error: "name must be 1-120 characters" });
  if (body.hidden !== undefined && typeof body.hidden !== "boolean") {
    return reply.code(400).send({ error: "hidden must be a boolean" });
  }
  db.updateProject(id, { ...(name ? { name } : {}), ...(body.hidden !== undefined ? { hidden: body.hidden } : {}) });
  const project = db.getProject(id)!;
  hub.projectChanged(project);
  return { project: db.getProjectForPrincipal(principal, id)! };
});

app.get("/api/projects/:id/access-scope", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const principal = requestHuman(req);
  if (!principal) return reply.code(403).send({ error: "human identity is required" });
  if (!manageableProject(req, id)) return reply.code(404).send({ error: "project not found" });
  const requested = requestedAccessScope(principal, accessScopeOwnerFromQuery(req.query));
  if (!requested.ok) return reply.code(requested.status).send({ error: requested.error });
  const currentScope = db.projectScope(id);
  if (!currentScope) return reply.code(404).send({ error: "project not found" });
  const transitionError = accessScopeTransitionError(principal, currentScope, requested.scope);
  if (transitionError) return reply.code(403).send({ error: transitionError });
  const preview = db.previewProjectAccessScope(id, requested.scope);
  return preview ? { preview } : reply.code(404).send({ error: "project not found" });
});

app.put("/api/projects/:id/access-scope", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const principal = requestHuman(req);
  if (!principal) return reply.code(403).send({ error: "human identity is required" });
  if (!manageableProject(req, id)) return reply.code(404).send({ error: "project not found" });
  const body = (req.body ?? {}) as { owner?: unknown; confirmationToken?: unknown };
  const requested = requestedAccessScope(principal, body.owner);
  if (!requested.ok) return reply.code(requested.status).send({ error: requested.error });
  const currentScope = db.projectScope(id);
  if (!currentScope) return reply.code(404).send({ error: "project not found" });
  const transitionError = accessScopeTransitionError(principal, currentScope, requested.scope);
  if (transitionError) return reply.code(403).send({ error: transitionError });
  if (typeof body.confirmationToken !== "string" || !/^[a-f0-9]{64}$/u.test(body.confirmationToken)) {
    return reply.code(400).send({ error: "a valid access-scope confirmation token is required" });
  }
  try {
    const preview = db.applyProjectAccessScope(id, requested.scope, body.confirmationToken, Date.now(), {
      principal,
      mutationAuditId: requestMutationAudits.get(req),
    });
    if (!preview) return reply.code(404).send({ error: "project not found" });
    hub.closeScopedUiClients();
    hub.synchronizeProjectSessionState();
    hub.projectChangedById(id);
    return { project: db.getProjectForPrincipal(principal, id)!, preview };
  } catch (error) {
    return reply.code(409).send({ error: error instanceof Error ? error.message : "project access update failed" });
  }
});

app.delete("/api/projects/:id", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const principal = requestHuman(req);
  if (!principal) return reply.code(403).send({ error: "human identity is required" });
  if (!manageableProject(req, id)) return reply.code(404).send({ error: "project not found" });
  if (!canManageAffectedSessions(principal, (session) => session.projectId === id)) {
    return reply.code(409).send({ error: "project contains sessions you cannot manage" });
  }
  const deleted = db.deleteProject(id);
  if (!deleted) return reply.code(404).send({ error: "project not found" });
  hub.projectRemoved(id);
  for (const sessionId of deleted.sessionIds) hub.sessionChangedById(sessionId);
  return { deleted: true };
});

app.post("/api/projects/:id/locations", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const principal = requestHuman(req);
  if (!principal) return reply.code(403).send({ error: "human identity is required" });
  if (!manageableProject(req, id)) return reply.code(404).send({ error: "project not found" });
  const body = (req.body ?? {}) as AddProjectLocationRequest;
  if (typeof body.runnerId !== "string" || !body.runnerId || typeof body.workspaceId !== "string" || !body.workspaceId) {
    return reply.code(400).send({ error: "runnerId and workspaceId are required" });
  }
  if (!db.canAccessWorkspace(principal, body.runnerId, body.workspaceId)) {
    return reply.code(404).send({ error: "workspace not found" });
  }
  try {
    db.addProjectLocation(id, body);
  } catch (error) {
    return reply.code(400).send({ error: (error as Error).message });
  }
  const project = db.getProject(id)!;
  hub.projectChanged(project);
  return { project: db.getProjectForPrincipal(principal, id)! };
});

app.post("/api/projects/:id/locations/new", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const principal = requestHuman(req);
  if (!principal) return reply.code(403).send({ error: "human identity is required" });
  if (!manageableProject(req, id)) return reply.code(404).send({ error: "project not found" });
  const body = (req.body ?? {}) as Partial<CreateProjectLocationRequest>;
  const runnerId = typeof body.runnerId === "string" ? body.runnerId : "";
  const name = projectName(body.name);
  const path = typeof body.path === "string" ? body.path.trim() : "";
  if (!runnerId || !name || !path || path.length > 4096 || /[\0-\x1f\x7f]/.test(path)) {
    return reply.code(400).send({ error: "runnerId, a 1-120 character name, and a valid path are required" });
  }
  if (!db.canAccessRunner(principal, runnerId)) return reply.code(404).send({ error: "runner not found" });
  const projectScope = db.projectScope(id);
  if (!projectScope) return reply.code(404).send({ error: "project not found" });
  const requested = requestedAccessScope(principal, body.owner, projectScope);
  if (!requested.ok) return reply.code(requested.status).send({ error: requested.error });
  if (!hub.isRunnerOnline(runnerId)) return reply.code(409).send({ error: "runner is offline" });
  const unsupported = runnerCapabilityError(runnerId, "directoryListing", "Directory browsing");
  if (unsupported) return reply.code(409).send({ error: unsupported });
  const browsed = await svc.listDirectory(runnerId, path);
  if (!browsed.ok) {
    const message = browsed.status === 404
      ? "The selected folder was not found on this Machine. It may have moved or been deleted; browse for the folder again."
      : `The selected folder could not be verified on this Machine: ${browsed.error}`;
    return reply.code(browsed.status).send({ error: message });
  }
  if (!browsed.data?.path) return reply.code(502).send({ error: "the runner did not return the selected directory" });
  try {
    db.createProjectWorkspace(id, runnerId, { name, path: browsed.data.path }, Date.now(), requested.scope);
  } catch (error) {
    const message = (error as Error).message;
    return reply.code(message.includes("already registered") ? 409 : 400).send({ error: message });
  }
  const project = db.getProject(id)!;
  hub.runnerChanged(runnerId);
  hub.projectChanged(project);
  return reply.code(201).send({ project: db.getProjectForPrincipal(principal, id)! });
});

app.post("/api/projects/:id/locations/move", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const principal = requestHuman(req);
  if (!principal) return reply.code(403).send({ error: "human identity is required" });
  if (!manageableProject(req, id)) return reply.code(404).send({ error: "project not found" });
  const locationId = (req.body as MoveProjectLocationRequest | undefined)?.locationId;
  const location = typeof locationId === "string" ? db.projectLocation(locationId) : null;
  if (!location || !db.canManageProject(principal, location.projectId)) {
    return reply.code(404).send({ error: "project location not found" });
  }
  if (!canManageAffectedSessions(principal, (session) => session.projectLocationId === location.id)) {
    return reply.code(409).send({ error: "project location contains sessions you cannot manage" });
  }
  const sourceProjectId = location.projectId;
  const affectedSessionIds = db.listSessions({ includeArchived: true })
    .filter((session) => session.projectLocationId === location.id)
    .map((session) => session.id);
  try {
    db.moveProjectLocation(location.id, id);
  } catch (error) {
    return reply.code(400).send({ error: (error as Error).message });
  }
  hub.projectChangedById(sourceProjectId);
  hub.projectChangedById(id);
  for (const sessionId of affectedSessionIds) hub.sessionChangedById(sessionId);
  return { project: db.getProjectForPrincipal(principal, id)! };
});

app.delete("/api/projects/:id/locations/:locationId", async (req, reply) => {
  const { id, locationId } = req.params as { id: string; locationId: string };
  const principal = requestHuman(req);
  if (!principal) return reply.code(403).send({ error: "human identity is required" });
  if (!manageableProject(req, id)) return reply.code(404).send({ error: "project not found" });
  const location = db.projectLocation(locationId);
  if (!location || location.projectId !== id) {
    return reply.code(404).send({ error: "project location not found" });
  }
  if (!canManageAffectedSessions(principal, (session) => session.projectLocationId === locationId)) {
    return reply.code(409).send({ error: "project location contains sessions you cannot manage" });
  }
  db.removeProjectLocation(locationId);
  const project = db.getProject(id)!;
  hub.projectChanged(project);
  for (const session of db.listSessions({ includeArchived: true })) {
    if (session.projectId === id) hub.sessionChanged(session, false);
  }
  return { project: db.getProjectForPrincipal(principal, id)! };
});

app.post("/api/projects/:id/locations/:locationId/default", async (req, reply) => {
  const { id, locationId } = req.params as { id: string; locationId: string };
  const principal = requestHuman(req);
  if (!principal) return reply.code(403).send({ error: "human identity is required" });
  if (!manageableProject(req, id)) return reply.code(404).send({ error: "project not found" });
  const location = db.projectLocation(locationId);
  if (!location || location.projectId !== id) {
    return reply.code(404).send({ error: "project location not found" });
  }
  try {
    const project = db.setProjectDefaultLocation(id, locationId);
    if (!project) return reply.code(404).send({ error: "project not found" });
    hub.projectChanged(project);
    return { project: db.getProjectForPrincipal(principal, id)! };
  } catch (error) {
    return reply.code(409).send({ error: (error as Error).message });
  }
});

app.post("/api/projects/:id/archive-sessions", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const principal = requestHuman(req);
  if (!principal) return reply.code(403).send({ error: "human identity is required" });
  if (!manageableProject(req, id)) return reply.code(404).send({ error: "project not found" });
  if (!canManageAffectedSessions(principal, (session) => session.projectId === id)) {
    return reply.code(409).send({ error: "project contains sessions you cannot manage" });
  }
  const sessions = db.archiveProjectSessions(id, true);
  const archivedSessionIds = sessions.map((session) => session.id);
  for (const session of sessions) hub.sessionChanged(session, false);
  const project = db.getProject(id)!;
  hub.projectChanged(project);
  return { project: db.getProjectForPrincipal(principal, id)!, sessions, archivedSessionIds };
});

registerInstanceRoute(app, {
  instanceId: () => db.instanceId(),
  displayName: () => db.localIdentityContext().organizationName,
});

// Connection coordinates are reusable; runner-specific credentials are issued separately and
// their plaintext is returned only once after the caller has chosen the exact runner id.
app.get("/api/onboarding", async (): Promise<OnboardingInfo> => {
  const reachableIps = TAILNET_ONLY ? tailnetIpv4(lanIpv4()) : lanIpv4();
  return {
    runnerWsUrl: buildRunnerWsUrl(HOST, PORT),
    token: null,
    host: HOST,
    port: PORT,
    lanIps: reachableIps,
    existingRunnerIds: db.listRunners().map((r) => r.runnerId),
  };
});

registerRunnerCredentialRoutes(app, { db, hub, requestHuman });

/* ------------------------------- Devices --------------------------------- */

// Pair a new device. LOOPBACK ONLY: minting credentials is reserved for the machine the
// control plane runs on — a paired (or unauthenticated) remote client must never be able to
// mint further tokens. The plaintext token is returned exactly once; only its hash persists.
app.post("/api/devices", async (req, reply) => {
  if (!trustedLoopback(req)) return reply.code(403).send({ error: "devices can only be paired from the local dashboard" });
  const body = (req.body ?? {}) as { name?: unknown; userId?: unknown };
  const name = String(body.name ?? "").trim().slice(0, 64);
  if (!name) return reply.code(400).send({ error: "name is required" });
  const principal = requestHuman(req) ?? localApiPrincipal().principal;
  const userId = typeof body.userId === "string" && body.userId ? body.userId : principal.userId;
  const token = newDeviceToken();
  const id = `dev_${randomUUID().slice(0, 8)}`;
  try {
    db.createDevice({
      id,
      name,
      tokenHash: hashToken(token),
      userId,
      organizationId: principal.organizationId,
      now: Date.now(),
    });
  } catch {
    return reply.code(400).send({ error: "device user must be an active member of this organization" });
  }
  // token is returned exactly once (only its hash persists); the caller shows it to the user.
  // `pairing` tells the UI whether a clickable link can actually work: a link is only real when
  // the app bundle is served AND the control plane is reachable at that address. pairingHosts()
  // encodes the bind semantics (loopback → none; 0.0.0.0 → every LAN address; a specific bind →
  // only that one). The UI degrades to "append this fragment" guidance rather than a dead URL.
  return reply.code(201).send({
    device: db.listDevices().find((d) => d.deviceId === id),
    token,
    pairing: {
      hosts: pairingHosts(HOST, TAILNET_ONLY ? tailnetIpv4(lanIpv4()) : lanIpv4()),
      port: PORT,
      webServed: webDist !== null,
      boundBeyondLoopback: !isLoopbackBindHost(HOST),
    },
  });
});

app.get("/api/devices", async (req) => {
  const principal = requestHuman(req);
  return { devices: principal ? db.listDevicesForOrganization(principal.organizationId) : [] };
});

// Revoke a device — takes effect on its next request. Loopback-only like pairing: a stolen
// device token must not be able to silence the other devices (or itself survive by deleting
// the revocation route's reach).
app.delete("/api/devices/:id", async (req, reply) => {
  if (!trustedLoopback(req)) return reply.code(403).send({ error: "devices can only be revoked from the local dashboard" });
  const id = (req.params as { id: string }).id;
  if (!db.deleteDevice(id)) return reply.code(404).send({ error: "device not found" });
  hub.closeUiClientsForDevice(id); // sever its live /ui stream now, not whenever it drops
  return reply.code(204).send();
});

/* --------------------------- Identity and access ------------------------- */

const ORGANIZATION_ROLES = new Set<OrganizationRole>(["owner", "admin", "operator", "viewer"]);
const USER_STATUSES = new Set<UserStatus>(["active", "suspended"]);

app.get("/api/identity", async (req, reply) => {
  const principal = requestHuman(req);
  if (!principal) return reply.code(403).send({ error: "human identity is required" });
  return db.identityAdministration(principal);
});

app.post("/api/identity/users", async (req, reply) => {
  const principal = requestHuman(req);
  if (!principal || !canAdministerIdentity(principal.role)) {
    return reply.code(403).send({ error: "organization owner or admin permission is required" });
  }
  const body = (req.body ?? {}) as { displayName?: unknown; role?: unknown };
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const role = body.role as OrganizationRole;
  if (!displayName || displayName.length > 80) return reply.code(400).send({ error: "displayName must be 1-80 characters" });
  if (!ORGANIZATION_ROLES.has(role)) return reply.code(400).send({ error: "invalid organization role" });
  if (role === "owner" && principal.role !== "owner") {
    return reply.code(403).send({ error: "only an organization owner can grant owner access" });
  }
  try {
    const membership = db.createIdentityMember({
      userId: `usr_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      displayName,
      organizationId: principal.organizationId,
      role,
      now: Date.now(),
    });
    return reply.code(201).send({ membership });
  } catch {
    return reply.code(409).send({ error: "could not create organization member" });
  }
});

app.patch("/api/identity/users/:userId", async (req, reply) => {
  const principal = requestHuman(req);
  if (!principal || !canAdministerIdentity(principal.role)) {
    return reply.code(403).send({ error: "organization owner or admin permission is required" });
  }
  const { userId } = req.params as { userId: string };
  const existing = db.identityAdministration(principal).memberships.find((item) => item.userId === userId);
  if (!existing) return reply.code(404).send({ error: "member not found" });
  if (principal.role !== "owner" && (existing.role === "owner" || (req.body as { role?: unknown })?.role === "owner")) {
    return reply.code(403).send({ error: "only an organization owner can change owner access" });
  }
  const body = (req.body ?? {}) as { displayName?: unknown; role?: unknown; status?: unknown };
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : existing.userName;
  const role = (body.role ?? existing.role) as OrganizationRole;
  const status = (body.status ?? existing.userStatus) as UserStatus;
  if (!displayName || displayName.length > 80) return reply.code(400).send({ error: "displayName must be 1-80 characters" });
  if (!ORGANIZATION_ROLES.has(role) || !USER_STATUSES.has(status)) {
    return reply.code(400).send({ error: "invalid role or user status" });
  }
  try {
    const deviceIds = status === "suspended" ? db.deviceIdsForUser(userId) : [];
    const membership = db.updateIdentityMember({
      organizationId: principal.organizationId,
      userId,
      displayName,
      role,
      status,
      now: Date.now(),
    });
    if (!membership) return reply.code(404).send({ error: "member not found" });
    for (const deviceId of deviceIds) hub.closeUiClientsForDevice(deviceId);
    hub.closeOrganizationUiClients(principal.organizationId);
    return { membership };
  } catch (error) {
    return reply.code(409).send({ error: error instanceof Error ? error.message : "member update failed" });
  }
});

app.post("/api/identity/teams", async (req, reply) => {
  const principal = requestHuman(req)!;
  const body = (req.body ?? {}) as { name?: unknown; memberUserIds?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const memberUserIds = Array.isArray(body.memberUserIds) && body.memberUserIds.every((id) => typeof id === "string")
    ? [...new Set(body.memberUserIds as string[])] : null;
  if (!name || name.length > 80) return reply.code(400).send({ error: "team name must be 1-80 characters" });
  if (!memberUserIds || memberUserIds.length > 100) return reply.code(400).send({ error: "memberUserIds must contain at most 100 unique user ids" });
  try {
    const team = db.createIdentityTeam({
      teamId: `team_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      organizationId: principal.organizationId,
      name,
      memberUserIds,
      now: Date.now(),
    });
    hub.closeScopedUiClients();
    return reply.code(201).send({ team });
  } catch (error) {
    return reply.code(409).send({ error: error instanceof Error ? error.message : "team creation failed" });
  }
});

app.put("/api/identity/teams/:teamId/members", async (req, reply) => {
  const principal = requestHuman(req)!;
  const { teamId } = req.params as { teamId: string };
  const ids = (req.body as { memberUserIds?: unknown })?.memberUserIds;
  const memberUserIds = Array.isArray(ids) && ids.every((id) => typeof id === "string")
    ? [...new Set(ids as string[])] : null;
  if (!memberUserIds || memberUserIds.length > 100) return reply.code(400).send({ error: "memberUserIds must contain at most 100 unique user ids" });
  try {
    const team = db.updateIdentityTeamMembers({
      teamId,
      organizationId: principal.organizationId,
      memberUserIds,
      now: Date.now(),
    });
    if (!team) return reply.code(404).send({ error: "team not found" });
    hub.closeScopedUiClients();
    return { team };
  } catch (error) {
    return reply.code(409).send({ error: error instanceof Error ? error.message : "team update failed" });
  }
});

app.delete("/api/identity/teams/:teamId", async (req, reply) => {
  const principal = requestHuman(req)!;
  const { teamId } = req.params as { teamId: string };
  try {
    if (!db.deleteIdentityTeam(teamId, principal.organizationId)) return reply.code(404).send({ error: "team not found" });
    hub.closeScopedUiClients();
    return reply.code(204).send();
  } catch (error) {
    return reply.code(409).send({ error: error instanceof Error ? error.message : "team deletion failed" });
  }
});

app.get("/api/identity/mutation-audit", async (req, reply) => {
  const principal = requestHuman(req);
  if (!principal || !canAdministerIdentity(principal.role)) {
    return reply.code(403).send({ error: "organization owner or admin permission is required" });
  }
  const rawLimit = Number((req.query as { limit?: string }).limit ?? 100);
  return { audit: db.listMutationAudit(principal.organizationId, Number.isFinite(rawLimit) ? rawLimit : 100) };
});

app.get("/api/identity/access-scope-audit", async (req, reply) => {
  const principal = requestHuman(req);
  if (!principal || !canAdministerIdentity(principal.role)) {
    return reply.code(403).send({ error: "organization owner or admin permission is required" });
  }
  const rawLimit = Number((req.query as { limit?: string }).limit ?? 100);
  return { audit: db.listAccessScopeAudit(principal.organizationId, Number.isFinite(rawLimit) ? rawLimit : 100) };
});

app.put("/api/identity/ownership/:resource/:resourceId", async (req, reply) => {
  const principal = requestHuman(req)!;
  const { resource, resourceId } = req.params as { resource: string; resourceId: string };
  if (resource !== "runner" && resource !== "session") {
    return reply.code(400).send({ error: "resource must be runner or session; Location access uses the preflighted access-scope endpoint" });
  }
  const body = (req.body ?? {}) as { runnerId?: unknown; owner?: unknown };
  const owner = body.owner as ResourceScope["owner"] | undefined;
  const validOwner = owner?.kind === "organization" && owner.organizationId === principal.organizationId ||
    owner?.kind === "user" && typeof owner.userId === "string" ||
    owner?.kind === "team" && typeof owner.teamId === "string";
  if (!validOwner) return reply.code(400).send({ error: "invalid resource owner" });
  try {
    const affectedProjectIds = resource === "session"
      ? [db.getSession(resourceId)?.projectId].filter((id): id is string => Boolean(id))
      : [];
    const updated = db.setResourceScope({
      resource,
      resourceId,
      scope: { organizationId: principal.organizationId, owner: owner! },
      now: Date.now(),
    });
    if (!updated) return reply.code(404).send({ error: "resource not found" });
    hub.closeScopedUiClients();
    hub.synchronizeProjectSessionState();
    for (const projectId of affectedProjectIds) hub.projectChangedById(projectId);
    return { scope: resource === "runner" ? db.runnerScope(resourceId) : db.sessionScope(resourceId) };
  } catch (error) {
    return reply.code(409).send({ error: error instanceof Error ? error.message : "ownership update failed" });
  }
});

/* ------------------------------- Web Push --------------------------------- */
// Standard /api/* gating requires a local-startup or paired-device bearer. The
// public key is not a secret — it's what the browser hands the push service — but keeping
// it on /api means only authenticated surfaces can even enumerate that push is enabled.

app.get("/api/push/vapid-public-key", async () => ({ publicKey: pushSender.vapidPublicKey() }));

// Register (or refresh) this browser's push subscription. Bound to the authed device when
// there is one so revocation silences it; local-bootstrap dashboards subscribe unowned (NULL).
// Capped: the table drives a per-transition fan-out, so its size bounds that work. 64 is
// far above any real personal-fleet device count; refreshes of existing endpoints always pass.
const MAX_PUSH_SUBSCRIPTIONS = 64;
app.post("/api/push/subscriptions", async (req, reply) => {
  const parsed = validateSubscription(req.body);
  if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
  if (!db.hasPushSubscription(parsed.endpoint) && db.countPushSubscriptions() >= MAX_PUSH_SUBSCRIPTIONS) {
    return reply.code(409).send({ error: "too many push subscriptions — unsubscribe unused devices first" });
  }
  db.upsertPushSubscription({
    endpoint: parsed.endpoint,
    p256dh: parsed.keys.p256dh,
    auth: parsed.keys.auth,
    deviceId: authedDevice(req)?.id ?? null,
    now: Date.now(),
  });
  return reply.code(201).send({ ok: true });
});

// POST (not DELETE-with-body — proxies drop those bodies) to drop one subscription.
app.post("/api/push/unsubscribe", async (req, reply) => {
  const endpoint = (req.body as { endpoint?: unknown })?.endpoint;
  if (typeof endpoint !== "string" || !endpoint) return reply.code(400).send({ error: "endpoint is required" });
  const principal = requestHuman(req);
  if (principal?.deviceId && principal.role !== "owner" && principal.role !== "admin") {
    db.deletePushSubscriptionForDevice(endpoint, principal.deviceId);
  } else {
    db.deletePushSubscription(endpoint);
  }
  return reply.code(204).send();
});

// Ask a runner to re-probe its installed agents; the refreshed list arrives
// asynchronously via an agents_updated message.
app.post("/api/runners/:id/rediscover", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!hub.isRunnerOnline(id)) return reply.code(409).send({ error: "runner is offline" });
  const sent = hub.sendToRunner(id, { type: "rediscover", runnerId: id });
  if (!sent) return reply.code(503).send({ error: "runner not reachable" });
  return { ok: true };
});

app.post("/api/runners/:id/acp-registry/:agentId/approval", async (req, reply) => {
  const { id, agentId } = req.params as { id: string; agentId: string };
  const body = req.body as RegistryApprovalInput;
  const runner = db.getRunner(id);
  if (!runner) return reply.code(404).send({ error: "runner not found" });
  if (!hub.isRunnerOnline(id)) return reply.code(409).send({ error: "runner is offline" });
  const unsupported = runnerCapabilityError(id, "acpRegistryApproval", "ACP Registry approval");
  if (unsupported) return reply.code(409).send({ error: unsupported });
  const validated = validateRegistryApproval(runner.agents, agentId, body);
  if (!validated.ok) return reply.code(validated.status).send({ error: validated.error });
  const requestId = `registry_${randomUUID().slice(0, 8)}`;
  try {
    const result = await hub.requestFromRunner(id, requestId, {
      type: "acp_registry_approval",
      requestId,
      runnerId: id,
      agentId,
      schemaVersion: validated.schemaVersion,
      adapterVersion: validated.adapterVersion,
      action: validated.action,
      confirmation: "explicit",
    });
    if (result.type !== "acp_registry_approval_result") {
      return reply.code(502).send({ error: "unexpected runner reply" });
    }
    if (!result.ok) return reply.code(409).send({ error: result.error ?? "Registry approval failed" });
    return { ok: true };
  } catch (error) {
    return reply.code(504).send({ error: (error as Error).message });
  }
});

// Remove a stale/offline runner (and its sessions/runs) from the dashboard. Online runners must be
// stopped first — otherwise they'd just re-register.
app.patch("/api/runners/:id", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const body = (req.body ?? {}) as { displayName?: unknown };
  if (typeof body.displayName !== "string") {
    return reply.code(400).send({ error: "displayName must be a string" });
  }
  const displayName = body.displayName.trim();
  if (displayName && !projectName(displayName)) {
    return reply.code(400).send({ error: "displayName must be 120 characters or fewer and contain no control characters" });
  }
  const boxId = db.boxIdForRunner(id);
  if (!db.getRunner(id) && !boxId) return reply.code(404).send({ error: "runner not found" });
  db.setMachineDisplayName(id, displayName);
  hub.runnerChanged(id);
  if (boxId) hub.boxChanged(boxId);
  return { ok: true };
});

app.delete("/api/runners/:id", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (hub.isRunnerOnline(id)) return reply.code(409).send({ error: "runner is online — stop it before removing" });
  // A box's runner must be removed through the box (DELETE /api/boxes/:id): that path also tears
  // down the orchestrator's runtime/timer state and tells UIs to drop the box card. deleteRunner()
  // would delete the persisted box row but leave both unsignaled, orphaning the box.
  if (db.boxIdForRunner(id)) {
    return reply.code(409).send({ error: "this runner belongs to a box — remove the box instead (DELETE /api/boxes/:id)" });
  }
  const projectIds = db.projectIdsForRunner(id);
  const res = db.deleteRunner(id);
  if (!res) return reply.code(404).send({ error: "runner not found" });
  for (const sid of res.sessionIds) hub.sessionRemoved(sid, false);
  for (const rid of res.runIds) hub.runRemoved(rid);
  for (const podId of res.podIds) {
    const pod = db.reconcilePodAfterMembershipLoss(podId, Date.now());
    if (pod) hub.podChanged(pod);
  }
  hub.runnerRemoved(id);
  for (const projectId of projectIds) hub.projectChangedById(projectId);
  return reply.code(204).send();
});

// Phase 3: list external (CLI-started) sessions on a runner host, and adopt one into Wollipog.
app.get("/api/runners/:id/external-sessions", async (req, reply) => {
  const query = req.query as { agentId?: string };
  const r = await svc.listExternalSessions((req.params as { id: string }).id, query.agentId || undefined);
  if (!r.ok) return reply.code(r.status).send({ error: r.error });
  return { sessions: r.data };
});

// Browse the runner machine's filesystem for the workspace directory picker.
app.get("/api/runners/:id/list-directory", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const q = req.query as { path?: string; distro?: string };
  const r = await svc.listDirectory(id, q.path ?? "", q.distro || undefined);
  if (!r.ok) return reply.code(r.status).send({ error: r.error });
  return r.data;
});

// Files panel: browse / read files under a session's root (worktree or repo, runner-resolved).
// `?path=a&path=b` parses as an array — reject it here rather than shipping a non-string to the
// runner (whose validator would throw an opaque TypeError back as a 502).
app.get("/api/sessions/:id/files", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const q = req.query as { path?: unknown };
  if (q.path !== undefined && typeof q.path !== "string") {
    return reply.code(400).send({ error: "path must be a single string" });
  }
  const r = await svc.listSessionFiles(id, q.path ?? "");
  if (!r.ok) return reply.code(r.status).send({ error: r.error });
  return r.data;
});

app.get("/api/sessions/:id/file", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const q = req.query as { path?: unknown };
  if (!q.path || typeof q.path !== "string") {
    return reply.code(400).send({ error: "path is required (a single string)" });
  }
  const r = await svc.readSessionFile(id, q.path);
  if (!r.ok) return reply.code(r.status).send({ error: r.error });
  return r.data;
});

// Drop one not-yet-started queued prompt (the running turn is unaffected). The runner echoes the
// updated queue back via session_queue, which refreshes the session — so this is fire-and-forget.
app.post("/api/sessions/:id/cancel-queued", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const body = (req.body ?? {}) as { promptId?: unknown };
  if (typeof body.promptId !== "string" || !body.promptId) {
    return reply.code(400).send({ error: "promptId (string) is required" });
  }
  const session = db.getSession(id);
  if (!session) return reply.code(404).send({ error: "session not found" });
  if (!hub.isRunnerOnline(session.runnerId)) return reply.code(409).send({ error: "runner is offline" });
  const unsupported = runnerCapabilityError(session.runnerId, "queuedPromptCancellation", "Queued prompt cancellation");
  if (unsupported) return reply.code(409).send({ error: unsupported });
  if (!hub.sendToRunner(session.runnerId, { type: "cancel_queued_prompt", sessionId: id, promptId: body.promptId })) {
    return reply.code(409).send({ error: "runner is offline" });
  }
  return reply.code(204).send();
});

// Shells panel: durable bounded history and detachable runner-owned processes.
app.get("/api/sessions/:id/shells", async (req) => {
  return { shells: shellRegistry.list((req.params as { id: string }).id) };
});

app.get("/api/sessions/:id/shells/:shellId/history", async (req, reply) => {
  const { id, shellId } = req.params as { id: string; shellId: string };
  const query = req.query as { after?: string; limit?: string };
  const after = Number(query.after ?? 0);
  const limit = Number(query.limit ?? 200);
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    return reply.code(400).send({ error: "after and limit must be bounded non-negative integers" });
  }
  const shell = shellRegistry.get(shellId);
  if (!shell || shell.sessionId !== id) return reply.code(404).send({ error: "shell not found" });
  return shellRegistry.history(shellId, after, limit);
});

type OpenSessionShellResult =
  | { ok: true; status: 200; shell: ShellView }
  | {
      ok: false;
      status: 400 | 404 | 409 | 502 | 504;
      error: string;
      /** False when a runner timeout/disconnect leaves process creation unknown. */
      definitive?: boolean;
    };

async function openSessionShell(
  sessionId: string,
  body: { cols?: unknown; rows?: unknown; kind?: unknown },
  options: { initialNativeTui?: boolean } = {},
): Promise<OpenSessionShellResult> {
  const session = db.getSession(sessionId);
  if (!session) return { ok: false, status: 404, error: "session not found" };
  if (!hub.isRunnerOnline(session.runnerId)) return { ok: false, status: 409, error: "runner is offline" };
  const unsupported = runnerCapabilityError(session.runnerId, "sessionShells", "Session terminal access");
  if (unsupported) return { ok: false, status: 409, error: unsupported };
  if (body.kind !== undefined && body.kind !== "shell" && body.kind !== "agent_tui") {
    return { ok: false, status: 400, error: "kind must be shell or agent_tui" };
  }
  const kind = body.kind === "agent_tui" ? "agent_tui" : "shell";
  if (kind === "agent_tui") {
    const tuiUnsupported = nativeTuiSessionError(db, hub, session, options.initialNativeTui === true);
    if (tuiUnsupported) return { ok: false, ...tuiUnsupported };
    if (shellRegistry.list(sessionId).some((shell) => shell.kind === "agent_tui" && shell.status !== "exited")) {
      return { ok: false, status: 409, error: "this session already has a running Agent TUI" };
    }
  }
  // Pass sizes through only as finite numbers; the runner clamps them (they end up inside a
  // `script -c` string, so the runner treats anything non-integer as the default).
  const cols = typeof body.cols === "number" && Number.isFinite(body.cols) ? body.cols : undefined;
  const rows = typeof body.rows === "number" && Number.isFinite(body.rows) ? body.rows : undefined;
  const shellId = `sh_${randomUUID().slice(0, 12)}`;
  const requestId = `shl_${randomUUID().slice(0, 8)}`;
  const createdAt = Date.now();
  const name = kind === "agent_tui" ? "Agent TUI" : shellRegistry.nextName(sessionId);
  const forgetAmbiguousOpen = () => {
    shellRegistry.remove(shellId, session.runnerId, Date.now());
    hub.sendToRunner(session.runnerId, { type: "shell_close", shellId });
  };
  shellRegistry.create({ shellId, sessionId, runnerId: session.runnerId, name, createdAt, kind });
  try {
    const res = await hub.requestFromRunner(
      session.runnerId,
      requestId,
      {
        type: "shell_open",
        requestId,
        sessionId,
        shellId,
        name,
        createdAt,
        kind,
        ...(options.initialNativeTui === true ? { fenceStart: true as const } : {}),
        cols,
        rows,
      },
      15_000,
    );
    if (res.type !== "shell_open_result") {
      forgetAmbiguousOpen();
      return { ok: false, status: 502, error: "unexpected runner reply", definitive: false };
    }
    if (!res.ok) {
      // The runner answered definitively that no process was opened. A tombstone is needed only
      // for ambiguous outcomes where a late snapshot could otherwise resurrect a live process.
      shellRegistry.discardUnopened(shellId, session.runnerId);
      return { ok: false, status: 502, error: res.error ?? "could not open a shell" };
    }
    const shell = shellRegistry.setPty(shellId, Boolean(res.pty), Date.now());
    if (!shell) {
      forgetAmbiguousOpen();
      return { ok: false, status: 502, error: "opened shell was not retained", definitive: false };
    }
    return { ok: true, status: 200, shell };
  } catch (err) {
    forgetAmbiguousOpen();
    return {
      ok: false,
      status: isRunnerRequestTimeoutError(err) ? 504 : 502,
      error: (err as Error).message,
      definitive: false,
    };
  }
}

app.post("/api/sessions/:id/shells", async (req, reply) => {
  const result = await openSessionShell(
    (req.params as { id: string }).id,
    (req.body ?? {}) as { cols?: unknown; rows?: unknown; kind?: unknown },
  );
  return result.ok
    ? reply.code(result.status).send({ shell: result.shell })
    : reply.code(result.status).send({ error: result.error });
});

// Best-effort PTY resize (fire-and-forget, like input — pipe shells ignore it).
app.post("/api/sessions/:id/shells/:shellId/resize", async (req, reply) => {
  const { id, shellId } = req.params as { id: string; shellId: string };
  const body = (req.body ?? {}) as { cols?: unknown; rows?: unknown };
  if (typeof body.cols !== "number" || typeof body.rows !== "number" || !Number.isFinite(body.cols) || !Number.isFinite(body.rows)) {
    return reply.code(400).send({ error: "cols and rows (numbers) are required" });
  }
  const entry = shellRegistry.get(shellId);
  if (!entry || entry.sessionId !== id) return reply.code(404).send({ error: "shell not found" });
  if (entry.status !== "running") return reply.code(409).send({ error: `shell is ${entry.status}` });
  if (!hub.sendToRunner(entry.runnerId, { type: "shell_resize", shellId, cols: body.cols, rows: body.rows })) {
    return reply.code(409).send({ error: "runner is offline" });
  }
  return reply.code(204).send();
});

app.post("/api/sessions/:id/shells/:shellId/input", async (req, reply) => {
  const { id, shellId } = req.params as { id: string; shellId: string };
  const body = (req.body ?? {}) as { data?: unknown };
  if (typeof body.data !== "string" || body.data.length === 0) {
    return reply.code(400).send({ error: "data (non-empty string) is required" });
  }
  if (body.data.length > 64 * 1024) return reply.code(400).send({ error: "input too large" });
  const entry = shellRegistry.get(shellId);
  if (!entry || entry.sessionId !== id) return reply.code(404).send({ error: "shell not found" });
  if (entry.status !== "running") return reply.code(409).send({ error: `shell is ${entry.status}` });
  if (!hub.sendToRunner(entry.runnerId, { type: "shell_input", shellId, data: body.data })) {
    return reply.code(409).send({ error: "runner is offline" });
  }
  return reply.code(204).send();
});

app.delete("/api/sessions/:id/shells/:shellId", async (req, reply) => {
  const { id, shellId } = req.params as { id: string; shellId: string };
  const entry = shellRegistry.get(shellId);
  if (!entry || entry.sessionId !== id) return reply.code(404).send({ error: "shell not found" });
  // Delete means kill + forget. A tombstone prevents an already-in-flight reconnect snapshot
  // from resurrecting the tab; collapsing the dock is a separate local detach action.
  hub.sendToRunner(entry.runnerId, { type: "shell_close", shellId });
  shellRegistry.remove(shellId, entry.runnerId, Date.now());
  hub.shellExit(entry.sessionId, shellId, null, entry.outputEndSeq);
  return reply.code(204).send();
});

app.post("/api/sessions/adopt", async (req, reply) => {
  const body = (req.body ?? {}) as { runnerId?: string; descriptor?: ExternalSessionDescriptor; backfill?: boolean };
  if (!body.runnerId || !body.descriptor?.agentSessionId) {
    return reply.code(400).send({ error: "runnerId and descriptor (with agentSessionId) are required" });
  }
  const r = await svc.adoptSession(body.runnerId, body.descriptor, body.backfill ?? true);
  if (!r.ok) return reply.code(r.status).send({ error: r.error });
  return reply.code(r.status).send(r.data);
});

// Re-import an adopted session: re-read its original CLI transcript with the current parser and
// replace the timeline, so formatting/parser improvements apply to already-adopted sessions.
app.post("/api/sessions/:id/reprocess", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const r = await svc.reprocessSession(id);
  if (!r.ok) return reply.code(r.status).send({ error: r.error });
  return reply.code(r.status).send(r.data);
});

/* --------------------------------- Boxes --------------------------------- */

app.get("/api/boxes", async () => ({ boxes: db.listBoxes() }));

// Offer the dashboard machine's ~/.ssh/config hosts for import in "Add a box". This reads the
// local user's ~/.ssh/config (host aliases, hostnames, users, ports) — sensitive inventory — so,
// like runner onboarding material, it's returned only to authenticated direct-loopback callers.
// A control plane bound beyond loopback must not let a remote client enumerate the dashboard
// host's SSH config even when that client has an ordinary paired-device credential.
app.get("/api/ssh-config-hosts", async (req) => ({ hosts: trustedLoopback(req) ? readSshConfigHosts() : [] }));

// Bootstrap a runner on a remote machine over SSH. Returns immediately with the box (status
// "bootstrapping"); progress streams to the UI via box_upsert messages.
app.post("/api/boxes", async (req, reply) => {
  const body = (req.body ?? {}) as AddBoxRequest;
  if (body.displayName !== undefined && typeof body.displayName !== "string") {
    return reply.code(400).send({ error: "displayName must be a string" });
  }
  const displayName = body.displayName?.trim() ?? "";
  if (displayName && !projectName(displayName)) {
    return reply.code(400).send({ error: "displayName must be 120 characters or fewer and contain no control characters" });
  }
  const sshTarget = (body.sshTarget ?? "").trim();
  // Reject anything that isn't a plain destination: a leading '-' would be read by ssh/scp as an
  // option, and whitespace/control chars are never valid in a user@host target.
  if (!sshTarget || sshTarget.startsWith("-") || /\s/.test(sshTarget)) {
    return reply.code(400).send({ error: "invalid sshTarget (expected user@host, no leading '-' or whitespace)" });
  }
  const sshPort = body.sshPort ?? 22;
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
    return reply.code(400).send({ error: "sshPort must be an integer between 1 and 65535" });
  }
  const boxId = `box-${randomUUID().slice(0, 8)}`;
  // Default the workspace to the box's home dir ("." resolves to $HOME over SSH) so an online box
  // can always run a session — an empty workspace list makes createSession() reject every request.
  const wsPath = body.workspacePath?.trim();
  const workspaces = wsPath
    ? [{ id: "workspace", name: "workspace", path: wsPath }]
    : [{ id: "home", name: "home", path: "." }];
  const principal = requestHuman(req) ?? localApiPrincipal().principal;
  const boxScope: ResourceScope = {
    organizationId: principal.organizationId,
    owner: { kind: "organization", organizationId: principal.organizationId },
  };
  db.createBox({
    boxId,
    runnerId: boxId,
    sshTarget,
    sshPort,
    workspaces,
    autoReconnect: true,
    runnerDataDir: managedBoxRunnerDataDir(boxId),
    scope: boxScope,
    now: Date.now(),
  });
  if (displayName) db.setMachineDisplayName(boxId, displayName);
  hub.boxChanged(boxId);
  orchestrator.add(boxId);
  return reply.code(201).send({ box: db.getBox(boxId) });
});

registerBoxLegacyAdoptionRoute(app, { db, orchestrator, requestHuman });

app.post("/api/boxes/:id/reconnect", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const box = db.getBox(id);
  if (!box) return reply.code(404).send({ error: "box not found" });
  const force = parseBoxLifecycleForce(req.body);
  if (!force.ok) return reply.code(400).send({ error: force.error });
  const principal = requestHuman(req) ?? localApiPrincipal().principal;
  const decision = decideScopedBoxLifecycle(
    db.listSessions({ includeArchived: true }),
    box.runnerId,
    force.force,
    "reconnect",
    (sessionId) => db.canAccessSession(principal, sessionId),
  );
  if (!decision.ok) return reply.code(409).send(decision.conflict);
  const result = await orchestrator.reconnect(id);
  if (result === "not_found") return reply.code(404).send({ error: "box not found" });
  if (result === "in_progress") return reply.code(409).send({ error: "another lifecycle operation is already stopping this box's managed runner" });
  if (result === "stop_failed") return reply.code(409).send({ error: "the managed runner could not be stopped; reconnect was not started" });
  if (result === "superseded") return reply.code(409).send({ error: "a newer box lifecycle operation superseded reconnect" });
  return { ok: true, forced: force.force };
});

// "Update runner": resolve and hash the exact candidate before interrupting work. An identical
// candidate is reported as already current without reconnecting. A changed candidate is then
// session-gated and handed to the normal reconnect/bootstrap path, which deploys by content hash.
// Resolution errors surface here while the currently running box remains untouched.
app.post("/api/boxes/:id/update-runner", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const box = db.getBox(id);
  if (!box) return reply.code(404).send({ error: "box not found" });
  const force = parseBoxLifecycleForce(req.body);
  if (!force.ok) return reply.code(400).send({ error: force.error });
  let prepared: Awaited<ReturnType<typeof orchestrator.prepareRunnerUpdate>>;
  try {
    prepared = await orchestrator.prepareRunnerUpdate(id);
  } catch (err) {
    return reply.code(502).send({ error: (err as Error).message });
  }
  if (!prepared) return reply.code(404).send({ error: "box not found" });
  if (prepared.status === "already_current") {
    return {
      ok: true,
      status: prepared.status,
      expectedVersion: prepared.expectedVersion,
      source: prepared.source,
      triple: prepared.triple,
      releaseTag: RUNNER_RELEASE_TAG,
    };
  }
  const principal = requestHuman(req) ?? localApiPrincipal().principal;
  const decision = decideScopedBoxLifecycle(
    db.listSessions({ includeArchived: true }),
    box.runnerId,
    force.force,
    "update",
    (sessionId) => db.canAccessSession(principal, sessionId),
  );
  if (!decision.ok) return reply.code(409).send(decision.conflict);
  const status = await orchestrator.startPreparedRunnerUpdate(prepared);
  if (status === "in_progress") {
    return reply.code(409).send({ error: "another lifecycle operation is already stopping this box's managed runner" });
  }
  if (status === "stop_failed") {
    return reply.code(409).send({ error: "the managed runner could not be stopped; update was not started" });
  }
  return {
    ok: true,
    status,
    forced: force.force,
    expectedVersion: prepared.expectedVersion,
    source: prepared.source,
    triple: prepared.triple,
    releaseTag: RUNNER_RELEASE_TAG,
  };
});

app.delete("/api/boxes/:id", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const box = db.getBox(id);
  if (box && db.boxHasPendingLegacyDataAdoption(id)) {
    return reply.code(409).send({
      error: "this Machine cannot be deleted while its legacy SSH account adoption is pending",
      code: "LEGACY_DATA_ADOPTION_PENDING",
    });
  }
  const projectIds = box ? db.projectIdsForRunner(box.runnerId) : [];
  orchestrator.remove(id);
  const res = db.deleteBox(id);
  if (!res) return reply.code(404).send({ error: "box not found" });
  for (const sid of res.sessionIds) hub.sessionRemoved(sid, false);
  for (const rid of res.runIds) hub.runRemoved(rid);
  for (const podId of res.podIds) {
    const pod = db.reconcilePodAfterMembershipLoss(podId, Date.now());
    if (pod) hub.podChanged(pod);
  }
  hub.boxRemoved(id);
  hub.runnerRemoved(res.runnerId);
  for (const projectId of projectIds) hub.projectChangedById(projectId);
  return reply.code(204).send();
});

app.get("/api/sessions", async (req) => {
  const includeArchived = (req.query as { archived?: string })?.archived === "true";
  const principal = requestPrincipal(req);
  return { sessions: principal ? db.listSessionsForPrincipal(principal, includeArchived) : [] };
});

registerSessionLookupRoute(app, { db, requestPrincipal });

app.get("/api/sessions/:id", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const session = db.getSession(id);
  if (!session) return reply.code(404).send({ error: "session not found" });
  return { session };
});

app.get("/api/sessions/:id/side-chat", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const result = svc.sideChat(id);
  if (!result.ok) return respond(reply, result);
  return { sideChat: result.data ?? null };
});

app.post("/api/sessions/:id/side-chat", async (req, reply) =>
  respond(reply, svc.createSideChat((req.params as { id: string }).id)),
);

app.get("/api/sessions/:id/events", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const query = req.query as { after?: string; limit?: string; eventEpoch?: string };
  const after = Number(query.after ?? 0);
  if (query.limit === undefined) {
    await svc.hydrateHistory(id);
    return { events: db.listEvents(id, after) };
  }
  const limit = Number(query.limit);
  const requestedEpoch = Number(query.eventEpoch);
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
      !Number.isSafeInteger(requestedEpoch) || requestedEpoch < 0) {
    return reply.code(400).send({
      error: "after, eventEpoch, and limit must be bounded non-negative integers",
      code: "invalid_history_page",
    });
  }
  const session = db.getSession(id);
  const state = db.getRunnerHistoryState(id);
  if (!session || !state) return reply.code(404).send({ error: "session not found" });
  if (requestedEpoch !== state.eventEpoch) {
    return reply.code(409).send({
      error: "session event history was replaced",
      code: "stale_event_epoch",
      eventEpoch: state.eventEpoch,
    });
  }
  const page = db.listCachedEventPage(id, after, limit);
  void svc.hydrateHistory(id);
  const indexed = runnerSupportsProtocol(db.getRunner(session.runnerId)?.protocolVersion, "indexedHistory");
  const cacheComplete = indexed ? state.complete : state.hydratedSeq >= state.tailSeq;
  return {
    events: page.events,
    eventEpoch: state.eventEpoch,
    nextAfter: page.nextAfterSeq,
    hasMoreCached: page.hasMore,
    cacheComplete,
  };
});

app.get("/api/sessions/:id/export", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const format = (req.query as { format?: string }).format;
  if (format !== "json" && format !== "markdown") {
    return reply.code(400).send({ error: "format must be json or markdown", code: "invalid_format" });
  }
  // Authorization has already resolved this canonical session route through canAccessSession.
  // Export only the frozen CP cache; do not invoke the runner's currently-unbounded history RPC.
  const principal = requestPrincipal(req);
  if (!principal) return reply.code(401).send({ error: "authentication required" });
  const result = buildAuthorizedSessionTranscriptExport(db, principal, id, format as TranscriptExportFormat);
  if (!result.ok) return reply.code(result.status).send({ error: result.error, code: result.code });
  return reply.headers(result.headers).send(result.body);
});

app.get("/api/sessions/:id/transcript-shares", async (req, reply) => {
  const principal = requestHuman(req);
  if (!principal) return reply.code(401).send({ error: "authentication required" });
  const result = listAuthorizedTranscriptShares(db, principal, (req.params as { id: string }).id);
  if (!result.ok) return reply.code(result.status).send({ error: result.error, code: result.code });
  return reply.header("cache-control", "private, no-store").send({ shares: result.value });
});

app.post("/api/sessions/:id/transcript-shares", async (req, reply) => {
  const principal = requestHuman(req);
  if (!principal) return reply.code(401).send({ error: "authentication required" });
  const result = createAuthorizedTranscriptShare(
    db,
    principal,
    (req.params as { id: string }).id,
    req.body,
  );
  if (!result.ok) return reply.code(result.status).send({ error: result.error, code: result.code });
  return reply
    .headers({ "cache-control": "private, no-store", pragma: "no-cache" })
    .code(201)
    .send(result.value);
});

app.delete("/api/sessions/:id/transcript-shares/:shareId", async (req, reply) => {
  const principal = requestHuman(req);
  if (!principal) return reply.code(401).send({ error: "authentication required" });
  const { id, shareId } = req.params as { id: string; shareId: string };
  const result = revokeAuthorizedTranscriptShare(db, principal, id, shareId);
  if (!result.ok) return reply.code(result.status).send({ error: result.error, code: result.code });
  return reply.header("cache-control", "private, no-store").send({ share: result.value });
});

// Exact auth-gate exception: this read still requires its independent share capability.
registerPublicTranscriptShareRoute(app, { db });

app.get("/api/sessions/:id/review-findings", async (req, reply) =>
  respond(reply, svc.reviewFindings((req.params as { id: string }).id)),
);

app.post("/api/sessions/:id/review-findings", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  return respond(reply, svc.createReviewFinding(id, req.body, { kind: "human", id: humanActorId(req) }));
});

app.patch("/api/sessions/:id/review-findings/:findingId", async (req, reply) => {
  const { id, findingId } = req.params as { id: string; findingId: string };
  return respond(reply, svc.updateReviewFinding(id, findingId, req.body, { kind: "human", id: humanActorId(req) }));
});

app.post("/api/sessions/:id/review-findings/bundle", async (req, reply) =>
  respond(reply, svc.bundleReviewFindings((req.params as { id: string }).id, req.body)),
);

app.post("/api/sessions", async (req, reply) => {
  const principal = requestHuman(req);
  const body = req.body as CreateSessionRequest;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return reply.code(400).send({ error: "session request is required" });
  }
  if (body.launchSurface !== undefined && body.launchSurface !== "direct" && body.launchSurface !== "native_tui") {
    return reply.code(400).send({ error: "launchSurface must be direct or native_tui" });
  }
  const ownership = resolveSessionCreationOwnership(db, principal, body);
  if (!ownership.ok) return reply.code(ownership.status).send({ error: ownership.error });
  const launchError = nativeTuiCreationError(db, hub, ownership.body);
  if (launchError) return reply.code(launchError.status).send({ error: launchError.error });
  const initialNativeTui = ownership.body.launchSurface === "native_tui";
  const created = svc.createSession(ownership.body, undefined, ownership.scope, initialNativeTui);
  if (!created.ok || !created.data || ownership.body.launchSurface !== "native_tui") return respond(reply, created);
  const sessionId = created.data.id;
  const opened = await openNativeTuiAtomically(
    sessionId,
    () => openSessionShell(
      sessionId,
      { kind: "agent_tui", cols: 120, rows: 30 },
      { initialNativeTui: true },
    ),
    (id) => svc.delete(id),
  );
  if (!opened.ok) {
    if (opened.retainedSession) {
      return reply.code(opened.status).send({
        error: `${opened.error ?? "Native TUI launch failed and session cleanup did not complete"}. Session ${sessionId} was retained; open it instead of creating another session.`,
        code: "NATIVE_TUI_COMPENSATION_FAILED",
        sessionId,
      });
    }
    if (opened.definitive === false) {
      return reply.code(opened.status).send({
        error: `Session ${sessionId} was retained because the Native TUI launch outcome is unknown. Open that session and retry Agent TUI from Terminal; do not create another session.`,
        code: "NATIVE_TUI_LAUNCH_AMBIGUOUS",
        sessionId,
      });
    }
    return reply.code(opened.status).send({ error: opened.error });
  }
  return respond(reply, { ...created, data: db.getSession(sessionId) ?? created.data });
});

app.post("/api/sessions/:id/prompt", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const body = req.body as PromptRequest;
  const text = body?.text?.trim() ?? "";
  const images = body?.images ?? [];
  const slashCommand = body?.slashCommand;
  if (!text && images.length === 0 && !slashCommand) {
    return reply.code(400).send({ error: "text, an image, or a slash command is required" });
  }
  return respond(reply, svc.prompt(id, text, images, slashCommand, body?.config));
});

app.post("/api/sessions/:id/command-invocations", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  return respond(reply, svc.invokeSessionCommand(id, req.body as InvokeSessionCommandRequest));
});

app.post("/api/sessions/:id/steer", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  return respond(reply, await svc.steer(id, req.body as SteerRequest));
});

app.post("/api/sessions/:id/steering/:submissionId/resolve", async (req, reply) => {
  const { id, submissionId } = req.params as { id: string; submissionId: string };
  const body = (req.body ?? {}) as { action?: unknown };
  if (body.action !== "queue_again" && body.action !== "dismiss") {
    return reply.code(400).send({ error: "action must be queue_again or dismiss" });
  }
  return respond(reply, await svc.resolveSteeringAttempt(id, submissionId, body.action));
});

app.post("/api/sessions/:id/project", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const body = (req.body ?? {}) as Partial<SetProjectRequest>;
  if (!("projectId" in body)) return reply.code(400).send({ error: "projectId is required" });
  if (body.projectId !== null && (typeof body.projectId !== "string" || !body.projectId.trim())) {
    return reply.code(400).send({ error: "projectId must be a non-empty string or null" });
  }
  if (body.linkLocation !== undefined && typeof body.linkLocation !== "boolean") {
    return reply.code(400).send({ error: "linkLocation must be a boolean" });
  }
  if (body.linkLocation && body.projectId === null) {
    return reply.code(400).send({ error: "linkLocation requires a target Project" });
  }
  const principal = requestHuman(req);
  if (!principal) return reply.code(403).send({ error: "human identity is required" });
  if (typeof body.projectId === "string" && !db.canAccessProject(principal, body.projectId)) {
    return reply.code(404).send({ error: "project not found" });
  }
  if (body.linkLocation && typeof body.projectId === "string" &&
      !db.canManageProject(principal, body.projectId)) {
    return reply.code(403).send({ error: "Project management permission is required to link a Location" });
  }
  if (body.linkLocation) {
    const session = db.getSession(id);
    const reusedWorkspaceId = session ? db.resolveAdoptedSessionLinkWorkspace(id)?.workspaceId : null;
    if (reusedWorkspaceId && session &&
        !db.canAccessWorkspace(principal, session.runnerId, reusedWorkspaceId)) {
      return reply.code(404).send({ error: "workspace not found" });
    }
  }
  if (!canAssignSessionProject(db, principal, id, body.projectId as string | null)) {
    return reply.code(403).send({
      error: "Project management permission or personal session ownership is required",
    });
  }
  return respond(reply, svc.setProject(
    id,
    body.projectId as string | null,
    principal.userId,
    { linkLocation: body.linkLocation },
  ));
});

app.post("/api/sessions/:id/stop", async (req, reply) =>
  respond(reply, svc.stop((req.params as { id: string }).id)),
);

app.post("/api/sessions/:id/cancel", async (req, reply) =>
  respond(reply, await svc.cancelTurn((req.params as { id: string }).id)),
);

app.post("/api/sessions/:id/restart", async (req, reply) =>
  respond(reply, svc.restart((req.params as { id: string }).id)),
);

app.post("/api/sessions/:id/logout-agent", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const session = db.getSession(id);
  if (!session) return reply.code(404).send({ error: "session not found" });
  if (session.driver !== "acp") return reply.code(409).send({ error: "only ACP sessions support in-app logout" });
  if (!hub.isRunnerOnline(session.runnerId)) return reply.code(409).send({ error: "runner is offline" });
  const unsupported = runnerCapabilityError(session.runnerId, "acpLogout", "ACP logout");
  if (unsupported) return reply.code(409).send({ error: unsupported });
  const requestId = `logout_${randomUUID().slice(0, 8)}`;
  try {
    const result = await hub.requestFromRunner(
      session.runnerId,
      requestId,
      { type: "logout_agent", requestId, sessionId: id },
      30_000,
    );
    if (result.type !== "logout_agent_result") return reply.code(502).send({ error: "unexpected runner reply" });
    if (!result.ok) return reply.code(409).send({ error: result.error ?? "agent logout failed" });
    return { ok: true };
  } catch (error) {
    return reply.code(504).send({ error: (error as Error).message });
  }
});

app.post("/api/sessions/:id/policy-hook", { bodyLimit: 128 * 1024 }, async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const sessionHeader = selectCompatibleHeader(
    req.headers,
    WOLLIPOG_POLICY_HOOK_SESSION_HEADER,
    LEGACY_POLICY_HOOK_SESSION_HEADER,
  );
  const pollHeader = selectCompatibleHeader(
    req.headers,
    WOLLIPOG_POLICY_HOOK_POLL_CAPABILITY_HEADER,
    LEGACY_POLICY_HOOK_POLL_CAPABILITY_HEADER,
  );
  if (!sessionHeader.ok || sessionHeader.value !== id) {
    return reply.code(403).send({ error: "policy hook session claim does not match the route" });
  }
  if (!pollHeader.ok) return reply.code(403).send({ error: "policy hook capability headers conflict" });
  return respond(reply, svc.evaluatePolicyHook(
    id,
    req.body,
    pollHeader.value === POLICY_HOOK_POLL_CAPABILITY,
  ));
});

app.post("/api/sessions/:id/approve", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const body = req.body as ApproveRequest;
  return respond(reply, svc.approve(id, body.requestId, body.optionId ?? null, {
    kind: "human",
    id: humanActorId(req),
  }));
});

app.get("/api/sessions/:id/governance-audit", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const rawLimit = (req.query as { limit?: string }).limit;
  const limit = rawLimit == null ? 200 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return reply.code(400).send({ error: "limit must be an integer between 1 and 500" });
  }
  return { entries: svc.governanceAudit(id, limit) };
});

app.get("/api/governance/policies", async () => ({ policies: svc.governancePolicies() }));

app.put("/api/governance/policies/:policyId", async (req, reply) => {
  const policyId = (req.params as { policyId: string }).policyId;
  const body = req.body as Omit<GovernancePolicy, "createdAt" | "updatedAt">;
  if (body?.policyId !== policyId) return reply.code(400).send({ error: "path and body policyId must match" });
  return respond(reply, svc.upsertGovernancePolicy(body));
});

app.delete("/api/governance/policies/:policyId", async (req, reply) =>
  respond(reply, svc.deleteGovernancePolicy((req.params as { policyId: string }).policyId)),
);

app.get("/api/governance/approval-queue", async () => ({ items: svc.approvalQueue() }));

app.get("/api/governance/review-queue", async () => ({ items: await svc.reviewQueue() }));

app.post("/api/governance/approval-queue/reject", async (req, reply) => {
  const body = req.body as ApprovalQueueRejectRequest;
  return respond(reply, svc.rejectApprovalQueue(body?.items, {
    kind: "human",
    id: humanActorId(req),
  }));
});

// Full-text transcript search (Cmd+K palette). Hits carry the owning session's title so the
// palette renders without a per-hit lookup.
app.get("/api/search", async (req, reply) => {
  const q = String((req.query as { q?: string })?.q ?? "").trim();
  if (q.length < 2) return reply.code(400).send({ error: "q must be at least 2 characters" });
  // Bound the work: FTS parsing/ranking runs synchronously on this thread.
  if (q.length > 256) return reply.code(400).send({ error: "q is too long (max 256 characters)" });
  const hits = db.searchEvents(q, 20);
  const results = hits.flatMap((h) => {
    const session = db.getSession(h.sessionId);
    // Archived sessions are absent from the UI snapshot — a hit would navigate to
    // "Session Not Found". Filter them (matches the palette's local session matching).
    return session && !session.archived
      ? [{ ...h, title: session.title, workspaceName: session.workspaceName }]
      : [];
  });
  return { results };
});

// Content-free operational aggregates used to judge driver rollout/retirement readiness.
app.get("/api/telemetry/drivers", async (req, reply) => {
  const days = telemetryWindowDays((req.query as { days?: string })?.days);
  if (days == null) {
    return reply.code(400).send({ error: "days must be between 1 and 90" });
  }
  return {
    days,
    privacy: "hourly aggregates only; no session ids, prompts, tool inputs, paths, environment values, or auth data",
    aggregates: db.summarizeDriverTelemetry(Date.now() - days * 86_400_000),
  };
});

// Content-free, observation-time usage accounting. Human members see only frozen ownership
// scopes they may access; conductor credentials are deliberately excluded from this surface.
registerUsageRoutes(app, db, requestPrincipal);

// Per-turn checkpoint rewind (T3-style, files only — the conversation continues). The runner
// re-checks authoritatively (turn running, checkpoint exists); guards here fail fast.
app.post("/api/sessions/:id/rewind", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const turn = Number((req.body as { turn?: number })?.turn);
  if (!Number.isInteger(turn) || turn < 1) return reply.code(400).send({ error: "turn must be a positive integer" });
  const session = db.getSession(id);
  if (!session) return reply.code(404).send({ error: "session not found" });
  const reconciliationBlock = svc.podReconciliationMutationError(id);
  if (reconciliationBlock) return reply.code(409).send({ error: reconciliationBlock });
  if (!session.worktreePath) return reply.code(409).send({ error: "rewind requires a worktree session" });
  if (session.status === "running" || session.status === "starting") {
    return reply.code(409).send({ error: "a turn is running — stop or wait before rewinding" });
  }
  if (!hub.isRunnerOnline(session.runnerId)) return reply.code(409).send({ error: "runner is offline" });
  // Persisted checkpoint events can outlive a runner downgrade — a pre-v25 runner ignores the
  // unknown command and the caller would eat a 30s timeout instead of a clear failure.
  const unsupported = runnerCapabilityError(session.runnerId, "checkpointRewind", "Checkpoint rewind");
  if (unsupported) return reply.code(409).send({ error: unsupported });
  const requestId = `rew_${randomUUID().slice(0, 8)}`;
  try {
    const res = await hub.requestFromRunner(
      session.runnerId,
      requestId,
      { type: "rewind_session", requestId, sessionId: id, turn, timeoutMs: 30_000 },
      30_000,
    );
    if (res.type !== "rewind_result") return reply.code(502).send({ error: "unexpected runner reply" });
    if (!res.ok) return reply.code(409).send({ error: res.error ?? "rewind failed" });
    return { ok: true };
  } catch (err) {
    return reply.code(502).send({ error: (err as Error).message });
  }
});

// Provider-native conversation fork: the runner owns both the provider transcript and git object
// database, so it creates the target atomically enough to return a complete box snapshot.
app.post("/api/sessions/:id/fork", async (req, reply) => {
  const sourceId = (req.params as { id: string }).id;
  const reconciliationBlock = svc.podReconciliationMutationError(sourceId);
  if (reconciliationBlock) return reply.code(409).send({ error: reconciliationBlock });
  const turn = Number((req.body as { turn?: number })?.turn);
  if (!Number.isInteger(turn) || turn < 1) return reply.code(400).send({ error: "turn must be a positive integer" });
  const source = db.getSession(sourceId);
  if (!source) return reply.code(404).send({ error: "session not found" });
  const sourceScope = db.sessionScope(sourceId);
  if (!sourceScope) return reply.code(409).send({ error: "source session ownership is unavailable" });
  const sourceAgent = db.getRunner(source.runnerId)?.agents.find((agent) => agent.id === source.agentId);
  const supportsFork = providerSupportsConversationFork(source.driver, sourceAgent?.capabilities);
  if (!supportsFork) return reply.code(409).send({ error: "this provider session does not support conversation fork" });
  if (!source.worktreePath) return reply.code(409).send({ error: "conversation fork requires a worktree session" });
  if (sessionBlocksConversationFork(source.status)) {
    return reply.code(409).send({ error: "the source session is busy — wait before forking" });
  }
  if (!hub.isRunnerOnline(source.runnerId)) return reply.code(409).send({ error: "runner is offline" });
  const unsupported = runnerCapabilityError(source.runnerId, "conversationFork", "Conversation forks");
  if (unsupported) return reply.code(409).send({ error: unsupported });
  const deferHistory = runnerSupportsProtocol(db.getRunner(source.runnerId)?.protocolVersion, "indexedHistory");
  const sourceExecutionWorkspacePath = db.getAdHocWorkspacePath(sourceId);
  const targetSessionId = `s_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const requestId = `fork_${randomUUID().slice(0, 8)}`;
  let forkCreatedOnRunner = false;
  try {
    const res = await hub.requestFromRunner(
      source.runnerId,
      requestId,
      {
        type: "fork_session",
        requestId,
        sourceSessionId: sourceId,
        targetSessionId,
        turn,
        title: `${source.title} (fork)`.slice(0, 120),
        ...(deferHistory ? { deferHistory: true } : {}),
      },
      150_000,
    );
    if (res.type !== "fork_result") return reply.code(502).send({ error: "unexpected runner reply" });
    if (!res.ok || !res.snapshot) return reply.code(409).send({ error: res.error ?? "conversation fork failed" });
    const snapshotIdError = providerForkSnapshotIdError(targetSessionId, res.snapshot.id);
    if (snapshotIdError) {
      forkCreatedOnRunner = true;
      throw new Error(snapshotIdError);
    }
    forkCreatedOnRunner = true;
    const forkIdentityError = forkSnapshotIdentityError(
      { ...source, executionWorkspacePath: sourceExecutionWorkspacePath },
      res.snapshot,
    );
    if (forkIdentityError) throw new Error(forkIdentityError);
    const now = Date.now();
    const activeSourceLocation = source.projectLocationId
      ? db.projectLocation(source.projectLocationId)
      : null;
    const inheritedProject = forkProjectAssignment(source, activeSourceLocation, res.snapshot.workspaceId);
    const session = db.createSessionFromSnapshot(
      res.snapshot,
      source.runnerId,
      now,
      sourceScope,
      inheritedProject,
      { sourceSessionId: sourceId, sourceTurn: turn },
    );
    let highWater = 0;
    for (const event of deferHistory ? [] : (res.events ?? [])) {
      db.appendEvent(targetSessionId, event.payload, event.ts);
      highWater = event.seq;
    }
    db.setHydratedSeq(targetSessionId, highWater);
    hub.sessionChangedById(session.id);
    if (deferHistory) void svc.hydrateHistory(targetSessionId);
    return reply.code(201).send(db.getSession(targetSessionId));
  } catch (err) {
    const timedOut = isRunnerRequestTimeoutError(err);
    const cleanupTargetSessionId = providerForkCleanupTarget(targetSessionId, forkCreatedOnRunner, timedOut);
    if (cleanupTargetSessionId) {
      // A timeout or malformed reply does not prove the runner failed before creating the fork.
      // Retain this tombstone across absent reconnect snapshots so a later-created target cannot
      // be adopted as an unassigned session.
      db.addTombstone(cleanupTargetSessionId, source.runnerId, Date.now(), "retain");
      hub.sendToRunner(source.runnerId, { type: "delete_session", sessionId: cleanupTargetSessionId });
      if (db.getSession(cleanupTargetSessionId)) {
        db.deleteSession(cleanupTargetSessionId);
        hub.sessionRemoved(cleanupTargetSessionId);
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    if (timedOut) {
      return reply.code(409).send({
        error: "the fork timed out and was discarded — retry when the runner is responsive",
      });
    }
    return reply.code(502).send({ error: message });
  }
});

// Structured agent questions (AskUserQuestion): a sibling of /approve because the shapes
// differ — N answers keyed by question id vs one optionId decision.
app.post("/api/sessions/:id/answer", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const body = req.body as { requestId?: string; answers?: Record<string, string | string[]> };
  if (typeof body?.requestId !== "string" || body.answers == null || typeof body.answers !== "object") {
    return reply.code(400).send({ error: "requestId and answers are required" });
  }
  return respond(reply, svc.answerQuestion(id, body.requestId, body.answers, {
    kind: "human",
    id: humanActorId(req),
  }));
});

// Git/PR workflow: run a git action (status/commit/open_pr) in the session's
// worktree on its runner, and return the result. Requires a worktree session.
app.post("/api/sessions/:id/git", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const session = db.getSession(id);
  if (!session) return reply.code(404).send({ error: "session not found" });
  if (!hub.isRunnerOnline(session.runnerId)) return reply.code(409).send({ error: "runner is offline" });

  const parsed = parseGitAction((req.body ?? {}) as GitActionRequest);
  if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
  const { action } = parsed;
  if (!session.worktreePath && gitActionRequiresLinkedWorktree(action)) {
    return reply.code(409).send({ error: "this git action requires a linked worktree session" });
  }
  if (!session.worktreePath) {
    const unsupported = runnerCapabilityError(
      session.runnerId,
      "gitVisibility",
      "Primary-checkout Git visibility",
    );
    if (unsupported) return reply.code(409).send({ error: unsupported });
  }
  const gitCapability = gitActionCapability(action);
  if (gitCapability) {
    const unsupported = runnerCapabilityError(session.runnerId, ...gitCapability);
    if (unsupported) return reply.code(409).send({ error: unsupported });
  }

  // Branch-relative diffs (all_branch / last_turn) only make sense on a worktree session; a
  // WSL in-place session has no session branch to diff against. (uncommitted reads are fine —
  // and today the worktreePath gate above already limits every git action to worktree sessions.)
  if (action.kind === "diff" && action.scope !== "uncommitted" && !session.useWorktree) {
    return reply.code(400).send({ error: `the '${action.scope}' diff scope requires a worktree session` });
  }

  // Don't mutate git mid-turn: a commit/PR while the agent is still editing would
  // capture a partial snapshot and can race the post-turn diff capture.
  const gate = gitActionAllowed(action, session.status);
  if (!gate.ok) return reply.code(409).send({ error: gate.error });
  if (!["status", "summary", "diff", "github_review_sync"].includes(action.kind)) {
    const reconciliationBlock = svc.podReconciliationMutationError(id);
    if (reconciliationBlock) return reply.code(409).send({ error: reconciliationBlock });
  }

  const requestId = randomUUID();
  // Pushing + calling gh takes longer than a quick status read.
  const timeoutMs = action.kind === "open_pr" || action.kind === "github_review_sync" ? 60_000 : 30_000;
  try {
    const result = await hub.requestFromRunner(
      session.runnerId,
      requestId,
      // timeoutMs rides along so the runner can EXPIRE a queued mutation we've already
      // reported as failed, instead of executing it late (ghost commits).
      {
        type: "git_action",
        requestId,
        sessionId: id,
        ...(session.worktreePath ? { worktreePath: session.worktreePath } : {}),
        action,
        timeoutMs,
      },
      timeoutMs,
    );
    if (result.type !== "git_result") return reply.code(502).send({ error: "unexpected runner reply" });
    if (!result.ok) {
      // Typed Git failures are well-formed requests conflicting with current repository state —
      // 409, with the code so callers can distinguish stale/apply/no-repository outcomes.
      const status = result.code === "GIT_STALE" || result.code === "GIT_APPLY_FAILED" || result.code === "GIT_NO_REPOSITORY" ? 409 : 400;
      return reply.code(status).send({ error: result.error ?? "git action failed", ...(result.code ? { code: result.code } : {}) });
    }
    // Version-skew guard: an older runner without the action falls through its switch and
    // replies ok:true with empty data — forwarding that as 200 would render a mutation as a
    // silent no-op "success" in the UI. Every local diff mutation returns {status, diff}.
    if (["stage_hunk", "stage_lines", "discard_file"].includes(action.kind) &&
        (result.data?.status == null || result.data?.diff == null)) {
      return reply.code(502).send({ error: "the runner does not support this diff mutation — update the runner on this box" });
    }
    if (action.kind === "github_review_sync") {
      if (!validateGitHubReviewSync(result.data?.githubReview)) {
        return reply.code(502).send({ error: "the runner did not return GitHub review data — update the runner on this box" });
      }
      const reconciled = svc.reconcileGitHubReviewFindings(id, result.data.githubReview);
      if (!reconciled.ok || !reconciled.data) {
        return reply.code(reconciled.status).send({ error: reconciled.error ?? "GitHub reviews could not be reconciled" });
      }
      const { reconciliation, findings, summary } = reconciled.data;
      return {
        ...result.data,
        reviewFindings: { findings, summary },
        reviewReconciliation: reconciliation,
      };
    }
    return result.data ?? {};
  } catch (err) {
    return reply.code(504).send({ error: (err as Error).message });
  }
});

// Host actions: open the session's working directory in a local editor on the runner host,
// or reveal it in the OS file manager. Fire-and-forget on the host; we only await the launch.
app.post("/api/sessions/:id/host-action", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const session = db.getSession(id);
  if (!session) return reply.code(404).send({ error: "session not found" });
  if (!hub.isRunnerOnline(session.runnerId)) return reply.code(409).send({ error: "runner is offline" });

  const parsed = parseSessionHostAction(req.body ?? {});
  if (!parsed) {
    return reply.code(400).send({ error: "invalid host action; precise editor locations require a canonical root-relative path" });
  }
  const label = parsed.capability === "editorLocations" ? "Precise editor locations" : "Host editor and file-manager actions";
  const unsupported = runnerCapabilityError(session.runnerId, parsed.capability, label);
  if (unsupported) return reply.code(409).send({ error: unsupported });
  if (parsed.action.kind === "open_editor_location") {
    const locationAction = parsed.action;
    const editor = db.getRunner(session.runnerId)?.editors?.find((candidate) => candidate.id === locationAction.editorId);
    if (!editorAdvertisesLocation(editor, locationAction)) {
      return reply.code(409).send({ error: "that editor does not advertise the requested source-location precision" });
    }
  }

  const requestId = randomUUID();
  try {
    const result = await hub.requestFromRunner(
      session.runnerId,
      requestId,
      { type: "host_action", requestId, sessionId: id, action: parsed.action },
      10_000,
    );
    if (result.type !== "host_action_result") return reply.code(502).send({ error: "unexpected runner reply" });
    if (!result.ok) return reply.code(400).send({ error: result.error ?? "host action failed" });
    return { ok: true };
  } catch (err) {
    // A pre-v22 runner never answers the unknown message — surface a clear hint over a bare timeout.
    return reply.code(504).send({ error: `${(err as Error).message} (the runner may be too old for host actions)` });
  }
});

// Create a project ("New project"). CP-owned workspace persisted in workspace_extras so it
// survives runner re-registers. Requires the runner online — the path was browsed on its host.
app.post("/api/runners/:runnerId/workspaces", async (req, reply) => {
  const { runnerId } = req.params as { runnerId: string };
  const body = (req.body ?? {}) as { name?: unknown; path?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const path = typeof body.path === "string" ? body.path.trim() : "";
  if (!name || !path) return reply.code(400).send({ error: "name and path are required" });
  if (!db.getRunner(runnerId)) return reply.code(404).send({ error: "runner not found" });
  if (!hub.isRunnerOnline(runnerId)) return reply.code(409).send({ error: "runner is offline" });
  const principal = requestHuman(req);
  const scope: ResourceScope | undefined = principal ? {
    organizationId: principal.organizationId,
    owner: { kind: "user", userId: principal.userId },
  } : undefined;
  const workspace = db.createWorkspace(runnerId, { name, path }, scope);
  hub.runnerChanged(runnerId);
  for (const projectId of db.projectIdsForWorkspace(runnerId, workspace.id)) {
    hub.projectChangedById(projectId);
  }
  return { workspace };
});

app.get("/api/runners/:runnerId/workspaces/:workspaceId/access-scope", async (req, reply) => {
  const { runnerId, workspaceId } = req.params as { runnerId: string; workspaceId: string };
  const principal = requestHuman(req);
  if (!principal) return reply.code(403).send({ error: "human identity is required" });
  if (!db.canManageWorkspace(principal, runnerId, workspaceId)) {
    return reply.code(404).send({ error: "workspace not found" });
  }
  const requested = requestedAccessScope(principal, accessScopeOwnerFromQuery(req.query));
  if (!requested.ok) return reply.code(requested.status).send({ error: requested.error });
  const currentScope = db.workspaceScope(runnerId, workspaceId);
  if (!currentScope) return reply.code(404).send({ error: "workspace not found" });
  const transitionError = accessScopeTransitionError(principal, currentScope, requested.scope);
  if (transitionError) return reply.code(403).send({ error: transitionError });
  const preview = db.previewWorkspaceAccessScope(runnerId, workspaceId, requested.scope);
  return preview
    ? { preview: accessScopePreviewForPrincipal(principal, preview) }
    : reply.code(404).send({ error: "workspace not found" });
});

app.put("/api/runners/:runnerId/workspaces/:workspaceId/access-scope", async (req, reply) => {
  const { runnerId, workspaceId } = req.params as { runnerId: string; workspaceId: string };
  const principal = requestHuman(req);
  if (!principal) return reply.code(403).send({ error: "human identity is required" });
  if (!db.canManageWorkspace(principal, runnerId, workspaceId)) {
    return reply.code(404).send({ error: "workspace not found" });
  }
  const body = (req.body ?? {}) as { owner?: unknown; confirmationToken?: unknown };
  const requested = requestedAccessScope(principal, body.owner);
  if (!requested.ok) return reply.code(requested.status).send({ error: requested.error });
  const currentScope = db.workspaceScope(runnerId, workspaceId);
  if (!currentScope) return reply.code(404).send({ error: "workspace not found" });
  const transitionError = accessScopeTransitionError(principal, currentScope, requested.scope);
  if (transitionError) return reply.code(403).send({ error: transitionError });
  if (typeof body.confirmationToken !== "string" || !/^[a-f0-9]{64}$/u.test(body.confirmationToken)) {
    return reply.code(400).send({ error: "a valid access-scope confirmation token is required" });
  }
  try {
    const preview = db.applyWorkspaceAccessScope(
      runnerId,
      workspaceId,
      requested.scope,
      body.confirmationToken,
      Date.now(),
      { principal, mutationAuditId: requestMutationAudits.get(req) },
    );
    if (!preview) return reply.code(404).send({ error: "workspace not found" });
    hub.closeScopedUiClients();
    hub.synchronizeProjectSessionState();
    hub.runnerChanged(runnerId);
    for (const project of preview.affectedProjects) hub.projectChangedById(project.projectId);
    const workspace = db.listRunnersForPrincipal(principal)
      .find((runner) => runner.runnerId === runnerId)?.workspaces.find((item) => item.id === workspaceId);
    return { workspace, preview: accessScopePreviewForPrincipal(principal, preview) };
  } catch (error) {
    return reply.code(409).send({ error: error instanceof Error ? error.message : "location access update failed" });
  }
});

// Rename a project (workspace display name). CP-owned override — the runner's own config
// name stays untouched and the override survives re-registers. Empty name resets it.
app.post("/api/runners/:runnerId/workspaces/register", async (req, reply) => {
  const { runnerId } = req.params as { runnerId: string };
  const body = (req.body ?? {}) as { name?: unknown; path?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const path = typeof body.path === "string" ? body.path.trim() : "";
  if (!name || !path) return reply.code(400).send({ error: "name and path are required" });
  if (!db.getRunner(runnerId)) return reply.code(404).send({ error: "runner not found" });
  if (!hub.isRunnerOnline(runnerId)) return reply.code(409).send({ error: "runner is offline" });
  const principal = requestHuman(req);
  const scope: ResourceScope | undefined = principal ? {
    organizationId: principal.organizationId,
    owner: { kind: "user", userId: principal.userId },
  } : undefined;
  try {
    const workspace = db.registerMachineWorkspace(runnerId, { name, path }, scope);
    hub.runnerChanged(runnerId);
    return { workspace };
  } catch (error) {
    const message = (error as Error).message;
    return reply.code(message.includes("already registered") ? 409 : 400).send({ error: message });
  }
});

app.post("/api/runners/:runnerId/workspaces/:workspaceId/rename", async (req, reply) => {
  const { runnerId, workspaceId } = req.params as { runnerId: string; workspaceId: string };
  const body = (req.body ?? {}) as { name?: unknown };
  if (typeof body.name !== "string") return reply.code(400).send({ error: "name must be a string" });
  if (!db.getRunner(runnerId)) return reply.code(404).send({ error: "runner not found" });
  const linkedProjectIds = db.projectIdsForWorkspace(runnerId, workspaceId);
  const principal = requestHuman(req);
  if (!principal || !db.canManageWorkspace(principal, runnerId, workspaceId)) {
    return reply.code(404).send({ error: "workspace not found" });
  }
  db.renameWorkspace(runnerId, workspaceId, body.name);
  hub.runnerChanged(runnerId);
  for (const projectId of linkedProjectIds) hub.projectChangedById(projectId);
  // Re-broadcast affected sessions so every open dashboard re-groups its sidebar immediately.
  for (const id of db.sessionIdsForWorkspace(runnerId, workspaceId)) hub.sessionChangedById(id);
  return { ok: true };
});

// Reveal a project root in the runner host's file manager ("Open in Explorer"). Only paths
// the runner itself advertised as workspace roots are allowed — this endpoint must not be a
// generic "open anything on the host" primitive.
app.post("/api/runners/:runnerId/host-action", async (req, reply) => {
  const { runnerId } = req.params as { runnerId: string };
  if (!hub.isRunnerOnline(runnerId)) return reply.code(409).send({ error: "runner is offline" });
  const body = (req.body ?? {}) as { kind?: string; path?: string };
  if (body.kind !== "reveal" || typeof body.path !== "string" || !body.path) {
    return reply.code(400).send({ error: "kind must be 'reveal' with a path" });
  }
  const runner = db.getRunner(runnerId);
  if (!runner?.workspaces.some((w) => w.path === body.path)) {
    return reply.code(400).send({ error: "path is not a workspace root on this runner" });
  }
  const unsupported = runnerCapabilityError(runnerId, "hostActions", "Host editor and file-manager actions");
  if (unsupported) return reply.code(409).send({ error: unsupported });
  const requestId = randomUUID();
  try {
    const result = await hub.requestFromRunner(
      runnerId,
      requestId,
      { type: "host_action", requestId, path: body.path, action: { kind: "reveal" } },
      10_000,
    );
    if (result.type !== "host_action_result") return reply.code(502).send({ error: "unexpected runner reply" });
    if (!result.ok) return reply.code(400).send({ error: result.error ?? "reveal failed" });
    return { ok: true };
  } catch (err) {
    return reply.code(504).send({ error: `${(err as Error).message} (the runner may be too old for host actions)` });
  }
});

app.post("/api/sessions/:id/column", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const body = req.body as SetColumnRequest;
  return respond(reply, svc.setColumn(id, body.column));
});

app.post("/api/sessions/:id/title", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const body = req.body as Partial<SetSessionTitleRequest>;
  return respond(reply, svc.setTitle(id, body?.title));
});

app.post("/api/sessions/:id/workspace", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const body = (req.body ?? {}) as Partial<SetWorkspaceRequest>;
  const session = db.getSession(id);
  const principal = requestPrincipal(req);
  const location = session && body.workspaceId
    ? db.findProjectLocation(session.runnerId, body.workspaceId)
    : null;
  if (location && (!principal || !db.canAccessProject(principal, location.projectId))) {
    return reply.code(404).send({ error: "project not found" });
  }
  return respond(reply, svc.setWorkspace(id, body.workspaceId ?? null));
});

app.post("/api/sessions/:id/archive", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const body = req.body as SetArchivedRequest;
  return respond(reply, svc.setArchived(id, body.archived));
});

app.post("/api/sessions/:id/config", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const body = (req.body ?? {}) as import("@wollipog/protocol").SessionConfig;
  return respond(reply, svc.setConfig(id, body, workflowActor(req)));
});

app.delete("/api/sessions/:id", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  // The runner kills the session's shell processes on delete_session; purge the registry here
  // too so offline-runner deletes don't leave ghost tabs.
  const shells = shellRegistry.list(id);
  shellRegistry.removeForSession(id);
  for (const shell of shells) hub.shellExit(shell.sessionId, shell.shellId, null, shell.outputEndSeq);
  return respond(reply, svc.delete(id));
});

app.get("/api/runs", async () => ({ runs: db.listRuns() }));

app.get("/api/runs/:id", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const run = db.getRun(id);
  if (!run) return reply.code(404).send({ error: "run not found" });
  const sessions = db.listSessions({ includeArchived: true }).filter((s) => s.runId === id);
  return { run, sessions };
});

app.post("/api/runs", async (req, reply) => {
  const body = req.body as CreateRunRequest;
  const principal = requestPrincipal(req);
  if (typeof body?.projectId === "string" && (!principal || !db.canAccessProject(principal, body.projectId))) {
    return reply.code(404).send({ error: "project not found" });
  }
  return respond(reply, svc.createRun(body));
});

app.get("/api/pods", async () => ({ pods: db.listPods() }));

app.get("/api/pods/:id", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const pod = db.getPod(id);
  if (!pod) return reply.code(404).send({ error: "pod not found" });
  const memberIds = new Set(pod.members.map((member) => member.sessionId));
  const sessions = db.listSessions({ includeArchived: true }).filter((session) => memberIds.has(session.id));
  return { pod, sessions };
});

app.post("/api/pods", async (req, reply) => respond(reply, svc.createPod(req.body as CreatePodRequest)));

app.get("/api/pods/:id/context", async (req, reply) => {
  const podId = (req.params as { id: string }).id;
  if (!db.getPod(podId)) return reply.code(404).send({ error: "pod not found" });
  const query = req.query as { before?: string; limit?: string };
  const before = query.before === undefined ? undefined : Number(query.before);
  const limit = query.limit === undefined ? 100 : Number(query.limit);
  if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) {
    return reply.code(400).send({ error: "before must be a positive integer" });
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    return reply.code(400).send({ error: "limit must be an integer from 1 to 200" });
  }
  const rows = db.listPodContextEntries(podId, before, limit + 1);
  const hasMore = rows.length > limit;
  const entries = hasMore ? rows.slice(1) : rows;
  return { entries, ...(hasMore && entries[0] ? { beforeSeq: entries[0].seq } : {}) };
});

app.post("/api/pods/:id/context", async (req, reply) => {
  return respond(reply, svc.appendPodContext(
    (req.params as { id: string }).id,
    req.body as AppendPodContextRequest,
    humanActorId(req),
  ));
});

app.post("/api/pods/:id/members", async (req, reply) =>
  respond(reply, svc.addPodMember(
    (req.params as { id: string }).id,
    req.body as AddPodMemberRequest,
  )),
);

app.delete("/api/pods/:id/members/:sessionId", async (req, reply) => {
  const params = req.params as { id: string; sessionId: string };
  return respond(reply, svc.removePodMember(params.id, params.sessionId));
});

app.patch("/api/pods/:id/members/:sessionId", async (req, reply) => {
  const params = req.params as { id: string; sessionId: string };
  return respond(reply, svc.updatePodMember(params.id, params.sessionId, req.body as UpdatePodMemberRequest));
});

app.put("/api/pods/:id/orchestration", async (req, reply) =>
  respond(reply, svc.updatePodOrchestration(
    (req.params as { id: string }).id,
    req.body as UpdatePodOrchestrationRequest,
  )),
);

app.post("/api/pods/:id/orchestration/start", async (req, reply) => {
  return respond(reply, svc.startPodOrchestration(
    (req.params as { id: string }).id,
    (req.body ?? {}) as StartPodOrchestrationRequest,
    humanActorId(req),
  ));
});

app.post("/api/pods/:id/orchestration/stop", async (req, reply) =>
  respond(reply, svc.stopPodOrchestration((req.params as { id: string }).id)),
);

app.post("/api/pods/:id/reconcile", async (req, reply) => {
  return respond(reply, await svc.reconcilePod(
    (req.params as { id: string }).id,
    req.body as ReconcilePodRequest,
    humanActorId(req),
  ));
});

app.post("/api/pods/:id/relay", async (req, reply) => {
  return respond(reply, svc.relayPod(
    (req.params as { id: string }).id,
    req.body as RelayPodRequest,
    humanActorId(req),
  ));
});

app.post("/api/pods/:id/close", async (req, reply) =>
  respond(reply, svc.closePod((req.params as { id: string }).id)),
);

app.post("/api/workflow-runs", async (req, reply) => {
  const body = req.body as CreateWorkflowRunRequest;
  const principal = requestPrincipal(req);
  if (typeof body?.projectId === "string" && (!principal || !db.canAccessProject(principal, body.projectId))) {
    return reply.code(404).send({ error: "project not found" });
  }
  return respond(reply, svc.createWorkflowRun(body, workflowActor(req)));
});

app.get("/api/automations", async () => automations.list());

app.post("/api/automations", async (req, reply) =>
  respond(reply, automations.create(req.body as CreateAutomationRequest, automationActor(req))),
);

app.get("/api/automations/:id", async (req, reply) =>
  respond(reply, automations.get((req.params as { id: string }).id)),
);

app.put("/api/automations/:id", async (req, reply) =>
  respond(reply, automations.update(
    (req.params as { id: string }).id,
    req.body as UpdateAutomationRequest,
    automationActor(req),
  )),
);

app.delete("/api/automations/:id", async (req, reply) =>
  respond(reply, automations.delete((req.params as { id: string }).id, automationActor(req))),
);

app.get("/api/automations/:id/triggers", async (req, reply) =>
  respond(reply, automations.triggers((req.params as { id: string }).id)),
);

app.post("/api/automations/:id/triggers", async (req, reply) =>
  respond(reply, automations.createTrigger(
    (req.params as { id: string }).id,
    req.body as CreateAutomationTriggerRequest,
    automationActor(req),
  )),
);

app.post("/api/automations/:id/triggers/:triggerId/rotate", async (req, reply) => {
  const params = req.params as { id: string; triggerId: string };
  return respond(reply, automations.rotateTrigger(params.id, params.triggerId, automationActor(req)));
});

app.delete("/api/automations/:id/triggers/:triggerId", async (req, reply) => {
  const params = req.params as { id: string; triggerId: string };
  return respond(reply, automations.deleteTrigger(params.id, params.triggerId, automationActor(req)));
});

app.post("/hooks/v1/automation-triggers/:triggerId", { bodyLimit: AUTOMATION_TRIGGER_MAX_BODY_BYTES }, async (req, reply) => {
  const contentEncoding = req.headers["content-encoding"];
  if (contentEncoding !== undefined && contentEncoding !== "identity") {
    return reply.code(415).send({ error: "signed automation trigger bodies must use identity encoding" });
  }
  if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: "signed automation trigger media type required" });
  const triggerHeaders = selectAutomationTriggerHeaders(req.headers);
  if (!triggerHeaders.ok) return reply.code(401).send({ error: "invalid automation trigger signature" });
  const result = automations.receiveTrigger(
    (req.params as { triggerId: string }).triggerId,
    triggerHeaders.value,
    req.body,
  );
  if (!result.ok && result.status === 429) reply.header("retry-after", "60");
  return respond(reply, result);
});

app.post("/api/artifacts", { bodyLimit: 3 * 1024 * 1024 }, async (req, reply) => {
  const body = req.body as CreateWorkflowArtifactRequest;
  if (body?.kind === "screenshot") return reply.code(400).send({ error: "screenshots use /api/artifacts/screenshots" });
  return respond(reply, svc.createWorkflowArtifact(body, workflowActor(req)));
});

// An 8 MiB screenshot expands to ~10.7 MiB base64. Only this kind-specific route receives the
// larger parser allowance; the service still verifies canonical image bytes and decoded size.
app.post("/api/artifacts/screenshots", { bodyLimit: 11 * 1024 * 1024 }, async (req, reply) => {
  const body = req.body as CreateWorkflowArtifactRequest;
  if (body?.kind !== "screenshot") return reply.code(400).send({ error: "this route accepts screenshot artifacts only" });
  return respond(reply, svc.createWorkflowArtifact(body, workflowActor(req)));
});

app.get("/api/artifacts/:artifactId", async (req, reply) =>
  respond(reply, svc.workflowArtifact((req.params as { artifactId: string }).artifactId)),
);

registerWorkflowArtifactExportRoute(app, { db, requestHuman });

app.get("/api/runs/:id/artifacts", async (req, reply) => {
  const query = req.query as { cursor?: string; limit?: string };
  return respond(reply, svc.runWorkflowArtifacts(
    (req.params as { id: string }).id,
    query.cursor,
    query.limit === undefined ? 50 : Number(query.limit),
  ));
});

app.get("/api/sessions/:id/artifacts", async (req, reply) => {
  const query = req.query as { cursor?: string; limit?: string };
  return respond(reply, svc.sessionWorkflowArtifacts(
    (req.params as { id: string }).id,
    query.cursor,
    query.limit === undefined ? 50 : Number(query.limit),
  ));
});

app.get("/api/workflows", async (req, reply) => {
  const query = req.query as { limit?: string };
  return respond(reply, svc.workflowDefinitions(query.limit === undefined ? 100 : Number(query.limit)));
});

// 64 nodes may each carry a 32 KiB prompt; keep the parser limit aligned with the validator's
// aggregate maximum while retaining a route-specific cap.
app.post("/api/workflows", { bodyLimit: 3 * 1024 * 1024 }, async (req, reply) => {
  return respond(reply, svc.createWorkflowDefinition(req.body as CreateWorkflowDefinitionRequest, workflowActor(req)));
});

app.post("/api/workflows/:workflowId/versions", { bodyLimit: 3 * 1024 * 1024 }, async (req, reply) => {
  return respond(reply, svc.createWorkflowDefinitionVersion(
    (req.params as { workflowId: string }).workflowId,
    req.body as CreateWorkflowDefinitionVersionRequest,
    workflowActor(req),
  ));
});

app.get("/api/workflows/:workflowId", async (req, reply) => {
  const query = req.query as { version?: string };
  const version = query.version === undefined ? undefined : Number(query.version);
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
    return reply.code(400).send({ error: "workflow version must be a positive integer" });
  }
  return respond(reply, svc.workflowDefinition(
    (req.params as { workflowId: string }).workflowId,
    version,
  ));
});

app.get("/api/workflow-instances", async (req, reply) => {
  const query = req.query as { runId?: string; limit?: string };
  return respond(reply, svc.workflowInstances(query.runId, query.limit === undefined ? 100 : Number(query.limit)));
});

app.post("/api/workflow-instances", async (req, reply) => {
  return respond(reply, svc.createWorkflowInstance(req.body as CreateWorkflowInstanceRequest, workflowActor(req)));
});

app.get("/api/workflow-instances/:instanceId", async (req, reply) =>
  respond(reply, svc.workflowInstance((req.params as { instanceId: string }).instanceId)),
);

app.post("/api/workflow-instances/:instanceId/nodes/:nodeId/dispatch", async (req, reply) => {
  const params = req.params as { instanceId: string; nodeId: string };
  return respond(reply, svc.dispatchWorkflowNode(params.instanceId, params.nodeId, req.body as DispatchWorkflowNodeRequest, workflowActor(req)));
});

app.post("/api/workflow-attempts/:attemptId/complete", async (req, reply) => {
  return respond(reply, svc.completeWorkflowAttempt(
    (req.params as { attemptId: string }).attemptId,
    req.body as CompleteWorkflowAttemptRequest,
    workflowActor(req),
  ));
});

app.get("/api/workflow-attempts/:attemptId/outputs", async (req, reply) => {
  const attemptId = (req.params as { attemptId: string }).attemptId;
  if (!db.getWorkflowAttempt(attemptId)) return reply.code(404).send({ error: "workflow attempt not found" });
  const outputs = Object.fromEntries(Object.entries(db.workflowAttemptOutputs(attemptId)).map(([name, artifact]) => {
    const { data: _data, ...view } = artifact;
    return [name, view];
  }));
  return { outputs };
});

app.post("/api/workflow-instances/:instanceId/nodes/:nodeId/resolve", async (req, reply) => {
  const params = req.params as { instanceId: string; nodeId: string };
  return respond(reply, svc.resolveWorkflowGate(params.instanceId, params.nodeId, req.body as ResolveWorkflowGateRequest, workflowActor(req)));
});

/* -------------------------------- Startup -------------------------------- */

// Graceful shutdown: kill the box SSH children (and stop reconnecting) before exit. Registered
// before listen() so the hook is in place by the time anything can close. Signals also cover the
// tsx-watch reload in dev, which would otherwise orphan ssh processes + their remote runners.
const workflowRecoveryTimer = setInterval(() => svc.recoverExpiredWorkflowAttempts(), 5_000);
workflowRecoveryTimer.unref();
const automationTimer = setInterval(() => automations.tick(Date.now()), 5_000);
automationTimer.unref();
const sessionCommandRetryTimer = setInterval(() => {
  try {
    svc.retryDueSessionCommands(Date.now());
  } catch (error) {
    app.log.warn({ error: error instanceof Error ? error.message : String(error) },
      "session command retry deferred");
  }
}, 5_000);
sessionCommandRetryTimer.unref();
reconcilePolicyHooksSafely(svc, app.log, Date.now());
const policyHookApprovalTimer = setInterval(
  () => reconcilePolicyHooksSafely(svc, app.log, Date.now()),
  1_000,
);
policyHookApprovalTimer.unref();
const artifactMaintenanceTimer = setInterval(() => {
  try {
    const now = Date.now();
    svc.maintainSessionCommands(now);
    db.pruneSessionCommandInvocations(now - SESSION_COMMAND_INVOCATION_RETENTION_MS, 1_000);
    db.compactSteeringAttempts(now, 1_000);
    db.collectOrphanedSteeringPromptImages(1_000);
    db.collectOrphanedEventPayloadArtifacts(1_000);
    db.collectWorkflowArtifactBlobs(1_000);
    db.prunePolicyHookDecisions(now - 7 * 24 * 60 * 60_000, 1_000);
    db.pruneGovernanceAudit(now - GOVERNANCE_AUDIT_RETENTION_MS, 1_000);
  } catch (error) {
    app.log.warn({ error: error instanceof Error ? error.message : String(error) }, "artifact maintenance deferred");
  }
}, 60_000);
artifactMaintenanceTimer.unref();
app.addHook("onClose", async () => {
  clearInterval(workflowRecoveryTimer);
  clearInterval(automationTimer);
  clearInterval(sessionCommandRetryTimer);
  clearInterval(policyHookApprovalTimer);
  clearInterval(artifactMaintenanceTimer);
  orchestrator.shutdown();
});
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    app.log.info(`${sig} — shutting down`);
    void app.close().finally(() => process.exit(0));
  });
}

// Wrapped in an async IIFE (not a top-level await) so the module bundles to CJS.
void (async () => {
  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`control plane listening on http://${HOST}:${PORT}`);
    // Normal service stdout is commonly captured as a log. Reveal the credential automatically
    // only to an interactive terminal; `--print-pair-url` is the explicit non-interactive path.
    if (process.stdout.isTTY) process.stdout.write(`[control-plane] Pair This Device: ${LOCAL_PAIRING_URL}\n`);
    // Re-bootstrap persisted boxes (auto_reconnect) now the control plane is up.
    orchestrator.rehydrate();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
})();

function send(socket: { send(data: string): void }, msg: ControlPlaneToRunner): void {
  socket.send(JSON.stringify(msg));
}

/** @fastify/cors origin callback — delegates to the shared local-origin policy. */
function isLocalOrigin(origin: string | undefined, cb: (err: Error | null, allow: boolean) => void): void {
  cb(null, isAllowedOrigin(origin));
}

/** Non-internal IPv4 addresses of this host, for remote/LAN runner onboarding. */
function lanIpv4(): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const ni of ifaces ?? []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function respond(
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  result: { ok: boolean; status: number; data?: unknown; error?: string },
) {
  return reply.code(result.status).send(result.ok ? result.data : { error: result.error });
}
