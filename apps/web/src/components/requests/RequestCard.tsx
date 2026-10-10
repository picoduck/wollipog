import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type Ref,
} from "react";
import type { GovernancePolicy, PendingApproval, PermissionOption, SessionView } from "@wollipog/protocol";
import { useApi } from "../../api-context.js";
import type { ApiClient } from "../../api.js";
import { titleCaseLabel } from "../../format.js";
import { RelativeTime } from "../RelativeTime.js";
import { runnerDisplay } from "../../runners.js";
import { useOptionalNavigate, useOptionalStoreSelector } from "../../store.js";
import { sessionCommandRefusal } from "../../session-command-permissions.js";
import { useAccessibleMenu } from "../interactions.js";
import { MenuItem, MenuSurface } from "../Menu.js";
import { BanIcon, ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, MoreHorizontalIcon } from "../Icons.js";
import { Notice } from "../Notice.js";
import { BusyButton } from "../ui/BusyButton.js";
import { ChoiceRows } from "../ui/ChoiceControls.js";
import { CopyButton } from "../common.js";
import { StructuredQuestionText } from "../StructuredQuestionText.js";
import { ProviderLoginCard } from "../ProviderLoginCard.js";
import { useIsMobile } from "../useIsMobile.js";
import { holdFieldFocus } from "./hold-field-focus.js";
import { useRemovedFocus } from "../useRemovedFocus.js";
import { useClipEdges } from "./clip-edges.js";
import {
  AuthenticationRecoveryPanel,
  SIGN_IN_COPY,
  authenticationAccountChoiceApplies,
  authenticationRecoveryPanelApplies,
  signInProviderName,
} from "../AuthenticationRecoveryPanel.js";
import { CHOOSE_ACCOUNT_COPY, ChooseAccountDialog, type ChooseAccountResult } from "./ChooseAccountDialog.js";
import { EvidenceReviewBody, useEvidenceReview } from "./EvidenceReview.js";
import { WorkflowDecisionSummary } from "./WorkflowDecisionSummary.js";
import { claimDecision, decisionKey, useDecisionFailure, useDecisionInFlight } from "./request-reveal.js";
import {
  REQUEST_CARD_COPY,
  RequestKindIcon,
  requestCardActions,
  requestKindMeta,
  requestOptionForIntent,
  requestPolicyLine,
  signInCardActions,
  type SignInCardActions,
} from "./request-meta.js";

/** A one-key decision on the card: true when the card took the key, whether or not it could act. */
export type RequestIntentHandler = (intent: "approve" | "deny") => boolean;

export interface RequestCardProps {
  /** The session the request belongs to: its id, runner and the reader's permissions on it. */
  session: SessionView;
  request: PendingApproval;
  runnerOnline: boolean;
  /** The dock above the composer, or a side panel's detail (child and worker requests): flush, with
   * a larger title and a footer that sticks to the panel's edge (#2206). */
  presentation: "dock" | "panel";
  /** Plain text: who asks. The agent, or "Plan Reviewer, a subagent". Omitted where the surrounding
   * surface already names it. */
  owner?: string;
  /** When the request was raised, when known. A workflow decision carries its own. */
  createdAt?: number;
  /** Controls at the end of the head line: the notice slot's "+N More" while the dock holds it. */
  headTrailing?: ReactNode;
  onSessionUpdate?: (session: SessionView) => void;
  /** Keycaps for A and D inside their buttons. CSS still hides them on a coarse pointer (§11.5). */
  showKeyHints?: boolean;
  /** Receives the card's A and D while it is the expanded request. */
  intentRef?: MutableRefObject<RequestIntentHandler | null>;
  headingRef?: Ref<HTMLHeadingElement>;
  /** The dock shows its reading-back strip in the card's place (#2195). The card stays mounted, so a
   * sign-in code being typed or an evidence review keeps its state, but its menu closes. */
  concealed?: boolean;
  /** Explicit reading mode on the session dock, shared with expanded questions (#2874). */
  onReadingChange?: (reading: boolean) => void;
  /** Someone else answers this request (an Orchestrator-owned child request, #2206): the card says
   * so in a neutral notice under its title and shows the request's facts, with no actions. */
  readOnlyNotice?: string;
  /** The session's harness and machine account are not known here (a child's request read from an
   * older server, #2714): the card shows no account facts rather than another session's, and Check
   * Again stays in its footer. */
  accountUnknown?: boolean;
}

