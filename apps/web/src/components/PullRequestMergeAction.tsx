import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  GitMergeResultInfo,
  GitPrSummary,
  PullRequestMergeReadinessResponse,
  SessionView,
} from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { useFeedback } from "./FeedbackProvider.js";
import { Spinner } from "./common.js";

/**
 * Enqueue for Merge, or Merge Pull Request where the base has no merge queue (#604): one button
 * gated by the control plane's readiness gate, with every reason it is disabled written out
 * beneath it. Pressing it asks for confirmation naming the pull request, its exact head and what
 * GitHub will do, then sends that head; the result is what the runner read back from GitHub.
 *
 * Reusable as is: the Review panel's request summary renders it, and so can #1270's Pull Request
 * view. `refreshKey` re-reads readiness when the caller's forge facts move (checks, queue state).
 */
export function PullRequestMergeAction({ session, pr, refreshKey, onMerged }: {
  session: SessionView;
  pr: GitPrSummary;
  /** Any change re-reads readiness, such as the check counts or merge-queue state the caller shows. */
  refreshKey?: string;
  /** Called after GitHub reports the pull request enqueued or merged, to refresh the caller's summary. */
  onMerged?: () => void;
}) {
  const api = useApi();
  const { confirm } = useFeedback();
  const [readiness, setReadiness] = useState<PullRequestMergeReadinessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GitMergeResultInfo | null>(null);
  const describedBy = useId();
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await api.pullRequestMergeReadiness(session.id);
      if (mine !== generation.current) return;
      setReadiness(next);
      setError(null);
    } catch (e) {
      if (mine !== generation.current) return;
      setReadiness(null);
      // The server's own refusal is a sentence for the person; a transport error's text is not.
      setError(e instanceof ApiError && e.message ? e.message : "Merge readiness could not be read; refresh Review to try again.");
    }
  }, [api, session.id]);

  const mergeRequest = pr.kind === "merge_request";
  useEffect(() => {
    if (!mergeRequest) void load();
  }, [load, mergeRequest, pr.url, pr.state, refreshKey]);

  // GitLab merge trains and merges are not supported yet: say so instead of offering a button.
  if (mergeRequest) {
    return <p className="review-pr-refusal">Merging from Wollipog supports GitHub pull requests only; merge this merge request on GitLab.</p>;
  }

  const gate = readiness?.readiness;
  const facts = readiness?.facts ?? null;
  const label = gate?.label ?? (pr.mergeQueue?.enabled ? "Enqueue for Merge" : "Merge Pull Request");
  // The facts must describe this pull request; a branch whose pull request changed reloads first.
  const current = facts?.url === pr.url;
  const ready = Boolean(gate?.ready && current && gate.mode && gate.headSha);
  const blockers = gate?.blockers.map((blocker) => blocker.message) ?? [];
  if (gate && !current && facts) blockers.push("The pull request changed; reloading its merge state.");

  const run = async () => {
    if (!ready || !gate || !facts || !gate.mode || !gate.headSha) return;
    const branchNote = facts.deleteBranchOnMerge
      ? "This repository's own setting deletes the head branch after it merges."
      : "The branch is not deleted.";
    const detailRows = [
      { label: `#${facts.number} ${pr.title}`.trim() },
      { label: gate.headSha, labelStyle: "mono" as const },
    ];
    const confirmed = await confirm(gate.mode === "enqueue" ? {
      title: "Enqueue for Merge",
      message: `GitHub adds pull request #${facts.number} to the ${facts.baseRef} merge queue at this head, tests it on top of the latest ${facts.baseRef}, and merges it with the queue's method. ${branchNote}`,
      detailRows,
      confirmLabel: "Enqueue for Merge",
    } : {
      title: "Merge Pull Request",
      message: `GitHub merges pull request #${facts.number} into ${facts.baseRef} at this head with the repository's ${gate.mergeMethod} method. ${branchNote}`,
      detailRows,
      confirmLabel: "Merge Pull Request",
    });
    if (!confirmed) return;
    setBusy(true);
    setResult(null);
    try {
      const response = await api.mergePullRequest(session.id, { pullRequestUrl: facts.url, headSha: gate.headSha, mode: gate.mode });
      setResult(response.result);
      if (response.result.outcome === "enqueued" || response.result.outcome === "merged") onMerged?.();
    } catch (e) {
      // A lost reply may still have enqueued or merged: never claim either, and say to check.
      const message = e instanceof ApiError && e.message ? e.message
        : "The request's result could not be read; check the pull request before trying again.";
      setResult({ outcome: "uncertain", message, mode: gate.mode, headSha: gate.headSha, state: null });
    } finally {
      setBusy(false);
      void load();
    }
  };

  return (
    <div role="group" aria-label={label}>
      <div className="review-pr-meta">
        <button
          type="button"
          className="btn sm"
          onClick={() => void run()}
          disabled={!ready || busy}
          aria-describedby={blockers.length > 0 || error ? describedBy : undefined}
        >
          {busy && <Spinner decorative />}
          {label}
        </button>
        {!readiness && !error && <span>Checking merge readiness…</span>}
      </div>
      {(blockers.length > 0 || error) && (
        <div id={describedBy}>
          {error && <p className="review-pr-refusal">{error}</p>}
          {blockers.map((blocker) => <p key={blocker} className="review-pr-refusal">{blocker}</p>)}
        </div>
      )}
      {result && <p className="review-pr-refusal" role="status">{result.message}</p>}
    </div>
  );
}
