import {
  MAX_LIVE_CHILD_LIMIT,
  WORKFLOW_DECISION_CATEGORIES,
  agentHarnessIdentityKey,
  exactAgentHarnessIdentityKey,
  runnerSupportsProtocol,
  type AgentDriverKind,
  type CampaignControlMode,
  type DelegatableWorkflowDecisionCategory,
  type OrchestratorDefaults,
  type OrchestratorSettingsView,
  type ParentControlMode,
} from "@wollipog/protocol";
import { agentHarnessMachinesDescription, agentHarnessOptionLabel } from "./agent-presentation.js";
import { SKILLS_UNAVAILABLE_ON_TARGET } from "./components/SkillsUnavailableNotice.js";
import { titleCaseLabel } from "./format.js";
import {
  INTEGRATION_ISOLATION_CONTROL_PLANE_REQUIRED,
  INTEGRATION_ISOLATION_PRESERVED,
  ORCHESTRATOR_PRESET_INTEGRATION_DISCLOSURE,
  controlPlaneSupportsIntegrationIsolation,
  integrationIsolationDisclosure,
} from "./session-preset-defaults.js";

/**
 * An Orchestrator's policy for one new session (#2955): what New Session's summary row states, what
 * the Orchestrator Policy dialog edits, and what the create request overrides. One evaluation serves
 * both, so the dialog's rows, the summary and Create Session can never disagree about whether the
 * policy can launch.
 */

export const AUTOMATIC_ORCHESTRATOR_VALUE = "__automatic__";

export const ORCHESTRATOR_DECISION_LABELS: Record<DelegatableWorkflowDecisionCategory, string> = {
  implementation_question: "Implementation Questions",
  pr_merge: "PR Merge Approval",
  merged_branch_deletion: "Merged Branch Deletion",
  follow_up_issue_publication: "Follow-Up Issue Publication",
  ui_evidence_approval: "UI Evidence Approval",
  review_round_extension: "Review Round Extensions",
};

/*
 * The options Settings › Orchestrator offers, shared so the Orchestrator Policy dialog offers the
 * same choices in the same words (#2955).
 *
 * Descendant Requests is a listbox rather than pills, by SettingsRows' own split: these options each
 * need a sentence to choose between, and "Questions and Approvals" is no short label. As three equal
 * pills in the old 260px value column they were 83px each, so that label drew over its neighbour at
 * every width (#2413).
 */
export const PARENT_CONTROL_OPTIONS: ReadonlyArray<{ value: ParentControlMode; label: string; description: string }> = [
  { value: "off", label: "Human", description: "Keep descendant questions and ordinary approvals human-owned." },
  { value: "questions", label: "Questions", description: "Delegate non-secret descendant implementation questions." },
  { value: "questions_and_approvals", label: "Questions and Approvals", description: "Also delegate eligible one-time approvals." },
];

/**
 * Follow-Ups, as a Select for the same reason: in the 240px control column two equal pills are
 * 116px each, and "Execute Approved" measured 118.5px in the widest verified face, so it drew past
 * its pill at 900px and wider (#3019's check). Session Role Settings offers the same choice as a
 * Select.
 */
export const FOLLOW_UP_OPTIONS: ReadonlyArray<{ value: OrchestratorDefaults["behavior"]["followUps"]; label: string; description: string }> = [
  { value: "recommend_only", label: "Recommend Only", description: "Report justified follow-ups and wait for approval." },
  { value: "execute_approved", label: "Execute Approved", description: "Continue with follow-ups after their required approval." },
];

export const COMPLETION_OPTIONS: ReadonlyArray<{ value: OrchestratorDefaults["behavior"]["completion"]; label: string; description: string }> = [
  { value: "retain", label: "Retain", description: "Leave verified finished child sessions available for inspection." },
  { value: "stop_and_archive", label: "Stop and Archive", description: "Stop and archive children only after verified completion." },
];

/*
 * Off | On rather than a switch: this is a draft that saves from the save bar or Apply Policy, and a
 * switch means "applies now" (§8.4, §8.6).
 *
 * Both policies bound the Orchestrator session itself, not its children: the control plane attaches
 * them to the Orchestrator's launch only, and children keep their own permissions and integrations.
 * The sentences say so rather than promising a boundary children do not have.
 */
