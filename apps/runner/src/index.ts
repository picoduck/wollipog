/**
 * Runner daemon: connects outbound to the control plane, advertises this host's
 * workspaces + agents, sends heartbeats, reconnects automatically, and manages
 * ACP agent sessions on behalf of the control plane.
 */

import { homedir, hostname } from "node:os";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";
import {
  parseMessage,
  PROTOCOL_VERSION,
  projectRunnerMessageForProtocol,
  projectSessionEventPayloadForProtocol,
  runnerSupportsProtocol,
  validatePromptImageInputs,
  type AdoptSessionMessage,
  type AcpRuntimeCapabilities,
  type AgentDriverKind,
  type AgentDefinition,
  type AgentContext,
  type AgentsUpdatedMessage,
  type ControlPlaneToRunner,
  type DurableSessionCommandResultMessage,
  type DurableSessionCommandUpdateMessage,
  type ExternalSessionDescriptor,
  type GitAction,
  type GitActionRequestMessage,
  type HeartbeatMessage,
  type HostActionMessage,
  type ListDirectoryRequestMessage,
  type ListSessionFilesRequestMessage,
  type OS,
  type ReadSessionFileRequestMessage,
  type RegisterMessage,
  type ReprocessSessionMessage,
  type RunnerMetadata,
  type RunnerToControlPlane,
  type SessionCommandInvocationResultMessage,
  type SessionCommandInvocationUpdateMessage,
  type SessionEventPayload,
  type SessionSnapshot,
  type SessionWorktreeView,
  type SkillsSyncManifestMessage,
  type StartSessionMessage,
} from "@wollipog/protocol";
import {
  loadConfig,
  parseArgs,
  parseEnv,
  resolveAgentEnvironment,
  type RunnerConfig,
} from "./config.js";
import {
  fenceConductorAdvertisement,
  withConductorAgent,
  defaultConductorHost,
  provisionConductor,
  removeConductorMcpConfig,
  sweepConductorMcpConfigs,
  stageRunnerCredentialFile,
} from "./conductor.js";
import {
  applyClaudeHookCapability,
  claudeHookRunnerConfigDir,
  claudeHooksEnabled,
  defaultClaudeHookHost,
  markClaudeHookCredentialReady,
  markClaudeHookCredentialRejected,
  provisionClaudeHooks,
  removeClaudeHookFiles,
  sweepClaudeHookFiles,
} from "./hook-settings.js";
import {
  defaultAgentControlHost,
  markAgentControlCredentialReady,
  markAgentControlCredentialRejected,
  provisionAgentControl,
  removeAgentControlFiles,
  sweepAgentControlFiles,
} from "./agent-control.js";
import {
  GitOpError,
  resolveGitActionExecution,
  runGitAction,
  runPodReconcile,
  validatePodReconciliationMetadata,
  withGitExecutionContext,
} from "./git-ops.js";
import { flushProjectedOutbox, Outbox } from "./outbox.js";
import { SessionManager } from "./session-manager.js";
import { NativeProviderAuthRecovery } from "./provider-auth-recovery.js";
import { handleResolveSteeringAttemptMessage, handleSteerSessionMessage } from "./steering-handler.js";
import {
  CLAUDE_GRACEFUL_STOP_BUDGET_MS,
  warnLegacyClaudeLifetimeEnvironment,
} from "./drivers/claude-code.js";
import { resolveAcpSessionContext } from "./acp-session-context.js";
import { SessionStore, isAdoptedSession, type SessionMeta } from "./session-store.js";
import {
  DESCENDANT_BOUNDARY_TERMINATION_BUDGET_MS,
  terminateDescendantBoundariesAfterPendingKills,
  waitForPendingKills,
} from "./spawn.js";
import {
  findExternalSession,
  listExternalSessions,
  readExternalTranscript,
  retargetExternalSession,
  resolveLaunchForAgent,
  resolveLaunchForDriver,
} from "./external/sources.js";
import {
  acpSessionKey,
  configuredAcpAgent,
  findAcpExternalSession,
  launchForAcpAgent,
  listAcpExternalSessions,
} from "./external/acp-sessions.js";
import { listDirectory } from "./fs-browse.js";
import { discoverEditors, runHostAction } from "./host-actions.js";
import { listSessionFiles, readSessionFile } from "./session-files.js";
import { ShellManager } from "./shell-manager.js";
import { agentTuiLaunch } from "./agent-tui.js";
import { capabilitiesFor } from "./catalog.js";
import { createPromptImageFetcher } from "./prompt-image-fetch.js";
import {
  publishNegotiatedSessionSnapshots,
  registrationSessionSnapshots,
  validateControlPlaneUrl,
} from "./control-plane-transport.js";
import { discoverAgents, enrichAgentModels, mergeAgents } from "./discovery/discover.js";
import {
  prepareClaudeSlashCommandCatalog,
} from "./discovery/claude-commands.js";
import { discoverRegistryAgents, updateRegistryApproval } from "./discovery/acp-registry.js";
import {
  cacheSkillSyncEntry,
  reconcileSkills,
  skillNeedsManualVariant,
  skillsStateMessage,
  storedSkillVersionAvailable,
  type ReconcileSkillEntry,
} from "./skills.js";
import { ChunkedSkillsSyncAssembler, type ChunkedSyncStep } from "./skills-sync.js";
import { VERSION } from "./version.js";
import { overlayAcpAuthStatus, type AcpAuthRuntime } from "./acp-auth-status.js";
import {
  DurableCommandStore,
  isDurableSessionCommandMessage,
  type DurableCommandHandle,
  type DurableCommandReceipt,
} from "./durable-command-store.js";
import type { DurableCommandLifecycle, SessionCommandInvocationLifecycle } from "./session-manager.js";
import {
  isInvokeSessionCommandMessage,
  SessionCommandReceiptStore,
  type SessionCommandInvocationReceipt,
  type SessionCommandReceiptHandle,
} from "./session-command-receipt-store.js";
import { ContainerTargetRegistry } from "./container-target.js";
import { CloudTargetRegistry } from "./cloud-target.js";
import { SessionStartFence } from "./session-start-fence.js";
import { PendingShellOpenCancellations } from "./pending-shell-open-cancellations.js";
import { handleShellOpenCommand } from "./shell-open-command.js";
import { startSessionWithMaterializationFence } from "./session-start-command.js";
import { handleSessionCancellationCommand } from "./session-cancellation-command.js";
import {
  acquireRunnerDataDirLease,
  readV1RunnerCredentialForAttestation,
  type RunnerDataDirLease,
} from "./runner-data-dir.js";
import { waitForRunnerControlPlaneAttestation } from "./control-plane-attestation.js";
import {
  shouldPublishSubscriptionUsageInventory,
  SubscriptionUsageManager,
  type SubscriptionUsageManagerOptions,
} from "./subscription-usage.js";
import { SessionNamingExecutor } from "./session-naming.js";
import { RunnerSessionNamingCustomModel } from "./session-naming-custom-model.js";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
// Half-open-socket liveness: after a laptop sleep / Wi-Fi drop / NAT rebind the control-plane socket
// can sit readyState=OPEN with no FIN/RST, so frames written into it are silently lost until the OS
// TCP timeout finally errors it (many minutes). Piggy-back a ws-level ping on every heartbeat and
// terminate once this many consecutive pings go unanswered — at the ~10s heartbeat that surfaces a
// dead peer in ~30s, dropping us straight into the existing reconnect/backoff/outbox path.
const MAX_MISSED_HEARTBEAT_PONGS = 2;

function detectOs(): OS {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    default:
      return "linux";
  }
}

// Drop argv[0] (the exec path) only. A Node SEA binary has NO script path in argv
// ([exe, ...args]), unlike a normal `node script.js …` launch ([exe, script, ...args]); slicing
// a fixed 2 would eat the first real flag in SEA mode. parseArgs ignores any leading non-flag
// positional (the script path under tsx/node), so slice(1) is correct for both.
const parsed = parseArgs(process.argv.slice(1));
if (parsed.showVersion) {
  console.log(VERSION);
  process.exit(0);
}

// Connection/identity precedence: flags > env > config file. Lets the control plane launch a
// runner remotely with no JSON on the box (--runner-id/--control-plane-url/--token/--workspace).
const overrides: Partial<RunnerConfig> = { ...parseEnv(), ...parsed.overrides };

// --token-file / RUNNER_TOKEN_FILE: read the token from a file so the secret never appears in any
// process's argv. Takes precedence over a flag/env/file token.
const tokenFile = parsed.tokenFile ?? process.env.RUNNER_TOKEN_FILE;
if (tokenFile) {
  try {
    overrides.token = readFileSync(tokenFile, "utf8").trim();
  } catch (err) {
    console.error(`[runner] could not read --token-file ${tokenFile}: ${(err as Error).message}`);
    process.exit(1);
  }
}

let config: RunnerConfig;
try {
  config = loadConfig(parsed.configPath, overrides, parsed.explicitConfig);
} catch (err) {
  console.error(`[runner] ${(err as Error).message}`);
  process.exit(1);
}

