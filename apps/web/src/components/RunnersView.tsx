import React, { useEffect, useMemo, useState } from "react";
import {
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type AgentContext,
  type AgentDefinition,
  type BoxStatus,
  type BoxView,
  type IdentityAdministrationView,
  type RunnerView,
} from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { useStore } from "../store.js";
import { osLabel, relativeTime, sshErrorHint, titleCaseLabel } from "../format.js";
import {
  agentInstallHints,
  formatAdmissionPolicy,
  formatExecutionIsolation,
  machineSettingsMutationError,
  nativeRunnerUpdateHint,
  outdatedBoxHint,
  outdatedRunnerTitle,
  runnerDisplay,
  runnerOutdated,
  sshRunnerLifecycleHint,
  unknownRunnerTitle,
} from "../runners.js";
import { CopyButton, Empty, Modal, Spinner } from "./common.js";
import { OnboardRunnerDialog } from "./OnboardRunnerDialog.js";
import { AddBoxDialog } from "./AddBoxDialog.js";
import { useFeedback } from "./FeedbackProvider.js";
import { agentDisplayName, agentDriverDescription, agentDriverLabel } from "../agent-presentation.js";
import {
  ChevronRightIcon,
  InfoIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  SettingsIcon,
  ComputerIcon,
  UpdateIcon,
} from "./Icons.js";
import { PeopleDevicesPanel } from "./PeopleDevicesPanel.js";
import { AgentSessionDiscoveryDialog } from "./AgentSessionDiscoveryDialog.js";
import { InstancesPanel } from "./InstancesPanel.js";
import { DirectoryPicker } from "./DirectoryPicker.js";
import { handleRovingChoiceKeyDown } from "./interactions.js";
import { useInstances } from "../instances-context.js";
import type { ConnectionSection } from "../navigation.js";
import {
  hasBundledLocalRunner,
  readLocalRunnerStatus,
  type LocalRunnerStatus,
} from "../local-runner.js";

function contextLabel(ctx: AgentContext | undefined): string {
  return ctx?.kind === "wsl" ? `WSL: ${ctx.distro}` : "Native";
}

function authTitle(status: AgentDefinition["authStatus"]): string {
  if (status === "authenticated") return "Authenticated";
  if (status === "unauthenticated") return "Not authenticated — run the agent's login (e.g. claude setup-token / codex login)";
  return "Auth status unknown";
}

function acpCapabilitySummary(a: AgentDefinition): string {
  if (!a.acp) return "Capabilities pending live ACP handshake";
  const names: Array<[keyof NonNullable<AgentDefinition["acp"]>, string]> = [
    ["loadSession", "load"],
    ["sessionList", "list"],
    ["sessionResume", "resume"],
    ["sessionClose", "close"],
    ["sessionDelete", "delete"],
    ["logout", "logout"],
  ];
  const enabled = names.filter(([key]) => a.acp?.[key]).map(([, label]) => label);
  return enabled.length ? `Live capabilities: ${enabled.join(", ")}` : "Live ACP handshake reported no optional stable capabilities";
}

function AgentDetailsDialog({ a, onClose }: { a: AgentDefinition; onClose: () => void }) {
  const launchCommand = [a.command, ...a.args].join(" ");
  const displayName = agentDisplayName(a);
  return (
    <Modal
      title={`${displayName} Details`}
      onClose={onClose}
      className="agent-details-dialog"
      footer={<button type="button" className="btn" onClick={onClose}>Close</button>}
    >
      <p className="agent-details-summary">{agentDriverDescription(a)}</p>
      <dl className="agent-details-grid">
        <div><dt>Integration</dt><dd>{titleCaseLabel(agentDriverLabel(a))}</dd></div>
        <div><dt>Execution Context</dt><dd>{titleCaseLabel(contextLabel(a.context))}</dd></div>
        <div><dt>Source</dt><dd>{titleCaseLabel(a.source ?? "configured")}</dd></div>
        <div><dt>Version</dt><dd>{a.version ? `v${a.version}` : "Unknown"}</dd></div>
        <div><dt>Availability</dt><dd>{a.available === false ? "Unavailable" : "Available"}</dd></div>
        <div><dt>Authentication</dt><dd>{titleCaseLabel(a.authStatus ?? "unknown")}</dd></div>
      </dl>
      <section className="agent-details-section">
        <h3>Launch Command</h3>
        <p>The runner resolved this command in the agent's execution context.</p>
        <div className="agent-details-command">
          <code>{launchCommand}</code>
          <CopyButton
            text={launchCommand}
            iconOnly
            className="copy-btn icon-only-copy"
            ariaLabel={`Copy ${displayName} Launch Command`}
          />
        </div>
      </section>
      {a.codexAppServer?.failure?.message && (
        <section className="agent-details-section">
          <h3>App Server Status</h3>
          <p>{a.codexAppServer.failure.message}</p>
        </section>
      )}
      {a.registry && (
        <section className="agent-details-section">
          <h3>ACP Registry Details</h3>
          <p>{a.registry.description} · {acpCapabilitySummary(a)}</p>
        </section>
      )}
    </Modal>
  );
}