export const STRICT_ISOLATION_OPTIONS = [
  { value: "off", label: "Off", description: "The Orchestrator uses its agent's own permissions and governance." },
  { value: "on", label: "On", description: "The Orchestrator can't write to the project. Needs a supported sandbox." },
] as const;
export const INTEGRATION_ISOLATION_OPTIONS = [
  { value: "off", label: "Off", description: "The Orchestrator loads the same integrations as any other session." },
  { value: "on", label: "On", description: "The Orchestrator gets Wollipog's management tools and no other integration." },
] as const;

/** Full Control's one line wherever it is chosen (#2940): it adds nothing to fill in. */
export const FULL_CONTROL_LINE = "The Orchestrator runs this campaign end to end.";
export const CONTROL_MODE_OPTIONS: ReadonlyArray<{ value: CampaignControlMode; label: string; description: string }> = [
  { value: "custom", label: "Custom", description: "Choose who decides at each gate below." },
  { value: "full_control", label: "Full Control", description: FULL_CONTROL_LINE },
];

/** The line every Decisions surface ends with: what delegation can never reach. */
export const HUMAN_ONLY_DECISIONS = "Secrets, sign-in, permission grants, governance changes, budgets and guardrails always stay with you.";

export function cloneOrchestratorDefaults(defaults: OrchestratorDefaults): OrchestratorDefaults {
  return {
    ...(defaults.controlMode === undefined ? {} : { controlMode: defaults.controlMode }),
    ...(defaults.campaignBudget === undefined ? {} : { campaignBudget: defaults.campaignBudget }),
    behavior: { ...defaults.behavior },
    delegation: { ...defaults.delegation, decisions: { ...defaults.delegation.decisions } },
    execution: { ...defaults.execution },
  };
}

/** The policy one new session launches with: the saved defaults and this session's changes to them. */
export interface OrchestratorPolicyDraft {
  values: OrchestratorDefaults;
  /** Custom or Full Control for this launch. It is never sent as policy; it chooses the launch flow. */
  controlMode: CampaignControlMode;
  /** Maximum Concurrent Children as typed, so a person can clear the field while typing. */
  limitText: string;
}

export function policyDraftFromDefaults(defaults: OrchestratorDefaults): OrchestratorPolicyDraft {
  const values = cloneOrchestratorDefaults(defaults);
  return {
    values,
    controlMode: defaults.controlMode ?? "custom",
    limitText: String(values.behavior.maximumConcurrentChildren),
  };
}

/** Every field a session can override, by the path the create request's sources use. */
export type OrchestratorPolicyPath =
  | `behavior.${keyof OrchestratorDefaults["behavior"]}`
  | "delegation.parentControl"
  | `delegation.decisions.${DelegatableWorkflowDecisionCategory}`
  | `execution.${keyof OrchestratorDefaults["execution"]}`;

export type OrchestratorPolicyTab = "behavior" | "permissions" | "decisions";

function harnessKey(harness: OrchestratorDefaults["behavior"]["childHarness"]): string | null {
  return harness ? exactAgentHarnessIdentityKey(harness) : null;
}

/**
 * The fields this session overrides: exactly the ones whose value differs from the saved defaults.
 * An untouched field, or one put back to its default, is not sent, so it keeps the provenance of
 * the default it came from.
 */
export function policyOverrides(draft: OrchestratorPolicyDraft, defaults: OrchestratorDefaults): Set<OrchestratorPolicyPath> {
  const overrides = new Set<OrchestratorPolicyPath>();
  const { behavior, delegation, execution } = draft.values;
  if (harnessKey(behavior.childHarness) !== harnessKey(defaults.behavior.childHarness)) overrides.add("behavior.childHarness");
  if (behavior.childModel !== defaults.behavior.childModel) overrides.add("behavior.childModel");
  if (behavior.childEffort !== defaults.behavior.childEffort) overrides.add("behavior.childEffort");
  // An unreadable entry is a change too: it can never equal the default, and it blocks the launch.
  if (draft.limitText.trim() !== String(defaults.behavior.maximumConcurrentChildren)) {
    const limit = Number(draft.limitText);
    if (draft.limitText.trim() === "" || limit !== defaults.behavior.maximumConcurrentChildren) {
      overrides.add("behavior.maximumConcurrentChildren");
    }
  }
  if (behavior.followUps !== defaults.behavior.followUps) overrides.add("behavior.followUps");
  if (behavior.completion !== defaults.behavior.completion) overrides.add("behavior.completion");
  if (delegation.parentControl !== defaults.delegation.parentControl) overrides.add("delegation.parentControl");
  for (const category of WORKFLOW_DECISION_CATEGORIES) {
    if (delegation.decisions[category] !== defaults.delegation.decisions[category]) {
      overrides.add(`delegation.decisions.${category}`);
    }
  }
  if (execution.strictProjectIsolation !== defaults.execution.strictProjectIsolation) overrides.add("execution.strictProjectIsolation");
  if (execution.integrationIsolation !== defaults.execution.integrationIsolation) overrides.add("execution.integrationIsolation");
  return overrides;
}

