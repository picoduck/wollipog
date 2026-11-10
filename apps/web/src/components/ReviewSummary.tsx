import { useId, useState } from "react";
import type { GitChecksSummary, GitDiffStats, GitPrSummary, GitStatusInfo, SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { safeExternalHref } from "../external-href.js";
import { fixChecksPrompt, forgeStateLabel } from "../pinned-summary.js";
import { sessionCommandRefusal } from "../session-command-permissions.js";
import { statusMeta } from "../status-meta.js";
import { titleCaseLabel } from "../format.js";
import { Spinner } from "./common.js";
import { BranchIcon, PullRequestIcon } from "./Icons.js";
import { StatusBadge } from "./StatusBadge.js";

/** "origin/main" reads as "main": the remote's name is not what the reviewer compares against. */
function baseName(ref: string | null | undefined): string | null {
  if (!ref) return null;
  return ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
}

/**
 * How far the branch is ahead of its base ("3 commits ahead of main"), or null when it is not. The
 * one wording for it: Session Tools' Review row reads it too, so the row and this summary agree.
 */
export function commitsAheadFact(status: Pick<GitStatusInfo, "ahead" | "baseRef" | "upstreamBranch">): string | null {
  if (status.ahead <= 0) return null;
  const base = baseName(status.baseRef ?? status.upstreamBranch);
  return `${status.ahead} commit${status.ahead === 1 ? "" : "s"} ahead${base ? ` of ${base}` : ""}`;
}

/**
 * The summary's meta facts (§11.3), in sentence case: how much of the uncommitted change is staged,
 * and how far the branch is ahead of its base. Each fact is its own item; the stylesheet sets them
 * 12px apart, with no middle dots (§5.2).
 */
export function reviewSummaryFacts(status: GitStatusInfo | null): string[] {
  if (!status) return [];
  const facts: string[] = [];
  const files = status.files.length;
  const count = `${files}${status.filesTruncated ? "+" : ""}`;
  const staged = status.stagedCount ?? 0;
  if (staged > 0) facts.push(`${staged} of ${count} file${files === 1 ? "" : "s"} staged`);
  else if (files > 0) facts.push(`${count} uncommitted file${files === 1 ? "" : "s"}`);
  const ahead = commitsAheadFact(status);
  if (ahead) facts.push(ahead);
  return facts;
}

/**
 * Review's summary (#2846; docs/design-system.md §11.2, §11.3): the first block of the scroller and
 * the one place Review states the branch and the size of the change. The branch in mono (truncating,
 * the full name in its tooltip) with the shown diff's diffstat, then the meta facts, then, when the
 * branch has a pull request, its row: title, state as a fact, a checks badge only when checks need
 * attention, Ask Agent to Fix for failing checks, and the forge link.
 */
export function ReviewSummary({
  session,
  status,
  stats,
  pr,
  checks,
  canPrompt,
}: {
  session: SessionView;
  status: GitStatusInfo | null;
  /** The diffstat of the diff on screen, or null before one has loaded. */
  stats: GitDiffStats | null;
  pr: GitPrSummary | null;
  checks: GitChecksSummary | null;
  /** The session can take a prompt now: online, not finished, not held by a policy approval. */
  canPrompt: boolean;
}) {
  if (!status && !pr) return null;
  const facts = reviewSummaryFacts(status);
  return (
    <section className="review-summary" aria-label="Summary">
      {status && (
        <div className="review-summary-line">
          <BranchIcon className="review-summary-icon" size={14} aria-hidden="true" />
          <span className="review-branch" title={status.branch}>{status.branch}</span>
          {stats && (stats.insertions > 0 || stats.deletions > 0) && (
            <span className="review-diffstat" aria-label={`${stats.insertions} added, ${stats.deletions} removed`}>
              <span className="diff-ins">+{stats.insertions}</span>
              <span className="diff-del">−{stats.deletions}</span>
            </span>
          )}
        </div>
      )}
      {facts.length > 0 && (
        <div className="review-summary-meta">
          {facts.map((fact) => <span key={fact}>{fact}</span>)}
        </div>
      )}
      {pr && <PullRequestRow session={session} pr={pr} checks={checks} canPrompt={canPrompt} />}
    </section>
  );
}

function PullRequestRow({ session, pr, checks, canPrompt }: {
  session: SessionView;
  pr: GitPrSummary;
  checks: GitChecksSummary | null;
  canPrompt: boolean;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const refusalId = useId();
  const mergeRequest = pr.kind === "merge_request";
  const noun = mergeRequest ? "Merge Request" : "Pull Request";
  const forgeName = (pr.provider ?? (mergeRequest ? "gitlab" : "github")) === "gitlab" ? "GitLab" : "GitHub";
  const href = safeExternalHref(pr.url);
  const failing = (checks?.failing ?? 0) > 0;
  const pending = !failing && (checks?.pending ?? 0) > 0;
  const promptRefusal = sessionCommandRefusal(session, "prompt");
  const fix = async () => {
    if (!checks || promptRefusal !== null) return;
    setBusy(true);
    try {
      // The same prompt the Pinned Summary's Fix sends, so either control asks for the same work.
      await api.prompt(session.id, fixChecksPrompt(checks, pr.kind ?? "pull_request"), []);
      setSent(true);
    } catch {
      /* the composer surfaces prompt failures; this button stays quiet, as the Pinned Summary's does */
    } finally {
      setBusy(false);
    }
  };
  const title = pr.title || `${mergeRequest ? "MR" : "PR"} #${pr.number}`;
  return (
    <div className="review-pr" role="group" aria-label={noun}>
      <div className="review-pr-line">
        <PullRequestIcon className="review-summary-icon" size={14} aria-hidden="true" />
        <span className="review-pr-title" title={`${noun} #${pr.number}${pr.title ? `: ${pr.title}` : ""}`}>{title}</span>
      </div>
      <div className="review-pr-meta">
        <span>{forgeStateLabel(pr.state)}</span>
        {(failing || pending) && checks && (
          <StatusBadge
            meta={statusMeta("checks", failing ? "failing" : "pending")}
            title={failing && checks.failingNames.length > 0 ? checks.failingNames.join(", ") : undefined}
          />
        )}
        {failing && canPrompt && (
          <button
            type="button"
            className="btn sm"
            onClick={() => void fix()}
            disabled={busy || sent || promptRefusal !== null}
            title={promptRefusal ?? "Ask the agent to investigate and fix the failing checks"}
            aria-describedby={promptRefusal !== null ? refusalId : undefined}
          >
            {busy && <Spinner decorative />}
            {sent ? "Sent to Agent" : "Ask Agent to Fix"}
          </button>
        )}
        {href && (
          <a className="link" href={href} target="_blank" rel="noreferrer">Open on {forgeName}</a>
        )}
      </div>
      {(pr.baseRef || pr.headRef || pr.mergeability) && (
        <dl className="review-request-facts">
          {pr.baseRef && <div><dt>Base</dt><dd>{pr.baseRef}</dd></div>}
          {pr.headRef && <div><dt>Head</dt><dd>{pr.headRef}</dd></div>}
          {pr.mergeability && <div><dt>Mergeability</dt><dd>{titleCaseLabel(pr.mergeability.replaceAll("_", " ").toLowerCase()).replace(/\bCi\b/g, "CI")}</dd></div>}
        </dl>
      )}
      {checks && (
        <details className="review-request-checks">
          <summary>Checks ({checks.passing} Passing, {checks.pending} Pending, {checks.failing} Failing)</summary>
          {checks.jobs && checks.jobs.length > 0 ? (
            <ul>
              {checks.jobs.map((job, index) => {
                const jobHref = safeExternalHref(job.url);
                return <li key={index}>
                  {jobHref ? <a className="link" href={jobHref} target="_blank" rel="noreferrer">{job.name}</a> : <span>{job.name}</span>}
                  {" — "}{job.state === "passing" ? "Passing" : job.state === "failing" ? "Failing" : "Pending"}
                </li>;
              })}
            </ul>
          ) : <p>Named checks are unavailable from this machine.</p>}
          {checks.jobsIncomplete && <p>Some checks are unavailable. Open the forge for the complete list.</p>}
          {safeExternalHref(checks.url) && <a className="link" href={safeExternalHref(checks.url)!} target="_blank" rel="noreferrer">Open Checks</a>}
        </details>
      )}
      {failing && canPrompt && promptRefusal !== null && (
        <p id={refusalId} className="review-pr-refusal">{promptRefusal}</p>
      )}
    </div>
  );
}