function AgentRow({
  a,
  os,
  runnerId,
  online,
  protocolVersion,
}: {
  a: AgentDefinition;
  os: RunnerView["os"];
  runnerId: string;
  online: boolean;
  protocolVersion: number | null | undefined;
}) {
  const api = useApi();
  const { confirm } = useFeedback();
  const [registryBusy, setRegistryBusy] = useState(false);
  const [registryError, setRegistryError] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const driver = a.driver ?? "acp";
  const claudeRemediation = a.claudeCode?.status === "unauthenticated"
    ? "claude auth login"
    : a.claudeCode?.status === "unsupported"
      ? "claude update"
      : a.claudeCode?.status === "unavailable"
        ? agentInstallHints(a.context?.kind === "wsl" ? "linux" : os).find((hint) => /claude/i.test(hint.name))?.command
        : undefined;
  const codexRemediation = driver.startsWith("codex")
    ? a.authStatus === "unauthenticated"
      ? "codex login"
      : a.codexAppServer?.status === "unsupported"
        ? "npm install -g @openai/codex@latest"
        : a.codexAppServer?.status === "unavailable"
          ? agentInstallHints(a.context?.kind === "wsl" ? "linux" : os).find((hint) => /codex/i.test(hint.name))?.command
          : undefined
    : undefined;
  const remediation = claudeRemediation ?? codexRemediation;
  const displayName = agentDisplayName(a);
  const registryAction = a.registry?.installStatus === "approval-required"
    ? "approve" as const
    : a.registry?.installStatus === "approved"
      ? "revoke" as const
      : null;
  const registrySupported = runnerSupportsProtocol(protocolVersion, "acpRegistryApproval");
  const changeRegistryApproval = async () => {
    if (!a.registry || !registryAction) return;
    const approving = registryAction === "approve";
    const confirmed = await confirm(approving
      ? {
          title: "Approve this exact Registry launch?",
          message: `This may download and execute third-party code on ${runnerId}. The approval is invalidated if the Registry launch changes.`,
          details: <pre className="code-block">{a.registry.installPreview}</pre>,
          confirmLabel: "Approve Exact Launch",
          tone: "danger",
        }
      : {
          title: "Revoke Registry approval?",
          message: `${a.name} v${a.registry.adapterVersion} will no longer be allowed to launch from this Registry entry.`,
          confirmLabel: "Revoke Approval",
          tone: "danger",
        });
    if (!confirmed) return;
    setRegistryBusy(true);
    setRegistryError("");
    try {
      await api.setAcpRegistryApproval(runnerId, a.id, {
        action: registryAction,
        schemaVersion: a.registry.schemaVersion,
        adapterVersion: a.registry.adapterVersion,
        confirmation: "explicit",
      });
    } catch (error) {
      setRegistryError((error as Error).message);
    } finally {
      setRegistryBusy(false);
    }
  };
  return (
    <>
    <div className="agent-row">
      <div className="agent-row-head">
        {a.authStatus && <span className={`auth-dot ${a.authStatus}`} title={authTitle(a.authStatus)} />}
        <span className="agent-name">{displayName}</span>
        {a.version && <span className="agent-ver">v{a.version}</span>}
        <button
          type="button"
          className="icon-btn agent-details-trigger"
          onClick={() => setShowDetails(true)}
          title="View Agent Details"
          aria-label={`View ${displayName} Details`}
        >
          <InfoIcon />
        </button>
      </div>
      <div className="agent-row-meta">
        <span className={`atag driver-${driver}`}>{agentDriverLabel(a)}</span>
        <span className="atag ctx">{contextLabel(a.context)}</span>
        {a.source === "discovered" && <span className="atag discovered">Discovered</span>}
        {a.source === "registry" && <span className="atag discovered">ACP Registry</span>}
        {a.available === false && <span className="atag broken">Unavailable</span>}
        {a.registry && <span className="atag">{a.registry.transport}</span>}
        {!a.registry && a.acpTransport && <span className="atag">{a.acpTransport}</span>}
        {a.registry && <span className="atag">Adapter v{a.registry.adapterVersion}</span>}
        {a.codexAppServer?.status === "supported" && a.authStatus !== "unauthenticated" && (
          <span className="atag">{driver === "codex" ? "Fallback Ready" : "Interactive Ready"}</span>
        )}
        {(driver === "codex" || driver === "codex-app-server") && a.authStatus === "unauthenticated" && (
          <span className="atag broken" title="Run `codex login`, then rediscover.">Not Signed In</span>
        )}
        {a.codexAppServer?.status === "unsupported" && (
          <span className="atag broken" title={a.codexAppServer.failure?.message}>
            {driver === "codex" ? "Non-Interactive Fallback" : "Interactive Unavailable"}
          </span>
        )}
        {a.codexAppServer?.status === "unavailable" && (
          <span className="atag broken" title={a.codexAppServer.failure?.message}>Not Installed</span>
        )}
        {a.claudeCode?.status === "ready" && <span className="atag">Claude Ready</span>}
        {a.claudeCode && a.claudeCode.auth.billingSource !== "unknown" && (
          <span className="atag">{a.claudeCode.auth.billingSource === "api" ? "API Billing" : `${titleCaseLabel(a.claudeCode.auth.billingSource)} Auth`}</span>
        )}
        {a.claudeCode?.launchSource && a.claudeCode.launchSource !== "path" && (
          <span className="atag" title="Installed outside the runner service PATH; discovery recovered an absolute launch path">
            PATH Recovered
          </span>
        )}
        {a.claudeCode?.status === "unauthenticated" && <span className="atag broken">Not Signed In</span>}
        {a.claudeCode?.status === "unsupported" && <span className="atag broken">Unsupported CLI Mode</span>}
        {a.claudeCode?.status === "unavailable" && <span className="atag broken">Not Installed</span>}
      </div>
      {(a.codexAppServer?.status === "unsupported" || a.codexAppServer?.status === "unavailable") && a.codexAppServer.failure?.message && (
        <div className="empty-sub">{a.codexAppServer.failure.message}</div>
      )}
      {a.claudeCode && a.claudeCode.status !== "ready" && a.claudeCode.failure?.message && (
        <div className="empty-sub">{a.claudeCode.failure.message}</div>
      )}
      {a.registry && (
        <div className="empty-sub">
          {a.registry.description} · {acpCapabilitySummary(a)} · registry requires authentication; status is verified at live initialize
          {a.registry.license ? ` · ${a.registry.license}` : ""}
        </div>
      )}
      {remediation && (
        <pre className="code-block install-cmd" title={`${a.name} remediation`}>
          {remediation}
          <CopyButton text={remediation} iconOnly ariaLabel={`Copy ${displayName} Remediation Command`} className="copy-btn icon-only-copy" />
        </pre>
      )}
      {a.registry && a.registry.installStatus !== "installed" && (
        <div>
          <div className="empty-sub">
            {a.registry.installStatus === "approval-required"
              ? "Registry launch is disabled until this exact version and command receive explicit confirmation."
              : a.registry.installStatus === "approved"
                ? a.available === false
                  ? "Exact launch approval is retained, but its package runner is unavailable. Install it, then Rediscover."
                  : "Exact Registry package launch approved. A changed version or command is disabled automatically."
                : a.registry.installStatus === "manual-only"
                  ? "Automatic install is disabled because Registry v1 supplies no binary digest or exact package pin. Install manually, then Rediscover."
                  : "The Registry has no compatible distribution for this runner platform."}
          </div>
          <pre className="code-block install-cmd" title={`${a.name} Registry install preview`}>
            {a.registry.installPreview}
            <CopyButton text={a.registry.installPreview} iconOnly ariaLabel={`Copy ${displayName} Registry Install Command`} className="copy-btn icon-only-copy" />
          </pre>
          {registryAction && (
            <button
              className="btn sm"
              disabled={!online || !registrySupported || registryBusy}
              onClick={() => void changeRegistryApproval()}
              title={!registrySupported
                ? runnerCapabilityRequirement(protocolVersion, "acpRegistryApproval", "Registry approval")
                : registryAction === "approve"
                  ? "Review and explicitly approve this exact package launch"
                  : "Disable this approved package launch"}
            >
              {registryBusy ? "Updating…" : registryAction === "approve" ? "Approve Exact Launch…" : "Revoke Approval"}
            </button>
          )}
          {registryError && <div className="empty-sub box-error">{registryError}</div>}
        </div>
      )}
    </div>
    {showDetails && <AgentDetailsDialog a={a} onClose={() => setShowDetails(false)} />}
    </>
  );
}

