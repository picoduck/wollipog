import { useCallback, useEffect, useRef, useState } from "react";
import type { ReviewQueueBlocker, ReviewQueueItem } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { relativeTime, titleCaseLabel } from "../format.js";
import { approvalQueueDetail } from "../review-queue-details.js";
import { useFeedback } from "./FeedbackProvider.js";
import { sessionAgentLabel } from "./agent-options.js";

const COMPLETION_LABEL: Record<ReviewQueueItem["completion"], string> = {
  blocked: "Blocked",
  needs_review: "Needs Review",
  ready: "Ready to Publish",
};

function blockerLabel(blocker: ReviewQueueBlocker): string {
  const count = blocker.count ?? 1;
  switch (blocker.kind) {
    case "approval_pending": return "Approval Pending";
    case "checks_failing": return `${count} Check${count === 1 ? "" : "s"} Failing`;
    case "checks_pending": return `${count} Check${count === 1 ? "" : "s"} Pending`;
    case "findings_required": return `${count} Required Finding${count === 1 ? "" : "s"} Unresolved`;
    case "runner_offline": return "Runner Offline";
    case "git_unavailable": return "Git Summary Unavailable";
    case "review_denied": return "Reviewer Denied";
    case "review_escalated": return "Reviewer Escalated";
    case "review_incomplete": return "Review Required";
  }
}

function approvalKey(item: ReviewQueueItem): string | null {
  return item.approval
    ? JSON.stringify([item.approval.sessionId, item.approval.requestId])
    : null;
}

