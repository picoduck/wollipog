import React, { useCallback, useEffect, useRef, useState } from "react";
import type { OnboardingInfo } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import {
  connectLocalRunner,
  readLocalRunnerStatus,
  selectLocalRunnerId,
  type LocalRunnerStatus,
} from "../local-runner.js";
import { localRunnerReadiness, localSetupHealth, type LocalRunnerAgent, type LocalRunnerReadiness } from "../onboarding.js";
import { statusMeta } from "../status-meta.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { AgentIcon } from "./AgentIcon.js";
import { Skeleton } from "./common.js";
import { CheckIcon } from "./Icons.js";
import { InstallManuallyDialog } from "./InstallManuallyDialog.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { ConnectionCheck, OnboardingRecommendedSkills, RunnerSetupFooter, SetupLoadFailure } from "./RunnerSetupParts.js";
import { StatusBadge } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";

/**
 * Where Set Up This Machine stands. `ready-to-set-up`: the bundled runner is not set up yet (the
 * desktop bridge may already be setting it up). `setting-up`: it is set up and Wollipog waits for it
 * to start, connect and report its agents. `unavailable`: the desktop bridge has no bundled runner.
 */
export type SetUpPhase =
  | "loading"
  | "load-failed"
  | "unavailable"
  | "ready-to-set-up"
  | "setting-up"
  | "ready"
  | "needs-attention";

