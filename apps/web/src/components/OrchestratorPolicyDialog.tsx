import { OrchestratorReviewFields } from "./OrchestratorReviewFields.js";
import { orchestratorReviewPolicyProblem } from "@wollipog/protocol";
import { useId, useState, type ReactNode, type Ref } from "react";
import {
  MAX_LIVE_CHILD_LIMIT,
  WORKFLOW_DECISION_CATEGORIES,
  agentHarnessIdentityKey,
  type DelegatableWorkflowDecisionCategory,
  type OrchestratorDefaults,
} from "@wollipog/protocol";
import { titleCaseLabel } from "../format.js";
import { handleRovingChoiceKeyDown } from "./interactions.js";
import {
  AUTOMATIC_ORCHESTRATOR_VALUE,
  COMPLETION_OPTIONS,
  CONTROL_MODE_OPTIONS,
  FULL_CONTROL_LINE,
  FOLLOW_UP_OPTIONS,
  FULL_CONTROL_FOLLOW_UPS_NOTE,
  HUMAN_ONLY_DECISIONS,
  INTEGRATION_ISOLATION_OPTIONS,
  ORCHESTRATOR_DECISION_LABELS,
  PARENT_CONTROL_OPTIONS,
  STRICT_ISOLATION_OPTIONS,
  changesLabel,
  evaluateOrchestratorPolicy,
  policyDraftFromDefaults,
  policySummaryFacts,
  resetField,
  withChildHarness,
  withChildModel,
  type OrchestratorPolicyContext,
  type OrchestratorPolicyDraft,
  type OrchestratorPolicyEvaluation,
  type OrchestratorPolicyPath,
  type OrchestratorPolicyTab,
} from "../orchestrator-policy.js";
import { FieldError } from "./FieldError.js";
import { ChevronRightIcon, LockIcon } from "./Icons.js";
import { Modal } from "./Modal.js";
import { TabList } from "./Tabs.js";
import { NumberRow, SegmentedRow, SelectRow, SettingRow, SettingsGroup, ValueRow } from "./ui/SettingsRows.js";

const TABS: ReadonlyArray<{ id: OrchestratorPolicyTab; label: string }> = [
  { id: "behavior", label: "Behavior" },
  { id: "permissions", label: "Permissions" },
  { id: "decisions", label: "Decisions" },
];

/**
 * New Session's Orchestrator Policy row (#2955), under Role: what the policy is, as §11.3 meta, how
 * many changes this session makes to the defaults, and Customize…, which opens the dialog. A problem
 * that blocks creation replaces the line about Settings, and Customize… is described by it, so a
 * submit that focuses Customize… announces why.
 */
export function OrchestratorPolicySummary({
  draft,
  evaluation,
  disabled,
  describedBy,
  customizeRef,
  onCustomize,
}: {
  draft: OrchestratorPolicyDraft;
  evaluation: OrchestratorPolicyEvaluation;
  disabled?: boolean;
  /** A submit's error about the policy, beside the row's own problem. */
  describedBy?: string;
  customizeRef: Ref<HTMLButtonElement>;
  onCustomize: () => void;
}) {
  const id = useId();
  const problemId = `${id}-problem`;
  const factsId = `${id}-facts`;
  const problem = evaluation.problems[0];
  const changes = evaluation.changeCounts.total;
  return (
    <SettingRow
      title="Orchestrator Policy"
      className="orchestrator-policy-summary"
      trailing
      description={<>
        <span className="orchestrator-policy-facts" id={factsId}>
          {policySummaryFacts(draft, evaluation).map((fact) => <span key={fact.key}>{fact.label}</span>)}
          {changes > 0 && <span key="changes">{changesLabel(changes)}</span>}
        </span>
        {problem
          ? <FieldError as="span" id={problemId}>{problem.message}</FieldError>
          : <span>From your Orchestrator defaults in Settings.</span>}
        {draft.controlMode === "full_control" && <span>{FULL_CONTROL_LINE}</span>}
      </>}
      control={(
        <button
          ref={customizeRef}
          type="button"
          className="btn"
          data-validation-target="orchestrator-policy"
          aria-haspopup="dialog"
          aria-describedby={[factsId, problem ? problemId : undefined, describedBy].filter(Boolean).join(" ")}
          disabled={disabled}
          onClick={onCustomize}
        >
          Customize…
        </button>
      )}
    />
  );
}

