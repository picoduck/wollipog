import { useEffect, useState } from "react";
import {
  DEFAULT_ORCHESTRATOR_DEFAULTS,
  agentHarnessIdentityKey,
  type OrchestratorCampaignBehavior,
  type OrchestratorCampaignBehaviorView,
  type OrchestratorDefaults,
  type SessionView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { ApiError } from "../api.js";
import {
  AUTOMATIC_ORCHESTRATOR_VALUE,
  COMPLETION_OPTIONS,
  FOLLOW_UP_OPTIONS,
  evaluateOrchestratorPolicy,
  withChildHarness,
  withChildModel,
  type OrchestratorPolicyContext,
  type OrchestratorPolicyDraft,
  type OrchestratorPolicyPath,
} from "../orchestrator-policy.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { SegmentedRow, SelectRow, SettingsGroup } from "./ui/SettingsRows.js";

export const CAMPAIGN_BEHAVIOR_CONFLICT = "Campaign Behavior changed elsewhere, so your change wasn't saved. The current values are shown.";
export const CAMPAIGN_BEHAVIOR_FAILED = "Your change wasn't saved.";
export const CAMPAIGN_BEHAVIOR_SCOPE = "Changes apply to children created from now on. Children already running keep their harness, model and effort.";
/** Under Full Control, how Follow-Ups relates to the follow-up limit #3826 made an approval
 * threshold: this editor never changes the limit, which Campaign Status edits as Follow-Ups Without
 * Approval. `limit` is the campaign allowance's current one; `null` is No Limit. */
export function campaignBehaviorFullControlNote(limit: number | null | undefined): string {
  const current = limit === undefined ? "" : limit === null ? " (now No Limit)" : ` (now ${limit})`;
  return `Full Control stays as you authorized it: these changes don't alter Follow-Ups Without Approval${current} or ` +
    "Maximum Issues. Past that limit, each follow-up waits for your approval. Change the limit in Campaign Status.";
}

const EDITED_PATHS: readonly OrchestratorPolicyPath[] = [
  "behavior.childHarness", "behavior.childModel", "behavior.childEffort", "behavior.followUps", "behavior.completion",
];

/**
 * New Session's Orchestrator Policy evaluation (#2955), pointed at a running campaign (#3580): the
 * campaign's current values stand where the person's defaults would, so the rows offer the same
 * choices, capability discovery and problems, and "changed" means changed from what the campaign
 * runs with now. Only the Orchestrator's own runner decides whether a fixed Child Harness is
 * supported; nothing here is about the Orchestrator's own launch.
 */
function editorContext(view: OrchestratorCampaignBehaviorView, session: SessionView, keepsRetainedRow = false): OrchestratorPolicyContext {
  const policy = session.orchestratorPolicy!;
  const defaults: OrchestratorDefaults = {
    behavior: { ...policy.behavior, ...structuredClone(view.behavior) },
    delegation: policy.delegation,
    execution: policy.execution ?? DEFAULT_ORCHESTRATOR_DEFAULTS.execution,
  };
  return {
    view: { defaults, source: "user_default", capabilities: keepsRetainedRow && view.retainedRow
      ? { ...view.capabilities, harnesses: view.capabilities.harnesses?.map((harness) =>
        agentHarnessIdentityKey(harness) === agentHarnessIdentityKey(view.retainedRow!) ? view.retainedRow! : harness) }
      : view.capabilities },
    machine: "the Orchestrator's machine",
    runnerProtocolVersion: view.runnerProtocolVersion,
    driver: session.driver,
    hostExecutionTarget: false,
    agentOffersOrchestratorPreset: false,
    strictProjectBoundaryAvailable: true,
    providerExecutionAvailable: true,
    presetReason: () => undefined,
  };
}

function draftFrom(context: OrchestratorPolicyContext): OrchestratorPolicyDraft {
  const values = structuredClone(context.view.defaults);
  return { values, controlMode: "custom", limitText: String(values.behavior.maximumConcurrentChildren) };
}

function editedBehavior(draft: OrchestratorPolicyDraft): OrchestratorCampaignBehavior {
  const { childHarness, childModel, childEffort, followUps, completion } = draft.values.behavior;
  return { childHarness, childModel, childEffort, followUps, completion };
}

function sameChild(left: OrchestratorCampaignBehavior, right: OrchestratorCampaignBehavior): boolean {
  const harness = (value: OrchestratorCampaignBehavior["childHarness"]) => value ? agentHarnessIdentityKey(value) : null;
  return harness(left.childHarness) === harness(right.childHarness) && left.childModel === right.childModel &&
    left.childEffort === right.childEffort;
}

function sameBehavior(left: OrchestratorCampaignBehavior, right: OrchestratorCampaignBehavior): boolean {
  return sameChild(left, right) && left.followUps === right.followUps && left.completion === right.completion;
}

/**
 * Campaign Behavior's edit form (#3580): Child Harness, Child Model, Child Effort, Follow-Ups and
 * Completion for a running root campaign, saved together against the revision the form loaded. A
 * conflict reloads the current values rather than replaying the person's choice over someone else's.
 */
export function CampaignBehaviorEditor({ session, fullControl, onCancel, onSaved }: {
  session: SessionView;
  fullControl: boolean;
  onCancel: () => void;
  onSaved: (session: SessionView) => void;
}) {
  const api = useApi();
  const [loaded, setLoaded] = useState<{ view: OrchestratorCampaignBehaviorView } | null>(null);
  const [draft, setDraft] = useState<OrchestratorPolicyDraft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; detail?: string } | null>(null);

  const take = (view: OrchestratorCampaignBehaviorView) => {
    setLoaded({ view });
    setDraft(draftFrom(editorContext(view, session)));
  };

  useEffect(() => {
    const controller = new AbortController();
    api.campaignBehavior(session.id, controller.signal).then(take, (cause: unknown) => {
      if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => controller.abort();
    // Loaded once per opening: a reload replaces the person's unsaved choices only after a conflict.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, session.id]);

  if (loadError !== null) {
    return <div className="campaign-behavior-edit">
      <Notice tone="danger" role="alert" title="Couldn't Load Campaign Behavior">{loadError}</Notice>
      <div className="actions"><button type="button" className="btn" onClick={onCancel}>Cancel</button></div>
    </div>;
  }
  if (!loaded || !draft) return <p className="section-note" role="status">Loading the campaign's current values…</p>;

  const { view } = loaded;
  // An exact-row campaign's harness offers only what its kept row does, but only while the change
  // keeps that harness: Automatic and every other harness use the full catalog (CR-2.1, CR-3.1).
  const draftHarness = draft.values.behavior.childHarness;
  const keepsRetainedRow = Boolean(view.retainedRow && draftHarness &&
    agentHarnessIdentityKey(draftHarness) === agentHarnessIdentityKey(view.retainedRow));
  const context = editorContext(view, session, keepsRetainedRow);
  const budget = session.orchestratorCampaign?.budget;
  const evaluation = evaluateOrchestratorPolicy(context, draft);
  const next = editedBehavior(draft);
  const unchanged = sameBehavior(next, view.behavior);
  // The server checks a child combination only when it changes, and never an all-Automatic one, so
  // the form does the same: when the machines offering the stored combination are offline, Follow-Ups
  // and Completion still save, and so does Automatic (CR-1.3).
  const checksChild = !sameChild(next, view.behavior) &&
    (next.childHarness !== null || next.childModel !== null || next.childEffort !== null);
  const problemFor = (path: OrchestratorPolicyPath) => checksChild
    ? evaluation.problems.find((problem) => problem.path === path)?.message ?? null : null;
  const blocked = EDITED_PATHS.some((path) => problemFor(path) !== null);
  const setBehavior = <K extends "childEffort" | "followUps" | "completion">(key: K, value: OrchestratorDefaults["behavior"][K]) =>
    setDraft((current) => current && ({ ...current, values: { ...current.values, behavior: { ...current.values.behavior, [key]: value } } }));

  const save = async () => {
    if (saving || unchanged || blocked) return;
    setSaving(true);
    setFailure(null);
    try {
      onSaved(await api.setCampaignBehavior(session.id, { expectedRevision: view.revision, behavior: next }));
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      const fresh = cause instanceof ApiError && cause.status === 409
        ? await api.campaignBehavior(session.id).catch(() => null) : null;
      if (fresh && fresh.revision !== view.revision) {
        // Someone else changed it: show what the campaign runs with now, not this form's guess.
        take(fresh);
        setFailure({ message: CAMPAIGN_BEHAVIOR_CONFLICT, detail });
      } else {
        setFailure({ message: cause instanceof ApiError && cause.status === 409 ? detail : CAMPAIGN_BEHAVIOR_FAILED,
          ...(cause instanceof ApiError && cause.status === 409 ? {} : { detail }) });
      }
      setSaving(false);
    }
  };

  return (
    <form className="campaign-behavior-edit" aria-label="Edit Campaign Behavior" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <SettingsGroup
        intro={CAMPAIGN_BEHAVIOR_SCOPE}
        notice={failure ? <Notice tone="danger" role="alert" details={failure.detail ? <p>{failure.detail}</p> : undefined}>{failure.message}</Notice> : undefined}
        foot={fullControl ? campaignBehaviorFullControlNote(budget ? budget.authority.acceptedFollowUps ?? null : undefined) : undefined}
      >
        <SelectRow
          title="Child Harness"
          description="The agent that runs each child."
          options={evaluation.harness.options}
          value={evaluation.harness.value}
          disabled={saving || evaluation.harness.disabled}
          disabledReason={evaluation.harness.disabledReason}
          error={problemFor("behavior.childHarness")}
          onChange={(value) => setDraft((current) => current && withChildHarness(current, context.view, value))}
        />
        <SelectRow
          title="Child Model"
          description="Automatic lets each child's agent choose."
          options={evaluation.model.options}
          value={evaluation.model.value}
          disabled={saving}
          error={problemFor("behavior.childModel")}
          onChange={(value) => setDraft((current) => current && withChildModel(current, context.view, value))}
        />
        <SelectRow
          title="Child Effort"
          description="Automatic uses the model's own default."
          options={evaluation.effort.options}
          value={evaluation.effort.value}
          disabled={saving}
          error={problemFor("behavior.childEffort")}
          onChange={(value) => setBehavior("childEffort", value === AUTOMATIC_ORCHESTRATOR_VALUE ? null : value)}
        />
        <SelectRow
          title="Follow-Ups"
          description={FOLLOW_UP_OPTIONS.find((option) => option.value === draft.values.behavior.followUps)?.description}
          options={FOLLOW_UP_OPTIONS}
          value={draft.values.behavior.followUps}
          disabled={saving}
          onChange={(value) => setBehavior("followUps", value as OrchestratorDefaults["behavior"]["followUps"])}
        />
        <SegmentedRow
          title="Completion"
          options={COMPLETION_OPTIONS}
          value={draft.values.behavior.completion}
          disabled={saving}
          onChange={(value) => setBehavior("completion", value as OrchestratorDefaults["behavior"]["completion"])}
        />
      </SettingsGroup>
      <div className="actions">
        <button type="button" className="btn" disabled={saving} onClick={onCancel}>Cancel</button>
        <BusyButton type="submit" className="btn primary" busy={saving} progress="Saving campaign behavior…" disabled={unchanged || blocked}>
          Save Changes
        </BusyButton>
      </div>
    </form>
  );
}
