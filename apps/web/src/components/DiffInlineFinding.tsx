import { useContext, useId, useState } from "react";
import type { ReviewFinding, ReviewFindingStatus } from "@wollipog/protocol";
import { safeExternalHref } from "../external-href.js";
import { findingProvenance, forgeName, isOpenFinding } from "../review-finding-copy.js";
import { ViewerIdentityContext } from "../resolver-identity.js";
import { useTimelineClock } from "../timeline-clock.js";
import { ChevronRightIcon, ExternalLinkIcon } from "./Icons.js";
import { FindingSeverityBadge } from "./ReviewFindings.js";
import { StatusBadge } from "./StatusBadge.js";

/** How many characters of a settled finding's body its one line keeps before the ellipsis. */
const SUMMARY_MAX = 80;

/** The first words of a body: its first line, cut at a word boundary near {@link SUMMARY_MAX}. */
export function findingSummary(body: string): string {
  const first = body.trim().split("\n", 1)[0]!.trim();
  if (first.length <= SUMMARY_MAX) return first;
  const cut = first.slice(0, SUMMARY_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > SUMMARY_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * One finding inline in the diff, under the line it was written against (#2851; docs/design-system.md
 * §11.1, §11.3). An open finding is the editor's neutral card: its severity and Required badges, who
 * wrote it and when (the same words as the Findings section above the diff, so never a user id, the
 * scope or the diff side), the body, and Resolve and Dismiss. A resolved or dismissed one is a single
 * quiet line, "Resolved: <first words>", with Reopen; the line opens the whole finding.
 *
 * A forge thread is resolved on its forge, as in the Findings section: the server refuses a local
 * status change for it.
 */
export function DiffInlineFinding({
  finding,
  busy,
  refusal,
  agentLabel,
  onStatus,
}: {
  finding: ReviewFinding;
  busy: boolean;
  refusal: { reason: string; id: string } | null;
  /** The session's agent, for "Sent to Claude". */
  agentLabel?: string;
  onStatus: (finding: ReviewFinding, status: Exclude<ReviewFindingStatus, "sent">) => Promise<void>;
}) {
  const detailId = `dfinding-${useId().replace(/:/g, "")}`;
  const [expanded, setExpanded] = useState(false);
  const viewer = useContext(ViewerIdentityContext);
  const open = isOpenFinding(finding);
  const now = useTimelineClock(open || expanded);
  const remote = finding.remote;
  const remoteHref = remote ? safeExternalHref(remote.url) : null;
  const gate = { disabled: busy || refusal !== null, title: refusal?.reason, "aria-describedby": refusal?.id };
  const forgeLink = (verb: string) => remote && remoteHref && (
    <a className="btn sm ghost" href={remoteHref} target="_blank" rel="noreferrer">
      <ExternalLinkIcon size={14} aria-hidden="true" />
      {verb} on {forgeName(remote.provider)}
    </a>
  );
  const head = (
    <div className="dfinding-head">
      <FindingSeverityBadge severity={finding.severity} />
      {finding.required && <StatusBadge tone="neutral" noDot label="Required" />}
      <p className="dfinding-meta">
        <span>{findingProvenance(finding, { viewer, now, scope: null })}</span>
        {finding.status === "sent" && agentLabel && <span>Sent to {agentLabel}</span>}
      </p>
    </div>
  );

  if (open) {
    return (
      <article className="dfinding" aria-label="Finding">
        {head}
        <p className="dfinding-body">{finding.body}</p>
        <div className="dfinding-actions">
          {remote ? forgeLink("Resolve") : (
            <>
              <button type="button" className="btn sm ghost" {...gate} onClick={() => void onStatus(finding, "resolved")}>
                Resolve
              </button>
              <button type="button" className="btn sm ghost" {...gate} onClick={() => void onStatus(finding, "dismissed")}>
                Dismiss
              </button>
            </>
          )}
        </div>
      </article>
    );
  }

  return (
    <article className={`dfinding is-settled${expanded ? " is-expanded" : ""}`} aria-label="Finding">
      <div className="dfinding-line">
        <button
          type="button"
          className="disclosure-trigger dfinding-toggle"
          aria-expanded={expanded}
          aria-controls={detailId}
          title={expanded ? undefined : finding.body}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronRightIcon className="disclosure-chevron" size={14} aria-hidden="true" />
          <span className="dfinding-summary">
            {finding.status === "dismissed" ? "Dismissed" : "Resolved"}: {findingSummary(finding.body)}
          </span>
        </button>
        {remote ? forgeLink("Reopen") : (
          <button type="button" className="btn sm ghost" {...gate} onClick={() => void onStatus(finding, "open")}>
            Reopen
          </button>
        )}
      </div>
      <div className="dfinding-detail" id={detailId} hidden={!expanded}>
        {expanded && (
          <>
            {head}
            <p className="dfinding-body">{finding.body}</p>
          </>
        )}
      </div>
    </article>
  );
}
