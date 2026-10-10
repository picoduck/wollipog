import { useContext, useId, useLayoutEffect, useRef, useState, type FocusEvent, type Ref } from "react";
import type { GitDiffScope, ReviewFinding, ReviewFindingSeverity, SourceLocation } from "@wollipog/protocol";
import { safeExternalHref } from "../external-href.js";
import {
  FINDING_SEVERITY,
  findingLocation,
  findingProvenance,
  forgeName,
  isOpenFinding,
} from "../review-finding-copy.js";
import { ViewerIdentityContext } from "../resolver-identity.js";
import { useTimelineClock } from "../timeline-clock.js";
import { ChevronRightIcon, ExternalLinkIcon, UpdatedIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { StatusBadge } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Checkbox } from "./ui/ChoiceControls.js";
import { useIsCoarsePointer } from "./useIsMobile.js";

/** A finding's one status badge (§11.1), from `FINDING_SEVERITY`. */
export function FindingSeverityBadge({ severity }: { severity: ReviewFindingSeverity }) {
  const { label, tone } = FINDING_SEVERITY[severity];
  return <StatusBadge tone={tone} label={label} />;
}

/** The head's Sync control, present only when the repository has that forge's remote. */
export interface FindingSyncControl {
  forge: "github" | "gitlab";
  busy: boolean;
  /** Held by another findings action, the machine being offline, or a refusal the toolbar shows. */
  disabled: boolean;
  /** Why this runner cannot sync at all, shown under the head. */
  unavailable: string | null;
  refusal: { reason: string; id: string } | null;
  onSync: () => void;
}

type FindingRefusal = { reason: string; id: string } | null;

/**
 * The body, clamped to three lines with Show More when it runs longer. Whether it runs longer is
 * measured against the clamp whenever the text or the row's width changes, as Skills' description
 * is, so a body that fits once the panel widens loses its toggle.
 */
function FindingBody({ text }: { text: string }) {
  const id = `finding-body-${useId().replace(/:/g, "")}`;
  const [expanded, setExpanded] = useState(false);
  const [truncates, setTruncates] = useState(false);
  const bodyRef = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => {
      body.classList.add("is-clamped");
      const hidden = body.scrollHeight > body.clientHeight + 1;
      if (expanded) body.classList.remove("is-clamped");
      setTruncates(hidden);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [text, expanded]);
  return (
    <>
      <p ref={bodyRef} id={id} className={`review-finding-body${expanded ? "" : " is-clamped"}`}>{text}</p>
      {truncates && (
        <button
          type="button"
          className="link review-finding-more"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show Less" : "Show More"}
        </button>
      )}
    </>
  );
}

function FindingRow({
  finding,
  outdated,
  selected,
  selectionDisabled,
  onSelect,
  busy,
  refusal,
  onStatus,
  onOpenSourceLocation,
  provenance,
  agentLabel,
}: {
  finding: ReviewFinding;
  outdated: boolean;
  selected: boolean;
  selectionDisabled: boolean;
  onSelect: (checked: boolean) => void;
  busy: boolean;
  refusal: FindingRefusal;
  onStatus: (finding: ReviewFinding, status: "resolved" | "dismissed") => void;
  onOpenSourceLocation: (location: SourceLocation) => void;
  provenance: string;
  agentLabel: string;
}) {
  const location = findingLocation(finding);
  const remote = finding.remote;
  const remoteHref = remote ? safeExternalHref(remote.url) : null;
  const statusGate = {
    disabled: busy || refusal !== null,
    title: refusal?.reason,
    "aria-describedby": refusal?.id,
  };
  return (
    <article className="review-finding-row">
      <div className="review-finding-head">
        <Checkbox
          labelHidden
          label={location.label === null
            ? "Select Remote Discussion"
            : remote?.subjectType === "file"
              ? `Select File-Level Finding on ${finding.filePath}`
              : `Select Finding on ${finding.filePath} Line ${finding.line}`}
          checked={selected}
          disabled={selectionDisabled}
          onChange={onSelect}
        />
        <FindingSeverityBadge severity={finding.severity} />
        {finding.required && <StatusBadge tone="neutral" noDot label="Required" />}
        {location.label === null
          ? (
            <span className="review-finding-discussion">
              {remote?.provider === "github" ? "Pull request discussion" : "Merge request discussion"}
            </span>
          )
          : location.source
            ? (
              <button
                type="button"
                className="review-finding-location"
                title={location.title ?? undefined}
                onClick={() => onOpenSourceLocation(location.source!)}
              >
                {location.label}
              </button>
            )
            : <span className="review-finding-location" title={location.title ?? undefined}>{location.label}</span>}
      </div>
      <FindingBody text={finding.body} />
      {outdated && (
        <p className="review-finding-outdated">
          <UpdatedIcon size={14} aria-hidden="true" />
          Outdated: the line changed after this was written.
        </p>
      )}
      <div className="review-finding-foot">
        <p className="review-finding-meta">
          <span>{provenance}</span>
          {finding.status === "sent" && <span>Sent to {agentLabel}</span>}
        </p>
        <div className="review-finding-row-actions">
          {remote
            ? remoteHref && (
              <a className="btn sm ghost" href={remoteHref} target="_blank" rel="noreferrer">
                <ExternalLinkIcon size={14} aria-hidden="true" />
                Resolve on {forgeName(remote.provider)}
              </a>
            )
            : (
              <>
                <button type="button" className="btn sm ghost" {...statusGate} onClick={() => onStatus(finding, "resolved")}>
                  Resolve
                </button>
                <button type="button" className="btn sm ghost" {...statusGate} onClick={() => onStatus(finding, "dismissed")}>
                  Dismiss
                </button>
              </>
            )}
        </div>
      </div>
    </article>
  );
}

