import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { PROVIDER_ACCOUNT_SKIP_TEXT, type AssistantThreadAccountChoices, type AssistantThreadLimits } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { ApiError } from "../api.js";
import {
  assistantThreadHarnessLabel,
  assistantThreadsOwnerOnly,
  assistantThreadsUnavailable,
  type AssistantThread,
  type AssistantThreadDefaults,
  type AssistantThreadHarness,
} from "../assistant-threads.js";
import { saveComposerDraft, stageComposerDraftHandoff } from "../composer-drafts.js";
import { formatCalendarTime } from "../format.js";
import { parseCount, parseUsd } from "../guardrail-values.js";
import { useInstanceScope } from "../instance-scope.js";
import { isPersonalIdentifier, maskedAccountTitles } from "../personal-identifiers.js";
import { useStoreActions } from "../store.js";
import { AccountIdentifierRevealButton, useAccountIdentifierReveal } from "./AccountIdentifier.js";
import { MACHINE_ACCOUNT_POLICY, canUseMachineAccountPolicy } from "./AssistantThreadAccountField.js";
import { ChevronDownIcon, CloseIcon } from "./Icons.js";
import { MenuSurface } from "./Menu.js";
import { Notice } from "./Notice.js";
import { Skeleton } from "./common.js";
import { useDismissiblePopover } from "./interactions.js";
import { BusyButton } from "./ui/BusyButton.js";
import { ChoiceRows } from "./ui/ChoiceControls.js";
import { useIsMobile } from "./useIsMobile.js";

export const THREADS_UNAVAILABLE_MESSAGE =
  "Assistant threads aren't available on this control plane yet. Update Wollipog to start one.";

type DefaultsState =
  | { kind: "loading" }
  | { kind: "ready"; defaults: AssistantThreadDefaults; limits: AssistantThreadLimits | null }
  | { kind: "blocked"; title: string; message: string }
  | { kind: "failed"; message: string };

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

export type NewAssistantThreadResult = {
  thread: AssistantThread;
  firstMessageFailure?: { reason: string; deliveryUnconfirmed: boolean };
};

const suggestions = [
  { label: "Check on Running Work", prompt: "Check on my running work and tell me what needs attention." },
  { label: "Review Open Decisions", prompt: "Show me the open decisions that need my input." },
  { label: "Plan a Task", prompt: "Help me plan a task and decide how to break it into sessions." },
];

