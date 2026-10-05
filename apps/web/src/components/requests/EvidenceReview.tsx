import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { PendingApproval, WorkflowDecisionView } from "@wollipog/protocol";
import { useInstanceScope } from "../../instance-scope.js";
import {
  clearEvidenceReviewDraft,
  loadEvidenceReviewDraft,
  loadOpenedEvidenceLinks,
  saveEvidenceReviewDraft,
  saveOpenedEvidenceLinks,
} from "../../evidence-review-drafts.js";
import { Checkbox } from "../ui/ChoiceControls.js";
import { ChevronRightIcon, ErrorIcon, ExternalLinkIcon, SuccessIcon } from "../Icons.js";
import { Notice } from "../Notice.js";
import {
  EvidenceArtifactView,
  EvidenceBlocked,
  EvidenceSecureContextNotice,
  EvidenceViewer,
  evidenceIntegrityCheckAvailable,
  evidenceStatusBlocksReview,
  isArtifactBackedEvidence,
  isRenderableEvidence,
  UnrenderableEvidenceArtifact,
  type EvidenceArtifactStatus,
  type EvidenceDimensions,
  type EvidenceSource,
  type EvidenceViewerEntry,
} from "../EvidenceArtifactView.js";

type EvidenceSnapshot = Extract<WorkflowDecisionView["resourceSnapshot"], { category: "ui_evidence_approval" }>;
type EvidenceItem = EvidenceSnapshot["evidence"][number];

/**
 * Where one item stands in this browser (#2197):
 * - `reviewable`: shown (or, for a link-only item, opened) and so may be marked Reviewed;
 * - `waiting`: still loading, or a link not opened yet; it will become reviewable on its own;
 * - `blocked`: it can't be reviewed here (Doesn't Match, Can't Load, Can't Show), so only Deny is left;
 * - `insecure`: this page is not HTTPS or localhost, so no artifact can be checked or shown (#1787).
 */
export type EvidenceItemState = "reviewable" | "waiting" | "blocked" | "insecure";

/** The server's title for every UI evidence request; the card replaces it with what to do. */
const GENERIC_EVIDENCE_TITLE = "UI Evidence Approval Required";

export const EVIDENCE_COPY = {
  moreToReview: (count: number) => `Review ${count} more to approve.`,
  cantApprove: "Can't approve until every item can be reviewed.",
  needsSecureContext: "Approve needs HTTPS or localhost. Deny works from here.",
  askForCapture: "Deny this request and ask for a new capture.",
  checked: "Shown screenshots were checked by this browser against the request's digest.",
} as const;

type EvidenceKind = "Screenshot" | "Recording" | "File" | "Link";

function evidenceKind(item: EvidenceItem): EvidenceKind {
  if (!isArtifactBackedEvidence(item)) return "Link";
  const mediaType = item.mediaType?.toLowerCase() ?? "";
  return mediaType.startsWith("image/") ? "Screenshot" : mediaType.startsWith("video/") ? "Recording" : "File";
}

/** Readable tile names by media type: "Screenshot 1" to "Screenshot 4", or "Recording" and "Link"
 * when a request has one of that kind. The evidence id stays as the tile's secondary text. */
export function evidenceItemNames(evidence: readonly EvidenceItem[]): Map<string, string> {
  const kinds = evidence.map(evidenceKind);
  const totals = new Map<EvidenceKind, number>();
  for (const kind of kinds) totals.set(kind, (totals.get(kind) ?? 0) + 1);
  const seen = new Map<EvidenceKind, number>();
  return new Map(evidence.map((item, index) => {
    const kind = kinds[index]!;
    const position = (seen.get(kind) ?? 0) + 1;
    seen.set(kind, position);
    return [item.evidenceId, totals.get(kind)! > 1 ? `${kind} ${position}` : kind];
  }));
}

/** The Evidence Viewer's titles (#2207): a tile's name and how many of its kind there are, "Screenshot 2
 * of 4", or the bare name when it is the only one ("Recording"). */
export function evidenceViewerTitles(evidence: readonly EvidenceItem[]): Map<string, string> {
  const names = evidenceItemNames(evidence);
  const totals = new Map<EvidenceKind, number>();
  for (const item of evidence) totals.set(evidenceKind(item), (totals.get(evidenceKind(item)) ?? 0) + 1);
  return new Map(evidence.map((item) => {
    const name = names.get(item.evidenceId) ?? item.evidenceId;
    const total = totals.get(evidenceKind(item))!;
    return [item.evidenceId, total > 1 ? `${name} of ${total}` : name];
  }));
}

