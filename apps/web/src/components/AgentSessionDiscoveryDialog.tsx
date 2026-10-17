import { useEffect, useMemo, useRef, useState } from "react";
import {
  runnerSupportsProtocol,
  type AgentContext,
  type AgentDefinition,
  type ExternalSessionDescriptor,
  type RunnerView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { agentDriverLabel } from "../agent-presentation.js";
import { relativeTime, titleCaseLabel } from "../format.js";
import { adoptAction, externalSessionKey } from "../runners.js";
import { Modal } from "./common.js";
import { RefreshIcon, SearchIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { State } from "./State.js";
import { agentOptions, type AgentOption } from "./agent-options.js";
import { BusyButton } from "./ui/BusyButton.js";
import { ChoiceRows, type ChoiceRowOption } from "./ui/ChoiceControls.js";

type DiscoveryState = "selecting" | "loading" | "loaded" | "error";

function contextLabel(context: AgentContext | undefined): string {
  return context?.kind === "wsl" ? `WSL: ${context.distro}` : "Native";
}

function sameContext(left: AgentContext | undefined, right: AgentContext): boolean {
  const normalized = left ?? { kind: "native" as const };
  return normalized.kind === right.kind
    && (normalized.kind !== "wsl" || (right.kind === "wsl" && normalized.distro === right.distro));
}

export function agentSupportsSessionDiscovery(agent: AgentDefinition): boolean {
  if (agent.available !== true) return false;
  const driver = agent.driver ?? "acp";
  if (driver === "claude-code" || driver === "codex" || driver === "codex-app-server" || driver === "pi") return true;
  return driver === "acp" && agent.acp?.sessionList !== false;
}

/** Why the runner cannot scan this agent yet, as the visible second line of its row (§8.4): the
 * runner predates the agent's session discovery. Null when it can. */
export function agentSessionDiscoveryUnavailableReason(
  agent: AgentDefinition,
  protocolVersion: number | null | undefined,
): string | null {
  const unsupported = agent.driver === "pi"
    ? !runnerSupportsProtocol(protocolVersion, "piExternalSessions")
    : agent.driver === "codex-app-server"
      && !runnerSupportsProtocol(protocolVersion, "codexAppServerExternalSessions");
  return unsupported ? "Update this machine's runner to find this agent's sessions." : null;
}

export function sessionMatchesAgent(session: ExternalSessionDescriptor, agent: AgentDefinition): boolean {
  const driver = agent.driver ?? "acp";
  if (driver === "acp") return session.agentId === agent.id;
  return !session.agentId && session.driver === driver && sameContext(agent.context, session.context);
}

/** The agent's integration, where it runs and its version: one meta line (§11.3). The integration
 * is left out when the agent's name already says it ("Pi RPC" over "Pi RPC"). */
function agentMetaLine(option: AgentOption): string {
  const integration = titleCaseLabel(agentDriverLabel(option.agent));
  return [
    option.label.includes(integration) ? null : integration,
    contextLabel(option.agent.context),
    option.agent.version ? `v${option.agent.version}` : null,
  ].filter(Boolean).join(" · ");
}

/** The agent a fresh dialog selects: the one it was opened for, else the only one it can scan. */
function initialSelection(scannable: readonly AgentDefinition[], initialAgentId: string | undefined): string {
  if (initialAgentId && scannable.some((agent) => agent.id === initialAgentId)) return initialAgentId;
  return scannable.length === 1 ? scannable[0]!.id : "";
}

const SKELETON_ROWS = 3;

export function AgentSessionDiscoveryDialog({
  runner,
  initialAgentId,
  onClose,
}: {
  runner: RunnerView;
  /** Preselects this agent, as Agent Details' Find Sessions… does, when it can be scanned. */
  initialAgentId?: string;
  onClose: () => void;
}) {
  const api = useApi();
  const agentEntries = useMemo(
    () => agentOptions(runner.agents, { includeProviderAdapters: true })
      .filter((option) => agentSupportsSessionDiscovery(option.agent)),
    [runner.agents],
  );
  const unavailableReasons = useMemo(
    () => new Map(agentEntries.map(({ agent }) => [
      agent.id,
      agentSessionDiscoveryUnavailableReason(agent, runner.protocolVersion),
    ])),
    [agentEntries, runner.protocolVersion],
  );
  const scannable = useMemo(
    () => agentEntries.map((option) => option.agent).filter((agent) => !unavailableReasons.get(agent.id)),
    [agentEntries, unavailableReasons],
  );
  const [selectedAgentId, setSelectedAgentId] = useState(() => initialSelection(scannable, initialAgentId));
  const [state, setState] = useState<DiscoveryState>("selecting");
  const [sessions, setSessions] = useState<ExternalSessionDescriptor[]>([]);
  const [error, setError] = useState("");
  const [adoptError, setAdoptError] = useState("");
  const [adopting, setAdopting] = useState<Record<string, boolean>>({});
  // Rescan from the results header keeps that button (busy) through the scan, so focus stays on it.
  const [rescanningInPlace, setRescanningInPlace] = useState(false);
  const requestGeneration = useRef(0);
  const selectionStepRef = useRef<HTMLDivElement>(null);
  const resultsStepRef = useRef<HTMLDivElement>(null);
  const previousStepRef = useRef<"selecting" | "results">("selecting");
  const selectedAgent = scannable.find((agent) => agent.id === selectedAgentId) ?? null;
  const selectedAgentLabel = agentEntries.find((option) => option.agent.id === selectedAgentId)?.label ?? "";
  const machineName = runner.displayName || runner.hostname || runner.runnerId;

  useEffect(() => () => {
    requestGeneration.current += 1;
  }, []);

  useEffect(() => {
    const nextStep = state === "selecting" ? "selecting" : "results";
    if (nextStep !== previousStepRef.current) {
      (nextStep === "selecting" ? selectionStepRef : resultsStepRef).current?.focus();
    }
    previousStepRef.current = nextStep;
  }, [state]);

  const load = async ({ inPlace = false }: { inPlace?: boolean } = {}) => {
    if (!selectedAgent) return;
    const generation = ++requestGeneration.current;
    // A recovery action (Try Again, the no-results Rescan) unmounts with its state, so focus moves
    // to the results step rather than falling to the document.
    if (!inPlace && state !== "selecting") resultsStepRef.current?.focus();
    setRescanningInPlace(inPlace);
    setState("loading");
    setError("");
    setAdoptError("");
    try {
      const response = await api.listExternalSessions(runner.runnerId, selectedAgent.id);
      if (generation !== requestGeneration.current) return;
      setSessions(response.sessions.filter((session) => sessionMatchesAgent(session, selectedAgent)));
      setState("loaded");
    } catch (caught) {
      if (generation !== requestGeneration.current) return;
      setError((caught as Error).message);
      setState("error");
    } finally {
      if (generation === requestGeneration.current) setRescanningInPlace(false);
    }
  };

  const changeAgent = () => {
    requestGeneration.current += 1;
    setRescanningInPlace(false);
    setState("selecting");
    setSessions([]);
    setError("");
    setAdoptError("");
    setAdopting({});
  };

  const adopt = async (descriptor: ExternalSessionDescriptor) => {
    const generation = requestGeneration.current;
    const key = externalSessionKey(descriptor);
    setAdopting((current) => ({ ...current, [key]: true }));
    setAdoptError("");
    try {
      await api.adoptSession(runner.runnerId, descriptor, true);
      if (generation !== requestGeneration.current) return;
      setSessions((current) => current.filter((session) => externalSessionKey(session) !== key));
    } catch (caught) {
      if (generation !== requestGeneration.current) return;
      setAdoptError((caught as Error).message);
    } finally {
      if (generation === requestGeneration.current) {
        setAdopting((current) => ({ ...current, [key]: false }));
      }
    }
  };

  const agentChoices: ChoiceRowOption<string>[] = agentEntries.map((option) => {
    const reason = unavailableReasons.get(option.agent.id) ?? null;
    return {
      value: option.agent.id,
      title: option.label,
      description: agentMetaLine(option),
      inputData: { "data-agent-id": option.agent.id },
      ...(reason ? { disabled: true, disabledReason: reason } : {}),
    };
  });

  const selecting = state === "selecting";
  const showHeaderRescan = (state === "loaded" && sessions.length > 0) || (state === "loading" && rescanningInPlace);
  return (
    <Modal
      title="Find Agent Sessions"
      onClose={onClose}
      size="lg"
      describedBy={selecting ? "agent-session-dialog-description" : undefined}
      footer={selecting ? (
        <>
          {!selectedAgent && scannable.length > 0 && (
            <p className="agent-session-find-reason" id="agent-session-find-reason">Choose an agent to scan.</p>
          )}
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn primary"
            disabled={!selectedAgent}
            aria-describedby={!selectedAgent && scannable.length > 0 ? "agent-session-find-reason" : undefined}
            onClick={() => void load()}
          >
            <SearchIcon />
            <span>Find Sessions</span>
          </button>
        </>
      ) : (
        <button type="button" className="btn" onClick={onClose}>Done</button>
      )}
    >
      {selecting ? (
        <div
          ref={selectionStepRef}
          className="agent-session-agent-step"
          tabIndex={-1}
          aria-label="Agent Selection"
        >
          <p id="agent-session-dialog-description" className="agent-session-intro">
            Choose the agent that started the sessions. Wollipog scans only that agent, where it runs.
          </p>
          {agentEntries.length === 0 ? (
            <State compact title="No Agents Can List Sessions">
              No agent on {machineName} can list the sessions it started.
            </State>
          ) : (
            <ChoiceRows
              label="Agent"
              options={agentChoices}
              value={selectedAgent ? selectedAgentId : null}
              onChange={setSelectedAgentId}
            />
          )}
        </div>
      ) : (
        <div
          ref={resultsStepRef}
          className="agent-session-results-step"
          tabIndex={-1}
          aria-label="Agent Session Discovery Results"
        >
          <div className="agent-session-results-head">
            <strong className="agent-session-results-agent">{selectedAgentLabel}</strong>
            <button type="button" className="btn sm ghost" onClick={changeAgent}>Change Agent</button>
            {showHeaderRescan && (
              <BusyButton
                className="btn sm ghost"
                busy={state === "loading"}
                progress={`Scanning ${selectedAgentLabel} sessions on ${machineName}…`}
                icon={<RefreshIcon />}
                onClick={() => void load({ inPlace: true })}
              >
                Rescan
              </BusyButton>
            )}
          </div>

          {state === "loading" && (
            <div className="agent-session-scanning" role="status" aria-live="polite">
              <p className="agent-session-scanning-text">
                Scanning {selectedAgentLabel} sessions on {machineName}…
              </p>
              <div className="surface" aria-hidden="true">
                {Array.from({ length: SKELETON_ROWS }, (_, index) => (
                  <div className="row row-2 agent-session-result-skeleton" key={index}>
                    <span className="row-body">
                      <span className="skeleton-bar title" />
                      <span className="skeleton-bar" />
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {state === "error" && (
            <State
              variant="error"
              compact
              title="Couldn't Load Sessions"
              actions={(
                <button type="button" className="btn sm" onClick={() => void load()}>
                  <RefreshIcon />
                  <span>Try Again</span>
                </button>
              )}
              details={<code className="agent-session-error-detail">{error}</code>}
            >
              The runner on {machineName} couldn't list {selectedAgentLabel} sessions.
            </State>
          )}

          {state === "loaded" && sessions.length === 0 && (
            <State
              variant="no-results"
              compact
              title="No Sessions Found"
              actions={(
                <button type="button" className="btn sm" onClick={() => void load()}>
                  <RefreshIcon />
                  <span>Rescan</span>
                </button>
              )}
            >
              {selectedAgentLabel} has no sessions on this machine that Wollipog isn't already showing.
            </State>
          )}

          {state === "loaded" && sessions.length > 0 && (
            <ul className="surface agent-session-results" aria-label={`${selectedAgentLabel} Sessions`}>
              {sessions.map((descriptor) => {
                const action = adoptAction(descriptor);
                const key = externalSessionKey(descriptor);
                return (
                  <li key={key} className={`row row-2${action.reason ? " read-only" : ""}`}>
                    <span className="row-body">
                      <span className="row-line">
                        {descriptor.title ? (
                          <span className="row-title" title={descriptor.title}>{descriptor.title}</span>
                        ) : (
                          <span className="row-title agent-session-untitled">Untitled Session</span>
                        )}
                      </span>
                      <span className="row-line">
                        <span className="row-sub agent-session-path" title={descriptor.cwd}>
                          <bdi>{descriptor.cwd}</bdi>
                        </span>
                        <span className="row-trail">
                          {relativeTime(descriptor.updatedAt)} · {descriptor.messageCount} Messages
                        </span>
                      </span>
                      {action.reason && <span className="row-sub agent-session-reason">{action.reason}</span>}
                    </span>
                    <BusyButton
                      className="btn sm"
                      busy={adopting[key] === true}
                      progress={action.reason ? "Importing the session…" : "Continuing the session here…"}
                      onClick={() => void adopt(descriptor)}
                    >
                      {action.label}
                    </BusyButton>
                  </li>
                );
              })}
            </ul>
          )}

          {adoptError && (
            <Notice tone="danger" role="alert" title="Couldn't Open Session" details={<code>{adoptError}</code>}>
              The session stays where it is. Try again, or rescan if it changed.
            </Notice>
          )}
        </div>
      )}
    </Modal>
  );
}
