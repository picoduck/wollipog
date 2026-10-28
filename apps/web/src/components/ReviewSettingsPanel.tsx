import { useEffect, useRef, useState } from "react";
import { agentHarnessIdentityKey, canonicalAgentHarnessIdentity, reviewerHarnessFor, sameReviewFamily,
  type ReviewSettings, type ReviewSettingsView, type ReviewReviewerRule } from "@wollipog/protocol";
import { useLeaveGuard } from "../leave-guard.js";
import { useFeedback } from "./FeedbackProvider.js";
import { useApi } from "../api-context.js";
import { Notice } from "./Notice.js";
import { SaveBar } from "./SaveBar.js";
import { useSettingsPanelHead } from "./SettingsView.js";
import { ActionRow, NumberRow, SelectRow, SettingsGroup, StaticRow, SwitchRow } from "./ui/SettingsRows.js";

const AUTO = "__automatic__";
const automatic = [{ value: AUTO, label: "Automatic" }];

export function ReviewSettingsPanel() {
  const api = useApi();
  const { confirm } = useFeedback();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [view, setView] = useState<ReviewSettingsView | null>(null);
  const [draft, setDraft] = useState<ReviewSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const dirty = !!view && !!draft && JSON.stringify(view.settings) !== JSON.stringify(draft);
  useLeaveGuard(dirty || busy, leave => {
    if (busy) return;
    void confirm({ title: "Discard Changes", message: "Your review settings have unsaved changes. Discarding them keeps the saved settings.",
      confirmLabel: "Discard Changes", cancelLabel: "Keep Editing", tone: "danger" }).then(discard => { if (discard && alive.current) leave(); });
  });
  useSettingsPanelHead({ description: "Choose who reviews your sessions and how many rounds they can use.",
    meta: !view ? null : view.source === "project_override" ? "Project Override" : view.source === "user_default" ? "Your Defaults" : "Wollipog Defaults" });
  useEffect(() => {
    let alive = true;
    setView(null); setDraft(null); setError(null);
    api.reviewSettings(projectId).then(value => { if (alive) { setView(value); setDraft(structuredClone(value.settings)); } },
      reason => { if (alive) setError(reason instanceof Error ? reason.message : "Review settings could not be loaded."); });
    return () => { alive = false; };
  }, [api, projectId, reload]);
  const save = async (settings: ReviewSettings | null) => {
    setBusy(true); setError(null);
    try { const value = await api.updateReviewSettings(projectId, settings); setView(value); setDraft(structuredClone(value.settings)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Review settings could not be saved."); }
    finally { setBusy(false); }
  };
  if (!view || !draft) return error ? <Notice tone="danger" title="Reviews Unavailable" actions={<button className="btn" onClick={() => setReload(r => r + 1)}>Try Again</button>}>{error}</Notice>
    : <p role="status">Loading review settings…</p>;
  const invalidBudget = !Number.isSafeInteger(draft.roundBudget) || draft.roundBudget < 1 || draft.roundBudget > 32;
  const sameFamily = draft.reviewers.some(r => !r.allowSameFamily && sameReviewFamily(r.implementer.driver, null, r.harness, r.model));
  const problem = invalidBudget ? "Enter a whole round budget from 1 to 32." : sameFamily
    ? "A reviewer belongs to the implementer's model family. Explicitly allow same-family reviews or choose another reviewer." : null;
  const changeRule = (rule: ReviewReviewerRule, patch: Partial<ReviewReviewerRule>) => setDraft(current => current && ({ ...current,
    reviewers: [...current.reviewers.filter(r => agentHarnessIdentityKey(r.implementer) !== agentHarnessIdentityKey(rule.implementer)), { ...rule, ...patch }] }));
  return <>
    <SettingsGroup title="Review Scope">
      <SelectRow title="Project" value={projectId ?? AUTO} options={[{ value: AUTO, label: "Your Defaults" }, ...view.projects.map(p => ({ value: p.id, label: p.name }))]}
        disabled={dirty || busy} disabledReason="Save or discard your changes before switching projects." onChange={id => setProjectId(id === AUTO ? null : id)} />
      <StaticRow title={projectId ? view.source === "project_override" ? "Own Review Settings" : "Inherits Your Settings" : "Your Review Settings"}
        description={projectId ? view.source === "project_override"
          ? "This project's settings replace all of your review defaults. Changes apply only to your sessions in this project."
          : "This project uses your review defaults. Editing starts with a copy of your current settings and replaces them for this project."
          : "These settings follow your account across devices and machines. Projects can override them."} />
      <ActionRow title={projectId ? "Reset to User Settings" : "Reset to Built-In Defaults"}
        actionLabel={projectId ? "Reset to User Settings" : "Reset Defaults"} disabled={busy}
        description={projectId ? "Remove this override and inherit your current review defaults." : "Use the opposite model family at high effort, with four valid rounds."}
        onAction={() => void save(null)} />
    </SettingsGroup>
    <SettingsGroup title="Round Budget">
      <NumberRow title="Valid Rounds" min={1} max={32} step={1} value={Number.isNaN(draft.roundBudget) ? "" : draft.roundBudget}
        disabled={busy} description="One budget for every implementing harness. Existing review runs keep their original budget."
        error={invalidBudget ? problem : null} onChange={value => setDraft({ ...draft, roundBudget: value === "" ? NaN : Number(value) })} />
    </SettingsGroup>
    {view.reviewers.length === 0 && <Notice tone="warning" title="Reviewers Unavailable">Connect a machine that supports configurable reviews and discovers reviewer models.</Notice>}
    {view.implementers.map(implementer => {
      const rule: ReviewReviewerRule = draft.reviewers.find(r => agentHarnessIdentityKey(r.implementer) === agentHarnessIdentityKey(implementer)) ?? {
        implementer: canonicalAgentHarnessIdentity(implementer), harness: reviewerHarnessFor(implementer.driver) ?? "codex", model: null, effort: null, allowSameFamily: false,
      };
      const installations = view.reviewers.filter(r => r.harness === rule.harness);
      const models = new Map(installations.flatMap(r => r.capabilities.models.filter(m => !m.hidden && m.id !== "default").map(m => [m.id, m])));
      const efforts = [...new Set(installations.flatMap(r => {
        const model = r.capabilities.models.find(m => m.id === rule.model);
        return model?.efforts?.length ? model.efforts : r.capabilities.effortLevels;
      }))];
      const harnesses = [...new Map(view.reviewers.map(r => [r.harness, { value: r.harness, label: r.name }])).values()];
      if (!harnesses.some(h => h.value === rule.harness)) harnesses.push({ value: rule.harness, label: `${rule.harness === "codex" ? "Codex" : "Claude Code"} (Unavailable)` });
      const refused = !rule.allowSameFamily && sameReviewFamily(implementer.driver, null, rule.harness, rule.model);
      return <SettingsGroup key={agentHarnessIdentityKey(implementer)} title={`${implementer.name} Reviewer`}
        intro={`Reviews sessions implemented with ${implementer.name}${implementer.context.kind === "wsl" ? ` in WSL ${implementer.context.distro}` : ""}.`}>
        <SelectRow title="Reviewer Harness" options={harnesses} value={rule.harness} disabled={busy}
          error={refused ? "This reviewer belongs to the implementer's model family. Choose another harness or explicitly allow it below." : null}
          onChange={harness => changeRule(rule, { harness: harness as ReviewReviewerRule["harness"], model: null, effort: null })} />
        <SelectRow title="Reviewer Model" value={rule.model ?? AUTO} disabled={busy}
          options={[...automatic, ...[...models.values()].map(m => ({ value: m.id, label: m.displayName ?? m.id })),
            ...(rule.model && !models.has(rule.model) ? [{ value: rule.model, label: `${rule.model} (Unavailable)` }] : [])]}
          description="Automatic uses the selected reviewer's discovered default model. A missing configured model refuses the review."
          onChange={model => changeRule(rule, { model: model === AUTO ? null : model, effort: null })} />
        <SelectRow title="Reviewer Effort" value={rule.effort ?? AUTO} disabled={busy}
          options={[...automatic, ...efforts.map(e => ({ value: e, label: e.charAt(0).toUpperCase() + e.slice(1) })),
            ...(rule.effort && !efforts.includes(rule.effort) ? [{ value: rule.effort, label: `${rule.effort} (Unavailable)` }] : [])]}
          description="Automatic uses high effort." onChange={effort => changeRule(rule, { effort: effort === AUTO ? null : effort })} />
        <SwitchRow title="Allow Same-Family Reviews" checked={rule.allowSameFamily} disabled={busy}
          description="Explicitly permit a reviewer from the implementing model's family. Otherwise the review is refused."
          onClick={() => changeRule(rule, { allowSameFamily: !rule.allowSameFamily })} />
      </SettingsGroup>;
    })}
    <SaveBar dirty={dirty} busy={busy} error={error} blockedReason={problem} saveLabel={projectId ? "Save Project Override" : "Save Defaults"}
      onDiscard={() => { setDraft(structuredClone(view.settings)); setError(null); }} onSave={() => void save(draft)} />
  </>;
}
