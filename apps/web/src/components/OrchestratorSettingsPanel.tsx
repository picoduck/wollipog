import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_LIVE_CHILD_LIMIT,
  WORKFLOW_DECISION_CATEGORIES,
  type OrchestratorDefaults,
  type OrchestratorSettingsView,
  type WorkflowDecisionCategory,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { effortLabel } from "../format.js";
import { SettingsGroup } from "./SettingsView.js";
import { SegmentedRow, SelectRow, StaticRow } from "./ui/SettingsRows.js";

const AUTO = "__automatic__";
const DECISION_LABELS: Record<WorkflowDecisionCategory, string> = {
  implementation_question: "Implementation Questions",
  pr_merge: "PR Merge Approval",
  merged_branch_deletion: "Merged Branch Deletion",
  follow_up_issue_publication: "Follow-Up Issue Publication",
  ui_evidence_approval: "UI Evidence Approval",
};

function unavailableError(caught: unknown): string {
  return caught instanceof Error && "status" in caught && (caught as Error & { status?: unknown }).status === 404
    ? "This control plane does not support Orchestrator settings. Update or restart it so it matches this dashboard, then try again."
    : caught instanceof Error ? caught.message : "Could not load Orchestrator settings.";
}

function cloneDefaults(defaults: OrchestratorDefaults): OrchestratorDefaults {
  return {
    behavior: { ...defaults.behavior },
    delegation: { ...defaults.delegation, decisions: { ...defaults.delegation.decisions } },
    execution: { ...defaults.execution },
  };
}