async function startRunner(config: RunnerConfig, allowInsecureTransport: boolean): Promise<void> {
const log = (msg: string) => console.log(`[runner ${config.runnerId}] ${msg}`);
validateControlPlaneUrl(config.controlPlaneUrl, allowInsecureTransport);
const warnLegacyEnvironment = (message: string) => console.warn(`[runner ${config.runnerId}] ${message}`);
const claudeHookFeatureEnabled = claudeHooksEnabled(process.env, warnLegacyEnvironment);
warnLegacyClaudeLifetimeEnvironment(process.env, warnLegacyEnvironment);
const v1Credential = readV1RunnerCredentialForAttestation(config.dataDir, {
  runnerId: config.runnerId,
  controlPlaneUrl: config.controlPlaneUrl,
});
const v1CredentialHash = v1Credential
  ? createHash("sha256").update(v1Credential).digest("hex")
  : undefined;
const attestation = await waitForRunnerControlPlaneAttestation({
  controlPlaneUrl: config.controlPlaneUrl,
  runnerId: config.runnerId,
  token: config.token,
  allowInsecureTransport,
  ...(v1CredentialHash
    ? { priorCredentialHash: v1CredentialHash }
    : {}),
  onRetry: (error, delayMs) => log(`${error.message}; retrying in ${delayMs}ms`),
});
const runnerDataIdentity = {
  runnerId: config.runnerId,
  controlPlaneUrl: config.controlPlaneUrl,
  controlPlaneInstanceId: attestation.instanceId,
};
const legacyEndpointMigrationCredentialHash = v1CredentialHash && (
  v1Credential === config.token || attestation.priorCredentialValid === true
) ? v1CredentialHash : undefined;
if (v1Credential && !legacyEndpointMigrationCredentialHash) {
  log("v1 endpoint ownership could not be proven to this control plane; preserving it in place");
}
let dataDirLease: RunnerDataDirLease;
const requestedDataDir = config.dataDir;
try {
  dataDirLease = acquireRunnerDataDirLease(
    config.dataDir,
    runnerDataIdentity,
    {
      adoptLegacyDataDir: parsed.adoptLegacyDataDir,
      legacyEndpointMigrationCredentialHash,
    },
  );
} catch (error) {
  console.error(`[runner ${config.runnerId}] data directory unavailable: ${(error as Error).message}`);
  process.exit(1);
}
if (resolve(requestedDataDir) !== resolve(dataDirLease.dataDir)) {
  log(`using isolated runner state at ${dataDirLease.dataDir}; prior owner state remains untouched`);
}
config.dataDir = dataDirLease.dataDir;
process.once("exit", dataDirLease.release);
if (dataDirLease.migratedLegacyDataDir) {
  log(`claimed legacy data directory ${config.dataDir} after explicit --adopt-legacy-data-dir authorization`);
}
const stagedRunnerCredential = stageRunnerCredentialFile(
  config.dataDir,
  config.token,
  runnerDataIdentity,
);
const runnerCredentialFile = stagedRunnerCredential.activePath;
const conductorHost = {
  ...defaultConductorHost(),
  // The pre-attestation default root also used ~/.agent-manager/conductor. Always add an
  // attested leaf so startup sweeping can never delete unattributable legacy configurations.
  configDir: resolve(config.dataDir, "conductor", "runner-instances", dataDirLease.ownerHash),
};
const claudeHookHost = {
  ...defaultClaudeHookHost(),
  configDir: claudeHookRunnerConfigDir(config.dataDir, config.runnerId),
};
const agentControlHost = defaultAgentControlHost(config.dataDir);
sweepConductorMcpConfigs(conductorHost.configDir);
sweepClaudeHookFiles(claudeHookHost.configDir);
sweepAgentControlFiles(agentControlHost.configDir);

const runnerHostname = hostname();
const sessionNamingCustomModel = new RunnerSessionNamingCustomModel(resolve(config.dataDir, "session-naming"));
const containerTargets = new ContainerTargetRegistry(config.runnerId, runnerHostname, config.containerTargets);
const cloudTargets = new CloudTargetRegistry(config.runnerId, runnerHostname, config.cloudTargets);
const configuredAgentDefinitions = config.agents.map((a) => {
  const driver = a.driver ?? "acp";
  return {
    id: a.id,
    name: a.name,
    command: a.command,
    args: a.args ?? [],
    env: {},
    // env is redacted above, so the discovery merge cannot see a configured OPENAI_API_KEY.
    // Carry the non-secret fact that auth is configured (literal or fromEnv) as an auth
    // assertion, or the auth gate would disable a deliberately API-keyed Codex whose
    // ~/.codex/auth.json is absent.
    ...((driver === "codex" || driver === "codex-app-server") && a.env && "OPENAI_API_KEY" in a.env
      ? { authStatus: "authenticated" as const, codexBillingSource: "api" as const }
      : {}),
    driver,
    ...(driver === "acp" ? { acpTransport: "stdio" as const } : {}),
    context: a.context ?? { kind: "native" as const },
    capabilities: capabilitiesFor(driver),
    source: "config" as const,
  };
});
const metadata: RunnerMetadata = {
  runnerId: config.runnerId,
  hostname: runnerHostname,
  os: detectOs(),
  version: VERSION,
  // Pre-discovery config rows go out verbatim so live discovery can still authoritatively
  // fill availability and capabilities; conductor synthesis happens after every merge.
  agents: configuredAgentDefinitions,
  workspaces: config.workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    path: w.path,
    ...(config.features.acpAdditionalDirectories && w.additionalDirectoryGrants?.length
      ? { additionalDirectoryGrants: w.additionalDirectoryGrants }
      : {}),
  })),
  runtime: {
    dataDir: config.dataDir,
    worktreeRoot: resolve(config.dataDir, "worktrees"),
    maxConcurrentSessions: config.maxConcurrentSessions,
    admission: config.admission,
    executionIsolation: config.executionIsolation,
  },
  sessionNamingCustomModel: sessionNamingCustomModel.status(),
};

// Configured agents are the baseline; discovery augments them (config wins on conflict).
const configAgents = metadata.agents;
const acpAuthStatus = new Map<string, AcpAuthRuntime>();

/** The control plane receives neither values nor fromEnv reference names. The synthesized
 * conductor is fenced here — at send time, with the CURRENT socket's negotiated version — so a
 * cached list can never carry it to a pre-v91 control plane, and a list merged before
 * registration still advertises it to a v91+ control plane on the post-register re-push. */
function agentsForControlPlane() {
  return fenceConductorAdvertisement(metadata.agents, controlPlaneProtocolVersion)
    .map((agent) => ({ ...agent, env: {} }));
}

/** Resolve exact configured/discovered agent env at the last responsible moment. */
function runnerLocalAgentEnv(agentId: string | null, driver: AgentDriverKind, context: AgentContext): Record<string, string> {
  const configured = agentId ? config.agents.find((agent) => agent.id === agentId) : undefined;
  if (configured) return resolveAgentEnvironment(configured);
  const exact = agentId ? metadata.agents.find((agent) => agent.id === agentId) : undefined;
  return { ...(exact?.env ?? resolveLaunchForDriver(metadata.agents, driver, context)?.env ?? {}) };
}

let authorizeSubscriptionUsageProbe: SubscriptionUsageManagerOptions["authorizeProbe"];

const subscriptionUsage = new SubscriptionUsageManager({
  runnerId: config.runnerId,
  agents: () => metadata.agents,
  resolveEnv: (agentId, driver, context) =>
    runnerLocalAgentEnv(agentId, driver ?? "acp", context),
  authorizeProbe: (agent, env, sourceId) => {
    if (!authorizeSubscriptionUsageProbe) {
      throw new Error("subscription usage probe authorization is not initialized");
    }
    return authorizeSubscriptionUsageProbe(agent, env, sourceId);
  },
  publish: (snapshot) => {
    if (runnerSupportsProtocol(controlPlaneProtocolVersion, "subscriptionUsage")) {
      sendUp({ type: "subscription_usage_updated", snapshot });
    }
  },
  log,
});

function updateAgentAuthStatus(agentId: string, update: AcpAuthRuntime): void {
  const prior = acpAuthStatus.get(agentId) ?? {};
  if (
    (update.status === undefined || prior.status === update.status) &&
    (update.capabilities === undefined || sameAcpCapabilities(prior.capabilities, update.capabilities))
  ) return;
  acpAuthStatus.set(agentId, { ...prior, ...update });
  // Native provider status is credential-scope specific (custom homes/env and execution context);
  // it must not disable or enable the runner-wide agent catalog. ACP status is agent-global and is
  // the only runtime status projected by overlayAcpAuthStatus.
  metadata.agents = overlayAcpAuthStatus(metadata.agents, acpAuthStatus);
  sendUp({
    type: "agents_updated",
    runnerId: config.runnerId,
    agents: agentsForControlPlane(),
    editors: metadata.editors,
  });
}