/** The meta + agents + workspaces body shared by runner cards and (once online) box cards. */
function RunnerDetails({ runner, online }: { runner: RunnerView; online: boolean }) {
  const pv = runner.protocolVersion;
  const [findingSessions, setFindingSessions] = useState(false);
  const externalSessionsSupported = runnerSupportsProtocol(pv, "externalSessions");
  const unsupported = runnerCapabilityRequirement(pv, "externalSessions", "Finding agent sessions");
  return (
    <div className="runner-details">
      <div className="runner-details-body">
        <dl className="runner-meta runner-system-meta" aria-label="System Details">
          <div>
            <dt>Host</dt>
            <dd>{runner.hostname}</dd>
          </div>
          <div>
            <dt>Runner Version</dt>
            <dd>
              {runner.version || "—"}
              {pv != null && runnerOutdated(pv) && (
                <span className="outdated-badge" title={outdatedRunnerTitle()}>
                  Outdated
                </span>
              )}
              {pv == null && (
                <span className="outdated-badge" title={unknownRunnerTitle()}>
                  Protocol Unknown
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Protocol</dt>
            <dd>{pv == null ? "Unknown" : `v${pv}`}</dd>
          </div>
          <div>
            <dt>Last Seen</dt>
            <dd>{relativeTime(runner.lastSeen)}</dd>
          </div>
          {runner.runtime && (
            <>
              <div>
                <dt>Capacity</dt>
                <dd>{runner.runtime.maxConcurrentSessions} Units</dd>
              </div>
              {formatAdmissionPolicy(runner.runtime) && (
                <div>
                  <dt>Admission Policy</dt>
                  <dd>{formatAdmissionPolicy(runner.runtime)}</dd>
                </div>
              )}
              <div>
                <dt>Worktree Storage</dt>
                <dd title={runner.runtime.worktreeRoot}>{runner.runtime.worktreeRoot}</dd>
              </div>
              <div>
                <dt>Execution Policy</dt>
                <dd>{formatExecutionIsolation(runner.runtime)}</dd>
              </div>
            </>
          )}
        </dl>
        <details className="runner-agents">
          <summary>
            <span className="runner-agents-label">Agents</span>
            <span className="group-count">{runner.agents.length}</span>
            <span className="runner-agents-summary">
              {runner.agents.filter((agent) => agent.available !== false).length} Available
            </span>
            <ChevronRightIcon className="runner-disclosure-chevron" />
          </summary>
          <div className="runner-agents-body">
            {runner.agents.length > 0 ? (
              <>
                <div className="agent-list">
                  {runner.agents.map((a) => (
                    <AgentRow
                      a={a}
                      os={runner.os}
                      runnerId={runner.runnerId}
                      online={online}
                      protocolVersion={runner.protocolVersion}
                      key={a.id}
                    />
                  ))}
                </div>
                {runner.agents.every((agent) => agent.available === false) && (
                  <div className="install-hints">
                    <p className="hint">No usable agent CLIs found on this machine — install one:</p>
                    {agentInstallHints(runner.os).map((h) => (
                      <pre key={h.name} className="code-block install-cmd" title={`Install ${h.name}`}>
                        {h.command}
                        <CopyButton text={h.command} />
                      </pre>
                    ))}
                  </div>
                )}
              </>
            ) : runner.agentsRefreshed ? (
              <div className="install-hints">
                <p className="hint">No agent CLIs found on this machine — install one:</p>
                {agentInstallHints(runner.os).map((h) => (
                  <pre key={h.name} className="code-block install-cmd" title={`Install ${h.name}`}>
                    {h.command}
                    <CopyButton text={h.command} />
                  </pre>
                ))}
              </div>
            ) : (
              <p className="hint">Probing for agent CLIs…</p>
            )}
          </div>
        </details>
        <div className="group runner-workspaces">
          <div className="group-head">
            Workspaces <span className="group-count">{runner.workspaces.length}</span>
          </div>
          <ul className="workspace-list">
            {runner.workspaces.map((w) => (
              <li key={w.id}>
                <span className="ws-name">{w.name}</span>
                <span className="ws-path">{w.path}</span>
              </li>
            ))}
          </ul>
        </div>
        {online && (
          <div className="group runner-agent-sessions">
            <div className="group-head">Agent Sessions</div>
            <div className="runner-agent-sessions-action">
              <p>Continue a session that was started outside Wollipog on this machine.</p>
              <button
                type="button"
                className="btn-rediscover"
                onClick={() => setFindingSessions(true)}
                disabled={!externalSessionsSupported}
                title={externalSessionsSupported ? "Choose an agent and scan its external sessions" : unsupported}
              >
                <SearchIcon />
                <span>Find Agent Sessions</span>
              </button>
            </div>
            {!externalSessionsSupported && <div className="empty-sub box-hint">{unsupported}</div>}
          </div>
        )}
      </div>
      {findingSessions && (
        <AgentSessionDiscoveryDialog runner={runner} onClose={() => setFindingSessions(false)} />
      )}
    </div>
  );
}

function NativeRunnerHealth({
  runner,
  onRepair,
  canRepair,
}: {
  runner: RunnerView;
  onRepair: () => void;
  canRepair: boolean;
}) {
  const hint = nativeRunnerUpdateHint(runner.protocolVersion);
  if (runner.status === "offline") {
    return (
      <div className="empty-sub box-hint connection-recovery" role="status">
        <div>
          <strong>Connection is offline.</strong> The runner process may be stopped or its saved credential may no longer be active.
        </div>
        {canRepair ? (
          <button className="btn sm" type="button" onClick={onRepair}>Repair Credential…</button>
        ) : (
          <span>Ask an organization owner or admin to repair this connection.</span>
        )}
      </div>
    );
  }
  if (!hint) return null;
  return (
    <div className="empty-sub box-hint" role="status">
      <strong>Native runner update required.</strong> {hint} Standalone installs should rerun the
      matching <code>scripts/install-runner</code> installer before relaunching. See{" "}
      <code>docs/runner-updates.md</code>.
    </div>
  );
}

function boxStatusLabel(s: BoxStatus): string {
  switch (s) {
    case "bootstrapping":
      return "Bootstrapping…";
    case "deploying":
      return "Deploying Runner…";
    case "online":
      return "Online";
    case "offline":
      return "Offline";
    case "failed":
      return "Failed";
  }
}

export interface LifecycleConflictPresentation {
  message: string;
  sessions: Array<{ title: string; status: string }>;
  omittedSessionCount: number;
}

function normalizedSessionTitle(value: unknown): string {
  if (typeof value !== "string") return "Untitled Session";
  return value.replace(/\s+/g, " ").trim() || "Untitled Session";
}

export function lifecycleConflictPresentation(
  error: ApiError,
  action: "update" | "reconnect" | "adopt",
): LifecycleConflictPresentation {
  const count = typeof error.details?.activeSessionCount === "number" ? error.details.activeSessionCount : null;
  const sessions = Array.isArray(error.details?.activeSessions)
    ? error.details.activeSessions
        .filter((session): session is { title?: unknown; status?: unknown } => !!session && typeof session === "object")
        .map((session) => ({
          title: normalizedSessionTitle(session.title),
          status: typeof session.status === "string"
            ? titleCaseLabel(session.status.replaceAll("_", " "))
            : "Active",
        }))
        .slice(0, 4)
    : [];
  const actionLabel = action === "update" ? "Updating" : action === "reconnect" ? "Reconnecting" : "Adopting legacy data for";
  const message = count == null
    ? `${actionLabel} this runner will interrupt active work.`
    : `${actionLabel} this runner will interrupt ${count} active session${count === 1 ? "" : "s"}.`;
  return {
    message,
    sessions,
    omittedSessionCount: count == null ? 0 : Math.max(0, count - sessions.length),
  };
}

export function LifecycleConflictDetails({ conflict }: { conflict: LifecycleConflictPresentation }) {
  if (conflict.sessions.length === 0) return null;
  return (
    <section className="lifecycle-conflict" aria-label="Affected Sessions">
      <h3>Affected Sessions</h3>
      <ul className="lifecycle-conflict-list">
        {conflict.sessions.map((session, index) => (
          <li key={`${session.title}-${session.status}-${index}`}>
            <span className="lifecycle-conflict-title" title={session.title}>{session.title}</span>
            <span className="lifecycle-conflict-status">{session.status}</span>
          </li>
        ))}
      </ul>
      {conflict.omittedSessionCount > 0 && (
        <p className="lifecycle-conflict-omitted">
          {conflict.omittedSessionCount} more active session{conflict.omittedSessionCount === 1 ? "" : "s"} not shown.
        </p>
      )}
    </section>
  );
}

function updateSourceLabel(source: "staged" | "release-cache", releaseTag: string): string {
  return source === "staged" ? "local development build" : `release ${releaseTag}`;
}

function workspaceNameFromPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "");
  return trimmed.split(/[\\/]/u).pop() || trimmed || "Workspace";
}

