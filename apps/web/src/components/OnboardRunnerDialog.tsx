import React, { useCallback, useEffect, useRef, useState } from "react";
import type { OnboardingInfo } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { localRunnerReadiness, type LocalRunnerReadiness } from "../onboarding.js";
import {
  connectLocalRunner,
  readLocalRunnerStatus,
  selectLocalRunnerId,
  type LocalRunnerStatus,
} from "../local-runner.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { Modal, Spinner } from "./common.js";
import { OnboardingRecommendedSkills, SetupLoadFailure } from "./RunnerSetupParts.js";

/**
 * The local runner's status mark: one decorative glyph, or a spinner while it is still starting.
 * The section's heading and text carry the status, which is why the contrast test holds the glyph
 * to the 3:1 bar for graphics rather than the 4.5:1 bar for text.
 */
export function LocalReadinessIcon({ state }: { state: LocalRunnerReadiness["state"] }) {
  return (
    <div className="onboard-local-icon" aria-hidden="true">
      {state === "ready" ? "✓" : state === "needs-attention" ? "!" : <Spinner />}
    </div>
  );
}

/**
 * Set Up This Machine: connects the desktop app's bundled runner with no terminal or config file.
 * Install Manually and Repair Connection are their own dialogs (#2992); this one is rebuilt as
 * SetUpThisMachineDialog by #2993.
 */
export function OnboardRunnerDialog({
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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [localStatus, setLocalStatus] = useState<LocalRunnerStatus | null | undefined>(undefined);
  const [localBusy, setLocalBusy] = useState(false);
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
        if (mounted.current) setInfo(i);
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

  const localRunnerId = localStatus && info
    ? selectLocalRunnerId(localStatus, info.existingRunnerIds)
    : localStatus?.runnerId ?? localStatus?.suggestedRunnerId ?? "this-machine";
  const localRunner = runners.get(localRunnerId);
  const localReadiness = localRunnerReadiness(localRunner);
  const showLocalSetup = localStatus?.available === true;
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
    if (!info || !localStatus?.available || autoStarted.current) return;
    autoStarted.current = true;
    void connectThisMachine();
  }, [connectThisMachine, info, localStatus]);

  return (
    <Modal
      title="Set Up This Machine"
      onClose={onClose}
      size="lg"
      footer={<button className="btn primary" onClick={onClose}>Done</button>}
    >
      {!info || localStatus === undefined ? (
        !info && error ? (
          <SetupLoadFailure message={error} retrying={loading} onRetry={load} />
        ) : (
          <Spinner />
        )
      ) : (
        <div className="onboard">
          {showLocalSetup ? (
            <section className={`onboard-local onboard-local-${localReadiness.state}`} aria-live="polite">
              <LocalReadinessIcon state={localReadiness.state} />
              <div className="onboard-local-body">
                <h3>{localBusy ? "Installing the Local Runner" : localTitle}</h3>
                <p>
                  {localBusy
                    ? "Wollipog is creating a private credential and starting its bundled runner."
                    : localDetail}
                </p>
                {localReadiness.agentLabels.length > 0 && (
                  <div className="onboard-local-agents" aria-label="Discovered Coding Agents">
                    {localReadiness.agentLabels.map((label) => <span key={label}>{label}</span>)}
                  </div>
                )}
                {error && <p className="form-error" role="alert">{error}</p>}
              </div>
            </section>
          ) : (
            <p className="form-error" role="alert">
              {error ?? "Wollipog could not access its managed local runner. Close this dialog and try again."}
            </p>
          )}
          <OnboardingRecommendedSkills onOpen={(skillId) => {
            onClose();
            navigate({ name: "skills", id: skillId });
          }} />
        </div>
      )}
    </Modal>
  );
}