/** The value one field takes from the saved defaults, as `resetField` puts it back. */
export function resetField(draft: OrchestratorPolicyDraft, defaults: OrchestratorDefaults, path: OrchestratorPolicyPath | "controlMode"): OrchestratorPolicyDraft {
  if (path === "controlMode") return { ...draft, controlMode: defaults.controlMode ?? "custom" };
  if (path === "behavior.maximumConcurrentChildren") {
    return {
      ...draft,
      limitText: String(defaults.behavior.maximumConcurrentChildren),
      values: { ...draft.values, behavior: { ...draft.values.behavior, maximumConcurrentChildren: defaults.behavior.maximumConcurrentChildren } },
    };
  }
  const [group, key, category] = path.split(".") as ["behavior" | "delegation" | "execution", string, string | undefined];
  const values = cloneOrchestratorDefaults(draft.values);
  if (group === "behavior") {
    (values.behavior as unknown as Record<string, unknown>)[key] = defaults.behavior[key as keyof OrchestratorDefaults["behavior"]];
  } else if (group === "execution") {
    (values.execution as unknown as Record<string, unknown>)[key] = defaults.execution[key as keyof OrchestratorDefaults["execution"]];
  } else if (category) {
    values.delegation.decisions[category as DelegatableWorkflowDecisionCategory] =
      defaults.delegation.decisions[category as DelegatableWorkflowDecisionCategory];
  } else {
    values.delegation.parentControl = defaults.delegation.parentControl;
  }
  return { ...draft, values };
}

/**
 * Where the session's Orchestrator would run, and what that machine and agent can do. New Session
 * derives it from the chosen location and agent; nothing in it depends on the policy draft.
 */
export interface OrchestratorPolicyContext {
  view: OrchestratorSettingsView;
  /** The chosen machine, by the name people see. */
  machine: string;
  runnerProtocolVersion: number | null | undefined;
  driver: AgentDriverKind | undefined;
  hostExecutionTarget: boolean;
  /** The installation advertises the coupled Orchestrator preset (which Strict Project Isolation needs). */
  agentOffersOrchestratorPreset: boolean;
  /** The preset can enforce the read-only project boundary on this machine and agent. */
  strictProjectBoundaryAvailable: boolean;
  /** A non-strict Orchestrator can launch here at all (the runner and agent support it). */
  providerExecutionAvailable: boolean;
  /** Why the coupled preset sets this Orchestrator's permissions under `strict`, or undefined when it doesn't. */
  presetReason: (strictProjectIsolation: boolean) => string | undefined;
}

export interface PolicyOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  disabledReason?: string;
}

/** A field's problem, in the words of §8.5: what is wrong and how to fix it. */
export interface PolicyProblem {
  tab: OrchestratorPolicyTab;
  path: OrchestratorPolicyPath;
  message: string;
}

