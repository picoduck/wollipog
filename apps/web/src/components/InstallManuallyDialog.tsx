import React, { useEffect, useId, useRef, useState } from "react";
import type { OnboardingInfo, RunnerCredentialSecret } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import {
  buildRunnerConfigJson,
  buildRunnerStartCommand,
  firstWorkspace,
  onboardingHealth,
  runnerHostLabel,
  RUNNER_TOKEN_FILE,
  suggestRunnerId,
  withHost,
} from "../onboarding.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { Skeleton } from "./common.js";
import { FieldError } from "./FieldError.js";
import { CheckIcon, ChevronRightIcon } from "./Icons.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import {
  CodeWell,
  ConnectionCheck,
  CredentialError,
  CredentialTokenField,
  OnboardingRecommendedSkills,
  RunnerSetupFooter,
  SetupLoadFailure,
  type RunnerSetupStage,
} from "./RunnerSetupParts.js";
import { Steps } from "./Steps.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Select } from "./ui/ChoiceControls.js";

const LOOPBACK = "127.0.0.1";

/**
 * Install Manually (#2992): run the runner yourself on any machine with Node.js. Three steps — name it
 * and choose what it connects to, issue its one-time credential, start it — then a Connection Check
 * that waits for the person until a credential exists and spins only while Wollipog waits on the
 * machine. Done turns on when the runner reports online.
 */
