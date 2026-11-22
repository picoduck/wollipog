import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  assistantDecisionActionLabel,
  type AssistantDecisionHistoryEntry,
  type AssistantDecisionHistoryPage,
  type AssistantDecisionOutcome,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { formatCalendarTime } from "../format.js";
import { viewPath } from "../navigation.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { CampaignSection } from "./CampaignSections.js";
import { ErrorIcon, MessageSquareIcon, SuccessIcon } from "./Icons.js";
import { Notice } from "./Notice.js";

type HistoryState = { kind: "loading" } | { kind: "ready"; page: AssistantDecisionHistoryPage } | { kind: "error" };
type OutcomeFilter = "all" | AssistantDecisionOutcome;
const outcomes = {
  approved: { label: "Approved", icon: <SuccessIcon size={16} />, tone: "t-success" },
  denied: { label: "Denied", icon: <ErrorIcon size={16} />, tone: "t-danger" },
  answered: { label: "Answered", icon: <MessageSquareIcon size={16} />, tone: "t-info" },
} as const;
const outcomeFilters = ["all", "approved", "denied", "answered"] as const;

function countOutcomes(entries: AssistantDecisionHistoryEntry[]) {
  const counts = { approved: 0, denied: 0, answered: 0 };
  for (const { delegation } of entries) counts[delegation.outcome]++;
  return counts;
}

function DecisionSubject({ category, resourceKey, subject }: AssistantDecisionHistoryEntry) {
  if (category === "ci_rerun") {
    if (!subject) return "GitHub Actions Run";
    const [repository, run, attempt, ...job] = subject.split(" · ");
    if (!run?.startsWith("Run ") || !attempt?.startsWith("Attempt ")) return subject;
    return <><code>{repository}</code> · Run <code>{run.slice(4)}</code> · {attempt}
      {!!job.length && <> · {job.join(" · ")}</>}
    </>;
  }
  if (category === "release_tag" || category === "release_publish") {
    return subject ? <code>{subject}</code> : "GitHub Release";
  }
  if (category === "merged_branch_deletion") {
    const branch = /^merged_branch_deletion:[^:]+:(.+)$/u.exec(resourceKey)?.[1];
    return <code>{subject ?? branch ?? resourceKey}</code>;
  }
  if (category === "pr_merge" || category === "issue_closure") return <code>{subject ?? resourceKey}</code>;
  return subject ?? resourceKey;
}

function DecisionReason({ reason }: { reason: string }) {
  const id = useId();
  const text = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);

  useLayoutEffect(() => {
    const paragraph = text.current;
    if (!paragraph || expanded) return;
    const measure = () => setClipped(paragraph.scrollHeight > paragraph.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(paragraph);
    return () => observer.disconnect();
  }, [expanded, reason]);

  return <>
    <p id={id} ref={text} className="assistant-decision-reason" data-expanded={expanded}>{reason}</p>
    {(clipped || expanded) && <button className="link" type="button" aria-expanded={expanded} aria-controls={id}
      onClick={() => setExpanded((value) => !value)}>{expanded ? "Show Less" : "Show Full Reason"}</button>}
  </>;
}

function DecisionRow({ entry, showThread }: { entry: AssistantDecisionHistoryEntry; showThread: boolean }) {
  const { category, delegation } = entry;
  const { label, icon, tone } = outcomes[delegation.outcome];
  const { navigate } = useStoreActions();
  const threadView = { name: "assistants", threadId: delegation.threadId } as const;

  return <li className="campaign-decision-item assistant-decision-row">
    <span className={"assistant-decision-outcome " + tone} role="img" aria-label={label} title={label}>{icon}</span>
    <div className="assistant-decision-content">
      <div className="assistant-decision-meta">
        <strong>{assistantDecisionActionLabel(category, delegation.outcome)}</strong>
        <time dateTime={new Date(delegation.resolvedAt).toISOString()}>{formatCalendarTime(delegation.resolvedAt)}</time>
      </div>
      <p className="assistant-decision-subject"><DecisionSubject {...entry} /></p>
      <DecisionReason reason={delegation.reason} />
      {showThread && <a className="link" href={viewPath(threadView)} onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(threadView);
      }}>{delegation.threadTitle ?? "Assistant Thread"}</a>}
    </div>
  </li>;
}

