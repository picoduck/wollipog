import { useEffect, useMemo, useRef, useState } from "react";
import {
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type AgentContext,
  type AgentDefinition,
  type ExternalSessionDescriptor,
  type RunnerView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import {
  agentDriverDescription,
  agentDriverLabel,
  driverKindLabel,
  isGeneratedConductorName,
} from "../agent-presentation.js";
import { relativeTime, titleCaseLabel } from "../format.js";
import { adoptAction, externalSessionKey } from "../runners.js";
import { Modal, Spinner } from "./common.js";
import { RefreshIcon, SearchIcon } from "./Icons.js";
import { agentOptions } from "./agent-options.js";

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
  if (agent.available === false || agent.id === "conductor" || isGeneratedConductorName(agent.name)) return false;
  const driver = agent.driver ?? "acp";
  if (driver === "claude-code" || driver === "codex" || driver === "codex-app-server") return true;
  return driver === "acp" && agent.acp?.sessionList !== false;
}

export function agentSessionDiscoveryUnavailableReason(
  agent: AgentDefinition,
  protocolVersion: number | null | undefined,
): string | null {
  if (agent.driver !== "codex-app-server"
    || runnerSupportsProtocol(protocolVersion, "codexAppServerExternalSessions")) return null;
  return runnerCapabilityRequirement(
    protocolVersion,
    "codexAppServerExternalSessions",
    "Codex App Server session discovery",
  );
}

export function sessionMatchesAgent(session: ExternalSessionDescriptor, agent: AgentDefinition): boolean {
  const driver = agent.driver ?? "acp";
  if (driver === "acp") return session.agentId === agent.id;
  return !session.agentId && session.driver === driver && sameContext(agent.context, session.context);
}

