import { useId, useState, type ReactNode } from "react";
import {
  ASSISTANT_DECISION_CATEGORIES,
  ASSISTANT_DECISION_DEFAULT_DURATIONS,
  ASSISTANT_EVIDENCE_RETENTION_DISCLOSURE,
  sessionRole,
  type AssistantDecisionCategory,
  type AssistantDecisionDefault,
  type AssistantDecisionDelegation,
  type AssistantDecisionGrant,
  type AssistantEvidenceReviewAvailability,
} from "@wollipog/protocol";
import { useStoreSelector } from "../store.js";
import {
  ASSISTANT_DECISION_GROUPS,
  DELEGATION_EXPIRY_OPTIONS,
  DEFAULT_DELEGATION_EXPIRY_OPTIONS,
  defaultDelegationExpiry,
  delegationExpiryAt,
  formatAssistantDelegationSummary,
  formatDelegationExpiryHelp,
  isDefaultDelegationExpiry,
  type DelegationExpiry,
} from "../assistant-decision-delegation.js";
import { useTimelineClock } from "../timeline-clock.js";
import { useFeedback } from "./FeedbackProvider.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Checkbox, SegmentedControl } from "./ui/ChoiceControls.js";

type Scope = AssistantDecisionGrant["projects"];
type ScopeItem = { id: string; title: string };
type Mode = "ask" | "all" | "choose";
const modes = [
  { value: "ask", label: "Ask Me" },
  { value: "all", label: "Delegate All" },
  { value: "choose", label: "Choose" },
] as const;

function SelectionScope({ name, value, items, onChange }: {
  name: "Projects" | "Campaigns";
  value: Scope;
  items: ScopeItem[];
  onChange: (value: Scope) => void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const picked = value === "all" ? [] : value;
  const titles = new Map(items.map(({ id, title }) => [id, title]));
  const choices = [...new Set([...picked, ...titles.keys()])].filter((id) =>
    (titles.get(id) ?? id).toLowerCase().includes(query.trim().toLowerCase()));
  const pageSize = 5;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(choices.length / pageSize) - 1));
  const start = currentPage * pageSize;
  const shown = choices.slice(start, start + pageSize);
  const scopeLabel = name === "Projects" ? "Project Scope" : "Campaign Scope";
  return <fieldset className="assistant-fields form">
    <legend>{name}</legend>
    <SegmentedControl label={scopeLabel} className="delegation-scope-choice" value={value === "all" ? "all" : "selected"} options={[
      { value: "all", label: `All ${name}` }, { value: "selected", label: `Selected ${name}` },
    ]} onChange={(next) => {
      if (next === (value === "all" ? "all" : "selected")) return;
      setQuery("");
      setPage(0);
      onChange(next === "all" ? "all" : []);
    }} />
    {value !== "all" && <>
      <label className="field">
        <span>Filter {name}</span>
        <input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
      </label>
      <div className="assistant-decision-choices">
        {choices.length === 0 && <p className="muted">No matching {name.toLowerCase()}.</p>}
        {shown.map((id) => <Checkbox key={id} label={titles.get(id) ?? id}
          checked={picked.includes(id)} onChange={(checked) => onChange(checked ? [...picked, id] : picked.filter((item) => item !== id))} />)}
      </div>
      {choices.length > pageSize && <>
        <p className="muted">Showing {start + 1}–{start + shown.length} of {choices.length} {name.toLowerCase()}.</p>
        <div className="assistant-decision-pagination">
          <button type="button" className="btn" disabled={start === 0} onClick={() => setPage(currentPage - 1)}>Previous {name}</button>
          <button type="button" className="btn" disabled={start + pageSize >= choices.length} onClick={() => setPage(currentPage + 1)}>Next {name}</button>
        </div>
      </>}
    </>}
  </fieldset>;
}