function DecisionHistory({ campaignId, threadId, onCount }: {
  campaignId?: string;
  threadId?: string;
  onCount?: (count: string | null) => void;
}) {
  const api = useApi();
  const [filter, setFilter] = useState<OutcomeFilter>("all");
  const [cursors, setCursors] = useState<string[]>([]);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<HistoryState>({ kind: "loading" });
  const [summary, setSummary] = useState<{ counts: ReturnType<typeof countOutcomes>; exact: boolean }>();
  const results = useRef<HTMLDivElement>(null);
  const before = cursors.at(-1);
  const refreshRevision = useStoreSelector((store) => store.snapshotRevision);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      try {
        const page = await api.assistantDecisionHistory({
          ...(campaignId ? { campaignId } : {}), ...(threadId ? { threadId } : {}), ...(before ? { before } : {}),
          ...(filter !== "all" ? { outcome: filter } : {}),
        }, controller.signal);
        if (controller.signal.aborted) return;
        setState({ kind: "ready", page });
        // Older control planes ignore the outcome query and can only show counts for the current page.
        setSummary((current) => page.outcomeCounts ? { counts: page.outcomeCounts, exact: true }
          : current?.exact && before ? current : { counts: countOutcomes(page.entries), exact: false });
        if (!before) onCount?.(page.total?.toString() ?? (page.entries.length + (page.nextBefore ? "+" : "")));
      } catch {
        if (controller.signal.aborted) return;
        setState({ kind: "error" });
        if (!before) onCount?.(null);
      }
    });
    return () => controller.abort();
  }, [api, before, campaignId, threadId, filter, retry, refreshRevision, onCount]);

  const page = state.kind === "ready" ? state.page : null;
  const allCount = summary ? Object.values(summary.counts).reduce((sum, count) => sum + count, 0) : undefined;
  const entries = page?.entries.filter((entry) => filter === "all" || filter === entry.delegation.outcome);
  const next = page?.nextBefore;

  function goToPage(nextCursors: string[]) {
    results.current?.focus();
    setState({ kind: "loading" });
    setCursors(nextCursors);
  }

  const body = <div className="assistant-decision-history">
    {(!!allCount || filter !== "all" || !!before) && <div className="chips assistant-decision-filters" role="group" aria-label="Filter Delegated Decisions">
      {outcomeFilters.map((choice) => <button key={choice} className="chip" type="button" aria-pressed={filter === choice}
        onClick={() => {
          if (filter === choice) return;
          setState({ kind: "loading" });
          setCursors([]);
          setFilter(choice);
        }}>
        {choice === "all" ? "All" : outcomes[choice].label} <span className="num">{choice === "all" ? allCount : summary?.counts[choice]}</span>
      </button>)}
    </div>}
    {page && summary && !summary.exact && !!allCount && (before || page.nextBefore) && <p className="muted">Counts reflect this page.</p>}
    <div ref={results} className="assistant-decision-results" tabIndex={-1}>
      {state.kind === "loading" && <div className="skeleton decision-history-skeleton" role="status">
        <span className="sr-only">Loading delegated decisions…</span>
        {[0, 1, 2].map((index) => <div aria-hidden="true" className="skeleton-row" key={index} />)}
      </div>}
      {state.kind === "error" && <Notice tone="danger" role="alert" actions={<button className="btn sm" type="button"
        onClick={() => {
          results.current?.focus();
          setState({ kind: "loading" });
          setRetry((current) => current + 1);
        }}>Retry</button>}>
        <p>Couldn't load delegated decisions.</p>
      </Notice>}
      {entries?.length === 0 && <p className="assistant-decision-empty muted">{filter === "all"
        ? "No delegated decisions yet."
        : summary?.exact ? "No matching decisions." : "No matching decisions on this page."}</p>}
      {!!entries?.length && <ul className="campaign-decision-list" aria-label="Delegated Decisions">
        {entries.map((entry) => <DecisionRow entry={entry} key={entry.occurrenceId} showThread={campaignId !== undefined} />)}
      </ul>}
      {page && (before || next) && <div className="assistant-decision-pagination">
        {before && <button type="button" className="btn sm" onClick={() => goToPage(cursors.slice(0, -1))}>Newer Decisions</button>}
        {next && <button type="button" className="btn sm" onClick={() => goToPage([...cursors, next])}>Older Decisions</button>}
      </div>}
    </div>
  </div>;

  if (!campaignId) return body;
  if (!allCount && state.kind !== "error") return null;
  return <CampaignSection title="Delegated Decisions" count={allCount}>{body}</CampaignSection>;
}

export function AssistantThreadDecisionHistory({ threadId, onCount }: {
  threadId: string;
  onCount: (count: string | null) => void;
}) {
  return <DecisionHistory key={threadId} threadId={threadId} onCount={onCount} />;
}

export function CampaignAssistantDecisions({ campaignId }: { campaignId: string }) {
  const supported = useStoreSelector((store) => store.assistantDecisionHistorySupported);
  return supported ? <DecisionHistory key={campaignId} campaignId={campaignId} /> : null;
}
