import React, { useId, useState, type ReactNode } from "react";
import { CloseIcon, ErrorIcon, InfoIcon, SuccessIcon, WarningIcon } from "./Icons.js";

export type NoticeTone = "info" | "success" | "warning" | "danger" | "neutral";

/** The 16px icon that carries a tone, so a notice or toast never depends on colour alone (§13). */
export function ToneIcon({ tone }: { tone: NoticeTone }) {
  return tone === "success" ? <SuccessIcon />
    : tone === "warning" ? <WarningIcon />
      : tone === "danger" ? <ErrorIcon />
        : <InfoIcon />;
}

export interface NoticeProps {
  tone?: NoticeTone;
  /** Replaces the tone icon where a subject icon says more, as the wrench does for a setup
   * suggestion. Only for a neutral or info notice: a warning or danger keeps its tone icon, except
   * HTTPS or Localhost Required, whose lock is the subject the design names (#2197), and the sign-in
   * card's can't-switch notice, whose `Ban` is (#2208). */
  icon?: ReactNode;
  /** Optional Title Case title, above a sentence-case body. */
  title?: ReactNode;
  /** Render the title as a heading at this level, for a notice that stands in for a page's content
   * and so names the page (a load error, §12.4). */
  headingLevel?: 1 | 2 | 3 | 4;
  /** The title's id. The title is then focusable from script, as the `page-title` focus-rescue
   * anchor is. */
  titleId?: string;
  /** The body: one or two sentences in sentence case. */
  children?: ReactNode;
  /** A left-aligned row of `.btn.sm` actions, the resolving action first. */
  actions?: ReactNode;
  /** Everything longer than the body's one or two sentences. It stays behind a Show Details toggle
   * at the end of the action row and is not in the DOM until the person opens it (§13.2). */
  details?: ReactNode;
  /** Controls in the title row, before the dismiss button: the session notice slot's "+N More".
   * In a titled notice these and the dismiss button sit in the title row only, so the body and the
   * actions use the notice's full width. */
  trailing?: ReactNode;
  /** Adds an icon dismiss button with this handler. */
  onDismiss?: () => void;
  dismissLabel?: string;
  dismissDisabled?: boolean;
  /** One line: icon, sentence and a trailing action (field and composer notices). */
  compact?: boolean;
  /** Spans the top of the main area for offline, pairing and held-update states (§13.3). */
  pageBanner?: boolean;
  as?: "div" | "section" | "aside";
  role?: "status" | "alert" | "note" | "region";
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaBusy?: boolean;
  /** Hides a notice whose words another live notice already announces. */
  ariaHidden?: boolean;
  id?: string;
  className?: string;
  tabIndex?: number;
  dataState?: string;
  noticeRef?: React.Ref<HTMLElement>;
}

/**
 * The one inline notice (docs/design-system.md §13.2): a 16px tone icon at the first line, an
 * optional title, a body and an action row, on a 7% wash of the tone. Every banner, callout and
 * boxed inline error in the app is this recipe; only the tone and the variant change.
 */
export function Notice({
  tone = "info",
  icon,
  title,
  headingLevel,
  titleId,
  children,
  actions,
  details,
  trailing,
  onDismiss,
  dismissLabel = "Dismiss",
  dismissDisabled = false,
  compact = false,
  pageBanner = false,
  as: Element = "div",
  role,
  ariaLabel,
  ariaLabelledBy,
  ariaBusy,
  ariaHidden,
  id,
  className,
  tabIndex,
  dataState,
  noticeRef,
}: NoticeProps) {
  const Tag = Element as "div";
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = `notice-details-${useId().replace(/:/g, "")}`;
  const hasDetails = details != null && details !== false;
  const dismiss = onDismiss && (
    <button type="button" className="icon-btn sm notice-dismiss" aria-label={dismissLabel} title={dismissLabel}
      disabled={dismissDisabled} onClick={onDismiss}>
      <CloseIcon />
    </button>
  );
  // A titled notice carries its trailing controls in the title row; an untitled one keeps them in
  // their own column beside the body.
  const head = Boolean(title);
  const Title = (headingLevel ? `h${headingLevel}` : "strong") as "strong" | "h1" | "h2" | "h3" | "h4";
  return (
    <Tag
      ref={noticeRef as React.Ref<HTMLDivElement>}
      id={id}
      className={[
        "notice",
        tone === "success" ? "t-success"
          : tone === "warning" ? "t-warning"
            : tone === "danger" ? "t-danger"
              : tone === "neutral" ? "t-neutral"
                : "t-info",
        compact ? "compact" : "",
        pageBanner ? "page-banner" : "",
        head ? "with-head" : "",
        className ?? "",
      ].filter(Boolean).join(" ")}
      role={role}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-busy={ariaBusy || undefined}
      aria-hidden={ariaHidden || undefined}
      tabIndex={tabIndex}
      data-state={dataState}
    >
      <span className="notice-icon" aria-hidden="true">{icon ?? <ToneIcon tone={tone} />}</span>
      <div className="notice-content">
        {head && (
          <div className="notice-head">
            <Title className="notice-title" id={titleId} tabIndex={titleId ? -1 : undefined}>{title}</Title>
            {(trailing || dismiss) && <div className="notice-trailing">{trailing}{dismiss}</div>}
          </div>
        )}
        {children != null && children !== false && <div className="notice-body">{children}</div>}
        {(actions || hasDetails) && (
          <div className="notice-actions">
            {actions}
            {hasDetails && (
              <button
                type="button"
                className="btn sm ghost notice-details-toggle"
                aria-expanded={detailsOpen}
                aria-controls={detailsOpen ? detailsId : undefined}
                onClick={() => setDetailsOpen((open) => !open)}
              >
                {detailsOpen ? "Hide Details" : "Show Details"}
              </button>
            )}
          </div>
        )}
        {hasDetails && detailsOpen && <div className="notice-details-body" id={detailsId}>{details}</div>}
      </div>
      {!head && (trailing || dismiss) && <div className="notice-trailing">{trailing}{dismiss}</div>}
    </Tag>
  );
}