export function OrchestratorSettingsPanel({ discoveryRevision }: { discoveryRevision?: object } = {}) {
  const api = useApi();
  const [view, setView] = useState<OrchestratorSettingsView | null>(null);
  const [draft, setDraft] = useState<OrchestratorDefaults | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const draftDirty = useRef(false);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const next = await api.orchestratorSettings();
      if (generation.current !== current) return;
      setView(next);
      if (!draftDirty.current) setDraft(cloneDefaults(next.defaults));
    } catch (caught) {
      if (generation.current === current) setError(unavailableError(caught));
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
    return () => { generation.current += 1; };
  }, [load, discoveryRevision]);

  const updateBehavior = <K extends keyof OrchestratorDefaults["behavior"]>(
    key: K,
    value: OrchestratorDefaults["behavior"][K],
  ) => {
    draftDirty.current = true;
    setDraft((current) => current ? {
      ...current,
      behavior: { ...current.behavior, [key]: value },
    } : current);
  };
  const updateDelegation = (
    category: WorkflowDecisionCategory,
    authority: "human" | "orchestrator",
  ) => {
    draftDirty.current = true;
    setDraft((current) => current ? {
      ...current,
      delegation: {
        ...current.delegation,
        decisions: { ...current.delegation.decisions, [category]: authority },
      },
    } : current);
  };
  const updateExecution = (strictProjectIsolation: boolean) => {
    draftDirty.current = true;
    setDraft((current) => current ? {
      ...current,
      execution: { strictProjectIsolation },
    } : current);
  };

  const modelOptions = useMemo(() => {
    const options = [{ value: AUTO, label: "Automatic", description: "Choose from live child capabilities at creation time." }];
    for (const model of view?.capabilities.models ?? []) {
      options.push({ value: model.id, label: model.displayName ?? model.id, description: `Use ${model.displayName ?? model.id} for children by default.` });
    }
    const selected = draft?.behavior.childModel;
    if (selected && !options.some((option) => option.value === selected)) {
      options.push({ value: selected, label: `${selected} (Unavailable)`, description: "No current installation advertises this saved model." });
    }
    return options;
  }, [draft?.behavior.childModel, view?.capabilities.models]);
  const effortOptions = useMemo(() => {
    const options = [{ value: AUTO, label: "Automatic", description: "Let the selected child model choose its default effort." }];
    for (const effort of view?.capabilities.effortLevels ?? []) {
      options.push({ value: effort, label: effortLabel(effort), description: `Use ${effortLabel(effort)} effort for children by default.` });
    }
    const selected = draft?.behavior.childEffort;
    if (selected && !options.some((option) => option.value === selected)) {
      options.push({ value: selected, label: `${effortLabel(selected)} (Unavailable)`, description: "No current installation advertises this saved effort." });
    }
    return options;
  }, [draft?.behavior.childEffort, view?.capabilities.effortLevels]);
  const limitValid = !!draft && Number.isSafeInteger(draft.behavior.maximumConcurrentChildren) &&
    draft.behavior.maximumConcurrentChildren >= 0 && draft.behavior.maximumConcurrentChildren <= MAX_LIVE_CHILD_LIMIT;
  const fixedPairValid = !draft || (!draft.behavior.childModel && !draft.behavior.childEffort) ||
    (view?.capabilities.supportedPairs
      ? draft.behavior.childModel
        ? view.capabilities.supportedPairs.some((pair) => pair.modelId === draft.behavior.childModel &&
          (!draft.behavior.childEffort || pair.effortLevels.includes(draft.behavior.childEffort)))
        : view.capabilities.supportedPairs.some((pair) =>
          pair.effortLevels.includes(draft.behavior.childEffort!))
      : view?.capabilities.status === "available");

  const save = async () => {
    if (!draft || busy || !limitValid || !fixedPairValid) return;
    generation.current += 1;
    setBusy(true);
    setError(null);
    try {
      const next = await api.updateOrchestratorSettings({ defaults: draft });
      setView(next);
      setDraft(cloneDefaults(next.defaults));
      draftDirty.current = false;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save Orchestrator defaults.");
    } finally {
      setBusy(false);
    }
  };

  if (!draft) {
    return <SettingsGroup title="Behavior">
      <StaticRow
        title="Orchestrator Defaults"
        description={error ?? (loading ? "Loading Orchestrator defaults…" : "Orchestrator defaults are unavailable.")}
      />
      {error && <button type="button" className="btn ghost sm" onClick={() => void load()}>Retry</button>}
    </SettingsGroup>;
  }
  const capabilities = view!.capabilities;
  const source = view!.source;

  return <div className="orchestrator-settings" aria-busy={busy || loading || undefined}>
    <SettingsGroup title="Behavior">
      <p className="settings-group-intro">
        Defaults apply to new campaigns only. Each campaign stores its own effective policy.
      </p>
      <SelectRow
        title="Child Model"
        description="Automatic or a fixed capability-discovered model. Model and effort resolve independently."
        options={modelOptions}
        value={draft.behavior.childModel ?? AUTO}
        onChange={(value) => updateBehavior("childModel", value === AUTO ? null : value)}
      />
      <SelectRow
        title="Child Effort"
        description="Automatic or a fixed advertised effort, independently of Child Model."
        options={effortOptions}
        value={draft.behavior.childEffort ?? AUTO}
        onChange={(value) => updateBehavior("childEffort", value === AUTO ? null : value)}
      />
      <label className="orchestrator-number-row" htmlFor="orchestrator-max-children">
        <span className="ui-row-body">
          <span className="ui-row-title">Maximum Concurrent Children</span>
          <span className="ui-row-desc">Uses the existing live-child admission limit. Choose 0 to pause child admission.</span>
        </span>
        <input
          id="orchestrator-max-children"
          type="number"
          inputMode="numeric"
          min="0"
          max={String(MAX_LIVE_CHILD_LIMIT)}
          value={draft.behavior.maximumConcurrentChildren}
          aria-invalid={!limitValid}
          aria-describedby={!limitValid ? "orchestrator-max-children-error" : undefined}
          onChange={(event) => updateBehavior("maximumConcurrentChildren", Number(event.currentTarget.value))}
        />
      </label>
      {!limitValid && <p id="orchestrator-max-children-error" className="form-error" role="alert">Enter a whole number from 0 to {MAX_LIVE_CHILD_LIMIT}.</p>}
      <SegmentedRow
        title="Follow-Ups"
        options={[
          { value: "recommend_only", label: "Recommend Only", description: "Report justified follow-ups and wait for approval." },
          { value: "execute_approved", label: "Execute Approved", description: "Continue with follow-ups after their required approval." },
        ]}
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

    <SettingsGroup title="Execution Permissions">
      <p className="settings-group-intro">
        The Orchestrator role defaults to delegation. Execution permissions are a separate policy
        and apply only to new campaigns.
      </p>
      <SegmentedRow
        title="Strict Project Isolation"
        options={[
          {
            value: "disabled",
            label: "Disabled",
            description: "Use provider permissions and governance. Explicit parent implementation must use its own worktree.",
          },
          {
            value: "enabled",
            label: "Enabled",
            description: "Enforce the legacy scratch-only project boundary with a compatible isolation backend.",
          },
        ]}
        value={draft.execution.strictProjectIsolation ? "enabled" : "disabled"}
        onChange={(value) => updateExecution(value === "enabled")}
      />
      <StaticRow
        title="Effective Boundary"
        description={draft.execution.strictProjectIsolation
          ? "Project writes are blocked by operating-system or audited provider sandbox enforcement. Unsupported harness and isolation combinations are refused."
          : "Provider approval controls and repository governance still apply. Orchestrator mode does not claim operating-system read-only enforcement."}
      />
    </SettingsGroup>

    <SettingsGroup title="Decision Delegation">
      <p className="settings-group-intro">
        Human ownership is the default. Delegation changes apply only to new campaigns and never grant authority to existing sessions.
      </p>
      <SegmentedRow
        title="Descendant Requests"
        options={[
          { value: "off", label: "Human", description: "Keep descendant questions and ordinary approvals human-owned." },
          { value: "questions", label: "Questions", description: "Delegate non-secret descendant implementation questions." },
          { value: "questions_and_approvals", label: "Questions and Approvals", description: "Also delegate eligible one-time approvals." },
        ]}
        value={draft.delegation.parentControl}
        onChange={(value) => {
          draftDirty.current = true;
          setDraft((current) => current ? {
            ...current,
            delegation: { ...current.delegation, parentControl: value as OrchestratorDefaults["delegation"]["parentControl"] },
          } : current);
        }}
      />
      {WORKFLOW_DECISION_CATEGORIES.map((category) => <SegmentedRow
        key={category}
        title={DECISION_LABELS[category]}
        options={[
          { value: "human", label: "Human", description: "Require a human decision for this exact workflow gate." },
          { value: "orchestrator", label: "Orchestrator", description: "Allow the campaign Orchestrator to resolve this typed gate." },
        ]}
        value={draft.delegation.decisions[category]}
        onChange={(value) => updateDelegation(category, value as "human" | "orchestrator")}
      />)}
      <StaticRow
        title="Human-Only Decisions"
        description="Secrets, authentication, persistent permission grants, governance changes, cost budgets, and tool guardrails cannot be delegated. Change those controls as an authenticated human."
      />
    </SettingsGroup>

    {!fixedPairValid && <p className="form-error" role="alert">
      The fixed Child Model and Child Effort are not supported together by a current installation. Choose Automatic or another advertised combination.
    </p>}
    {fixedPairValid && capabilities.status === "unavailable" && <p className="form-error" role="alert">{capabilities.reason}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="orchestrator-settings-actions">
      <span className="muted">Current Source: {source === "user_default" ? "User Default" : "Wollipog Default"}</span>
      <button type="button" className="btn primary" disabled={busy || !limitValid || !fixedPairValid} onClick={() => void save()}>
        {busy ? "Saving…" : "Save Defaults"}
      </button>
    </div>
  </div>;
}