function sameAcpCapabilities(
  left: AcpAuthRuntime["capabilities"],
  right: AcpAuthRuntime["capabilities"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

let ws: WebSocket | null = null;
let registered = false;
let controlPlaneProtocolVersion: number | null = null;
const registerPolicyHookCredential = (sessionId: string, tokenHash: string) =>
  sendUp({ type: "policy_hook_credential", sessionId, tokenHash });
const registerAgentControlCredential = (sessionId: string, tokenHash: string) =>
  sendUp({ type: "agent_control_credential", sessionId, tokenHash });
// The box's on-disk session store (source of truth, shared across runner instances on this box).
const store = new SessionStore(resolve(config.dataDir, "sessions"));
store.scrubLegacyAgentEnv();
const durableCommands = new DurableCommandStore(resolve(config.dataDir, "command-receipts"));
durableCommands.prune();
const sessionCommandReceipts = new SessionCommandReceiptStore(
  resolve(config.dataDir, "session-command-receipts"),
);
sessionCommandReceipts.prune();
const sessionNaming = new SessionNamingExecutor({
  authorize: (agent, env, cwd) => sessions.prepareSessionNamingExecution(agent, env, cwd),
});
// The resolver closes over `metadata`, so it always sees the LIVE agent list (discovery replaces
// metadata.agents). It's the same shared resolver as the `resumable` flag and handleAdopt — resume,
// listing, and adoption can never disagree — and it lets a read-only adopt heal once the box gains
// a matching agent (discovery finished after the adopt, or the user installed the CLI later).
const sessions = new SessionManager(() => {}, log, store, config.runnerId, (driver, context, agentId) =>
  agentId
    ? resolveLaunchForAgent(metadata.agents, agentId, driver, context)
    : resolveLaunchForDriver(metadata.agents, driver, context),
  undefined,
  config.dataDir,
  config.maxConcurrentSessions,
  updateAgentAuthStatus,
  (spec) => {
    const workspace = config.workspaces.find((item) => item.id === spec.workspaceId);
    const agent = config.agents.find((item) => item.id === spec.agentId);
    return resolveAcpSessionContext({
      runner: config.mcpServers,
      workspace: workspace?.mcpServers,
      agent: agent?.mcpServers,
      session: spec.acpSessionContext,
      additionalDirectoryGrants: workspace?.additionalDirectoryGrants,
      additionalDirectoriesEnabled: config.features.acpAdditionalDirectories,
      context: spec.context,
    });
  },
  config.admission,
  config.executionIsolation,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  config.agents.map((agent) => agent.context ?? { kind: "native" as const }),
  async (meta) => {
    meta.env = runnerLocalAgentEnv(meta.agentId, meta.driver, meta.context);
    provisionConductor(
      meta,
      {
        controlPlaneUrl: config.controlPlaneUrl,
        tokenFile: runnerCredentialFile,
        allowInsecureTransport,
      },
      log,
      conductorHost,
    );
    provisionClaudeHooks(
      meta,
      {
        controlPlaneUrl: config.controlPlaneUrl,
        controlPlaneProtocolVersion,
        enabled: claudeHookFeatureEnabled,
        allowInsecureTransport,
        registerCredential: registerPolicyHookCredential,
      },
      log,
      claudeHookHost,
    );
    provisionAgentControl(
      meta,
      {
        controlPlaneUrl: config.controlPlaneUrl,
        controlPlaneProtocolVersion,
        allowInsecureTransport,
        registerCredential: registerAgentControlCredential,
      },
      log,
      agentControlHost,
    );
    const commandPreparation = await prepareClaudeSlashCommandCatalog(meta);
    if (commandPreparation.outcome === "retained") {
      log(`${commandPreparation.error}; retaining matching prior session command catalog`);
    } else if (commandPreparation.outcome === "discarded") {
      log(`${commandPreparation.error}; discarded mismatched prior session command catalog`);
    }
    return {
      sessionCommandCatalogFresh:
        meta.driver === "claude-code" &&
        (commandPreparation.outcome === "updated" || commandPreparation.outcome === "cleared"),
      sessionCommandCatalogProvenance: JSON.stringify(meta.sessionSlashCommandProvenance ?? null),
    };
  },
  createPromptImageFetcher({
    controlPlaneUrl: config.controlPlaneUrl,
    runnerId: config.runnerId,
    tokenFile: runnerCredentialFile,
    allowInsecureTransport,
  }),
  containerTargets,
  cloudTargets,
  () => controlPlaneProtocolVersion,
  dataDirLease.ownerHash,
  // The existing runner credential is already staged in a protected local file. Reuse it only as
  // an HMAC key so structural scope/account equality cannot be dictionary-tested from meta.json.
  new NativeProviderAuthRecovery(undefined, config.token),
  (agentId, driver, context, update) => {
    subscriptionUsage.observe(agentId, driver, context, update);
  },
  config.workspaces.map((workspace) => workspace.path),
);
authorizeSubscriptionUsageProbe = (agent, env, sourceId) =>
  sessions.prepareSubscriptionUsageProbe(agent, env, sourceId);
const sessionStarts = new SessionStartFence();
const pendingShellOpenCancellations = new PendingShellOpenCancellations();
sessions.reconcileStore(); // demote any sessions left mid-flight by a previous run to idle

// Per-session shells (Shells panel). Live output bypasses the general outbox so console spam
// cannot evict session events. ShellManager retains a bounded sequenced tail and replays an
// authoritative inventory after every registration instead.
const shells = new ShellManager({
  onOutput: (shellId, sessionId, stream, data, seq) => {
    if (ws && ws.readyState === WebSocket.OPEN && registered) {
      ws.send(JSON.stringify({ type: "shell_output", sessionId, shellId, stream, data, seq }));
    }
  },
  onExit: (shellId, sessionId, code, outputSeq) =>
    sendUp({ type: "shell_exit", sessionId, shellId, code, outputSeq }),
});

// Buffer outbound events while the control-plane socket is down or mid-reconnect so a terminal
// status or permission request produced during a blip is not lost. The buffering/coalescing/overflow
// policy lives in outbox.ts; the online-decision and the actual protocol-projected send stay here.
const outbox = new Outbox<RunnerToControlPlane>();

function projectSnapshotForCurrentProtocol(snapshot: SessionSnapshot): SessionSnapshot {
  return store.projectSnapshotForProtocol(snapshot, controlPlaneProtocolVersion);
}

function projectStoredEventsForCurrentProtocol(
  sessionId: string,
  events: Array<{ seq: number; ts: number; payload: SessionEventPayload }>,
) {
  return store.projectEventsForProtocol(sessionId, events, controlPlaneProtocolVersion);
}

function projectMessageForCurrentProtocol(msg: RunnerToControlPlane): RunnerToControlPlane | null {
  if (msg.type === "session_event") {
    if (msg.seq === undefined) {
      const payload = projectSessionEventPayloadForProtocol(msg.payload, controlPlaneProtocolVersion);
      return payload ? { ...msg, payload } : null;
    }
    const event = store.projectEventForProtocol(
      msg.sessionId,
      { seq: msg.seq, ts: msg.ts ?? Date.now(), payload: msg.payload },
      controlPlaneProtocolVersion,
    );
    return event
      ? { ...msg, seq: event.seq, ts: msg.ts, payload: event.payload }
      : null;
  }
  if (msg.type === "session_runtime_updated") {
    return projectRunnerMessageForProtocol({
      ...msg,
      snapshot: projectSnapshotForCurrentProtocol(msg.snapshot),
    }, controlPlaneProtocolVersion);
  }
  if (msg.type === "reprocess_session_result") {
    const snapshot = msg.snapshot
      ? projectSnapshotForCurrentProtocol(msg.snapshot)
      : undefined;
    const events = msg.events
      ? projectStoredEventsForCurrentProtocol(msg.sessionId, msg.events)
      : undefined;
    return projectRunnerMessageForProtocol({
      ...msg,
      ...(snapshot ? { snapshot } : {}),
      ...(events
        ? { events, eventCount: events.length }
        : snapshot && msg.eventCount !== undefined
          ? { eventCount: snapshot.seq }
          : {}),
    }, controlPlaneProtocolVersion);
  }
  if (msg.type === "fork_result") {
    const events = msg.events && msg.snapshot
      ? projectStoredEventsForCurrentProtocol(msg.snapshot.id, msg.events)
      : undefined;
    return projectRunnerMessageForProtocol({
      ...msg,
      ...(msg.snapshot ? { snapshot: projectSnapshotForCurrentProtocol(msg.snapshot) } : {}),
      ...(events ? { events } : {}),
    }, controlPlaneProtocolVersion);
  }
  if (msg.type === "session_worktree_result") {
    return projectRunnerMessageForProtocol({
      ...msg,
      ...(msg.snapshot ? { snapshot: projectSnapshotForCurrentProtocol(msg.snapshot) } : {}),
    }, controlPlaneProtocolVersion);
  }
  if (msg.type === "adopt_session_result" && msg.snapshot) {
    return projectRunnerMessageForProtocol({
      ...msg,
      snapshot: projectSnapshotForCurrentProtocol(msg.snapshot),
    }, controlPlaneProtocolVersion);
  }
  return projectRunnerMessageForProtocol(msg, controlPlaneProtocolVersion);
}

function sendUp(msg: RunnerToControlPlane): void {
  if (ws && ws.readyState === WebSocket.OPEN && registered) {
    let projected: RunnerToControlPlane | null;
    try {
      projected = projectMessageForCurrentProtocol(msg);
    } catch (error) {
      log(`dropping ${msg.type}: wire projection failed (${errText(error)})`);
      return;
    }
    if (!projected) return;
    try {
      ws.send(JSON.stringify(projected));
    } catch (error) {
      outbox.enqueue(msg);
      log(`buffering ${msg.type}: socket send failed (${errText(error)})`);
    }
    return;
  }
  outbox.enqueue(msg);
}

function flushOutbox(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN || !registered) return;
  const socket = ws;
  flushProjectedOutbox(
    outbox,
    projectMessageForCurrentProtocol,
    (message) => socket.send(JSON.stringify(message)),
    (error, message) => log(`dropping ${message.type}: wire projection failed (${errText(error)})`),
    (error, message) => log(`retaining ${message.type}: socket send failed (${errText(error)})`),
  );
}

function sendDurableUpdate(receipt: DurableCommandReceipt): void {
  const update: DurableSessionCommandUpdateMessage = {
    type: "durable_session_command_update",
    commandId: receipt.commandId,
    sessionId: receipt.sessionId,
    state: receipt.state,
    revision: receipt.revision,
    ...(receipt.error ? { error: receipt.error } : {}),
    ...(receipt.code ? { code: receipt.code } : {}),
    ...(receipt.userEventSeq !== undefined ? { userEventSeq: receipt.userEventSeq } : {}),
  };
  sendUp(update);
}

function durableLifecycle(handle: DurableCommandHandle): DurableCommandLifecycle {
  const transition = (run: () => DurableCommandReceipt) => sendDurableUpdate(run());
  const bestEffort = (run: () => DurableCommandReceipt) => {
    try {
      transition(run);
    } catch (error) {
      log(`durable command ${handle.commandId} transition failed: ${errText(error)}`);
    }
  };
  return {
    commandId: handle.commandId,
    queued: () => transition(() => handle.queued()),
    started: (userEventSeq) => transition(() => handle.started(userEventSeq)),
    completed: () => bestEffort(() => handle.completed()),
    failed: (error, code) => bestEffort(() => handle.failed(error, code)),
    uncertain: (error) => bestEffort(() => handle.uncertain(error)),
  };
}

function sendSessionCommandUpdate(receipt: SessionCommandInvocationReceipt): void {
  const update: SessionCommandInvocationUpdateMessage = {
    type: "session_command_invocation_update",
    invocationId: receipt.invocationId,
    submissionId: receipt.submissionId,
    sessionId: receipt.sessionId,
    state: receipt.state,
    revision: receipt.revision,
    ...(receipt.error ? { error: receipt.error } : {}),
    ...(receipt.code ? { code: receipt.code } : {}),
    ...(receipt.userEventSeq !== undefined ? { userEventSeq: receipt.userEventSeq } : {}),
  };
  sendUp(update);
}

function sessionCommandLifecycle(handle: SessionCommandReceiptHandle): SessionCommandInvocationLifecycle {
  const transition = (run: () => SessionCommandInvocationReceipt) => sendSessionCommandUpdate(run());
  const bestEffort = (run: () => SessionCommandInvocationReceipt) => {
    try {
      transition(run);
    } catch (error) {
      log(`session command ${handle.invocationId} transition failed: ${errText(error)}`);
    }
  };
  return {
    invocationId: handle.invocationId,
    queued: () => transition(() => handle.queued()),
    started: (userEventSeq) => transition(() => handle.started(userEventSeq)),
    completed: () => bestEffort(() => handle.completed()),
    failed: (error, code) => bestEffort(() => handle.failed(error, code)),
    uncertain: (error) => bestEffort(() => handle.uncertain(error)),
  };
}

/** Recover only work whose prior receipt owner lease is stale. Started work is claimed solely to
 * become uncertain; accepted/queued work waits for a ready session and queue capacity, then is
 * claimed even when its authority is stale so SessionManager can settle it explicitly. */
function recoverStaleSessionCommands(): void {
  try {
    // Bound synchronous deletion work on the live event loop; startup and capacity-pressure calls
    // may still drain the full indexed expiry set before websocket traffic begins or admission.
    sessionCommandReceipts.prune(Date.now(), 100);
  } catch (error) {
    log(`session command receipt expiry pruning failed: ${errText(error)}`);
  }
  for (const candidate of sessionCommandReceipts.staleRecoveries()) {
    if (candidate.state !== "started" && !sessions.canRecoverSessionCommand(candidate.message)) continue;
    let claim: ReturnType<SessionCommandReceiptStore["claim"]>;
    try {
      claim = sessionCommandReceipts.claim(candidate.message);
    } catch (error) {
      log(`session command ${candidate.message.invocationId} recovery journal failure: ${errText(error)}`);
      continue;
    }
    if (claim.kind === "busy") continue;
    sendSessionCommandUpdate(claim.receipt);
    if (!("handle" in claim)) continue;
    const lifecycle = sessionCommandLifecycle(claim.handle);
    try {
      sessions.invokeSessionCommand(candidate.message, lifecycle);
    } catch (error) {
      lifecycle.failed(`session command recovery failed: ${errText(error)}`, "INVALID_COMMAND");
    }
  }
}

sessions.setSend(sendUp);

function startTrackedSession(
  command: StartSessionMessage,
  lifecycle?: DurableCommandLifecycle,
): void {
  startSessionWithMaterializationFence(command, lifecycle, {
    track: (sessionId, materialized) => {
      sessionStarts.track(sessionId, materialized);
    },
    start: (startCommand, durable, onMaterialized) => sessions.start(
      startCommand.spec,
      startCommand.initialPrompt,
      startCommand.initialImages,
      durable,
      onMaterialized,
    ),
    failed: (error, durable) => {
      if (durable) durable.failed(`session launch failed: ${errText(error)}`);
      else log(`session launch failed: ${errText(error)}`);
    },
  });
}

/** Last authoritative desired skill list from the control plane. Null until the first skills_sync
 * arrives on this process; removal sweeps and store GC never run before then, so a fresh runner
 * cannot tear down links deployed by its previous incarnation on a scan-only pass. */
let lastDesiredSkills: ReconcileSkillEntry[] | null = null;
const chunkedSkillsSync = new ChunkedSkillsSyncAssembler({
  runnerId: config.runnerId,
  needsContent: (entry) =>
    !storedSkillVersionAvailable(config.dataDir, entry.name, entry.versionDigest) ||
    (skillNeedsManualVariant(metadata.agents, entry) &&
      !storedSkillVersionAvailable(config.dataDir, entry.name, entry.versionDigest, true)),
  cacheContent: (entry) => cacheSkillSyncEntry(config.dataDir, metadata.agents, entry),
});

function reportChunkedSkillsSyncRejection(result: Extract<ChunkedSyncStep, { kind: "rejected" }>): void {
  sendUp({
    type: "skills_state",
    runnerId: config.runnerId,
    ...(result.requestId ? { requestId: result.requestId } : {}),
    deployed: [],
    unmanaged: [],
    removals: [],
    error: result.error,
  });
}

function beginChunkedSkillsSync(msg: SkillsSyncManifestMessage): void {
  const result = chunkedSkillsSync.begin(msg);
  if (result.kind === "rejected") reportChunkedSkillsSyncRejection(result);
  else if (result.kind === "accepted") sendUp(result.need);
}

function acceptChunkedSkillContent(msg: Extract<ControlPlaneToRunner, { type: "skills_sync_content" }>): void {
  const result = chunkedSkillsSync.acceptContent(msg);
  if (result.kind === "rejected") reportChunkedSkillsSyncRejection(result);
}

function completeChunkedSkillsSync(msg: Extract<ControlPlaneToRunner, { type: "skills_sync_complete" }>): void {
  const result = chunkedSkillsSync.complete(msg);
  if (result.kind === "rejected") reportChunkedSkillsSyncRejection(result);
  else if (result.kind === "accepted") {
    lastDesiredSkills = result.desired;
    queueSkillsReconcile(result.requestId);
  }
}
/** Serializes reconcile passes so concurrent syncs and discovery rescans cannot interleave the
 * link-replacement and removal steps. */
let skillsReconcileQueue: Promise<void> = Promise.resolve();

function queueSkillsReconcile(requestId?: string): void {
  const run = async () => {
    // Read at run time, not queue time: a pass queued behind another always applies the freshest
    // authoritative list, and replaying it under an older requestId still reports converged truth.
    const desired = lastDesiredSkills;
    try {
      const result = await reconcileSkills({
        dataDir: config.dataDir,
        home: homedir(),
        agents: metadata.agents,
        desired: desired ?? [],
        // Content frames are published immediately to bound memory. While their completion fence
        // is pending, suppress removal/GC so an interleaved discovery pass cannot reclaim that
        // newly cached digest (especially when previousVersionMinutes is configured to zero).
        allowRemovals: desired !== null && !chunkedSkillsSync.inProgress,
        log,
        acquireProviderHomeLease: () =>
          sessions.acquireSkillReconciliationProviderHome(homedir()),
        removedSkillRetentionMs: config.skillRetention.removedSkillDays * 24 * 60 * 60 * 1000,
        previousVersionGraceMs: config.skillRetention.previousVersionMinutes * 60 * 1000,
      });
      sendUp(skillsStateMessage(config.runnerId, result, requestId));
    } catch (error) {
      sendUp({
        type: "skills_state",
        runnerId: config.runnerId,
        ...(requestId !== undefined ? { requestId } : {}),
        deployed: [],
        unmanaged: [],
        removals: [],
        error: `skill reconcile failed: ${errText(error)}`,
      });
    }
  };
  skillsReconcileQueue = skillsReconcileQueue.then(run, run);
}

let discovering = false;
let rediscoverPending = false;
let rediscoverRefreshModels = false;
let rediscoverRefreshSubscriptionUsage = false;
/** At least one discovery pass has completed — its result is baked into metadata.agents. */
let discoveryDone = false;
const DISCOVERY_REFRESH_MS = 5 * 60_000;
let discoveryTimer: ReturnType<typeof setInterval> | null = null;

function publishSubscriptionUsageInventory(refreshCodex: boolean): void {
  if (!shouldPublishSubscriptionUsageInventory(discoveryDone, controlPlaneProtocolVersion)) return;
  sendUp({
    type: "subscription_usage_inventory",
    runnerId: config.runnerId,
    snapshots: subscriptionUsage.syncSources(),
  });
  if (!refreshCodex) return;
  void subscriptionUsage.refreshAll()
    .then((snapshots) => {
      if (!shouldPublishSubscriptionUsageInventory(discoveryDone, controlPlaneProtocolVersion)) return;
      sendUp({
        type: "subscription_usage_inventory",
        runnerId: config.runnerId,
        snapshots,
      });
    })
    .catch((error) => log(`subscription usage refresh failed: ${errText(error)}`));
}

/** Probe installed agents, merge into the advertised list, and push to the control
 * plane if already registered. Safe to call repeatedly (e.g. on a rediscover) — a
 * call made while a pass is in flight is coalesced into a single trailing rerun. */
async function runDiscovery(refreshModels = false, refreshSubscriptionUsage = true): Promise<void> {
  if (discovering) {
    rediscoverPending = true;
    rediscoverRefreshModels ||= refreshModels;
    rediscoverRefreshSubscriptionUsage ||= refreshSubscriptionUsage;
    return;
  }
  discovering = true;
  try {
    const registryPromise = config.features.acpRegistry
      ? discoverRegistryAgents({
          dataDir: config.dataDir,
          allowedAgentIds: config.acpRegistryAgents,
          refresh: refreshModels,
        }).catch((error) => {
          log(`ACP Registry unavailable: ${(error as Error).message}`);
          return [];
        })
      : Promise.resolve([]);
    const [nativeAgents, registryAgents, editors] = await Promise.all([
      discoverAgents(),
      registryPromise,
      discoverEditors(),
    ]);
    const discovered = [...nativeAgents, ...registryAgents];
    // Enrich the merged list with dynamic per-version/context models (live app-server model/list,
    // labeled cache fallback, codex-exec cache, or Claude aliases), replacing the catalog list.
    // The conductor is synthesized AFTER the merge — inside discovery, a configured claude entry
    // sharing the launch key would silently suppress it via the merge's usedKeys check.
    metadata.agents = applyClaudeHookCapability(
      await enrichAgentModels(withConductorAgent(
        mergeAgents(configAgents, discovered),
      ), {
        refresh: refreshModels,
      }),
      claudeHookFeatureEnabled,
      log,
    );
    // A definitive native discovery result is newer authoritative evidence than the process-local
    // failure overlay. Drop only its status (preserving ACP capability state) so a terminal login
    // followed by rediscovery cannot be overwritten by stale "unauthenticated" state.
    for (const agent of metadata.agents) {
      if ((agent.driver ?? "acp") === "acp" || agent.authStatus === undefined || agent.authStatus === "unknown") continue;
      const runtime = acpAuthStatus.get(agent.id);
      if (!runtime?.status) continue;
      if (runtime.capabilities) acpAuthStatus.set(agent.id, { capabilities: runtime.capabilities });
      else acpAuthStatus.delete(agent.id);
    }
    metadata.agents = overlayAcpAuthStatus(metadata.agents, acpAuthStatus);
    metadata.editors = editors;
    discoveryDone = true;
    const extra = metadata.agents.length - configAgents.length;
    log(
      `discovery: ${nativeAgents.length} local + ${registryAgents.length} registry agent(s), ` +
        `${extra} added (${metadata.agents.length} total), ` +
        `${editors.length} editor(s)`,
    );
    // Always push the result. sendUp buffers in the outbox until the runner is
    // registered, so a pass that finishes after the register frame is sent (but
    // before the `registered` reply) still reaches the control plane via flush —
    // it isn't lost to the stale agent list in the already-sent register.
    const update: AgentsUpdatedMessage = {
      type: "agents_updated",
      runnerId: config.runnerId,
      agents: agentsForControlPlane(),
      editors,
    };
    sendUp(update);
    // Discovery may have changed the agent list, and harness skill dirs drift out of band: heal
    // links against the last authoritative desired list (scan-only, no removals, before the first
    // sync) and report fresh deployment + unmanaged state. Gated so a pre-v90 control plane never
    // receives an unsolicited message type it cannot parse.
    if (runnerSupportsProtocol(controlPlaneProtocolVersion, "agentSkills")) queueSkillsReconcile();
    if (registered) publishSubscriptionUsageInventory(refreshSubscriptionUsage);
  } catch (err) {
    log(`discovery failed: ${(err as Error).message}`);
  } finally {
    discovering = false;
    if (rediscoverPending) {
      rediscoverPending = false;
      const refresh = rediscoverRefreshModels;
      const refreshUsage = rediscoverRefreshSubscriptionUsage;
      rediscoverRefreshModels = false;
      rediscoverRefreshSubscriptionUsage = false;
      void runDiscovery(refresh, refreshUsage);
    }
  }
}

let backoff = INITIAL_BACKOFF_MS;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;
// Consecutive heartbeat pings sent without a pong reply on the current socket. Reset by the 'pong'
// handler attached in connect() and by startHeartbeat() when a fresh socket registers.
let missedHeartbeatPongs = 0;
const sessionCommandRecoveryTimer = setInterval(recoverStaleSessionCommands, 10_000);
sessionCommandRecoveryTimer.unref?.();
recoverStaleSessionCommands();

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat(socket: WebSocket, intervalMs: number): void {
  stopHeartbeat();
  missedHeartbeatPongs = 0;
  heartbeatTimer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    // Half-open detection: the socket still reads OPEN, but if the last several ws-level pings went
    // unanswered the peer is gone. Terminate now — ws emits 'close' immediately, so the close handler
    // enters the reconnect/backoff/outbox path instead of us writing frames into a dead socket until
    // the OS TCP timeout finally errors it (many minutes).
    if (missedHeartbeatPongs >= MAX_MISSED_HEARTBEAT_PONGS) {
      log(`control plane heartbeat unanswered (${missedHeartbeatPongs} missed pongs) — terminating socket to reconnect`);
      socket.terminate();
      return;
    }
    missedHeartbeatPongs++;
    const beat: HeartbeatMessage = { type: "heartbeat", runnerId: config.runnerId, ts: Date.now() };
    socket.send(JSON.stringify(beat));
    // A pong resets missedHeartbeatPongs via the connect() handler; a live peer therefore never
    // accumulates toward the terminate threshold.
    socket.ping();
  }, intervalMs);
}