/** A shown capture's viewport, as its tile and the Evidence Viewer state it: "960 × 600". */
function evidenceFacts(dimensions: EvidenceDimensions): string {
  return `${dimensions.width} × ${dimensions.height}`;
}

/** "Review 4 screenshots before approving"; "items" when the request mixes kinds. */
export function evidenceReviewTitle(evidence: readonly EvidenceItem[]): string {
  const kinds = new Set(evidence.map(evidenceKind));
  const kind = kinds.size === 1 ? [...kinds][0]! : null;
  const noun = kind === "Screenshot" ? "screenshot" : kind === "Recording" ? "recording" : kind === "Link" ? "link" : "item";
  return `Review ${evidence.length} ${noun}${evidence.length === 1 ? "" : "s"} before approving`;
}

export interface EvidenceReview {
  decision: WorkflowDecisionView;
  evidence: EvidenceItem[];
  /** The card's title: the request's own, or what the review asks for. */
  title: string;
  names: Map<string, string>;
  state: (item: EvidenceItem) => EvidenceItemState;
  reviewed: (item: EvidenceItem) => boolean;
  setReviewed: (evidenceId: string, checked: boolean) => void;
  /** A link-only item's link was activated in this browser: only then may it be marked Reviewed. */
  markOpened: (evidenceId: string) => void;
  reviewedCount: number;
  complete: boolean;
  /** Why Approve is off, as the footer's foot-note; null once every item is reviewed. */
  footNote: string | null;
  onArtifactStatus: (evidenceId: string, status: EvidenceArtifactStatus) => void;
  /** The approve route's review proof for this exact occurrence. */
  approval: () => { evidenceReviewed?: string[]; evidenceReviewDigest?: string };
  clearDraft: () => void;
}

/**
 * The review state of a UI evidence decision: which items were seen, kept per occurrence in this
 * browser so a reload or a narrower layout does not lose it (#1107). Only a workflow decision whose
 * snapshot is UI evidence has one; every other request gets null.
 */
