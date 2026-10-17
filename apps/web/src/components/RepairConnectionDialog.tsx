import React, { useEffect, useRef, useState } from "react";
import type { RunnerCredentialSecret } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { buildRunnerStartCommand, onboardingHealth, RUNNER_TOKEN_FILE } from "../onboarding.js";
import { runnerDisplay } from "../runners.js";
import { useStoreSelector } from "../store.js";
import { Modal } from "./Modal.js";
import {
  CodeWell,
  ConnectionCheck,
  CredentialError,
  CredentialTokenField,
  RunnerSetupFooter,
  type RunnerSetupStage,
} from "./RunnerSetupParts.js";
import { Steps } from "./Steps.js";
import { BusyButton } from "./ui/BusyButton.js";

/**
 * Repair Connection (#2992): replace an existing runner's credential and restart it. The runner is a
 * fact here, not an input, so there is no host, workspace or prerequisite to choose. The Connection
 * Check confirms the runner reconnects with the workspaces it already knew, and Done turns on when
 * it is back online.
 */
export function RepairConnectionDialog({ runnerId, onClose }: { runnerId: string; onClose: () => void }) {
  const api = useApi();
  const runner = useStoreSelector((state) => state.runners.get(runnerId));
  const name = runnerDisplay(runner, undefined, runnerId).name;
  // The workspaces the runner advertised before it went offline: the ones it should come back with.
  const [knownWorkspaceIds] = useState(() => runner?.workspaces.map((workspace) => workspace.id) ?? []);
  const [secret, setSecret] = useState<RunnerCredentialSecret | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const health = onboardingHealth({
    credentialAvailable: secret !== null,
    // The checks name the machine as the description does; the store lookup above uses the id.
    runnerId: name,
    workspaceIds: knownWorkspaceIds,
    runner,
    repair: true,
  });
  const stage: RunnerSetupStage = runner?.status === "online" ? "connected" : secret ? "waiting" : "before";

  const generateCredential = async () => {
    setGenerating(true);
    setError(null);
    try {
      let issued: RunnerCredentialSecret;
      try {
        issued = await api.issueRunnerCredential(runnerId, "Connection repair");
      } catch (issueError) {
        // A runner that still has an active credential is rotated instead, which revokes the old one.
        if (!/rotate it instead/i.test((issueError as Error).message)) throw issueError;
        issued = await api.rotateRunnerCredential(runnerId, "Connection repair");
      }
      if (mounted.current) setSecret(issued);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setGenerating(false);
    }
  };

  return (
    <Modal
      title="Repair Connection"
      description={name}
      onClose={onClose}
      phoneSheet="full"
      footer={<RunnerSetupFooter stage={stage} beforeNote="Done turns on when the runner reconnects." onClose={onClose} />}
    >
      <div className="runner-setup">
        <Steps className="runner-setup-steps">
          <li>
            <h3>Replace the Credential</h3>
            <p>The new credential replaces the one {name} has now. Its name, workspaces and settings stay the same.</p>
            {!secret && (
              <BusyButton
                className="btn"
                busy={generating}
                progress="Generating a replacement credential…"
                onClick={() => void generateCredential()}
              >
                Generate Replacement Credential
              </BusyButton>
            )}
            {error && <CredentialError message={error} />}
            {secret && <CredentialTokenField token={secret.token} file={RUNNER_TOKEN_FILE} />}
          </li>
          <li>
            <h3>Restart the Runner</h3>
            <p>Save the token over the old one, then restart the runner with its existing config.</p>
            <CodeWell value={buildRunnerStartCommand()} name="Start Command" />
          </li>
        </Steps>
        <ConnectionCheck health={health} />
      </div>
    </Modal>
  );
}