function scheduleReconnect(): void {
  if (shuttingDown) return;
  log(`reconnecting in ${Math.round(backoff / 1000)}s`);
  reconnectTimer = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
}

// Contain a fire-and-forget async command handler. A malformed frame that reaches one of these
// (e.g. `git_action` with no `action`) rejects AFTER handleCommand's synchronous try/catch has
// returned, so without this the rejection reaches the process-level unhandledRejection net and
// shuts the runner down — defeating the whole point of isolating a bad frame. Log and drop instead.
function runCommandTask(kind: string, task: Promise<void>): void {
  void task.catch((error) => log(`dropping unhandled control-plane frame (${kind}): ${errText(error)}`));
}

function handleCommand(msg: ControlPlaneToRunner): void {
  switch (msg.type) {
    case "registered":
      try {
        stagedRunnerCredential.promote();
      } catch (error) {
        log(`could not promote the registered runner credential: ${(error as Error).message}`);
        ws?.close();
        break;
      }
      backoff = INITIAL_BACKOFF_MS;
      registered = true;
      controlPlaneProtocolVersion = msg.protocolVersion ?? null;
      log(`registered (heartbeat every ${msg.heartbeatIntervalMs}ms)`);
      if (ws) startHeartbeat(ws, msg.heartbeatIntervalMs);
      flushOutbox();
      // Registration snapshots are sent before the control plane's protocol version is known, so
      // they conservatively omit native capability overlays. Re-publish negotiated snapshots now;
      // v65 peers continue to receive no overlay, while v66+ peers get the hook transport truth.
      publishNegotiatedSessionSnapshots(sessions, sendUp);
      // The CP may have restarted or missed live frames. Reconcile retained terminal processes
      // from bounded, sequence-addressed snapshots, then close the inventory with a fence.
      const shellSnapshots = shells.snapshots();
      for (const snapshot of shellSnapshots) sendUp(snapshot);
      sendUp({ type: "shell_inventory_complete", shellIds: shellSnapshots.map((s) => s.shellId) });
      // A register wipes the control plane's discovery-done marker (an empty agent list must read
      // as "still probing", not "none installed"), and a reconnect runs NO new discovery pass — so
      // re-push the last completed result to restore the marker. Idempotent: the CP replaces its
      // agent rows, and a duplicate next to a just-flushed agents_updated is harmless.
      if (discoveryDone) {
        sendUp({ type: "agents_updated", runnerId: config.runnerId, agents: agentsForControlPlane(), editors: metadata.editors });
      }
      publishSubscriptionUsageInventory(true);
      // The CP dropped this runner's queue overlays on register (in-memory queues are assumed
      // dead), but OURS survived the socket blip — re-report every non-empty queue or those
      // prompts stay invisible and uncancelable until the queue next changes.
      sessions.reportQueues();
      sessions.recoverAllOrphanedWork();
      for (const receipt of durableCommands.recentUpdates()) sendDurableUpdate(receipt);
      for (const receipt of sessionCommandReceipts.recentUpdates()) sendSessionCommandUpdate(receipt);
      break;
    case "register_rejected":
      log(`registration rejected: ${msg.reason}`);
      // Keep the staged bytes for the reconnect loop. A transient rejection can be followed by a
      // successful registration with the same pending token; discarding here would make promote()
      // a no-op and leave conductor processes on the revoked prior credential after cutover.
      ws?.close();
      break;
    case "policy_hook_credential_registered":
      try {
        if (msg.accepted) {
          markClaudeHookCredentialReady(claudeHookHost.configDir, msg.sessionId, msg.tokenHash);
        } else {
          markClaudeHookCredentialRejected(claudeHookHost.configDir, msg.sessionId);
          log(`Claude hooks ${msg.sessionId}: credential registration rejected (${msg.error ?? "unknown session binding"})`);
        }
      } catch (error) {
        log(`Claude hooks ${msg.sessionId}: credential acknowledgement rejected (${errText(error)})`);
      }
      break;
    case "agent_control_credential_registered":
      try {
        if (msg.accepted) markAgentControlCredentialReady(agentControlHost.configDir, msg.sessionId, msg.tokenHash);
        else {
          markAgentControlCredentialRejected(agentControlHost.configDir, msg.sessionId);
          log(`agent control ${msg.sessionId}: credential registration rejected (${msg.error ?? "unknown session binding"})`);
        }
      } catch (error) {
        markAgentControlCredentialRejected(agentControlHost.configDir, msg.sessionId);
        log(`agent control ${msg.sessionId}: credential acknowledgement rejected (${errText(error)})`);
      }
      break;
    case "start_session":
      log(`start_session ${msg.spec.sessionId} (${msg.spec.agentId})`);
      if (!validatePromptImageInputs(msg.initialImages ?? []).ok) {
        log("ignored start_session with malformed prompt images");
        break;
      }
      // Provision the conductor BEFORE sessions.start(): start() persists spec.args/config
      // into the box store's meta, so the injected MCP flags survive restarts and the
      // resume path reuses them. A provisioning failure fails the session loudly — a
      // conductor without its manager tools would only look broken in confusing ways.
      try {
        provisionConductor(
          msg.spec,
          {
            controlPlaneUrl: config.controlPlaneUrl,
            tokenFile: runnerCredentialFile,
                allowInsecureTransport,
          },
          log,
          conductorHost,
        );
        provisionClaudeHooks(
          msg.spec,
          {
            controlPlaneUrl: config.controlPlaneUrl,
            controlPlaneProtocolVersion,
            enabled: claudeHookFeatureEnabled,
            allowInsecureTransport,
            registerCredential: registerPolicyHookCredential,
          },
          log,
          claudeHookHost,
        );
      } catch (err) {
        sendUp({
          type: "session_status",
          sessionId: msg.spec.sessionId,
          status: "failed",
          detail: `session launch provisioning failed: ${errText(err)}`,
        });
        break;
      }
      startTrackedSession(msg);
      break;
    case "prompt_session":
      if (!validatePromptImageInputs(msg.images ?? []).ok) {
        log("ignored prompt_session with malformed prompt images");
        break;
      }
      sessions.prompt(msg.sessionId, msg.text, msg.images, msg.slashCommand, msg.config);
      break;
    case "steer_session": {
      handleSteerSessionMessage(msg, sessions, sendUp);
      break;
    }
    case "resolve_steering_attempt": {
      handleResolveSteeringAttemptMessage(msg, sessions, sendUp);
      break;
    }
    case "invoke_session_command": {
      if (!isInvokeSessionCommandMessage(msg)) {
        log("ignored malformed invoke_session_command envelope");
        break;
      }
      let claim: ReturnType<SessionCommandReceiptStore["claim"]>;
      try {
        claim = sessionCommandReceipts.claim(msg);
      } catch (error) {
        log(`session command ${msg.invocationId} journal failure: ${errText(error)}`);
        // The journal may have committed before the filesystem error surfaced. Silence is safer
        // than a revision-zero rejection racing the durable owner; the CP will retry until expiry.
        break;
      }
      if (claim.kind === "busy") {
        log(`session command ${msg.invocationId} is owned by another journal operation; awaiting retry`);
        break;
      }
      const response: SessionCommandInvocationResultMessage = {
        type: "session_command_invocation_result",
        requestId: msg.requestId,
        invocationId: claim.receipt.invocationId,
        submissionId: claim.receipt.submissionId,
        sessionId: claim.receipt.sessionId,
        state: claim.receipt.state,
        revision: claim.receipt.revision,
        duplicate: claim.receipt.duplicate,
        ...(claim.receipt.error ? { error: claim.receipt.error } : {}),
        ...(claim.receipt.code ? { code: claim.receipt.code } : {}),
      };
      sendUp(response);
      if (!("handle" in claim)) break;
      const lifecycle = sessionCommandLifecycle(claim.handle);
      try {
        sessions.invokeSessionCommand(msg, lifecycle);
      } catch (error) {
        lifecycle.failed(`session command acceptance failed: ${errText(error)}`, "INVALID_COMMAND");
      }
      break;
    }
    case "durable_session_command": {
      if (!isDurableSessionCommandMessage(msg)) {
        log("ignored malformed durable_session_command envelope");
        break;
      }
      let claim: ReturnType<DurableCommandStore["claim"]>;
      try {
        claim = durableCommands.claim(msg);
      } catch (error) {
        log(`durable command ${msg.commandId} journal failure: ${errText(error)}`);
        // The exception may have happened after another process durably accepted this identity.
        // A revision-zero terminal response could beat that owner's ACK, so remain silent and let
        // the persistent sender retry or expire the command with an explicit unknown outcome.
        break;
      }
      if (claim.kind === "busy") {
        log(`durable command ${msg.commandId} is owned by another journal operation; awaiting sender retry`);
        break;
      }
      const response: DurableSessionCommandResultMessage = {
        type: "durable_session_command_result",
        requestId: msg.requestId,
        commandId: claim.receipt.commandId,
        sessionId: claim.receipt.sessionId,
        state: claim.receipt.state,
        revision: claim.receipt.revision,
        duplicate: claim.receipt.duplicate,
        ...(claim.receipt.error ? { error: claim.receipt.error } : {}),
        ...(claim.receipt.code ? { code: claim.receipt.code } : {}),
      };
      sendUp(response);
      if (!("handle" in claim)) break;
      const lifecycle = durableLifecycle(claim.handle);
      if (msg.command.type === "start_session") {
        try {
          provisionConductor(
            msg.command.spec,
            {
              controlPlaneUrl: config.controlPlaneUrl,
              tokenFile: runnerCredentialFile,
                    allowInsecureTransport,
            },
            log,
            conductorHost,
          );
          provisionClaudeHooks(
            msg.command.spec,
            {
              controlPlaneUrl: config.controlPlaneUrl,
              controlPlaneProtocolVersion,
              enabled: claudeHookFeatureEnabled,
              allowInsecureTransport,
              registerCredential: registerPolicyHookCredential,
            },
            log,
            claudeHookHost,
          );
        } catch (error) {
          lifecycle.failed(`session launch provisioning failed: ${errText(error)}`, "INVALID_COMMAND");
          break;
        }
        startTrackedSession(msg.command, lifecycle);
      } else {
        try {
          sessions.prompt(
            msg.command.sessionId,
            msg.command.text,
            msg.command.images,
            msg.command.slashCommand,
            msg.command.config,
            lifecycle,
          );
        } catch (error) {
          lifecycle.failed(`prompt acceptance failed: ${errText(error)}`);
        }
      }
      break;
    }
    case "cancel_session":
    case "interrupt_turn": {
      const reason = handleSessionCancellationCommand(msg, {
        cancelSessionStart: (sessionId) => sessionStarts.cancel(sessionId),
        cancelSession: (sessionId) => sessions.cancel(sessionId),
        interruptTurn: (sessionId, turnId) => sessions.interruptTurn(sessionId, turnId),
      });
      if (msg.type === "interrupt_turn" && msg.requestId && reason) {
        sendUp({
          type: "interrupt_turn_result",
          requestId: msg.requestId,
          sessionId: msg.sessionId,
          applied: reason === "applied" || reason === "already_requested",
          reason,
        });
      }
      break;
    }
    case "cancel_queued_prompt":
      sessions.removeQueuedPrompt(msg.sessionId, msg.promptId);
      break;
    case "read_queued_prompt":
      sendUp(sessions.readQueuedPrompt(msg));
      break;
    case "edit_queued_prompt":
      sendUp(sessions.editQueuedPrompt(msg));
      break;
    case "stop_session":
      try {
        sessions.stop(msg.sessionId);
        if (msg.operationId) {
          sendUp({
            type: "stop_session_result",
            sessionId: msg.sessionId,
            operationId: msg.operationId,
            ...(msg.deliveryAttemptId ? { deliveryAttemptId: msg.deliveryAttemptId } : {}),
            accepted: true,
          });
        }
      } catch (error) {
        const detail = errText(error).replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 240);
        if (msg.operationId) {
          sendUp({
            type: "stop_session_result", sessionId: msg.sessionId,
            operationId: msg.operationId, accepted: false, error: detail,
            ...(msg.deliveryAttemptId ? { deliveryAttemptId: msg.deliveryAttemptId } : {}),
          });
        } else log("session stop failed for " + msg.sessionId + ": " + detail);
      }
      break;
    case "rearm_governance":
      sessions.rearmGovernance(msg.sessionId, msg.config, msg.holdFor);
      break;
    case "delete_session":
      sessionStarts.cancel(msg.sessionId);
      void sessions.delete(msg.sessionId).catch((error) => {
        log(`session deletion failed for ${msg.sessionId}: ${errText(error)}`);
      });
      shells.closeForSession(msg.sessionId);
      // Reap the conductor per-session MCP config too. It references the runner credential file;
      // best-effort removal is a no-op for non-conductor sessions.
      removeConductorMcpConfig(msg.sessionId, conductorHost.configDir);
      removeClaudeHookFiles(msg.sessionId, claudeHookHost.configDir);
      removeAgentControlFiles(msg.sessionId, agentControlHost.configDir);
      break;
    case "resolve_permission":
      sessions.resolvePermission(msg.sessionId, msg.requestId, msg.optionId);
      break;
    case "answer_question":
      sessions.answerQuestion(msg.sessionId, msg.requestId, msg.answers, msg.action);
      break;
    case "rewind_session": {
      // Serialize behind the same per-session queue as mutating git actions: a rewind
      // restoring files while stage_hunk/commit/open_pr runs between its stale-check and
      // apply would corrupt the very state those actions just validated. The session turn
      // lock does NOT cover git actions — this queue is their only serializer.
      // Fence prompts IMMEDIATELY (not just inside rewind()): a prompt landing during the
      // queue wait would run a turn whose edits the delayed rewind then silently overwrote.
      if (!sessions.fenceRewind(msg.sessionId)) {
        sendUp({ type: "rewind_result", requestId: msg.requestId, ok: false, error: "a rewind is already in progress" });
        break;
      }
      const receivedAt = Date.now();
      const prior = gitActionQueues.get(msg.sessionId) ?? Promise.resolve();
      const run = prior.then(async () => {
        // Same expiry contract as queued git mutations: past the caller's budget the CP has
        // already reported failure — restoring NOW would be a ghost rewind.
        const budget = msg.timeoutMs ?? 30_000;
        if (Date.now() - receivedAt >= budget) {
          sessions.releaseRewindFence(msg.sessionId);
          sendUp({
            type: "rewind_result",
            requestId: msg.requestId,
            ok: false,
            error: "the rewind expired while waiting behind another git action — retry",
          });
          return;
        }
        const r = await sessions.rewind(msg.sessionId, msg.turn, /* alreadyFenced */ true);
        sendUp({ type: "rewind_result", requestId: msg.requestId, ok: r.ok, error: r.error });
      });
      gitActionQueues.set(msg.sessionId, run);
      void run
        // A rewind that rejects (an I/O fault in rewind(), or a malformed frame that slipped past
        // the fenceRewind guard) must not reach the process unhandledRejection net. Contain it on
        // the void-discarded branch; the stored `run` used for queue chaining is left untouched.
        .catch((error) => log(`dropping unhandled control-plane frame (rewind_session): ${errText(error)}`))
        .finally(() => {
          if (gitActionQueues.get(msg.sessionId) === run) gitActionQueues.delete(msg.sessionId);
        });
      break;
    }
    case "fork_session": {
      void sessions
        .forkConversation(msg.sourceSessionId, msg.targetSessionId, msg.turn, msg.title, msg.deferHistory === true)
        .then((result) =>
          sendUp({
            type: "fork_result",
            requestId: msg.requestId,
            ok: result.ok,
            error: result.error,
            snapshot: result.snapshot,
            events: result.events,
          }),
        )
        .catch((err) =>
          sendUp({ type: "fork_result", requestId: msg.requestId, ok: false, error: errText(err) }),
        );
      break;
    }
    case "session_worktree": {
      const operation: Promise<{ snapshot: SessionSnapshot; worktree?: SessionWorktreeView }> = msg.operation === "create"
        ? sessions.requestWorktree(msg.sessionId, { branch: msg.branch, baseRef: msg.baseRef })
        : msg.operation === "attach"
          ? sessions.attachWorktree(msg.sessionId, msg.path)
          : msg.operation === "select"
            ? sessions.selectWorktree(msg.sessionId, msg.path).then((snapshot) => ({
              snapshot,
              worktree: snapshot.worktrees?.find((item) => item.path === snapshot.worktreePath),
            }))
            : sessions.discardWorktree(msg.sessionId, msg.path).then((snapshot) => ({ snapshot }));
      void operation.then((result) => sendUp({
        type: "session_worktree_result",
        requestId: msg.requestId,
        ok: true,
        snapshot: result.snapshot,
        ...(result.worktree ? { worktree: result.worktree } : {}),
      })).catch((error) => sendUp({
        type: "session_worktree_result",
        requestId: msg.requestId,
        ok: false,
        error: errText(error),
      }));
      break;
    }
    case "rediscover":
      log("rediscover requested");
      void runDiscovery(true);
      break;
    case "refresh_subscription_usage":
      if (!shouldPublishSubscriptionUsageInventory(discoveryDone, controlPlaneProtocolVersion)) {
        sendUp({
          type: "subscription_usage_refresh_result",
          requestId: msg.requestId,
          ok: false,
          error: "subscription usage refresh is unavailable until agent discovery completes",
        });
        break;
      }
      void subscriptionUsage.refreshAll()
        .then((snapshots) => sendUp({
          type: "subscription_usage_refresh_result",
          requestId: msg.requestId,
          ok: true,
          snapshots,
        }))
        .catch((error) => sendUp({
          type: "subscription_usage_refresh_result",
          requestId: msg.requestId,
          ok: false,
          error: `subscription usage refresh failed: ${errText(error)}`,
        }));
      break;
    case "generate_session_title": {
      if (msg.mode === "custom_model_endpoint") {
        if (!runnerSupportsProtocol(controlPlaneProtocolVersion, "sessionCustomModelNaming")) {
          sendUp({
            type: "generate_session_title_result",
            requestId: msg.requestId,
            ok: false,
            code: "provider_unsupported",
            phase: "preflight",
          });
          break;
        }
        runCommandTask(
          "generate_session_title",
          sessionNamingCustomModel.generateResult(msg).then((result) => sendUp(result)),
        );
        break;
      }
      if (msg.target && !runnerSupportsProtocol(controlPlaneProtocolVersion, "sessionNamingTargets")) {
        sendUp({
          type: "generate_session_title_result",
          requestId: msg.requestId,
          ok: false,
          code: "provider_unsupported",
          phase: "preflight",
        });
        break;
      }
      const meta = msg.target ? undefined : store.readMeta(msg.sessionId);
      const agent = msg.target
        ? metadata.agents.find((candidate) => candidate.id === msg.target!.agentId &&
            (candidate.driver ?? "acp") === msg.target!.driver)
        : meta?.agentId
          ? metadata.agents.find((candidate) =>
            candidate.id === meta.agentId &&
            (candidate.driver ?? "acp") === meta.driver &&
            JSON.stringify(candidate.context ?? { kind: "native" }) === JSON.stringify(meta.context),
          )
          : undefined;
      const env = agent
        ? runnerLocalAgentEnv(agent.id, agent.driver ?? "acp", agent.context ?? { kind: "native" })
        : {};
      runCommandTask("generate_session_title", sessionNaming.execute(
        msg,
        agent,
        env,
        controlPlaneProtocolVersion,
      ).then((result) => sendUp(result)));
      break;
    }
    case "configure_session_naming_custom_model": {
      if (!runnerSupportsProtocol(controlPlaneProtocolVersion, "sessionCustomModelNaming")) break;
      const result = sessionNamingCustomModel.result(msg.requestId, "configure", () =>
        sessionNamingCustomModel.configure({ endpoint: msg.endpoint, model: msg.model, timeoutMs: msg.timeoutMs }, msg.apiKey),
      );
      metadata.sessionNamingCustomModel = sessionNamingCustomModel.status();
      sendUp(result);
      break;
    }
    case "delete_session_naming_custom_model_key": {
      if (!runnerSupportsProtocol(controlPlaneProtocolVersion, "sessionCustomModelNaming")) break;
      const result = sessionNamingCustomModel.result(msg.requestId, "delete_api_key", () =>
        sessionNamingCustomModel.deleteApiKey(),
      );
      metadata.sessionNamingCustomModel = sessionNamingCustomModel.status();
      sendUp(result);
      break;
    }
    case "test_session_naming_custom_model":
      if (runnerSupportsProtocol(controlPlaneProtocolVersion, "sessionCustomModelNaming")) {
        runCommandTask(
          "test_session_naming_custom_model",
          sessionNamingCustomModel.testResult(msg.requestId).then((result) => sendUp(result)),
        );
      }
      break;
    case "logout_agent":
      runCommandTask("logout_agent", sessions.logoutAgent(msg.sessionId).then((result) =>
        sendUp({
          type: "logout_agent_result",
          requestId: msg.requestId,
          ok: result.ok,
          error: result.error,
        }),
      ));
      break;
    case "acp_registry_approval":
      void (async () => {
        const fail = (error: string) => sendUp({
          type: "acp_registry_approval_result",
          requestId: msg.requestId,
          agentId: msg.agentId,
          action: msg.action,
          ok: false,
          error,
        });
        if (msg.runnerId !== config.runnerId) return fail("registry approval targeted a different runner");
        if (msg.confirmation !== "explicit") return fail("explicit registry confirmation is required");
        if (!config.features.acpRegistry) return fail("ACP Registry is disabled by runner policy");
        try {
          await updateRegistryApproval({
            dataDir: config.dataDir,
            allowedAgentIds: config.acpRegistryAgents,
            agentId: msg.agentId,
            schemaVersion: msg.schemaVersion,
            adapterVersion: msg.adapterVersion,
            action: msg.action,
          });
          sendUp({
            type: "acp_registry_approval_result",
            requestId: msg.requestId,
            agentId: msg.agentId,
            action: msg.action,
            ok: true,
          });
          void runDiscovery(true);
        } catch (error) {
          fail(errText(error));
        }
      })();
      break;
    case "skills_sync":
      chunkedSkillsSync.reset();
      if (msg.runnerId !== config.runnerId) {
        sendUp({
          type: "skills_state",
          runnerId: config.runnerId,
          ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}),
          deployed: [],
          unmanaged: [],
          removals: [],
          error: "skills sync targeted a different runner",
        });
        break;
      }
      lastDesiredSkills = msg.skills;
      queueSkillsReconcile(msg.requestId);
      break;
    case "skills_sync_manifest":
      beginChunkedSkillsSync(msg);
      break;
    case "skills_sync_content":
      acceptChunkedSkillContent(msg);
      break;
    case "skills_sync_complete":
      completeChunkedSkillsSync(msg);
      break;
    case "git_action":
      runCommandTask("git_action", handleGitAction(msg));
      break;
    case "session_history": {
      // Reply with the session's event log from the box store (control plane lazy-hydration).
      try {
        const events = sessions.history(msg.sessionId, msg.afterSeq);
        sendUp({ type: "session_history_result", requestId: msg.requestId, sessionId: msg.sessionId, ok: true, events });
      } catch (error) {
        const detail = errText(error).replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 240);
        sendUp({ type: "session_history_result", requestId: msg.requestId, sessionId: msg.sessionId, ok: false, error: detail });
      }
      break;
    }
    case "session_history_page": {
      const result = sessions.historyPage(msg.sessionId, {
        afterSeq: msg.afterSeq,
        limit: msg.limit,
        ...(msg.logEpoch === undefined ? {} : { logEpoch: msg.logEpoch }),
        ...(msg.throughSeq === undefined ? {} : { throughSeq: msg.throughSeq }),
      });
      sendUp(result.ok
        ? {
            type: "session_history_page_result",
            requestId: msg.requestId,
            sessionId: msg.sessionId,
            ok: true,
            events: result.events,
            page: result.page,
          }
        : {
            type: "session_history_page_result",
            requestId: msg.requestId,
            sessionId: msg.sessionId,
            ok: false,
            code: result.code,
            error: result.error,
          });
      break;
    }
    case "list_external_sessions":
      runCommandTask("list_external_sessions", handleListExternal(msg.requestId, msg.agentId));
      break;
    case "adopt_session":
      runCommandTask("adopt_session", handleAdopt(msg));
      break;
    case "reprocess_session":
      runCommandTask("reprocess_session", handleReprocess(msg));
      break;
    case "list_directory":
      runCommandTask("list_directory", handleListDirectory(msg));
      break;
    case "list_session_files":
      runCommandTask("list_session_files", handleListSessionFiles(msg));
      break;
    case "read_session_file":
      runCommandTask("read_session_file", handleReadSessionFile(msg));
      break;
    case "shell_open": {
      runCommandTask("shell_open", handleShellOpenCommand(msg, {
        waitForSessionStart: (sessionId) => sessionStarts.wait(sessionId),
        registerPending: (shellId) => pendingShellOpenCancellations.register(shellId),
        unregisterPending: (shellId) => pendingShellOpenCancellations.unregister(shellId),
        consumeCancellation: (shellId) => pendingShellOpenCancellations.consume(shellId),
        sessionCanOpen: (sessionId) => sessions.sessionCanOpen(sessionId),
        resolveTarget: (sessionId) => sessionFilesTarget(sessionId),
        resolveAgentTuiLaunch: (meta) => {
          const launch = agentTuiLaunch(meta);
          if (launch) sessions.acquireAgentTuiProviderHome(meta);
          return launch;
        },
        open: (message, target, launch) => shells.open(
          message.shellId,
          message.sessionId,
          target.root,
          target.context,
          { cols: message.cols, rows: message.rows },
          { name: message.name, createdAt: message.createdAt, kind: message.kind, launch },
        ),
        send: (result) => sendUp(result),
        errorText: (error) => errText(error),
      }));
      break;
    }
    case "shell_resize":
      shells.resize(msg.shellId, msg.cols, msg.rows);
      break;
    case "shell_input":
      // Dead-target writes surface as a synthetic exit so the dashboard's tab closes cleanly
      // instead of swallowing keystrokes (phantom-resolution lesson from the approvals work).
      if (!shells.input(msg.shellId, msg.data)) {
        sendUp({ type: "shell_exit", sessionId: "", shellId: msg.shellId, code: null });
      }
      break;
    case "shell_close":
      pendingShellOpenCancellations.cancel(msg.shellId);
      shells.close(msg.shellId);
      break;
    case "host_action":
      runCommandTask("host_action", handleHostAction(msg));
      break;
  }
}