export function AgentSessionDiscoveryDialog({
  runner,
  onClose,
}: {
  runner: RunnerView;
  onClose: () => void;
}) {
  const api = useApi();
  const agentEntries = useMemo(
    () => agentOptions(runner.agents, { includeProviderAdapters: true })
      .filter((option) => agentSupportsSessionDiscovery(option.agent)),
    [runner.agents],
  );
  const agents = useMemo(() => agentEntries.map((option) => option.agent), [agentEntries]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [state, setState] = useState<DiscoveryState>("selecting");
  const [sessions, setSessions] = useState<ExternalSessionDescriptor[]>([]);
  const [error, setError] = useState("");
  const [adopting, setAdopting] = useState<Record<string, boolean>>({});
  const requestGeneration = useRef(0);
  const selectionStepRef = useRef<HTMLDivElement>(null);
  const resultsStepRef = useRef<HTMLDivElement>(null);
  const rescanButtonRef = useRef<HTMLButtonElement>(null);
  const restoreRescanFocusRef = useRef(false);
  const previousStepRef = useRef<"selecting" | "results">("selecting");
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null;
  const selectedAgentLabel = agentEntries.find((option) => option.agent.id === selectedAgentId)?.label ?? "";

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

  useEffect(() => {
    if (state === "loaded" && restoreRescanFocusRef.current) {
      restoreRescanFocusRef.current = false;
      rescanButtonRef.current?.focus();
    } else if (state === "error" && restoreRescanFocusRef.current) {
      restoreRescanFocusRef.current = false;
      resultsStepRef.current?.focus();
    }
  }, [state]);

  const load = async () => {
    if (!selectedAgent) return;
    restoreRescanFocusRef.current = state === "loaded"
      && document.activeElement === rescanButtonRef.current;
    const generation = ++requestGeneration.current;
    if (state === "error") resultsStepRef.current?.focus();
    setState("loading");
    setError("");
    try {
      const response = await api.listExternalSessions(runner.runnerId, selectedAgent.id);
      if (generation !== requestGeneration.current) return;
      setSessions(response.sessions.filter((session) => sessionMatchesAgent(session, selectedAgent)));
      setState("loaded");
    } catch (caught) {
      if (generation !== requestGeneration.current) return;
      setError((caught as Error).message);
      setState("error");
    }
  };

  const chooseAnotherAgent = () => {
    requestGeneration.current += 1;
    restoreRescanFocusRef.current = false;
    setState("selecting");
    setSessions([]);
    setError("");
    setAdopting({});
  };

  const adopt = async (descriptor: ExternalSessionDescriptor) => {
    const generation = requestGeneration.current;
    const key = externalSessionKey(descriptor);
    setAdopting((current) => ({ ...current, [key]: true }));
    setError("");
    try {
      await api.adoptSession(runner.runnerId, descriptor, true);
      if (generation !== requestGeneration.current) return;
      setSessions((current) => current.filter((session) => externalSessionKey(session) !== key));
    } catch (caught) {
      if (generation !== requestGeneration.current) return;
      setError((caught as Error).message);
    } finally {
      if (generation === requestGeneration.current) {
        setAdopting((current) => ({ ...current, [key]: false }));
      }
    }
  };

  const selecting = state === "selecting";
  return (
    <Modal
      title="Find Agent Sessions"
      onClose={onClose}
      wide
      className="agent-session-dialog"
      describedBy={selecting ? "agent-session-dialog-description" : undefined}
      footer={selecting ? (
        <>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn primary"
            disabled={!selectedAgent}
            onClick={() => void load()}
          >
            <SearchIcon />
            <span>Find Sessions</span>
          </button>
        </>
      ) : (
        <button type="button" className="btn" onClick={onClose}>Close</button>
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
            Select the agent that created the sessions. Wollipog will scan only that agent and execution context.
          </p>
          {agents.length === 0 ? (
            <div className="agent-session-empty" role="status">
              No available agents on this machine support session discovery.
            </div>
          ) : (
            <fieldset className="agent-session-agent-picker">
              <legend>Select an Agent</legend>
              <div className="agent-session-agent-list">
                {agentEntries.map(({ agent, label }) => {
                  const unavailableReason = agentSessionDiscoveryUnavailableReason(agent, runner.protocolVersion);
                  return (
                    <label
                      key={agent.id}
                      className={`agent-session-agent-option ${selectedAgentId === agent.id ? "selected" : ""} ${unavailableReason ? "unavailable" : ""}`}
                    >
                      <input
                        type="radio"
                        name="agent-session-agent"
                        value={agent.id}
                        checked={selectedAgentId === agent.id}
                        disabled={!!unavailableReason}
                        onChange={() => setSelectedAgentId(agent.id)}
                      />
                      <span className="agent-session-agent-copy">
                        <span className="agent-session-agent-name">
                          {label}
                          {unavailableReason && <span className="agent-session-update-badge">Runner Update Required</span>}
                        </span>
                        <span className="agent-session-agent-meta">
                          {titleCaseLabel(agentDriverLabel(agent))} · {contextLabel(agent.context)}
                          {agent.version ? ` · v${agent.version}` : ""}
                        </span>
                        <span className="agent-session-agent-description">
                          {unavailableReason ?? agentDriverDescription(agent)}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          )}
        </div>
      ) : (
        <div
          ref={resultsStepRef}
          className="agent-session-results-step"
          tabIndex={-1}
          aria-label="Agent Session Discovery Results"
        >
          <div className="agent-session-selected-agent">
            <div>
              <span className="agent-session-selection-label">Selected Agent</span>
              <strong>{selectedAgentLabel}</strong>
              <span>
                {selectedAgent
                  ? `${titleCaseLabel(agentDriverLabel(selectedAgent))} · ${contextLabel(selectedAgent.context)}`
                  : ""}
              </span>
            </div>
            <button type="button" className="btn ghost sm" onClick={chooseAnotherAgent}>
              Choose Another Agent
            </button>
          </div>

          {(state === "loading" || state === "loaded") && (
            <div className="agent-session-results-head">
              <div>
                <strong>Sessions</strong>
                <span>{state === "loading" ? "Scanning…" : `${sessions.length} Found`}</span>
              </div>
              <button
                ref={rescanButtonRef}
                type="button"
                className="btn ghost sm"
                disabled={state === "loading"}
                onClick={() => void load()}
              >
                <RefreshIcon />
                <span>{state === "loading" ? "Scanning…" : "Rescan"}</span>
              </button>
            </div>
          )}

          {state === "loading" && (
            <div className="agent-session-loading" role="status" aria-live="polite">
              <Spinner />
              <div>
                <strong>Scanning {selectedAgentLabel}</strong>
                <span>This can take a few seconds while the runner checks local session history.</span>
              </div>
            </div>
          )}

          {state === "error" && (
            <div className="agent-session-error" role="alert">
              <strong>Sessions Could Not Be Loaded</strong>
              <span>{error}</span>
              <button type="button" className="btn sm" onClick={() => void load()}>
                <RefreshIcon />
                <span>Try Again</span>
              </button>
            </div>
          )}

          {state === "loaded" && (
            <>
              {sessions.length === 0 ? (
                <div className="agent-session-empty" role="status">
                  No unmanaged sessions were found for this agent.
                </div>
              ) : (
                <ul className="ext-session-list agent-session-results">
                  {sessions.map((descriptor) => {
                    const action = adoptAction(descriptor);
                    const key = externalSessionKey(descriptor);
                    return (
                      <li key={key} className="ext-session">
                        <span className="ext-title" title={descriptor.title || undefined}>
                          {descriptor.title || "(Untitled Session)"}
                        </span>
                        <div className="ext-badges">
                          <span className={`atag driver-${descriptor.driver}`}>
                            {titleCaseLabel(driverKindLabel(descriptor.driver))}
                          </span>
                          <span className="atag ctx">{contextLabel(descriptor.context)}</span>
                        </div>
                        <span className="ws-path" title={descriptor.cwd}>{descriptor.cwd}</span>
                        <div className="ext-foot">
                          <span className="muted">
                            {relativeTime(descriptor.updatedAt)} · {descriptor.messageCount} Messages
                          </span>
                          <button
                            type="button"
                            className="btn sm"
                            onClick={() => void adopt(descriptor)}
                            disabled={adopting[key]}
                            title={action.title}
                          >
                            {adopting[key] ? "Adopting…" : action.label}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {error && <div className="agent-session-inline-error" role="alert">{error}</div>}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
