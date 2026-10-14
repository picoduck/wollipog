import { useEffect, useId, useRef, useState } from "react";
import type { CampaignControlMode, CampaignLaunchPreflight, CampaignLaunchProposal, CreateSessionRequest } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { titleCaseLabel } from "../format.js";
import { fullControlPreflight, type FullControlPreparation as PreparationInput } from "../full-control-preflight.js";
import { ChoiceRows } from "./ui/ChoiceControls.js";
import { SegmentedRow } from "./ui/SettingsRows.js";
import { Notice } from "./Notice.js";

/** Shared preference/preflight display. Launch uses only the exact Human endpoint, which refuses
 * production admission until complete enforcement is proven; ordinary creation stays fenced. */
export function FullControlPreparation({ mode, onChange, disabled = false, preferenceSupported = false,
  launchRequest, launchSelectionValid = false, onCampaignCreated, ...input }: PreparationInput & {
  mode: CampaignControlMode; onChange: (mode: CampaignControlMode) => void; disabled?: boolean; preferenceSupported?: boolean;
  launchRequest?: () => CreateSessionRequest; launchSelectionValid?: boolean; onCampaignCreated?: (id: string) => void;
}) {
  const id = useId();
  const preflight = fullControlPreflight(input);
  const current = preflight.effectiveMode;
  const defaults = input.surface === "defaults";
  return <section className="section" aria-labelledby={defaults ? undefined : `${id}-title`}
    aria-label={defaults ? "Orchestrator Control" : undefined}>
    {defaults ? <SegmentedRow title="Orchestrator Control" value={mode}
      onChange={(value) => onChange(value === "full_control" ? "full_control" : "custom")} disabled={disabled}
      options={[
        { value: "custom", label: "Custom", description: "Choose individual workflow owners. Defaults apply only to new campaigns." },
        { value: "full_control", label: "Full Control", description: preferenceSupported
          ? "Prefer Full Control for new campaigns; each needs authenticated human authorization."
          : "Preview Full Control; this version cannot save the preference." },
      ]} /> : <>
      <h3 className="section-title" id={`${id}-title`}>Orchestrator Control</h3>
      <ChoiceRows<CampaignControlMode> label="Orchestrator Control" value={mode} onChange={onChange}
        options={[
          { value: "custom", title: "Custom", description: "Choose individual request and workflow decision owners.", disabled, inputData: { "data-control-mode": "custom" } },
          { value: "full_control", title: "Full Control", description: "Review autonomous control within one human-established campaign boundary. Activation is unavailable here.", disabled, inputData: { "data-control-mode": "full_control" } },
        ]} />
      <p className="section-note">Selecting the Orchestrator role or assigning all five owners does not authorize Full Control.</p>
    </>}
    {input.surface === "campaign" && <p className="section-note">Effective Mode: {current === "full_control" ? "Full Control" : current === "custom" ? "Custom" : "Current Root State Not Reported"}. Enabling or revoking control requires an explicit authenticated campaign operation against the current revision and revokes incompatible unused approvals. This preview does not change the mode.</p>}
    {mode === "full_control" && <>
      {defaults && <>
        <p className="section-note">Selecting the Orchestrator role or assigning all five owners does not authorize Full Control.</p>
        <p className="section-note">Defaults apply only to new campaigns. {preferenceSupported ? "Save Defaults records a preferred mode; it grants no campaign authority. " : "This version cannot save a control preference. "}Each new campaign still needs its own exact scope and authenticated human authorization.</p>
      </>}
      <h4 className="section-title">Full Control Preflight</h4>
      <Notice tone="neutral" role="status">Activation Unavailable</Notice>
      <dl className="facts orchestrator-facts">
        {preflight.facts.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      <h4 className="section-title">Human Required and Unsupported Capabilities</h4>
      <ul>{preflight.blockers.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      <p className="section-note">One authenticated human confirmation must bind the complete issue, budget, and evidence authorities together. Agent JSON, saved defaults, and this preview cannot grant authorization.</p>
      {input.surface === "launch" && launchRequest && onCampaignCreated
        ? <CampaignLaunchForm request={launchRequest()} selectionValid={launchSelectionValid} disabled={disabled} onCreated={onCampaignCreated} />
        : <button type="button" className="btn primary" disabled>Authorize Full Control</button>}
    </>}
  </section>;
}

function CampaignLaunchForm({ request, selectionValid, disabled, onCreated }: {
  request: CreateSessionRequest; selectionValid: boolean; disabled: boolean; onCreated: (id: string) => void;
}) {
  const api = useApi();
  const id = useId();
  const [repository, setRepository] = useState("");
  const [issues, setIssues] = useState("");
  const [objective, setObjective] = useState("");
  const [cost, setCost] = useState("");
  const [tools, setTools] = useState("");
  const [concurrency, setConcurrency] = useState("");
  const [followUps, setFollowUps] = useState("0");
  const [maximumIssues, setMaximumIssues] = useState("");
  const [relatedFollowUps, setRelatedFollowUps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ input: string; value: CampaignLaunchPreflight } | null>(null);
  const generation = useRef(0);
  const numbers = issues.trim().split(/[,\s]+/).map(Number);
  const proposal: CampaignLaunchProposal = {
    repository: repository.trim().toLowerCase(), issueNumbers: numbers, objective: objective.trim(),
    operations: ["implementation_question", "pr_merge", "merged_branch_deletion", "follow_up_issue_publication",
      "ui_evidence_approval", "campaign_issue_scope", "issue_closure", "question", "tool_approval"],
    delegatablePolicyIds: [],
    issueAuthority: { epics: [], relatedFollowUps, maxIssues: Number(maximumIssues), closureReasons: ["completed"] },
    budgetAuthority: { version: 1, costUsd: Number(cost), toolCalls: Number(tools), concurrency: Number(concurrency),
      acceptedFollowUps: Number(followUps), accounting: "managed_workers_only", unpriced: "stop" },
  };
  const valid = selectionValid && /^[\w.-]+\/[\w.-]+$/.test(proposal.repository) && objective.trim().length > 0 && objective.length <= 4000 &&
    numbers.length >= 1 && numbers.length <= 100 && numbers.every((n) => Number.isSafeInteger(n) && n > 0) && new Set(numbers).size === numbers.length &&
    [cost, tools, concurrency, maximumIssues].every((value) => value.trim() && Number.isFinite(Number(value)) && Number(value) > 0) &&
    [tools, concurrency, followUps, maximumIssues].every((value) => value.trim() && Number.isSafeInteger(Number(value))) &&
    Number(followUps) >= 0 && Number(concurrency) <= 64 && Number(maximumIssues) >= numbers.length && Number(maximumIssues) <= 100;
  const input = JSON.stringify({ session: request, proposal });
  const currentInput = useRef(input);
  currentInput.current = input;
  const identity = useRef<{ input: string; requestId: string } | null>(null);
  if (identity.current?.input !== input) identity.current = { input,
    requestId: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("") };
  useEffect(() => { generation.current++; setError(null); }, [input]);
  useEffect(() => () => { generation.current++; }, []);
  const fresh = checked?.input === input ? checked.value : null;
  // A mode choice or a response boolean alone never enables admission.
  const ready = fresh?.supported === true && fresh.capabilities.length >= 4 && fresh.capabilities.every((item) => item.state === "verified");
  const check = async () => {
    if (!valid || disabled || busy) return;
    const attempt = ++generation.current;
    setBusy(true); setError(null);
    try {
      const { preflight } = await api.fullControlLaunchPreflight(JSON.parse(input));
      if (attempt === generation.current && currentInput.current === input) setChecked({ input, value: preflight });
    } catch (caught) {
      if (attempt === generation.current) setError(caught instanceof Error ? caught.message : "Full Control preflight is unavailable.");
    } finally { setBusy(false); }
  };
  const authorize = async () => {
    if (!ready || !fresh || !valid || disabled || busy) return;
    setBusy(true); setError(null);
    try {
      const session = await api.createFullControlCampaign({ session: request, proposal, requestId: identity.current!.requestId, preflightDigest: fresh.digest });
      onCreated(session.id);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The campaign was not created."); }
    finally { setBusy(false); }
  };
  const field = (label: string, value: string, change: (value: string) => void, numeric = false) => <label className="field">
    <span>{label}</span>
    <input type={numeric ? "number" : "text"} value={value} disabled={disabled || busy} onChange={(event) => change(event.target.value)} />
  </label>;
  return <section className="section" aria-labelledby={`${id}-launch`}>
    <h4 className="section-title" id={`${id}-launch`}>Exact Human Launch Proposal</h4>
    <p className="section-note">Review the repository, objective, permitted effects and finite campaign limits before authorizing. A preflight request grants no authority.</p>
    {field("Repository", repository, setRepository)}
    {field("Issue Numbers", issues, setIssues)}
    {field("Objective", objective, setObjective)}
    {field("Campaign Cost Limit (USD)", cost, setCost, true)}
    {field("Campaign Tool Call Limit", tools, setTools, true)}
    {field("Campaign Concurrency Limit", concurrency, setConcurrency, true)}
    {field("Accepted Follow-Up Limit", followUps, setFollowUps, true)}
    {field("Maximum Authorized Issues", maximumIssues, setMaximumIssues, true)}
    <label className="field"><span>Related Follow-Ups</span><input type="checkbox" checked={relatedFollowUps} disabled={disabled || busy} onChange={(event) => setRelatedFollowUps(event.target.checked)} /></label>
    <p className="section-note">Requested effects: implementation questions, eligible one-time repository approvals, exact PR merge and merged branch deletion, bounded follow-up publication and issue scope, completed issue closure, and compatible UI evidence review. Secrets, sign-in, persistent permissions, governance, budgets and guardrails stay Human Required.</p>
    <button type="button" className="btn" disabled={!valid || disabled || busy} onClick={() => void check()}>Check Full Control Preflight</button>
    {fresh && <>
      <Notice tone="neutral" role="status">{ready ? "Ready for Exact Human Authorization" : "Full Control Launch Blocked"}</Notice>
      <dl className="facts orchestrator-facts">
        <div><dt>Resolved Root Model</dt><dd>{fresh.plan.config.model ?? "Unverified"}</dd></div>
        <div><dt>Resolved Root Effort</dt><dd>{fresh.plan.config.effort ? titleCaseLabel(fresh.plan.config.effort) : "Provider Default"}</dd></div>
        <div><dt>Resolved Provider Permissions</dt><dd>{fresh.plan.config.permissionMode ? titleCaseLabel(fresh.plan.config.permissionMode) : "Provider Default"}</dd></div>
      </dl>
      <ul>{fresh.capabilities.map((capability) => <li key={capability.capability}>{capability.capability}: {capability.reason}</li>)}</ul>
    </>}
    {error && <Notice tone="danger" role="alert">{error}</Notice>}
    <button type="button" className="btn primary" disabled={!ready || !valid || disabled || busy} onClick={() => void authorize()}>Authorize and Create Session</button>
  </section>;
}