/** Open-in-editor / reveal: resolve the target like files/shells do, then hand off to the OS. */
async function handleHostAction(msg: HostActionMessage): Promise<void> {
  const reply = (r: { ok: true } | { ok: false; error: string }) =>
    sendUp({ type: "host_action_result", requestId: msg.requestId, ...r });
  let root: string;
  let context: AgentContext;
  if (msg.path) {
    // Explicit path (project-level reveal) — native host context. A POSIX-style path on a
    // Windows host is a WSL workspace root; without a distro there is no way to build the
    // \\wsl.localhost UNC path, so refuse clearly instead of opening a nonsense location.
    if (process.platform === "win32" && msg.path.startsWith("/")) {
      return reply({ ok: false, error: "this looks like a WSL path — project-level reveal can't resolve its distro yet" });
    }
    root = msg.path;
    context = { kind: "native" };
  } else {
    const target = msg.sessionId ? sessionFilesTarget(msg.sessionId) : null;
    if (!target || target === "pending") {
      return reply({ ok: false, error: target === "pending" ? WORKTREE_PENDING_ERROR : "unknown session" });
    }
    root = target.root;
    context = target.context;
  }
  try {
    reply(await runHostAction(msg.action, root, context));
  } catch (err) {
    reply({ ok: false, error: errText(err) });
  }
}