/** "Changed" and the link that puts the row back (#2955): the only mark a draft row carries. */
function ChangedMark({ resetTo, onReset }: { resetTo: string; onReset: () => void }) {
  return (
    <span className="changed-mark">
      <span>Changed</span>
      <button type="button" className="link" onClick={onReset}>{`Reset to ${resetTo}`}</button>
    </span>
  );
}

/** The label a saved default goes by in a row's options, for "Reset to <value>". */
function optionLabel(options: ReadonlyArray<{ value: string; label: string }>, value: string, fallback: string): string {
  return options.find((option) => option.value === value)?.label.replace(/ \((?:Unavailable|Legacy Automatic Harness)\)$/u, "") ?? fallback;
}

/**
 * Orchestrator Policy (#2955): this session's Orchestrator policy, in three tabs of the same rows as
 * Settings › Orchestrator. It edits a copy of New Session's draft: Apply Policy returns the copy,
 * Cancel (and Back, on a phone) discards it, and Reset to Defaults clears every change. On desktop it
 * stacks over New Session; on a phone it takes over New Session's sheet with Back (§7.1, §7.5).
 */
export function OrchestratorPolicyDialog({
  context,
  draft: applied,
  initialTab = "behavior",
  returnFocusRef,
  onApply,
  onClose,
}: {
  context: OrchestratorPolicyContext;
  draft: OrchestratorPolicyDraft;
  initialTab?: OrchestratorPolicyTab;
  returnFocusRef?: { current: HTMLElement | null };
  onApply: (draft: OrchestratorPolicyDraft) => void;
  onClose: () => void;
}) {
  const ids = useId();
  const [draft, setDraft] = useState(applied);
  const [tab, setTab] = useState<OrchestratorPolicyTab>(initialTab);
  const { view } = context;
  const defaults: OrchestratorDefaults = view.defaults;
  const evaluation = evaluateOrchestratorPolicy(context, draft);
  const { behavior, delegation, execution } = draft.values;
  const reasonId = `${ids}-reason`;
  const errorId = (path: OrchestratorPolicyPath) => `${ids}-${path.replaceAll(".", "-")}-error`;
  const problemFor = (path: OrchestratorPolicyPath) => evaluation.problems.find((problem) => problem.path === path)?.message ?? null;
  const rowError = (path: OrchestratorPolicyPath): ReactNode => {
    const message = problemFor(path);
    return message ? <FieldError id={errorId(path)}>{message}</FieldError> : undefined;
  };
  const mark = (path: OrchestratorPolicyPath | "controlMode", resetTo: string) => evaluation.changed(path)
    ? <ChangedMark resetTo={resetTo} onReset={() => setDraft(resetField(draft, defaults, path))} />
    : undefined;
  const setBehavior = <K extends keyof OrchestratorDefaults["behavior"]>(key: K, value: OrchestratorDefaults["behavior"][K]) =>
    setDraft((current) => ({ ...current, values: { ...current.values, behavior: { ...current.values.behavior, [key]: value } } }));
  const setExecution = (key: keyof OrchestratorDefaults["execution"], value: boolean) =>
    setDraft((current) => ({ ...current, values: { ...current.values, execution: { ...current.values.execution, [key]: value } } }));
  const setDecision = (category: DelegatableWorkflowDecisionCategory, value: "human" | "orchestrator") =>
    setDraft((current) => ({
      ...current,
      values: { ...current.values, delegation: { ...current.values.delegation, decisions: { ...current.values.delegation.decisions, [category]: value } } },
    }));

  // The saved defaults by the names their rows use, for each "Reset to <value>".
  const defaultHarness = defaults.behavior.childHarness;
  const defaultModel = defaults.behavior.childModel;
  const defaultModelName = defaultModel === null ? "Automatic"
    : view.capabilities?.harnesses?.flatMap((harness) => harness.models).find((model) => model.id === defaultModel)?.displayName ??
      view.capabilities?.models?.find((model) => model.id === defaultModel)?.displayName ?? defaultModel;
  const resetLabels = {
    harness: defaultHarness ? optionLabel(evaluation.harness.options, agentHarnessIdentityKey(defaultHarness), "Your Default") : "Automatic",
    model: defaultModelName,
    effort: defaults.behavior.childEffort ? titleCaseLabel(defaults.behavior.childEffort) : "Automatic",
    limit: String(defaults.behavior.maximumConcurrentChildren),
    followUps: optionLabel(FOLLOW_UP_OPTIONS, defaults.behavior.followUps, "Your Default"),
    completion: optionLabel(COMPLETION_OPTIONS, defaults.behavior.completion, "Your Default"),
    parentControl: optionLabel(PARENT_CONTROL_OPTIONS, defaults.delegation.parentControl, "Your Default"),
    controlMode: optionLabel(CONTROL_MODE_OPTIONS, defaults.controlMode ?? "custom", "Custom"),
  };
  const onOff = (value: boolean) => value ? "On" : "Off";

  // The boundary the Orchestrator launches with, as one read-only row.
  const boundary = execution.strictProjectIsolation
    ? { value: "Read-Only Project", description: "The Orchestrator can't write to the project and loads no integrations." }
    : evaluation.presetReason !== undefined
      ? { value: "Orchestrator Preset", description: "The Orchestrator preset sets its permissions and integrations." }
      : evaluation.integration.effective
        ? { value: "Agent Permissions", description: "The Orchestrator keeps this agent's permissions, with Wollipog's tools as its only integration." }
        : { value: "Agent Permissions", description: "The Orchestrator keeps this agent's permissions and integrations." };

  const behaviorPanel = (
    <SettingsGroup>
      <SelectRow
        title="Child Harness"
        description="The agent that runs each child."
        badge={mark("behavior.childHarness", resetLabels.harness)}
        options={evaluation.harness.options}
        value={evaluation.harness.value}
        disabled={evaluation.harness.disabled}
        disabledReason={evaluation.harness.disabledReason}
        error={problemFor("behavior.childHarness")}
        onChange={(value) => setDraft((current) => withChildHarness(current, view, value))}
      />
      <SelectRow
        title="Child Model"
        description="Automatic lets each child's agent choose."
        badge={mark("behavior.childModel", resetLabels.model)}
        options={evaluation.model.options}
        value={evaluation.model.value}
        error={problemFor("behavior.childModel")}
        onChange={(value) => setDraft((current) => withChildModel(current, view, value))}
      />
      <SelectRow
        title="Child Effort"
        description="Automatic uses the model's own default."
        badge={mark("behavior.childEffort", resetLabels.effort)}
        options={evaluation.effort.options}
        value={evaluation.effort.value}
        error={problemFor("behavior.childEffort")}
        onChange={(value) => setBehavior("childEffort", value === AUTOMATIC_ORCHESTRATOR_VALUE ? null : value)}
      />
      {view.reviewPolicySupported && <OrchestratorReviewFields value={draft.values.behavior} reviewers={view.capabilities.reviewers ?? []}
        problem={orchestratorReviewPolicyProblem(draft.values.behavior, view.capabilities.reviewers ?? [])}
        badge={key => {
          const saved = defaults.behavior[key];
          const label = saved == null ? "Automatic" : key === "reviewHarness" ? saved === "codex" ? "Codex" : "Claude Code"
            : key === "reviewEffort" ? titleCaseLabel(String(saved)) : key === "reviewModel"
              ? view.capabilities.reviewers?.flatMap(r => r.capabilities.models).find(m => m.id === saved)?.displayName ?? String(saved) : String(saved);
          return mark(`behavior.${key}`, label);
        }}
        onChange={patch => setDraft(current => ({ ...current, values: { ...current.values, behavior: { ...current.values.behavior, ...patch } } }))} />}
      {/* The error replaces the description (§8.5), so the row says one thing at a time. */}
      <NumberRow
        title="Maximum Concurrent Children"
        description={evaluation.limit.valid ? evaluation.limit.description : undefined}
        badge={mark("behavior.maximumConcurrentChildren", resetLabels.limit)}
        inputId={`${ids}-limit`}
        min={evaluation.limit.min}
        max={MAX_LIVE_CHILD_LIMIT}
        step={1}
        value={draft.limitText}
        error={evaluation.limit.valid ? null : evaluation.limit.error}
        onChange={(text) => setDraft((current) => ({
          ...current,
          limitText: text,
          values: { ...current.values, behavior: { ...current.values.behavior, maximumConcurrentChildren: Number(text) } },
        }))}
      />
      <SelectRow
        title="Follow-Ups"
        description={draft.controlMode === "full_control" && behavior.followUps === "execute_approved"
          ? `${FOLLOW_UP_OPTIONS.find((option) => option.value === behavior.followUps)?.description} ${FULL_CONTROL_FOLLOW_UPS_NOTE}`
          : FOLLOW_UP_OPTIONS.find((option) => option.value === behavior.followUps)?.description}
        badge={mark("behavior.followUps", resetLabels.followUps)}
        options={FOLLOW_UP_OPTIONS}
        value={behavior.followUps}
        onChange={(value) => setBehavior("followUps", value as OrchestratorDefaults["behavior"]["followUps"])}
      />
      <SegmentedRow
        title="Completion"
        badge={mark("behavior.completion", resetLabels.completion)}
        options={COMPLETION_OPTIONS}
        value={behavior.completion}
        onChange={(value) => setBehavior("completion", value as OrchestratorDefaults["behavior"]["completion"])}
      />
    </SettingsGroup>
  );

  const integrationLocked = evaluation.integration.lockedReason;
  const permissionsPanel = (
    <SettingsGroup
      foot={(
        <details className="disclosure orchestrator-about">
          <summary><ChevronRightIcon className="disclosure-chevron" />About Integration Isolation</summary>
          <div className="disclosure-body"><p>{evaluation.integration.about}</p></div>
        </details>
      )}
    >
      <SegmentedRow
        title="Strict Project Isolation"
        badge={mark("execution.strictProjectIsolation", onOff(defaults.execution.strictProjectIsolation))}
        options={STRICT_ISOLATION_OPTIONS}
        value={execution.strictProjectIsolation ? "on" : "off"}
        error={rowError("execution.strictProjectIsolation")}
        invalid={problemFor("execution.strictProjectIsolation") !== null}
        describedBy={problemFor("execution.strictProjectIsolation") ? errorId("execution.strictProjectIsolation") : undefined}
        onChange={(value) => setExecution("strictProjectIsolation", value === "on")}
      />
      {/* While Strict Project Isolation or the preset implies it, the row shows the implied value and
          says why it can't change, rather than a choice the launch would ignore. */}
      <SegmentedRow
        title="Integration Isolation"
        badge={mark("execution.integrationIsolation", onOff(defaults.execution.integrationIsolation))}
        options={integrationLocked
          ? INTEGRATION_ISOLATION_OPTIONS.map(({ value, label }) => ({ value, label }))
          : INTEGRATION_ISOLATION_OPTIONS}
        value={evaluation.integration.effective ? "on" : "off"}
        disabled={integrationLocked !== undefined}
        disabledReason={integrationLocked}
        error={rowError("execution.integrationIsolation")}
        invalid={problemFor("execution.integrationIsolation") !== null}
        describedBy={problemFor("execution.integrationIsolation") ? errorId("execution.integrationIsolation") : undefined}
        onChange={(value) => setExecution("integrationIsolation", value === "on")}
      />
      <ValueRow title="Effective Boundary" value={boundary.value} description={boundary.description} />
    </SettingsGroup>
  );

  // Full Control launches like any Orchestrator (#2940): its boundary owns every gate, so the Custom
  // owners below would have no effect and are not shown. A row whose problem blocks the launch stays.
  const fullControl = draft.controlMode === "full_control";
  const decisionsPanel = (
    <SettingsGroup
      foot={fullControl ? undefined : <p className="orchestrator-human-only"><LockIcon size={14} aria-hidden="true" />{HUMAN_ONLY_DECISIONS}</p>}
    >
      <SegmentedRow
        title="Orchestrator Control"
        badge={mark("controlMode", resetLabels.controlMode)}
        options={CONTROL_MODE_OPTIONS}
        value={draft.controlMode}
        onChange={(value) => setDraft((current) => ({ ...current, controlMode: value as OrchestratorPolicyDraft["controlMode"] }))}
      />
      {(!fullControl || problemFor("delegation.parentControl") !== null) && <SelectRow
        title="Descendant Requests"
        description={PARENT_CONTROL_OPTIONS.find((option) => option.value === evaluation.parentControl.value)?.description}
        badge={mark("delegation.parentControl", resetLabels.parentControl)}
        options={evaluation.parentControl.options}
        value={evaluation.parentControl.value}
        error={problemFor("delegation.parentControl")}
        onChange={(value) => setDraft((current) => ({
          ...current,
          values: { ...current.values, delegation: { ...current.values.delegation, parentControl: value as typeof delegation.parentControl } },
        }))}
      />}
      {!fullControl && <h4 className="orchestrator-gates-label">Who Decides at Each Gate</h4>}
      {WORKFLOW_DECISION_CATEGORIES.map((category) => {
        const path = `delegation.decisions.${category}` as const;
        if (fullControl && problemFor(path) === null) return null;
        return (
          <SegmentedRow
            key={category}
            title={ORCHESTRATOR_DECISION_LABELS[category]}
            description={category === "ui_evidence_approval" ? "The Orchestrator reviews only evidence images it can see." : undefined}
            badge={mark(path, titleCaseLabel(defaults.delegation.decisions[category]))}
            options={[
              { value: "human", label: "Human" },
              {
                value: "orchestrator",
                label: "Orchestrator",
                disabled: evaluation.decisionDisabledReason !== undefined,
                disabledReason: evaluation.decisionDisabledReason,
              },
            ]}
            value={evaluation.decision(category)}
            error={rowError(path)}
            invalid={problemFor(path) !== null}
            describedBy={problemFor(path) ? errorId(path) : undefined}
            onChange={(value) => setDecision(category, value as "human" | "orchestrator")}
          />
        );
      })}
    </SettingsGroup>
  );

  const counts = evaluation.changeCounts;
  return (
    <Modal
      title="Orchestrator Policy"
      description="For this session only. Your defaults live in Settings."
      returnFocusRef={returnFocusRef}
      onClose={onClose}
      footer={<>
        {!evaluation.limit.valid && <p className="orchestrator-policy-reason" id={reasonId}>{evaluation.limit.error}</p>}
        <button
          type="button"
          className="btn ghost orchestrator-policy-reset"
          disabled={counts.total === 0}
          onClick={() => setDraft(policyDraftFromDefaults(defaults))}
        >
          Reset to Defaults
        </button>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="btn primary"
          disabled={!evaluation.limit.valid}
          aria-describedby={evaluation.limit.valid ? undefined : reasonId}
          onClick={() => onApply(draft)}
        >
          Apply Policy
        </button>
      </>}
    >
      <TabList label="Orchestrator Policy" className="orchestrator-policy-tabs" onKeyDown={(event) => handleRovingChoiceKeyDown(event, "tab")}>
        {TABS.map((item) => (
          <button
            key={item.id}
            id={`${ids}-${item.id}-tab`}
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === item.id}
            aria-controls={`${ids}-${item.id}-panel`}
            tabIndex={tab === item.id ? 0 : -1}
            // The dialog opens on its tabs, so the first arrow moves between them (§7.2).
            autoFocus={item.id === initialTab}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {counts[item.id] > 0 && <span className="count">{counts[item.id]} Changed</span>}
          </button>
        ))}
      </TabList>
      <div id={`${ids}-${tab}-panel`} role="tabpanel" aria-labelledby={`${ids}-${tab}-tab`} className="orchestrator-policy-panel">
        {tab === "behavior" ? behaviorPanel : tab === "permissions" ? permissionsPanel : decisionsPanel}
      </div>
    </Modal>
  );
}