export interface OrchestratorPolicyEvaluation {
  harness: { options: PolicyOption[]; value: string; disabled: boolean; disabledReason?: string };
  model: { options: PolicyOption[]; value: string };
  effort: { options: PolicyOption[]; value: string };
  limit: { value: number; min: number; valid: boolean; description: string; error: string };
  parentControl: { value: ParentControlMode; options: PolicyOption[] };
  decision: (category: DelegatableWorkflowDecisionCategory) => "human" | "orchestrator";
  decisionDisabledReason?: string;
  /** The coupled preset sets this Orchestrator's permissions, with the sentence that says why. */
  presetReason: string | undefined;
  integration: {
    /** Strict Project Isolation or the preset already launches without integrations. */
    implied: boolean;
    /** What the session launches with, implied or chosen. */
    effective: boolean;
    controlPlaneSupported: boolean;
    /** Why the row can't be changed: implied, or Wollipog too old to know the policy. */
    lockedReason?: string;
    /** The full explanation, for About Integration Isolation. */
    about: string;
  };
  /** Every problem, in the order Create Session reports them. */
  problems: PolicyProblem[];
  /** The fields that differ from the saved defaults and would be sent. */
  overrides: ReadonlySet<OrchestratorPolicyPath>;
  /** A row shows Changed: its value differs from the defaults and the launch would carry it. */
  changed: (path: OrchestratorPolicyPath | "controlMode") => boolean;
  changeCounts: Record<OrchestratorPolicyTab, number> & { total: number };
  /** Workflow gates the Orchestrator decides. */
  delegatedCount: number;
}

const PATH_TAB = (path: OrchestratorPolicyPath | "controlMode"): OrchestratorPolicyTab =>
  path.startsWith("behavior.") ? "behavior" : path.startsWith("execution.") ? "permissions" : "decisions";

/** Maximum Concurrent Children's floor: under Full Control it is also the campaign's concurrency, which must be at least 1. */
export function minimumChildLimit(controlMode: CampaignControlMode): number {
  return controlMode === "full_control" ? 1 : 0;
}

export function childLimitError(min: number): string {
  return `Enter a whole number from ${min} to ${MAX_LIVE_CHILD_LIMIT}.`;
}

export function childLimitValid(limitText: string, min: number): boolean {
  const limit = Number(limitText);
  return limitText.trim() !== "" && Number.isSafeInteger(limit) && limit >= min && limit <= MAX_LIVE_CHILD_LIMIT;
}