/** Files/shells: resolve the session's root from box meta (worktreePath ?? repoPath) — the
 * dashboard only ever names root-relative paths, in this box's own context (native or WSL).
 * "pending" while worktree setup is still in flight: falling back to repoPath in that window
 * would put a shell/browser in the shared base checkout while the agent lands in the worktree. */
function sessionFilesTarget(sessionId: string): { root: string; context: AgentContext; meta: SessionMeta } | "pending" | null {
  const meta = store.readMeta(sessionId);
  if (!meta) return null;
  if (meta.worktreePending && !meta.worktreePath) return "pending";
  return { root: meta.worktreePath ?? meta.repoPath, context: meta.context, meta };
}

const WORKTREE_PENDING_ERROR = "the session's worktree is still being prepared — try again in a moment";

async function handleListSessionFiles(msg: ListSessionFilesRequestMessage): Promise<void> {
  const target = sessionFilesTarget(msg.sessionId);
  if (!target || target === "pending") {
    const error = target === "pending" ? WORKTREE_PENDING_ERROR : "unknown session";
    return sendUp({ type: "list_session_files_result", requestId: msg.requestId, ok: false, error });
  }
  try {
    const listing = await listSessionFiles(target.context, target.root, msg.path);
    sendUp({ type: "list_session_files_result", requestId: msg.requestId, ok: true, ...listing });
  } catch (err) {
    sendUp({ type: "list_session_files_result", requestId: msg.requestId, ok: false, error: errText(err) });
  }
}

