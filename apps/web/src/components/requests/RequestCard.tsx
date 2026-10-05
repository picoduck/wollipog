import React, {
  useEffect,
  useId,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type Ref,
} from "react";
import type { GovernancePolicy, PendingApproval, PermissionOption, SessionView } from "@wollipog/protocol";
import { useApi } from "../../api-context.js";
import type { ApiClient } from "../../api.js";
import { relativeTime } from "../../format.js";
import { useOptionalStoreSelector } from "../../store.js";
import { sessionCommandRefusal } from "../../session-command-permissions.js";
import { useAccessibleMenu } from "../interactions.js";
import { MenuItem, MenuSurface } from "../Menu.js";
import { MoreHorizontalIcon } from "../Icons.js";
import { Notice } from "../Notice.js";
import { BusyButton } from "../ui/BusyButton.js";
import { CopyButton } from "../common.js";
import { ProviderLoginCard } from "../ProviderLoginCard.js";
import { AuthenticationRecoveryPanel, authenticationRecoveryPanelApplies } from "../AuthenticationRecoveryPanel.js";
import { EvidenceReviewBody, useEvidenceReview } from "./EvidenceReview.js";
import { WorkflowDecisionSummary } from "./WorkflowDecisionSummary.js";
import { claimDecision, decisionKey, useDecisionInFlight } from "./request-reveal.js";
import {
  REQUEST_CARD_COPY,
  RequestKindIcon,
  requestCardActions,
  requestKindMeta,
  requestOptionForIntent,
  requestPolicyLine,
} from "./request-meta.js";

/** A one-key decision on the card: true when the card took the key, whether or not it could act. */
export type RequestIntentHandler = (intent: "approve" | "deny") => boolean;

export interface RequestCardProps {
  /** The session the request belongs to: its id, runner and the reader's permissions on it. */
  session: SessionView;
  request: PendingApproval;
  runnerOnline: boolean;
  /** The dock above the composer, or a side panel's detail (child and worker requests). */
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
  const busy = useDecisionInFlight(flightKey);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useAccessibleMenu(menuOpen, setMenuOpen, "request-options", "item", { reachUnavailable: true });
  const idPrefix = useId().replace(/:/g, "");
  const titleId = `${idPrefix}-title`;
  const reasonId = `${idPrefix}-reason`;
  const signInReasonId = `${idPrefix}-sign-in-reason`;
  const evidenceReasonId = `${idPrefix}-evidence-reason`;
  const policyName = useGovernancePolicyName(api, request.governancePolicyId);
  const remaining = useCountdown(request.expiresAt);

