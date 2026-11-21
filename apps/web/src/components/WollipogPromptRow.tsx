import React, { useEffect, useState } from "react";
import type { SessionView } from "@wollipog/protocol";
import type { ApiClient } from "../api.js";
import { useApi } from "../api-context.js";
import { formatClock, formatRecordedTimestamp } from "../format.js";
import type { View } from "../navigation.js";
import { sessionDisplayTitle } from "../session-title.js";
import { statusMeta } from "../status-meta.js";
import { useOptionalNavigate, useOptionalStoreSelector } from "../store.js";
import type { TimelinePromptOrigin } from "../wollipog-prompt-origin.js";
import { ChevronRightIcon, DecisionBlockedIcon, DecisionClosedIcon, DecisionTimedOutIcon, InfoIcon, SuccessIcon } from "./Icons.js";
import { StatusBadge } from "./StatusBadge.js";

type ConfirmationOrigin = Extract<TimelinePromptOrigin, { kind: "owner_confirmation" }>;

const outcomes = {
  approved: { lead: "You approved", tone: "t-success", icon: <SuccessIcon size={16} /> },
  denied: { lead: "You denied", tone: "t-neutral", icon: <DecisionClosedIcon size={16} /> },
  expired: { lead: "Approval expired for", tone: "t-warning", icon: <DecisionTimedOutIcon size={16} /> },
  refused: { lead: "Wollipog refused", tone: "t-danger", icon: <DecisionBlockedIcon size={16} /> },
} as const;

const noticeTitles = {
  background_result: "Background Work Finished",
  delegation_notice: "Delegated Decision",
  scheduled_wake: "Scheduled Wake-Up",
  system_notice: "Wollipog Notice",
} as const;

const receipts = {
  accepted: "Accepted", running: "Running", succeeded: "Completed", failed: "Failed", uncertain: "Uncertain",
} as const;

const pendingTargetLookups = new WeakMap<ApiClient, Map<string, Promise<SessionView>>>();

function lookupTargetSession(api: ApiClient, id: string): Promise<SessionView> {
  const pending = pendingTargetLookups.get(api) ?? new Map<string, Promise<SessionView>>();
  pendingTargetLookups.set(api, pending);
  const existing = pending.get(id);
  if (existing) return existing;
  const lookup = api.session(id).then(({ session }) => session).finally(() => pending.delete(id));
  pending.set(id, lookup);
  return lookup;
}

function ConfirmationTargetChip({ target }: { target: ConfirmationOrigin["target"] }) {
  const api = useApi();
  const navigate = useOptionalNavigate();
  const liveSession = useOptionalStoreSelector((state) =>
    target.kind === "session" ? state.sessions.get(target.id) : undefined);
  const [lookedUpSession, setLookedUpSession] = useState<SessionView>();
  useEffect(() => {
    if (target.kind !== "session" || liveSession || !navigate) return;
    // The default live snapshot omits archived sessions, including the result of Archive Session.
    let current = true;
    void lookupTargetSession(api, target.id).then((session) => {
      if (current) setLookedUpSession(session);
    }).catch(() => {
      if (current) setLookedUpSession(undefined);
    });
    return () => { current = false; };
  }, [api, liveSession, navigate, target.kind, target.id]);
  const session = liveSession ?? (lookedUpSession?.id === target.id ? lookedUpSession : undefined);
  const runner = useOptionalStoreSelector((state) =>
    target.kind === "runner" ? state.runners.get(target.id) : undefined);
  const project = useOptionalStoreSelector((state) =>
    target.kind === "project" ? state.projects.get(target.id) : undefined);
  const label = (session?.title && sessionDisplayTitle(session.title)) || runner?.displayName || project?.name || target.label;
  const status = session ? statusMeta("session", session.archived ? "archived" : session.status)
    : runner ? statusMeta("machine", runner.status) : undefined;
  const destination: View | undefined = session ? { name: "session", id: session.id }
    : runner ? { name: "runners", section: "machines", machineId: runner.runnerId }
    : project ? { name: "projects", id: project.id } : undefined;
  const content = <><span>{label}</span>{status && <StatusBadge inline meta={status} />}</>;
  return navigate && destination
    ? <button type="button" className="chip tl-prompt-target" onClick={() => navigate(destination)}>{content}</button>
    : <span className="chip tl-prompt-target">{content}</span>;
}

export function WollipogPromptRow({ origin, text, createdAt, open, onToggle }: {
  origin: TimelinePromptOrigin;
  text: string;
  createdAt?: number;
  open: boolean;
  onToggle?: () => void;
}) {
  const confirmation = origin.kind === "owner_confirmation" ? origin : null;
  const outcome = confirmation ? outcomes[confirmation.outcome] : null;
  const at = confirmation?.resolvedAt ?? createdAt;
  const time = formatRecordedTimestamp(at);
  const fact = confirmation?.outcome === "approved"
    ? "Wollipog ran it once · Receipt: " + (confirmation.receiptStatus ? receipts[confirmation.receiptStatus] : "Unknown")
    : confirmation ? "Nothing ran" : undefined;
  return (
    <div className="tl-wollipog-prompt" data-prompt-origin={origin.kind} data-confirmation-outcome={confirmation?.outcome}>
      <div className="tl-prompt-icon" aria-hidden="true">
        <span className={"tl-decision-icon " + (outcome?.tone ?? "t-info")}>{outcome?.icon ?? <InfoIcon size={16} />}</span>
      </div>
      <div className="tl-prompt-content">
        <div className="tl-prompt-heading">
          {origin.kind === "owner_confirmation"
            ? <span>{outcomes[origin.outcome].lead} <strong>{origin.title}</strong></span>
            : <strong>{noticeTitles[origin.kind]}</strong>}
          {confirmation && <ConfirmationTargetChip target={confirmation.target} />}
        </div>
        {(fact || time) && <div className="tl-prompt-fact">
          {fact}{fact && time && " · "}
          {time && <time dateTime={time.dateTime} title={time.title}>{formatClock(at)}</time>}
        </div>}
        <details className="disclosure tl-prompt-details" open={open}>
          <summary onClick={(event) => {
            if (!onToggle) return;
            event.preventDefault();
            onToggle();
          }}>
            <ChevronRightIcon size={14} className="disclosure-chevron" />
            Details
          </summary>
          <div className="code-well tl-prompt-message">
            <strong>Message Wollipog Sent to the Assistant</strong>
            <pre>{text}</pre>
          </div>
        </details>
      </div>
    </div>
  );
}