/**
 * Review's findings (#2850; docs/design-system.md §5.2, §5.5, §11.1, §11.3, §11.4): one flush
 * section between the summary and the diff, collapsed under a disclosure whose head carries the open
 * count and one summary status. Each open finding is a single-column row at every width: its badges
 * and location, the body at full width, then who wrote it and its actions. Selecting rows hands the
 * panel's foot to the selection bar, which sends them to the agent.
 */
export function ReviewFindings({
  findings,
  loaded,
  anchoredFindingIds,
  anchorsKnown,
  scope,
  selected,
  onSelect,
  selectionDisabled,
  busyFindingId,
  refusal,
  onStatus,
  onOpenSourceLocation,
  agentLabel,
  sync,
  notice,
  error,
  onDismissNotice,
  triggerRef,
}: {
  findings: ReviewFinding[];
  /** False until the first read lands, so the empty line never flashes before the findings. */
  loaded: boolean;
  /** Findings still attached to the line they were written against in the diff on screen. */
  anchoredFindingIds: ReadonlySet<string>;
  /** A diff is on screen, so an unanchored local finding is known to be outdated. */
  anchorsKnown: boolean;
  /** The scope on screen; a finding written against another one says which. */
  scope: GitDiffScope | null;
  selected: ReadonlySet<string>;
  onSelect: (findingId: string, checked: boolean) => void;
  selectionDisabled: boolean;
  busyFindingId: string | null;
  /** A person the server refuses finding changes to (#1864): the reason, shown in the section. */
  refusal: FindingRefusal;
  onStatus: (finding: ReviewFinding, status: "resolved" | "dismissed") => void;
  onOpenSourceLocation: (location: SourceLocation) => void;
  /** The session's agent, for "Sent to Claude". */
  agentLabel: string;
  sync: FindingSyncControl | null;
  /** A sync's result, beside the Sync control that made it. */
  notice: string | null;
  error: string | null;
  onDismissNotice: () => void;
  /** The disclosure, where focus returns when the selection bar goes away under it. */
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  const uid = useId().replace(/:/g, "");
  const bodyId = `${uid}-findings`;
  const syncReasonId = `${uid}-sync-reason`;
  const viewer = useContext(ViewerIdentityContext);
  const coarse = useIsCoarsePointer();
  const open = findings.filter(isOpenFinding);
  const now = useTimelineClock(open.length > 0);
  // Open by default while anything waits on someone, and while there is nothing yet, so the line
  // that says how to add one is on screen; a review whose findings are all settled starts folded.
  const [expandedChoice, setExpandedChoice] = useState<boolean | null>(null);
  const expanded = expandedChoice ?? (open.length > 0 || findings.length === 0);
  const requiredOpen = open.filter((finding) => finding.required).length;

  return (
    <section className="review-findings" aria-label="Findings">
      <div className="review-findings-head">
        <button
          ref={triggerRef}
          type="button"
          className="disclosure-trigger"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpandedChoice(!expanded)}
        >
          <ChevronRightIcon className="disclosure-chevron" size={14} aria-hidden="true" />
          Findings
          {open.length > 0 && <span className="review-findings-count">{open.length}</span>}
        </button>
        {requiredOpen > 0
          ? <StatusBadge tone="warning" label={`${requiredOpen} Required`} />
          : findings.length > 0 && open.length === 0 && <StatusBadge tone="success" label="All Resolved" />}
        {sync && (
          <BusyButton
            className="btn sm ghost review-findings-sync"
            busy={sync.busy}
            progress={`Syncing ${forgeName(sync.forge)} review threads…`}
            disabled={sync.disabled || sync.unavailable !== null}
            title={sync.refusal?.reason ?? (sync.unavailable === null
              ? `Import this branch's ${forgeName(sync.forge)} review threads (read-only)`
              : undefined)}
            aria-describedby={sync.unavailable !== null ? syncReasonId : sync.refusal?.id}
            onClick={sync.onSync}
          >
            Sync {forgeName(sync.forge)}
          </BusyButton>
        )}
      </div>
      {sync?.unavailable && <p className="review-findings-reason" id={syncReasonId}>{sync.unavailable}</p>}
      {error && <Notice tone="danger" compact>Review findings: {error}</Notice>}
      {notice && <Notice tone="success" compact role="status" onDismiss={onDismissNotice}>{notice}</Notice>}
      {/* Outside the folded body: the selection bar's Send to Agent is described by it too. */}
      {refusal && <p id={refusal.id} className="review-findings-reason">{refusal.reason}</p>}
      <div id={bodyId} hidden={!expanded}>
        {open.length > 0
          ? (
            <div className="review-findings-list">
              {open.map((finding) => (
                <FindingRow
                  key={finding.findingId}
                  finding={finding}
                  // Outdated means the anchored content actually moved, not merely that the change-set
                  // hash advanced, which every unrelated stage and agent edit does (#1203). A forge
                  // thread takes the forge's word for it.
                  outdated={finding.remote
                    ? finding.remote.subjectType !== "remote" && finding.remote.outdated
                    : anchorsKnown && !anchoredFindingIds.has(finding.findingId)}
                  selected={selected.has(finding.findingId)}
                  selectionDisabled={selectionDisabled}
                  onSelect={(checked) => onSelect(finding.findingId, checked)}
                  busy={busyFindingId === finding.findingId}
                  refusal={refusal}
                  onStatus={onStatus}
                  onOpenSourceLocation={onOpenSourceLocation}
                  provenance={findingProvenance(finding, { viewer, now, scope })}
                  agentLabel={agentLabel}
                />
              ))}
            </div>
          )
          : loaded && findings.length === 0 && (
            <p className="review-findings-empty">
              {coarse ? "Tap a line number to add a finding." : "Hover a line and choose + to add a finding."}
            </p>
          )}
      </div>
    </section>
  );
}

