import React, { useId, useRef, useState } from "react";
import { runnerCapabilityRequirement, runnerSupportsProtocol, type AgentDefinition, type RunnerView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import {
  agentContextLabel,
  agentDisplayName,
  agentDriverLabel,
  agentStatus,
  harnessUpdateLabel,
  type AgentStatus,
} from "../agent-presentation.js";
import { relativeTime, titleCaseLabel } from "../format.js";
import { formatHarnessLaunchCommand } from "../harness-command.js";
import {
  acpCapabilitySummary,
  agentNotice,
  agentSignInFact,
  machineAgentGroups,
  notInstalledLabel,
  type MachineAgentRow,
} from "../machine-agents.js";
import { agentInstallHints } from "../runners.js";
import { statusMeta } from "../status-meta.js";
import { AgentIcon } from "./AgentIcon.js";
import { agentSessionDiscoveryUnavailableReason, agentSupportsSessionDiscovery, AgentSessionDiscoveryDialog } from "./AgentSessionDiscoveryDialog.js";
import { CopyButton, Modal } from "./common.js";
import { DetailSection } from "./DetailSection.js";
import { DialogReturnFocusContext } from "./dialog-return-focus.js";
import { useFeedback } from "./FeedbackProvider.js";
import { ChevronRightIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { CodeWell } from "./RunnerSetupParts.js";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";

const SKELETON_ROWS = 3;

function AgentBadge({ status }: { status: AgentStatus }) {
  return <StatusBadge meta={statusMeta("agent", status)} inline={status === "ready"} className="machine-agent-status" />;
}

/** One agent: its name and one badge, then the integration, where it runs and its version (§5.2). */
function AgentRow({ row, name, onOpen }: { row: MachineAgentRow; name: string; onOpen: (opener: HTMLButtonElement) => void }) {
  const { agent, status } = row;
  return (
    <li>
      <button type="button" className="row row-2" aria-haspopup="dialog"
        onClick={(event) => onOpen(event.currentTarget)}>
        <span className="row-icon"><AgentIcon driver={agent.driver ?? "acp"} agentName={agent.name} size={16} /></span>
        <span className="row-body">
          <span className="row-line">
            <span className="row-title" title={name}>{name}</span>
            <AgentBadge status={status} />
          </span>
          <span className="row-sub machine-agent-meta">
            <span>{agentDriverLabel(agent)}</span>
            <span className="machine-agent-meta-extra">{agentContextLabel(agent.context)}</span>
            {agent.version && <span className="machine-agent-meta-extra">v{agent.version}</span>}
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * Agent Details (#2990): what is wrong and how to fix it first, then one facts list, the launch
 * command and the release details. Approving or revoking a Registry launch confirms here.
 */
function AgentDetailsDialog({ agent, name, machineName, runner, online, returnFocusRef, onFindSessions, onChooseInstallation, onClose }: {
  agent: AgentDefinition;
  name: string;
  machineName: string;
  runner: RunnerView;
  online: boolean;
  returnFocusRef: { current: HTMLElement | null };
  onFindSessions: (() => void) | null;
  onChooseInstallation: (() => void) | undefined;
  onClose: () => void;
}) {
  const api = useApi();
  const { confirm } = useFeedback();
  const os = runner.os;
  const status = agentStatus(agent, online);
  const verified = runnerSupportsProtocol(runner.protocolVersion, "verifiedAgentAvailability");
  const notice = agentNotice(agent, { os, online, name, verified });
  const launch = formatHarnessLaunchCommand(agent.command, agent.args, agent.context, os);
  const registry = agent.registry;
  const registrySupported = runnerSupportsProtocol(runner.protocolVersion, "acpRegistryApproval");
  const registryBlocked = !online ? "Wait for this machine to come back online."
    : !registrySupported ? runnerCapabilityRequirement(runner.protocolVersion, "acpRegistryApproval", "registry approval")
      : null;
  const transport = registry?.transport ?? agent.acpTransport;
  const launchTitleId = useId();

  // Both confirmations wait on the request, so a failure stays in view (§7.4).
  const setApproval = (action: "approve" | "revoke") => {
    if (!registry) return;
    const approving = action === "approve";
    void confirm({
      title: approving ? "Approve Launch" : "Revoke Approval",
      message: approving
        ? `${name} v${registry.adapterVersion} from the ACP Registry can run this command on ${machineName}. If the Registry changes the command, approval is withdrawn automatically.`
        : `${name} v${registry.adapterVersion} can no longer launch from this Registry entry.`,
      ...(approving ? { details: <div className="code-well"><pre>{registry.installPreview}</pre></div> } : { tone: "danger" as const }),
      confirmLabel: approving ? "Approve Launch" : "Revoke Approval",
      progress: approving ? "Approving the launch…" : "Revoking the approval…",
      onConfirm: async () => {
        await api.setAcpRegistryApproval(runner.runnerId, agent.id, {
          action,
          schemaVersion: registry.schemaVersion,
          adapterVersion: registry.adapterVersion,
          confirmation: "explicit",
        });
      },
    });
  };

  const fixAction = notice?.action === "approve_launch" ? (
    <button type="button" className="btn sm" disabled={registryBlocked !== null} title={registryBlocked ?? undefined}
      onClick={() => setApproval("approve")}>Approve Launch…</button>
  ) : notice?.action === "choose_installation" && onChooseInstallation ? (
    <button type="button" className="btn sm" onClick={onChooseInstallation}>Choose Another Installation…</button>
  ) : null;
  const revoke = registry?.installStatus === "approved" ? (
    <button type="button" className="btn ghost danger" disabled={registryBlocked !== null} title={registryBlocked ?? undefined}
      onClick={() => setApproval("revoke")}>Revoke Approval…</button>
  ) : null;
  const tertiary = onFindSessions || revoke ? (
    <>
      {onFindSessions && <button type="button" className="btn ghost" onClick={onFindSessions}>Find Sessions…</button>}
      {revoke}
    </>
  ) : undefined;

  return (
    <Modal
      title={name}
      description={`On ${machineName}`}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      tertiary={tertiary}
      footer={<button type="button" className="btn" onClick={onClose}>Done</button>}
    >
      {notice && (
        <Notice tone={notice.tone} title={notice.title} role="status" actions={fixAction}>
          <p>{notice.text}</p>
          {notice.command && <CodeWell value={notice.command} name={`${name} Command`} />}
        </Notice>
      )}
      <dl className="facts">
        <div><dt>Integration</dt><dd>{agentDriverLabel(agent)}</dd></div>
        <div><dt>Runs In</dt><dd>{agentContextLabel(agent.context)}</dd></div>
        {agent.installation && (
          <div>
            <dt>Location</dt>
            <dd>
              <span className="connection-fact">
                <span className="connection-fact-mono">{agent.installation.path}</span>
                <CopyButton text={agent.installation.path} iconOnly ariaLabel={`Copy ${name} Location`} className="icon-btn sm" />
              </span>
            </dd>
          </div>
        )}
        <div><dt>Version</dt><dd>{agent.version ? `v${agent.version}` : "Unknown"}</dd></div>
        <div><dt>Sign-In</dt><dd>{agentSignInFact(agent)}</dd></div>
        {agent.update && <div><dt>Updates</dt><dd>{harnessUpdateLabel(agent.update, online)}</dd></div>}
        {registry && (
          <div>
            <dt>Registry</dt>
            <dd><div>{registry.description}</div><div>{acpCapabilitySummary(agent)}</div></dd>
          </div>
        )}
        {registry && transport && <div><dt>Transport</dt><dd>{transport}</dd></div>}
      </dl>
      {status !== "not_installed" && (
        <section className="machine-agent-launch" aria-labelledby={launchTitleId}>
          <h3 id={launchTitleId} className="section-title">Launch Command</h3>
          {launch.referenceOnly ? (
            <>
              <p className="section-note">This Windows launch may resolve to a batch wrapper or use an executable with legacy PowerShell argument passing, which can change quotes or expand percent signs, so there is no command to copy.</p>
              <dl className="facts">
                <div><dt>Executable</dt><dd><code>{agent.command}</code></dd></div>
                <div><dt>Arguments</dt><dd>{agent.args.length > 0 ? <code>{JSON.stringify(agent.args)}</code> : "None"}</dd></div>
              </dl>
            </>
          ) : (
            <>
              <p className="section-note">Quoted for {launch.shell}.</p>
              <CodeWell value={launch.command} name={`${name} Launch Command`} />
            </>
          )}
        </section>
      )}
      {agent.update && (
        <details className="disclosure">
          <summary>
            <ChevronRightIcon className="disclosure-chevron" />
            Release Details
          </summary>
          <div className="disclosure-body">
            <dl className="facts">
              <div><dt>Installed</dt><dd>{agent.update.installedVersion ?? "Unknown"}</dd></div>
              <div><dt>Latest Known Compatible</dt><dd>{agent.update.latestKnownCompatibleVersion ?? "Unknown"}</dd></div>
              <div><dt>Latest Published</dt><dd>{agent.update.latestPublishedVersion ?? "Unknown"}</dd></div>
              <div><dt>Channel</dt><dd>{titleCaseLabel(agent.update.channel)}</dd></div>
              <div><dt>Last Checked</dt><dd>{titleCaseLabel(relativeTime(agent.update.checkedAt))}</dd></div>
              <div><dt>Source</dt><dd>{agent.update.evidenceSource}</dd></div>
            </dl>
          </div>
        </details>
      )}
    </Modal>
  );
}

/**
 * A machine's Agents section (#2990, docs/design-system.md §5.2, §5.5): one row per agent that opens
 * Agent Details, the agents not installed folded into a closed disclosure at the end, and, while no
 * agent is ready, how to install one.
 */
export function MachineAgentsSection({ runner, online, machineName, canFindSessions, onChooseInstallation }: {
  runner: RunnerView;
  /** The machine's agent reports are current: its runner (and an SSH machine's connection) is up. */
  online: boolean;
  machineName: string;
  /** May look for sessions started outside Wollipog. Viewers may not. */
  canFindSessions: boolean;
  /** Opens Machine Settings at its installations; absent for those who may not open it. */
  onChooseInstallation?: () => void;
}) {
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  const [findingSessionsFor, setFindingSessionsFor] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const agents = runner.agents;
  const { listed, notInstalled, anyReady } = machineAgentGroups(agents, online);
  const nameOf = (agent: AgentDefinition) => agentDisplayName(agent, agents);
  const open = (agentId: string) => (button: HTMLButtonElement) => {
    opener.current = button;
    setOpenAgentId(agentId);
  };
  // The dialog follows the live report, and closes if the agent leaves the machine.
  const openAgent = openAgentId ? agents.find((agent) => agent.id === openAgentId) : undefined;
  const sessionsSupported = online && canFindSessions && runnerSupportsProtocol(runner.protocolVersion, "externalSessions");
  const canFindSessionsFor = (agent: AgentDefinition) => sessionsSupported && agentSupportsSessionDiscovery(agent) &&
    agentSessionDiscoveryUnavailableReason(agent, runner.protocolVersion) === null;
  const probing = agents.length === 0 && runner.agentsRefreshed !== true;
  const verified = runnerSupportsProtocol(runner.protocolVersion, "verifiedAgentAvailability");
  const installCommands = agentInstallHints(runner.os).filter((hint) => hint.command);

  return (
    <DetailSection title="Agents" count={probing ? undefined : agents.length}>
      {probing ? (
        <div className="skeleton" role="status" aria-live="polite">
          <span className="sr-only">Looking for agents on this machine…</span>
          <div aria-hidden="true">
            {Array.from({ length: SKELETON_ROWS }, (_, index) => (
              <div className="row row-2 machine-agent-row-skeleton" key={index}>
                <span className="row-body">
                  <span className="skeleton-bar title" />
                  <span className="skeleton-bar" />
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          {!anyReady && (
            <State compact title="No Agents Ready" className="machine-agents-empty">
              {verified ? (
                <>
                  <p>Install Claude Code or Codex on this machine, then rediscover.</p>
                  {installCommands.map((hint) => (
                    <CodeWell key={hint.name} value={hint.command!} name={`${hint.name} Install Command`} />
                  ))}
                </>
              ) : (
                <p>Update this runner to verify its configured agent availability.</p>
              )}
            </State>
          )}
          {listed.length > 0 && (
            <ul className="machine-agent-list" aria-label="Agents">
              {listed.map((row) => (
                <AgentRow key={row.agent.id} row={row} name={nameOf(row.agent)} onOpen={open(row.agent.id)} />
              ))}
            </ul>
          )}
          {notInstalled.length > 0 && (
            <details className="disclosure">
              <summary>
                <ChevronRightIcon className="disclosure-chevron" />
                {notInstalledLabel(notInstalled.length)}
              </summary>
              <ul className="disclosure-body machine-agent-list" aria-label={notInstalledLabel(notInstalled.length)}>
                {notInstalled.map((row) => (
                  <AgentRow key={row.agent.id} row={row} name={nameOf(row.agent)} onOpen={open(row.agent.id)} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {openAgent && (
        <AgentDetailsDialog
          agent={openAgent}
          name={nameOf(openAgent)}
          machineName={machineName}
          runner={runner}
          online={online}
          returnFocusRef={opener}
          onFindSessions={canFindSessionsFor(openAgent) ? () => {
            setOpenAgentId(null);
            setFindingSessionsFor(openAgent.id);
          } : null}
          // Machine Settings opens over Agent Details, so closing it comes back to the agent.
          onChooseInstallation={onChooseInstallation}
          onClose={() => setOpenAgentId(null)}
        />
      )}
      {findingSessionsFor && (
        // Find Agent Sessions replaces Agent Details, so closing it returns to the agent's row.
        <DialogReturnFocusContext.Provider value={opener}>
          <AgentSessionDiscoveryDialog runner={runner} initialAgentId={findingSessionsFor} onClose={() => setFindingSessionsFor(null)} />
        </DialogReturnFocusContext.Provider>
      )}
    </DetailSection>
  );
}