function MachineSettingsDialog({
  runner,
  box,
  onClose,
  onDelete,
}: {
  runner: RunnerView | undefined;
  box?: BoxView;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const api = useApi();
  const { confirm } = useFeedback();
  const runnerId = runner?.runnerId ?? box?.runnerId ?? "";
  const display = runnerDisplay(runner, box, runnerId);
  const configuredName = runner?.displayName ?? box?.displayName ?? "";
  const [machineName, setMachineName] = useState(configuredName || display.name);
  const [savingName, setSavingName] = useState(false);
  const [addingWorkspace, setAddingWorkspace] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [adoptingLegacyData, setAdoptingLegacyData] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canBrowse = runner?.status === "online" &&
    runnerSupportsProtocol(runner.protocolVersion, "directoryListing");
  const onlineNativeRunner = !box && runner?.status === "online";

  const saveName = async () => {
    const nextName = machineName.trim();
    if (!nextName || savingName) return;
    setSavingName(true);
    setError(null);
    try {
      await api.updateMachine(runnerId, { displayName: nextName });
    } catch (cause) {
      setError(machineSettingsMutationError(cause));
    } finally {
      setSavingName(false);
    }
  };

  const pickWorkspace = (path: string) => {
    setWorkspacePath(path);
    if (!nameEdited) setWorkspaceName(workspaceNameFromPath(path));
    setBrowsing(false);
    setError(null);
  };

  const addWorkspace = async () => {
    const name = workspaceName.trim();
    const path = workspacePath.trim();
    if (!name || !path || addingWorkspace) return;
    setAddingWorkspace(true);
    setError(null);
    try {
      await api.registerMachineWorkspace(runnerId, { name, path });
      setWorkspacePath("");
      setWorkspaceName("");
      setNameEdited(false);
    } catch (cause) {
      setError(machineSettingsMutationError(cause));
    } finally {
      setAddingWorkspace(false);
    }
  };

  const deleteMachine = async () => {
    const approved = await confirm({
      title: `Delete ${display.name}?`,
      message: box
        ? "This removes the Machine connection and permanently deletes its sessions and multi-agent runs from Wollipog. Files on the remote Machine are not deleted."
        : "This permanently deletes the Machine, its sessions, and its multi-agent runs from Wollipog. Stop an online native runner before deleting it. Files on the Machine are not deleted.",
      confirmLabel: "Delete Machine",
      tone: "danger",
    });
    if (!approved) return;
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
      setDeleting(false);
    }
  };

  const adoptLegacyData = async () => {
    if (!box || adoptingLegacyData) return;
    const approved = await confirm({
      title: `Adopt Legacy Data for ${display.name}?`,
      message: "Confirm that every legacy runner process using this SSH account is stopped. Wollipog will preserve the existing state and authorize one migration attempt.",
      confirmLabel: "Adopt Legacy Data",
      tone: "danger",
    });
    if (!approved) return;
    setAdoptingLegacyData(true);
    setError(null);
    try {
      try {
        await api.adoptLegacyBoxData(box.boxId, false);
      } catch (cause) {
        if (!(cause instanceof ApiError) || cause.status !== 409 || cause.code !== "BOX_HAS_ACTIVE_SESSIONS") throw cause;
        setAdoptingLegacyData(false);
        const conflict = lifecycleConflictPresentation(cause, "adopt");
        const force = await confirm({
          title: `Interrupt Sessions and Adopt Legacy Data for ${display.name}?`,
          message: conflict.message,
          details: <LifecycleConflictDetails conflict={conflict} />,
          confirmLabel: "Interrupt Sessions and Adopt Legacy Data",
          tone: "danger",
        });
        if (!force) return;
        setAdoptingLegacyData(true);
        await api.adoptLegacyBoxData(box.boxId, true);
      }
    } catch (cause) {
      setError(machineSettingsMutationError(cause));
    } finally {
      setAdoptingLegacyData(false);
    }
  };

  return (
    <Modal
      title={`Manage ${display.name}`}
      onClose={onClose}
      wide
      className="machine-settings-dialog"
      footer={<button type="button" className="btn" onClick={onClose}>Close</button>}
    >
      <section className="machine-settings-section">
        <h3>Machine Details</h3>
        <div className="machine-name-row">
          <label className="field">
            <span>Machine Name</span>
            <input
              value={machineName}
              onChange={(event) => setMachineName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void saveName()}
            />
          </label>
          <button
            type="button"
            className="btn primary"
            disabled={!machineName.trim() || machineName.trim() === configuredName || savingName}
            onClick={() => void saveName()}
          >
            {savingName ? "Saving…" : "Save Changes"}
          </button>
        </div>
        <dl className="runner-meta runner-system-meta">
          <div><dt>Connection Type</dt><dd>{box ? "SSH" : "Native"}</dd></div>
          {runner && <div><dt>Hostname</dt><dd>{runner.hostname}</dd></div>}
          {box && <div><dt>SSH Target</dt><dd>{box.sshTarget}</dd></div>}
          <div><dt>Machine ID</dt><dd><code>{runnerId}</code></dd></div>
        </dl>
      </section>

      <section className="machine-settings-section">
        <div className="machine-settings-heading">
          <div>
            <h3>Workspaces</h3>
            <p>Working directories registered on this Machine. Projects can use them as Locations.</p>
          </div>
          <button
            type="button"
            className="btn"
            disabled={!canBrowse}
            title={canBrowse ? "Register another working directory" : "The Machine must be online and support directory browsing"}
            onClick={() => {
              setBrowsing((current) => !current);
              setError(null);
            }}
          >
            <PlusIcon />
            <span>Add Workspace</span>
          </button>
        </div>
        {runner?.workspaces.length ? (
          <ul className="workspace-list machine-workspace-list">
            {runner.workspaces.map((workspace) => (
              <li key={workspace.id}>
                <span className="ws-name">{workspace.name}</span>
                <span className="ws-path">{workspace.path}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No Workspaces Registered</p>
        )}
        {browsing && runner && (
          <div className="machine-workspace-create">
            <DirectoryPicker
              runnerId={runner.runnerId}
              protocolVersion={runner.protocolVersion}
              onPick={pickWorkspace}
              onCancel={() => setBrowsing(false)}
            />
          </div>
        )}
        {workspacePath && (
          <div className="machine-workspace-form">
            <label className="field">
              <span>Workspace Name</span>
              <input
                value={workspaceName}
                onChange={(event) => {
                  setWorkspaceName(event.target.value);
                  setNameEdited(true);
                }}
              />
            </label>
            <div className="field">
              <span>Folder</span>
              <code title={workspacePath}>{workspacePath}</code>
            </div>
            <button
              type="button"
              className="btn primary"
              disabled={!workspaceName.trim() || addingWorkspace}
              onClick={() => void addWorkspace()}
            >
              {addingWorkspace ? "Adding…" : "Add Workspace"}
            </button>
          </div>
        )}
      </section>

      <section className="machine-settings-section machine-danger-zone">
        <h3>Danger Zone</h3>
        {box?.runnerDataLayout === "legacy" && box.legacyDataAdoption?.status !== "completed" && (
          <div className="machine-settings-danger-action">
            <h4>Legacy Runner Data</h4>
            <p>
              This Machine predates isolated managed-runner data. Stop every legacy runner on its SSH account,
              then authorize one state-preserving migration attempt.
            </p>
            <button
              type="button"
              className="btn danger"
              disabled={adoptingLegacyData || box.legacyDataAdoption?.status === "pending"}
              onClick={() => void adoptLegacyData()}
            >
              {box.legacyDataAdoption?.status === "pending"
                ? "Legacy Data Adoption Pending"
                : adoptingLegacyData ? "Authorizing…" : "Adopt Legacy Data"}
            </button>
          </div>
        )}
        <p>Deleting a Machine removes its sessions and run history from Wollipog. Files on the Machine remain in place.</p>
        <button
          type="button"
          className="btn danger"
          disabled={deleting || onlineNativeRunner}
          title={onlineNativeRunner ? "Stop this native runner before deleting the Machine" : undefined}
          onClick={() => void deleteMachine()}
        >
          {deleting ? "Deleting…" : "Delete Machine"}
        </button>
      </section>
      {error && <div className="form-error" role="alert">{error}</div>}
    </Modal>
  );
}

function BoxConnectionDetailsDialog({ box, onClose }: { box: BoxView; onClose: () => void }) {
  const build = box.deployedVersion?.trim() || "Not Available";
  const platform = box.triple?.trim() || "Not Available";
  return (
    <Modal
      title={`${box.sshTarget} Connection Details`}
      onClose={onClose}
      className="connection-details-dialog"
      footer={<button type="button" className="btn" onClick={onClose}>Close</button>}
    >
      <dl className="connection-details-list">
        <div>
          <dt>Connection Type</dt>
          <dd>SSH</dd>
        </div>
        <div>
          <dt>SSH Target</dt>
          <dd>{box.sshTarget}</dd>
        </div>
        <div className="connection-details-wide">
          <dt>Last Deployed Build</dt>
          <dd className="connection-details-code">
            <code>{build}</code>
            {box.deployedVersion && (
              <CopyButton
                text={box.deployedVersion}
                iconOnly
                ariaLabel="Copy Last Deployed Build"
                className="copy-btn icon-only-copy"
              />
            )}
          </dd>
        </div>
        <div className="connection-details-wide">
          <dt>Runner Platform</dt>
          <dd className="connection-details-code"><code>{platform}</code></dd>
        </div>
      </dl>
      <p className="connection-details-note">
        These details can help troubleshoot connection updates or provide information to support.
      </p>
    </Modal>
  );
}

/** A box card: SSH target + bootstrap status + actions, with the runner's details once online. */
export function BoxCard({
  box,
  runner,
  canManage,
  onReconnect,
  onRemove,
}: {
  box: BoxView;
  runner: RunnerView | undefined;
  canManage: boolean;
  onReconnect: (boxId: string, force: boolean) => Promise<void>;
  onRemove: (boxId: string) => Promise<void>;
}) {
  const api = useApi();
  const { confirm } = useFeedback();
  const inProgress = box.status === "bootstrapping" || box.status === "deploying";
  const dot = box.status === "online" ? "online" : inProgress ? "connecting" : "offline";
  // A connection-blocked SSH error (VPN/firewall) gets an actionable hint; null otherwise. lastError
  // is cleared once a box is online, so this is naturally absent on healthy boxes.
  const connHint = sshErrorHint(box.lastError);
  // Only a known older protocol proves that the deployed runner is out of date. An absent
  // protocol version is unknown rather than stale, so do not offer a destructive redeploy on a
  // guess. The runner details still explain the unknown-version compatibility limitations.
  const needsUpdate = !!runner && runnerOutdated(runner.protocolVersion);
  const display = runnerDisplay(runner, box, box.runnerId);
  const [updating, setUpdating] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [showConnectionDetails, setShowConnectionDetails] = useState(false);
  const [showMachineSettings, setShowMachineSettings] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateResult, setUpdateResult] = useState<string | null>(null);
  const updateRunner = async () => {
    setUpdating(true);
    setUpdateError(null);
    setUpdateResult(null);
    try {
      let result: Awaited<ReturnType<typeof api.updateBoxRunner>>;
      try {
        result = await api.updateBoxRunner(box.boxId, false);
      } catch (cause) {
        if (!(cause instanceof ApiError) || cause.status !== 409 || cause.code !== "BOX_HAS_ACTIVE_SESSIONS") throw cause;
        setUpdating(false);
        const conflict = lifecycleConflictPresentation(cause, "update");
        const approved = await confirm({
          title: `Force Update ${box.sshTarget}?`,
          message: conflict.message,
          details: <LifecycleConflictDetails conflict={conflict} />,
          confirmLabel: "Interrupt Sessions and Update",
          tone: "danger",
        });
        if (!approved) return;
        setUpdating(true);
        result = await api.updateBoxRunner(box.boxId, true);
      }
      const source = updateSourceLabel(result.source, result.releaseTag);
      if (result.status === "already_current") {
        setUpdateResult(`Already current · build ${result.expectedVersion} · ${source}`);
      } else if (result.status === "started") {
        setUpdateResult(`Deploying build ${result.expectedVersion} from ${source}. Connection status will confirm when it is online.`);
      } else {
        setUpdateResult(`A newer connection action took over. Build ${result.expectedVersion} is ready for the next reconnect.`);
      }
    } catch (e) {
      setUpdateError((e as Error).message);
    } finally {
      setUpdating(false);
    }
  };
  const reconnect = async () => {
    setReconnecting(true);
    setUpdateError(null);
    setUpdateResult(null);
    try {
      try {
        await onReconnect(box.boxId, false);
      } catch (cause) {
        if (!(cause instanceof ApiError) || cause.status !== 409 || cause.code !== "BOX_HAS_ACTIVE_SESSIONS") throw cause;
        setReconnecting(false);
        const conflict = lifecycleConflictPresentation(cause, "reconnect");
        const approved = await confirm({
          title: `Force Reconnect ${box.sshTarget}?`,
          message: conflict.message,
          details: <LifecycleConflictDetails conflict={conflict} />,
          confirmLabel: "Interrupt Sessions and Reconnect",
          tone: "danger",
        });
        if (!approved) return;
        setReconnecting(true);
        await onReconnect(box.boxId, true);
      }
    } catch (error) {
      setUpdateError(`Reconnect failed: ${(error as Error).message}`);
    } finally {
      setReconnecting(false);
    }
  };
  return (
    <>
    <article className={`runner-card box-card status-${dot}`}>
      <div className="runner-head">
        <div className="runner-id">
          <span className={`status-dot ${dot}`} />
          <h2>{display.name}</h2>
          <span className={`connection-status status-${dot}`}>{boxStatusLabel(box.status)}</span>
        </div>
      </div>
      <div className="runner-head-right runner-card-actions">
        <span className="os-badge">SSH</span>
        {canManage && needsUpdate && !inProgress && (
          <button
            className="btn-rediscover update-runner needs-update"
            onClick={() => void updateRunner()}
            disabled={updating || inProgress}
            title={outdatedBoxHint()}
          >
            {updating ? <Spinner decorative /> : <UpdateIcon />}
            <span>{updating ? "Checking…" : "Update Runner"}</span>
          </button>
        )}
        {canManage && (
          <>
            <button
              className="btn-rediscover"
              onClick={() => void reconnect()}
              disabled={inProgress || reconnecting}
              title="Reconnect this machine"
            >
              <RefreshIcon />
              <span>{reconnecting ? "Reconnecting…" : "Reconnect"}</span>
            </button>
            <button className="btn-rediscover" onClick={() => setShowMachineSettings(true)} title="Manage this Machine">
              <SettingsIcon />
              <span>Manage</span>
            </button>
          </>
        )}
        <button
          type="button"
          className="connection-details-trigger"
          onClick={() => setShowConnectionDetails(true)}
          aria-label={`View ${box.sshTarget} Connection Details`}
          title="Connection Details"
        >
          <InfoIcon />
        </button>
      </div>
      <dl className="runner-meta runner-connection-meta">
        <div>
          <dt>SSH Target</dt>
          <dd>{box.sshTarget}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{boxStatusLabel(box.status)}</dd>
        </div>
      </dl>
      {box.status === "failed" && box.lastError && <div className="empty-sub box-error">{box.lastError}</div>}
      {updateError && (
        <div className="empty-sub box-error" role="alert">
          {updateError.startsWith("Reconnect") || updateError.startsWith("Remove") ? updateError : `Update failed: ${updateError}`}
        </div>
      )}
      {updateResult && <div className="runner-update-result" role="status">{updateResult}</div>}
      {connHint && <div className="empty-sub box-hint">{connHint}</div>}
      <div className="empty-sub box-hint">
        {sshRunnerLifecycleHint()}
      </div>
      {runner ? (
        <RunnerDetails runner={runner} online={box.status === "online"} />
      ) : inProgress ? (
        <div className="empty-sub">Waiting for the runner to come online…</div>
      ) : box.status === "offline" ? (
        <div className="empty-sub">Offline — the SSH session ended. Reconnect to retry.</div>
      ) : null}
    </article>
    {showMachineSettings && (
      <MachineSettingsDialog
        runner={runner}
        box={box}
        onClose={() => setShowMachineSettings(false)}
        onDelete={() => onRemove(box.boxId)}
      />
    )}
    {showConnectionDetails && <BoxConnectionDetailsDialog box={box} onClose={() => setShowConnectionDetails(false)} />}
    </>
  );
}

/** A native runner card, exported so browser fixtures exercise the production component. */
export function NativeRunnerCard({
  runner,
  canManage,
  busy,
  removeError,
  onRediscover,
  onManage,
  onRepair,
}: {
  runner: RunnerView;
  canManage: boolean;
  busy: boolean;
  removeError?: string;
  onRediscover: (runnerId: string) => void | Promise<void>;
  onManage: (runnerId: string) => void;
  onRepair: (runnerId: string) => void;
}) {
  return (
    <article className={`runner-card status-${runner.status}`}>
      <div className="runner-head">
        <div className="runner-id">
          {/* Full literals so the stylesheet guardrails see these classes rendered. */}
          <span className={runner.status === "online" ? "status-dot online" : "status-dot offline"} />
          <h2>{runnerDisplay(runner, undefined, runner.runnerId).name}</h2>
          <span className={`connection-status status-${runner.status}`}>
            {runner.status === "online" ? "Online" : "Offline"}
          </span>
        </div>
      </div>
      <div className="runner-head-right runner-card-actions">
        <span className={`os-badge os-${runner.os}`}>{osLabel(runner.os)}</span>
        {canManage && <button
          className="btn-rediscover"
          disabled={runner.status !== "online" || busy}
          onClick={() => void onRediscover(runner.runnerId)}
          title="Re-probe this host for installed agents"
        >
          <RefreshIcon />
          <span>{busy ? "Rediscovering…" : "Rediscover"}</span>
        </button>}
        {canManage && (
          <button
            className="btn-rediscover"
            onClick={() => onManage(runner.runnerId)}
            title="Manage this Machine"
          >
            <SettingsIcon />
            <span>Manage</span>
          </button>
        )}
      </div>
      {removeError && <div className="empty-sub box-error" role="alert">{removeError}</div>}
      <RunnerDetails runner={runner} online={runner.status === "online"} />
      <NativeRunnerHealth
        runner={runner}
        canRepair={canManage}
        onRepair={() => onRepair(runner.runnerId)}
      />
    </article>
  );
}

export function RunnersView() {
  const api = useApi();
  const { runners, boxes, view, navigate } = useStore();
  const instances = useInstances();
  const bundledLocalRunner = hasBundledLocalRunner();
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [onboarding, setOnboarding] = useState<"local" | "manual" | null>(null);
  const [localRunnerStatus, setLocalRunnerStatus] = useState<LocalRunnerStatus | null>(null);
  const [repairRunnerId, setRepairRunnerId] = useState<string | null>(null);
  const [addingBox, setAddingBox] = useState(false);
  const [settingsRunnerId, setSettingsRunnerId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<Record<string, string>>({});
  const [identity, setIdentity] = useState<IdentityAdministrationView | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const requestedSection = view.name === "runners" ? view.section ?? "machines" : "machines";
  const section: ConnectionSection = !instances.desktopMultiInstance && requestedSection === "instances"
    ? "machines"
    : requestedSection;
  const identityRole = identity?.context.role ?? null;
  const canManageMachines = identityRole === "owner" || identityRole === "admin";
  const selectSection = (next: ConnectionSection) => navigate({ name: "runners", section: next });
  useEffect(() => {
    if (!instances.desktopMultiInstance && requestedSection === "instances") {
      navigate({ name: "runners", section: "machines" });
    }
  }, [instances.desktopMultiInstance, navigate, requestedSection]);

  const loadMachineAccess = () => {
    setIdentityError(null);
    void api.getIdentity().then((nextIdentity) => {
      setIdentity(nextIdentity);
    }).catch((error) => {
      setIdentityError((error as Error).message);
    });
  };
  useEffect(loadMachineAccess, [api]);
  useEffect(() => {
    if (!bundledLocalRunner) return;
    void readLocalRunnerStatus().then(setLocalRunnerStatus).catch(() => setLocalRunnerStatus(null));
  }, [bundledLocalRunner]);

  const boxList = useMemo(
    () => [...boxes.values()].sort((a, b) => a.sshTarget.localeCompare(b.sshTarget)),
    [boxes],
  );
  // Runners that belong to a box are shown inside the box card, not in the plain list.
  const boxRunnerIds = useMemo(() => new Set(boxList.map((b) => b.runnerId)), [boxList]);
  const runnerList = useMemo(
    () =>
      [...runners.values()]
        .filter((r) => !boxRunnerIds.has(r.runnerId))
        .sort((a, b) => a.runnerId.localeCompare(b.runnerId)),
    [runners, boxRunnerIds],
  );

  const rediscover = async (runnerId: string) => {
    setBusy((b) => ({ ...b, [runnerId]: true }));
    setRemoveError((errors) => {
      const { [runnerId]: _drop, ...rest } = errors;
      return rest;
    });
    try {
      await api.rediscover(runnerId);
    } catch (error) {
      setRemoveError((errors) => ({ ...errors, [runnerId]: `Rediscovery failed: ${(error as Error).message}` }));
    } finally {
      setTimeout(() => setBusy((b) => ({ ...b, [runnerId]: false })), 1500);
    }
  };

  const reconnectBox = async (boxId: string, force: boolean) => {
    await api.reconnectBox(boxId, force);
  };
  const removeBox = async (boxId: string) => {
    await api.removeBox(boxId);
  };
  const dialogs = (
    <>
      {onboarding && (
        <OnboardRunnerDialog
          mode={onboarding}
          onClose={() => setOnboarding(null)}
          onLocalRunnerChanged={setLocalRunnerStatus}
        />
      )}
      {repairRunnerId && (
        <OnboardRunnerDialog initialRunnerId={repairRunnerId} onClose={() => setRepairRunnerId(null)} />
      )}
      {addingBox && <AddBoxDialog onClose={() => setAddingBox(false)} />}
      {settingsRunnerId && runners.get(settingsRunnerId) && (
        <MachineSettingsDialog
          runner={runners.get(settingsRunnerId)}
          onClose={() => setSettingsRunnerId(null)}
          onDelete={() => api.removeRunner(settingsRunnerId)}
        />
      )}
    </>
  );

  const localRunnerOnline = Boolean(
    localRunnerStatus?.runnerId && runners.get(localRunnerStatus.runnerId)?.status === "online",
  );
  const localInstanceActive = instances.activeProfile.kind === "local";
  const offerLocalSetup = Boolean(
    localInstanceActive && localRunnerStatus?.available && (!localRunnerStatus.enabled || !localRunnerOnline),
  );
  const addButtons = canManageMachines ? (
    <>
      {offerLocalSetup && (
        <button className="btn primary" onClick={() => setOnboarding("local")}>
          <PlusIcon />
          <span>{localRunnerStatus?.enabled ? "Reconnect This Machine" : "Set Up This Machine"}</span>
        </button>
      )}
      <button className={`btn${offerLocalSetup ? "" : " primary"}`} onClick={() => setAddingBox(true)}>
        <PlusIcon />
        <span>Connect via SSH</span>
      </button>
      <button className="btn" onClick={() => setOnboarding("manual")}>
        <PlusIcon />
        <span>
          {localInstanceActive && bundledLocalRunner
            ? localRunnerStatus?.enabled ? "Add Another Runner" : "Advanced Runner Setup"
            : "Add Native Runner"}
        </span>
      </button>
    </>
  ) : null;

  const total = runnerList.length + boxList.length;
  const sections: Array<{ id: ConnectionSection; label: React.ReactNode }> = [
    ...(instances.desktopMultiInstance
      ? [{ id: "instances" as const, label: <>Instances <span className="tab-count">{instances.registry.profiles.length}</span></> }]
      : []),
    { id: "machines", label: <>Machines <span className="tab-count">{total}</span></> },
    { id: "people", label: <>People &amp; Devices</> },
  ];
  return (
    <>
      <div
        className="connections-tabs"
        role="tablist"
        aria-label="Connection Settings"
        onKeyDown={(event) => handleRovingChoiceKeyDown(event, "tab")}
      >
        {sections.map((item) => (
          <button
            key={item.id}
            id={`connections-${item.id}-tab`}
            type="button"
            role="tab"
            aria-selected={section === item.id}
            aria-controls={`connections-${item.id}-panel`}
            tabIndex={section === item.id ? 0 : -1}
            className={section === item.id ? "active" : ""}
            onClick={() => selectSection(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {section === "instances" ? (
        <div
          id="connections-instances-panel"
          role="tabpanel"
          aria-labelledby="connections-instances-tab"
          className="connections-panel"
        >
          <InstancesPanel />
        </div>
      ) : section === "people" ? (
        <div
          id="connections-people-panel"
          role="tabpanel"
          aria-labelledby="connections-people-tab"
          className="connections-panel access-panel"
        >
          {identity ? (
            <PeopleDevicesPanel identity={identity} onIdentityChange={setIdentity} />
          ) : identityError ? (
            <div className="connection-access-error" role="alert">
              People and device access could not be loaded: {identityError}
              <button type="button" className="btn ghost sm" onClick={loadMachineAccess}>Retry</button>
            </div>
          ) : (
            <div className="access-loading">Loading organization access…</div>
          )}
        </div>
      ) : (
      <div
        id="connections-machines-panel"
        role="tabpanel"
        aria-labelledby="connections-machines-tab"
        className="connections-panel"
      >
        <div className="view-toolbar connections-toolbar">
          <span className="muted">
            {total} Machine{total === 1 ? "" : "s"}
          </span>
          <div className="toolbar-actions">{addButtons}</div>
        </div>
        {identityError && (
          <div className="connection-access-error" role="alert">
            Machine management permissions could not be loaded: {identityError}
            <button type="button" className="btn ghost sm" onClick={loadMachineAccess}>Retry</button>
          </div>
        )}
        {total === 0 ? (
          <Empty
            icon={<ComputerIcon size={28} />}
            title="No Machines Connected"
            hint={
              <div className="empty-sub">
                {canManageMachines ? (
                  <>Connect via SSH or add a native runner to start working on this dashboard.</>
                ) : identityRole ? (
                  <>Ask an organization owner or admin to connect a machine.</>
                ) : (
                  <>Loading machine access…</>
                )}
              </div>
            }
            // Only where the user CAN act. A viewer without machine-management rights is told to
            // ask an admin, and offering them a button that fails is worse than offering none —
            // §11.3's rule about disabled controls carrying a reason, applied to an empty state.
            // And only the action the toolbar would offer HERE. "local" onboarding drives the
            // desktop bridge, whose runner credential and socket work is hard-coded to the loopback
            // control plane — so on a remote instance it set up a machine the empty screen in front
            // of you does not show, and could overwrite the local runner while doing it. The gate is
            // `offerLocalSetup`, the same one the toolbar uses.
            action={!canManageMachines ? undefined : offerLocalSetup
              ? <button type="button" className="btn primary sm" onClick={() => setOnboarding("local")}>
                  {localRunnerStatus?.enabled ? "Reconnect This Machine" : "Set Up This Machine"}
                </button>
              : <button type="button" className="btn primary sm" onClick={() => setAddingBox(true)}>Connect via SSH</button>}
          />
        ) : <div className="runner-grid">
        {boxList.map((box) => (
          <BoxCard
            key={box.boxId}
            box={box}
            runner={runners.get(box.runnerId)}
            canManage={canManageMachines}
            onReconnect={reconnectBox}
            onRemove={removeBox}
          />
        ))}
        {runnerList.map((runner) => (
          <NativeRunnerCard
            key={runner.runnerId}
            runner={runner}
            canManage={canManageMachines}
            busy={Boolean(busy[runner.runnerId])}
            removeError={removeError[runner.runnerId]}
            onRediscover={rediscover}
            onManage={setSettingsRunnerId}
            onRepair={setRepairRunnerId}
          />
        ))}
        </div>}
      </div>
      )}
      {dialogs}
    </>
  );
}