async function handleReadSessionFile(msg: ReadSessionFileRequestMessage): Promise<void> {
  const target = sessionFilesTarget(msg.sessionId);
  if (!target || target === "pending") {
    const error = target === "pending" ? WORKTREE_PENDING_ERROR : "unknown session";
    return sendUp({ type: "read_session_file_result", requestId: msg.requestId, ok: false, error });
  }
  try {
    const file = await readSessionFile(target.context, target.root, msg.path);
    sendUp({ type: "read_session_file_result", requestId: msg.requestId, ok: true, ...file });
  } catch (err) {
    sendUp({ type: "read_session_file_result", requestId: msg.requestId, ok: false, error: errText(err) });
  }
}

/** Browse the runner machine's filesystem so a dashboard can pick a workspace directory. */
async function handleListDirectory(msg: ListDirectoryRequestMessage): Promise<void> {
  try {
    const listing = await listDirectory(msg.context ?? { kind: "native" }, msg.path);
    sendUp({ type: "list_directory_result", requestId: msg.requestId, ok: true, ...listing });
  } catch (err) {
    sendUp({ type: "list_directory_result", requestId: msg.requestId, ok: false, error: errText(err) });
  }
}

/** Re-import an adopted session: re-read its original transcript with the current parser and replace
 * the stored event log, so formatting/parser improvements apply to an already-adopted session. */
async function handleReprocess(msg: ReprocessSessionMessage): Promise<void> {
  const { requestId, sessionId } = msg;
  const replyFail = (error: string) =>
    sendUp({ type: "reprocess_session_result", requestId, sessionId, ok: false, error });

  const meta = store.readMeta(sessionId);
  if (!meta || !meta.agentSessionId || !isAdoptedSession(meta)) {
    return replyFail("only adopted sessions can be re-imported");
  }
  if (sessions.isActive(sessionId)) {
    return replyFail("the session is busy — reprocess is only available when it's idle");
  }
  // Build the descriptor from the session's own (already trusted) metadata and read the transcript by
  // id directly — no capped enumeration, so an older adopted session is still found on disk.
  const descriptor: ExternalSessionDescriptor = {
    agentSessionId: meta.agentSessionId,
    driver: meta.driver,
    cwd: meta.repoPath,
    context: meta.context,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    messageCount: 0,
  };
  try {
    const events = await readExternalTranscript(descriptor);
    if (!events.length) return replyFail("the original CLI transcript could not be read (it may have been deleted)");
    const updated = sessions.reprocess(sessionId, events);
    if (!updated) return replyFail("the session is busy — try again when it's idle");
    sendUp({
      type: "reprocess_session_result",
      requestId,
      sessionId,
      ok: true,
      snapshot: sessions.snapshotForControlPlane(updated),
      ...(msg.deferHistory ? {} : {
        events: store.readEvents(sessionId), // exact until the socket-send peer projection
      }),
      eventCount: events.length,
    });
  } catch (err) {
    replyFail(errText(err));
  }
}

/** Phase 3: enumerate external (CLI-started) sessions on this box, excluding ones we already own. */
async function handleListExternal(requestId: string, agentId?: string): Promise<void> {
  try {
    const selectedAgent = agentId
      ? metadata.agents.find((agent) => agent.id === agentId && agent.available !== false)
      : undefined;
    if (agentId && !selectedAgent) {
      sendUp({
        type: "list_external_sessions_result",
        requestId,
        ok: false,
        error: "the selected agent is not available on this runner",
      });
      return;
    }
    const selectedDriver = selectedAgent?.driver ?? (selectedAgent ? "acp" : undefined);
    const selectedContext = selectedAgent?.context ?? { kind: "native" as const };
    const stored = store.listSessions();
    const knownNative = new Set(
      stored.filter((m) => m.driver !== "acp").map((m) => m.agentSessionId).filter((id): id is string => id != null),
    );
    // Stamp each descriptor with whether THIS box can resume it (same resolver handleAdopt uses),
    // so the dashboard can label the action "Adopt & continue" vs "Adopt as read-only" truthfully.
    const knownAcp = new Set(
      stored.flatMap((m) => m.driver === "acp" && m.agentId && m.agentSessionId
        ? [acpSessionKey(m.agentId, m.agentSessionId)]
        : []),
    );
    const [nativeSessions, acpSessions] = await Promise.all([
      selectedDriver === "acp"
        ? Promise.resolve([])
        : listExternalSessions(
          knownNative,
          selectedDriver ? { driver: selectedDriver, context: selectedContext } : undefined,
        ).then((listed) => listed.map((d) => ({
          ...d,
          resumable: resolveLaunchForDriver(metadata.agents, d.driver, d.context) != null,
        }))),
      selectedDriver && selectedDriver !== "acp"
        ? Promise.resolve([])
        : listAcpExternalSessions(
          selectedAgent ? [selectedAgent] : metadata.agents,
          knownAcp,
          (reportedAgentId, capabilities) => {
            updateAgentAuthStatus(reportedAgentId, { capabilities });
          },
          (warning) => log(warning),
        ),
    ]);
    const externalSessions = [
      ...nativeSessions,
      ...acpSessions.map((session) => session.descriptor),
    ].sort((a, b) => b.updatedAt - a.updatedAt);
    sendUp({ type: "list_external_sessions_result", requestId, ok: true, sessions: externalSessions });
  } catch (err) {
    sendUp({ type: "list_external_sessions_result", requestId, ok: false, error: errText(err) });
  }
}

/** Phase 3: adopt an external session into the box store (optionally backfilling its transcript). */
async function handleAdopt(msg: AdoptSessionMessage): Promise<void> {
  const { requestId, sessionId, descriptor: claimed, backfill } = msg;
  const fail = (detail: string) => requestId
    ? sendUp({ type: "adopt_session_result", requestId, ok: false, error: detail })
    : sendUp({ type: "session_status", sessionId, status: "failed", detail });

  // Never trust the client-supplied descriptor for execution state. ACP is re-queried through the
  // exact configured adapter; native sessions are re-read from box-owned transcript stores.
  const claimedAcpAgentId = typeof claimed.agentId === "string" && claimed.agentId ? claimed.agentId : null;
  let descriptor: ExternalSessionDescriptor;
  let launch: { command: string; args: string[]; env: Record<string, string> };
  let acpCapabilities: AcpRuntimeCapabilities | undefined;
  if (claimedAcpAgentId) {
    const agent = configuredAcpAgent(metadata.agents, claimedAcpAgentId);
    if (!agent) return fail("that ACP agent is not configured or available on this box");
    const found = await findAcpExternalSession(metadata.agents, claimedAcpAgentId, claimed.agentSessionId);
    if (!found) return fail("that ACP session was not found on the selected agent");
    descriptor = found.descriptor;
    launch = launchForAcpAgent(agent);
    acpCapabilities = found.capabilities;
    updateAgentAuthStatus(claimedAcpAgentId, { capabilities: found.capabilities });
  } else {
    const known = new Set(
      store.listSessions().filter((m) => m.driver !== "acp").map((m) => m.agentSessionId).filter((id): id is string => id != null),
    );
    const found = await findExternalSession(claimed.agentSessionId, known);
    if (!found) return fail("that external session was not found on this box (it may already be adopted)");
    descriptor = retargetExternalSession(found, claimed);
    launch = resolveLaunchForDriver(metadata.agents, descriptor.driver, descriptor.context) ??
      { command: "", args: [], env: {} };
  }

  // No native agent on this box for the session's driver+context (e.g. a Claude *Desktop* session
  // with only a WSL claude installed): adopt anyway as READ-ONLY history — the transcript is the
  // value, and a dead "failed" card helps nobody. The empty command is the read-only sentinel the
  // resume path refuses with a clear message instead of ever spawning "".
  if (!launch.command) {
    log(`adopting ${descriptor.agentSessionId} as read-only — no ${descriptor.driver} agent for its context`);
  }

  // Create the store row BEFORE the (possibly slow) transcript read, so a prompt sent the moment the
  // UI shows the session isn't lost to a missing row.
  if (!sessions.adopt(sessionId, descriptor, launch, acpCapabilities)) {
    return fail("this session has already been adopted");
  }
  if (requestId) {
    const meta = store.readMeta(sessionId);
    if (!meta) return fail("the adopted session could not be persisted");
    sendUp({
      type: "adopt_session_result",
      requestId,
      ok: true,
      descriptor,
      snapshot: sessions.snapshotForControlPlane(meta),
    });
  }

  if (backfill) {
    try {
      const events: SessionEventPayload[] = await readExternalTranscript(descriptor);
      sessions.backfillTranscript(sessionId, events);
      sessions.recoverOrphanedWork(sessionId, false);
    } catch {
      /* best-effort — keep the adopted session without history rather than fail */
    }
  }
}

function errText(err: unknown): string {
  return err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : String(err);
}

/** Per-session promise-chain queue: MUTATING git actions for one session run strictly in order.
 * The dispatch is fire-and-forget (`void handleGitAction`), so without this two mutations could
 * interleave and our own applies could collide on index.lock or check-then-apply races. Reads
 * (status/diff) bypass the queue — they are index-safe on this build (snapshots use throwaway
 * temp indexes) and serializing them behind a slow open_pr would starve the pane for its whole
 * duration (the CP gives reads only 30s). */
const gitActionQueues = new Map<string, Promise<unknown>>();

const GIT_MUTATIONS = new Set<GitAction["kind"]>([
  "stage_hunk",
  "stage_lines",
  "discard_file",
  "commit",
  "open_pr",
  "pod_reconcile",
]);