export function InstallManuallyDialog({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const { navigate } = useStoreActions();
  const runners = useStoreSelector((state) => state.runners);
  const ids = useId();
  const [info, setInfo] = useState<OnboardingInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [runnerId, setRunnerId] = useState("runner");
  const [host, setHost] = useState(LOOPBACK);
  const [folder, setFolder] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [secret, setSecret] = useState<RunnerCredentialSecret | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = () => {
    setLoading(true);
    setLoadError(null);
    api.getOnboarding()
      .then((loaded) => {
        if (!mounted.current) return;
        setInfo(loaded);
        setRunnerId(suggestRunnerId(loaded.existingRunnerIds));
      })
      .catch((cause) => { if (mounted.current) setLoadError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (mounted.current) setLoading(false); });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  const name = runnerId.trim();
  const hostOptions = [LOOPBACK, ...(info?.lanIps ?? [])].map((value) => ({ value, label: runnerHostLabel(value) }));
  const remote = host !== LOOPBACK;
  const wsUrl = info ? withHost(info.runnerWsUrl, host) : "";
  const plaintext = remote && wsUrl.startsWith("ws://");
  const startCommand = buildRunnerStartCommand(plaintext);
  const workspace = firstWorkspace(folder, workspaceName);
  // The credential is bound to the name it was issued for; renaming the runner discards it.
  const credential = secret?.credential.runnerId === name ? secret : null;
  const collision = Boolean(info?.existingRunnerIds.includes(name));
  const liveRunner = collision ? undefined : runners.get(name);
  const health = onboardingHealth({
    credentialAvailable: credential !== null,
    runnerId: name,
    workspaceIds: workspace ? [workspace.id] : [],
    runner: liveRunner,
    runnerIdCollision: collision,
  });
  const stage: RunnerSetupStage = !info ? (loadError ? "failed" : "before")
    : !credential ? "before"
      : liveRunner?.status === "online" ? "connected" : "waiting";
  const nameError = !info ? null
    : !name ? "Enter a name for the runner."
      : collision ? `A runner named ${name} already exists. Choose another name.` : null;

  const generateCredential = async () => {
    if (!name || collision) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const issued = await api.issueRunnerCredential(name, "Onboarding credential");
      if (mounted.current) setSecret(issued);
    } catch (cause) {
      if (mounted.current) setGenerateError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setGenerating(false);
    }
  };

  return (
    <Modal
      title="Install Manually"
      description="Run the runner yourself on any machine with Node.js."
      onClose={onClose}
      phoneSheet={stage === "failed" ? "fit" : "full"}
      footer={<RunnerSetupFooter stage={stage} beforeNote="Done turns on when the runner connects." onClose={onClose} />}
    >
      {!info ? (
        loadError
          ? <SetupLoadFailure message={loadError} retrying={loading} onRetry={load} />
          : <Skeleton rows={4} announce="Loading setup details…" />
      ) : (
        <div className="runner-setup">
          <details className="disclosure">
            <summary><ChevronRightIcon className="disclosure-chevron" />What the Machine Needs</summary>
            <ul className="disclosure-body runner-setup-needs">
              <li><CheckIcon size={14} />Node.js 22 or later, and pnpm</li>
              <li><CheckIcon size={14} />A clone of Wollipog with <code>pnpm install</code> run</li>
              <li><CheckIcon size={14} />The coding agents you want, installed and signed in</li>
            </ul>
          </details>

          <Steps className="runner-setup-steps">
            <li>
              <h3>Name and Connect</h3>
              <div className="field-row">
                <div className="field">
                  <div className="field-head"><label htmlFor={`${ids}-name`}>Runner Name</label></div>
                  <input
                    id={`${ids}-name`}
                    value={runnerId}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={nameError ? true : undefined}
                    aria-describedby={`${ids}-name-help`}
                    onChange={(event) => setRunnerId(event.target.value)}
                  />
                  {nameError
                    ? <FieldError id={`${ids}-name-help`}>{nameError}</FieldError>
                    : <p className="field-helper" id={`${ids}-name-help`}>Its credential is tied to this name.</p>}
                </div>
                <div className="field">
                  <div className="field-head"><span>Connects To</span></div>
                  <Select label="Connects To" value={host} options={hostOptions} onChange={setHost} />
                </div>
              </div>
              {remote && (
                <Notice tone="warning" compact>
                  Wollipog must listen on the network with port {info.port} open.
                  {plaintext && " This connection isn't encrypted, so use it only on a trusted network."}
                </Notice>
              )}
              <div className="field-row">
                <div className="field">
                  <div className="field-head"><label htmlFor={`${ids}-folder`}>First Workspace Folder (Optional)</label></div>
                  <input
                    id={`${ids}-folder`}
                    value={folder}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="e.g. /home/me/my-repo"
                    aria-describedby={`${ids}-folder-help`}
                    onChange={(event) => setFolder(event.target.value)}
                  />
                  <p className="field-helper" id={`${ids}-folder-help`}>A folder on that machine. Leave it blank to add workspaces later.</p>
                </div>
                <div className="field">
                  <div className="field-head"><label htmlFor={`${ids}-workspace`}>Workspace Name (Optional)</label></div>
                  <input
                    id={`${ids}-workspace`}
                    value={workspaceName}
                    autoComplete="off"
                    placeholder={workspace ? `e.g. ${workspace.name}` : "e.g. my-repo"}
                    onChange={(event) => setWorkspaceName(event.target.value)}
                  />
                </div>
              </div>
            </li>

            <li>
              <h3>Credential</h3>
              <p>Wollipog issues a one-time credential for {name || "this runner"}.</p>
              {!credential && (
                <BusyButton
                  className="btn"
                  busy={generating}
                  progress="Generating the credential…"
                  disabled={!name || collision}
                  onClick={() => void generateCredential()}
                >
                  Generate Credential
                </BusyButton>
              )}
              {generateError && <CredentialError message={generateError} />}
              {credential && <>
                <CredentialTokenField token={credential.token} file={RUNNER_TOKEN_FILE} />
                <div className="field">
                  <span className="field-label"><code>runner.config.json</code></span>
                  <CodeWell
                    block
                    name="runner.config.json"
                    value={buildRunnerConfigJson({ runnerId: name, runnerWsUrl: wsUrl, workspace })}
                  />
                </div>
              </>}
            </li>

            <li>
              <h3>Start</h3>
              <p>Run this in that copy of Wollipog once both files are saved.</p>
              <CodeWell value={startCommand} name="Start Command" />
            </li>
          </Steps>

          <ConnectionCheck health={health} />
          <OnboardingRecommendedSkills onOpen={(skillId) => {
            onClose();
            navigate({ name: "skills", id: skillId });
          }} />
        </div>
      )}
    </Modal>
  );
}
