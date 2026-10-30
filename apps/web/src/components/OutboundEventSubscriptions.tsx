import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type {
  AutomationSchedule,
  CreateOutboundEventSubscriptionRequest,
  OutboundEventDeliveryView,
  OutboundEventSubscriptionCredential,
  OutboundEventSubscriptionView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { writeClipboardText } from "../clipboard.js";
import {
  alsoIncludesLabel,
  callbackParts,
  deliveryResult,
  eventCountLabel,
  lastDeliveryLabel,
  nextRetryLabel,
  orderedEventKinds,
  outboundEventLabel,
  subscriptionStatus,
} from "../outbound-events.js";
import { statusMeta } from "../status-meta.js";
import { useStoreSelector } from "../store.js";
import { useTimelineClock } from "../timeline-clock.js";
import { startVisiblePolling } from "../visible-polling.js";
import { useFeedback, type ConfirmationOptions } from "./FeedbackProvider.js";
import { ChevronRightIcon, ShareIcon } from "./Icons.js";
import { NewOutboundSubscriptionDialog } from "./NewOutboundSubscriptionDialog.js";
import { Notice } from "./Notice.js";
import { OneLineCodeWell } from "./OneLineCodeWell.js";
import { ActionsMenu, type ActionsMenuChoice, type PageMenuAction } from "./PageHeader.js";
import { StaleContent } from "./StaleContent.js";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";

const BACK_TO_MORE_ACTIONS = "Back to More Actions";

/** The tab's one help line (#2973). */
export const OUTBOUND_EVENTS_HELP =
  "Send signed session, pull request and cost events to your own HTTPS address. Prompts, transcripts and answers are never sent.";

/** A failed action, shown above the rows until the next one starts. */
interface ActionFailure {
  title: string;
  message: string;
}

/** What a subscription sends events for, by name; the name is unknown while the lists don't hold it. */
interface SubscriptionScope {
  kind: "Project" | "Automation";
  name: string | undefined;
}

const failureMessage = (cause: unknown) => cause instanceof Error && cause.message ? cause.message : String(cause);

function SubscriptionsSkeleton() {
  return (
    <div className="surface" role="status">
      <span className="sr-only">Loading outbound events…</span>
      {Array.from({ length: 3 }, (_, index) => (
        <div className="row row-2" aria-hidden="true" key={index}>
          <span className="row-body">
            <span className="skeleton-bar title" />
            <span className="skeleton-bar" />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The Deliveries table (§14): what each event's delivery came to, in words. On a phone, and in any
 * container under 560px, each delivery is two lines: the event and its result, then its attempts
 * and next retry.
 */
function DeliveriesTable({ deliveries, now, labelledBy }: {
  deliveries: readonly OutboundEventDeliveryView[];
  now: number;
  labelledBy: string;
}) {
  return (
    <div className="table-wrap">
      <table className="table outbound-deliveries" aria-labelledby={labelledBy}>
        <thead>
          <tr>
            <th scope="col">Event</th>
            <th scope="col" className="col-result">Result</th>
            <th scope="col" className="col-attempts num">Attempts</th>
            <th scope="col" className="col-retry">Next Retry</th>
          </tr>
        </thead>
        <tbody>
          {deliveries.map((delivery) => {
            const retry = nextRetryLabel(delivery, now);
            return (
              <tr key={delivery.deliveryId}>
                <th scope="row">{outboundEventLabel(delivery.kind)}</th>
                <td className="cell-status"><StatusBadge inline meta={deliveryResult(delivery)} /></td>
                <td className="cell-meta num"><span className="cell-label">Attempts: </span>{delivery.attemptCount}</td>
                <td className="cell-meta">
                  {retry && <><span className="cell-label">Next Retry: </span>{retry}</>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One subscription (§5.2, §5.5): a two-line expandable row. Line 1 is the callback's host and path
 * with the one badge, line 2 the scope, the event count and the last delivery (on a phone the last
 * delivery alone); ⋯ trails it. Opened, it lists the events (and on a phone the scope), what else is
 * sent, the pause and its Resume, and the Deliveries table.
 */
function SubscriptionRow({ subscription, deliveries, scope, now, open, resuming, onToggle, onResume, menu }: {
  subscription: OutboundEventSubscriptionView;
  deliveries: readonly OutboundEventDeliveryView[];
  scope: SubscriptionScope;
  now: number;
  open: boolean;
  resuming: boolean;
  onToggle: () => void;
  onResume: () => void;
  menu: PageMenuAction[];
}) {
  const ids = useId();
  const bodyId = `${ids}-body`;
  const deliveriesId = `${ids}-deliveries`;
  const { host, hostAndPath } = callbackParts(subscription.callbackUrl);
  const extras = alsoIncludesLabel(subscription);
  return (
    <div className="outbound-subscription" data-subscription-id={subscription.subscriptionId}>
      <div className="row row-2 outbound-subscription-row">
        <button type="button" className="disclosure-trigger outbound-subscription-open"
          aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={onToggle}>
          <ChevronRightIcon className="disclosure-chevron" aria-hidden="true" />
          <span className="row-body">
            <span className="row-line">
              <span className="row-title outbound-subscription-address" title={hostAndPath}>{hostAndPath}</span>
              <StatusBadge meta={statusMeta("subscription", subscriptionStatus(subscription, deliveries))} />
            </span>
            <span className="row-sub outbound-subscription-meta">
              <span>{scope.name ? `${scope.kind}: ${scope.name}` : scope.kind}</span>
              <span>{eventCountLabel(subscription.eventKinds.length)}</span>
              <span>{lastDeliveryLabel(subscription, deliveries, now)}</span>
            </span>
          </span>
        </button>
        <ActionsMenu size="sm" label={`${host} Actions`} items={menu} />
      </div>
      {open && (
        <div className="disclosure-body outbound-subscription-body" id={bodyId}>
          <dl className="facts">
            {scope.name && (
              <div className="outbound-subscription-scope">
                <dt>{scope.kind}</dt>
                <dd>{scope.name}</dd>
              </div>
            )}
            <div>
              <dt>Events</dt>
              <dd>
                <ul className="outbound-subscription-events-list">
                  {orderedEventKinds(subscription.eventKinds).map((kind) => <li key={kind}>{outboundEventLabel(kind)}</li>)}
                </ul>
              </dd>
            </div>
            {extras && (
              <div>
                <dt>Also Includes</dt>
                <dd>{extras}</dd>
              </div>
            )}
          </dl>
          {subscription.state === "paused" && (
            <Notice tone="warning" compact title="Deliveries Paused"
              actions={(
                <button type="button" className="btn sm" disabled={resuming} onClick={onResume}>Resume</button>
              )}>
              {subscription.pauseReason ?? "Nothing is sent until you resume this subscription."}
            </Notice>
          )}
          <section className="outbound-subscription-deliveries" aria-labelledby={deliveriesId}>
            <h3 className="section-title" id={deliveriesId}>Deliveries</h3>
            {deliveries.length === 0
              ? <p className="section-note">No events have been sent yet.</p>
              : <DeliveriesTable deliveries={deliveries} now={now} labelledBy={deliveriesId} />}
          </section>
        </div>
      )}
    </div>
  );
}

/**
 * The Outbound Events tab of Automations (#2973, docs/design-system.md §4.2, §5.2, §5.5, §7, §12):
 * one help line, the signing secret once after a create or rotate, and one surface of subscription
 * rows. The page header's primary, New Subscription, opens the dialog; the parent hides it while the
 * tab is empty, where the empty state offers it instead.
 */
export function OutboundEventSubscriptions({
  projects,
  automations,
  creating: creatingProp,
  onCreatingChange,
  onEmptyChange,
}: {
  projects: Array<{ id: string; name: string }>;
  automations: AutomationSchedule[];
  /** Whether New Subscription is open; the page header's primary opens it. Uncontrolled without it. */
  creating?: boolean;
  onCreatingChange?: (open: boolean) => void;
  /** Whether the tab shows its empty state, so the page header can hide its primary (§12.1). */
  onEmptyChange?: (empty: boolean) => void;
}) {
  const api = useApi();
  const { confirm, showToast } = useFeedback();
  const conn = useStoreSelector((state) => state.conn);
  const snapshotLoaded = useStoreSelector((state) => state.snapshotLoaded);
  const [subscriptions, setSubscriptions] = useState<OutboundEventSubscriptionView[]>([]);
  const [deliveries, setDeliveries] = useState<Record<string, OutboundEventDeliveryView[]>>({});
  const [credential, setCredential] = useState<OutboundEventSubscriptionCredential | null>(null);
  /** The list has been read once; before that an empty list proves nothing (§12). */
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionFailure, setActionFailure] = useState<ActionFailure | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [resuming, setResuming] = useState<ReadonlySet<string>>(() => new Set());
  const [creatingLocal, setCreatingLocal] = useState(false);
  const creating = creatingProp ?? creatingLocal;
  const setCreating = onCreatingChange ?? setCreatingLocal;
  const now = useTimelineClock(subscriptions.length > 0);
  // Set in the effect body, so StrictMode's simulated unmount and remount leave it true; a request
  // that settles after the tab has gone changes and reports nothing.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refreshInFlight = useRef<Promise<boolean> | null>(null);
  /** Reads the list and every subscription's deliveries; false when a hidden tab skipped the read. */
  const refresh = useCallback(async (onlyWhileVisible = false): Promise<boolean> => {
    while (refreshInFlight.current) {
      await refreshInFlight.current.catch(() => false);
    }
    if (onlyWhileVisible && document.visibilityState === "hidden") return false;
    const work = (async () => {
      const next = await api.outboundEventSubscriptions();
      const results = await Promise.allSettled(next.map(async (subscription) => [
        subscription.subscriptionId,
        await api.outboundEventDeliveries(subscription.subscriptionId),
      ] as const));
      const receiptEntries = results.map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      if (!mounted.current) return true;
      setSubscriptions(next);
      setDeliveries(Object.fromEntries(receiptEntries));
      return true;
    })();
    refreshInFlight.current = work;
    try {
      return await work;
    } finally {
      refreshInFlight.current = null;
    }
  }, [api]);

  const load = useCallback(async (onlyWhileVisible: boolean) => {
    try {
      const read = await refresh(onlyWhileVisible);
      if (!read || !mounted.current) return;
      setLoadError(null);
      setLoaded(true);
    } catch (cause) {
      if (mounted.current) setLoadError(failureMessage(cause));
    }
  }, [refresh]);

  useEffect(() => {
    let initialRefresh = true;
    const poll = () => {
      if (refreshInFlight.current && !initialRefresh) return;
      initialRefresh = false;
      void load(true);
    };
    return startVisiblePolling(poll, 5_000);
  }, [load]);

  // §12, in order: offline, loading, error, empty, content. Before the first snapshot a connection
  // that is still connecting is the first load, not a lost one.
  const reconnecting = conn === "offline" || (snapshotLoaded && conn !== "online");
  const empty = !reconnecting && loaded && !loadError && subscriptions.length === 0;
  useEffect(() => { onEmptyChange?.(empty); }, [empty, onEmptyChange]);

  // A scope the lists don't hold (yet) reads as its kind, never its id.
  const scopeOf = ({ scope }: OutboundEventSubscriptionView): SubscriptionScope => scope.kind === "project"
    ? { kind: "Project", name: projects.find((project) => project.id === scope.projectId)?.name }
    : { kind: "Automation", name: automations.find((automation) => automation.automationId === scope.automationId)?.name };

  const create = async (request: CreateOutboundEventSubscriptionRequest) => {
    const created = await api.createOutboundEventSubscription(request);
    if (!mounted.current) return;
    setCredential(created);
    setActionFailure(null);
    setCreating(false);
    setExpanded((prior) => new Set(prior).add(created.subscription.subscriptionId));
    void load(false);
  };

  const resume = async (subscription: OutboundEventSubscriptionView) => {
    const id = subscription.subscriptionId;
    if (resuming.has(id)) return;
    setResuming((prior) => new Set(prior).add(id));
    setActionFailure(null);
    try {
      await api.resumeOutboundEventSubscription(id);
      if (mounted.current) void load(false);
    } catch (cause) {
      if (mounted.current) setActionFailure({ title: "Couldn't Resume Subscription", message: failureMessage(cause) });
    } finally {
      if (mounted.current) {
        setResuming((prior) => {
          const next = new Set(prior);
          next.delete(id);
          return next;
        });
      }
    }
  };

  const copyCallbackUrl = async (subscription: OutboundEventSubscriptionView) => {
    // ⋯ has handed focus back to its trigger. A refused write falls back to a selected field only
    // while the copy still owns the interaction: the tab is mounted and focus is still there, or nowhere.
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const unclaimed = () => document.activeElement === null || document.activeElement === document.body;
    const copied = await writeClipboardText(subscription.callbackUrl,
      () => mounted.current && (unclaimed() || document.activeElement === invoker));
    // A write that settles after the tab has gone resolves null, a late success included.
    if (copied === null) return;
    if (unclaimed()) invoker?.focus();
    if (copied) showToast("Callback URL copied.", { tone: "success", detail: subscription.callbackUrl, detailStyle: "mono" });
    else showToast("Couldn't copy the callback URL.", { tone: "error" });
  };

  // On a phone the confirmation replaces the row's ⋯ sheet, and Back brings it back (§7.5). Neither
  // Rotate nor Revoke can be withdrawn once sent, so the confirmation stays until the request settles
  // (CR-1.2): a dismissed request still running could otherwise overlap the next one, and its late
  // secret replace a newer one or come back after a revoke.
  const confirmFromMenu = (choice: ActionsMenuChoice, options: ConfirmationOptions) => void confirm({
    ...options,
    tone: "danger",
    cancelWhileRunning: false,
    back: { label: BACK_TO_MORE_ACTIONS, run: choice.reopen },
  });
  /** Subscriptions revoked here: a rotation's secret for one of them signs nothing and is never shown. */
  const revokedIds = useRef(new Set<string>());

  const rotate = (subscription: OutboundEventSubscriptionView, choice: ActionsMenuChoice) => {
    const { host } = callbackParts(subscription.callbackUrl);
    confirmFromMenu(choice, {
      title: "Rotate Secret",
      message: `The subscription to ${host} gets a new signing secret. The old one stops working and any request in flight is canceled.`,
      confirmLabel: "Rotate Secret",
      progress: "Rotating the secret…",
      onConfirm: async (signal) => {
        const rotated = await api.rotateOutboundEventSubscription(subscription.subscriptionId);
        if (signal.aborted || !mounted.current || revokedIds.current.has(subscription.subscriptionId)) return;
        setCredential(rotated);
        setActionFailure(null);
        void load(false);
      },
    });
  };

  const revoke = (subscription: OutboundEventSubscriptionView, choice: ActionsMenuChoice) => {
    const { host } = callbackParts(subscription.callbackUrl);
    const id = subscription.subscriptionId;
    confirmFromMenu(choice, {
      title: "Revoke Subscription",
      message: `Events stop going to ${host}, and pending deliveries are dropped. This can't be undone.`,
      confirmLabel: "Revoke Subscription",
      progress: "Revoking the subscription…",
      onConfirm: async () => {
        await api.deleteOutboundEventSubscription(id);
        revokedIds.current.add(id);
        if (!mounted.current) return;
        // A secret shown for this subscription signs nothing any more.
        setCredential((current) => current?.subscription.subscriptionId === id ? null : current);
        setActionFailure(null);
        void load(false);
      },
    });
  };

  const menuFor = (subscription: OutboundEventSubscriptionView): PageMenuAction[] => [
    { label: "Copy Callback URL", onClick: () => void copyCallbackUrl(subscription) },
    ...(subscription.state === "paused"
      ? [{
        label: "Resume",
        disabled: resuming.has(subscription.subscriptionId),
        onClick: () => void resume(subscription),
      }]
      : []),
    { label: "Rotate Secret…", onClick: (choice: ActionsMenuChoice) => rotate(subscription, choice) },
    { label: "Revoke Subscription…", danger: true, onClick: (choice: ActionsMenuChoice) => revoke(subscription, choice) },
  ];

  const toggle = (id: string) => setExpanded((prior) => {
    const next = new Set(prior);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // One wrapper whether or not the rows are stale, so their spacing never changes (§12.5).
  const rows = (stale: boolean) => (
    <StaleContent stale={stale} className="outbound-subscriptions-list">
      <div className="surface">
        {subscriptions.map((subscription) => (
          <SubscriptionRow
            key={subscription.subscriptionId}
            subscription={subscription}
            deliveries={deliveries[subscription.subscriptionId] ?? []}
            scope={scopeOf(subscription)}
            now={now}
            open={expanded.has(subscription.subscriptionId)}
            resuming={resuming.has(subscription.subscriptionId)}
            onToggle={() => toggle(subscription.subscriptionId)}
            onResume={() => void resume(subscription)}
            menu={menuFor(subscription)}
          />
        ))}
      </div>
    </StaleContent>
  );

  let body: ReactNode;
  if (reconnecting) {
    // The last-known rows stay, dimmed and still operable, under one line that says why (§12.5).
    body = (
      <>
        <Notice compact tone="neutral" role="status">Reconnecting…</Notice>
        {subscriptions.length > 0 && rows(true)}
      </>
    );
  } else if (!loaded && !loadError) {
    body = <SubscriptionsSkeleton />;
  } else if (empty) {
    body = (
      <State
        icon={<ShareIcon />}
        title="No Outbound Events Yet"
        headingLevel={3}
        actions={<button type="button" className="btn primary" onClick={() => setCreating(true)}>New Subscription</button>}
      >
        Send a signed request to your own service when a session finishes or a pull request merges.
      </State>
    );
  } else {
    // A failed read says so above the rows it could not refresh; with nothing read yet it is the
    // whole content (§12.4).
    body = (
      <>
        {loadError && (
          <Notice tone="danger" role="alert" title="Couldn't Load Outbound Events"
            actions={<button type="button" className="btn sm" onClick={() => void load(false)}>Retry</button>}
            details={<pre className="code-well">{loadError}</pre>}>
            Retry to load the subscriptions again.
          </Notice>
        )}
        {subscriptions.length > 0 && rows(false)}
      </>
    );
  }

  const secretHost = credential ? callbackParts(credential.subscription.callbackUrl).host : "";
  return (
    <div className="outbound-events">
      <p className="outbound-events-help">{OUTBOUND_EVENTS_HELP}</p>
      {credential && (
        <Notice tone="warning" role="status" title="Copy the Signing Secret Now"
          className="outbound-events-secret"
          actions={<button type="button" className="btn sm" onClick={() => setCredential(null)}>Done</button>}>
          <p>{`Requests to ${secretHost} are signed with it. It won't be shown again.`}</p>
          <OneLineCodeWell value={credential.secret} name="Secret" />
        </Notice>
      )}
      {actionFailure && (
        <Notice tone="danger" role="alert" title={actionFailure.title}
          details={<pre className="code-well">{actionFailure.message}</pre>}>
          Try again in a moment.
        </Notice>
      )}
      {body}
      {creating && (
        <NewOutboundSubscriptionDialog
          projects={projects}
          automations={automations.map((automation) => ({ id: automation.automationId, name: automation.name }))}
          create={create}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}