export function evaluateOrchestratorPolicy(context: OrchestratorPolicyContext, draft: OrchestratorPolicyDraft): OrchestratorPolicyEvaluation {
  const { view, machine, runnerProtocolVersion: protocol } = context;
  const { behavior, delegation, execution } = draft.values;
  const defaults = view.defaults;
  const overrides = policyOverrides(draft, defaults);
  const capabilities = view.capabilities;
  const update = (what: string) => `Update Wollipog on ${machine} to ${what}.`;

  // Delegation. An older runner downgrades an inherited delegation to Human rather than refusing it;
  // a delegation this session chose is refused instead, so nothing it shows is silently dropped.
  const parentControlSupported = runnerSupportsProtocol(protocol, "delegatedParentControl");
  const typedDelegationSupported = runnerSupportsProtocol(protocol, "typedWorkflowDecisionDelegation");
  const parentControlReason = parentControlSupported ? undefined : update("delegate Descendant Requests");
  const decisionReason = typedDelegationSupported ? undefined : update("delegate decisions to the Orchestrator");
  const effectiveParentControl: ParentControlMode = !parentControlSupported && !overrides.has("delegation.parentControl")
    ? "off" : delegation.parentControl;
  const decision = (category: DelegatableWorkflowDecisionCategory): "human" | "orchestrator" =>
    !typedDelegationSupported && !overrides.has(`delegation.decisions.${category}`) ? "human" : delegation.decisions[category];

  // Child Harness, Model and Effort, from what the connected machines advertise.
  const harnessPolicyAvailable = capabilities?.harnesses !== undefined;
  const childHarnessPolicySupported = runnerSupportsProtocol(protocol, "orchestratorChildHarnessPolicy");
  const childHarnesses = capabilities?.harnesses ?? [];
  const fixedChildHarness = behavior.childHarness;
  const fixedChildHarnessCapability = fixedChildHarness
    ? childHarnesses.find((harness) => agentHarnessIdentityKey(harness) === agentHarnessIdentityKey(fixedChildHarness))
    : undefined;
  const candidateChildHarnesses = fixedChildHarness
    ? (fixedChildHarnessCapability ? [fixedChildHarnessCapability] : [])
    : childHarnesses;
  const harnessOptions: PolicyOption[] = [
    {
      value: AUTOMATIC_ORCHESTRATOR_VALUE,
      label: "Automatic",
      description: harnessPolicyAvailable
        ? "Choose a compatible Agent Harness, model, and effort together at child creation."
        : "Update Wollipog to configure a fixed Child Harness.",
    },
    ...childHarnesses.map((harness) => ({
      value: agentHarnessIdentityKey(harness),
      label: harness.installations > 0 ? agentHarnessOptionLabel(harness) : `${agentHarnessOptionLabel(harness)} (Unavailable)`,
      description: harness.installations > 0
        ? agentHarnessMachinesDescription(harness)
        : "No current installation advertises this saved Agent Harness.",
    })),
  ];
  const scopedModels = new Map<string, { displayName: string; harnessNames: Set<string> }>();
  if (harnessPolicyAvailable) {
    for (const harness of candidateChildHarnesses) {
      for (const model of harness.models) {
        const current = scopedModels.get(model.id) ?? { displayName: model.displayName ?? model.id, harnessNames: new Set<string>() };
        current.harnessNames.add(harness.name);
        scopedModels.set(model.id, current);
      }
    }
  } else {
    for (const model of capabilities?.models ?? []) {
      scopedModels.set(model.id, { displayName: model.displayName ?? model.id, harnessNames: new Set() });
    }
  }
  const scopedEfforts = new Set(harnessPolicyAvailable
    ? candidateChildHarnesses.flatMap((harness) => behavior.childModel
      ? harness.supportedPairs.filter((pair) => pair.modelId === behavior.childModel).flatMap((pair) => pair.effortLevels)
      : harness.effortLevels)
    : capabilities?.effortLevels ?? []);
  const fixedHarnessAvailable = !fixedChildHarness || (fixedChildHarnessCapability?.installations ?? 0) > 0;
  const fixedHarnessSupported = !fixedChildHarness || childHarnessPolicySupported;
  const fixedModelAvailable = !behavior.childModel || scopedModels.has(behavior.childModel);
  const fixedEffortAvailable = !behavior.childEffort || scopedEfforts.has(behavior.childEffort);
  const fixedPairAvailable = harnessPolicyAvailable
    ? candidateChildHarnesses.some((harness) => harness.installations > 0 &&
      (behavior.childModel
        ? harness.supportedPairs.some((pair) => pair.modelId === behavior.childModel &&
          (!behavior.childEffort || pair.effortLevels.includes(behavior.childEffort)))
        : behavior.childEffort
          ? harness.effortLevels.includes(behavior.childEffort)
          : true))
    : capabilities?.supportedPairs
      ? behavior.childModel
        ? capabilities.supportedPairs.some((pair) =>
          pair.modelId === behavior.childModel && (!behavior.childEffort || pair.effortLevels.includes(behavior.childEffort)))
        : behavior.childEffort
          ? capabilities.effortLevels.includes(behavior.childEffort)
          : capabilities.installations > 0
      : capabilities?.status === "available";
  const modelOptions: PolicyOption[] = [
    { value: AUTOMATIC_ORCHESTRATOR_VALUE, label: "Automatic", description: "Resolve from live child capabilities." },
    ...(fixedChildHarness || !harnessPolicyAvailable ? [...scopedModels.entries()] : []).map(([modelId, model]) => ({
      value: modelId,
      label: model.displayName,
      description: fixedChildHarness
        ? `Use ${model.displayName} through the selected Child Harness.`
        : model.harnessNames.size > 0
          ? `Resolve through a compatible harness: ${[...model.harnessNames].sort().join(", ")}.`
          : `Use ${model.displayName} for child sessions.`,
    })),
    ...(!fixedChildHarness && harnessPolicyAvailable && behavior.childModel && fixedModelAvailable ? [{
      value: behavior.childModel,
      label: `${scopedModels.get(behavior.childModel)?.displayName ?? behavior.childModel} (Legacy Automatic Harness)`,
      description: "This legacy fixed model retains automatic harness resolution. Choose a fixed Child Harness before selecting a different model.",
    }] : []),
    ...(!fixedModelAvailable && behavior.childModel ? [{
      value: behavior.childModel,
      label: `${behavior.childModel} (Unavailable)`,
      description: "No current child installation advertises this saved model.",
      disabled: true,
      disabledReason: "Choose Automatic or a model advertised by a connected installation.",
    }] : []),
  ];
  const effortOptions: PolicyOption[] = [
    { value: AUTOMATIC_ORCHESTRATOR_VALUE, label: "Automatic", description: "Use the child model's advertised default effort." },
    ...(fixedChildHarness || !harnessPolicyAvailable ? [...scopedEfforts].sort() : []).map((effort) => ({
      value: effort,
      label: titleCaseLabel(effort),
      description: `Use ${titleCaseLabel(effort)} effort for child sessions.`,
    })),
    ...(!fixedChildHarness && harnessPolicyAvailable && behavior.childEffort && fixedEffortAvailable ? [{
      value: behavior.childEffort,
      label: `${titleCaseLabel(behavior.childEffort)} (Legacy Automatic Harness)`,
      description: "This legacy fixed effort retains automatic harness resolution. Choose a fixed Child Harness before selecting a different effort.",
    }] : []),
    ...(!fixedEffortAvailable && behavior.childEffort ? [{
      value: behavior.childEffort,
      label: `${titleCaseLabel(behavior.childEffort)} (Unavailable)`,
      description: "No current child installation advertises this saved effort.",
      disabled: true,
      disabledReason: "Choose Automatic or an effort advertised by a connected installation.",
    }] : []),
  ];

  // Execution permissions.
  const presetReason = context.presetReason(execution.strictProjectIsolation);
  // Strict Project Isolation, and every coupled-preset launch, already launches without provider
  // integrations. The control is then implied rather than independent, and the server stores the
  // same `true`, so showing anything else would advertise a shape the control plane refuses.
  const integrationImplied = execution.strictProjectIsolation || presetReason !== undefined;
  const effectiveIntegration = integrationImplied || execution.integrationIsolation;
  // BOTH peers have to know the policy, and they upgrade independently: a v164 runner can sit behind
  // a v163 control plane, whose override parser rejects `execution.integrationIsolation` outright.
  // The runner's protocol version cannot answer that, so the control plane's own settings payload
  // does — it echoes the field only if it knows it.
  const integrationControlPlane = controlPlaneSupportsIntegrationIsolation(defaults);
  const integrationSupported = integrationImplied ||
    (integrationControlPlane && runnerSupportsProtocol(protocol, "orchestratorIntegrationIsolation"));
  const executionPolicySupported = runnerSupportsProtocol(protocol, "orchestratorExecutionPolicy");
  // The policy differs by harness, so the copy follows the agent this session will actually launch.
  const integrationCopy = integrationIsolationDisclosure(context.driver);
  const skillsNote = context.hostExecutionTarget
    ? ""
    : ` ${SKILLS_UNAVAILABLE_ON_TARGET}`;
  const integrationAbout = integrationImplied
    ? `${execution.strictProjectIsolation ? "Strict Project Isolation" : "The Orchestrator preset"} already launches without provider integrations, so Integration Isolation is implied. ${ORCHESTRATOR_PRESET_INTEGRATION_DISCLOSURE}`
    : !integrationControlPlane
      ? INTEGRATION_ISOLATION_CONTROL_PLANE_REQUIRED
      : effectiveIntegration
        ? `${integrationCopy.removed} ${integrationCopy.kept} ${INTEGRATION_ISOLATION_PRESERVED}${skillsNote}`
        : context.hostExecutionTarget
          ? "Hooks, plugins, extensions, skills, and configured MCP servers load exactly as they would for a normal session with this harness."
          : `Hooks, plugins, extensions, and configured MCP servers load exactly as they would for a normal session with this harness.${skillsNote}`;

  // Maximum Concurrent Children.
  const min = minimumChildLimit(draft.controlMode);
  const limitValid = childLimitValid(draft.limitText, min);
  const limitDescription = min > 0
    ? `Up to ${MAX_LIVE_CHILD_LIMIT}. This is also the campaign's concurrency.`
    : `0 pauses new children. Up to ${MAX_LIVE_CHILD_LIMIT}.`;

  // Problems, in the order Create Session reports them.
  const problems: PolicyProblem[] = [];
  if (fixedChildHarness && !fixedHarnessSupported) {
    problems.push({ tab: "behavior", path: "behavior.childHarness", message: update("choose a fixed Child Harness") });
  } else if (!fixedHarnessAvailable) {
    problems.push({ tab: "behavior", path: "behavior.childHarness", message: "No connected machine offers this Child Harness now. Choose another, or Automatic." });
  } else if (!fixedModelAvailable) {
    problems.push({ tab: "behavior", path: "behavior.childModel", message: "No connected machine offers this Child Model now. Choose another, or Automatic." });
  } else if (!fixedEffortAvailable) {
    problems.push({ tab: "behavior", path: "behavior.childEffort", message: "No connected machine offers this Child Effort now. Choose another, or Automatic." });
  } else if (!fixedPairAvailable) {
    problems.push({ tab: "behavior", path: behavior.childEffort && !behavior.childModel ? "behavior.childEffort" : "behavior.childModel",
      message: capabilities?.reason ?? "Choose a model and effort a connected machine supports, or Automatic." });
  }
  if (effectiveParentControl !== "off" && !parentControlSupported) {
    problems.push({ tab: "decisions", path: "delegation.parentControl", message: `${parentControlReason} To start now, choose Human.` });
  }
  const refusedGate = typedDelegationSupported ? undefined : WORKFLOW_DECISION_CATEGORIES.find((category) => decision(category) === "orchestrator");
  if (refusedGate) {
    problems.push({ tab: "decisions", path: `delegation.decisions.${refusedGate}`, message: `${decisionReason} To start now, choose Human.` });
  }
  if (execution.strictProjectIsolation && !context.strictProjectBoundaryAvailable) {
    problems.push({ tab: "permissions", path: "execution.strictProjectIsolation", message: context.agentOffersOrchestratorPreset
      ? `${machine} can't enforce Strict Project Isolation for this agent. To start now, turn it off.`
      : "This agent can't run with Strict Project Isolation. To start now, turn it off." });
  } else if (!execution.strictProjectIsolation && !executionPolicySupported) {
    problems.push({ tab: "permissions", path: "execution.strictProjectIsolation",
      message: `${update("run an Orchestrator without Strict Project Isolation")} To start now, turn it on.` });
  } else if (!execution.strictProjectIsolation && !context.providerExecutionAvailable) {
    problems.push({ tab: "permissions", path: "execution.strictProjectIsolation",
      message: "This agent can't run an Orchestrator without Strict Project Isolation. Turn it on, or choose another agent." });
  } else if (effectiveIntegration && !integrationSupported) {
    problems.push({ tab: "permissions", path: "execution.integrationIsolation", message: !integrationControlPlane
      ? INTEGRATION_ISOLATION_CONTROL_PLANE_REQUIRED
      : `${update("turn on Integration Isolation")} To start now, turn it off.` });
  }
  if (!limitValid) {
    problems.push({ tab: "behavior", path: "behavior.maximumConcurrentChildren", message: childLimitError(min) });
  }

  const defaultControlMode = defaults.controlMode ?? "custom";
  const changed = (path: OrchestratorPolicyPath | "controlMode") => path === "controlMode"
    ? draft.controlMode !== defaultControlMode
    // An implied Integration Isolation is withheld from the request, so it is not a change either.
    : overrides.has(path) && !(path === "execution.integrationIsolation" && integrationImplied);
  const changeCounts = { behavior: 0, permissions: 0, decisions: 0, total: 0 };
  for (const path of [...overrides, "controlMode" as const]) {
    if (!changed(path)) continue;
    changeCounts[PATH_TAB(path)] += 1;
    changeCounts.total += 1;
  }

  return {
    harness: {
      options: harnessOptions,
      value: fixedChildHarness ? agentHarnessIdentityKey(fixedChildHarness) : AUTOMATIC_ORCHESTRATOR_VALUE,
      disabled: !harnessPolicyAvailable,
      disabledReason: harnessPolicyAvailable ? undefined : "Update Wollipog to choose a fixed Child Harness.",
    },
    model: { options: modelOptions, value: behavior.childModel ?? AUTOMATIC_ORCHESTRATOR_VALUE },
    effort: { options: effortOptions, value: behavior.childEffort ?? AUTOMATIC_ORCHESTRATOR_VALUE },
    limit: { value: Number(draft.limitText), min, valid: limitValid, description: limitDescription, error: childLimitError(min) },
    parentControl: {
      value: effectiveParentControl,
      options: PARENT_CONTROL_OPTIONS.map((option) => option.value === "off" || parentControlSupported
        ? option : { ...option, disabled: true, disabledReason: parentControlReason }),
    },
    decision,
    decisionDisabledReason: decisionReason,
    presetReason,
    integration: {
      implied: integrationImplied,
      effective: effectiveIntegration,
      controlPlaneSupported: integrationControlPlane,
      lockedReason: integrationImplied
        ? `Implied by ${execution.strictProjectIsolation ? "Strict Project Isolation" : "the Orchestrator preset"}, so it can't be turned off.`
        : !integrationControlPlane ? INTEGRATION_ISOLATION_CONTROL_PLANE_REQUIRED : undefined,
      about: integrationAbout,
    },
    problems,
    overrides,
    changed,
    changeCounts,
    delegatedCount: WORKFLOW_DECISION_CATEGORIES.filter((category) => decision(category) === "orchestrator").length,
  };
}

