import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type {
  CampaignControlMode, CampaignLaunchPreflight, CreateSessionRequest, FullControlEnableRequest, FullControlLaunchOverrides,
  FullControlLaunchRequest, OrchestratorDefaults, SessionView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { titleCaseLabel } from "../format.js";
import { ChevronRightIcon } from "./Icons.js";
import { ChoiceRows, SegmentedControl } from "./ui/ChoiceControls.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Switch } from "./ui/SettingsRows.js";

/** A future preference only; the selected option cannot authorize a campaign. */
export function FullControlModeChoice({ mode, onChange, disabled = false, preferenceSupported = false }: {
  mode: CampaignControlMode; onChange: (mode: CampaignControlMode) => void;
  disabled?: boolean; preferenceSupported?: boolean;
}) {
  return <span className="setting-row-control"><SegmentedControl<CampaignControlMode> className="sm"
    label="Orchestrator Control" value={mode} onChange={onChange}
    options={[
      { value: "custom", label: "Custom", description: "Choose individual workflow owners. Defaults apply only to new campaigns.", disabled },
      { value: "full_control", label: "Full Control", description: preferenceSupported
        ? "Prefer Full Control for new campaigns; each still needs your authorization."
        : "This version cannot save the preference.", disabled },
    ]} /></span>;
}

/** The launch and active-campaign choice. Choosing Full Control only shows its preflight; one
 * explicit authorization action is still required. */
export function OrchestratorControlChoice({ mode, onChange, disabled = false, surface, embedded = false }: {
  mode: CampaignControlMode; onChange: (mode: CampaignControlMode) => void; disabled?: boolean; surface: "launch" | "campaign";
  /** Rendered inside a section that already carries the Orchestrator Control heading. */
  embedded?: boolean;
}) {
  const id = useId();
  const rows = <ChoiceRows<CampaignControlMode> label="Orchestrator Control" value={mode} onChange={onChange}
      options={[
        { value: "custom", title: "Custom", description: "Choose individual request and workflow decision owners.", disabled, inputData: { "data-control-mode": "custom" } },
        { value: "full_control", title: "Full Control", description: "Let the Orchestrator finish this campaign within the limits you authorize.", disabled, inputData: { "data-control-mode": "full_control" } },
      ]} />;
  if (embedded) return rows;
  return <section className="section" aria-labelledby={`${id}-title`}>
    <h3 className="section-title" id={`${id}-title`}>Orchestrator Control</h3>
    {rows}
  </section>;
}

const STATE_LABELS: Record<CampaignLaunchPreflight["capabilities"][number]["state"], string> = {
  verified: "Verified", unsupported: "Blocks Launch", human_required: "Human Required",
};
const DEBOUNCE_MS = 400;

/** One readiness answer per input. A newer input aborts the older request, so a late answer can
 * never describe what the person is looking at now. */
export function useServerPreflight<T>(key: string | null, run: (signal: AbortSignal) => Promise<T>) {
  const latest = useRef(run);
  latest.current = run;
  const [state, setState] = useState<{ key: string | null; value: T | null; error: string | null; loading: boolean }>(
    { key: null, value: null, error: null, loading: false });
  useEffect(() => {
    if (key === null) { setState({ key: null, value: null, error: null, loading: false }); return; }
    const controller = new AbortController();
    setState((prior) => ({ ...prior, loading: true, error: null }));
    const timer = window.setTimeout(() => {
      latest.current(controller.signal).then(
        (value) => { if (!controller.signal.aborted) setState({ key, value, error: null, loading: false }); },
        (cause) => { if (!controller.signal.aborted) setState({ key, value: null, error: cause instanceof Error ? cause.message : "Full Control readiness is unavailable.", loading: false }); });
    }, DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [key]);
  return { value: state.key === key ? state.value : null, error: state.key === key || state.key === null ? state.error : null,
    loading: state.loading || state.key !== key };
}

/** A response boolean alone never enables authorization: every mandatory capability must be verified. */
export function preflightReady(preflight: CampaignLaunchPreflight | null): boolean {
  return preflight?.ready === true && preflight.capabilities.some((item) => item.mandatory) &&
    preflight.capabilities.every((item) => !item.mandatory || item.state === "verified");
}

function newRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface BudgetDraft { cost: string; tools: string; save: boolean }
function budgetValue(draft: BudgetDraft): { costUsd?: number; toolCalls?: number } {
  const cost = Number(draft.cost), tools = Number(draft.tools);
  return { ...(draft.cost.trim() && Number.isFinite(cost) && cost > 0 ? { costUsd: cost } : {}),
    ...(draft.tools.trim() && Number.isSafeInteger(tools) && tools > 0 ? { toolCalls: tools } : {}) };
}

interface LimitDrafts { concurrency: string; followUps: string; maxIssues: string; related: boolean | null }

type DraftField = "cost" | "tools" | "concurrency" | "followUps" | "maxIssues";
type DraftErrors = Partial<Record<DraftField, string>>;
const whole = (n: number, min: number, max: number) => Number.isSafeInteger(n) && n >= min && n <= max;
// Plain digits only: `Number` alone would also accept forms such as `1e1` or `0x10`.
const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/, WHOLE = /^\d+$/;
const DRAFT_RULES: Record<DraftField, { pattern: RegExp; valid: (n: number) => boolean; message: string }> = {
  cost: { pattern: DECIMAL, valid: (n) => n > 0 && n <= 1_000_000, message: "Enter an amount above 0, up to 1,000,000." },
  tools: { pattern: WHOLE, valid: (n) => whole(n, 1, 10_000_000), message: "Enter a whole number from 1 to 10,000,000." },
  concurrency: { pattern: WHOLE, valid: (n) => whole(n, 1, 64), message: "Enter a whole number from 1 to 64." },
  followUps: { pattern: WHOLE, valid: (n) => whole(n, 0, Number.MAX_SAFE_INTEGER), message: "Enter a whole number, 0 or more." },
  maxIssues: { pattern: WHOLE, valid: (n) => whole(n, 1, 100), message: "Enter a whole number from 1 to 100." },
};
const INVALID_DRAFTS = "Correct the highlighted limits to check readiness.";

/** An empty field uses the derived value. Anything else must be a valid limit: an entry is never
 * silently dropped, because the summary would then describe a launch the person did not enter. */
function draftErrors(budget: BudgetDraft, limits: LimitDrafts): DraftErrors {
  const values: Record<DraftField, string> = { cost: budget.cost, tools: budget.tools, concurrency: limits.concurrency,
    followUps: limits.followUps, maxIssues: limits.maxIssues };
  const invalid = (field: DraftField) => {
    const text = values[field].trim(), rule = DRAFT_RULES[field];
    return text !== "" && !(rule.pattern.test(text) && rule.valid(Number(text)));
  };
  return Object.fromEntries((Object.keys(values) as DraftField[]).filter(invalid)
    .map((field) => [field, DRAFT_RULES[field].message]));
}

function limitOverrides(limits: LimitDrafts): Pick<FullControlLaunchOverrides, "budget" | "issues"> {
  const entered = (value: string) => value.trim() ? Number(value) : undefined;
  const concurrency = entered(limits.concurrency), acceptedFollowUps = entered(limits.followUps), maxIssues = entered(limits.maxIssues);
  return {
    ...(concurrency !== undefined || acceptedFollowUps !== undefined ? { budget: {
      ...(concurrency !== undefined ? { concurrency } : {}), ...(acceptedFollowUps !== undefined ? { acceptedFollowUps } : {}) } } : {}),
    ...(maxIssues !== undefined || limits.related !== null ? { issues: {
      ...(maxIssues !== undefined ? { maxIssues } : {}), ...(limits.related !== null ? { relatedFollowUps: limits.related } : {}) } } : {}),
  };
}

function mergeOverrides(budget: BudgetDraft, limits: LimitDrafts): Pick<FullControlLaunchOverrides, "budget" | "issues"> {
  const limit = limitOverrides(limits);
  const amounts = budgetValue(budget);
  const merged = { ...limit.budget, ...amounts };
  return { ...(Object.keys(merged).length ? { budget: merged } : {}), ...(limit.issues ? { issues: limit.issues } : {}) };
}

/** The capability exceptions by name; the standing protections every campaign has are counted. */
function humanRequiredSummary(preflight: CampaignLaunchPreflight): string {
  const exceptions = preflight.capabilities.filter((item) => item.state === "human_required").map((item) => item.capability);
  const standing = preflight.summary.humanRequired.length - exceptions.length;
  const protections = standing > 0 ? `${standing} standing ${standing === 1 ? "protection" : "protections"}, such as secrets and sign-in` : "";
  return [exceptions.join(", "), protections].filter(Boolean).join(" · ") || "None";
}

function money(value: number): string {
  return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
}

/** The concise readiness summary shared by launch and enable. Details live under Advanced. */
export function FullControlSummary({ preflight, loading, error, scopeLabel, budgetEntry, advanced, action }: {
  preflight: CampaignLaunchPreflight | null; loading: boolean; error: string | null; action: "start" | "enable";
  scopeLabel: (preflight: CampaignLaunchPreflight) => string;
  budgetEntry?: ReactNode; advanced?: ReactNode;
}) {
  const ready = preflightReady(preflight);
  const budget = preflight?.summary.budget;
  return <div aria-busy={loading}>
    {error ? <Notice tone="danger" role="alert">{error}</Notice>
      : !preflight ? <Notice tone="neutral" role="status">Checking Full Control Readiness…</Notice>
      : ready ? <Notice tone="success" role="status">{action === "start" ? "Ready to Authorize and Start" : "Ready to Enable"}</Notice>
      : <Notice tone="warning" role="status" title={action === "start" ? "Can't Start Yet" : "Can't Enable Yet"}>
        <ul>{preflight.summary.blockers.map((item) => <li key={item.capability}><strong>{item.capability}:</strong> {item.reason}</li>)}</ul>
      </Notice>}
    {preflight && <dl className="facts orchestrator-facts">
      <div><dt>Scope</dt><dd>{scopeLabel(preflight)}</dd></div>
      <div><dt>Budget</dt><dd>{budget && budget.costUsd !== null && budget.toolCalls !== null
        ? `${money(budget.costUsd)} · ${budget.toolCalls} tool calls · ${budget.concurrency} at a time${budget.source === "saved_defaults" ? " · Saved Default" : ""}`
        : "Not Set"}</dd></div>
      <div><dt>Follow-Ups</dt><dd>{`${titleCaseLabel(preflight.summary.followUps.policy.replaceAll("_", " "))} · up to ${preflight.summary.followUps.maxIssues} ${preflight.summary.followUps.maxIssues === 1 ? "issue" : "issues"}`}</dd></div>
      <div><dt>Evidence</dt><dd>{preflight.summary.evidence.statement}</dd></div>
      <div><dt>Human Required</dt><dd>{humanRequiredSummary(preflight)}</dd></div>
    </dl>}
    {budgetEntry}
    {preflight?.summary.evidence.provider && <p className="section-note">{preflight.summary.evidence.provider.retentionDisclosure}</p>}
    <details className="disclosure">
      <summary><ChevronRightIcon size={14} className="disclosure-chevron" />Advanced</summary>
      <div className="disclosure-body">
        {advanced}
        {preflight && <>
          <h4 className="section-title">Human Required</h4>
          <ul>{preflight.summary.humanRequired.map((item) => <li key={item.exception}>{item.exception}</li>)}</ul>
          <h4 className="section-title">Capabilities</h4>
          <ul>{preflight.capabilities.map((item) => <li key={item.id}>{item.capability} ({STATE_LABELS[item.state]}): {item.reason}</li>)}</ul>
        </>}
      </div>
    </details>
  </div>;
}

function LimitInput({ label, value, onChange, mode, error, disabled, placeholder }: {
  label: string; value: string; onChange: (value: string) => void; mode: "decimal" | "numeric"; error?: string;
  disabled: boolean; placeholder?: string;
}) {
  const id = useId();
  // Text with a numeric keyboard, not type="number": a number input reports text it cannot read, such
  // as `1e`, as "", which here would mean "use the derived value" while the entry is still shown.
  return <>
    <label className="field"><span>{label}</span>
      <input type="text" inputMode={mode} autoComplete="off" value={value} disabled={disabled}
        placeholder={placeholder} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.currentTarget.value)} /></label>
    {error && <span className="form-error" id={`${id}-error`}>{error}</span>}
  </>;
}

function BudgetEntry({ draft, onChange, errors, disabled }: {
  draft: BudgetDraft; onChange: (draft: BudgetDraft) => void; errors: DraftErrors; disabled: boolean;
}) {
  const id = useId();
  return <fieldset className="orchestrator-policy-area">
    <legend>Campaign Budget</legend>
    <p className="muted">Choose the most this campaign may spend. The Orchestrator stops admitting new work at either limit.</p>
    <LimitInput label="Cost Limit (USD)" value={draft.cost} mode="decimal" error={errors.cost} disabled={disabled}
      onChange={(cost) => onChange({ ...draft, cost })} />
    <LimitInput label="Tool Call Limit" value={draft.tools} mode="numeric" error={errors.tools} disabled={disabled}
      onChange={(tools) => onChange({ ...draft, tools })} />
    <div className="field"><span id={`${id}-save`}>Save as Default</span>
      <Switch labelledBy={`${id}-save`} checked={draft.save} disabled={disabled}
        onChange={(save) => onChange({ ...draft, save })} />
    </div>
  </fieldset>;
}

function LimitFields({ budget, onBudget, limits, onLimits, errors, derivedRelated, disabled, savedBudget }: {
  budget: BudgetDraft; onBudget: (draft: BudgetDraft) => void; limits: LimitDrafts; onLimits: (limits: LimitDrafts) => void;
  errors: DraftErrors;
  /** The server's last answer when the person has not chosen: the switch must show what will be
   * authorized, so it waits for a first answer rather than guessing. */
  derivedRelated: boolean | null;
  disabled: boolean; savedBudget: boolean;
}) {
  const id = useId();
  const field = (label: string, value: string, change: (value: string) => void, mode: "decimal" | "numeric", error?: string) =>
    <LimitInput label={label} value={value} onChange={change} mode={mode} error={error} disabled={disabled} placeholder="Use Default" />;
  return <fieldset className="orchestrator-policy-area">
    <legend>Campaign Limits</legend>
    <p className="muted">Leave a field empty to use the derived value. Changes check readiness again.</p>
    {savedBudget && field("Cost Limit (USD)", budget.cost, (cost) => onBudget({ ...budget, cost }), "decimal", errors.cost)}
    {savedBudget && field("Tool Call Limit", budget.tools, (tools) => onBudget({ ...budget, tools }), "numeric", errors.tools)}
    {field("Concurrent Children", limits.concurrency, (concurrency) => onLimits({ ...limits, concurrency }), "numeric", errors.concurrency)}
    {field("Accepted Follow-Ups", limits.followUps, (followUps) => onLimits({ ...limits, followUps }), "numeric", errors.followUps)}
    {field("Maximum Issues", limits.maxIssues, (maxIssues) => onLimits({ ...limits, maxIssues }), "numeric", errors.maxIssues)}
    <div className="field"><span id={`${id}-related`}>Related Follow-Ups</span>
      <Switch labelledBy={`${id}-related`} checked={limits.related ?? derivedRelated ?? false}
        disabled={disabled || (limits.related === null && derivedRelated === null)}
        onChange={(related) => onLimits({ ...limits, related })} />
    </div>
  </fieldset>;
}

/** Saves a first budget as the Human's default, only after the authorization succeeded, so saving can
 * never change the preflight that was reviewed. An existing default is never replaced from here:
 * entries under Advanced override one campaign only. */
async function saveFirstBudgetDefault(api: ReturnType<typeof useApi>, defaults: OrchestratorDefaults | null, draft: BudgetDraft): Promise<void> {
  const amounts = budgetValue(draft);
  if (!draft.save || !defaults || defaults.campaignBudget || amounts.costUsd === undefined || amounts.toolCalls === undefined) return;
  // The campaign is already authorized; a failed save only means the next launch asks again.
  await api.updateOrchestratorSettings({ defaults: { ...defaults, campaignBudget: { costUsd: amounts.costUsd, toolCalls: amounts.toolCalls } } })
    .catch(() => undefined);
}

/** Imperative handle New Session's footer uses for its single primary action. */
export interface FullControlAuthorization { ready: boolean; authorize: () => Promise<void> }

/** New Session with Full Control: the server checks readiness as soon as a workspace is chosen,
 * and the one footer action authorizes and starts the campaign. */
export function FullControlLaunchPanel({ request, selectionValid, disabled, savedDefaults, onAuthorization, onCreated, onActivity, advanced }: {
  request: () => CreateSessionRequest; selectionValid: boolean; disabled: boolean; savedDefaults: OrchestratorDefaults | null;
  onAuthorization: (authorization: FullControlAuthorization) => void; onCreated: (id: string) => void; onActivity?: () => void;
  advanced?: ReactNode;
}) {
  const api = useApi();
  const [task, setTask] = useState("");
  const [issues, setIssues] = useState("");
  const [budget, setBudget] = useState<BudgetDraft>({ cost: "", tools: "", save: true });
  const [limits, setLimits] = useState<LimitDrafts>({ concurrency: "", followUps: "", maxIssues: "", related: null });
  const numbers = issues.trim() ? issues.trim().split(/[,\s]+/).map((value) => Number(value.replace(/^#/, ""))) : [];
  const issuesValid = numbers.length <= 100 && numbers.every((n) => Number.isSafeInteger(n) && n > 0) && new Set(numbers).size === numbers.length;
  const hasWork = task.trim().length > 0 || numbers.length > 0;
  const savedBudget = Boolean(savedDefaults?.campaignBudget);
  const errors = draftErrors(budget, limits);
  const draftsValid = Object.keys(errors).length === 0;
  const base = request();
  const { runnerId, workspaceId, projectId, projectLocationId, agentId, providerAccountId, title, useWorktree, config, orchestrator } = base;
  // The server derives repository, scope and authority. With no work entered yet, readiness is still
  // checked with a placeholder task so a person never has to fill anything in to learn that a launch
  // cannot start. Authorization needs real work, so the placeholder is never what gets authorized.
  const issueNumbers = numbers.length && issuesValid ? numbers : [];
  const taskText = task.trim() || (issueNumbers.length ? undefined : "Full Control readiness check");
  const launch: FullControlLaunchRequest = {
    runnerId, workspaceId, ...(projectId !== undefined ? { projectId } : {}), ...(projectLocationId !== undefined ? { projectLocationId } : {}),
    ...(taskText !== undefined ? { task: taskText } : {}), ...(issueNumbers.length ? { issueNumbers } : {}),
    overrides: {
      session: { agentId, ...(providerAccountId ? { providerAccountId } : {}), ...(title ? { title } : {}),
        ...(useWorktree !== undefined ? { useWorktree } : {}), ...(config ? { config } : {}), ...(orchestrator ? { orchestrator } : {}) },
      ...mergeOverrides(budget, limits),
    },
  };
  const key = selectionValid && runnerId && workspaceId && issuesValid && draftsValid ? JSON.stringify(launch) : null;
  const { value, error, loading } = useServerPreflight(key, (signal) => api.fullControlLaunchPreflight(launch, signal).then((result) => result.preflight));
  const derivedRelated = useRef<boolean | null>(null);
  if (value) derivedRelated.current = value.summary.followUps.relatedFollowUps;
  const identity = useRef<{ key: string | null; requestId: string }>({ key: null, requestId: newRequestId() });
  if (identity.current.key !== key) identity.current = { key, requestId: newRequestId() };
  const [authorizeError, setAuthorizeError] = useState<string | null>(null);
  useEffect(() => { setAuthorizeError(null); onActivity?.(); }, [key]);
  const ready = hasWork && !loading && preflightReady(value);
  const authorizeRef = useRef<() => Promise<void>>(async () => undefined);
  authorizeRef.current = async () => {
    if (!ready || !value || disabled) return;
    setAuthorizeError(null);
    try {
      const session = await api.createFullControlCampaign({ ...launch, requestId: identity.current.requestId, preflightDigest: value.digest });
      await saveFirstBudgetDefault(api, savedDefaults, budget);
      onCreated(session.id);
    } catch (cause) {
      setAuthorizeError(cause instanceof Error ? cause.message : "The campaign was not started.");
      throw cause;
    }
  };
  useEffect(() => { onAuthorization({ ready, authorize: () => authorizeRef.current() }); }, [ready]);
  const scopeLabel = (preflight: CampaignLaunchPreflight) => `${preflight.summary.repository ?? "Repository Not Verified"} · ${
    preflight.summary.issueNumbers.length ? preflight.summary.issueNumbers.map((n) => `#${n}`).join(", ") : "Task Only"}`;
  return <section className="section" aria-label="Full Control Launch">
    <label className="field"><span>Task</span>
      <textarea rows={3} value={task} disabled={disabled} placeholder="Describe what this campaign should deliver."
        onChange={(event) => setTask(event.currentTarget.value)} /></label>
    <label className="field"><span>Issue Numbers</span>
      <input type="text" inputMode="numeric" value={issues} disabled={disabled} placeholder="Optional, for example 12, 14"
        aria-invalid={!issuesValid} onChange={(event) => setIssues(event.currentTarget.value)} /></label>
    {!issuesValid && <span className="form-error" role="alert">Enter up to 100 distinct issue numbers.</span>}
    <FullControlSummary preflight={value} loading={loading} error={draftsValid ? error : INVALID_DRAFTS} scopeLabel={scopeLabel} action="start"
      budgetEntry={!savedBudget ? <BudgetEntry draft={budget} onChange={setBudget} errors={errors} disabled={disabled} /> : undefined}
      advanced={<>
        <LimitFields budget={budget} onBudget={setBudget} limits={limits} onLimits={setLimits} errors={errors}
          derivedRelated={derivedRelated.current} disabled={disabled} savedBudget={savedBudget} />
        {advanced}
      </>} />
    {!hasWork && <p className="muted">Describe the task or enter issue numbers to authorize.</p>}
    {authorizeError && <Notice tone="danger" role="alert">{authorizeError}</Notice>}
  </section>;
}

/** Active campaign: the same summary and one Enable action through the existing control operation. */
export function FullControlEnablePanel({ session, disabled, savedDefaults, onEnabled }: {
  session: SessionView; disabled: boolean; savedDefaults: OrchestratorDefaults | null; onEnabled: (session: SessionView) => void;
}) {
  const api = useApi();
  const [budget, setBudget] = useState<BudgetDraft>({ cost: "", tools: "", save: true });
  const [limits, setLimits] = useState<LimitDrafts>({ concurrency: "", followUps: "", maxIssues: "", related: null });
  const [busy, setBusy] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);
  const savedBudget = Boolean(savedDefaults?.campaignBudget);
  const errors = draftErrors(budget, limits);
  const draftsValid = Object.keys(errors).length === 0;
  const overrides = mergeOverrides(budget, limits);
  const body: FullControlEnableRequest = Object.keys(overrides).length ? { overrides } : {};
  const key = draftsValid ? JSON.stringify([session.id, session.parentControlPolicy?.revision ?? 0, body]) : null;
  const { value, error, loading } = useServerPreflight(key, (signal) => api.fullControlEnablePreflight(session.id, body, signal));
  const derivedRelated = useRef<boolean | null>(null);
  if (value) derivedRelated.current = value.preflight.summary.followUps.relatedFollowUps;
  const ready = !loading && preflightReady(value?.preflight ?? null);
  const enable = async () => {
    if (!ready || !value || busy || disabled) return;
    setBusy(true); setEnableError(null);
    try {
      const enabled = await api.enableFullControl(session.id, { ...body, expectedRevision: value.expectedRevision, preflightDigest: value.preflight.digest });
      await saveFirstBudgetDefault(api, savedDefaults, budget);
      onEnabled(enabled);
    } catch (cause) { setEnableError(cause instanceof Error ? cause.message : "Full Control was not enabled."); }
    finally { setBusy(false); }
  };
  const scopeLabel = (preflight: CampaignLaunchPreflight) => `${preflight.summary.repository ?? "No Repository Scope"} · ${
    preflight.summary.issueNumbers.length ? preflight.summary.issueNumbers.map((n) => `#${n}`).join(", ") : "No Issues"}`;
  return <section className="section" aria-label="Enable Full Control">
    <FullControlSummary preflight={value?.preflight ?? null} loading={loading} error={draftsValid ? error : INVALID_DRAFTS} scopeLabel={scopeLabel} action="enable"
      budgetEntry={!savedBudget ? <BudgetEntry draft={budget} onChange={setBudget} errors={errors} disabled={disabled || busy} /> : undefined}
      advanced={<LimitFields budget={budget} onBudget={setBudget} limits={limits} onLimits={setLimits} errors={errors}
        derivedRelated={derivedRelated.current} disabled={disabled || busy} savedBudget={savedBudget} />} />
    {enableError && <Notice tone="danger" role="alert">{enableError}</Notice>}
    <BusyButton className="btn primary" busy={busy} progress="Enabling Full Control…" disabled={!ready || disabled}
      onClick={() => void enable()}>Enable Full Control</BusyButton>
  </section>;
}
