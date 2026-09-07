import { useState } from "react";
import type { RunnerView, SkillInvocationPolicy } from "@wollipog/protocol";
import { driverKindLabel } from "../agent-presentation.js";
import { invocationLabel, skillEligibleAgents, type SkillAgentSelector, type SkillSummary } from "../skills.js";
import { Modal } from "./common.js";
import { Select } from "./ui/ChoiceControls.js";
const ASSIGNABLE_DRIVERS = ["claude-code", "codex", "codex-app-server"] as const;

export function AddAssignmentDialog({ skill, runners, machineLabels, busy, error, onClose, onCreate }: {
  skill: SkillSummary;
  runners: RunnerView[];
  machineLabels: Map<string, string>;
  busy: boolean;
  error?: string | null;
  onClose: () => void;
  onCreate: (input: {
    scopeKind: "instance" | "runner";
    runnerId?: string;
    agentSelector: SkillAgentSelector;
    invocation: SkillInvocationPolicy;
  }) => Promise<void>;
}) {
  const [machineChoice, setMachineChoice] = useState("all");
  const [agentChoice, setAgentChoice] = useState("all");
  const [invocation, setInvocation] = useState<SkillInvocationPolicy>("agent");
  const runnerId = machineChoice === "all" ? "" : machineChoice;
  const selectedRunner = runners.find((runner) => runner.runnerId === runnerId);
  const eligibleAgents = selectedRunner ? skillEligibleAgents(selectedRunner.agents) : [];

  const submit = async () => {
    const agentSelector: SkillAgentSelector = agentChoice === "all"
      ? { kind: "all" }
      : agentChoice.startsWith("driver:")
        ? { kind: "driver", driver: agentChoice.slice("driver:".length) }
        : { kind: "agent", agentId: agentChoice.slice("agent:".length) };
    await onCreate({
      scopeKind: runnerId ? "runner" : "instance",
      ...(runnerId ? { runnerId } : {}),
      agentSelector,
      invocation,
    });
  };

  return (
    <Modal title="Add Assignment" onClose={onClose} footer={
      <>
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
          {busy ? "Adding…" : "Add Assignment"}
        </button>
      </>
    }>
      <div className="form">
        {error && <p role="alert" className="form-error">{error}</p>}
        <p className="skills-hint">Deploy “{skill.name}” to the machines and agents selected below.</p>
        <div className="field">
          <span>Machine</span>
          <Select
            label="Machine"
            value={machineChoice}
            options={[
              { value: "all", label: "All Machines" },
              ...runners.map((runner) => ({
                value: runner.runnerId,
                label: machineLabels.get(runner.runnerId) ?? runner.runnerId,
              })),
            ]}
            onChange={(value) => { setMachineChoice(value); setAgentChoice("all"); }}
          />
        </div>
        <div className="field">
          <span>Agents</span>
          <Select
            label="Agents"
            value={agentChoice}
            options={[
              { value: "all", label: "All Agents" },
              ...ASSIGNABLE_DRIVERS.map((driver) => ({
                value: `driver:${driver}`,
                label: driverKindLabel(driver),
              })),
              ...eligibleAgents.map((agent) => ({ value: `agent:${agent.id}`, label: agent.name })),
            ]}
            onChange={setAgentChoice}
          />
        </div>
        <div className="field">
          <span>Invocation</span>
          <Select<SkillInvocationPolicy>
            label="Invocation"
            value={invocation}
            options={[
              { value: "agent", label: invocationLabel("agent") },
              { value: "manual", label: invocationLabel("manual") },
            ]}
            onChange={setInvocation}
          />
        </div>
        <p className="skills-hint">
          Manual Only deploys the skill with model invocation disabled, so only a person can run it.
        </p>
      </div>
    </Modal>
  );
}