export function useEvidenceReview(sessionId: string, request: PendingApproval): EvidenceReview | null {
  const instanceScope = useInstanceScope();
  const workflowDecision = request.kind === "workflow_decision" ? request.workflowDecision : undefined;
  const decision = workflowDecision?.resourceSnapshot.category === "ui_evidence_approval" ? workflowDecision : null;
  const evidence = decision?.resourceSnapshot.category === "ui_evidence_approval" ? decision.resourceSnapshot.evidence : [];
  const evidenceIds = evidence.map((item) => item.evidenceId);
  const load = () => decision
    ? loadEvidenceReviewDraft(instanceScope, sessionId, request.requestId, decision.resourceDigest, evidenceIds)
    : [];
  const loadOpened = () => decision
    ? loadOpenedEvidenceLinks(instanceScope, sessionId, request.requestId, decision.resourceDigest, evidenceIds)
    : [];
  const [reviewedIds, setReviewedIds] = useState<string[]>(load);
  const [openedIds, setOpenedIds] = useState<string[]>(loadOpened);
  // An artifact-backed item counts as reviewed only once its verified image was actually shown. A
  // saved mark from an earlier visit does not survive the artifact turning out missing, mismatched,
  // or uncheckable in this browser. An artifact's `uri`, if any, never stands in for the checked
  // bytes, so an artifact of a media type the card cannot show stays blocked.
  const [artifactStatus, setArtifactStatus] = useState<Record<string, EvidenceArtifactStatus>>({});

  useEffect(() => {
    setReviewedIds(load());
    setOpenedIds(loadOpened());
    setArtifactStatus({});
  // The ids and digest are the immutable identity of this exact review occurrence.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.requestId, decision?.resourceDigest, instanceScope, sessionId]);

  if (!decision) return null;
  const secure = evidenceIntegrityCheckAvailable();
  const state = (item: EvidenceItem): EvidenceItemState => {
    if (!isArtifactBackedEvidence(item)) {
      // A link-only item is reviewed by opening its link; one with no link has nothing to review.
      if (!item.uri) return "blocked";
      return openedIds.includes(item.evidenceId) ? "reviewable" : "waiting";
    }
    if (!isRenderableEvidence(item)) return "blocked";
    if (!secure) return "insecure";
    const status = artifactStatus[item.evidenceId] ?? "pending";
    if (status === "unverifiable") return "insecure";
    if (!evidenceStatusBlocksReview(status)) return "reviewable";
    return status === "pending" || status === "loading" ? "waiting" : "blocked";
  };
  const reviewed = (item: EvidenceItem) => reviewedIds.includes(item.evidenceId) && state(item) === "reviewable";
  // The total counts what the marks show, so a saved mark on an item this page cannot show is not
  // reported as reviewed.
  const reviewedCount = evidence.filter(reviewed).length;
  const complete = reviewedCount === evidence.length;
  const states = evidence.map(state);
  const footNote = complete ? null
    : states.includes("insecure") ? EVIDENCE_COPY.needsSecureContext
      : states.includes("blocked") ? EVIDENCE_COPY.cantApprove
        : EVIDENCE_COPY.moreToReview(evidence.length - reviewedCount);
  return {
    decision,
    evidence,
    title: request.title && request.title !== GENERIC_EVIDENCE_TITLE ? request.title
      : evidence.length > 0 ? evidenceReviewTitle(evidence) : request.title,
    names: evidenceItemNames(evidence),
    state,
    reviewed,
    setReviewed: (evidenceId, checked) => setReviewedIds((current) => {
      const next = checked
        ? [...new Set([...current, evidenceId])]
        : current.filter((candidate) => candidate !== evidenceId);
      saveEvidenceReviewDraft(instanceScope, sessionId, request.requestId, decision.resourceDigest, next);
      return next;
    }),
    markOpened: (evidenceId) => setOpenedIds((current) => {
      if (current.includes(evidenceId)) return current;
      const next = [...current, evidenceId];
      saveOpenedEvidenceLinks(instanceScope, sessionId, request.requestId, decision.resourceDigest, next);
      return next;
    }),
    reviewedCount,
    complete,
    footNote,
    onArtifactStatus: (evidenceId, status) => setArtifactStatus((current) =>
      current[evidenceId] === status ? current : { ...current, [evidenceId]: status }),
    approval: () => evidence.length === 0 ? {} : ({
      evidenceReviewed: reviewedIds,
      ...(evidence.some((item) => item.uri === undefined) ? { evidenceReviewDigest: decision.resourceDigest } : {}),
    }),
    clearDraft: () => clearEvidenceReviewDraft(instanceScope, sessionId, request.requestId, decision.resourceDigest),
  };
}

/** What a tile shares with the Evidence Viewer (#2207): its bytes and size once shown, and how to open it. */
interface EvidenceTileViewer {
  dimensions: EvidenceDimensions | null;
  onDimensions: (evidenceId: string, dimensions: EvidenceDimensions) => void;
  onSource: (evidenceId: string, source: EvidenceSource | null) => void;
  onOpen: (evidenceId: string) => void;
  /** The viewer is open, so every item loads now rather than as it nears the viewport. */
  eager: boolean;
}

/** One evidence item as a tile (#2197): its frame with the Reviewed mark on it, then its name, the
 * capture's size once shown, and its id. Its picture opens the Evidence Viewer (#2207). */
function EvidenceTile({ review, item, viewer }: { review: EvidenceReview; item: EvidenceItem; viewer: EvidenceTileViewer }) {
  const nameId = `${useId().replace(/:/g, "")}-name`;
  const { dimensions } = viewer;
  const name = review.names.get(item.evidenceId) ?? item.evidenceId;
  const state = review.state(item);
  const linkOnly = !isArtifactBackedEvidence(item);
  // A blocked item has no mark at all: nothing it could show would make it reviewable here. An
  // artifact still loading has none yet either; a link-only item shows its mark disabled until
  // its link is opened, which is what it waits on.
  const mark = (state === "reviewable" || (linkOnly && state === "waiting")) && (
    <Checkbox
      className="ev-mark"
      label="Reviewed"
      ariaLabel={`Mark ${name} as Reviewed`}
      checked={review.reviewed(item)}
      disabled={state !== "reviewable"}
      onChange={(checked) => review.setReviewed(item.evidenceId, checked)}
    />
  );
  const frame = isRenderableEvidence(item)
    ? <EvidenceArtifactView item={item} name={name} onStatusChange={review.onArtifactStatus}
      onDimensions={(next) => viewer.onDimensions(item.evidenceId, next)} onSource={viewer.onSource}
      onOpen={() => viewer.onOpen(item.evidenceId)} eager={viewer.eager} />
    : isArtifactBackedEvidence(item) ? <UnrenderableEvidenceArtifact item={item} />
      : item.uri ? (
        // No picture to carry the mark, so it sits under Open Link inside the frame.
        <div className="ev-media" data-status="link">
          <span className="ev-link-glyph" aria-hidden="true"><ExternalLinkIcon /></span>
          <a
            className="btn sm"
            href={item.uri}
            target="_blank"
            rel="noreferrer"
            aria-describedby={nameId}
            // A plain or modifier click, Enter, and a middle click (auxclick) each open the link,
            // so each counts as opened. The context menu's Open in New Tab tells the page nothing,
            // so a link opened only that way still waits for one of these.
            onClick={() => review.markOpened(item.evidenceId)}
            // auxclick also fires for the secondary button, which only opens the menu.
            onAuxClick={(event) => { if (event.button === 1) review.markOpened(item.evidenceId); }}
          >
            Open Link
          </a>
          {mark}
        </div>
      ) : (
        <div className="ev-media" data-status="unsupported">
          <EvidenceBlocked tone="danger" icon={<ErrorIcon size={14} />} label="Can't Show" detail="It has no file or link." />
        </div>
      );
  return (
    <article className="ev-tile" data-state={state} data-reviewed={review.reviewed(item) || undefined}
      data-evidence-id={item.evidenceId} aria-labelledby={nameId}>
      <div className="ev-frame">
        {frame}
        {!linkOnly && mark}
      </div>
      <div className="ev-meta">
        <span className="ev-name" id={nameId}>{name}</span>
        {dimensions && state === "reviewable" && (
          <span className="ev-facts">{evidenceFacts(dimensions)}</span>
        )}
        {linkOnly && state === "waiting" && <span className="ev-facts">Open it to review.</span>}
        <span className="ev-id" title={item.evidenceId}>{item.evidenceId}</span>
      </div>
    </article>
  );
}

/** What stands for a tile when focus comes back to it: its picture, else its first live control, else
 * the tile itself (still loading, or failed with nothing to retry), so focus never lands on another one. */
function tileFocusTarget(grid: HTMLElement | null, evidenceId: string | null): HTMLElement | null {
  const tile = [...grid?.querySelectorAll<HTMLElement>(".ev-tile") ?? []]
    .find((candidate) => candidate.dataset.evidenceId === evidenceId);
  if (!tile) return null;
  const control = tile.querySelector<HTMLElement>(
    ".ev-thumb:not([hidden]):not(:disabled), button:not(:disabled), input:not(:disabled), a[href]",
  );
  if (control) return control;
  tile.tabIndex = -1;
  return tile;
}

/**
 * The evidence of a UI evidence decision as a grid of named tiles (docs/design-system.md §13.2;
 * #2197): the HTTPS notice when this page cannot check artifacts, a notice when an item can't be
 * reviewed, a progress line, the tiles, one digest caption, and Show Details. A tile's picture opens
 * the Evidence Viewer (#2207) over the grid, on the same review.
 */
export function EvidenceReviewBody({ review }: { review: EvidenceReview }) {
  const { decision, evidence } = review;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [sources, setSources] = useState<Record<string, EvidenceSource>>({});
  const [dimensions, setDimensions] = useState<Record<string, EvidenceDimensions>>({});
  const gridRef = useRef<HTMLDivElement>(null);
  const lastShownRef = useRef<string | null>(null);
  // Read as the viewer closes, so focus returns to the tile of the item last shown, whichever it was.
  const returnFocusRef = useMemo(() => ({
    get current() { return tileFocusTarget(gridRef.current, lastShownRef.current); },
  }), []);
  const states = evidence.map(review.state);
  const show = useCallback((evidenceId: string) => {
    lastShownRef.current = evidenceId;
    setViewing(evidenceId);
  }, []);
  const onSource = useCallback((evidenceId: string, source: EvidenceSource | null) => setSources((current) => {
    if (source) return current[evidenceId] === source ? current : { ...current, [evidenceId]: source };
    if (!Object.hasOwn(current, evidenceId)) return current;
    const { [evidenceId]: _withdrawn, ...rest } = current;
    return rest;
  }), []);
  const onDimensions = useCallback((evidenceId: string, next: EvidenceDimensions) => setDimensions((current) =>
    current[evidenceId]?.width === next.width && current[evidenceId]?.height === next.height
      ? current : { ...current, [evidenceId]: next }), []);
  // Grid order, without what the grid shows as blocked or Not Shown, and without link-only items,
  // which keep Open Link on their tile. An item still loading is an entry: the viewer loads it.
  const titles = evidenceViewerTitles(evidence);
  const entries: EvidenceViewerEntry[] = evidence.flatMap((item, index) => {
    if (!isRenderableEvidence(item) || (states[index] !== "reviewable" && states[index] !== "waiting")) return [];
    return [{
      item,
      name: review.names.get(item.evidenceId) ?? item.evidenceId,
      title: titles.get(item.evidenceId) ?? item.evidenceId,
      source: states[index] === "reviewable" ? sources[item.evidenceId] ?? null : null,
      facts: dimensions[item.evidenceId] ? evidenceFacts(dimensions[item.evidenceId]!) : null,
      reviewable: states[index] === "reviewable",
      reviewed: review.reviewed(item),
    }];
  });
  // An item that fails while it is shown (a recording that stops playing) leaves the viewer, and
  // focus returns to its tile, which now says what happened.
  const current = viewing !== null && entries.some((entry) => entry.item.evidenceId === viewing) ? viewing : null;
  useEffect(() => {
    if (viewing !== null && current === null) setViewing(null);
  }, [current, viewing]);
  const tileViewer = (item: EvidenceItem): EvidenceTileViewer => ({
    dimensions: dimensions[item.evidenceId] ?? null,
    onDimensions,
    onSource,
    onOpen: show,
    eager: current !== null,
  });
  const anyShown = evidence.some((item, index) => states[index] === "reviewable" && isArtifactBackedEvidence(item));
  return (
    <div className="ev-review">
      <EvidenceSecureContextNotice evidence={evidence} />
      {/* Above the tiles, where it is read before a scroll: what to do when an item can't be reviewed. */}
      {states.includes("blocked") && (
        <Notice tone="danger" compact role="alert">{EVIDENCE_COPY.askForCapture}</Notice>
      )}
      <p className="ev-progress" role="status" aria-live="polite">
        {review.reviewedCount} of {evidence.length} reviewed
      </p>
      <div className="ev-grid" role="list" aria-label="Evidence Items" ref={gridRef}>
        {evidence.map((item) => (
          <div role="listitem" key={item.evidenceId} className="ev-cell">
            <EvidenceTile review={review} item={item} viewer={tileViewer(item)} />
          </div>
        ))}
      </div>
      {current !== null && (
        <EvidenceViewer
          entries={entries}
          currentId={current}
          reviewedCount={review.reviewedCount}
          total={evidence.length}
          onShow={show}
          onReviewed={review.setReviewed}
          onClose={() => setViewing(null)}
          returnFocusRef={returnFocusRef}
        />
      )}
      <div className="ev-foot">
        {anyShown && (
          <p className="ev-checked"><SuccessIcon size={14} />{EVIDENCE_COPY.checked}</p>
        )}
        <details className="disclosure" onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
          <summary><ChevronRightIcon className="disclosure-chevron" />{detailsOpen ? "Hide Details" : "Show Details"}</summary>
          <div className="disclosure-body">
            <dl className="facts">
              <div><dt>Resource Key</dt><dd>{decision.resourceKey}</dd></div>
              <div><dt>Resource Digest</dt><dd className="ev-digest">{decision.resourceDigest}</dd></div>
              <div><dt>Decided By</dt><dd>{decision.authority === "orchestrator" ? "The Orchestrator" : "A person"}</dd></div>
              {decision.humanFallback && (
                <div>
                  <dt>Why a Person</dt>
                  <dd>UI Evidence Approval is assigned to the Orchestrator, but this request needs a person. {decision.humanFallback.reason}</dd>
                </div>
              )}
            </dl>
          </div>
        </details>
      </div>
    </div>
  );
}