/** Mount in an explicit New Thread pane or in the empty Assistants detail pane. */
export function NewAssistantThreadComposer({ onCancel, onCreated }: {
  onCancel?: () => void;
  onCreated: (result: NewAssistantThreadResult) => void;
}) {
  const api = useApi();
  const scope = useInstanceScope();
  const { loadSession } = useStoreActions();
  const headingId = useId();
  const messageField = useRef<HTMLTextAreaElement>(null);
  const [state, setState] = useState<DefaultsState>({ kind: "loading" });
  const [harness, setHarness] = useState<AssistantThreadHarness | null>(null);
  const [chosenAccount, setChosenAccount] = useState<string | null>(null);
  const [chosenLimits, setChosenLimits] = useState<AssistantThreadLimits | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setState({ kind: "loading" });
    void Promise.all([
      api.assistantThreadDefaults(),
      api.assistantThreadLimitDefaults().catch((cause: unknown) => {
        // Control planes before per-thread limits can still create threads and take prompts.
        if (assistantThreadsUnavailable(cause)) return null;
        throw cause;
      }),
    ]).then(([defaults, limits]) => {
      if (!current) return;
      const preferred = defaults.harnesses.find((option) => option.id === defaults.harness && option.available);
      setHarness(preferred?.id ?? defaults.harnesses.find((option) => option.available)?.id ?? null);
      setState({ kind: "ready", defaults, limits });
    }, (cause: unknown) => {
      if (current) setState(threadBlock(cause) ?? { kind: "failed", message: errorMessage(cause) });
    });
    return () => { current = false; };
  }, [api, attempt]);

  const defaults = state.kind === "ready" ? state.defaults : null;
  const accounts = defaults?.harnesses.find((option) => option.id === harness)?.accountSelection;
  const launchDefaults = defaults?.launchDefaults;
  const saved = launchDefaults?.harness === harness ? launchDefaults?.providerAccount : null;
  const savedChoice = saved && accounts?.runnerId === saved.runnerId
    ? accounts.accounts.find((candidate) => candidate.accountRef === saved.accountRef && !candidate.reason) : undefined;
  const policyAvailable = !accounts || canUseMachineAccountPolicy(accounts);
  const account = chosenAccount ?? (saved ? savedChoice?.accountRef ?? null : policyAvailable ? MACHINE_ACCOUNT_POLICY : null);
  const defaultLimits = state.kind === "ready" ? state.limits : null;
  const limits = chosenLimits ?? defaultLimits;
  const canStart = Boolean(defaults && harness && account && message.trim());

  const start = async () => {
    if (!defaults || !harness || !account || !message.trim() || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setFailure(null);
    let thread: AssistantThread;
    try {
      ({ thread } = await api.createAssistantThread({
        harness,
        ...(accounts && !accounts.unavailable ? { runnerId: accounts.runnerId, workspaceId: accounts.workspaceId } : {}),
        ...(account !== MACHINE_ACCOUNT_POLICY ? { providerAccountRef: account }
          : launchDefaults ? { providerAccountRef: null } : {}),
      }));
    } catch (cause) {
      const block = threadBlock(cause);
      if (block) setState(block);
      else setFailure(errorMessage(cause));
      submitting.current = false;
      setBusy(false);
      return;
    }

    let firstMessageFailure: NewAssistantThreadResult["firstMessageFailure"];
    let applyingLimits = chosenLimits !== null;
    try {
      // Let the first delivered message name the backing session. Apply explicit limits before
      // admitting that message, so it can't start work under the wrong budget.
      if (chosenLimits) ({ thread } = await api.setAssistantThreadLimits(thread.id, chosenLimits));
      applyingLimits = false;
      loadSession(await api.prompt(thread.sessionId, message.trim()));
    } catch (cause) {
      stageComposerDraftHandoff(thread.sessionId, message, [], scope);
      void saveComposerDraft(thread.sessionId, message, [], scope);
      firstMessageFailure = {
        reason: applyingLimits
          ? "The selected budget couldn't be applied. Check Thread Settings before sending. " + errorMessage(cause)
          : errorMessage(cause),
        deliveryUnconfirmed: !applyingLimits && (!(cause instanceof ApiError) || cause.status >= 500),
      };
    }
    // Once create succeeded, retries belong in the backing conversation.
    onCreated({ thread, firstMessageFailure });
  };

  return (
    <form className="new-assistant-thread" aria-labelledby={headingId}
      onSubmit={(event) => { event.preventDefault(); void start(); }}>
      <div className="new-assistant-thread-body">
        <h2 id={headingId}>What should the assistant work on?</h2>
        {state.kind === "loading" && <Skeleton rows={2} announce="Loading thread defaults…" />}
        {state.kind === "blocked" && <>
          <Notice tone="neutral" role="status" title={state.title}>{state.message}</Notice>
          {message.trim() && <label className="field">
            <span>Draft</span><textarea readOnly value={message} />
          </label>}
        </>}
        {state.kind === "failed" && (
          <Notice tone="danger" role="alert" title="Couldn't Load Thread Defaults"
            actions={<button type="button" className="btn" onClick={() => setAttempt((value) => value + 1)}>Retry</button>}>
            {state.message}
          </Notice>
        )}
        {defaults && <>
          <div className="new-assistant-thread-box">
            <label className="sr-only" htmlFor={headingId + "-message"}>First Message</label>
            <textarea id={headingId + "-message"} ref={messageField} value={message} readOnly={busy}
              onChange={(event) => setMessage(event.target.value)} placeholder="Ask the assistant to do something…" />
            <div className="new-assistant-thread-chips">
              <ThreadOption label="Harness" value={harness ? assistantThreadHarnessLabel(harness, defaults.harnesses) : "Choose"}
                disabled={busy}>
                {() => <ChoiceRows<AssistantThreadHarness> label="Harness" value={harness}
                  onChange={(next) => { setChosenAccount(null); setHarness(next); }}
                  options={defaults.harnesses.map((option) => ({
                    value: option.id, title: assistantThreadHarnessLabel(option.id, defaults.harnesses),
                    disabled: !option.available,
                    disabledReason: option.available ? undefined : option.reason ?? "Not available on your machines.",
                  }))} />}
              </ThreadOption>
              <ThreadAccountOption key={harness} choices={accounts} value={account} disabled={busy || !harness}
                onChange={setChosenAccount} />
              {limits && <ThreadOption label="Budget" value={budgetLabel(limits)} disabled={busy}>
                {(close) => <BudgetOptions limits={limits} onApply={(next) => {
                  setChosenLimits(next.costUsd === defaultLimits?.costUsd &&
                    next.launchedSessions === defaultLimits.launchedSessions ? null : next);
                  close();
                }} />}
              </ThreadOption>}
            </div>
          </div>
          {!harness && <Notice tone="warning">No harness is available to start a thread. Open Harness for details.</Notice>}
          {saved && !savedChoice && !chosenAccount && (
            <Notice tone="warning">Your default account is unavailable. Open Account to choose how this thread will sign in.</Notice>
          )}
          {failure && <Notice tone="danger" role="alert" title="Couldn't Start the Thread">{failure}</Notice>}
          <div className="new-assistant-thread-suggestions" aria-label="Starter Prompts" role="group">
            {suggestions.map(({ label, prompt }) => (
              <button key={label} type="button" className="btn" disabled={busy} onClick={() => {
                setMessage(prompt);
                messageField.current?.focus();
              }}>{label}</button>
            ))}
          </div>
        </>}
      </div>
      <div className="new-assistant-thread-actions">
        {onCancel && <button type="button" className="btn" disabled={busy} onClick={onCancel}>Cancel</button>}
        {defaults && <BusyButton type="submit" className="btn primary" busy={busy}
          progress="Starting the thread…" disabled={!canStart}>Start Thread</BusyButton>}
      </div>
    </form>
  );
}