/**
 * The one Request Card (docs/design-system.md §13.2 Request dock; #2179): a session's permission,
 * policy ask, guardrail pause or workflow decision, answered where it is read.
 *
 * Top to bottom: a head line (kind, owner, time), the title, an optional policy line, a body that
 * scrolls on its own, a failed-decision notice, the reason nobody can act now, and a footer whose
 * order never follows the provider's (`requestCardActions`). The head, title and footer stay in
 * view; only the body scrolls, so a long command never pushes the decision out of reach.
 */
export function RequestCard({
  session,
  request,
  runnerOnline,
  presentation,
  owner,
  createdAt,
  headTrailing,
  onSessionUpdate,
  showKeyHints = false,
  intentRef,
  headingRef,
  concealed = false,
  onReadingChange,
  readOnlyNotice,
  accountUnknown = false,
}: RequestCardProps) {
  const api = useApi();
  const runner = useOptionalStoreSelector((state) => state.runners.get(session.runnerId));
  // A person the server refuses a decision (a Viewer) reads the request with every option disabled
  // and the reason beside them (#1857).
  const responseRefusal = sessionCommandRefusal(session, "respond");
  const providerLogin = runner?.providerLogins?.find(
    (login) => login.sessionId === session.id && login.status !== "succeeded" && login.status !== "cancelled",
  );
  const evidence = useEvidenceReview(session.id, request);
  const workflowDecision = request.kind === "workflow_decision" ? request.workflowDecision : undefined;
  const meta = requestKindMeta(request);
  // The decision in flight lives outside the card, which remounts when another request is expanded
  // and this one comes back; a second decision for the same occurrence is refused until it settles.
  const flightKey = decisionKey(session.id, request.requestId, request.occurrenceId);
  const [readingKey, setReadingKey] = useState<string | null>(null);
  const canExpandDecision = request.kind === "workflow_decision" && presentation === "dock" && onReadingChange !== undefined;
  const reading = canExpandDecision && readingKey === flightKey;
  const onReadingChangeRef = useRef(onReadingChange);
  onReadingChangeRef.current = onReadingChange;
  useEffect(() => {
    if (!reading) return;
    onReadingChangeRef.current?.(true);
    return () => onReadingChangeRef.current?.(false);
  }, [reading]);
  const busy = useDecisionInFlight(flightKey);
  const error = useDecisionFailure(flightKey);
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useAccessibleMenu(menuOpen, setMenuOpen, "request-options", "item", { reachUnavailable: true });
  // The menu is portalled, so hiding the card would leave it open over the strip.
  useLayoutEffect(() => {
    if (concealed) setMenuOpen(false);
  }, [concealed]);
  const idPrefix = useId().replace(/:/g, "");
  const titleId = `${idPrefix}-title`;
  const bodyId = `${idPrefix}-body`;
  const reasonId = `${idPrefix}-reason`;
  const signInReasonId = `${idPrefix}-sign-in-reason`;
  const evidenceReasonId = `${idPrefix}-evidence-reason`;
  const policyName = useGovernancePolicyName(api, request.governancePolicyId);
  const remaining = useCountdown(request.expiresAt);

  // Guardrail pauses and workflow decisions are resolved by the control plane; everything else is
  // answered by the runner, which must be connected to take it.
  const decisionNeedsRunner = request.kind !== "policy_hook" && request.kind !== "workflow_decision";
  const reason = responseRefusal ?? (decisionNeedsRunner && !runnerOnline ? REQUEST_CARD_COPY.runnerOffline : null);
  const signInBlocked = runner?.canManage === false && request.options.some((option) => option.optionId === "auth:login");
  const optionReason = (option: PermissionOption): string | null =>
    option.optionId === "auth:login" && runner?.canManage === false ? signInReasonId
      : option.optionId === "approve" && evidence && !evidence.complete ? evidenceReasonId
        : null;
  const unavailable = (option: PermissionOption) => reason !== null || optionReason(option) !== null;
  const describedBy = (option: PermissionOption) =>
    [reason !== null ? reasonId : null, optionReason(option)].filter(Boolean).join(" ") || undefined;

  const decide = async (option: PermissionOption) => {
    if (unavailable(option)) return;
    // Synchronous, so a second press or a held A key cannot slip in before the busy state renders.
    const release = claimDecision(flightKey, option.optionId);
    if (!release) return;
    let failure: string | undefined;
    try {
      const updated = await api.approve(session.id, {
        requestId: request.requestId,
        optionId: option.optionId,
        ...(evidence && option.optionId === "approve" ? evidence.approval() : {}),
      });
      evidence?.clearDraft();
      onSessionUpdate?.(updated);
    } catch (cause) {
      failure = (cause as Error).message;
    } finally {
      release(failure);
    }
  };

  const decideRef = useRef(decide);
  decideRef.current = decide;
  useEffect(() => {
    if (!intentRef || readOnlyNotice) return;
    const handler: RequestIntentHandler = (intent) => {
      const option = requestOptionForIntent(request.options, intent);
      if (option) void decideRef.current(option);
      // The expanded request owns A and D even when it cannot act on them, so the key never falls
      // through to a different request.
      return true;
    };
    intentRef.current = handler;
    return () => {
      if (intentRef.current === handler) intentRef.current = null;
    };
  }, [intentRef, readOnlyNotice, request.options]);

  const signIn = request.kind === "authentication";
  // Every kind marks the edges its scrolling body can still scroll past (#2715).
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useClipEdges(bodyRef);
  const actions: SignInCardActions = signIn
    ? signInCardActions(request.options)
    : { ...requestCardActions(request.options), recheck: null, methods: [] };
  const { tertiary, secondary, menu: menuOptions, primary, recheck, methods } = actions;
  const recovery = !accountUnknown && authenticationRecoveryPanelApplies(session, request);
  // Check Again lives on the recovery body's Last Checked fact. Where that body is not shown (a
  // harness without it, or a child whose account is unknown here) the recheck stays a secondary.
  const footerSecondary = recheck && !recovery ? [...secondary, recheck] : secondary;
  // What Choose Another Account… belongs to: this card and the account it was opened against. A
  // change to either closes the dialog and drops its notice, so neither speaks for a newer card.
  const accountCardKey = `${request.requestId}\u0000${session.providerAccountId ?? ""}`;
  // A `not_resumable` refusal holds for every account, so the choice leaves this request's footer.
  const [cantSwitch, setCantSwitch] = useState<string | null>(null);
  const canChooseAccount = !accountUnknown && authenticationAccountChoiceApplies(session, request, runner) &&
    cantSwitch !== request.requestId;
  const [choosingAccount, setChoosingAccount] = useState<string | null>(null);
  const [accountNotice, setAccountNotice] = useState<{ key: string; text: string; cantSwitch: boolean } | null>(null);
  const [identityRefresh, setIdentityRefresh] = useState(0);
  const box = useOptionalStoreSelector((state) => [...state.boxes.values()].find((candidate) => candidate.runnerId === session.runnerId));
  const navigate = useOptionalNavigate();
  const chooseAccount = () => {
    setAccountNotice(null);
    setChoosingAccount(accountCardKey);
  };
  const chosenAccount = (result: ChooseAccountResult) => {
    setChoosingAccount(null);
    if (result.kind === "selected") return;
    if (result.kind === "cant_switch") {
      setCantSwitch(request.requestId);
      setAccountNotice({ key: request.requestId, text: CHOOSE_ACCOUNT_COPY.cantSwitch, cantSwitch: true });
    } else {
      const text = result.kind === "cancelled" ? result.refusal : result.notice;
      if (text) setAccountNotice({ key: accountCardKey, text, cantSwitch: false });
    }
    // A refused choice may have rechecked a sign-in, so the facts read the account again.
    if (result.kind !== "cancelled" || result.refusal) setIdentityRefresh((value) => value + 1);
  };
  const shownAccountNotice = accountNotice && (accountNotice.cantSwitch
    ? accountNotice.key === request.requestId
    : accountNotice.key === accountCardKey) ? accountNotice : null;
  // Dismiss Recovery, Choose Another Account… and a primary do not fit one phone row; there the first
  // two overflow into ⋯ (§3.1) rather than wrap the footer and squeeze the body under the dock's cap.
  // The layout comes from the phone query, so only one set of these controls exists at a time.
  const isPhone = useIsMobile();
  const phoneOverflow = signIn && tertiary !== null && canChooseAccount && isPhone;
  const cardRef = useRef<HTMLElement | null>(null);
  const chooseRef = useRef<HTMLButtonElement | null>(null);
  // Only this card's own menu counts as its focus: another card's menu is that card's to hand back.
  const removedFocus = useRemovedFocus(cardRef, `[id="${menu.menuId}"]`);
  const wasPhoneOverflow = useRef(phoneOverflow);
  useLayoutEffect(() => {
    if (wasPhoneOverflow.current === phoneOverflow) return;
    wasPhoneOverflow.current = phoneOverflow;
    // Crossing 760px swaps Dismiss Recovery and Choose Another Account… for the ⋯ that holds them, or
    // back. The ⋯'s menu goes with its trigger, and focus held by a swapped control (or the open menu)
    // moves to the control that now offers the same choices, rather than to nowhere.
    if (!phoneOverflow && menuOptions.length === 0) setMenuOpen(false);
    if (!removedFocus()) return;
    // The counterpart may be disabled while a decision is sent; the card's heading always takes focus.
    const counterpart = phoneOverflow ? menu.triggerRef.current : chooseRef.current;
    const target = counterpart && !counterpart.disabled
      ? counterpart
      : cardRef.current?.querySelector<HTMLElement>(".request-card-title");
    target?.focus({ preventScroll: true });
  });
  // The sign-in method chosen among several; the first until the person picks another.
  const [chosenMethod, setChosenMethod] = useState<string | null>(null);
  const method = methods.find((option) => option.optionId === chosenMethod) ?? methods[0] ?? null;
  const keyHint = (option: PermissionOption): string | null => {
    if (!showKeyHints) return null;
    if (requestOptionForIntent(request.options, "approve") === option) return "A";
    if (requestOptionForIntent(request.options, "deny") === option) return "D";
    return null;
  };
  const optionButton = (option: PermissionOption, variant: "primary" | "secondary" | "tertiary") => {
    const hint = keyHint(option);
    return (
      <BusyButton
        key={option.optionId}
        className={variant === "primary" ? "btn primary" : variant === "tertiary" ? "btn ghost request-card-tertiary" : "btn"}
        busy={busy === option.optionId}
        progress={REQUEST_CARD_COPY.sending}
        disabled={(busy !== null && busy !== option.optionId) || unavailable(option)}
        aria-describedby={describedBy(option)}
        data-session-request-control={`option:${option.optionId}`}
        onClick={() => void decide(option)}
      >
        {/* An agent's own sign-in choices are its words, not Wollipog's: Title Case them as labels. */}
        {methods.length > 0 ? titleCaseLabel(option.name) : option.name}
        {hint && <kbd aria-hidden="true">{hint}</kbd>}
      </BusyButton>
    );
  };

  const time = createdAt ?? workflowDecision?.createdAt;
  const input = !workflowDecision ? request.context?.input : undefined;
  // A workflow decision's full request stays readable behind a disclosure, as it was before the card,
  // except where its body already shows all of it: an issue closure, and UI evidence, whose input
  // carries signed links the review must not expose.
  const decisionCategory = workflowDecision?.resourceSnapshot.category;
  const decisionDetails = workflowDecision && decisionCategory !== "issue_closure" &&
    decisionCategory !== "campaign_issue_scope" && decisionCategory !== "ui_evidence_approval" ? request.context?.input : undefined;
  const facts = [
    { label: "Tool", value: request.context?.toolName },
    { label: "Path", value: request.context?.path },
    { label: "Network", value: request.context?.network },
    { label: "Branch", value: request.context?.branch },
  ].filter((fact): fact is { label: string; value: string } => typeof fact.value === "string" && fact.value.length > 0);
  const policyLine = requestPolicyLine(
    request.governancePolicyId ? policyName ?? request.governancePolicyId : null,
    remaining,
  );
  const readOnly = readOnlyNotice !== undefined;
  const body: ReactNode[] = readOnly ? [
    // Facts only: what is being decided, never a control that would act on it.
    workflowDecision ? <WorkflowDecisionSummary key="decision" snapshot={workflowDecision.resourceSnapshot} /> : null,
    request.kind === "question" && request.questions?.length ? (
      <ol key="questions" className="request-card-questions">
        {request.questions.map((question) => (
          <li key={question.id}><StructuredQuestionText>{question.question}</StructuredQuestionText></li>
        ))}
      </ol>
    ) : null,
    input ? <div key="input" className="code-well"><pre>{input}</pre></div> : null,
    facts.length > 0 ? (
      <dl key="facts" className="facts">
        {facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
      </dl>
    ) : null,
  ].filter(Boolean) : [
    // What Choose Another Account ended with heads the body, inside the part that scrolls, so the
    // facts under it keep their room rather than the card's frame taking it from the body (#2208).
    shownAccountNotice ? (
      <Notice
        key="account-notice"
        tone="danger"
        compact
        role="alert"
        noticeRef={revealAccountNotice}
        {...(shownAccountNotice.cantSwitch ? { icon: <BanIcon /> } : {})}
      >
        {shownAccountNotice.text}
      </Notice>
    ) : null,
    signIn && providerLogin && !recovery
      ? <ProviderLoginCard key="login" runnerId={session.runnerId} login={providerLogin} embedded /> : null,
    recovery ? (
      <AuthenticationRecoveryPanel
        key="recovery"
        session={session}
        approval={request}
        runner={runner}
        runnerOnline={runnerOnline}
        recheck={recheck ? {
          run: () => decide(recheck),
          busy: busy === recheck.optionId,
          disabled: (busy !== null && busy !== recheck.optionId) || unavailable(recheck),
          describedBy: describedBy(recheck),
        } : undefined}
        refreshKey={identityRefresh}
      />
    ) : null,
    methods.length > 0 ? (
      <ChoiceRows
        key="methods"
        label={SIGN_IN_COPY.signInMethods}
        value={method?.optionId ?? null}
        onChange={setChosenMethod}
        options={methods.map((option) => ({
          value: option.optionId,
          title: titleCaseLabel(option.name),
          description: option.description ? <>{option.description}</> : undefined,
        }))}
        className="sign-in-methods"
      />
    ) : null,
    evidence ? <EvidenceReviewBody key="evidence" review={evidence} /> : null,
    workflowDecision && !evidence ? <WorkflowDecisionSummary key="decision" snapshot={workflowDecision.resourceSnapshot} /> : null,
    decisionDetails ? (
      <details key="details" className="disclosure">
        <summary><ChevronRightIcon className="disclosure-chevron" />{REQUEST_CARD_COPY.requestDetails}</summary>
        <div className="disclosure-body">
          <div className="code-well">
            <pre>{decisionDetails}</pre>
            <CopyButton text={decisionDetails} iconOnly ariaLabel={REQUEST_CARD_COPY.copyDetails} className="icon-btn sm" />
          </div>
        </div>
      </details>
    ) : null,
    // A sign-in's request details are the runner's guidance: where to sign in and with which command.
    input && recovery ? (
      <details key="input" className="disclosure">
        <summary><ChevronRightIcon className="disclosure-chevron" />{REQUEST_CARD_COPY.requestDetails}</summary>
        <div className="disclosure-body">
          <div className="code-well">
            <pre>{input}</pre>
            <CopyButton text={input} iconOnly ariaLabel={REQUEST_CARD_COPY.copyDetails} className="icon-btn sm"
              tooltip={false} />
          </div>
        </div>
      </details>
    ) : input ? (
      <div key="input" className="code-well">
        <pre>{input}</pre>
        <CopyButton text={input} iconOnly ariaLabel={REQUEST_CARD_COPY.copyDetails} className="icon-btn sm"
          tooltip={!signIn} />
      </div>
    ) : null,
    facts.length > 0 && !signIn ? (
      <dl key="facts" className="facts" aria-label={REQUEST_CARD_COPY.policyMatch}>
        {facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
      </dl>
    ) : null,
  ].filter(Boolean);

  return (
    <section
      ref={cardRef}
      className="request-card"
      data-presentation={presentation}
      data-request-kind={meta.kind}
      data-decision-expanded={reading ? "" : undefined}
      data-read-only={readOnly ? "" : undefined}
      aria-labelledby={titleId}
      aria-busy={busy !== null || undefined}
      // A press while a field (the sign-in's code, or the composer) has focus keeps it there until the
      // click lands, so the dock does not regrow under the finger on a touch phone (#2675).
      onMouseDown={holdFieldFocus}
    >
      <RequestCardHead
        kind={<><RequestKindIcon request={request} />{meta.label}</>}
        owner={owner}
        time={time}
        trailing={canExpandDecision ? <>
          <button
            type="button"
            className="btn sm ghost decision-reading-toggle"
            aria-label={reading ? REQUEST_CARD_COPY.collapseDecision : REQUEST_CARD_COPY.expandDecision}
            aria-expanded={reading}
            aria-controls={`${titleId} ${bodyId}`}
            onClick={() => setReadingKey(reading ? null : flightKey)}
          >
            {reading ? <ChevronDownIcon size={14} /> : <ChevronUpIcon size={14} />}
            <span className="decision-reading-toggle-label">
              {reading ? REQUEST_CARD_COPY.collapseDecision : REQUEST_CARD_COPY.expandDecision}
            </span>
          </button>
          {headTrailing}
        </> : headTrailing}
      />
      <h3 className="request-card-title" id={titleId} ref={headingRef} tabIndex={-1} data-session-request-focus="">
        {evidence && !readOnly ? evidence.title : request.title}
      </h3>
      {readOnly && <Notice tone="neutral" compact>{readOnlyNotice}</Notice>}
      {policyLine && <p className="request-card-policy">{policyLine}</p>}
      {body.length > 0 && <div className="request-card-body" id={bodyId} ref={bodyRef}>{body}</div>}
      {error && !readOnly && (
        <Notice tone="danger" compact role="alert">
          {REQUEST_CARD_COPY.notSent} {error}
        </Notice>
      )}
      {!readOnly && (reason !== null || signInBlocked || evidence?.footNote) && (
        <div className="request-card-reasons">
          {reason !== null && <p id={reasonId}>{reason}</p>}
          {signInBlocked && <p id={signInReasonId}>{REQUEST_CARD_COPY.signInOwner}</p>}
          {/* Why Approve is off while UI evidence is under review (#2197); Deny never waits on it. */}
          {evidence?.footNote && <p id={evidenceReasonId}>{evidence.footNote}</p>}
        </div>
      )}
      {!readOnly && <div className="request-card-foot">
        {tertiary && !phoneOverflow && optionButton(tertiary, "tertiary")}
        {footerSecondary.map((option) => optionButton(option, "secondary"))}
        {canChooseAccount && !phoneOverflow && (
          <button
            type="button"
            ref={chooseRef}
            className="btn"
            aria-haspopup="dialog"
            disabled={busy !== null || reason !== null}
            aria-describedby={reason !== null ? reasonId : undefined}
            onClick={chooseAccount}
          >
            {SIGN_IN_COPY.chooseAnotherAccount}
          </button>
        )}
        {(menuOptions.length > 0 || phoneOverflow) && (
          <>
            <button
              ref={menu.triggerRef}
              type="button"
              className="icon-btn"
              aria-label={REQUEST_CARD_COPY.moreChoices}
              title={signIn ? undefined : REQUEST_CARD_COPY.moreChoices}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? menu.menuId : undefined}
              // Unavailable while a decision is sent, but still focusable: it is where focus waits
              // after a choice from its menu, until the next request or the composer takes it.
              aria-disabled={busy !== null || undefined}
              onClick={busy !== null ? undefined : menu.toggle}
              onKeyDown={menu.onTriggerKeyDown}
            >
              <MoreHorizontalIcon />
            </button>
            {menuOpen && (
              <MenuSurface
                surfaceRef={menu.menuRef}
                anchor={{ trigger: menu.triggerRef }}
                id={menu.menuId}
                label={REQUEST_CARD_COPY.moreChoices}
                align="end"
                onDismiss={() => menu.close(true)}
                onKeyDown={menu.onMenuKeyDown}
                // Its presentation, so the dock owns focus in its own cards' menus and not in a
                // Requests panel card's beside it.
                data-request-card-menu={presentation}
              >
                {menuOptions.map((option) => (
                  <MenuItem
                    key={option.optionId}
                    description={option.description}
                    aria-disabled={unavailable(option) || undefined}
                    aria-describedby={describedBy(option)}
                    data-session-request-control={`option:${option.optionId}`}
                    onClick={() => {
                      if (unavailable(option)) return;
                      menu.close(true);
                      void decide(option);
                    }}
                  >
                    {option.name}
                  </MenuItem>
                ))}
                {phoneOverflow && (
                  <MenuItem
                    aria-disabled={busy !== null || reason !== null || undefined}
                    aria-describedby={reason !== null ? reasonId : undefined}
                    onClick={() => {
                      // As the footer's button: not while a decision is sent, nor when nobody can act.
                      if (busy !== null || reason !== null) return;
                      menu.close(true);
                      chooseAccount();
                    }}
                  >
                    {SIGN_IN_COPY.chooseAnotherAccount}
                  </MenuItem>
                )}
                {phoneOverflow && tertiary && (
                  <MenuItem
                    description={tertiary.description}
                    aria-disabled={unavailable(tertiary) || undefined}
                    aria-describedby={describedBy(tertiary)}
                    data-session-request-control={`option:${tertiary.optionId}`}
                    onClick={() => {
                      if (unavailable(tertiary)) return;
                      menu.close(true);
                      void decide(tertiary);
                    }}
                  >
                    {tertiary.name}
                  </MenuItem>
                )}
              </MenuSurface>
            )}
          </>
        )}
        {primary && optionButton(primary, "primary")}
        {method && (
          <BusyButton
            className="btn primary"
            busy={methods.some((option) => busy === option.optionId)}
            progress={REQUEST_CARD_COPY.sending}
            disabled={(busy !== null && !methods.some((option) => busy === option.optionId)) || unavailable(method)}
            aria-describedby={describedBy(method)}
            data-session-request-control="option:sign-in-method"
            onClick={() => void decide(method)}
          >
            {SIGN_IN_COPY.startSignIn}
          </BusyButton>
        )}
      </div>}
      {!readOnly && canChooseAccount && choosingAccount === accountCardKey && (
        <ChooseAccountDialog
          session={session}
          approval={request}
          runner={runner}
          runnerOnline={runnerOnline}
          provider={signInProviderName(session.driver)}
          machineName={runnerDisplay(runner, box, session.runnerId).name}
          onDone={chosenAccount}
          {...(navigate ? { onOpenConnections: () => navigate({ name: "runners", section: "machines" }) } : {})}
          // On a phone the opener was an item of the ⋯ menu, which closed as the dialog opened.
          returnFocusRef={phoneOverflow ? menu.triggerRef : chooseRef}
        />
      )}
    </section>
  );
}

/** A notice that heads the body starts in view in whatever scrolls it: the dock's card body, or the
 * Requests panel's detail, where the body itself does not scroll (#2206). */
function revealAccountNotice(node: HTMLElement | null): void {
  node?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

/** The card's head line: the kind's icon and label, then who asks and when, then trailing controls.
 * Shared with the question card (#2196), which builds its own body and footer. */
export function RequestCardHead({ kind, owner, time, trailing }: {
  kind: ReactNode;
  owner?: string;
  time?: number;
  trailing?: ReactNode;
}) {
  return (
    <div className="request-card-head">
      <span className="request-card-kind">{kind}</span>
      {(owner || time) && (
        <span className="request-card-meta">
          {owner && <span>{owner}</span>}
          {time ? <span><RelativeTime at={time} /></span> : null}
        </span>
      )}
      {trailing && <span className="request-card-trailing">{trailing}</span>}
    </div>
  );
}


/** Ticks once a second until `expiresAt`, as the milliseconds left; null without a deadline. */
function useCountdown(expiresAt: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  return expiresAt === undefined ? null : Math.max(0, expiresAt - now);
}

/** How long one read of the policy list names asks; a later card reads it again, so a policy added
 * or renamed since is named as it is now. */
export const POLICY_NAMES_FRESH_MS = 60_000;

/** The policy list per API client, shared by the cards that read it within the freshness window. */
const policyLists = new WeakMap<ApiClient, { readAt: number; policies: Promise<GovernancePolicy[]> }>();

function readPolicies(api: ApiClient, policyId: string): Promise<GovernancePolicy[]> {
  const cached = policyLists.get(api);
  const fresh = cached && Date.now() - cached.readAt < POLICY_NAMES_FRESH_MS ? cached : null;
  const read = () => {
    const entry = {
      readAt: Date.now(),
      policies: Promise.resolve()
        .then(() => api.governancePolicies())
        .then((result) => result.policies)
        .catch(() => {
          if (policyLists.get(api) === entry) policyLists.delete(api);
          return [] as GovernancePolicy[];
        }),
    };
    policyLists.set(api, entry);
    return entry.policies;
  };
  if (!fresh) return read();
  // A policy the fresh list does not know was added since it was read.
  return fresh.policies.then((policies) =>
    policies.some((policy) => policy.policyId === policyId) || policyLists.get(api) !== fresh ? policies : read());
}

function useGovernancePolicyName(api: ApiClient, policyId: string | undefined): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    setName(null);
    if (!policyId) return;
    let live = true;
    void readPolicies(api, policyId).then((policies) => {
      const policy = policies.find((candidate) => candidate.policyId === policyId);
      if (live && policy) setName(policy.name);
    });
    return () => { live = false; };
  }, [api, policyId]);
  return name;
}
