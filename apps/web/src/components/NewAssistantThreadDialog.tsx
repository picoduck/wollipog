import { useEffect, useId, useRef, useState } from "react";
import {
  ASSISTANT_DECISION_CATEGORIES,
  ASSISTANT_DECISION_DEFAULT_DURATIONS,
  type AssistantDecisionCategory,
  type AssistantDecisionDefault,
  type AssistantThreadLimits,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { formatAssistantDefaultDelegation } from "../assistant-decision-delegation.js";
import {
  assistantEffortChoices,
  assistantModelChoices,
  effortAfterModelChange,
  fromChoice,
  modelEffortProblem,
  reportsModels,
  toChoice,
} from "../assistant-thread-models.js";
import {
  assistantThreadHarnessLabel,
  assistantThreadsOwnerOnly,
  assistantThreadsUnavailable,
  type AssistantThread,
  type AssistantThreadDefaults,
  type AssistantThreadHarness,
} from "../assistant-threads.js";
import { parseCount, parseUsd } from "../guardrail-values.js";
import { isPersonalIdentifier, maskedAccountTitles } from "../personal-identifiers.js";
import { useStoreSelector } from "../store.js";
import { AccountIdentifierRevealButton, useAccountIdentifierReveal } from "./AccountIdentifier.js";
import { ASSISTANT_DEFAULTS_VIEW, AssistantSettingsLink } from "./AssistantSettingsLink.js";
import { MACHINE_ACCOUNT_POLICY, assistantAccountOptions } from "./AssistantThreadAccountField.js";
import { FieldError } from "./FieldError.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { Skeleton } from "./common.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Select } from "./ui/ChoiceControls.js";

export const THREADS_UNAVAILABLE_MESSAGE =
  "Assistant threads aren't available on this control plane yet. Update Wollipog to start one.";

type DefaultsState =
  | { kind: "loading" }
  | { kind: "ready"; defaults: AssistantThreadDefaults; limits: AssistantThreadLimits | null }
  | { kind: "blocked"; title: string; message: string }
  | { kind: "failed"; message: string };

type Delegation = "default" | "ask" | "all";