/** A new Child Harness starts its model and effort over at Automatic: they were chosen for another agent. */
export function withChildHarness(draft: OrchestratorPolicyDraft, view: OrchestratorSettingsView, value: string): OrchestratorPolicyDraft {
  const harness = value === AUTOMATIC_ORCHESTRATOR_VALUE
    ? null
    : view.capabilities?.harnesses?.find((candidate) => agentHarnessIdentityKey(candidate) === value);
  const childHarness = harness ? { agentId: harness.agentId, driver: harness.driver, context: harness.context } : null;
  return { ...draft, values: { ...draft.values, behavior: { ...draft.values.behavior, childHarness, childModel: null, childEffort: null } } };
}

/** A new Child Model keeps its effort only where that model supports it. */
export function withChildModel(draft: OrchestratorPolicyDraft, view: OrchestratorSettingsView, value: string): OrchestratorPolicyDraft {
  const behavior = draft.values.behavior;
  const capabilities = view.capabilities;
  const childModel = value === AUTOMATIC_ORCHESTRATOR_VALUE ? null : value;
  const effort = behavior.childEffort;
  const fixed = behavior.childHarness;
  const candidates = capabilities?.harnesses !== undefined
    ? (fixed
      ? capabilities.harnesses.filter((harness) => agentHarnessIdentityKey(harness) === agentHarnessIdentityKey(fixed))
      : capabilities.harnesses)
    : undefined;
  const effortCompatible = !effort || (candidates
    ? candidates.some((harness) => childModel
      ? harness.supportedPairs.some((pair) => pair.modelId === childModel && pair.effortLevels.includes(effort))
      : harness.effortLevels.includes(effort))
    : capabilities?.supportedPairs
      ? childModel
        ? capabilities.supportedPairs.some((pair) => pair.modelId === childModel && pair.effortLevels.includes(effort))
        : capabilities.effortLevels.includes(effort)
      : true);
  return {
    ...draft,
    values: { ...draft.values, behavior: { ...behavior, childModel, childEffort: effortCompatible ? effort : null } },
  };
}

