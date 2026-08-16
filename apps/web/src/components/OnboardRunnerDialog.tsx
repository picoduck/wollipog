import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OnboardingInfo, RunnerCredentialSecret } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import {
  buildRunnerConfigJson,
  localRunnerReadiness,
  onboardingHealth,
  RUNNER_START_COMMAND,
  RUNNER_TOKEN_FILE,
  suggestRunnerId,
  withHost,
  type OnboardingHealthCheck,
} from "../onboarding.js";
import {
  connectLocalRunner,
  readLocalRunnerStatus,
  selectLocalRunnerId,
  type LocalRunnerStatus,
} from "../local-runner.js";
import { useStoreSelector } from "../store.js";
import { CopyButton, Modal, Spinner } from "./common.js";

export function OnboardingHealthChecklist({ health }: { health: OnboardingHealthCheck[] }) {
  return (
    <ul className="onboard-health" aria-label="Runner Health Checklist" aria-live="polite">
      {health.map((check) => (
        <li className={`onboard-health-${check.status}`} key={check.id}>
          <span className="onboard-health-icon" aria-hidden="true">
            {/* The pending branch is a real progress state — the check is still running — so it
                gets the spinner. Decorative because the row's sr-only text already announces the
                status, and two names would read as "Loading pending: Tailscale". */}
            {check.status === "pass" ? "✓" : check.status === "fail" ? "!" : check.status === "warning" ? "△" : <Spinner decorative />}
          </span>
          <div>
            <strong><span className="sr-only">{check.status}: </span>{check.label}</strong>
            <span>{check.detail}</span>
            {check.command && (
              <span className="onboard-health-command">
                <code>{check.command}</code>
                <CopyButton text={check.command} ariaLabel={`Copy ${check.label.toLowerCase()} recovery command`} />
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function LocalRunnerSetupButton({
  status,
  existingRunnerIds,
  busy,
  onConnect,
}: {
  status: LocalRunnerStatus;
  existingRunnerIds: string[];
  busy: boolean;
  onConnect: (runnerId: string) => void | Promise<void>;
}) {
  return (
    <button
      className="btn primary"
      type="button"
      onClick={() => void onConnect(selectLocalRunnerId(status, existingRunnerIds))}
      disabled={busy}
    >
      {busy ? "Setting Up…" : status.enabled ? "Reconnect This Machine" : "Set Up This Machine"}
    </button>
  );
}
/**
 * Guided "Add a runner" flow: fetches connection coordinates, reserves an exact runner id,
 * returns its credential once, and generates a token-free runner.config.json plus the start
 * command, with a loopback/LAN host switch for connecting a runner from another machine.
 */
export function OnboardRunnerDialog({
  onClose,
  initialRunnerId,
  mode = "manual",
  onLocalRunnerChanged,
}: {
  onClose: () => void;
  initialRunnerId?: string;
  mode?: "local" | "manual";
  onLocalRunnerChanged?: (status: LocalRunnerStatus) => void;
}) {
  const api = useApi();
  const runners = useStoreSelector((state) => state.runners);
  const [info, setInfo] = useState<OnboardingInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [secret, setSecret] = useState<RunnerCredentialSecret | null>(null);
  const [runnerId, setRunnerId] = useState(initialRunnerId ?? "runner");
  const [host, setHost] = useState("127.0.0.1");
  const [wsId, setWsId] = useState("my-repo");
  const [wsPath, setWsPath] = useState("/path/to/your/repo");
  const [localStatus, setLocalStatus] = useState<LocalRunnerStatus | null | undefined>(undefined);
  const [localBusy, setLocalBusy] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(mode === "manual");
  const autoStarted = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = () => {
    setLoading(true);
    setError(null);
    api
      .getOnboarding()
      .then((i) => {
        if (!mounted.current) return;
        setInfo(i);
        setRunnerId(initialRunnerId ?? suggestRunnerId(i.existingRunnerIds));
      })
      .catch((e) => mounted.current && setError((e as Error).message))
      .finally(() => mounted.current && setLoading(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => load(), []);

  useEffect(() => {
    readLocalRunnerStatus()
      .then((status) => {
        if (mounted.current) setLocalStatus(status);
      })
      .catch((cause) => {
        if (mounted.current) {
          setLocalStatus(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
  }, []);

  const hostOptions = useMemo(() => ["127.0.0.1", ...(info?.lanIps ?? [])], [info]);
  const isRemote = host !== "127.0.0.1";
  const wsUrl = info ? withHost(info.runnerWsUrl, host) : "";
  const credentialMatches = secret?.credential.runnerId === runnerId.trim();
  const config =
    info && runnerId.trim() && credentialMatches
      ? buildRunnerConfigJson({
          runnerId: runnerId.trim(),
          runnerWsUrl: wsUrl,
          workspaceId: wsId.trim() || "my-repo",
          workspacePath: wsPath.trim() || ".",
        })
      : "";
  const repairingExisting = Boolean(initialRunnerId && runnerId.trim() === initialRunnerId);
  const runnerIdCollision = Boolean(info?.existingRunnerIds.includes(runnerId.trim()) && !repairingExisting);
  const liveRunner = runnerIdCollision ? undefined : runners.get(runnerId.trim());
  const health = info ? onboardingHealth({
    credentialAvailable: Boolean(credentialMatches),
    runnerId,
    workspaceId: wsId,
    runner: liveRunner,
    runnerIdCollision,
  }) : [];
  const localRunnerId = localStatus && info
    ? selectLocalRunnerId(localStatus, info.existingRunnerIds)
    : localStatus?.runnerId ?? localStatus?.suggestedRunnerId ?? "this-machine";
  const localRunner = runners.get(localRunnerId);
  const localReadiness = localRunnerReadiness(localRunner);
  const showLocalSetup = !repairingExisting && localStatus?.available === true;
  const localStatusLoading = mode === "local" && localStatus === undefined;
  const localTitle = !localStatus?.enabled && !localBusy ? "Connect This Machine" : localReadiness.title;
  const localDetail = !localStatus?.enabled && !localBusy
    ? "Use Wollipog's bundled runner to connect this computer and discover its supported coding agents."
    : localReadiness.detail;

  const connectThisMachine = useCallback(async (selectedRunnerId?: string) => {
    if (!info || !localStatus?.available || localBusy) return;
    const id = selectedRunnerId ?? selectLocalRunnerId(localStatus, info.existingRunnerIds);
    setLocalBusy(true);
    setError(null);
    try {
      const status = await connectLocalRunner(id);
      if (!mounted.current) return;
      setLocalStatus(status);
      onLocalRunnerChanged?.(status);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setLocalBusy(false);
    }
  }, [info, localBusy, localStatus, onLocalRunnerChanged]);

  useEffect(() => {
    if (mode !== "local" || !info || !localStatus?.available || autoStarted.current) return;
    autoStarted.current = true;
    void connectThisMachine();
  }, [connectThisMachine, info, localStatus, mode]);

  const generateCredential = async () => {
    const id = runnerId.trim();
    if (!id) return;
    setGenerating(true);
    setError(null);
    try {
      let issued: RunnerCredentialSecret;
      try {
        issued = await api.issueRunnerCredential(id, repairingExisting ? "Connection repair" : "Onboarding credential");
      } catch (issueError) {
        if (!repairingExisting || !/rotate it instead/i.test((issueError as Error).message)) throw issueError;
        issued = await api.rotateRunnerCredential(id, "Connection repair");
      }
      if (mounted.current) setSecret(issued);
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setGenerating(false);
    }
  };

  return (
    <Modal
      title={repairingExisting ? "Repair Runner Connection" : mode === "local" ? "Set Up This Machine" : "Add a Runner"}
      onClose={onClose}
      wide
      footer={<button className="btn primary" onClick={onClose}>Done</button>}
    >
      {!info || localStatusLoading ? (
        !info && error ? (
          <div className="onboard-error">
            <p className="form-error" role="alert">Couldn't load onboarding info: {error}</p>
            <button className="btn ghost sm" onClick={load} disabled={loading}>
              {loading ? "Retrying…" : "↻ Retry"}
            </button>
          </div>
        ) : (
          <Spinner />
        )
      ) : (
        <div className="onboard">
          {showLocalSetup && (
            <section className={`onboard-local onboard-local-${localReadiness.state}`} aria-live="polite">
              <div className="onboard-local-icon" aria-hidden="true">
                {localReadiness.state === "ready" ? "✓" : localReadiness.state === "needs-attention" ? "!" : <Spinner />}
              </div>
              <div className="onboard-local-body">
                <h3>{localBusy ? "Installing the Local Runner" : localTitle}</h3>
                <p>
                  {localBusy
                    ? "Wollipog is creating a private credential and starting its bundled runner."
                    : localDetail}
                </p>
                {!localStatus.enabled && !localBusy && mode !== "local" && (
                  <ul className="tick onboard-local-benefits">
                    <li>No Node.js, repository clone, config file, or terminal command</li>
                    <li>Starts automatically with Wollipog</li>
                    <li>Discovers supported native and WSL coding agents</li>
                  </ul>
                )}
                {localReadiness.agentLabels.length > 0 && (
                  <div className="onboard-local-agents" aria-label="Discovered Coding Agents">
                    {localReadiness.agentLabels.map((label) => <span key={label}>{label}</span>)}
                  </div>
                )}
                {error && <p className="form-error" role="alert">{error}</p>}
                {mode !== "local" && localReadiness.state !== "ready" && (
                  <LocalRunnerSetupButton
                    status={localStatus}
                    existingRunnerIds={info.existingRunnerIds}
                    busy={localBusy}
                    onConnect={connectThisMachine}
                  />
                )}
              </div>
            </section>
          )}

          {showLocalSetup && mode !== "local" && (
            <button
              type="button"
              className="btn ghost onboard-advanced-toggle"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              {advancedOpen ? "Hide Advanced Setup" : "Set Up Another Machine or Customize"}
            </button>
          )}

          {mode === "local" && !showLocalSetup && (
            <p className="form-error" role="alert">
              {error ?? "Wollipog could not access its managed local runner. Close this dialog and try again."}
            </p>
          )}

          {mode !== "local" && (!showLocalSetup || advancedOpen) && <>
          <p className="muted">
            A <strong>runner</strong> runs on any machine that owns a repo and toolchain — this box, a WSL distro, a Linux
            server, a Mac. It connects <em>out</em> to this control plane, so there's nothing to expose inbound on the runner.
          </p>

          <ol className="onboard-steps">
            <li>
              <div className="step-head">Prerequisites on That Machine</div>
              <ul className="tick">
                <li>Node.js ≥ 22 and <code>pnpm</code></li>
                <li>This repo cloned, with <code>pnpm install</code> run</li>
                <li>The agents you want — Claude Code Native or Codex App Server — installed and signed in</li>
              </ul>
            </li>

            <li>
              <div className="step-head">Where Does the Runner Connect From?</div>
              <div className="seg" role="radiogroup" aria-label="Runner Connection Host">
                {hostOptions.map((h) => (
                  <button
                    key={h}
                    type="button"
                    role="radio"
                    aria-checked={host === h}
                    className={`seg-btn ${host === h ? "active" : ""}`}
                    onClick={() => setHost(h)}
                  >
                    {h === "127.0.0.1" ? "This Machine" : h}
                  </button>
                ))}
              </div>
              {isRemote && (
                <p className="hint warn">
                  Remote machine selected. Start the control plane with <code>CONTROL_PLANE_HOST=0.0.0.0</code> and make sure
                  port <code>{info.port}</code> is reachable through the firewall.
                </p>
              )}
            </li>

            <li>
              <div className="step-head">Name It and Point It at a Repo</div>
              <div className="field-row">
                <label className="field">
                  <span>Runner ID</span>
                  <input
                    value={runnerId}
                    readOnly={repairingExisting}
                    aria-describedby={repairingExisting ? "repair-runner-id-help" : undefined}
                    onChange={(e) => { setRunnerId(e.target.value); setSecret(null); }}
                  />
                </label>
                <label className="field">
                  <span>Workspace ID</span>
                  <input value={wsId} onChange={(e) => setWsId(e.target.value)} />
                </label>
              </div>
              {repairingExisting && (
                <p className="hint" id="repair-runner-id-help">
                  This keeps the existing connection identity and replaces only its credential.
                </p>
              )}
              <label className="field">
                <span>Workspace Path (on That Machine)</span>
                <input value={wsPath} onChange={(e) => setWsPath(e.target.value)} />
              </label>
            </li>

            <li>
              <div className="step-head">
                {repairingExisting ? "Generate a Replacement One-Time Credential" : "Generate This Runner's One-Time Credential"}
              </div>
              <p className="hint warn">
                The credential is bound to <code>{runnerId.trim() || "the chosen runner ID"}</code> and is shown once.
                Changing the ID requires a new credential.
              </p>
              <button className="btn primary" type="button" onClick={() => void generateCredential()} disabled={generating || !runnerId.trim()}>
                {generating ? "Generating…" : repairingExisting ? "Generate Replacement Credential" : "Generate Credential"}
              </button>
              {error && <p className="form-error" role="alert">{error}</p>}
              {credentialMatches && secret && (
                <>
                  <div className="step-head">
                    Save As <code>{RUNNER_TOKEN_FILE}</code> <CopyButton text={secret.token} />
                  </div>
                  <p className="hint warn">
                    Copy this value now, then restrict the file to the runner's operating-system account. It cannot be retrieved later.
                  </p>
                  <pre className="code-block">{secret.token}</pre>
                </>
              )}
            </li>

            {credentialMatches && <>
            <li>
              <div className="step-head">
                Save As <code>runner.config.json</code> <CopyButton text={config} />
              </div>
              <pre className="code-block">{config}</pre>
            </li>

            <li>
              <div className="step-head">
                Start the Runner <CopyButton text={RUNNER_START_COMMAND} />
              </div>
              <pre className="code-block">{RUNNER_START_COMMAND}</pre>
              <p className="hint">It should appear in this list within a second or two.</p>
            </li>
            </>}
            <li>
              <div className="step-head">Verify Runner Health</div>
              <p className="hint">This checklist updates live while the dialog is open.</p>
              <OnboardingHealthChecklist health={health} />
            </li>
          </ol>
          </>}
        </div>
      )}
    </Modal>
  );
}
