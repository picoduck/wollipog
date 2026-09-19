import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_LIVE_CHILD_LIMIT,
  WORKFLOW_DECISION_CATEGORIES,
  agentHarnessIdentityKey,
  type OrchestratorDefaults,
  type OrchestratorSettingsView,
  type WorkflowDecisionCategory,
} from "@wollipog/protocol";
import { agentHarnessOptionLabel } from "../agent-presentation.js";
import { useApi } from "../api-context.js";
import { effortLabel } from "../format.js";
import {
  ORCHESTRATOR_PRESET_INTEGRATION_DISCLOSURE,
  INTEGRATION_ISOLATION_BY_HARNESS,
  INTEGRATION_ISOLATION_CONTROL_PLANE_REQUIRED,
  INTEGRATION_ISOLATION_PRESERVED,
  controlPlaneSupportsIntegrationIsolation,
} from "../session-preset-defaults.js";
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
  const updateExecution = <Key extends keyof OrchestratorDefaults["execution"]>(
    key: Key,
    value: OrchestratorDefaults["execution"][Key],
  ) => {
    draftDirty.current = true;
    setDraft((current) => current ? {
      ...current,
      execution: { ...current.execution, [key]: value },
    } : current);
  };

  // Strict Project Isolation's harness shapes carry no user integration at all, so the settings
  // panel shows the value those launches actually have rather than the one stored underneath it.
  const integrationIsolationImplied = draft?.execution.strictProjectIsolation === true;
  // An older control plane's update parser rejects a defaults payload carrying this key, so the
  // control is disabled there. The draft is a plain spread of the served payload, so a save from
  // this panel round-trips WITHOUT the field and every unrelated default stays saveable.
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
        : "Update the control plane to configure a fixed Child Harness.",
    }];
    for (const harness of harnesses) {
      options.push({
        value: agentHarnessIdentityKey(harness),
        label: harness.installations > 0 ? agentHarnessOptionLabel(harness) : `${agentHarnessOptionLabel(harness)} (Unavailable)`,
        description: harness.installations > 0
          ? `${harness.installations} current installation${harness.installations === 1 ? "" : "s"}.`
          : "No current installation advertises this saved Agent Harness. Connect it or choose Automatic.",
      });
    }
    return options;
  }, [harnessPolicySupported, harnesses]);
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
        title="Child Harness"
        description={harnessPolicySupported
          ? "Automatic or a fixed stable Agent Harness identity. Execution context is part of the identity."
          : "Fixed Child Harness policy is unavailable on this control plane. Update or restart it to enable this control."}
        options={harnessOptions}
        value={selectedHarness ? agentHarnessIdentityKey(selectedHarness) : AUTO}
        disabled={!harnessPolicySupported}
        onChange={(value) => {
          const childHarness = value === AUTO
            ? null
            : (() => {
              const harness = harnesses.find((candidate) => agentHarnessIdentityKey(candidate) === value);
              return harness ? { agentId: harness.agentId, driver: harness.driver, context: harness.context } : null;
            })();
          draftDirty.current = true;
          setDraft((current) => current ? {
            ...current,
            behavior: { ...current.behavior, childHarness, childModel: null, childEffort: null },
          } : current);
        }}
      />
      <SelectRow
        title="Child Model"
        description="Automatic or a model advertised through a compatible Child Harness."
        options={modelOptions}
        value={draft.behavior.childModel ?? AUTO}
        onChange={(value) => {
          const childModel = value === AUTO ? null : value;
          const effortCompatible = !draft.behavior.childEffort || candidateHarnesses.some((harness) =>
            childModel
              ? harness.supportedPairs.some((pair) => pair.modelId === childModel &&
                pair.effortLevels.includes(draft.behavior.childEffort!))
              : harness.effortLevels.includes(draft.behavior.childEffort!));
          draftDirty.current = true;
          setDraft((current) => current ? {
            ...current,
            behavior: { ...current.behavior, childModel, ...(!effortCompatible ? { childEffort: null } : {}) },
          } : current);
        }}
      />
      <SelectRow
        title="Child Effort"
        description="Automatic or an effort advertised for the selected harness and model combination."
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
        onChange={(value) => updateExecution("strictProjectIsolation", value === "enabled")}
      />
      <StaticRow
        title="Effective Boundary"
        description={draft.execution.strictProjectIsolation
          ? "Project writes are blocked by operating-system or audited provider sandbox enforcement. Unsupported harness and isolation combinations are refused."
          : "Provider approval controls and repository governance still apply. Orchestrator mode does not claim operating-system read-only enforcement."}
      />
      <SegmentedRow
        title="Integration Isolation"
        options={[
          {
            value: "disabled",
            label: "Disabled",
            description: "Load the same integrations as a normal session with the selected harness.",
          },
          {
            value: "enabled",
            label: "Enabled",
            // Account defaults have no selected harness, so the pill states the shared promise and
            // the row below it carries the per-harness differences.
            description: "Launch with Wollipog's management tools as the only integration.",
          },
        ]}
        // Strict Project Isolation already launches without any provider integration, so the value
        // it implies is shown here rather than the stored one, and the control cannot contradict it.
        value={integrationIsolationImplied || draft.execution.integrationIsolation ? "enabled" : "disabled"}
        disabled={integrationIsolationImplied || !integrationIsolationSupported}
        disabledReason={integrationIsolationImplied
          ? "Strict Project Isolation already launches without provider integrations."
          : !integrationIsolationSupported
            ? INTEGRATION_ISOLATION_CONTROL_PLANE_REQUIRED
            : undefined}
        onChange={(value) => updateExecution("integrationIsolation", value === "enabled")}
      />
      <StaticRow
        title="Effective Integrations"
        description={!integrationIsolationSupported
          ? INTEGRATION_ISOLATION_CONTROL_PLANE_REQUIRED
          : integrationIsolationImplied
          ? `Strict Project Isolation already launches without provider integrations, so Integration Isolation is implied and cannot be disabled. ${ORCHESTRATOR_PRESET_INTEGRATION_DISCLOSURE}`
          : draft.execution.integrationIsolation
            ? `${INTEGRATION_ISOLATION_BY_HARNESS} ${INTEGRATION_ISOLATION_PRESERVED}`
            : "Hooks, plugins, extensions, skills, and configured MCP servers load exactly as they would for a normal session."}
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
          { value: "orchestrator", label: "Orchestrator", description: category === "ui_evidence_approval"
            ? "Let the campaign Orchestrator see each evidence image and resolve this gate. Takes effect only when its runner, harness, and model can inspect images and the evidence is an image attached as a Session artifact. Video, externally stored evidence, and unsupported clients are still routed to a human, and the campaign shows why."
            : "Allow the campaign Orchestrator to resolve this typed gate." },
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
      The fixed Child Harness, Child Model, and Child Effort are not supported together by a current installation. Choose Automatic or another advertised combination.
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