function threadBlock(cause: unknown): Extract<DefaultsState, { kind: "blocked" }> | null {
  if (assistantThreadsUnavailable(cause)) {
    return { kind: "blocked", title: "Threads Aren't Available Yet", message: THREADS_UNAVAILABLE_MESSAGE };
  }
  const ownerOnly = assistantThreadsOwnerOnly(cause);
  return ownerOnly === null ? null : { kind: "blocked", title: "Threads Are for Owners", message: ownerOnly };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Whole cents, positive; empty is no limit. */
function budgetEntry(text: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const parsed = parseUsd(text);
  if (!parsed.ok) return parsed;
  if (parsed.value !== null &&
      (!Number.isSafeInteger(Math.round(parsed.value * 100)) || Number(parsed.value.toFixed(2)) !== parsed.value)) {
    return { ok: false, error: "Enter an amount in whole cents, such as 2.50." };
  }
  return parsed;
}

export interface NewAssistantThreadResult {
  thread: AssistantThread;
  /** What couldn't be applied after the thread was created, in one sentence. */
  setupFailure?: string;
}

/**
 * New Thread (§ New Session): where the thread runs, its model, and what it may spend and decide.
 * The first message is written in the thread itself once it opens, as a new session's is.
 */
export function NewAssistantThreadDialog({ onClose, onCreated }: {
  onClose: () => void;
  /** `stillOpen` is false once this dialog has closed, as when the owner left before creation
   * finished; a New Thread opened since is another dialog, and the thread must not replace it. */
  onCreated: (result: NewAssistantThreadResult, stillOpen: boolean) => void;
}) {
  const api = useApi();
  const formId = useId();
  const reasonId = `${formId}-reason`;
  const accountErrorId = `${formId}-account-error`;
  const modelErrorId = `${formId}-model-error`;
  const effortErrorId = `${formId}-effort-error`;
  const [state, setState] = useState<DefaultsState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [harness, setHarness] = useState<AssistantThreadHarness | null>(null);
  const [chosenAccount, setChosenAccount] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [budget, setBudget] = useState("");
  const [launches, setLaunches] = useState("");
  const [delegation, setDelegation] = useState<Delegation>("default");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const ciRerunSupported = useStoreSelector((store) => store.assistantCiRerunDecisionsSupported);
  const releaseSupported = useStoreSelector((store) => store.assistantReleaseDecisionsSupported);

  useEffect(() => {
    let current = true;
    setState({ kind: "loading" });
    void Promise.all([
      api.assistantThreadDefaults(),
      api.assistantThreadLimitDefaults().catch((cause: unknown) => {
        // Control planes before per-thread limits can still create threads.
        if (assistantThreadsUnavailable(cause)) return null;
        throw cause;
      }),
    ]).then(([defaults, limits]) => {
      if (!current) return;
      const preferred = defaults.harnesses.find((option) => option.id === defaults.harness && option.available)?.id
        ?? defaults.harnesses.find((option) => option.available)?.id ?? null;
      setHarness(preferred);
      if (preferred === defaults.launchDefaults?.harness) {
        setModel(defaults.launchDefaults.model ?? null);
        setEffort(defaults.launchDefaults.effort ?? null);
      }
      setBudget(limits?.costUsd?.toString() ?? "");
      setLaunches(limits?.launchedSessions?.toString() ?? "");
      setState({ kind: "ready", defaults, limits });
    }, (cause: unknown) => {
      if (current) setState(threadBlock(cause) ?? { kind: "failed", message: errorMessage(cause) });
    });
    return () => { current = false; };
  }, [api, attempt]);

  const defaults = state.kind === "ready" ? state.defaults : null;
  const option = defaults?.harnesses.find((candidate) => candidate.id === harness);
  const choices = option?.accountSelection;
  const launchDefaults = defaults?.launchDefaults;
  const saved = launchDefaults?.harness === harness ? launchDefaults?.providerAccount : null;
  const savedChoice = saved && choices?.runnerId === saved.runnerId
    ? choices.accounts.find((candidate) => candidate.accountRef === saved.accountRef && !candidate.reason) : undefined;
  const labels = choices?.accounts.map(({ label }) => label) ?? [];
  const [revealed, toggleReveal] = useAccountIdentifierReveal(JSON.stringify(choices?.accounts.map(({ accountRef, label }) => [accountRef, label]) ?? []));
  const accountOptions = assistantAccountOptions(choices, revealed ? labels : maskedAccountTitles(labels));
  const policyAvailable = accountOptions.some((candidate) => candidate.value === MACHINE_ACCOUNT_POLICY);
  const account = chosenAccount ?? (saved ? savedChoice?.accountRef ?? null : policyAvailable ? MACHINE_ACCOUNT_POLICY : null);
  const accountMissing = Boolean(defaults && harness && !account && !choices?.unavailable);

  const modelsOffered = reportsModels(option) && launchDefaults !== undefined && "model" in launchDefaults;
  const modelProblem = modelsOffered ? modelEffortProblem(option, model, effort) : null;
  const limitsOffered = state.kind === "ready" && state.limits !== null;
  const budgetValue = budgetEntry(budget);
  const launchValue = parseCount(launches, Number.MAX_SAFE_INTEGER);
  const decisionDefault = defaults?.decisionDefault;
  const delegationOffered = decisionDefault !== undefined;

  const blockedReason = !defaults ? null
    : !harness ? "No harness can start a thread. Choose Harness for details."
      : accountMissing ? "Choose an account."
        : modelProblem ? modelProblem.message
          : limitsOffered && !budgetValue.ok ? budgetValue.error
            : limitsOffered && !launchValue.ok ? launchValue.error : null;

  const allGrant = (base: AssistantDecisionDefault | null | undefined) => {
    const unavailable = new Set<AssistantDecisionCategory>(["ui_evidence_review"]);
    if (!ciRerunSupported) unavailable.add("ci_rerun");
    if (!releaseSupported) { unavailable.add("release_tag"); unavailable.add("release_publish"); }
    const expiresAfterMs = base ? base.expiresAfterMs : ASSISTANT_DECISION_DEFAULT_DURATIONS.week;
    return {
      categories: (Object.keys(ASSISTANT_DECISION_CATEGORIES) as AssistantDecisionCategory[]).filter((category) => !unavailable.has(category)),
      selectionMode: "all" as const, projects: "all" as const, campaigns: "all" as const,
      expiresAt: expiresAfterMs === null ? null : Date.now() + expiresAfterMs,
    };
  };

  const create = async () => {
    if (!defaults || !harness || !account || blockedReason || busy) return;
    setBusy(true);
    setFailure(null);
    let thread: AssistantThread;
    try {
      ({ thread } = await api.createAssistantThread({
        harness,
        ...(choices && !choices.unavailable ? { runnerId: choices.runnerId, workspaceId: choices.workspaceId } : {}),
        ...(account !== MACHINE_ACCOUNT_POLICY ? { providerAccountRef: account }
          : launchDefaults ? { providerAccountRef: null } : {}),
        ...(modelsOffered ? { model, effort } : {}),
      }));
    } catch (cause) {
      if (!mounted.current) return;
      const block = threadBlock(cause);
      if (block) setState(block);
      else setFailure(errorMessage(cause));
      setBusy(false);
      return;
    }
    // The thread exists. What follows only adjusts it before its first message, and a failure says
    // where to finish the change instead of losing the thread.
    const failures: string[] = [];
    if (limitsOffered && state.limits && budgetValue.ok && launchValue.ok &&
        (budgetValue.value !== state.limits.costUsd || launchValue.value !== state.limits.launchedSessions)) {
      try {
        ({ thread } = await api.setAssistantThreadLimits(thread.id, { costUsd: budgetValue.value, launchedSessions: launchValue.value }));
      } catch (cause) { failures.push("The budget couldn't be applied: " + errorMessage(cause)); }
    }
    if (delegation !== "default" && !thread.decisionDelegation) {
      failures.push("This control plane doesn't support decision delegation for the thread.");
    } else if (delegation !== "default" && thread.decisionDelegation) {
      try {
        ({ thread } = await api.setAssistantThreadDelegation(thread.id, {
          revision: thread.decisionDelegation.revision,
          grant: delegation === "ask" ? null : allGrant(decisionDefault),
        }));
      } catch (cause) { failures.push("The decision delegation couldn't be applied: " + errorMessage(cause)); }
    }
    onCreated({ thread, ...(failures.length ? { setupFailure: failures.join(" ") + " Change it in Thread Settings." } : {}) },
      mounted.current);
  };

  const harnessOptions = defaults?.harnesses.map((candidate) => ({
    value: candidate.id,
    label: assistantThreadHarnessLabel(candidate.id, defaults.harnesses),
    disabled: !candidate.available,
    disabledReason: candidate.available ? undefined : candidate.reason ?? "Not available on your machines.",
  })) ?? [];
  const delegationOptions: { value: Delegation; label: string; description?: string }[] = [
    { value: "default", label: formatAssistantDefaultDelegation(decisionDefault ?? null), description: "Your default for new threads." },
    ...(decisionDefault ? [{ value: "ask" as const, label: "Ask Me", description: "The assistant asks you before every decision." }] : []),
    ...(decisionDefault?.selectionMode !== "all" ? [{ value: "all" as const, label: "Delegate All",
      description: "The assistant decides every category it can, except approving UI evidence, which needs your disclosure in Thread Settings." }] : []),
  ];

  return (
    <Modal title="New Thread" description="Choose who runs the thread and what it may do. Write your first message once it opens."
      onClose={busy ? () => {} : onClose} phoneSheet="full"
      tertiary={<AssistantSettingsLink view={ASSISTANT_DEFAULTS_VIEW} className="btn ghost">Assistant Settings</AssistantSettingsLink>}
      footer={<>
        {blockedReason && <p className="new-session-reason" id={reasonId}>{blockedReason}</p>}
        <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
        {defaults && <BusyButton type="submit" form={formId} className="btn primary" busy={busy}
          progress="Creating the thread…" disabled={Boolean(blockedReason)}
          aria-describedby={blockedReason ? reasonId : undefined}>Create Thread</BusyButton>}
      </>}>
      <form id={formId} className="form" noValidate onSubmit={(event) => { event.preventDefault(); void create(); }}>
        {state.kind === "loading" && <Skeleton rows={4} announce="Loading thread defaults…" />}
        {state.kind === "blocked" && <Notice tone="neutral" role="status" title={state.title}>{state.message}</Notice>}
        {state.kind === "failed" && (
          <Notice tone="danger" role="alert" title="Couldn't Load Thread Defaults"
            actions={<button type="button" className="btn" onClick={() => setAttempt((value) => value + 1)}>Try Again</button>}>
            {state.message}
          </Notice>
        )}
        {defaults && <>
          <div className="field-row">
            <div className="field">
              <span className="new-session-field-label">Harness</span>
              <Select<AssistantThreadHarness> label="Harness" value={harness} options={harnessOptions} disabled={busy}
                placeholder="Choose a Harness…" emptyLabel="No Harnesses"
                onChange={(next) => {
                  if (next === harness) return;
                  setHarness(next);
                  setChosenAccount(null);
                  // Saved models belong to the harness they were saved for.
                  setModel(next === launchDefaults?.harness ? launchDefaults.model ?? null : null);
                  setEffort(next === launchDefaults?.harness ? launchDefaults.effort ?? null : null);
                }} />
            </div>
            <div className="field">
              <div className="pid-field-head">
                <span className="new-session-field-label">Account</span>
                {labels.some(isPersonalIdentifier) && (
                  <AccountIdentifierRevealButton label="Emails" revealed={revealed} onToggle={toggleReveal} withText />
                )}
              </div>
              {choices?.unavailable
                ? <p className="field-helper">{choices.unavailable}</p>
                : <Select<string> label="Account" value={account} options={accountOptions} disabled={busy || !harness}
                  placeholder="Choose an Account…" emptyLabel="No Accounts" invalid={accountMissing} onChange={setChosenAccount}
                  describedBy={saved && !savedChoice && !chosenAccount ? accountErrorId : undefined} />}
              {saved && !savedChoice && !chosenAccount && (
                <FieldError id={accountErrorId}>Your default account is unavailable. Choose how this thread signs in.</FieldError>
              )}
            </div>
          </div>
          {modelsOffered && <div className="field-row">
            <div className="field">
              <span className="new-session-field-label">Model</span>
              <Select<string> label="Model" value={toChoice(model)} options={assistantModelChoices(option, model)} disabled={busy}
                invalid={modelProblem?.field === "model"} describedBy={modelProblem?.field === "model" ? modelErrorId : undefined}
                onChange={(next) => { const value = fromChoice(next); setModel(value); setEffort((current) => effortAfterModelChange(option, value, current)); }} />
              {modelProblem?.field === "model" && <FieldError id={modelErrorId}>{modelProblem.message}</FieldError>}
            </div>
            <div className="field">
              <span className="new-session-field-label">Effort</span>
              <Select<string> label="Effort" value={toChoice(effort)} options={assistantEffortChoices(option, model, effort)}
                disabled={busy} invalid={modelProblem?.field === "effort"} onChange={(next) => setEffort(fromChoice(next))}
                describedBy={modelProblem?.field === "effort" ? effortErrorId : undefined} />
              {modelProblem?.field === "effort" && <FieldError id={effortErrorId}>{modelProblem.message}</FieldError>}
            </div>
          </div>}
          {modelsOffered && <p className="field-helper">You can change the model and effort in the thread's composer at any time.</p>}
          {/* Plain fields like the ones above, not a bordered group inside the dialog's own surface. */}
          {limitsOffered && <div className="field-row">
            <div className="field">
              <span className="new-session-field-label" id={`${formId}-budget`}>Budget</span>
              <span className="input-affix">
                <input inputMode="decimal" autoComplete="off" value={budget} placeholder="No Limit" disabled={busy}
                  aria-labelledby={`${formId}-budget ${formId}-budget-unit`} aria-invalid={budgetValue.ok ? undefined : true}
                  aria-describedby={`${formId}-budget-help`} onChange={(event) => setBudget(event.currentTarget.value)} />
                <span className="input-affix-text" id={`${formId}-budget-unit`}>USD</span>
              </span>
              {budgetValue.ok
                ? <p className="field-helper" id={`${formId}-budget-help`}>Covers the thread and everything it launches.</p>
                : <FieldError id={`${formId}-budget-help`}>{budgetValue.error}</FieldError>}
            </div>
            <div className="field">
              <label className="new-session-field-label" htmlFor={`${formId}-launches`}>Session Launches</label>
              <input id={`${formId}-launches`} inputMode="numeric" autoComplete="off" value={launches} placeholder="No Limit"
                disabled={busy} aria-invalid={launchValue.ok ? undefined : true} aria-describedby={`${formId}-launches-help`}
                onChange={(event) => setLaunches(event.currentTarget.value)} />
              {launchValue.ok
                ? <p className="field-helper" id={`${formId}-launches-help`}>0 pauses new launches.</p>
                : <FieldError id={`${formId}-launches-help`}>{launchValue.error}</FieldError>}
            </div>
          </div>}
          {delegationOffered && <div className="field">
            <span className="new-session-field-label">Decision Delegation</span>
            <Select<Delegation> label="Decision Delegation" value={delegation} options={delegationOptions} disabled={busy}
              describedBy={`${formId}-delegation-help`} onChange={setDelegation} />
            <p className="field-helper" id={`${formId}-delegation-help`}>
              {delegationOptions.find((candidate) => candidate.value === delegation)?.description}
            </p>
          </div>}
          {failure && <Notice tone="danger" role="alert" title="Couldn't Create the Thread">{failure}</Notice>}
        </>}
      </form>
    </Modal>
  );
}