function localDateTime(timestamp: number | null | undefined): string {
  if (timestamp == null) return "";
  const date = new Date(timestamp);
  return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function CategoryGroup({ label, categories, selected, unavailable, disclosure, onToggle, evidenceConsent }: {
  label: string;
  categories: readonly AssistantDecisionCategory[];
  selected: readonly AssistantDecisionCategory[];
  unavailable: Partial<Record<AssistantDecisionCategory, string>>;
  disclosure: string | undefined;
  onToggle: (categories: readonly AssistantDecisionCategory[], checked: boolean) => void;
  evidenceConsent: ReactNode;
}) {
  const enabled = categories.filter((category) => !unavailable[category]);
  const count = categories.filter((category) => selected.includes(category)).length;
  const all = enabled.length > 0 && enabled.every((category) => selected.includes(category));
  return <fieldset className="assistant-fields delegation-group" aria-label={label}>
    <Checkbox className="delegation-group-toggle" label={label} checked={count === categories.length}
      indeterminate={count > 0 && count < categories.length} helper={`${count} of ${categories.length}`}
      disabled={!enabled.length} onChange={() => onToggle(enabled, !all)} />
    {categories.map((category) => {
      const checked = selected.includes(category);
      const review = category === "ui_evidence_review";
      return <div key={category} className="delegation-category">
        <Checkbox label={ASSISTANT_DECISION_CATEGORIES[category]} checked={checked}
          disabled={Boolean(unavailable[category]) && !checked}
          helper={unavailable[category] ?? (review && checked ? disclosure : undefined)}
          onChange={(next) => onToggle([category], next)} />
        {review && checked && evidenceConsent}
      </div>;
    })}
  </fieldset>;
}

type DelegationEditorProps = { onClose: () => void } & (
  | {
    delegation: AssistantDecisionDelegation;
    evidenceReview?: AssistantEvidenceReviewAvailability;
    onSave: (value: AssistantDecisionDelegation) => Promise<void>;
  }
  | {
    defaultGrant: AssistantDecisionDefault | null;
    onSaveDefault: (grant: AssistantDecisionDefault | null) => Promise<void>;
  }
);

export function AssistantDecisionDelegationDialog(props: DelegationEditorProps) {
  const { onClose } = props;
  const isDefault = "defaultGrant" in props;
  const threadGrant = isDefault ? null : props.delegation.grant;
  const grant = isDefault ? props.defaultGrant : threadGrant;
  const evidenceReview = isDefault ? undefined : props.evidenceReview;
  const form = useId();
  const expiryHelp = useId();
  const { confirm } = useFeedback();
  const projects = useStoreSelector((state) => state.projects);
  const sessions = useStoreSelector((state) => state.sessions);
  const now = useTimelineClock(threadGrant?.expiresAt != null);
  const [mode, setMode] = useState<Mode>(grant ? grant.selectionMode ?? "choose" : "ask");
  const [categories, setCategories] = useState(grant?.categories ?? []);
  // An existing Delegate All grant is an explicit snapshot. Only selecting the mode again
  // enumerates today's categories, so editing a scope or expiry after an upgrade cannot add one.
  const [refreshAll, setRefreshAll] = useState(false);
  const [acceptedDigest, setAcceptedDigest] = useState(threadGrant?.evidenceDisclosureDigest);
  const [projectScope, setProjectScope] = useState<Scope>(grant?.projects ?? "all");
  const [campaignScope, setCampaignScope] = useState<Scope>(grant?.campaigns ?? "all");
  const [preset, setPreset] = useState<DelegationExpiry>("defaultGrant" in props && props.defaultGrant
    ? defaultDelegationExpiry(props.defaultGrant.expiresAfterMs)?.value ?? "week"
    : threadGrant ? threadGrant.expiresAt === null ? "never" : "custom" : "week");
  const [customTime, setCustomTime] = useState(localDateTime(threadGrant?.expiresAt));
  const [expiryStart, setExpiryStart] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const ciRerunSupported = useStoreSelector((state) => state.assistantCiRerunDecisionsSupported);
  const releaseSupported = useStoreSelector((state) => state.assistantReleaseDecisionsSupported);
  const [error, setError] = useState<string | null>(null);
  const expired = threadGrant?.expiresAt != null && threadGrant.expiresAt <= now;
  const digest = evidenceReview?.available ? evidenceReview.disclosureDigest : undefined;
  const disclosed = digest !== undefined && acceptedDigest === digest;
  const disclosure = evidenceReview?.available
    ? `${evidenceReview.provider} · ${evidenceReview.model}. ${ASSISTANT_EVIDENCE_RETENTION_DISCLOSURE}`
    : undefined;
  const unavailable: Partial<Record<AssistantDecisionCategory, string>> = {};
  if (!ciRerunSupported) unavailable.ci_rerun = "Update the control plane to grant CI rerun decisions.";
  if (!releaseSupported) {
    unavailable.release_tag = "Update the control plane to grant release tag decisions.";
    unavailable.release_publish = "Update the control plane to grant release publication decisions.";
  }
  if (!evidenceReview?.available) {
    unavailable.ui_evidence_review = isDefault
      ? "Approving UI evidence requires accepting the provider disclosure in each thread."
      : evidenceReview?.reason ?? "This control plane does not support approving UI evidence.";
  }
  const allCategories = Object.keys(ASSISTANT_DECISION_CATEGORIES) as AssistantDecisionCategory[];
  const allCandidates = refreshAll ? allCategories : categories;
  const selected = (mode === "all" ? allCandidates : categories).filter((category) => {
    if (category === "ui_evidence_review" && mode === "all") return disclosed;
    // Retain an existing category when editing a saved grant on an older control plane.
    // Selecting Delegate All explicitly starts a fresh list of available categories.
    return !unavailable[category] || ((mode !== "all" || !refreshAll) && Boolean(grant?.categories.includes(category)));
  });
  const evidenceSelected = selected.includes("ui_evidence_review");
  const evidenceConsent = disclosure && <Checkbox label="I accept the provider disclosure." consent checked={disclosed}
    onChange={(checked) => {
      setAcceptedDigest(checked ? digest : undefined);
      // Accepting the disclosure here explicitly adds this category to an existing all grant.
      if (checked && mode === "all") setCategories((current) => [...new Set([...current, "ui_evidence_review" as const])]);
    }} />;
  const expiresAt = preset === "custom" && threadGrant?.expiresAt != null && customTime === localDateTime(threadGrant.expiresAt)
    ? threadGrant.expiresAt : delegationExpiryAt(preset, customTime, expiryStart);

  const revoke = async () => {
    if ("defaultGrant" in props) return;
    const revoked = await confirm({
      title: "Revoke Delegation",
      message: "This thread will lose permission to resolve decisions on your behalf.",
      confirmLabel: "Revoke Delegation",
      tone: "danger",
      progress: "Revoking delegation…",
      cancelWhileRunning: false,
      onConfirm: () => props.onSave({ revision: props.delegation.revision, grant: null }),
    });
    if (revoked) onClose();
  };

  const save = async () => {
    if (busy) return;
    if (mode !== "ask") {
      if (!selected.length) return setError("Select at least one decision category.");
      if (evidenceSelected && !digest) return setError("Clear Approve UI Evidence to save while it is unavailable.");
      if (evidenceSelected && !disclosed) return setError("Accept the provider disclosure to grant Approve UI Evidence.");
      if (!projectScope.length || !campaignScope.length) return setError("Select at least one item in each selected scope, or choose All.");
      if (!isDefault && expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) return setError("Choose a future expiration time.");
    }
    setError(null);
    setBusy(true);
    try {
      const scope: Omit<AssistantDecisionDefault, "expiresAfterMs"> | null = mode === "ask" ? null : {
        categories: selected, selectionMode: mode, projects: projectScope, campaigns: campaignScope,
      };
      if ("defaultGrant" in props) {
        if (!isDefaultDelegationExpiry(preset)) throw new Error("Choose a supported expiry duration.");
        await props.onSaveDefault(scope ? { ...scope, expiresAfterMs: ASSISTANT_DECISION_DEFAULT_DURATIONS[preset] } : null);
      } else {
        await props.onSave({ revision: props.delegation.revision, grant: scope ? {
          ...scope, expiresAt, ...(evidenceSelected && disclosed ? { evidenceDisclosureDigest: digest } : {}),
        } : null });
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update decision delegation.");
      setBusy(false);
    }
  };

  const categoryNotes = allCategories.filter((category) => !selected.includes(category) || unavailable[category]);

  return <Modal title={isDefault ? "Decision Delegation for New Threads" : "Decision Delegation"} size="lg"
    className="delegation-dialog" phoneSheet="full"
    description={isDefault ? "New threads start with these permissions. Existing threads keep their own grants."
      : "Choose which decisions this Assistant thread may resolve on your behalf. Its decisions are attributed to the thread."}
    onClose={busy ? () => {} : onClose}
    footer={<>
      {threadGrant && <button className="btn ghost danger delegation-revoke" type="button" disabled={busy}
        onClick={() => void revoke()}>Revoke Delegation</button>}
      <button className="btn" type="button" disabled={busy} onClick={onClose}>Cancel</button>
      <BusyButton className="btn primary" form={form} type="submit" busy={busy}
        progress="Saving delegation…">Save Delegation</BusyButton>
    </>}>
    <form id={form} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <fieldset className="assistant-fields form" disabled={busy}>
        {threadGrant && <Notice compact role="status" tone={expired ? "neutral" : "success"}
          title={expired ? "Expired Delegation" : "Active Delegation"}>
          {formatAssistantDelegationSummary(threadGrant, now)}
        </Notice>}
        <SegmentedControl label="Delegation Mode" options={modes} value={mode} onChange={(next) => {
          setMode(next);
          setError(null);
          if (mode === "ask" && next !== "ask") setExpiryStart(Date.now());
          if (next === "all") setRefreshAll(true);
          if (next === "choose" && mode === "all") setCategories(selected);
        }} />
        {mode === "ask" && <p className="muted">Decisions stay with you.</p>}
        {mode === "all" && <fieldset className="assistant-fields form">
          <legend>Decision Categories</legend>
          <p aria-live="polite">{selected.length} of {allCategories.length} categories included.</p>
          {categoryNotes.map((category) => <div key={category} className="delegation-category">
            <strong>{ASSISTANT_DECISION_CATEGORIES[category]}</strong>
            <p className="muted">{unavailable[category] ?? (category === "ui_evidence_review" && !disclosed
              ? "Excluded until you accept the provider disclosure."
              : "This category was outside the saved grant. Select Delegate All again to include it.")}</p>
            {category === "ui_evidence_review" && disclosure && !disclosed && <>
              <p>{disclosure}</p>
              {evidenceConsent}
            </>}
          </div>)}
          {evidenceSelected && <div className="delegation-category">
            <strong>Approve UI Evidence</strong>
            <p className="muted">Included. You accepted the provider disclosure.</p>
            {evidenceConsent}
          </div>}
        </fieldset>}
        {mode === "choose" && <>
          {evidenceSelected && grant?.categories.includes("ui_evidence_review") && !disclosed &&
            <Notice tone="warning" role="status" title="Confirm Provider Disclosure">
              Approve UI Evidence is paused. Accept the current provider disclosure and save delegation to restore it.
            </Notice>}
          <div className="delegation-groups">
            {ASSISTANT_DECISION_GROUPS.map((group) => <CategoryGroup key={group.label} {...group}
              selected={selected} unavailable={unavailable} disclosure={disclosure} evidenceConsent={evidenceConsent}
              onToggle={(items, checked) => setCategories((current) => checked ? [...new Set([...current, ...items])]
                : current.filter((category) => !items.includes(category)))} />)}
          </div>
        </>}
        {mode !== "ask" && <>
          <fieldset className="assistant-fields form">
            <legend>Expiry</legend>
            <SegmentedControl label="Expiry Preset" options={isDefault ? DEFAULT_DELEGATION_EXPIRY_OPTIONS : DELEGATION_EXPIRY_OPTIONS} value={preset} describedBy={expiryHelp}
              className="delegation-presets" onChange={(next) => { setPreset(next); setExpiryStart(Date.now()); }} />
            {preset === "custom" && <label className="field">
              <span>Ends At</span>
              <input type="datetime-local" aria-describedby={expiryHelp} value={customTime} onChange={(event) => setCustomTime(event.target.value)} />
            </label>}
            <p className="muted" id={expiryHelp}>{isDefault && preset !== "never" ? "The expiry starts when each thread is created."
              : formatDelegationExpiryHelp(preset, expiresAt)}</p>
          </fieldset>
          <div className="delegation-scopes">
            <SelectionScope name="Projects" value={projectScope} onChange={setProjectScope}
              items={[...projects.values()].map(({ id, name }) => ({ id, title: name }))} />
            <SelectionScope name="Campaigns" value={campaignScope} onChange={setCampaignScope}
              items={[...sessions.values()].filter((session) => sessionRole(session) === "orchestrator" && !session.parentSessionId)
                .map(({ id, title }) => ({ id, title }))} />
          </div>
        </>}
        {error && <Notice tone="danger" role="alert"
          noticeRef={(node) => node?.scrollIntoView({ block: "nearest" })}>{error}</Notice>}
      </fieldset>
    </form>
  </Modal>;
}