/** What the summary row states (§11.3), in the order it lists them. */
export function policySummaryFacts(draft: OrchestratorPolicyDraft, evaluation: OrchestratorPolicyEvaluation): Array<{ key: string; label: string }> {
  const limit = evaluation.limit.valid ? evaluation.limit.value : null;
  const isolation = draft.values.execution.strictProjectIsolation ? "Strict Project Isolation"
    : evaluation.integration.effective ? "Integration Isolation" : "No Isolation";
  const delegated = evaluation.delegatedCount;
  return [
    { key: "children", label: limit === null ? "Child Limit Needs a Change"
      : limit === 0 ? "New Children Paused" : `Up to ${limit} ${limit === 1 ? "Child" : "Children"}` },
    { key: "follow-ups", label: draft.values.behavior.followUps === "execute_approved" ? "Executes Approved Follow-Ups" : "Recommends Follow-Ups" },
    { key: "completion", label: draft.values.behavior.completion === "stop_and_archive" ? "Archives Finished Children" : "Keeps Finished Children" },
    { key: "isolation", label: isolation },
    { key: "decisions", label: draft.controlMode === "full_control" ? "Full Control"
      : delegated === 0 ? "No Decisions Delegated" : `${delegated} ${delegated === 1 ? "Decision" : "Decisions"} Delegated` },
  ];
}

/** "1 change", "3 changes": the summary's count of what differs from the defaults. */
export function changesLabel(count: number): string {
  return `${count} ${count === 1 ? "change" : "changes"}`;
}
