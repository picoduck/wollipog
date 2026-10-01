import { useState } from "react";
import { runnerSupportsProtocol, type RunnerView, type SkillInvocationPolicy } from "@wollipog/protocol";
import {
  SKILL_AGENT_TYPES,
  agentTypeLabel,
  agentsReachedBySelector,
  invocationLabel,
  skillEligibleAgents,
  supportsManualOnly,
  type SkillAgentSelector,
} from "../skills.js";
import { Modal } from "./common.js";
import { FieldWarning } from "./FieldWarning.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { SegmentedControl, Select, type SelectOption } from "./ui/ChoiceControls.js";

export interface AddAssignmentInput {
  scopeKind: "instance" | "runner";
  runnerId?: string;
  agentSelector: SkillAgentSelector;
  invocation: SkillInvocationPolicy;
}

/** What the rule deploys: one skill, or every skill in a group, now and later. */
export type AddAssignmentVariant = { variant: "skill" } | { variant: "group"; groupName: string };

export type AddAssignmentDialogProps = AddAssignmentVariant & {
  runners: RunnerView[];
  machineLabels: Map<string, string>;
  busy: boolean;
  /** The last create request's failure, shown above the footer. */
  error?: string | null;
  onClose: () => void;
  onCreate: (input: AddAssignmentInput) => Promise<void>;
};

/** "A", "A and B", "A, B and C". */
function listSentence(names: string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function selectorFromChoice(choice: string): SkillAgentSelector {
  if (choice.startsWith("driver:")) return { kind: "driver", driver: choice.slice("driver:".length) };
  if (choice.startsWith("agent:")) return { kind: "agent", agentId: choice.slice("agent:".length) };
  return { kind: "all" };
}

export const INVOCATION_HELP: Record<SkillInvocationPolicy, string> = {
  agent: "Agents use the skill on their own whenever a task calls for it.",
  manual: "Only a person can start the skill, and only Claude Code agents support it.",
};

/** Why some agents the rule reaches will report Manual Only as unsupported, or null. */
function manualOnlyWarning(selector: SkillAgentSelector, machineAgents: ReturnType<typeof skillEligibleAgents> | null): string | null {
  if (machineAgents) {
    const names = agentsReachedBySelector(machineAgents, selector)
      .filter((agent) => !supportsManualOnly(agent.driver))
      .map((agent) => agent.name);
    if (!names.length) return null;
    return `${listSentence(names)} can't run manual-only skills, so this assignment will show ${names.length === 1 ? "it" : "them"} as unsupported.`;
  }
  if (selector.kind === "driver" && !supportsManualOnly(selector.driver)) {
    return `${agentTypeLabel(selector.driver)} agents can't run manual-only skills, so this assignment will show them as unsupported.`;
  }
  return null;
}

/**
 * Add Assignment (docs/design-system.md §7, §8.3, §10.2): which machines and agents a skill — or,
 * from Manage Groups, every skill in a group — is deployed to, and whether agents may invoke it.
 */
export function AddAssignmentDialog(props: AddAssignmentDialogProps) {
  const { runners, machineLabels, busy, error, onClose, onCreate } = props;
  const [machineChoice, setMachineChoice] = useState("all");
  const [agentChoice, setAgentChoice] = useState("all");
  const [invocation, setInvocation] = useState<SkillInvocationPolicy>("agent");
  const runnerId = machineChoice === "all" ? "" : machineChoice;
  const eligibleOn = (runner: RunnerView) => skillEligibleAgents(runner.agents,
    runner.os === "windows" && runnerSupportsProtocol(runner.protocolVersion, "wslMachineSkills"));
  const selectedRunner = runners.find((runner) => runner.runnerId === runnerId);
  const eligibleAgents = selectedRunner ? eligibleOn(selectedRunner) : [];
  const selector = selectorFromChoice(agentChoice);
  // Known before Manual Only is chosen, so the option can announce it; shown once it is.
  const manualWarning = manualOnlyWarning(selector, selectedRunner ? eligibleAgents : null);
  const warning = invocation === "manual" ? manualWarning : null;

  const machineOptions: SelectOption<string>[] = [
    { value: "all", label: "All Machines", description: "Every machine, including ones connected later" },
    ...runners.map((runner) => {
      const count = eligibleOn(runner).length;
      const agents = count === 0 ? "No agents can use skills" : `${count} agent${count === 1 ? "" : "s"} can use skills`;
      return {
        value: runner.runnerId,
        label: machineLabels.get(runner.runnerId) ?? runner.runnerId,
        description: runner.status === "online" ? agents : `Offline · ${agents}`,
      };
    }),
  ];
  const agentOptions: SelectOption<string>[] = [
    {
      value: "all",
      label: "All Agents",
      description: selectedRunner ? "Every agent on this machine that can use skills" : "Every agent that can use skills",
    },
    ...SKILL_AGENT_TYPES.map((driver) => ({
      value: `driver:${driver}`,
      label: agentTypeLabel(driver),
      description: selectedRunner ? "Any agent of this type on this machine" : "On any machine",
      group: "Agent Types",
    })),
    ...eligibleAgents.map((agent) => ({
      value: `agent:${agent.id}`,
      label: agent.name,
      description: agentTypeLabel(agent.driver ?? ""),
      group: "On This Machine",
    })),
  ];

  const submit = async () => {
    await onCreate({
      scopeKind: runnerId ? "runner" : "instance",
      ...(runnerId ? { runnerId } : {}),
      agentSelector: selector,
      invocation,
    });
  };

  const group = props.variant === "group";
  return (
    <Modal
      title={group ? "Add Group Assignment" : "Add Assignment"}
      description={group ? `Every skill in ${props.groupName}, now and later, is deployed here.` : "Choose where this skill is deployed."}
      onClose={onClose}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <BusyButton className="btn primary" busy={busy} progress="Adding the assignment…" onClick={() => void submit()}>
          Add Assignment
        </BusyButton>
      </>}
    >
      <div className="form">
        <div className="field">
          <div className="field-head"><span>Machine</span></div>
          <Select
            label="Machine"
            value={machineChoice}
            options={machineOptions}
            onChange={(value) => { setMachineChoice(value); setAgentChoice("all"); }}
          />
        </div>
        <div className="field">
          <div className="field-head"><span>Agents</span></div>
          <Select label="Agents" value={agentChoice} options={agentOptions} onChange={setAgentChoice} />
        </div>
        <div className="field">
          <div className="field-head"><span>Invocation</span></div>
          <SegmentedControl<SkillInvocationPolicy>
            className="block"
            label="Invocation"
            value={invocation}
            options={(["agent", "manual"] as const).map((value) => ({
              value,
              label: invocationLabel(value),
              // Announced with the option, since the helper below is not attached to the group.
              description: [INVOCATION_HELP[value], value === "manual" ? manualWarning : null].filter(Boolean).join(" "),
            }))}
            onChange={setInvocation}
          />
          <p className="field-helper">{INVOCATION_HELP[invocation]}</p>
          {warning && <FieldWarning>{warning}</FieldWarning>}
        </div>
        {error && <Notice tone="danger" role="alert" title="Couldn't Add the Assignment">{error}</Notice>}
      </div>
    </Modal>
  );
}