/**
 * What the panel's foot holds while findings are selected (#2850), in place of the commit bar: how
 * many, Clear, and Send to Agent. After a send it keeps the result, "Sent 2 findings to Claude.",
 * until it is dismissed or the selection changes; a failure stays beside the button that made it.
 */
export function FindingSelectionBar({
  count,
  busy,
  unavailable,
  refusal,
  notice,
  error,
  onClear,
  onSend,
  onDismissNotice,
  onDismissError,
}: {
  count: number;
  busy: boolean;
  /** Why Send to Agent cannot run (the machine is offline, the session has ended), shown in the bar. */
  unavailable: string | null;
  refusal: FindingRefusal;
  notice: string | null;
  error: string | null;
  onClear: () => void;
  onSend: () => void;
  onDismissNotice: () => void;
  onDismissError: () => void;
}) {
  const reasonId = `${useId().replace(/:/g, "")}-send-reason`;
  const blocked = unavailable !== null || refusal !== null;
  // Send to Agent and the notices go away under the focus they hold; focus then moves to whatever
  // the bar still shows, rather than dropping to the page.
  const barRef = useRef<HTMLElement>(null);
  const focusedControl = useRef<HTMLElement | null>(null);
  const trackFocus = (event: FocusEvent<HTMLElement>) => { focusedControl.current = event.target; };
  const releaseFocus = (event: FocusEvent<HTMLElement>) => {
    const left = event.target;
    queueMicrotask(() => { if (left.isConnected && focusedControl.current === left) focusedControl.current = null; });
  };
  useLayoutEffect(() => {
    const lost = focusedControl.current;
    if (!lost || lost.isConnected) return;
    focusedControl.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    barRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  });
  return (
    <section className="finding-selection-bar" aria-label="Selected Findings" ref={barRef} onFocus={trackFocus} onBlur={releaseFocus}>
      {error && <Notice tone="danger" compact role="alert" onDismiss={onDismissError}>{error}</Notice>}
      {notice && <Notice tone="success" compact role="status" onDismiss={onDismissNotice}>{notice}</Notice>}
      {count > 0 && (
        <div className="finding-selection-row">
          <span className="finding-selection-count">{count} {count === 1 ? "finding" : "findings"} selected</span>
          <div className="finding-selection-actions">
            <button type="button" className="btn sm ghost" disabled={busy} onClick={onClear}>Clear</button>
            <BusyButton
              className="btn primary sm"
              busy={busy}
              progress={`Sending ${count === 1 ? "the finding" : `${count} findings`} to the agent…`}
              disabled={blocked}
              title={refusal?.reason}
              aria-describedby={refusal ? refusal.id : unavailable !== null ? reasonId : undefined}
              onClick={onSend}
            >
              Send to Agent
            </BusyButton>
          </div>
        </div>
      )}
      {count > 0 && unavailable !== null && refusal === null && (
        <p className="finding-selection-reason" id={reasonId}>{unavailable}</p>
      )}
    </section>
  );
}