/** Run a git/PR action in a session worktree and report the result upstream. */
async function handleGitAction(msg: GitActionRequestMessage): Promise<void> {
  if (!GIT_MUTATIONS.has(msg.action.kind)) return runOneGitAction(msg);
  const receivedAt = Date.now();
  // Reconciliation reads the source head and mutates the target, so it owns both session queues.
  // This closes the race with a source-side commit that was already in flight (or arrives while
  // the merge runs), even though the control plane also rejects new overlapping API mutations.
  const lockedSessionIds = msg.action.kind === "pod_reconcile"
    ? [...new Set([msg.sessionId, msg.action.sourceSessionId])].sort()
    : [msg.sessionId];
  const priors = lockedSessionIds.map((sessionId) => gitActionQueues.get(sessionId) ?? Promise.resolve());
  const run = Promise.all(priors).then(() => {
    // A mutation that waited past the control plane's timeout has already been reported as
    // FAILED to the caller — executing it now would silently diverge (ghost commits). Expire it.
    const budget = msg.timeoutMs ?? 30_000;
    if (Date.now() - receivedAt >= budget) {
      sendUp({
        type: "git_result",
        requestId: msg.requestId,
        ok: false,
        error: "the request expired while waiting behind another git action — retry",
      });
      return;
    }
    return runOneGitAction(msg);
  });
  for (const sessionId of lockedSessionIds) gitActionQueues.set(sessionId, run);
  await run.finally(() => {
    // Only the tail entry cleans up — a newer request may have chained past this one.
    for (const sessionId of lockedSessionIds) {
      if (gitActionQueues.get(sessionId) === run) gitActionQueues.delete(sessionId);
    }
  });
}

async function runOneGitAction(msg: GitActionRequestMessage): Promise<void> {
  try {
    // Scope-aware reads (diff) need the session kind, and last_turn needs the turn-start
    // snapshot — both live in the box store's meta. Preserve undefined-vs-null on the tree
    // (never captured vs capture failed) — gitDiff words its error differently for each.
    const meta = store.readMeta(msg.sessionId);
    const execution = resolveGitActionExecution(msg.worktreePath, msg.action, meta);
    const data = await withGitExecutionContext(execution.context.context ?? { kind: "native" }, async () => {
      if (msg.action.kind !== "pod_reconcile") {
        return runGitAction(execution.cwd, msg.action, execution.context);
      }
      const source = store.readMeta(msg.action.sourceSessionId);
      const resolved = validatePodReconciliationMetadata(execution.cwd, meta, source);
      return { podReconciliation: await runPodReconcile(execution.cwd, resolved.sourceWorktreePath, msg.action) };
    });
    if (msg.action.kind === "open_pr" && data.pr?.createdWithGh) {
      await sessions.linkWorktreePullRequest(msg.sessionId, execution.cwd, data.pr.url);
    }
    sendUp({ type: "git_result", requestId: msg.requestId, ok: true, data });
  } catch (err) {
    const text = errText(err);
    const code = err instanceof GitOpError ? err.code : undefined;
    log(`git_action ${msg.action.kind} failed: ${text}`);
    sendUp({ type: "git_result", requestId: msg.requestId, ok: false, error: text, ...(code ? { code } : {}) });
  }
}

function connect(): void {
  log(`connecting to ${config.controlPlaneUrl}`);
  registered = false;
  controlPlaneProtocolVersion = null;
  chunkedSkillsSync.reset();
  const socket = new WebSocket(validateControlPlaneUrl(config.controlPlaneUrl, allowInsecureTransport));
  ws = socket;

  socket.on("open", () => {
    log("connected — registering");
    const register: RegisterMessage = {
      type: "register",
      token: config.token,
      runner: { ...metadata, agents: agentsForControlPlane() },
      // Lets the dashboard flag this runner as outdated when its own PROTOCOL_VERSION is newer.
      protocolVersion: PROTOCOL_VERSION,
      liveSessions: sessions.liveSessionIds(),
      // Phase 2: full metadata for every session in the box store, so this dashboard hydrates
      // sessions it didn't create (and ones from before a runner restart).
      // The peer profile is unknown until `registered`. Advertise complete metadata but no history
      // generation here; the ordered negotiated runtime updates below become authoritative.
      sessionSnapshots: registrationSessionSnapshots(sessions),
    };
    socket.send(JSON.stringify(register));
  });

  socket.on("message", (raw: Buffer) => {
    const msg = parseMessage<ControlPlaneToRunner>(raw.toString());
    if (!msg) return;
    // A malformed frame (missing/mistyped fields survive the cast-only parseMessage) must not
    // throw out of this listener: an uncaught throw here becomes a fatal uncaughtException that
    // bypasses the graceful shutdown/lease-release path and strands the provider-home lease.
    // Drop the bad frame instead — one poisoned command can't take the runner down.
    try {
      handleCommand(msg);
    } catch (error) {
      log(`dropping unhandled control-plane frame (${msg.type}): ${errText(error)}`);
    }
  });

  socket.on("close", () => {
    stopHeartbeat();
    registered = false;
    controlPlaneProtocolVersion = null;
    // Shell processes are runner-owned, not transport-owned. Their bounded snapshots reconcile
    // after registration; only explicit close, session deletion, or runner shutdown kills them.
    log("disconnected");
    if (ws === socket) ws = null;
    scheduleReconnect();
  });

  socket.on("error", (err: Error) => {
    log(`socket error: ${err.message}`);
  });

  // Liveness: every heartbeat sends a ws-level ping; a pong proves the peer is still reachable, so
  // clear the missed-ping counter. Silence across MAX_MISSED_HEARTBEAT_PONGS pings terminates the
  // socket in startHeartbeat.
  socket.on("pong", () => {
    missedHeartbeatPongs = 0;
  });
}

function shutdown(exitCode = 0): void {
  // Second signal while draining = the user really means it — exit hard.
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  // shutdown() is also the uncaughtException path, so the triggering fault (e.g. a storage failure)
  // can make one of these cleanup steps throw. NONE of them may abort before the pending-kill drain
  // and provider-home lease release run: a throw out of the uncaughtException listener makes Node
  // exit IMMEDIATELY, stranding the lease and orphaning agent process trees — the exact failure this
  // path exists to prevent. Run each best-effort so control always reaches waitForPendingKills below.
  const bestEffort = (label: string, fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      log(`shutdown step '${label}' failed: ${errText(error)}`);
    }
  };
  bestEffort("discard staged credential", () => stagedRunnerCredential.discard());
  bestEffort("stop heartbeat", () => stopHeartbeat());
  bestEffort("clear timers", () => {
    clearInterval(sessionCommandRecoveryTimer);
    if (discoveryTimer) clearInterval(discoveryTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
  });
  bestEffort("stop subscription usage", () => subscriptionUsage.shutdown());
  // Track whether every provider driver was disposed. If not (a dispose threw), a provider may still
  // be alive with no registered kill, so we must NOT release its provider-home lease below even if
  // waitForPendingKills reports "reaped" — releasing it could let a replacement runner share the HOME.
  let sessionsCleanlyShutDown = false;
  bestEffort("shut down sessions", () => {
    sessionsCleanlyShutDown = sessions.shutdownAll();
  });
  bestEffort("dispose shells", () => shells.dispose());
  // Providers that exited normally may have intentional background descendants retained under
  // their session boundary. Runner shutdown is the final owner and must drain every such scope.
  bestEffort("register retained descendant cleanup", () => terminateDescendantBoundariesAfterPendingKills());
  log("shutting down");
  // process.exit() cancels pending timers/exec callbacks — exiting immediately would drop
  // the SIGKILL escalation and the WSL in-distro reap, letting TERM-ignoring agents survive
  // the runner. Wait (bounded) until the kills have delivered — incl. SIGKILL: the WSL
  // sequence is pidfile retries + TERM + 2s + KILL. The deadline covers Claude's 5s clean-exit
  // interval plus the reap's 6s safety cap.
  // No active sessions ⇒ zero pending kills ⇒ instant exit (dev restarts stay snappy).
  void waitForPendingKills(
    CLAUDE_GRACEFUL_STOP_BUDGET_MS + DESCENDANT_BOUNDARY_TERMINATION_BUDGET_MS + 500,
  )
    .then((processTreesReaped) => {
      // Never let a throw here skip the exit. Only release the lease when session cleanup completed
      // cleanly AND every tracked process tree was reaped; otherwise retain it (fail closed) so a
      // possibly-still-alive provider cannot share its HOME with a replacement runner.
      try {
        if (sessionsCleanlyShutDown) {
          if (!sessions.releaseProviderHomeLeasesAfterShutdown(processTreesReaped)) {
            log("process-tree cleanup was incomplete — retaining provider-home lease; inspect the preceding survivor diagnostic before restarting this runner");
          }
        } else {
          log("session cleanup was incomplete — retaining provider-home lease to avoid concurrent HOME use");
        }
      } catch (error) {
        log(`provider-home lease release failed: ${errText(error)}`);
      }
    })
    .catch((error) => log(`pending-kill drain failed: ${errText(error)}`))
    .finally(() => process.exit(exitCode));
}

// Wrapped so the signal name Node passes as the listener's first argument is never mistaken for
// shutdown()'s exitCode.
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
process.on("SIGHUP", () => shutdown());
// A synchronous uncaughtException leaves the process in an unknown, possibly corrupt state, so run
// the graceful shutdown() (waits for pending kills, releases provider-home leases) before exiting —
// a hard crash would strand the lease and block every future agent. shutdown()'s own `shuttingDown`
// flag makes re-entry safe; a second fault exits immediately.
process.on("uncaughtException", (error) => {
  try {
    log(`uncaughtException — shutting down: ${errText(error)}`);
  } catch {
    /* logging must never mask the exit */
  }
  shutdown(1);
});
// An unhandled rejection is a LAST-RESORT net, NOT a shutdown trigger: this daemon supervises every
// session on the box, and one session's stray async fault (an unobserved rejection in a fire-and-
// forget command handler this file cannot enumerate exhaustively) must not tear down all the others.
// Node would otherwise terminate by default; log and keep running instead. Frame-dispatched handlers
// still contain their own errors at the source (runCommandTask / per-dispatch .catch) so expected
// failures surface as proper session errors rather than a bare log here.
process.on("unhandledRejection", (reason) => {
  try {
    log(`unhandledRejection (continuing) — ${errText(reason)}`);
  } catch {
    /* logging must never mask survival */
  }
});

log(
  `starting v${VERSION} — host=${metadata.hostname} os=${metadata.os} ` +
    `agents=[${metadata.agents.map((a) => a.id).join(", ")}] ` +
    `workspaces=[${metadata.workspaces.map((w) => w.id).join(", ")}]`,
);
// Probe installed agents in the background; results are advertised on register or
// pushed via agents_updated once discovery completes.
void runDiscovery();
// Claude Code can update itself while the runner remains connected. A bounded periodic pass
// notices the new version and refreshes its flags/auth/slash commands; model discovery is already
// keyed by version, so a changed binary automatically bypasses the prior version's cache entry.
discoveryTimer = setInterval(() => void runDiscovery(false, false), DISCOVERY_REFRESH_MS);
discoveryTimer.unref?.();
// Registration waits for deterministic runner-owned target checks. Missing adapters/images/checks
// stay visible as unavailable; only an unexpected registry failure aborts startup.
void Promise.all([containerTargets.initialize(), cloudTargets.initialize()]).then(() => {
  metadata.executionTargets = [...containerTargets.definitions(), ...cloudTargets.definitions()];
  log(`execution targets=[${metadata.executionTargets.map((target) =>
    `${target.environment?.id}:${target.available ? "ready" : "unavailable"}`).join(", ")}]`);
  connect();
}).catch((error) => {
  console.error(`[runner] execution target checks failed unexpectedly: ${errText(error)}`);
  process.exit(1);
});
}

void startRunner(config, parsed.allowInsecureTransport).catch((error) => {
  console.error(`[runner ${config.runnerId}] startup blocked: ${(error as Error).message}`);
  process.exit(1);
});
