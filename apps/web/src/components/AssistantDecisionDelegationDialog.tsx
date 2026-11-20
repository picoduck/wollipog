import { useId, useState } from "react";
import {
  ASSISTANT_DECISION_CATEGORIES,
  ASSISTANT_EVIDENCE_RETENTION_DISCLOSURE,
  sessionRole,
  type AssistantDecisionCategory,
  type AssistantDecisionDelegation,
  type AssistantDecisionGrant,
  type AssistantEvidenceReviewAvailability,
} from "@wollipog/protocol";
import { useStoreSelector } from "../store.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Checkbox, Select } from "./ui/ChoiceControls.js";

type Scope = AssistantDecisionGrant["projects"];
type ScopeItem = { id: string; title: string };

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
    <div className="field">
      <span className="field-label">{scopeLabel}</span>
      <Select label={scopeLabel} value={value === "all" ? "all" : "selected"} options={[
        { value: "all", label: `All ${name}` }, { value: "selected", label: `Selected ${name}` },
      ]} onChange={(next) => {
        setQuery("");
        setPage(0);
        onChange(next === "all" ? "all" : []);
      }} />
    </div>
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
          <button type="button" className="btn sm" disabled={start === 0} onClick={() => setPage(currentPage - 1)}>Previous {name}</button>
          <button type="button" className="btn sm" disabled={start + pageSize >= choices.length} onClick={() => setPage(currentPage + 1)}>Next {name}</button>
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

export function AssistantDecisionDelegationDialog({ delegation, evidenceReview, onSave, onClose }: {
  delegation: AssistantDecisionDelegation;
  evidenceReview?: AssistantEvidenceReviewAvailability;
  onSave: (value: AssistantDecisionDelegation) => Promise<void>;
  onClose: () => void;
}) {
  const form = useId();
  const projects = useStoreSelector((state) => state.projects);
  const sessions = useStoreSelector((state) => state.sessions);
  const [categories, setCategories] = useState(delegation.grant?.categories ?? []);
  const [projectScope, setProjectScope] = useState<Scope>(delegation.grant?.projects ?? "all");
  const [campaignScope, setCampaignScope] = useState<Scope>(delegation.grant?.campaigns ?? "all");
  const [expiry, setExpiry] = useState(localDateTime(delegation.grant?.expiresAt));
  const [busy, setBusy] = useState<"save" | "revoke" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const evidenceSelected = categories.includes("ui_evidence_review");

  const save = async (mode: "save" | "revoke") => {
    if (busy) return;
    const expiresAt = expiry ? new Date(expiry).getTime() : null;
    if (mode === "save") {
      if (!categories.length) return setError("Select at least one decision category.");
      if (evidenceSelected && !evidenceReview?.available) return setError("Remove UI Evidence Approval to save this grant.");
      if (!projectScope.length || !campaignScope.length) return setError("Select at least one project and campaign, or choose All.");
      if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) return setError("Choose a future expiration time.");
    }
    setError(null);
    setBusy(mode);
    try {
      await onSave({ revision: delegation.revision,
        grant: mode === "revoke" ? null : { categories, projects: projectScope, campaigns: campaignScope, expiresAt,
          ...(evidenceSelected && evidenceReview?.available ? { evidenceDisclosureDigest: evidenceReview.disclosureDigest } : {}) } });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update decision delegation.");
      setBusy(null);
    }
  };

  return <Modal title="Decision Delegation"
    description="Choose which decisions this Assistant thread may resolve on your behalf. Its decisions are attributed to the thread."
    onClose={busy ? () => {} : onClose}
    footer={<>
      {delegation.grant && <BusyButton className="btn" type="button" busy={busy === "revoke"} disabled={busy === "save"}
        progress="Revoking grant…" onClick={() => void save("revoke")}>Revoke Grant</BusyButton>}
      <button className="btn" type="button" disabled={busy !== null} onClick={onClose}>Cancel</button>
      <BusyButton className="btn primary" form={form} type="submit" busy={busy === "save"} disabled={busy === "revoke"}
        progress="Saving grant…">Save Grant</BusyButton>
    </>}>
    <form id={form} onSubmit={(event) => { event.preventDefault(); void save("save"); }}>
      <fieldset className="assistant-fields form" disabled={busy !== null}>
        <fieldset className="assistant-fields">
          <legend>Decision Categories</legend>
          {Object.entries(ASSISTANT_DECISION_CATEGORIES).map(([id, label]) => {
            const category = id as AssistantDecisionCategory;
            if (category === "ui_evidence_review") {
              if (!evidenceReview) return null;
              return <Checkbox key={category} label={label} checked={evidenceSelected}
                disabled={!evidenceReview.available && !evidenceSelected}
                helper={evidenceReview.available
                  ? evidenceSelected && `${evidenceReview.provider} · ${evidenceReview.model}. ${ASSISTANT_EVIDENCE_RETENTION_DISCLOSURE}`
                  : evidenceReview.reason}
                onChange={(checked) => setCategories((current) => checked ? [...current, category] : current.filter((item) => item !== category))} />;
            }
            return <Checkbox key={category} label={label} checked={categories.includes(category)}
              onChange={(checked) => setCategories((current) => checked ? [...current, category] : current.filter((item) => item !== category))} />;
          })}
        </fieldset>
        <SelectionScope name="Projects" value={projectScope} onChange={setProjectScope}
          items={[...projects.values()].map(({ id, name }) => ({ id, title: name }))} />
        <SelectionScope name="Campaigns" value={campaignScope} onChange={setCampaignScope}
          items={[...sessions.values()].filter((session) => sessionRole(session) === "orchestrator" && !session.parentSessionId)
            .map(({ id, title }) => ({ id, title }))} />
        <label className="field">
          <span>Expires at (Optional)</span>
          <input type="datetime-local" value={expiry} onChange={(event) => setExpiry(event.target.value)} />
          <span className="muted">Use your device’s local time. An empty field keeps the grant active until revoked.</span>
        </label>
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
      </fieldset>
    </form>
  </Modal>;
}