export function setUpPhase(input: {
  infoLoaded: boolean;
  loadFailed: boolean;
  status: LocalRunnerStatus | null | undefined;
  /** The desktop bridge is starting the runner, or is about to, since the dialog starts it on open. */
  connecting: boolean;
  connectFailed: boolean;
  readiness: LocalRunnerReadiness["state"];
}): SetUpPhase {
  const { status } = input;
  if (!input.infoLoaded) return input.loadFailed ? "load-failed" : "loading";
  if (status === undefined) return "loading";
  if (!status?.available) return "unavailable";
  if (!status.enabled) return "ready-to-set-up";
  if (input.connecting) return "setting-up";
  if (input.connectFailed) return "needs-attention";
  if (input.readiness === "ready") return "ready";
  if (input.readiness === "needs-attention") return "needs-attention";
  // Not online yet: worth waiting for only while the bridge says the runner process is running.
  if (input.readiness === "starting" && !status.running) return "needs-attention";
  return "setting-up";
}

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** The agents the runner found, one row each with its one status (§5.2, §11.1). */
function FoundAgents({ agents }: { agents: LocalRunnerAgent[] }) {
  if (agents.length === 0) return null;
  return (
    <ul className="surface set-up-machine-agents" aria-label="Agents on This Machine">
      {agents.map((agent) => (
        <li key={agent.id} className="row row-2">
          <span className="row-icon"><AgentIcon driver={agent.driver} agentName={agent.name} size={16} /></span>
          <span className="row-body">
            <span className="row-title" title={agent.name}>{agent.name}</span>
            <span className="row-sub">{agent.context}</span>
          </span>
          <StatusBadge meta={statusMeta("agent", agent.ready ? "ready" : "needs_attention")} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Set Up This Machine (#2993): connects the desktop app's bundled runner with no terminal or config
 * file. It starts the setup on open, shows the Connection Check while the runner starts, connects
 * and reports its agents, then the agents it found. Its one primary is always in the footer.
 * Install Manually Instead opens Install Manually over it (pushed onto the sheet on a phone).
 */
export function SetUpThisMachineDialog({
  onClose,
  onLocalRunnerChanged,
}: {
  onClose: () => void;
  onLocalRunnerChanged?: (status: LocalRunnerStatus) => void;
}) {
  const api = useApi();
  const { navigate } = useStoreActions();
  const runners = useStoreSelector((state) => state.runners);
  const [info, setInfo] = useState<OnboardingInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<LocalRunnerStatus | null | undefined>(undefined);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [rediscovering, setRediscovering] = useState(false);
  const [rediscoverError, setRediscoverError] = useState<string | null>(null);
  const [installingManually, setInstallingManually] = useState(false);
  const autoStarted = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = () => {
    setLoading(true);
    setLoadError(null);
    api.getOnboarding()
      .then((loaded) => { if (mounted.current) setInfo(loaded); })
      .catch((cause) => { if (mounted.current) setLoadError(message(cause)); })
      .finally(() => { if (mounted.current) setLoading(false); });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  useEffect(() => {
    readLocalRunnerStatus()
      .then((next) => { if (mounted.current) setStatus(next); })
      .catch((cause) => {
        if (!mounted.current) return;
        setStatus(null);
        setStatusError(message(cause));
      });
  }, []);

  const runnerId = status && info
    ? selectLocalRunnerId(status, info.existingRunnerIds)
    : status?.runnerId ?? status?.suggestedRunnerId ?? "this-machine";
  const runner = runners.get(runnerId);
  const readiness = localRunnerReadiness(runner);
  // Until the setup that starts on open has begun, it counts as running, so nothing flashes first.
  const working = connecting || (!attempted && status?.available === true);
  const phase = setUpPhase({
    infoLoaded: info !== null,
    loadFailed: loadError !== null,
    status,
    connecting: working,
    connectFailed: connectError !== null,
    readiness: readiness.state,
  });

  const connect = useCallback(async () => {
    if (!info || !status?.available || connecting) return;
    setAttempted(true);
    setConnecting(true);
    setConnectError(null);
    setRediscoverError(null);
    try {
      const next = await connectLocalRunner(selectLocalRunnerId(status, info.existingRunnerIds));
      if (!mounted.current) return;
      setStatus(next);
      onLocalRunnerChanged?.(next);
    } catch (cause) {
      if (mounted.current) setConnectError(message(cause));
    } finally {
      if (mounted.current) setConnecting(false);
    }
  }, [connecting, info, onLocalRunnerChanged, status]);

  useEffect(() => {
    if (!info || !status?.available || autoStarted.current) return;
    autoStarted.current = true;
    void connect();
  }, [connect, info, status]);

  const rediscover = async () => {
    setRediscovering(true);
    setRediscoverError(null);
    try {
      await api.rediscover(runnerId);
    } catch (cause) {
      if (mounted.current) setRediscoverError(message(cause));
    } finally {
      if (mounted.current) setRediscovering(false);
    }
  };

  // The runner never came online, or reconnecting it failed: Reconnect, rather than Rediscover.
  const reconnect = connectError !== null || readiness.state === "starting";
  const result = phase === "ready" || phase === "needs-attention";

  const footer = phase === "load-failed" || phase === "unavailable"
    ? <button type="button" className="btn" onClick={onClose}>Cancel</button>
    : phase === "loading" || phase === "ready-to-set-up"
      ? (
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <BusyButton
            className="btn primary"
            busy={working}
            progress="Setting up this machine…"
            disabled={phase === "loading"}
            onClick={() => void connect()}
          >
            Set Up This Machine
          </BusyButton>
        </>
      )
      : <RunnerSetupFooter stage={phase === "setting-up" ? "waiting" : "connected"} beforeNote="" onClose={onClose} />;

  return (
    <>
      <Modal
        title="Set Up This Machine"
        description="Run agents on the computer Wollipog is running on."
        onClose={onClose}
        tertiary={phase === "setting-up" || phase === "ready" ? undefined : (
          <button type="button" className="btn ghost" onClick={() => setInstallingManually(true)}>
            Install Manually Instead
          </button>
        )}
        footer={footer}
      >
        {phase === "loading" ? (
          <Skeleton rows={3} announce="Loading setup details…" />
        ) : phase === "load-failed" ? (
          <SetupLoadFailure message={loadError!} retrying={loading} onRetry={load} />
        ) : (
          <div className="runner-setup">
            {phase === "unavailable" && (
              <Notice
                tone="danger"
                role="alert"
                details={statusError ? <div className="code-well"><pre>{statusError}</pre></div> : undefined}
              >
                Wollipog couldn't reach its bundled runner. Close this dialog and try again.
              </Notice>
            )}

            {phase === "ready-to-set-up" && (
              <>
                <ul className="set-up-machine-checklist">
                  <li><CheckIcon size={14} />No Node.js, repository clone, config file or terminal command</li>
                  <li><CheckIcon size={14} />Starts automatically with Wollipog</li>
                  <li><CheckIcon size={14} />Discovers supported native and WSL coding agents</li>
                </ul>
                {connectError && (
                  <Notice tone="danger" role="alert" details={<div className="code-well"><pre>{connectError}</pre></div>}>
                    Wollipog couldn't set up this machine. Try again.
                  </Notice>
                )}
              </>
            )}

            {phase === "setting-up" && <ConnectionCheck health={localSetupHealth({ starting: working, runner })} />}

            {phase === "ready" && (
              <Notice tone="success" role="status" title="This Machine Is Ready">{readiness.detail}</Notice>
            )}

            {phase === "needs-attention" && (
              <Notice
                tone="warning"
                role="status"
                title={connectError ? "Couldn't Reconnect This Machine" : reconnect ? "This Machine Isn't Connected" : readiness.title}
                actions={reconnect ? (
                  <button type="button" className="btn sm" onClick={() => void connect()}>Reconnect This Machine</button>
                ) : (
                  <BusyButton
                    className="btn sm"
                    busy={rediscovering}
                    progress="Rediscovering this machine's agents…"
                    onClick={() => void rediscover()}
                  >
                    Rediscover
                  </BusyButton>
                )}
                details={connectError ? <div className="code-well"><pre>{connectError}</pre></div> : undefined}
              >
                {connectError
                  ? "Wollipog couldn't restart its bundled runner."
                  : reconnect ? "The bundled runner isn't running." : readiness.detail}
              </Notice>
            )}

            {result && <FoundAgents agents={readiness.agents} />}
            {result && rediscoverError && (
              <Notice tone="danger" role="alert" details={<div className="code-well"><pre>{rediscoverError}</pre></div>}>
                Wollipog couldn't rediscover this machine's agents. Try again.
              </Notice>
            )}
            {result && (
              <OnboardingRecommendedSkills onOpen={(skillId) => {
                onClose();
                navigate({ name: "skills", id: skillId });
              }} />
            )}
          </div>
        )}
      </Modal>
      {installingManually && <InstallManuallyDialog onClose={() => setInstallingManually(false)} />}
    </>
  );
}