  useEffect(() => {
    setError(null);
  }, [request.requestId, request.occurrenceId]);

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
    setError(null);
    try {
      const updated = await api.approve(session.id, {
        requestId: request.requestId,
        optionId: option.optionId,
        ...(evidence && option.optionId === "approve" ? evidence.approval() : {}),
      });
      evidence?.clearDraft();
      onSessionUpdate?.(updated);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      release();
    }
  };

  const decideRef = useRef(decide);
  decideRef.current = decide;
  useEffect(() => {
    if (!intentRef) return;
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
  }, [intentRef, request.options]);

  const { secondary, menu: menuOptions, primary } = requestCardActions(request.options);
  const keyHint = (option: PermissionOption): string | null => {
    if (!showKeyHints) return null;
    if (requestOptionForIntent(request.options, "approve") === option) return "A";
    if (requestOptionForIntent(request.options, "deny") === option) return "D";
    return null;
  };
  const optionButton = (option: PermissionOption, primaryButton: boolean) => {
    const hint = keyHint(option);
    return (
      <BusyButton
        key={option.optionId}
        className={primaryButton ? "btn primary" : "btn"}
        busy={busy === option.optionId}
        progress={REQUEST_CARD_COPY.sending}
        disabled={(busy !== null && busy !== option.optionId) || unavailable(option)}
        aria-describedby={describedBy(option)}
        data-session-request-control={`option:${option.optionId}`}
        onClick={() => void decide(option)}
      >
        {option.name}
        {hint && <kbd aria-hidden="true">{hint}</kbd>}
      </BusyButton>
    );
  };

  const time = createdAt ?? workflowDecision?.createdAt;
  const input = !workflowDecision ? request.context?.input : undefined;
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
  const body: ReactNode[] = [
    request.kind === "authentication" && providerLogin
      ? <ProviderLoginCard key="login" runnerId={session.runnerId} login={providerLogin} /> : null,
    authenticationRecoveryPanelApplies(session, request)
      ? <AuthenticationRecoveryPanel key="recovery" session={session} approval={request} runner={runner}
        runnerOnline={runnerOnline} /> : null,
    evidence ? <EvidenceReviewBody key="evidence" review={evidence} reasonId={evidenceReasonId} /> : null,
    workflowDecision && !evidence ? <WorkflowDecisionSummary key="decision" snapshot={workflowDecision.resourceSnapshot} /> : null,
    input ? (
      <div key="input" className="code-well">
        <pre>{input}</pre>
        <CopyButton text={input} iconOnly ariaLabel={REQUEST_CARD_COPY.copyDetails} className="icon-btn sm" />
      </div>
    ) : null,
    facts.length > 0 ? (
      <dl key="facts" className="facts" aria-label={REQUEST_CARD_COPY.policyMatch}>
        {facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
      </dl>
    ) : null,
  ].filter(Boolean);

  return (
    <section
      className="request-card"
      data-presentation={presentation}
      data-request-kind={meta.kind}
      aria-labelledby={titleId}
      aria-busy={busy !== null || undefined}
    >
      <div className="request-card-head">
        <span className="request-card-kind"><RequestKindIcon request={request} />{meta.label}</span>
        {(owner || time) && (
          <span className="request-card-meta">
            {owner && <span>{owner}</span>}
            {time ? <span>{relativeTime(time)}</span> : null}
          </span>
        )}
        {headTrailing && <span className="request-card-trailing">{headTrailing}</span>}
      </div>
      <h3 className="request-card-title" id={titleId} ref={headingRef} tabIndex={-1} data-session-request-focus="">
        {request.title}
      </h3>
      {policyLine && <p className="request-card-policy">{policyLine}</p>}
      {body.length > 0 && <div className="request-card-body">{body}</div>}
      {error && (
        <Notice tone="danger" compact role="alert">
          {REQUEST_CARD_COPY.notSent} {error}
        </Notice>
      )}
      {(reason !== null || signInBlocked) && (
        <div className="request-card-reasons">
          {reason !== null && <p id={reasonId}>{reason}</p>}
          {signInBlocked && <p id={signInReasonId}>{REQUEST_CARD_COPY.signInOwner}</p>}
        </div>
      )}
      <div className="request-card-foot">
        {secondary.map((option) => optionButton(option, false))}
        {menuOptions.length > 0 && (
          <>
            <button
              ref={menu.triggerRef}
              type="button"
              className="icon-btn"
              aria-label={REQUEST_CARD_COPY.moreChoices}
              title={REQUEST_CARD_COPY.moreChoices}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? menu.menuId : undefined}
              disabled={busy !== null}
              onClick={menu.toggle}
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
                      menu.close(false);
                      void decide(option);
                    }}
                  >
                    {option.name}
                  </MenuItem>
                ))}
              </MenuSurface>
            )}
          </>
        )}
        {primary && optionButton(primary, true)}
      </div>
    </section>
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

/** One policy list per API client for the life of the page: a policy ask names its policy. */
const policyLists = new WeakMap<ApiClient, Promise<GovernancePolicy[]>>();

function useGovernancePolicyName(api: ApiClient, policyId: string | undefined): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    setName(null);
    if (!policyId) return;
    let live = true;
    let list = policyLists.get(api);
    if (!list) {
      list = Promise.resolve()
        .then(() => api.governancePolicies())
        .then((result) => result.policies)
        .catch(() => {
          policyLists.delete(api);
          return [];
        });
      policyLists.set(api, list);
    }
    void list.then((policies) => {
      const policy = policies.find((candidate) => candidate.policyId === policyId);
      if (live && policy) setName(policy.name);
    });
    return () => { live = false; };
  }, [api, policyId]);
  return name;
}
