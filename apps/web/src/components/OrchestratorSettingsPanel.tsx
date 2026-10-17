import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_LIVE_CHILD_LIMIT,
  WORKFLOW_DECISION_CATEGORIES,
  agentHarnessIdentityKey,
  type OrchestratorDefaults,
  type OrchestratorSettingsView,
  type DelegatableWorkflowDecisionCategory,
} from "@wollipog/protocol";
import { agentHarnessMachinesDescription, agentHarnessOptionLabel, modelDriftText, pinnedModelChoices } from "../agent-presentation.js";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { effortLabel } from "../format.js";
import { useLeaveGuard } from "../leave-guard.js";
import { viewPath } from "../navigation.js";
import {
  ORCHESTRATOR_PRESET_INTEGRATION_DISCLOSURE,
  INTEGRATION_ISOLATION_BY_HARNESS,
  INTEGRATION_ISOLATION_CONTROL_PLANE_REQUIRED,
  INTEGRATION_ISOLATION_PRESERVED,
  controlPlaneSupportsIntegrationIsolation,
} from "../session-preset-defaults.js";
import { useOptionalNavigate } from "../store.js";
import { DELEGATED_UI_EVIDENCE_RETENTION_DISCLOSURE } from "../ui-evidence-disclosure.js";
import { useFeedback } from "./FeedbackProvider.js";
import { ChevronRightIcon, LockIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { SkeletonRows } from "./QuestionPoliciesPanel.js";
import { SaveBar } from "./SaveBar.js";
import { useSettingsPanelHead } from "./SettingsView.js";
import type { SelectOption } from "./ui/ChoiceControls.js";
import { NumberRow, SegmentedRow, SelectRow, SettingsGroup } from "./ui/SettingsRows.js";
import { FullControlModeChoice } from "./FullControlPreparation.js";

const AUTO = "__automatic__";
const DECISION_LABELS: Record<DelegatableWorkflowDecisionCategory, string> = {
  implementation_question: "Implementation Questions",
  pr_merge: "PR Merge Approval",
  merged_branch_deletion: "Merged Branch Deletion",
  follow_up_issue_publication: "Follow-Up Issue Publication",
  ui_evidence_approval: "UI Evidence Approval",
};
/*
 * A listbox rather than pills, by SettingsRows' own split: these options each need a sentence to
 * choose between, and "Questions and Approvals" is no short label. As three equal pills in the old
 * 260px value column they were 83px each, so that label drew over its neighbour at every width
 * (#2413). New Session offers the same choice as a Select.
 */
const PARENT_CONTROL_OPTIONS: SelectOption<OrchestratorDefaults["delegation"]["parentControl"]>[] = [
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
const FOLLOW_UP_OPTIONS: SelectOption<OrchestratorDefaults["behavior"]["followUps"]>[] = [
  { value: "recommend_only", label: "Recommend Only", description: "Report justified follow-ups and wait for approval." },
  { value: "execute_approved", label: "Execute Approved", description: "Continue with follow-ups after their required approval." },
];

/*
 * Off | On rather than a switch: this is a draft that saves from the save bar, and a switch means
 * "applies now" (§8.4, §8.6). The same two pills as New Session's Orchestrator Policy dialog.
 *
 * Both policies bound the Orchestrator session itself, not its children: the control plane attaches
 * them to the Orchestrator's launch only, and children keep their own permissions and integrations.
 * The sentences say so rather than promising a boundary children do not have.
 */
const STRICT_ISOLATION_OPTIONS = [
  { value: "off", label: "Off", description: "The Orchestrator uses its agent's own permissions and governance." },
  { value: "on", label: "On", description: "The Orchestrator can't write to the project. Needs a supported sandbox." },
];
const INTEGRATION_ISOLATION_OPTIONS = [
  { value: "off", label: "Off", description: "The Orchestrator loads the same integrations as any other session." },
  { value: "on", label: "On", description: "The Orchestrator gets Wollipog's management tools and no other integration." },
];

const PANEL_DESCRIPTION = "Defaults for new campaigns. Running campaigns keep their own.";
const SKELETON_DELAY_MS = 300;
const HARNESS_UNSUPPORTED = "Update Wollipog on a machine to choose a fixed Child Harness.";
const PAIR_ERROR = "Choose a model and effort this agent supports, or Automatic.";
const LIMIT_ERROR = `Enter a whole number from 0 to ${MAX_LIVE_CHILD_LIMIT}.`;

type LoadFailure = { kind: "unsupported" } | { kind: "failed"; detail: string };

function loadFailure(caught: unknown): LoadFailure {
  return caught instanceof ApiError && caught.status === 404
    ? { kind: "unsupported" }
    : { kind: "failed", detail: caught instanceof Error ? caught.message : String(caught) };
}

/** A failed save in one sentence: the server's own when it answered, which says what to change. */
function saveFailure(caught: unknown): string {
  return caught instanceof ApiError && caught.message
    ? caught.message
    : "Couldn't reach Wollipog to save your defaults.";
}

function cloneDefaults(defaults: OrchestratorDefaults): OrchestratorDefaults {
  return {
    ...(defaults.controlMode === undefined ? {} : { controlMode: defaults.controlMode }),
    behavior: { ...defaults.behavior },
    delegation: { ...defaults.delegation, decisions: { ...defaults.delegation.decisions } },
    execution: { ...defaults.execution },
    ...(defaults.campaignBudget === undefined ? {} : { campaignBudget: defaults.campaignBudget ? { ...defaults.campaignBudget } : null }),
  };
}

/** The same JSON whatever order its keys were written in, so a draft equals what it was cloned from. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/**
 * Settings › Orchestrator: the policy every new campaign starts with, as an editor (§8.6). Changes
 * are a draft, saved together from the save bar, which shows only while the draft differs from the
 * saved defaults or a save failed. Each problem is shown at the setting that causes it, and while
 * any is, the bar says how many to fix instead of saving.
 */
export function OrchestratorSettingsPanel({ discoveryRevision }: { discoveryRevision?: object } = {}) {
  const api = useApi();
  const { confirm } = useFeedback();
  const navigate = useOptionalNavigate();
  const [view, setView] = useState<OrchestratorSettingsView | null>(null);
  const [draft, setDraft] = useState<OrchestratorDefaults | null>(null);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [busy, setBusy] = useState(false);
  const [controlPreview, setControlPreview] = useState<"custom" | "full_control">("custom");
  const [saveError, setSaveError] = useState<string | null>(null);
  const generation = useRef(0);

  // Typed text for the saved Full Control budget; the draft holds it only once both parts are valid.
  // It is replaced only where the draft is (load into a clean editor, save, discard), so a discovery
  // refresh never drops a half-typed budget, and typed text counts as an unsaved change.
  const [budgetText, setBudgetText] = useState({ cost: "", tools: "" });
  const budgetFromDefaults = (defaults: OrchestratorDefaults | undefined) => ({
    cost: defaults?.campaignBudget ? String(defaults.campaignBudget.costUsd) : "",
    tools: defaults?.campaignBudget ? String(defaults.campaignBudget.toolCalls) : "",
  });
  // Text a number field cannot read (`1e`) reports "", which must never read as a cleared budget.
  const [budgetUnreadable, setBudgetUnreadable] = useState({ cost: false, tools: false });
  const budgetBadInput = budgetUnreadable.cost || budgetUnreadable.tools;
  const savedBudgetText = budgetFromDefaults(view?.defaults);
  const budgetTextDirty = budgetBadInput || budgetText.cost !== savedBudgetText.cost || budgetText.tools !== savedBudgetText.tools;
  const dirty = !!draft && !!view && (canonical(draft) !== canonical(view.defaults) || budgetTextDirty);
  // Read by a refresh that lands later: discovery brings new capabilities, never a lost draft.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const load = useCallback(async () => {
    const current = ++generation.current;
    setFailure(null);
    try {
      const next = await api.orchestratorSettings();
      if (generation.current !== current) return;
      setView(next);
      if (!dirtyRef.current) {
        setDraft(cloneDefaults(next.defaults));
        setBudgetText(budgetFromDefaults(next.defaults));
      }
    } catch (caught) {
      // A refresh that fails keeps the loaded editor; only a first load has nothing else to show.
      if (generation.current === current) setFailure(loadFailure(caught));
    }
  }, [api]);

  useEffect(() => {
    void load();
    return () => { generation.current += 1; };
  }, [load, discoveryRevision]);

  // §12.3: nothing for the first 300ms, so a quick load never flashes a skeleton.
  useEffect(() => {
    const timer = window.setTimeout(() => setShowSkeleton(true), SKELETON_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const controlMode = view?.controlModeSupported ? draft?.controlMode ?? "custom" : controlPreview;
  const changeControlMode = useCallback((mode: "custom" | "full_control") => {
    if (view?.controlModeSupported) setDraft((current) => current ? { ...current, controlMode: mode } : current);
    else setControlPreview(mode);
  }, [view?.controlModeSupported]);
  const controlLoaded = Boolean(view && draft);
  const headControl = useMemo(() => controlLoaded
    ? <FullControlModeChoice mode={controlMode} onChange={changeControlMode}
      disabled={busy} preferenceSupported={view?.controlModeSupported} />
    : null, [controlLoaded, controlMode, changeControlMode, busy, view?.controlModeSupported]);
  const hasPanelHead = useSettingsPanelHead({
    description: PANEL_DESCRIPTION,
    meta: view ? (view.source === "user_default" ? "Your Defaults" : "Wollipog Defaults") : null,
    action: headControl,
  });

  const askToLeave = (leave: () => void) => {
    void confirm({
      title: "Discard Changes",
      message: "Your Orchestrator defaults have changes that aren't saved. Discarding them keeps the saved defaults.",
      confirmLabel: "Discard Changes",
      cancelLabel: "Keep Editing",
      // Danger opens with focus on Keep Editing, the choice that loses nothing (§7.4).
      tone: "danger",
    // The confirmation belongs to the app, so it can outlive this panel (a Back or Forward that
    // cannot be held, history-position.ts): confirmed after the editor is gone, there is nothing left
    // to leave from.
    }).then((discard) => { if (discard && alive.current) leave(); });
  };
  // A save in flight cannot be discarded (Discard is disabled while busy, §8.6), so leaving waits
  // for it: a saved draft then leaves without asking, and a refused one asks as any dirty draft does.
  const busyRef = useRef(false);
  busyRef.current = busy;
  const leaveAfterSave = useRef<(() => void) | null>(null);
  // Whether the editor is still on screen. Gone before a save settled or a confirmation was answered
  // (a Back or Forward that cannot be held), nothing is left to leave from.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      leaveAfterSave.current = null;
    };
  }, []);
  useLeaveGuard(dirty, (leave) => {
    if (busyRef.current) leaveAfterSave.current = leave;
    else askToLeave(leave);
  });

  const updateBehavior = <K extends keyof OrchestratorDefaults["behavior"]>(
    key: K,
    value: OrchestratorDefaults["behavior"][K],
  ) => {
    setDraft((current) => current ? {
      ...current,
      behavior: { ...current.behavior, [key]: value },
    } : current);
  };
  const updateDelegation = (
    category: DelegatableWorkflowDecisionCategory,
    authority: "human" | "orchestrator",
  ) => {
    setDraft((current) => current ? {
      ...current,
      delegation: {
        ...current.delegation,
        decisions: { ...current.delegation.decisions, [category]: authority },
      },
    } : current);
  };
  const updateExecution = <Key extends keyof OrchestratorDefaults["execution"]>(
    key: Key,
    value: OrchestratorDefaults["execution"][Key],
  ) => {
    setDraft((current) => current ? {
      ...current,
      execution: { ...current.execution, [key]: value },
    } : current);
  };

  // Strict Project Isolation's harness shapes carry no user integration at all, so the settings
  // panel shows the value those launches actually have rather than the one stored underneath it.
  const integrationIsolationImplied = draft?.execution.strictProjectIsolation === true;
  // An older server's update parser rejects a defaults payload carrying this key, so the control is
  // disabled there. The draft is a plain spread of the served payload, so a save from this panel
  // round-trips WITHOUT the field and every unrelated default stays saveable.
  const integrationIsolationSupported = controlPlaneSupportsIntegrationIsolation(view?.defaults);
  const harnessPolicySupported = view?.capabilities.harnesses !== undefined;
  const harnesses = view?.capabilities.harnesses ?? [];
  const selectedHarness = draft?.behavior.childHarness ?? null;
  const selectedModel = draft?.behavior.childModel ?? null;
  const selectedEffort = draft?.behavior.childEffort ?? null;
  const selectedHarnessCapability = selectedHarness
    ? harnesses.find((harness) => agentHarnessIdentityKey(harness) === agentHarnessIdentityKey(selectedHarness))
    : undefined;
  const candidateHarnesses = selectedHarness ? (selectedHarnessCapability ? [selectedHarnessCapability] : []) : harnesses;
  const harnessOptions = useMemo(() => {
    const options = [{
      value: AUTO,
      label: "Automatic",
      description: harnessPolicySupported
        ? "Choose one compatible Agent Harness with the selected model and effort at child creation."
        : HARNESS_UNSUPPORTED,
    }];
    for (const harness of harnesses) {
      options.push({
        value: agentHarnessIdentityKey(harness),
        label: harness.installations > 0 ? agentHarnessOptionLabel(harness) : `${agentHarnessOptionLabel(harness)} (Unavailable)`,
        description: harness.installations > 0
          ? agentHarnessMachinesDescription(harness)
          : "No current installation advertises this saved Agent Harness. Connect it or choose Automatic.",
      });
    }
    return options;
  }, [harnessPolicySupported, harnesses]);
  // A saved model that no current installation advertises, which only another choice can repair.
  const advertisedModels = harnessPolicySupported
    ? candidateHarnesses.flatMap((harness) => harness.models)
    : view?.capabilities.models ?? [];
  const modelRetired = !!selectedModel && !advertisedModels.some((model) => model.id === selectedModel);
  const modelOptions = useMemo(() => {
    const options = [{ value: AUTO, label: "Automatic", description: "Choose from live child capabilities at creation time." }];
    const models = new Map<string, { names: Set<string>; displayName: string }>();
    for (const harness of selectedHarness ? candidateHarnesses : []) {
      for (const model of harness.models) {
        const current = models.get(model.id) ?? { names: new Set<string>(), displayName: model.displayName ?? model.id };
        current.names.add(harness.name);
        models.set(model.id, current);
      }
    }
    if (!harnessPolicySupported) {
      for (const model of view?.capabilities.models ?? []) {
        models.set(model.id, { names: new Set<string>(), displayName: model.displayName ?? model.id });
      }
    }
    for (const [modelId, model] of models) {
      options.push({
        value: modelId,
        label: model.displayName,
        description: selectedHarness
          ? `Use ${model.displayName} through the selected Child Harness.`
          : `Resolve ${model.displayName} through a compatible harness: ${[...model.names].sort().join(", ")}.`,
      });
    }
    const selected = selectedModel;
    if (selected && !options.some((option) => option.value === selected)) {
      const advertised = candidateHarnesses.flatMap((harness) => harness.models)
        .find((model) => model.id === selected);
      options.push({
        value: selected,
        label: advertised && !selectedHarness
          ? `${advertised.displayName ?? advertised.id} (Legacy Automatic Harness)`
          : `${selected} (Unavailable)`,
        description: advertised && !selectedHarness
          ? "This legacy fixed model retains automatic harness resolution. Choose a fixed Child Harness before selecting a different model."
          : selectedHarness
            ? "No current installation advertises this saved model through the selected Child Harness."
            : "No current installation advertises this saved model. Choose a Child Harness or return Child Model to Automatic.",
      });
    }
    return options;
  }, [candidateHarnesses, harnessPolicySupported, selectedHarness, selectedModel, view?.capabilities.models]);
  const effortOptions = useMemo(() => {
    const options = [{ value: AUTO, label: "Automatic", description: "Let the selected child model choose its default effort." }];
    const efforts = new Set(harnessPolicySupported
      ? (selectedHarness ? candidateHarnesses : []).flatMap((harness) => selectedModel
        ? harness.supportedPairs.filter((pair) => pair.modelId === selectedModel)
          .flatMap((pair) => pair.effortLevels)
        : harness.effortLevels)
      : view?.capabilities.effortLevels ?? []);
    for (const effort of [...efforts].sort()) {
      options.push({ value: effort, label: effortLabel(effort), description: `Use ${effortLabel(effort)} effort for children by default.` });
    }
    const selected = selectedEffort;
    if (selected && !options.some((option) => option.value === selected)) {
      const advertised = candidateHarnesses.some((harness) => selectedModel
        ? harness.supportedPairs.some((pair) => pair.modelId === selectedModel && pair.effortLevels.includes(selected))
        : harness.effortLevels.includes(selected));
      options.push({
        value: selected,
        label: advertised && !selectedHarness
          ? `${effortLabel(selected)} (Legacy Automatic Harness)`
          : `${effortLabel(selected)} (Unavailable)`,
        description: advertised && !selectedHarness
          ? "This legacy fixed effort retains automatic harness resolution. Choose a fixed Child Harness before selecting a different effort."
          : "No current installation advertises this saved effort for the selected combination.",
      });
    }
    return options;
  }, [candidateHarnesses, harnessPolicySupported, selectedEffort, selectedHarness, selectedModel, view?.capabilities.effortLevels]);
  const limitValid = !!draft && Number.isSafeInteger(draft.behavior.maximumConcurrentChildren) &&
    draft.behavior.maximumConcurrentChildren >= 0 && draft.behavior.maximumConcurrentChildren <= MAX_LIVE_CHILD_LIMIT;
  const fixedPairValid = (!selectedHarness && !selectedModel && !selectedEffort) || (harnessPolicySupported
    ? candidateHarnesses.some((harness) => harness.installations > 0 &&
      (selectedModel
        ? harness.supportedPairs.some((pair) => pair.modelId === selectedModel &&
          (!selectedEffort || pair.effortLevels.includes(selectedEffort)))
        : selectedEffort
          ? harness.effortLevels.includes(selectedEffort)
          : true))
    : view?.capabilities.supportedPairs
      ? selectedModel
        ? view.capabilities.supportedPairs.some((pair) => pair.modelId === selectedModel &&
          (!selectedEffort || pair.effortLevels.includes(selectedEffort)))
        : selectedEffort
          ? view.capabilities.effortLevels.includes(selectedEffort)
          : view.capabilities.installations > 0
      : view?.capabilities.status === "available");

  /*
   * Each problem at the setting that causes it (§8.5). A fixed harness no installation advertises is
   * the harness's to fix; a retired model is the model's; anything else unsupported is the model and
   * effort the person chose together. Automatic is never the cause.
   */
  const harnessRetired = harnessPolicySupported && !!selectedHarness && (selectedHarnessCapability?.installations ?? 0) === 0;
  const harnessError = !fixedPairValid && harnessRetired ? "Choose another Child Harness, or Automatic." : null;
  const modelError = fixedPairValid || harnessError ? null
    : modelRetired ? "Choose another model."
      : selectedModel ? PAIR_ERROR : null;
  const effortError = fixedPairValid || harnessError || modelRetired ? null : selectedEffort ? PAIR_ERROR : null;
  // An unsupported fixed harness with Automatic model and effort still has to be fixed somewhere.
  const pairFallbackError = !fixedPairValid && !harnessError && !modelError && !effortError && selectedHarness
    ? "Choose another Child Harness, or Automatic." : null;
  const limitError = limitValid ? null : LIMIT_ERROR;
  const budgetCost = Number(budgetText.cost), budgetTools = Number(budgetText.tools);
  const budgetEmpty = !budgetText.cost.trim() && !budgetText.tools.trim();
  const budgetComplete = Number.isFinite(budgetCost) && budgetCost > 0 && budgetCost <= 1_000_000 &&
    Number.isSafeInteger(budgetTools) && budgetTools > 0 && budgetTools <= 10_000_000;
  const budgetError = !budgetBadInput && (budgetEmpty || budgetComplete) ? null
    : "Enter both a cost limit and a whole number of tool calls, or clear both.";
  const changeBudget = (next: { cost: string; tools: string }) => {
    setBudgetText(next);
    const cost = Number(next.cost), tools = Number(next.tools);
    const empty = !next.cost.trim() && !next.tools.trim();
    const complete = Number.isFinite(cost) && cost > 0 && cost <= 1_000_000 && Number.isSafeInteger(tools) && tools > 0 && tools <= 10_000_000;
    if (!empty && !complete) return;
    setDraft((current) => {
      if (!current) return current;
      const { campaignBudget: _previous, ...rest } = current;
      return empty ? (view?.defaults.campaignBudget !== undefined ? { ...rest, campaignBudget: null } : rest)
        : { ...rest, campaignBudget: { costUsd: cost, toolCalls: tools } };
    });
  };
  const invalidCount = [harnessError ?? pairFallbackError, modelError, effortError, limitError, budgetError].filter(Boolean).length;

  // No connected machine reports child capabilities at all: the group says so once, at its top, and
  // a model or effort left on Automatic has nothing else to offer until one does.
  const capabilities = view?.capabilities;
  const capabilityNotice = !capabilities ? null
    : capabilities.status === "unavailable" && capabilities.installations === 0
      ? capabilities.reason ?? "No connected machine reports which models and efforts child agents can use."
      : !harnessPolicySupported ? HARNESS_UNSUPPORTED : null;
  const noInstallations = capabilities?.status === "unavailable" && capabilities.installations === 0;
  // Under each disabled select, pointing at the notice rather than repeating its sentences.
  const noInstallationsReason = noInstallations ? "Unavailable until a connected machine reports models and efforts." : undefined;
  // Machine support and model drift describe the saved combination, so they show only while the
  // draft still holds it (#3248).
  const savedCombination = Boolean(view && draft &&
    (view.defaults.behavior.childHarness ? agentHarnessIdentityKey(view.defaults.behavior.childHarness) : null) ===
      (draft.behavior.childHarness ? agentHarnessIdentityKey(draft.behavior.childHarness) : null) &&
    view.defaults.behavior.childModel === draft.behavior.childModel &&
    view.defaults.behavior.childEffort === draft.behavior.childEffort);
  const machineSupport = savedCombination ? capabilities?.machineSupport : undefined;
  const partialSupport = machineSupport && machineSupport.supported > 0 && machineSupport.supported < machineSupport.total
    ? machineSupport : undefined;
  const modelDrift = savedCombination ? capabilities?.childModelDrift : undefined;
  const chooseModel = (childModel: string | null) => setDraft((current) => {
    if (!current) return current;
    const effort = current.behavior.childEffort;
    const effortCompatible = !effort || candidateHarnesses.some((harness) =>
      childModel
        ? harness.supportedPairs.some((pair) => pair.modelId === childModel && pair.effortLevels.includes(effort))
        : harness.effortLevels.includes(effort));
    return { ...current, behavior: { ...current.behavior, childModel, ...(!effortCompatible ? { childEffort: null } : {}) } };
  });

  const save = async () => {
    if (!draft || busy || invalidCount > 0 || (controlPreview === "full_control" && !view?.controlModeSupported)) return;
    generation.current += 1;
    busyRef.current = true;
    setBusy(true);
    setSaveError(null);
    let saved = false;
    try {
      const next = await api.updateOrchestratorSettings({ defaults: draft });
      setView(next);
      setDraft(cloneDefaults(next.defaults));
      setBudgetText(budgetFromDefaults(next.defaults));
      saved = true;
    } catch (caught) {
      // The draft stays as typed, and the bar offers Try Again (§8.6).
      setSaveError(saveFailure(caught));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
    const leave = leaveAfterSave.current;
    leaveAfterSave.current = null;
    if (leave) {
      if (saved) leave();
      else askToLeave(leave);
    }
  };
  const discard = () => {
    if (view) setDraft(cloneDefaults(view.defaults));
    setBudgetText(budgetFromDefaults(view?.defaults));
    setSaveError(null);
  };

  if (!draft || !view) {
    if (failure?.kind === "unsupported") {
      return <Notice
        tone="danger"
        role="alert"
        title="Orchestrator Settings Need a Newer Wollipog"
        actions={<button type="button" className="btn sm" onClick={() => void load()}>Retry</button>}
      >
        This version of Wollipog does not support Orchestrator settings. Update or restart Wollipog so it matches this dashboard, then try again.
      </Notice>;
    }
    if (failure) {
      return <Notice
        tone="danger"
        role="alert"
        title="Couldn't Load Orchestrator Settings"
        actions={<button type="button" className="btn sm" onClick={() => void load()}>Retry</button>}
        details={<code>{failure.detail}</code>}
      >
        Your saved defaults are unchanged. Retry to load them again.
      </Notice>;
    }
    if (!showSkeleton) return null;
    return <>
      <SettingsGroup title="Children"><SkeletonRows count={6} announce="Loading Orchestrator defaults…" /></SettingsGroup>
      <SettingsGroup title="Execution Permissions"><SkeletonRows count={2} announce="" /></SettingsGroup>
      <SettingsGroup title="Decision Delegation"><SkeletonRows count={6} announce="" /></SettingsGroup>
    </>;
  }

  const limit = draft.behavior.maximumConcurrentChildren;
  return <>
    {controlMode === "full_control" && <SettingsGroup
      title="Full Control"
      intro="Proposed whenever you start a Full Control campaign. Each campaign still needs your authorization, and you can change its limits before you start."
    >
      <NumberRow
        title="Campaign Cost Limit"
        description="The most one campaign may spend, in USD."
        inputId="orchestrator-campaign-cost"
        min={0}
        step={0.01}
        value={budgetText.cost}
        error={budgetError}
        onChange={(cost) => changeBudget({ ...budgetText, cost })}
        onBadInput={(cost) => setBudgetUnreadable((current) => ({ ...current, cost }))}
      />
      <NumberRow
        title="Campaign Tool Call Limit"
        description="The most tool calls one campaign may use."
        inputId="orchestrator-campaign-tools"
        min={1}
        step={1}
        value={budgetText.tools}
        onChange={(tools) => changeBudget({ ...budgetText, tools })}
        onBadInput={(tools) => setBudgetUnreadable((current) => ({ ...current, tools }))}
      />
    </SettingsGroup>}
    <SettingsGroup
      title="Children"
      action={!hasPanelHead ? <FullControlModeChoice mode={controlMode} onChange={changeControlMode}
        disabled={busy} preferenceSupported={view.controlModeSupported} /> : undefined}
      notice={capabilityNotice && <Notice
        tone="warning"
        compact
        actions={<a
          className="btn sm"
          href={viewPath({ name: "runners", section: "machines" })}
          onClick={(event) => {
            if (!navigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            navigate({ name: "runners", section: "machines" });
          }}
        >Open Connections</a>}
      >
        {capabilityNotice}
      </Notice> || (partialSupport || modelDrift) && <>
        {partialSupport && <Notice tone="warning" compact title="Not Every Machine Can Run These Children">
          {`${partialSupport.supported} of ${partialSupport.total} connected machines support the saved Child Harness, Child Model and Child Effort together. Children can't start on ${partialSupport.unsupportedMachines.join(", ")}.`}
        </Notice>}
        {modelDrift && <Notice
          tone="warning"
          compact
          title="Child Model Differs Between Machines"
          actions={pinnedModelChoices(modelDrift).length ? <>{pinnedModelChoices(modelDrift).slice(0, 3).map((choice) =>
            <button key={choice.modelId} type="button" className="btn sm" onClick={() => chooseModel(choice.modelId)}>
              Use {choice.displayName}
            </button>)}</> : undefined}
        >
          {`${modelDriftText(modelDrift)} Choose a specific model so every child runs the same one.`}
        </Notice>}
      </>}
    >
      <SelectRow
        title="Child Harness"
        description="The agent that runs each child."
        options={harnessOptions}
        value={selectedHarness ? agentHarnessIdentityKey(selectedHarness) : AUTO}
        disabled={!harnessPolicySupported}
        error={harnessError ?? pairFallbackError}
        onChange={(value) => {
          const childHarness = value === AUTO
            ? null
            : (() => {
              const harness = harnesses.find((candidate) => agentHarnessIdentityKey(candidate) === value);
              return harness ? { agentId: harness.agentId, driver: harness.driver, context: harness.context } : null;
            })();
          setDraft((current) => current ? {
            ...current,
            behavior: { ...current.behavior, childHarness, childModel: null, childEffort: null },
          } : current);
        }}
      />
      <SelectRow
        title="Child Model"
        description="Automatic lets each child's agent choose."
        options={modelOptions}
        value={draft.behavior.childModel ?? AUTO}
        // A saved model stays changeable, so it can be put back to Automatic.
        disabled={noInstallations && !selectedModel}
        disabledReason={noInstallationsReason}
        error={modelError}
        onChange={(value) => chooseModel(value === AUTO ? null : value)}
      />
      <SelectRow
        title="Child Effort"
        description="Automatic uses the model's own default."
        options={effortOptions}
        value={draft.behavior.childEffort ?? AUTO}
        disabled={noInstallations && !selectedEffort}
        disabledReason={noInstallationsReason}
        error={effortError}
        onChange={(value) => updateBehavior("childEffort", value === AUTO ? null : value)}
      />
      <NumberRow
        title="Maximum Concurrent Children"
        description={`0 pauses new children. Up to ${MAX_LIVE_CHILD_LIMIT}.`}
        inputId="orchestrator-max-children"
        min={0}
        max={MAX_LIVE_CHILD_LIMIT}
        // An emptied field is NaN in the draft, so it is invalid rather than a silent 0.
        value={Number.isNaN(limit) ? "" : limit}
        error={limitError}
        onChange={(value) => updateBehavior("maximumConcurrentChildren", value.trim() === "" ? Number.NaN : Number(value))}
      />
      <SelectRow
        title="Follow-Ups"
        // The selected option's sentence, as the pills showed it.
        description={FOLLOW_UP_OPTIONS.find((option) => option.value === draft.behavior.followUps)?.description}
        options={FOLLOW_UP_OPTIONS}
        value={draft.behavior.followUps}
        onChange={(value) => updateBehavior("followUps", value as OrchestratorDefaults["behavior"]["followUps"])}
      />
      <SegmentedRow
        title="Completion"
        options={[
          { value: "retain", label: "Retain", description: "Leave verified finished child sessions available for inspection." },
          { value: "stop_and_archive", label: "Stop and Archive", description: "Stop and archive children only after verified completion." },
        ]}
        value={draft.behavior.completion}
        onChange={(value) => updateBehavior("completion", value as OrchestratorDefaults["behavior"]["completion"])}
      />
    </SettingsGroup>

    <SettingsGroup
      title="Execution Permissions"
      foot={<details className="disclosure orchestrator-about">
        <summary><ChevronRightIcon className="disclosure-chevron" />About Isolation</summary>
        <div className="disclosure-body">
          <p>{draft.execution.strictProjectIsolation
            ? "Project writes are blocked by operating-system or audited provider sandbox enforcement. Unsupported harness and isolation combinations are refused."
            : "Provider approval controls and repository governance still apply. Orchestrator mode does not claim operating-system read-only enforcement. Explicit parent implementation must use its own worktree."}</p>
          <p>{!integrationIsolationSupported
            ? INTEGRATION_ISOLATION_CONTROL_PLANE_REQUIRED
            : integrationIsolationImplied
              ? `Strict Project Isolation already launches without provider integrations, so Integration Isolation is implied and cannot be turned off. ${ORCHESTRATOR_PRESET_INTEGRATION_DISCLOSURE}`
              : draft.execution.integrationIsolation
                ? `${INTEGRATION_ISOLATION_BY_HARNESS} ${INTEGRATION_ISOLATION_PRESERVED}`
                : "Hooks, plugins, extensions, skills, and configured MCP servers load exactly as they would for a normal session."}</p>
        </div>
      </details>}
    >
      <SegmentedRow
        title="Strict Project Isolation"
        options={STRICT_ISOLATION_OPTIONS}
        value={draft.execution.strictProjectIsolation ? "on" : "off"}
        onChange={(value) => updateExecution("strictProjectIsolation", value === "on")}
      />
      <SegmentedRow
        title="Integration Isolation"
        options={INTEGRATION_ISOLATION_OPTIONS}
        // Strict Project Isolation already launches without any provider integration, so the value
        // it implies is shown here rather than the stored one, and the control cannot contradict it.
        value={integrationIsolationImplied || draft.execution.integrationIsolation ? "on" : "off"}
        disabled={integrationIsolationImplied || !integrationIsolationSupported}
        disabledReason={integrationIsolationImplied
          ? "Included with Strict Project Isolation."
          : !integrationIsolationSupported
            ? INTEGRATION_ISOLATION_CONTROL_PLANE_REQUIRED
            : undefined}
        onChange={(value) => updateExecution("integrationIsolation", value === "on")}
      />
    </SettingsGroup>

    <SettingsGroup
      title="Decision Delegation"
      intro="You decide by default. Delegation never applies to campaigns that are already running."
      foot={<>
        <details className="disclosure orchestrator-about">
          <summary><ChevronRightIcon className="disclosure-chevron" />About UI Evidence Delegation</summary>
          <div className="disclosure-body">
            <p>
              The Orchestrator resolves this gate only when its runner, harness, and model can inspect images and the
              evidence is attached as a Session artifact. Video normally routes to a human; an operator may enable one
              short-frame validation campaign. Externally stored evidence and unsupported clients route to a human, and
              the campaign shows why.
            </p>
            <p>{DELEGATED_UI_EVIDENCE_RETENTION_DISCLOSURE}</p>
          </div>
        </details>
        <p className="orchestrator-human-only">
          <LockIcon size={14} aria-hidden="true" />
          Secrets, sign-in, permission grants, governance changes, budgets and guardrails always stay with you.
        </p>
      </>}
    >
      <SelectRow
        title="Descendant Requests"
        // The selected option's sentence, as the pills showed it: the row says what the choice does.
        description={PARENT_CONTROL_OPTIONS.find((option) => option.value === draft.delegation.parentControl)?.description}
        options={PARENT_CONTROL_OPTIONS}
        value={draft.delegation.parentControl}
        onChange={(value) => {
          setDraft((current) => current ? {
            ...current,
            delegation: { ...current.delegation, parentControl: value as OrchestratorDefaults["delegation"]["parentControl"] },
          } : current);
        }}
      />
      {/* A label inside the surface rather than a group of its own: the five gates are the same
          choice, made once per gate. */}
      <h4 className="orchestrator-gates-label">Who Decides at Each Gate</h4>
      {/* Human | Orchestrator under that label needs no sentence per gate. UI Evidence Approval
          keeps one, because delegating it depends on what the Orchestrator can see. */}
      {WORKFLOW_DECISION_CATEGORIES.map((category) => <SegmentedRow
        key={category}
        title={DECISION_LABELS[category]}
        description={category === "ui_evidence_approval"
          ? "The Orchestrator reviews only evidence images it can see."
          : undefined}
        options={[
          { value: "human", label: "Human" },
          { value: "orchestrator", label: "Orchestrator" },
        ]}
        value={draft.delegation.decisions[category]}
        onChange={(value) => updateDelegation(category, value as "human" | "orchestrator")}
      />)}
    </SettingsGroup>

    <SaveBar
      dirty={dirty}
      busy={busy}
      error={saveError}
      saveLabel="Save Defaults"
      blockedReason={controlPreview === "full_control" && !view.controlModeSupported ? "This version can't save Full Control as a default. Choose Custom to save."
        : invalidCount > 0 ? `Fix ${invalidCount} setting${invalidCount === 1 ? "" : "s"} to save` : null}
      onDiscard={discard}
      onSave={() => void save()}
    />
  </>;
}