export function ReviewQueue({
  refreshKey,
  onOpen,
  onOpenReview,
}: {
  refreshKey: string;
  onOpen: (sessionId: string) => void;
  onOpenReview: (sessionId: string) => void;
}) {
  const api = useApi();
  const { confirm } = useFeedback();
  const [items, setItems] = useState<ReviewQueueItem[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const { items: next } = await api.reviewQueue();
      if (request !== requestRef.current) return;
      setItems(next);
      const valid = new Set(next.flatMap((item) => {
        const key = approvalKey(item);
        return key && item.approval?.runnerOnline ? [key] : [];
      }));
      setSelected((prior) => new Set([...prior].filter((key) => valid.has(key))));
      setError(null);
    } catch (cause) {
      if (request === requestRef.current) setError((cause as Error).message);
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
    return () => { requestRef.current += 1; };
  }, [load, refreshKey]);

  const selectedItems = items.flatMap((item) => {
    const approval = item.approval;
    const key = approvalKey(item);
    return approval && key && approval.runnerOnline && selected.has(key) ? [approval] : [];
  });
  const rejectSelected = async () => {
    if (!selectedItems.length || !await confirm({
      title: `Reject ${selectedItems.length} approval${selectedItems.length === 1 ? "" : "s"}?`,
      message: "The selected approval requests will be rejected or dismissed and their waiting operations will not continue.",
      confirmLabel: "Reject Selected",
      tone: "danger",
    })) return;
    setBusy(true);
    setError(null);
    try {
      const { results } = await api.rejectApprovalQueue({
        items: selectedItems.map(({ sessionId, requestId }) => ({ sessionId, requestId })),
      });
      const failures = results.filter((result) => !result.ok);
      setSelected(new Set());
      await load();
      if (failures.length) {
        setError(failures.map((failure) => `${failure.sessionId}: ${failure.error ?? "failed"}`).join("; "));
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!items.length && !error && !loading) return null;
  return (
    <section className="review-queue" aria-label="Review Queue">
      <div className="review-queue-head">
        <button className="btn ghost sm" aria-expanded={expanded} aria-controls="review-queue-list" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "▾" : "▸"} Review Queue (All Active Sessions) <span className="column-count">{items.length}</span>
        </button>
        <div className="review-queue-actions">
          {expanded && items.some((item) => item.approval) && (
            <button className="btn danger sm" disabled={busy || selectedItems.length === 0} onClick={() => void rejectSelected()}>
              {busy ? "Rejecting…" : `Reject Selected (${selectedItems.length})`}
            </button>
          )}
          <button className="btn ghost sm" disabled={loading || busy} onClick={() => void load()}>
            {loading ? "Scanning…" : "↻ Refresh"}
          </button>
        </div>
      </div>
      {error && <div className="tl-error">Review queue refresh failed: {error}</div>}
      {expanded && (
        <div className="review-queue-list" id="review-queue-list">
          {loading && items.length === 0 && <div className="review-queue-empty muted">Scanning active worktrees and checks…</div>}
          {!loading && items.length === 0 && <div className="review-queue-empty muted">No review work is waiting.</div>}
          {items.map((item) => {
            const key = approvalKey(item);
            const approval = item.approval;
            const scope = approval?.provenance.scope;
            const summary = item.summary;
            const verdict = item.reviewerVerdict;
            const approvalDetail = approval ? approvalQueueDetail(approval) : null;
            const hasReviewSurface = item.changesReady || item.findings.total > 0;
            return (
              <article className="review-queue-row" key={item.sessionId}>
                <div className="review-queue-select">
                  {approval && key ? (
                    <input
                      type="checkbox"
                      aria-label={`Select ${approval.approval.title}`}
                      checked={selected.has(key)}
                      disabled={!approval.runnerOnline || busy}
                      onChange={(event) => setSelected((prior) => {
                        const next = new Set(prior);
                        if (event.target.checked) next.add(key); else next.delete(key);
                        return next;
                      })}
                    />
                  ) : <span aria-hidden="true" />}
                </div>
                <div className="review-queue-main">
                  <button className="review-queue-summary" onClick={() => onOpen(item.sessionId)}>
                    <span className="review-queue-title">
                      {item.sessionTitle}
                      <span className={`review-completion review-completion-${item.completion}`}>
                        {COMPLETION_LABEL[item.completion]}
                      </span>
                    </span>
                    <span className="review-queue-session">
                      {item.workspaceName ?? "Workspace"} · {sessionAgentLabel(item.agentName, undefined, item.agentId)} · Updated {relativeTime(item.updatedAt)}
                    </span>
                    <span className="review-signals">
                      {item.changesReady && <span>Changes Ready{summary ? ` · ${summary.branch} · +${summary.addedLines}/−${summary.deletedLines}` : ""}</span>}
                      {approval && <span>Approval: {approval.approval.title}</span>}
                      {summary?.checks && <span>Checks: {summary.checks.failing} Failing · {summary.checks.pending} Pending · {summary.checks.passing} Passing</span>}
                      {item.findings.total > 0 && (
                        <span>
                          Findings: {item.findings.unresolved} Unresolved
                          {item.findings.requiredUnresolved > 0 ? ` · ${item.findings.requiredUnresolved} Required` : ""}
                        </span>
                      )}
                      {verdict && <span>Reviewer {verdict.reviewer.id ?? titleCaseLabel(verdict.reviewer.kind)}: {titleCaseLabel(verdict.outcome)}{verdict.riskLevel ? ` · ${titleCaseLabel(verdict.riskLevel)} Risk` : ""}</span>}
                    </span>
                    {approval && (
                      <span className="review-provenance">
                        Requested By {approval.provenance.actor.id ?? titleCaseLabel(approval.provenance.actor.kind)} · {relativeTime(approval.provenance.requestedAt)}
                        {scope?.toolName ? ` · ${scope.toolName}` : ""}
                        {scope?.path ? ` · ${scope.path}` : ""}
                        {scope?.network ? ` · ${scope.network}` : ""}
                        {scope?.branch ? ` · ${scope.branch}` : ""}
                      </span>
                    )}
                    {verdict?.rationale && <span className="review-rationale">{verdict.rationale}</span>}
                    {item.blockers.length > 0 && (
                      <span className="review-blockers">Must Resolve: {item.blockers.map(blockerLabel).join(" · ")}</span>
                    )}
                  </button>
                  {approvalDetail && (
                    <details className="review-exact-input" open>
                      <summary>{approvalDetail.label}</summary>
                      <pre>{approvalDetail.input}</pre>
                    </details>
                  )}
                  {approval && !approvalDetail && (
                    <div className="review-exact-unavailable muted">Exact input was not supplied by this runner.</div>
                  )}
                </div>
                <div className="review-queue-row-actions">
                  {approval && (
                    <button className="btn ghost sm review-open" onClick={() => onOpen(item.sessionId)}>Open Approval</button>
                  )}
                  {hasReviewSurface && (
                    <button className="btn ghost sm review-open" onClick={() => onOpenReview(item.sessionId)}>Open Exact Diff</button>
                  )}
                  {!approval && !hasReviewSurface && (
                    <button className="btn ghost sm review-open" onClick={() => onOpen(item.sessionId)}>Open Session</button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
