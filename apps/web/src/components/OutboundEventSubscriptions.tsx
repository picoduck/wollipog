import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AutomationSchedule,
  OutboundEventDeliveryView,
  OutboundEventKind,
  OutboundEventSubscriptionCredential,
  OutboundEventSubscriptionView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { titleCaseLabel } from "../format.js";
import { useFeedback } from "./FeedbackProvider.js";
import { Checkbox, Select } from "./ui/ChoiceControls.js";

const EVENT_KINDS: OutboundEventKind[] = [
  "session.created", "session.input_required", "session.idle", "session.completed",
  "session.failed", "session.stopped", "pull_request.opened", "pull_request.merged",
  "checks.failed", "cost.checkpoint", "cost.budget_exhausted",
];

function eventLabel(kind: OutboundEventKind): string {
  return titleCaseLabel(kind.replaceAll(".", " ").replaceAll("_", " "));
}

function receiptTime(value: number | undefined): string {
  return value === undefined ? "—" : new Date(value).toLocaleString();
}

export function OutboundEventSubscriptions({
  projects,
  automations,
}: {
  projects: Array<{ id: string; name: string }>;
  automations: AutomationSchedule[];
}) {
  const api = useApi();
  const { confirm } = useFeedback();
  const [subscriptions, setSubscriptions] = useState<OutboundEventSubscriptionView[]>([]);
  const [deliveries, setDeliveries] = useState<Record<string, OutboundEventDeliveryView[]>>({});
  const [credential, setCredential] = useState<OutboundEventSubscriptionCredential | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scopeKind, setScopeKind] = useState<"project" | "automation">("project");
  const [scopeId, setScopeId] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [eventKinds, setEventKinds] = useState<OutboundEventKind[]>(["session.created", "session.input_required"]);
  const [includeSessionName, setIncludeSessionName] = useState(false);
  const [includeQuestionTitle, setIncludeQuestionTitle] = useState(false);

  const scopeOptions = useMemo(() => scopeKind === "project"
    ? projects.map((project) => ({ id: project.id, name: project.name }))
    : automations.map((automation) => ({ id: automation.automationId, name: automation.name })),
  [automations, projects, scopeKind]);
  const effectiveScopeId = scopeOptions.some((option) => option.id === scopeId)
    ? scopeId
    : scopeOptions[0]?.id ?? "";

  const refresh = useCallback(async () => {
    const next = await api.outboundEventSubscriptions();
    setSubscriptions(next);
    const receiptEntries = await Promise.all(next.map(async (subscription) => [
      subscription.subscriptionId,
      await api.outboundEventDeliveries(subscription.subscriptionId),
    ] as const));
    setDeliveries(Object.fromEntries(receiptEntries));
  }, [api]);

  useEffect(() => {
    let active = true;
    const load = () => refresh().catch((cause) => active && setError((cause as Error).message));
    void load();
    const timer = window.setInterval(load, 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [refresh]);

  const mutate = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!effectiveScopeId || !callbackUrl.trim() || eventKinds.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createOutboundEventSubscription({
        callbackUrl: callbackUrl.trim(),
        scope: scopeKind === "project"
          ? { kind: "project", projectId: effectiveScopeId }
          : { kind: "automation", automationId: effectiveScopeId },
        eventKinds,
        includeSessionName,
        includeQuestionTitle,
      });
      setCredential(created);
      setCallbackUrl("");
      setCreating(false);
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="outbound-events" aria-labelledby="outbound-events-heading">
      <div className="outbound-events-heading">
        <div>
          <h3 id="outbound-events-heading">Outbound Events</h3>
          <p>Send signed, content-minimized session, pull request, check, and cost events to an HTTPS callback.</p>
        </div>
        <button className="btn ghost sm" type="button" onClick={() => setCreating((value) => !value)}>
          {creating ? "Close Subscription Form" : "New Subscription"}
        </button>
      </div>
      {error && <div className="automation-error" role="alert">{error}</div>}
      {creating && <div className="outbound-event-editor" aria-label="New Outbound Event Subscription">
        <div className="automation-form-grid">
          <label>Scope Type<Select label="Scope Type" value={scopeKind} options={[
            { value: "project", label: "Project" },
            { value: "automation", label: "Automation" },
          ]} onChange={(value) => {
            setScopeKind(value);
            setScopeId("");
          }} /></label>
          <label>{scopeKind === "project" ? "Project" : "Automation"}<Select label={scopeKind === "project" ? "Project" : "Automation"}
            value={effectiveScopeId || null}
            emptyLabel={`No ${scopeKind === "project" ? "Projects" : "Automations"} Available`}
            options={scopeOptions.map((option) => ({ value: option.id, label: option.name }))}
            onChange={setScopeId} /></label>
          <label className="automation-span">Callback URL<input type="url" value={callbackUrl}
            placeholder="https://events.example.com/wollipog" maxLength={2048}
            onInput={(event) => setCallbackUrl(event.currentTarget.value)} /></label>
          <fieldset className="automation-span"><legend>Event Kinds</legend><div className="outbound-event-kinds">
            {EVENT_KINDS.map((kind) => <label key={kind}><Checkbox label={eventLabel(kind)}
              checked={eventKinds.includes(kind)} onChange={(checked) => setEventKinds((current) => checked
                ? [...current, kind]
                : current.filter((value) => value !== kind))} />{eventLabel(kind)}</label>)}
          </div></fieldset>
          <label className="automation-enable"><Checkbox label="Include Session Name" checked={includeSessionName}
            onChange={setIncludeSessionName} />Include Session Name</label>
          <label className="automation-enable"><Checkbox label="Include Question Title" checked={includeQuestionTitle}
            onChange={setIncludeQuestionTitle} />Include Question Title</label>
        </div>
        <p className="automation-hint">Session names and question titles are excluded unless selected. Prompts, transcripts, answers, and tool input are never delivered.</p>
        <div className="automation-editor-actions"><button className="btn primary sm" type="button"
          disabled={busy || !effectiveScopeId || !callbackUrl.trim() || eventKinds.length === 0}
          onClick={() => void create()}>{busy ? "Creating…" : "Create Subscription"}</button></div>
      </div>}
      {credential && <div className="automation-trigger-secret" role="status">
        <strong>Copy this signing secret now. It will not be shown again.</strong>
        <code>{credential.secret}</code>
        <button className="btn ghost sm" type="button"
          onClick={() => void navigator.clipboard.writeText(credential.secret)}>Copy Secret</button>
        <button className="btn ghost sm" type="button" onClick={() => setCredential(null)}>Hide</button>
      </div>}
      <div className="outbound-event-list">
        {subscriptions.length === 0 && <p className="automation-hint">No outbound event subscriptions yet.</p>}
        {subscriptions.map((subscription) => {
          const scope = subscription.scope;
          const scopeName = scope.kind === "project"
            ? projects.find((project) => project.id === scope.projectId)?.name ?? scope.projectId
            : automations.find((automation) => automation.automationId === scope.automationId)?.name ?? scope.automationId;
          const receipts = deliveries[subscription.subscriptionId] ?? [];
          return <article className="outbound-event-subscription" key={subscription.subscriptionId}>
            <div className="outbound-event-subscription-head"><div><strong>{scopeName}</strong>
              <span>{titleCaseLabel(subscription.scope.kind)} · Key Generation {subscription.generation}</span></div>
              <span className={`automation-state ${subscription.state === "active" ? "enabled" : "paused"}`}>
                {titleCaseLabel(subscription.state)}
              </span></div>
            <code>{subscription.callbackUrl}</code>
            <p>{subscription.eventKinds.map(eventLabel).join(" · ")}</p>
            <div className="outbound-event-badges">
              <span>{subscription.includeSessionName ? "Session Name Included" : "Session Name Excluded"}</span>
              <span>{subscription.includeQuestionTitle ? "Question Title Included" : "Question Title Excluded"}</span>
            </div>
            {subscription.pauseReason && <p className="automation-execution-error">{subscription.pauseReason}</p>}
            <div className="automation-trigger-actions">
              {subscription.state === "paused" && <button className="btn ghost sm" disabled={busy} type="button"
                onClick={() => void mutate(() => api.resumeOutboundEventSubscription(subscription.subscriptionId))}>Resume</button>}
              <button className="btn ghost sm" disabled={busy} type="button" onClick={() => void (async () => {
                if (await confirm({ title: "Rotate outbound signing secret?", message: "The previous secret stops working immediately and any in-flight request is aborted.", confirmLabel: "Rotate Secret", tone: "danger" })) {
                  await mutate(async () => setCredential(await api.rotateOutboundEventSubscription(subscription.subscriptionId)));
                }
              })()}>Rotate Secret</button>
              <button className="btn danger sm" disabled={busy} type="button" onClick={() => void (async () => {
                if (await confirm({ title: "Revoke outbound subscription?", message: "Delivery stops immediately and all pending requests are dropped.", confirmLabel: "Revoke Subscription", tone: "danger" })) {
                  await mutate(() => api.deleteOutboundEventSubscription(subscription.subscriptionId));
                  if (credential?.subscription.subscriptionId === subscription.subscriptionId) setCredential(null);
                }
              })()}>Revoke</button>
            </div>
            <details><summary>Delivery Journal ({receipts.length})</summary>
              {receipts.length === 0 ? <p className="automation-hint">No delivery attempts yet.</p> :
                <div className="outbound-event-receipts">{receipts.map((receipt) => <div key={receipt.deliveryId}>
                  <strong>{eventLabel(receipt.kind)} · {titleCaseLabel(receipt.status)}</strong>
                  <span>{receipt.attemptCount} Attempt{receipt.attemptCount === 1 ? "" : "s"} · Last Attempt {receiptTime(receipt.lastAttemptAt)}</span>
                  {receipt.statusCode !== undefined && <small>HTTP {receipt.statusCode}</small>}
                  {receipt.nextRetryAt !== undefined && <small>Next Retry {receiptTime(receipt.nextRetryAt)}</small>}
                  {receipt.error && <em>{receipt.error}</em>}
                </div>)}</div>}
            </details>
          </article>;
        })}
      </div>
    </section>
  );
}