function ThreadOption({ label, value, disabled, className, fitWithinViewport, children }: {
  label: string;
  value: string;
  disabled: boolean;
  className?: string;
  fitWithinViewport?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const popover = useDismissiblePopover(open, setOpen, "new-thread-option");
  const contentRef = useRef<HTMLDivElement>(null);
  const close = () => popover.close(true);
  return <>
    <button type="button" className="btn new-assistant-option" ref={popover.triggerRef} disabled={disabled}
      aria-haspopup="dialog" aria-expanded={open && !disabled} aria-controls={open && !disabled ? popover.panelId : undefined}
      onClick={popover.toggle} onKeyDown={popover.onTriggerKeyDown}>
      <span>{label} <strong>{value}</strong></span><ChevronDownIcon size={14} />
    </button>
    {open && !disabled && <MenuSurface surfaceRef={popover.panelRef} contentRef={contentRef}
      anchor={{ trigger: popover.triggerRef }} boundary=".new-assistant-thread" kind="popover" role="dialog"
      label={label} className={className ? "new-assistant-option-panel " + className : "new-assistant-option-panel"}
      id={popover.panelId} tabIndex={-1}
      fitWithinViewport={fitWithinViewport}
      onScroll={fitWithinViewport
        ? (event) => event.currentTarget.toggleAttribute("data-scrolled", event.currentTarget.scrollTop > 0)
        : undefined}
      onDismiss={close} onKeyDown={popover.onPanelKeyDown}
      head={<div className="menu-head persistent">
        <span className="menu-head-title">{label}</span>
        <button type="button" className="icon-btn" aria-label={"Close " + label} onClick={close}><CloseIcon size={16} /></button>
      </div>}>
      <div ref={contentRef} className="new-assistant-option-content">{children(close)}</div>
    </MenuSurface>}
  </>;
}

function ThreadAccountOption({ choices, value, disabled, onChange }: {
  choices: AssistantThreadAccountChoices | undefined;
  value: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const phone = useIsMobile();
  const accounts = choices?.accounts ?? [];
  const labels = accounts.map(({ label }) => label);
  const [revealed, toggle] = useAccountIdentifierReveal(JSON.stringify(accounts.map(({ accountRef, label }) => [accountRef, label])));
  const titles = revealed ? labels : maskedAccountTitles(labels);
  const policyIndex = accounts.findIndex(({ accountRef }) => accountRef === choices?.policyAccountRef);
  const policyTitle = policyIndex < 0 ? "Machine Policy" : "Machine Policy · " + titles[policyIndex];
  const selectedIndex = accounts.findIndex(({ accountRef }) => accountRef === value);
  const eligible = accounts.flatMap((account, index) => account.reason ? [] : [{ value: account.accountRef, title: titles[index]! }]);
  const unavailable = accounts.flatMap((account, index) => account.reason ? [{
    ref: account.accountRef, title: titles[index]!,
    reason: "This account " + PROVIDER_ACCOUNT_SKIP_TEXT[account.reason] +
      (account.retryAt === undefined ? "" : account.reason === "usage_exhausted"
        ? " until " + formatCalendarTime(account.retryAt)
        : ". Try again after " + formatCalendarTime(account.retryAt)) + ".",
  }] : []);
  const usePolicy = !choices || canUseMachineAccountPolicy(choices);
  const options = usePolicy ? [{ value: MACHINE_ACCOUNT_POLICY, title: policyTitle }, ...eligible] : eligible;
  return <ThreadOption label="Account" value={value === MACHINE_ACCOUNT_POLICY ? policyTitle : titles[selectedIndex] ?? "Choose"}
    disabled={disabled} className="new-assistant-account-panel" fitWithinViewport>
    {() => <>
      {labels.some(isPersonalIdentifier) && <AccountIdentifierRevealButton label="Emails" revealed={revealed}
        onToggle={toggle} withText />}
      {options.length > 0 && <ChoiceRows label="Eligible Accounts" value={value} onChange={onChange} options={options} />}
      {(choices?.unavailable || choices?.policyRefusal) && <p>{choices.unavailable ?? choices.policyRefusal}</p>}
      {unavailable.length > 0 && <details className="new-assistant-unavailable" onToggle={(event) => {
        const group = event.currentTarget;
        const panel = group.closest(".new-assistant-account-panel");
        if (phone && group.open && panel && panel.scrollHeight > panel.clientHeight) {
          group.querySelector("summary")?.scrollIntoView({ block: "start" });
        }
      }}>
        <summary className="btn">Unavailable <span className="count">{unavailable.length}</span></summary>
        <ul>{unavailable.map((account) => <li key={account.ref}>
          <strong>{account.title}</strong><span>{account.reason}</span>
        </li>)}</ul>
      </details>}
    </>}
  </ThreadOption>;
}

function budgetLabel({ costUsd, launchedSessions }: AssistantThreadLimits): string {
  const budget = costUsd === null ? "No Budget Limit" : "$" + costUsd;
  const launches = launchedSessions === null ? "No Launch Limit"
    : launchedSessions + (launchedSessions === 1 ? " Launch" : " Launches");
  return budget + " · " + launches;
}

function BudgetOptions({ limits, onApply }: {
  limits: AssistantThreadLimits;
  onApply: (limits: AssistantThreadLimits) => void;
}) {
  const [budget, setBudget] = useState(limits.costUsd?.toString() ?? "");
  const [launches, setLaunches] = useState(limits.launchedSessions?.toString() ?? "");
  const parsedBudget = parseUsd(budget);
  const parsedLaunches = parseCount(launches, Number.POSITIVE_INFINITY);
  const budgetError = !parsedBudget.ok ? parsedBudget.error
    : parsedBudget.value !== null && parsedBudget.value !== limits.costUsd &&
      (!Number.isSafeInteger(Math.round(parsedBudget.value * 100)) || Number(parsedBudget.value.toFixed(2)) !== parsedBudget.value)
      ? "Enter a positive amount in whole cents." : null;
  return <>
    <label className="field">
      <span>Budget (USD)</span>
      <input inputMode="decimal" value={budget} placeholder="No Limit" onChange={(event) => setBudget(event.target.value)} />
      {budgetError && <span className="field-error">{budgetError}</span>}
    </label>
    <label className="field">
      <span>Session Launch Limit</span>
      <input inputMode="numeric" value={launches} placeholder="No Limit" onChange={(event) => setLaunches(event.target.value)} />
      {!parsedLaunches.ok && <span className="field-error">{parsedLaunches.error}</span>}
    </label>
    <button type="button" className="btn primary" disabled={Boolean(budgetError) || !parsedLaunches.ok}
      onClick={() => {
        if (parsedBudget.ok && parsedLaunches.ok && !budgetError) {
          onApply({ costUsd: parsedBudget.value, launchedSessions: parsedLaunches.value });
        }
      }}>Apply Budget</button>
  </>;
}
